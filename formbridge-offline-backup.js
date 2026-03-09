(function () {
    'use strict';

    // =========================================================================
    // 0. CSSの注入 (インラインスタイルから分離)
    // =========================================================================
    const style = document.createElement('style');
    style.innerHTML = `
        #fb-custom-offline-btn {
            color: #ffffff; text-align: center; padding: 8px 15px; font-size: 14px;
            font-weight: bold; border: none; cursor: pointer; border-radius: 6px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2); transition: all 0.3s; line-height: 1.2;
        }
        #fb-custom-offline-btn.mode-offline { background-color: #6c757d; }
        #fb-custom-offline-btn.mode-online { background-color: #28a745; }
        #fb-custom-progress {
            display: none; position: sticky; top: 0; background-color: #007bff;
            color: #ffffff; text-align: center; padding: 12px; font-size: 14px;
            font-weight: bold; z-index: 9999; box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            border-radius: 4px; margin-bottom: 10px; transition: opacity 0.3s;
        }
        .fb-offline-indicator {
            background-color: #d4edda; color: #155724; padding: 10px; border-radius: 4px;
            margin-top: 5px; border: 1px solid #c3e6cb; font-size: 14px; text-align: left;
            line-height: 1.5; z-index: 10;
        }
        .fb-offline-reset-btn {
            margin-top: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer;
            background: #fff; border: 1px solid #aaa; border-radius: 3px;
        }
    `;
    document.head.appendChild(style);

    // =========================================================================
    // 1. 設定エリア
    // =========================================================================
    const DB_NAME = 'FormBridge_Backup_DB', STORE_NAME = 'record_backup', DB_VERSION = 1;
    const PHOTO_FIELDS = ['作業前', '作業後'];
    const COMPRESS_CONFIG = { quality: 0.7, maxWidth: 1280, mimeType: 'image/jpeg' };
    const COMPRESSOR_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/compressorjs/1.2.1/compressor.min.js';

    // =========================================================================
    // 2. 状態管理変数
    // =========================================================================
    let pendingSavePromise = null;
    let isCompressing = false, backupRestored = false, isRestoring = false;
    let isOfflineMode = localStorage.getItem('fb_offline_mode') === 'true';
    let daemonMonitoringData = []; // 不死身デーモンが監視

    // =========================================================================
    // 3. 共通ヘルパー関数 (データ変換・DOM操作)
    // =========================================================================
    const base64ToBlob = (base64Str, type) => {
        const bstr = atob(base64Str.split(',')[1] || base64Str.split(',')[0]);
        const u8arr = new Uint8Array(bstr.length).map((_, i) => bstr.charCodeAt(i));
        return new Blob([u8arr], { type });
    };

    const applyFilesToInput = (input, filesData) => {
        const dt = new DataTransfer();
        filesData.forEach(f => dt.items.add(new File([base64ToBlob(f.data, f.type || 'image/jpeg')], f.name || 'image.jpg', { type: f.type || 'image/jpeg' })));
        input.files = dt.files;
        input.dataset.processed = 'true';
        return dt.files;
    };

    const getBase64 = (file) => new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });

    // =========================================================================
    // 4. UI部品 (進捗インジケーター & モード切替ボタン)
    // =========================================================================
    const ProgressIndicator = {
        toggleSubmitButton(hide) {
            document.querySelectorAll('.fb-submit, .confirm-submit').forEach(btn => btn.style.display = hide ? 'none' : '');
            document.querySelectorAll('button, a.el-button, .el-button, span').forEach(el => {
                if (['回答', '確認', '送信'].includes(el.textContent.trim())) {
                    const target = el.closest('button') || el.closest('a') || el.closest('.el-button') || el;
                    if (target) target.style.display = hide ? 'none' : '';
                }
            });
        },
        initOfflineButton() {
            if (document.getElementById('fb-custom-offline-btn')) return;
            const container = document.querySelector('.fb-custom--main') || document.body;
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'display: flex; justify-content: flex-end; margin-bottom: 10px;';

            const btn = document.createElement('button');
            btn.id = 'fb-custom-offline-btn';

            const updateBtnUI = () => {
                btn.className = isOfflineMode ? 'mode-offline' : 'mode-online';
                btn.innerHTML = isOfflineMode
                    ? '✈️ オフライン(一時保存)モード<br><span style="font-size:11px;">(現在アップロード停止中)</span>'
                    : '🌐 オンラインモード<br><span style="font-size:11px;">(クリックで一時保存専用に切替)</span>';
            };
            updateBtnUI();

            btn.onclick = (e) => {
                e.preventDefault();
                if (isOfflineMode) {
                    if (confirm('【オンラインモードに戻します】\\n未送信の画像をFormBridgeサーバーへアップロードするため、ページを再読み込み（リロード）します。よろしいですか？')) {
                        isOfflineMode = false; localStorage.setItem('fb_offline_mode', 'false'); location.reload();
                    }
                } else {
                    isOfflineMode = true; localStorage.setItem('fb_offline_mode', 'true'); updateBtnUI();
                    ProgressIndicator.toggleSubmitButton(true);
                    alert('【オフラインモードをONにしました】\\n以降は画像をアップロードせず一時保存(IndexedDB)のみ行います。');
                }
            };
            wrapper.appendChild(btn); container.insertBefore(wrapper, container.firstChild);
        },
        init() {
            this.initOfflineButton();
            if (document.getElementById('fb-custom-progress')) return;
            const el = document.createElement('div');
            el.id = 'fb-custom-progress';
            const container = document.querySelector('.fb-custom--main') || document.body;
            container.insertBefore(el, container.firstChild);
        },
        show(total) {
            this.init();
            const el = document.getElementById('fb-custom-progress');
            if (el) { el.style.display = 'block'; el.style.opacity = '1'; this.update(total, total); }
        },
        update(remaining, total) {
            const el = document.getElementById('fb-custom-progress');
            if (el) el.textContent = `📷 画像を圧縮中... 残り ${remaining} 枚 / 全 ${total} 枚`;
        },
        hide() {
            const el = document.getElementById('fb-custom-progress');
            if (el) { el.style.opacity = '0'; setTimeout(() => el.style.display = 'none', 300); }
        }
    };

    // =========================================================================
    // 5. データ保存 (IndexedDB 共通処理化)
    // =========================================================================
    const dbOp = {
        open() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = e => !e.target.result.objectStoreNames.contains(STORE_NAME) && e.target.result.createObjectStore(STORE_NAME);
                req.onsuccess = e => resolve(e.target.result);
                req.onerror = e => reject(e.target.error || new Error('保存領域が利用できません'));
            });
        },
        async execTx(mode, callback) {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, mode);
                const req = callback(tx.objectStore(STORE_NAME));
                tx.oncomplete = () => resolve(req?.result);
                tx.onerror = e => reject(req?.error || e.target.error);
            });
        },
        async save(record) {
            try {
                await this.execTx('readwrite', store => store.put(record, location.pathname));
            } catch (err) {
                if (err?.name === 'QuotaExceededError') alert('ストレージ容量制限に達しました。画像を減らしてください。');
                else alert('プライバシー設定等によりバックアップ機能が利用できません。送信は可能です。');
            }
        },
        load: () => dbOp.execTx('readonly', store => store.get(location.pathname)).catch(() => null),
        clear: () => dbOp.execTx('readwrite', store => store.delete(location.pathname)).catch(e => console.warn('消去エラー', e))
    };

    // =========================================================================
    // 6. 画像圧縮ロジック
    // =========================================================================
    document.head.appendChild(Object.assign(document.createElement('script'), { src: COMPRESSOR_LIB_URL }));
    const compressImage = async (file) => {
        if (!window.Compressor) await new Promise(r => setTimeout(r, 500));
        return new Promise((resolve, reject) => new window.Compressor(file, { ...COMPRESS_CONFIG, success: res => resolve(new File([res], file.name, { type: res.type })), error: reject }));
    };

    // =========================================================================
    // 7. データ保存の補助関数 (ファイル連携部・UI復元)
    // =========================================================================
    const saveWithOfflineFiles = async () => {
        if (isRestoring) return;
        const recordToSave = { ...formBridge.fn.getRecord() };
        const offlineFilesData = [...daemonMonitoringData];

        for (const input of document.querySelectorAll('input[type="file"]')) {
            if (input.files?.length > 0) {
                const wrapper = input.closest('[data-field-code]');
                if (!wrapper) continue;
                const fieldCode = wrapper.dataset.fieldCode, wrapperIndex = Array.from(document.querySelectorAll(`[data-field-code="${fieldCode}"]`)).indexOf(wrapper);
                
                const fileDatas = (await Promise.all(Array.from(input.files).map(async f => {
                    const data = await getBase64(f);
                    return data ? { name: f.name, type: f.type, data } : null;
                }))).filter(Boolean);

                if (fileDatas.length > 0) {
                    const idx = offlineFilesData.findIndex(d => d.fieldCode === fieldCode && d.wrapperIndex === wrapperIndex);
                    if (idx !== -1) offlineFilesData[idx].files = fileDatas;
                    else offlineFilesData.push({ fieldCode, wrapperIndex, files: fileDatas });
                }
            }
        }
        recordToSave.__timestamp = Date.now(); // 課題1: 保存日時を記録
        daemonMonitoringData = recordToSave.__offline_files_data = offlineFilesData;
        pendingSavePromise = dbOp.save(recordToSave).finally(() => pendingSavePromise = null);
    };

    const restoreUIForOfflineFile = (wrapper, input, fileDataArray) => {
        wrapper.setAttribute('data-offline-restored', 'true');
        wrapper.querySelectorAll('.el-upload, .fb-add-file, .fb-file-button, button.el-button, [type="button"]')
            .forEach(el => !el.className.includes('fb-offline-reset-btn') && !el.className.includes('fb-remove-row-btn') && (el.style.display = 'none', el.dataset.offlineHidden = 'true'));

        wrapper.querySelector('.fb-offline-indicator')?.remove();
        const indicator = document.createElement('div');
        indicator.className = 'fb-offline-indicator';
        indicator.innerHTML = `✅ <b>オフライン一時保存済:</b><br>${fileDataArray.map(f => `<div>📄 ${f.name}</div>`).join('')}<br><button type="button" class="fb-offline-reset-btn">選び直す</button>`;
        wrapper.appendChild(indicator);

        indicator.querySelector('.fb-offline-reset-btn').addEventListener('click', e => {
            e.stopPropagation();
            input.value = ''; input.dataset.processed = '';
            wrapper.removeAttribute('data-offline-restored');
            wrapper.querySelectorAll('[data-offline-hidden="true"]').forEach(el => (el.style.display = '', el.dataset.offlineHidden = ''));
            indicator.remove();
            
            const fieldCode = wrapper.dataset.fieldCode, idx = Array.from(document.querySelectorAll(`[data-field-code="${fieldCode}"]`)).indexOf(wrapper);
            daemonMonitoringData = daemonMonitoringData.filter(d => !(d.fieldCode === fieldCode && d.wrapperIndex === idx));
            saveWithOfflineFiles();
        });
    };

    // =========================================================================
    // 8. UX向上・堅牢性強化 (ネットワーク検知 / 容量事前チェック)
    // =========================================================================
    // 課題2: ネットワーク復帰検知
    window.addEventListener('online', () => {
        if (isOfflineMode) alert('📡 電波が回復し、オンライン状態に復帰しました！\\n未送信データを送信するには、上部ボタンからオンラインモードに戻してください。');
    });

    // 課題3: 容量事前チェック
    const checkStorageQuota = async () => {
        if (navigator.storage?.estimate) {
            try {
                const { usage, quota } = await navigator.storage.estimate();
                if (quota && usage) {
                    const remainingMb = (quota - usage) / (1024 * 1024);
                    // 残り50MB以下で警告
                    if (remainingMb > 0 && remainingMb < 50) alert(`⚠️ 端末の空き容量がわずかです（推定残り ${Math.round(remainingMb)}MB）。\n大きな画像を複数アップロードすると保存エラーになる可能性があります。`);
                }
            } catch (err) { console.warn('Storage check error:', err); }
        }
    };

    // =========================================================================
    // 9. FormBridge イベント連携
    // =========================================================================
    formBridge.events.on('form.show', async (context) => {
        checkStorageQuota(); // 画面表示時に容量をチェック
        ProgressIndicator.initOfflineButton();
        if (isOfflineMode) ProgressIndicator.toggleSubmitButton(true);
        if (backupRestored) return context;
        backupRestored = isRestoring = true;

        try {
            let backup = await dbOp.load();
            
            // 課題1: 古いバックアップデータの自動クリーンアップ (テスト用に30秒に短縮中)
            // タイムスタンプが存在しない過去のデータも古すぎるとみなして破棄します
            if (backup && (!backup.__timestamp || Date.now() - backup.__timestamp > 30 * 1000)) {
                console.log('🚮 古いバックアップ(30秒以上経過)を自動破棄しました。');
                await dbOp.clear();
                backup = null;
            }

            if (backup && Object.keys(backup).length && confirm('未送信の一時保存データが見つかりました。\\n前回入力していた内容や画像を復元しますか？')) {
                Object.keys(backup).forEach(key => {
                    if (key === '__offline_files_data' || !backup[key] || backup[key].type === 'FILE') return;
                    if (backup[key].type === 'SUBTABLE' && context.record?.[key]) context.record[key].value = backup[key].value;
                    else try { context.setFieldValue(key, backup[key].value); } catch { if(context.record?.[key]) context.record[key].value = backup[key].value; }
                });

                if (backup.__offline_files_data?.length) {
                    daemonMonitoringData = backup.__offline_files_data;
                    setTimeout(() => {
                        backup.__offline_files_data.forEach(data => {
                            const wrapper = document.querySelectorAll(`[data-field-code="${data.fieldCode}"]`)[data.wrapperIndex];
                            const input = wrapper?.querySelector('input[type="file"]');
                            if (input) {
                                try {
                                    applyFilesToInput(input, data.files);
                                    restoreUIForOfflineFile(wrapper, input, data.files);
                                    if (!isOfflineMode && navigator.onLine) setTimeout(() => input.dispatchEvent(new Event('change', { bubbles: true })), 100);
                                } catch (err) { console.error('File obj error:', err); }
                            }
                        });
                        isRestoring = false;
                    }, 2500);
                } else isRestoring = false;
            } else isRestoring = false;
        } catch (e) {
            console.error('復元エラー:', e); isRestoring = false;
        }
        return context;
    });

    document.addEventListener('change', async e => {
        if (e.target?.type !== 'file' || e.target.dataset.processed === 'true') return;
        const wrapper = e.target.closest('[data-field-code]');
        if (!PHOTO_FIELDS.includes(wrapper?.dataset.fieldCode)) return;

        e.stopPropagation(); e.stopImmediatePropagation();
        const dt = new DataTransfer(), originalFiles = Array.from(e.target.files), imageFiles = originalFiles.filter(f => f.type.startsWith('image/'));

        if (imageFiles.length > 0) {
            isCompressing = true; ProgressIndicator.show(imageFiles.length);
            let remaining = imageFiles.length;
            for (const file of originalFiles) {
                if (file.type.startsWith('image/')) {
                    try { dt.items.add(await compressImage(file)); } catch { dt.items.add(file); }
                    finally { ProgressIndicator.update(--remaining, imageFiles.length); }
                } else dt.items.add(file);
            }
            ProgressIndicator.hide(); isCompressing = false;
        } else originalFiles.forEach(f => dt.items.add(f));

        e.target.files = dt.files; e.target.dataset.processed = 'true';

        if (isOfflineMode || !navigator.onLine) {
            saveWithOfflineFiles();
            wrapper && restoreUIForOfflineFile(wrapper, e.target, [{ name: e.target.files[0]?.name || '画像' }]);
            return;
        }

        e.target.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => !isOfflineMode && wrapper.querySelector('.el-loading-mask, i.el-icon-loading')?.style.display !== 'none' && alert('⚠️ ネットワーク環境が不安定です(推奨:オフライン)'), 8000);
        setTimeout(saveWithOfflineFiles, 500);
    }, true);

    formBridge.events.on('form.show', (ctx) => {
        if (window.__fb_change_hooked) return ctx;
        window.__fb_change_hooked = true;
        formBridge.fn.getFieldSettings().forEach(s => {
            ['form.field.change.', 'form.kviewerLookup.selectRecord.'].forEach(ev => formBridge.events.on(ev + s.code, (ctx2) => { saveWithOfflineFiles(); return ctx2; }));
            if (s.type === 'SUBTABLE') {
                ['form.subtable.addRow.', 'form.subtable.removeRow.'].forEach(ev => formBridge.events.on(ev + s.code, (ctx2) => { saveWithOfflineFiles(); return ctx2; }));
                s.tableFields?.forEach(ts => ['form.field.change.', 'form.kviewerLookup.selectRecord.'].forEach(ev => formBridge.events.on(ev + `${s.code}.${ts.code}`, (ctx2) => { saveWithOfflineFiles(); return ctx2; })));
            }
        });
        return ctx;
    });

    setInterval(() => {
        if (isOfflineMode) ProgressIndicator.toggleSubmitButton(true);
        if (!daemonMonitoringData?.length) return;
        daemonMonitoringData.forEach(data => {
            const wrapper = document.querySelectorAll(`[data-field-code="${data.fieldCode}"]`)[data.wrapperIndex];
            if (wrapper && !wrapper.querySelector('.fb-offline-indicator')) {
                const input = wrapper.querySelector('input[type="file"]');
                if (input) {
                    try { applyFilesToInput(input, data.files); restoreUIForOfflineFile(wrapper, input, data.files); } 
                    catch (err) { console.error('Daemon:', err); }
                }
            }
        });
    }, 1500);

    const stopIfProcessing = (ctx, isConfirm = false) => {
        if (isCompressing) return alert('📷 現在画像を圧縮処理中です。完了するまでお待ちください。') || (ctx.preventDefault(), true);
        if (isConfirm && pendingSavePromise) return alert('💾 バックアップ保存中です。数秒待ってから再度お試しください。') || (ctx.preventDefault(), true);
        return false;
    };
    formBridge.events.on('form.confirm', ctx => {
        stopIfProcessing(ctx, true);
        return ctx; // FormBridgeの仕様上、フック内で必ずcontextを返す必要があります
    });
    
    const handleSubmit = ctx => {
        if (stopIfProcessing(ctx)) return ctx;
        if (pendingSavePromise) { ctx.preventDefault(); pendingSavePromise.then(() => formBridge.fn.emitSubmit()); }
        return ctx; // FormBridgeの仕様上、フック内で必ずcontextを返す必要があります
    };
    ['form.submit', 'confirm.submit'].forEach(ev => formBridge.events.on(ev, handleSubmit));
    
    // ▼ 送信が完全に終わったらバックアップデータを削除
    ['form.submitted', 'confirm.submitted'].forEach(ev => formBridge.events.on(ev, async (ctx) => {
        await dbOp.clear();
        return ctx; // submittedイベントは非同期ですが、確実にcontextを返す構成にします
    }));

})();