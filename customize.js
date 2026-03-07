(function () {
    'use strict';

    // =========================================================================
    // 1. 設定エリア
    // =========================================================================
    const DB_NAME = 'FormBridge_Backup_DB';
    const STORE_NAME = 'record_backup';
    const DB_VERSION = 1;

    // 圧縮対象のフィールドコード（添付ファイルフィールド）
    const PHOTO_FIELDS = ['作業前', '作業後'];

    const COMPRESS_CONFIG = {
        quality: 0.6,
        maxWidth: 1280,
        mimeType: 'image/jpeg'
    };

    const COMPRESSOR_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/compressorjs/1.2.1/compressor.min.js';

    // =========================================================================
    // 2. IndexedDB 操作ユーティリティ
    // =========================================================================
    const dbOp = {
        open() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME);
                    }
                };
                request.onsuccess = (e) => resolve(e.target.result);
                request.onerror = (e) => reject(e.target.error);
            });
        },
        async save(record) {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                // フォームのパス（URL）をキーにして保存
                store.put(record, location.pathname);
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(e.target.error);
            });
        },
        async load() {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const request = store.get(location.pathname);
                request.onsuccess = (e) => resolve(e.target.result);
                request.onerror = (e) => reject(e.target.error);
            });
        },
        async clear() {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                store.delete(location.pathname);
                tx.oncomplete = () => resolve();
            });
        }
    };

    // =========================================================================
    // 3. 画像圧縮ロジック（既存のハイジャック方式を統合）
    // =========================================================================
    // ライブラリのロード
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
    // 4. FormBridge イベント連携
    // =========================================================================

    // 表示時：バックアップの復元
    formBridge.events.on('form.show', async (context) => {
        try {
            const backup = await dbOp.load();
            if (backup && Object.keys(backup).length > 0) {
                // すでにデータがある場合は上書きしない（ユーザーの意志を尊重）
                const current = formBridge.fn.getRecord();
                const isDirty = Object.values(current).some(v => v.value && v.value.length > 0);

                if (!isDirty && confirm('一時保存されているデータが見つかりました。復元しますか？')) {
                    Object.keys(backup).forEach(key => {
                        context.setFieldValue(key, backup[key].value);
                    });
                    console.log('✅ IndexedDBからデータを復元しました');
                }
            }
        } catch (e) {
            console.error('復元エラー:', e);
        }
    });

    // 値変更時：バックアップの保存
    // 画像圧縮と保存を連動させるため、Captureフェーズでchangeを監視
    document.addEventListener('change', async function (e) {
        if (!e.target || e.target.type !== 'file') return;

        const wrapper = e.target.closest('[data-field-code]');
        if (!wrapper) return;
        const fieldCode = wrapper.getAttribute('data-field-code');
        if (!PHOTO_FIELDS.includes(fieldCode)) return;
        if (e.target.dataset.processed === 'true') return;

        // ハイジャック
        e.stopPropagation();
        e.stopImmediatePropagation();

        const dt = new DataTransfer();
        const originalFiles = Array.from(e.target.files);

        for (const file of originalFiles) {
            if (file.type.startsWith('image/')) {
                const compressed = await compressImage(file);
                dt.items.add(compressed);
            } else {
                dt.items.add(file);
            }
        }

        e.target.files = dt.files;
        e.target.dataset.processed = 'true';

        // FormBridgeに通知
        e.target.dispatchEvent(new Event('change', { bubbles: true }));

        // ★ここで IndexedDB に即時保存
        setTimeout(async () => {
            const currentRecord = formBridge.fn.getRecord();
            await dbOp.save(currentRecord);
            console.log('💾 画像追加に伴い IndexedDB に保存しました');
        }, 500);

    }, true);

    // テキスト入力の変更も監視して保存
    formBridge.events.on('form.show', () => {
        // フィールド設定を取得して全フィールドの変更を監視
        const settings = formBridge.fn.getFieldSettings();
        settings.forEach(s => {
            formBridge.events.on(`form.field.change.${s.code}`, async () => {
                const record = formBridge.fn.getRecord();
                await dbOp.save(record);
            });
        });
    });

    // 送信完了時：バックアップの削除
    formBridge.events.on('form.submitted', async () => {
        await dbOp.clear();
        console.log('🗑️ 送信完了のためバックアップを削除しました');
    });

})();