//Antigravity作成後に手動修正 2026/03/09

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
    // 「復旧処理中か？」を記録する場所（復元前に空のデータで上書き保存されるのを防ぐ）
    let isRestoring = false;
    // 「オフラインモード（アップロード停止・一時保存専用）」がONかどうか（リロードしても記憶させる）
    let isOfflineMode = localStorage.getItem('fb_offline_mode') === 'true';
    // 不死身デーモンが監視するためのグローバルデータ（Vueに消されてもここから復活させる）
    let daemonMonitoringData = [];

    // =========================================================================
    // 3. UI部品 (進捗インジケーター & モード切替ボタン)
    // 画面のトップに「📷画像を圧縮中... 残り X 枚」という青い帯を表示する仕組み
    // =========================================================================
    const ProgressIndicator = {
        // 送信ボタンの表示・非表示を切り替えるメソッド
        toggleSubmitButton(hide) {
            // 通常画面の「確認」「送信」ボタンと、確認画面の「送信」ボタンをターゲットにする
            const submitButtons = document.querySelectorAll('.fb-submit, .confirm-submit');
            submitButtons.forEach(btn => {
                btn.style.display = hide ? 'none' : '';
            });

            // READMEの方針通り、テキストが「回答」「確認」「送信」のボタンも堅牢に隠す
            // <span>タグの内部にテキストがあるケースにも対応できるよう、span要素も含めて検知
            const allElements = document.querySelectorAll('button, a.el-button, .el-button, span');
            allElements.forEach(el => {
                const text = el.textContent.trim();
                if (text === '回答' || text === '確認' || text === '送信') {
                    const target = el.closest('button') || el.closest('a') || el.closest('.el-button') || el;
                    target.style.display = hide ? 'none' : '';
                }
            });
        },
        // オフラインモード切替ボタンの作成
        initOfflineButton() {
            if (document.getElementById('fb-custom-offline-btn')) return;
            const container = document.querySelector('.fb-custom--main') || document.body;

            const wrapper = document.createElement('div');
            wrapper.style.cssText = `
                display: flex;
                justify-content: flex-end;
                margin-bottom: 10px;
            `;
            const btn = document.createElement('button');
            btn.id = 'fb-custom-offline-btn';

            btn.style.cssText = `
                color: #ffffff;
                text-align: center;
                padding: 8px 15px;
                font-size: 14px;
                font-weight: bold;
                border: none;
                cursor: pointer;
                border-radius: 6px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                transition: all 0.3s;
                line-height: 1.2;
            `;

            const updateBtnUI = () => {
                if (isOfflineMode) {
                    btn.innerHTML = '✈️ オフライン(一時保存)モード<br><span style="font-size:11px;">(現在アップロード停止中)</span>';
                    btn.style.backgroundColor = '#6c757d';
                } else {
                    btn.innerHTML = '🌐 オンラインモード<br><span style="font-size:11px;">(クリックで一時保存専用に切替)</span>';
                    btn.style.backgroundColor = '#28a745';
                }
            };

            // 初期のUIセット
            updateBtnUI();

            // モード切替のクリック処理
            btn.onclick = (e) => {
                e.preventDefault();

                // 次のモードがどちらになるか判定
                const nextIsOnline = isOfflineMode; // 現在オフラインなら次はオンライン

                if (nextIsOnline) {
                    // 【オンラインに戻す場合】
                    const confirmReload = confirm('【オンラインモードに戻します】\n未送信の画像をFormBridgeサーバーへアップロードするため、ページを再読み込み（リロード）します。よろしいですか？');

                    if (confirmReload) {
                        isOfflineMode = false;
                        localStorage.setItem('fb_offline_mode', 'false');
                        // ページを強制リロード
                        location.reload();
                    }
                } else {
                    // 【オフラインにする場合】
                    isOfflineMode = true;
                    localStorage.setItem('fb_offline_mode', 'true');
                    updateBtnUI();
                    // 送信ボタンを隠す
                    ProgressIndicator.toggleSubmitButton(true);
                    alert('【オフラインモードをONにしました】\nこれ以降に添付された画像はFormBridgeへアップロードせず、すぐ裏側(IndexedDB)に保存して処理を終えます。ネットワーク接続が回復したら、このボタンをオンラインに戻してページを再読み込みしてください。');
                }
            };
            wrapper.appendChild(btn);
            container.insertBefore(wrapper, container.firstChild);
        },
        // 画面に青い帯の枠組みを作る
        init() {
            this.initOfflineButton();
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
    // 7. データ保存の補助関数 (IndexedDBと画面上のFile連携部分)
    // =========================================================================

    // 特別な保存処理：FormBridgeの公式データだけでなく、現在画面に残っているがアップロード前である「ファイルの中身」もかき集めて保存する
    const saveWithOfflineFiles = async () => {
        if (isRestoring) return; // 復元処理が終わるまでは保存処理をブロックし、上書きを防止する

        const currentRecord = formBridge.fn.getRecord();
        const recordToSave = Object.assign({}, currentRecord);

        const allFileInputs = document.querySelectorAll('input[type="file"]');
        const offlineFilesData = [...daemonMonitoringData]; // デーモンが記憶しているデータをベースにする

        // ファイルをBase64文字列に変換する関数（絶対にデータが消えないようにするため）
        const getBase64 = (file) => new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        });

        for (const input of Array.from(allFileInputs)) {
            // VueによるDOM上書きで消えた場合は input.filesが空になるが、
            // その場合でも「daemonMonitoringData」には記録が残っているので上書き消去されない
            if (input.files && input.files.length > 0) {
                const wrapper = input.closest('[data-field-code]');
                if (!wrapper) continue;

                const fieldCode = wrapper.getAttribute('data-field-code');
                const sameCodeWrappers = document.querySelectorAll(`[data-field-code="${fieldCode}"]`);
                const wrapperIndex = Array.from(sameCodeWrappers).indexOf(wrapper);

                const fileDatas = [];
                for (const file of Array.from(input.files)) {
                    const b64 = await getBase64(file);
                    if (b64) {
                        fileDatas.push({ name: file.name, type: file.type, data: b64 });
                    }
                }

                if (fileDatas.length > 0) {
                    const existingIndex = offlineFilesData.findIndex(d => d.fieldCode === fieldCode && d.wrapperIndex === wrapperIndex);
                    if (existingIndex !== -1) {
                        offlineFilesData[existingIndex].files = fileDatas;
                    } else {
                        offlineFilesData.push({
                            fieldCode: fieldCode,
                            wrapperIndex: wrapperIndex,
                            files: fileDatas
                        });
                    }
                }
            }
        }

        recordToSave.__offline_files_data = offlineFilesData;
        daemonMonitoringData = offlineFilesData; // デーモンにも最新状態を同期する

        pendingSavePromise = dbOp.save(recordToSave).then(() => {
            pendingSavePromise = null;
        }).catch(() => { pendingSavePromise = null; });
    };

    // 画像復元処理のヘルパー関数
    const restoreUIForOfflineFile = (wrapper, input, fileDataArray) => {
        // FormBridgeのVueがDOMを書き換えても残るよう、親要素に属性を付ける
        wrapper.setAttribute('data-offline-restored', 'true');

        // デフォルト要素を隠す
        const hideTargets = wrapper.querySelectorAll('.el-upload, .fb-add-file, .fb-file-button, button.el-button, [type="button"]');
        hideTargets.forEach(el => {
            if (!el.classList.contains('fb-offline-reset-btn') && !el.classList.contains('fb-remove-row-btn')) {
                el.style.display = 'none';
                el.dataset.offlineHidden = 'true';
            }
        });

        // 古いメッセージ削除
        let indicator = wrapper.querySelector('.fb-offline-indicator');
        if (indicator) indicator.remove();

        indicator = document.createElement('div');
        indicator.className = 'fb-offline-indicator';
        indicator.style.cssText = 'background-color:#d4edda; color:#155724; padding:10px; border-radius:4px; margin-top:5px; border:1px solid #c3e6cb; font-size:14px; text-align: left; line-height: 1.5; z-index: 10;';

        const fileNamesHtml = fileDataArray.map(f => `<div>📄 ${f.name}</div>`).join('');
        indicator.innerHTML = `✅ <b>オフライン一時保存済:</b><br>${fileNamesHtml}<br><button type="button" class="fb-offline-reset-btn" style="margin-top:8px; padding:4px 10px; font-size:12px; cursor:pointer; background:#fff; border:1px solid #aaa; border-radius:3px;">選び直す</button>`;
        wrapper.appendChild(indicator);

        indicator.querySelector('.fb-offline-reset-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            input.value = '';
            input.dataset.processed = '';
            wrapper.removeAttribute('data-offline-restored');
            wrapper.querySelectorAll('[data-offline-hidden="true"]').forEach(el => {
                el.style.display = '';
                el.dataset.offlineHidden = '';
            });
            indicator.remove();

            // 自らデーモンの監視対象から除外する
            const fieldCode = wrapper.getAttribute('data-field-code');
            const sameCodeWrappers = document.querySelectorAll(`[data-field-code="${fieldCode}"]`);
            const wrapperIndex = Array.from(sameCodeWrappers).indexOf(wrapper);
            daemonMonitoringData = daemonMonitoringData.filter(d => !(d.fieldCode === fieldCode && d.wrapperIndex === wrapperIndex));

            saveWithOfflineFiles();
        });
    };

    // 同期的にBase64からBlobを作成するヘルパー（CSPでfetchが弾かれる現象の回避）
    const base64ToBlob = (base64Str, contentType) => {
        const parts = base64Str.split(',');
        const bstr = atob(parts[1] || parts[0]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
        }
        return new Blob([u8arr], { type: contentType });
    };

    // =========================================================================
    // 8. FormBridge イベント連携（自動保存・復元を行うタイミングの設定）
    // =========================================================================

    // ▼ 表示時：バックアップ（indexedDB）の復元とボタン設置
    formBridge.events.on('form.show', async (context) => {
        ProgressIndicator.initOfflineButton(); // 画面表示時にオフラインボタンを設置
        // 初期状態がオフラインならボタンを隠す
        if (isOfflineMode) {
            ProgressIndicator.toggleSubmitButton(true);
        }
        if (backupRestored) return; // 復元確認は1回だけ行う
        backupRestored = true;
        isRestoring = true;

        try {
            const backup = await dbOp.load();
            if (backup && Object.keys(backup).length > 0) {
                // デフォルト値などでisDirtyの判定が狂うのを防ぐため、バックアップデータが存在すれば常に確認を出す
                const requireRestore = confirm('未送信の一時保存データが見つかりました。\n前回入力していた内容や画像を復元しますか？');
                if (requireRestore) {
                    // 通常の文字入力などのフィールドを復元
                    Object.keys(backup).forEach(key => {
                        if (key === '__offline_files_data') return;
                        if (!backup[key]) return;

                        if (backup[key].type === 'FILE') {
                            // ファイルは直後にDOMレベルで専用の復元処理をするためスキップ
                            return;
                        } else if (backup[key].type === 'SUBTABLE') {
                            // サブテーブルは setFieldValue だと『Unexpected field type: SUBTABLE』エラーになるため直接 record へ復元
                            if (context.record && context.record[key]) {
                                context.record[key].value = backup[key].value;
                            }
                        } else {
                            try {
                                context.setFieldValue(key, backup[key].value);
                            } catch (e) {
                                console.warn('フィールド復元エラー:', key, e);
                                if (context.record && context.record[key]) {
                                    context.record[key].value = backup[key].value;
                                }
                            }
                        }
                    });

                    // 【追加】オフラインモード時に保存されたファイル画像たちを復元する
                    if (backup.__offline_files_data && backup.__offline_files_data.length > 0) {
                        daemonMonitoringData = backup.__offline_files_data; // デーモンに記憶させる

                        // サブテーブルの行などが描画されるのを長めに待つ(1.5秒)
                        setTimeout(async () => {
                            for (const data of backup.__offline_files_data) {
                                const sameCodeWrappers = document.querySelectorAll(`[data-field-code="${data.fieldCode}"]`);
                                const wrapper = sameCodeWrappers[data.wrapperIndex];

                                // 当時の画面上の順番(DOM階層)と同じ位置のファイル入力欄に書き戻す
                                if (wrapper) {
                                    const input = wrapper.querySelector('input[type="file"]');
                                    if (input) {
                                        try {
                                            // まずは常にファイルをセットする
                                            const dt = new DataTransfer();
                                            for (const f of data.files) {
                                                const blob = base64ToBlob(f.data, f.type || 'image/jpeg');
                                                const fObj = new File([blob], f.name || 'image.jpg', { type: f.type || 'image/jpeg' });
                                                dt.items.add(fObj);
                                            }
                                            input.files = dt.files;
                                            input.dataset.processed = 'true';

                                            // オンラインかつ復元直後の場合はアップロードを試みる、ただしオフライン専用 UI を上書きするためオンラインでも UI ガードする
                                            if (!isOfflineMode && navigator.onLine) {
                                                // 復元直後すぐに dispatchEvent すると Vue が追いつかず消えるので、確実に UI を一時保存化してから FormBridge に流す
                                                restoreUIForOfflineFile(wrapper, input, data.files);
                                                setTimeout(() => {
                                                    input.dispatchEvent(new Event('change', { bubbles: true }));
                                                }, 100);
                                            } else {
                                                restoreUIForOfflineFile(wrapper, input, data.files);
                                            }
                                        } catch (err) {
                                            console.error('File object reconstruction error:', err);
                                        }
                                    }
                                }
                            }
                            isRestoring = false; // 復元の全工程が完了したら保存許可
                        }, 2500); // UI構築待ち(長めに待つ)
                    } else {
                        isRestoring = false;
                    }

                    console.log('✅ IndexedDBからデータを復元しました（サブテーブル含む）');
                } else {
                    isRestoring = false;
                }
            } else {
                isRestoring = false;
            }
        } catch (e) {
            console.error('復元にかかわるエラー:', e);
            isRestoring = false;
        }

        // FormBridgeへ書き換えた状態を返す(状態更新を反映させるため)
        return context;
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

        // ------------------------------------------------------------------------
        // 【重要】オフラインモードの場合の分岐（FormBridgeを意図的に止める）
        // ------------------------------------------------------------------------
        if (isOfflineMode || !navigator.onLine) {
            // 一時保存処理のみを実行
            saveWithOfflineFiles();

            // UI更新: ユーザーに一時保存完了が伝わるようにする
            if (wrapper) {
                restoreUIForOfflineFile(wrapper, e.target, [{ name: e.target.files[0] ? e.target.files[0].name : '画像' }]);
            }

            // FormBridgeに通知(dispatchEvent)を行わずにここで強制終了するため、永遠のグルグルは起きません。
            return;
        }

        // FormBridgeへ「ファイルの準備が終わったこと」を伝達する (これによりアップロード開始)
        e.target.dispatchEvent(new Event('change', { bubbles: true }));

        // 通信遅延のキャッチ（8秒間監視して、まだ通信中なら警告を出す）
        const spinnerCheckWrapper = wrapper;
        setTimeout(() => {
            if (isOfflineMode) return;
            // fb-loading系やel-icon-loadingなどのスピナー表示が残っているか
            const spinner = spinnerCheckWrapper.querySelector('.el-loading-mask, i.el-icon-loading');
            if (spinner && spinner.style.display !== 'none') {
                alert('⚠️ 画像のアップロードに時間がかかっています。\nネットワーク環境が不安定な場合は、画面上部の「オフラインモード」をONにして一時保存のみ行うことをお勧めします。');
            }
        }, 8000);

        // 写真のセットからわずかに遅らせて、入力中のデータを全て一時保存（バックアップ）する
        setTimeout(() => {
            saveWithOfflineFiles();
        }, 500);

    }, true);

    // ▼ それ以外のテキスト入力・項目の変更があった際も、自動で一時保存する
    formBridge.events.on('form.show', () => {
        if (window.__fb_change_hooked) return;
        window.__fb_change_hooked = true;

        // この関数が呼ばれると画面の今の状態がすべて保存される
        const saveHandler = () => {
            saveWithOfflineFiles();
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

    // 画面の監視（Vueの仮想DOM差分更新によって独自のUIが吹き飛ばされても必ず復活させるデーモン）
    setInterval(() => {
        // オフラインモードなら、常に送信ボタンを隠し続ける
        if (isOfflineMode) {
            ProgressIndicator.toggleSubmitButton(true);
        }
        // オフラインモードに関わらず、デーモンの記憶にデータが残っていれば絶対にUIを維持する
        if (!daemonMonitoringData || daemonMonitoringData.length === 0) return;

        daemonMonitoringData.forEach(data => {
            const sameCodeWrappers = document.querySelectorAll(`[data-field-code="${data.fieldCode}"]`);
            const wrapper = sameCodeWrappers[data.wrapperIndex];

            if (wrapper) {
                const indicator = wrapper.querySelector('.fb-offline-indicator');
                if (!indicator) {
                    // Vueの再描画でDOMが消えた場合、または未構築の場合、強制的に蘇生させる
                    const input = wrapper.querySelector('input[type="file"]');
                    if (input) {
                        try {
                            const dt = new DataTransfer();
                            data.files.forEach(f => {
                                const blob = base64ToBlob(f.data, f.type || 'image/jpeg');
                                const fObj = new File([blob], f.name || 'image.jpg', { type: f.type || 'image/jpeg' });
                                dt.items.add(fObj);
                            });
                            input.files = dt.files;
                            input.dataset.processed = 'true';
                            restoreUIForOfflineFile(wrapper, input, data.files);
                            // console.log('👻 不死身デーモンがUIを復元しました');
                        } catch (err) {
                            console.error('Daemon restoration error:', err);
                        }
                    }
                }
            }
        });
    }, 1500);

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