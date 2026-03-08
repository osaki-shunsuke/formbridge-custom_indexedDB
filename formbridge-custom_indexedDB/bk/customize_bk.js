//オフライン対応前のコード
(function () {
    'use strict';

    // =========================================================================
    // 1. 設定エリア
    // =========================================================================
    // ブラウザに備わっている保存領域（IndexedDB）の名前と管理番号
    const DB_NAME = 'FormBridge_Backup_DB';
    const STORE_NAME = 'record_backup';
    const DB_VERSION = 1;

    // 圧縮・保存の対象となる「添付ファイル」フィールドの名前
    // ※表（サブテーブル）の中にあってもこの名前で自動的に判定します
    const PHOTO_FIELDS = ['作業前', '作業後'];

    // 画像を圧縮する際の設定（画質70%、横幅の最大サイズを1280pxに縮小）
    const COMPRESS_CONFIG = {
        quality: 0.7,
        maxWidth: 1280,
        mimeType: 'image/jpeg'
    };

    // 画像圧縮を行うライブラリ(CDN)のURL
    const COMPRESSOR_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/compressorjs/1.2.1/compressor.min.js';

    // =========================================================================
    // 2. 状態管理変数（裏側で何が起きているかを記録）
    // =========================================================================
    // 「保存処理が行われている最中か？」を記録する場所
    let pendingSavePromise = null;
    // 「画像を圧縮している最中か？」を記録する場所
    let isCompressing = false;
    // 「すでに一時保存データを復元したか？」を記録する場所（何度も聞かれないようにするため）
    let backupRestored = false;

    // =========================================================================
    // 3. UI部品 (進捗インジケーター)
    // 画面のトップに「📷画像を圧縮中... 残り X 枚」という青い帯を表示する仕組み
    // =========================================================================
    const ProgressIndicator = {
        // 画面に青い帯の枠組みを作る
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
        // 合計枚数を受け取って青い帯を表示する
        show(total) {
            this.init();
            const el = document.getElementById('fb-custom-progress');
            if (el) {
                el.style.display = 'block';
                el.style.opacity = '1';
                this.update(total, total);
            }
        },
        // 圧縮が終わるたびに「残り 何枚」の数字を減らして更新する
        update(remaining, total) {
            const el = document.getElementById('fb-custom-progress');
            if (el) {
                el.textContent = `📷 画像を圧縮中... 残り ${remaining} 枚 / 全 ${total} 枚`;
            }
        },
        // 全て終わったら青い帯を隠す
        hide() {
            const el = document.getElementById('fb-custom-progress');
            if (el) {
                el.style.opacity = '0';
                setTimeout(() => {
                    el.style.display = 'none';
                }, 300); // 0.3秒かけて消す
            }
        }
    };

    // =========================================================================
    // 4. データ保存の仕組み・エラーハンドリング（IndexedDB 操作）
    // ブラウザの中に「一時保存データ」を読み書きする機能
    // =========================================================================
    const dbOp = {
        // 保存領域を準備する（開く）
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
                    request.onerror = (e) => reject(e.target.error || new Error('保存領域が利用できません'));
                } catch (err) {
                    reject(err);
                }
            });
        },
        // 入力された文字や写真を保存する（スマホの容量限界等のエラーもキャッチする）
        async save(record) {
            try {
                const db = await this.open();
                return await new Promise((resolve, reject) => {
                    const tx = db.transaction(STORE_NAME, 'readwrite');
                    const store = tx.objectStore(STORE_NAME);
                    // フォームのURLを箱のラベルにしてデータをしまう
                    const request = store.put(record, location.pathname);
                    tx.oncomplete = () => resolve();
                    tx.onerror = (e) => reject(request.error || e.target.error);
                });
            } catch (error) {
                console.error('保存に失敗:', error);
                const errName = error && error.name;
                // ブラウザの容量オーバー等のエラーが出た際の警告メッセージ
                if (errName === 'QuotaExceededError') {
                    alert('端末のストレージ容量制限に達したため、バックアップ保存できませんでした。\n画像の枚数を減らすか、空き容量を確保してください。');
                } else if (errName === 'NotAllowedError' || errName === 'SecurityError' || !error) {
                    alert('ブラウザのプライバシー設定（プライベートブラウズ等）によりバックアップ機能が利用できません。\n入力データは保護されませんが、送信自体は可能です。');
                }
            }
        },
        // しまってあった一時保存データを取り出す
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
                return null;
            }
        },
        // 一時保存データを全て消去する（送信が終わったあとに空にするため）
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
                console.warn('indexedDB消去エラー:', error);
            }
        }
    };

    // =========================================================================
    // 5. データ検索ロジック（サブテーブル対応）
    // =========================================================================
    // フォームの中にサブテーブルがある場合、そのデータも対象とするための関数
    function traverseRecord(record, callback) {
        if (!record || typeof record !== 'object') return;

        Object.keys(record).forEach(fieldCode => {
            const field = record[fieldCode];
            if (!field) return;

            // 見つけたデータに対して指定の処理（保存やチェック）を行う
            callback(field, fieldCode);

            // もしサブテーブルだったら、その中の行を1つずつチェック
            if (field.type === 'SUBTABLE' && Array.isArray(field.value)) {
                field.value.forEach(row => {
                    if (row && row.value) {
                        traverseRecord(row.value, callback);
                    }
                });
            }
        });
    }

    // 「現在開いている画面に、すでに何か文字などが入力されているか？」を判定する関数
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
    // 設定エリアで指定した外部プログラム（Compressor.js）を使って画像サイズを小さくする
    // =========================================================================
    const script = document.createElement('script');
    script.src = COMPRESSOR_LIB_URL;
    document.head.appendChild(script);

    async function compressImage(file) {
        // プログラムが読み込まれるまで少し待つ
        if (!window.Compressor) {
            await new Promise(r => setTimeout(r, 500));
        }
        return new Promise((resolve, reject) => {
            new window.Compressor(file, {
                ...COMPRESS_CONFIG,
                success: (res) => resolve(new File([res], file.name, { type: res.type })), // 圧縮成功
                error: (err) => reject(err) // 圧縮失敗
            });
        });
    }

    // =========================================================================
    // 7. FormBridge イベント連携（自動保存・復元を行うタイミングの設定）
    // =========================================================================

    // ▼ 表示時：バックアップ（indexedDB）の復元
    formBridge.events.on('form.show', async (context) => {
        if (backupRestored) return; // 復元確認は1回だけ行う
        backupRestored = true;

        try {
            const backup = await dbOp.load();
            if (backup && Object.keys(backup).length > 0) {
                const current = formBridge.fn.getRecord();
                const isDirty = isRecordDirty(current);

                // 画面がまだ白紙の場合にのみ、「復元しますか？」と聞く
                if (!isDirty && confirm('一時保存されているデータが見つかりました。復元しますか？')) {
                    Object.keys(backup).forEach(key => {
                        context.setFieldValue(key, backup[key].value);
                    });
                    console.log('✅ IndexedDBからデータを復元しました（サブテーブル含む）');
                }
            }
        } catch (e) {
            console.error('復元にかかわるエラー:', e);
        }
    });

    // ▼ 写真が選択された時：まず画像を圧縮して、その後に一時保存する
    document.addEventListener('change', async function (e) {
        // 選ばれたのがファイルじゃない場合は引き返す
        if (!e.target || e.target.type !== 'file') return;

        const wrapper = e.target.closest('[data-field-code]');
        if (!wrapper) return;

        const fieldCode = wrapper.getAttribute('data-field-code');
        // 「作業前」「作業後」等の対象項目じゃなければ引き返す
        if (!PHOTO_FIELDS.includes(fieldCode)) return;
        if (e.target.dataset.processed === 'true') return;

        // ここから先はFormBridge本来の動きを裏で一時停止させて自前のプログラムを割り込ませる
        e.stopPropagation();
        e.stopImmediatePropagation();

        const dt = new DataTransfer();
        const originalFiles = Array.from(e.target.files);
        // 選ばれたファイルの中から写真（画像）だけを区別する
        const imageFiles = originalFiles.filter(f => f.type.startsWith('image/'));

        if (imageFiles.length > 0) {
            isCompressing = true; // 「圧縮中」のフラグを付ける（この間は送信できなくする）
            ProgressIndicator.show(imageFiles.length); // 画面上に青い帯を表示
            let remaining = imageFiles.length;

            // 添付された写真を1枚ずつ順番に圧縮していく
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
                        ProgressIndicator.update(remaining, imageFiles.length); // 残り枚数を減らして帯の文字を変える
                    }
                } else {
                    dt.items.add(file); // 写真以外（PDF等）はそのまま扱う
                }
            }
            ProgressIndicator.hide(); // 全部終わったら青い帯を消す
            isCompressing = false; // 「圧縮中」の印を外す
        } else {
            // 画像以外がアップロードされた場合
            for (const file of originalFiles) dt.items.add(file);
        }

        // 圧縮されたキレイな写真を、見えない所で入力欄にセットし直す
        e.target.files = dt.files;
        e.target.dataset.processed = 'true';

        // FormBridgeへ「ファイルの準備が終わったこと」を伝達する
        e.target.dispatchEvent(new Event('change', { bubbles: true }));

        // 写真のセットからわずかに遅らせて、入力中のデータを全て一時保存（バックアップ）する
        setTimeout(() => {
            const currentRecord = formBridge.fn.getRecord();
            pendingSavePromise = dbOp.save(currentRecord).then(() => {
                pendingSavePromise = null;
            });
        }, 500);

    }, true);

    // ▼ それ以外のテキスト入力・項目の変更があった際も、自動で一時保存する
    formBridge.events.on('form.show', () => {
        if (window.__fb_change_hooked) return;
        window.__fb_change_hooked = true;

        // この関数が呼ばれると画面の今の状態がすべて保存される
        const saveHandler = () => {
            const record = formBridge.fn.getRecord();
            pendingSavePromise = dbOp.save(record).then(() => {
                pendingSavePromise = null;
            }).catch(() => { pendingSavePromise = null; });
        };

        // 全部の入力欄に対し、「文字が打たれる・選ばれる」度に保存処理を行うよう監視をつける
        const settings = formBridge.fn.getFieldSettings();
        settings.forEach(s => {
            formBridge.events.on(`form.field.change.${s.code}`, saveHandler);
            formBridge.events.on(`form.kviewerLookup.selectRecord.${s.code}`, saveHandler);

            // サブテーブルのイベント監視：「行の追加・削除・変更」も監視する
            if (s.type === 'SUBTABLE') {
                formBridge.events.on(`form.subtable.addRow.${s.code}`, saveHandler);
                formBridge.events.on(`form.subtable.removeRow.${s.code}`, saveHandler);

                if (s.tableFields) {
                    s.tableFields.forEach(ts => {
                        formBridge.events.on(`form.field.change.${s.code}.${ts.code}`, saveHandler);
                        formBridge.events.on(`form.kviewerLookup.selectRecord.${s.code}.${ts.code}`, saveHandler);
                    });
                }
            }
        });
    });

    // =========================================================================
    // 8. ページ遷移・送信時（「確認」「回答」ボタンを押したとき）の制御ロジック（安全措置）
    // =========================================================================

    // 「画像を圧縮している途中」や「保存処理中」に送信ボタンが押されたら、処理が終わるまで意図的に待たせる仕組み
    const stopIfProcessing = (context, isConfirmScreen = false) => {
        if (isCompressing) {
            alert('📷 現在画像を圧縮処理中です。完了するまでお待ちください。');
            context.preventDefault(); // 画面遷移をここで一旦ストップ
            return true;
        }
        if (isConfirmScreen && pendingSavePromise) {
            alert('💾 バックアップ保存中です。数秒待ってから再度お試しください。');
            context.preventDefault(); // 画面遷移をここで一旦ストップ
            return true;
        }
        return false;
    };

    // 「確認画面」へ移動するボタンが押された時のチェック
    formBridge.events.on('form.confirm', (context) => {
        stopIfProcessing(context, true);
    });

    // 「送信（回答）」ボタンが押された時のチェック
    const handleSubmit = (context) => {
        if (stopIfProcessing(context, false)) return;

        // まだ裏側で一時保存処理が動いていれば、それが終わるのを待ってから「自動で」再送信する
        if (pendingSavePromise) {
            context.preventDefault(); // エラーにならないよう送信を一旦ストップ

            // 保存が終わったタイミングで、プログラム側から改めて送信ボタンを押す
            pendingSavePromise.then(() => {
                formBridge.fn.emitSubmit();
            });
        }
    };

    // どの画面からの送信時でもチェックを通す
    formBridge.events.on('form.submit', handleSubmit);
    formBridge.events.on('confirm.submit', handleSubmit);

    // ▼ 送信が完全に終わったら（サンクスページ等）、用済みのバックアップデータを綺麗に削除する
    const clearBackup = async () => {
        await dbOp.clear();
    };
    formBridge.events.on('form.submitted', clearBackup);
    formBridge.events.on('confirm.submitted', clearBackup);

})();