(function () {
    'use strict';

    // =========================================================================
    // 1. 設定エリア
    // =========================================================================
    const DB_NAME = 'FormBridge_Backup_DB';
    const STORE_NAME = 'record_backup';
    const DB_VERSION = 1;

    // 圧縮対象のフィールドコード（添付ファイルフィールド）
    // サブテーブル内にある場合も同様のフィールドコードとして扱います
    const PHOTO_FIELDS = ['作業前', '作業後'];

    const COMPRESS_CONFIG = {
        quality: 0.6,
        maxWidth: 1280,
        mimeType: 'image/jpeg'
    };

    const COMPRESSOR_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/compressorjs/1.2.1/compressor.min.js';

    // =========================================================================
    // 2. 状態管理変数
    // =========================================================================
    // バックアップ保存の非同期処理を追跡するためのPromise
    let pendingSavePromise = null;
    // 画像圧縮中であることを判別するためのフラグ
    let isCompressing = false;
    // 初回の復元判定を複数回（ステップ 이동や確認画面戻り）走らせないためのフラグ
    let backupRestored = false;

    // =========================================================================
    // 3. UI部品 (進捗インジケーター)
    // =========================================================================
    const ProgressIndicator = {
        init() {
            if (document.getElementById('fb-custom-progress')) return;
            const container = document.querySelector('.fb-custom--main') || document.body;
            const el = document.createElement('div');
            el.id = 'fb-custom-progress';
            el.style.cssText = `
                display: none;
                position: sticky;
                top: 0;
                background-color: #007bff;
                color: #ffffff;
                text-align: center;
                padding: 12px;
                font-size: 14px;
                font-weight: bold;
                z-index: 9999;
                box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                border-radius: 4px;
                margin-bottom: 10px;
                transition: opacity 0.3s;
            `;
            container.insertBefore(el, container.firstChild);
        },
        show(total) {
            this.init();
            const el = document.getElementById('fb-custom-progress');
            if (el) {
                el.style.display = 'block';
                el.style.opacity = '1';
                this.update(total, total);
            }
        },
        update(remaining, total) {
            const el = document.getElementById('fb-custom-progress');
            if (el) {
                el.textContent = \`📷 画像を圧縮中... 残り \${remaining} 枚 / 全 \${total} 枚\`;
            }
        },
        hide() {
            const el = document.getElementById('fb-custom-progress');
            if (el) {
                el.style.opacity = '0';
                setTimeout(() => {
                    el.style.display = 'none';
                }, 300);
            }
        }
    };

    // =========================================================================
    // 4. IndexedDB 操作ユーティリティ （エラーハンドリング対応）
    // =========================================================================
    const dbOp = {
        open() {
            return new Promise((resolve, reject) => {
                try {
                    const request = indexedDB.open(DB_NAME, DB_VERSION);
                    request.onupgradeneeded = (e) => {
                        const db = e.target.result;
                        if (!db.objectStoreNames.contains(STORE_NAME)) {
                            db.createObjectStore(STORE_NAME);
                        }
                    };
                    request.onsuccess = (e) => resolve(e.target.result);
                    request.onerror = (e) => reject(e.target.error || new Error('IndexedDB Not Available'));
                } catch (err) {
                    reject(err);
                }
            });
        },
        async save(record) {
            try {
                const db = await this.open();
                return await new Promise((resolve, reject) => {
                    const tx = db.transaction(STORE_NAME, 'readwrite');
                    const store = tx.objectStore(STORE_NAME);
                    // フォームのパス（URL）をキーにして保存
                    const request = store.put(record, location.pathname);
                    tx.oncomplete = () => resolve();
                    tx.onerror = (e) => reject(request.error || e.target.error);
                });
            } catch (error) {
                console.error('IndexedDB 保存エラー:', error);
                const errName = error && error.name;
                // 容量制限エラーとブラウザ制限のフォールバック対応
                if (errName === 'QuotaExceededError') {
                    alert('端末のストレージ容量制限に達したため、バックアップ保存できませんでした。\\n画像の枚数を減らすか、空き容量を確保してください。');
                } else if (errName === 'NotAllowedError' || errName === 'SecurityError' || !error) {
                    alert('ブラウザのプライバシー設定（プライベートブラウズ等）によりバックアップ機能が利用できません。\\n入力データは保護されませんが、送信自体は可能です。');
                }
            }
        },
        async load() {
            try {
                const db = await this.open();
                return await new Promise((resolve, reject) => {
                    const tx = db.transaction(STORE_NAME, 'readonly');
                    const store = tx.objectStore(STORE_NAME);
                    const request = store.get(location.pathname);
                    request.onsuccess = (e) => resolve(e.target.result);
                    request.onerror = (e) => reject(e.target.error);
                });
            } catch (error) {
                console.warn('IndexedDB 読み込みスキップ:', error);
                return null;
            }
        },
        async clear() {
            try {
                const db = await this.open();
                return await new Promise((resolve, reject) => {
                    const tx = db.transaction(STORE_NAME, 'readwrite');
                    const store = tx.objectStore(STORE_NAME);
                    store.delete(location.pathname);
                    tx.oncomplete = () => resolve();
                    tx.onerror = (e) => reject(e.target.error);
                });
            } catch (error) {
                console.warn('IndexedDB クリアエラー:', error);
            }
        }
    };

    // =========================================================================
    // 5. データ再帰走査ロジック（サブテーブル完全対応）
    // =========================================================================
    function traverseRecord(record, callback) {
        if (!record || typeof record !== 'object') return;

        Object.keys(record).forEach(fieldCode => {
            const field = record[fieldCode];
            if (!field) return;

            callback(field, fieldCode);

            if (field.type === 'SUBTABLE' && Array.isArray(field.value)) {
                field.value.forEach(row => {
                    if (row && row.value) {
                        traverseRecord(row.value, callback);
                    }
                });
            }
        });
    }

    function isRecordDirty(record) {
        let dirty = false;
        traverseRecord(record, (field, code) => {
            if (field.type === 'SUBTABLE') return;
            
            if (Array.isArray(field.value)) {
                if (field.value.length > 0) dirty = true;
            } else if (field.value !== null && field.value !== undefined && field.value !== '') {
                dirty = true;
            }
        });
        return dirty;
    }

    // =========================================================================
    // 6. 画像圧縮ロジック
    // =========================================================================
    const script = document.createElement('script');
    script.src = COMPRESSOR_LIB_URL;
    document.head.appendChild(script);

    async function compressImage(file) {
        if (!window.Compressor) {
            await new Promise(r => setTimeout(r, 500));
        }
        return new Promise((resolve, reject) => {
            new window.Compressor(file, {
                ...COMPRESS_CONFIG,
                success: (res) => resolve(new File([res], file.name, { type: res.type })),
                error: (err) => reject(err)
            });
        });
    }

    // =========================================================================
    // 7. FormBridge イベント連携
    // =========================================================================

    // ▼ 表示時：バックアップの復元
    formBridge.events.on('form.show', async (context) => {
        if (backupRestored) return; // 復元確認は1回だけ行う
        backupRestored = true;

        try {
            const backup = await dbOp.load();
            if (backup && Object.keys(backup).length > 0) {
                const current = formBridge.fn.getRecord();
                const isDirty = isRecordDirty(current);

                if (!isDirty && confirm('一時保存されているデータが見つかりました。復元しますか？')) {
                    Object.keys(backup).forEach(key => {
                        context.setFieldValue(key, backup[key].value);
                    });
                    console.log('✅ IndexedDBからデータを復元しました（サブテーブル含む）');
                }
            }
        } catch (e) {
            console.error('復元エラー:', e);
        }
    });

    // ▼ 値変更時（ファイル選択）：バックアップの保存 ＋ 画像圧縮
    document.addEventListener('change', async function (e) {
        if (!e.target || e.target.type !== 'file') return;

        const wrapper = e.target.closest('[data-field-code]');
        if (!wrapper) return;
        
        const fieldCode = wrapper.getAttribute('data-field-code');
        if (!PHOTO_FIELDS.includes(fieldCode)) return;
        if (e.target.dataset.processed === 'true') return;

        // 以降の通常処理を一時ストップ
        e.stopPropagation();
        e.stopImmediatePropagation();

        const dt = new DataTransfer();
        const originalFiles = Array.from(e.target.files);
        const imageFiles = originalFiles.filter(f => f.type.startsWith('image/'));

        if (imageFiles.length > 0) {
            isCompressing = true; // 圧縮中は送信させないためのフラグ
            ProgressIndicator.show(imageFiles.length);
            let remaining = imageFiles.length;

            for (const file of originalFiles) {
                if (file.type.startsWith('image/')) {
                    try {
                        const compressed = await compressImage(file);
                        dt.items.add(compressed);
                    } catch (err) {
                        console.error('画像圧縮エラー:', err);
                        dt.items.add(file);
                    } finally {
                        remaining--;
                        ProgressIndicator.update(remaining, imageFiles.length);
                    }
                } else {
                    dt.items.add(file);
                }
            }
            ProgressIndicator.hide();
            isCompressing = false; // 圧縮完了
        } else {
            for (const file of originalFiles) dt.items.add(file);
        }

        e.target.files = dt.files;
        e.target.dataset.processed = 'true';

        // FormBridgeへ変更の完了を伝播
        e.target.dispatchEvent(new Event('change', { bubbles: true }));

        setTimeout(() => {
            const currentRecord = formBridge.fn.getRecord();
            pendingSavePromise = dbOp.save(currentRecord).then(() => {
                console.log('💾 画像追加に伴い IndexedDB に保存しました');
                pendingSavePromise = null;
            });
        }, 500);

    }, true);

    // ▼ テキスト入力の変更も監視して保存（サブテーブル等すべて網羅）
    formBridge.events.on('form.show', () => {
        if (window.__fb_change_hooked) return;
        window.__fb_change_hooked = true;

        const saveHandler = () => {
            const record = formBridge.fn.getRecord();
            pendingSavePromise = dbOp.save(record).then(() => {
                pendingSavePromise = null;
            }).catch(() => { pendingSavePromise = null; });
        };

        const settings = formBridge.fn.getFieldSettings();
        settings.forEach(s => {
            // 通常フィールドおよびルックアップの変更監視
            formBridge.events.on(\`form.field.change.\${s.code}\`, saveHandler);
            formBridge.events.on(\`form.kviewerLookup.selectRecord.\${s.code}\`, saveHandler);

            // サブテーブル固有のイベント監視
            if (s.type === 'SUBTABLE') {
                formBridge.events.on(\`form.subtable.addRow.\${s.code}\`, saveHandler);
                formBridge.events.on(\`form.subtable.removeRow.\${s.code}\`, saveHandler);
                
                // サブテーブル内の各フィールドの変更
                if (s.tableFields) {
                    s.tableFields.forEach(ts => {
                        formBridge.events.on(\`form.field.change.\${s.code}.\${ts.code}\`, saveHandler);
                        formBridge.events.on(\`form.kviewerLookup.selectRecord.\${s.code}.\${ts.code}\`, saveHandler);
                    });
                }
            }
        });
    });

    // =========================================================================
    // 8. 遷移・送信時の制御ロジック
    // =========================================================================

    const stopIfProcessing = (context, isConfirmScreen = false) => {
        if (isCompressing) {
            alert('📷 現在画像を圧縮処理中です。完了するまでお待ちください。');
            context.preventDefault();
            return true;
        }
        if (isConfirmScreen && pendingSavePromise) {
            // 確認画面へ移動する（form.confirm）の場合はemitが無いのでアラートで待ってもらう
            alert('💾 バックアップ保存中です。数秒待ってから再度お試しください。');
            context.preventDefault();
            return true;
        }
        return false;
    };

    // 確認画面への遷移（確認画面設定がある場合）
    formBridge.events.on('form.confirm', (context) => {
        stopIfProcessing(context, true);
    });

    // 確認画面経由、または直接送信される場合
    const handleSubmit = (context) => {
        if (stopIfProcessing(context, false)) return;

        if (pendingSavePromise) {
            console.log('⏳ バックアップ保存中のため、送信を一時待機します...');
            context.preventDefault();

            pendingSavePromise.then(() => {
                console.log('🔄 保存完了。送信処理を再開します。');
                formBridge.fn.emitSubmit();
            });
        }
    };
    
    // サブミット時のイベント（どちらの画面からでもフックする）
    formBridge.events.on('form.submit', handleSubmit);
    formBridge.events.on('confirm.submit', handleSubmit);

    // ▼ 送信完了時：バックアップの削除
    const clearBackup = async () => {
        await dbOp.clear();
        console.log('🗑️ 送信完了のためバックアップを削除しました');
    };
    formBridge.events.on('form.submitted', clearBackup);
    formBridge.events.on('confirm.submitted', clearBackup);

})();e.target.dataset.processed = 'true';

        // FormBridgeへ変更の完了を伝播
        e.target.dispatchEvent(new Event('change', { bubbles: true }));

        // ★ IndexedDB バックアップ保存
        // Reactの再描画後を見計らって保存を行うためのsetTimeout
        setTimeout(() => {
            const currentRecord = formBridge.fn.getRecord();
            // 送信ボタン同期用のPromiseの更新
            pendingSavePromise = dbOp.save(currentRecord).then(() => {
                console.log('💾 画像追加に伴い IndexedDB に保存しました');
                pendingSavePromise = null;
            });
        }, 500);

    }, true);

    // テキスト入力の変更も監視して保存
    formBridge.events.on('form.show', () => {
        const settings = formBridge.fn.getFieldSettings();
        settings.forEach(s => {
            formBridge.events.on(\`form.field.change.\${s.code}\`, () => {
                const record = formBridge.fn.getRecord();
                pendingSavePromise = dbOp.save(record).then(() => {
                    pendingSavePromise = null; // 完了したらリセット
                });
            });
        });
    });

    // ▼ 送信ボタン（form.submit）との同期処理
    // 保存が進行中の場合は送信を一度止め、完了後に自動再送信する
    formBridge.events.on('form.submit', (context) => {
        if (pendingSavePromise) {
            console.log('⏳ バックアップ保存中のため、送信を一時待機します...');
            context.preventDefault();

            // 保存処理完了を待ってから再度送信エミット
            pendingSavePromise.then(() => {
                console.log('🔄 保存完了。送信処理を再開します。');
                formBridge.fn.emitSubmit();
            });
        }
    });

    // ▼ 送信完了時：バックアップの削除
    formBridge.events.on('form.submitted', async () => {
        await dbOp.clear();
        console.log('🗑️ 送信完了のためバックアップを削除しました');
    });

})();