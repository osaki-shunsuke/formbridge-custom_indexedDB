const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  
  page.on('console', msg => console.log('LOG:', msg.text()));
  page.on('pageerror', err => console.log('ERROR:', err.message));
  page.on('dialog', async dialog => {
    console.log('DIALOG:', dialog.message());
    await dialog.accept();
  });
  
  await page.goto('https://8d33bd8d.form.kintoneapp.com/public/5a05fd61fb14962ce1e170f495717d5486cf0f1ad0cdd0265e8ee7d2e1059714');
  await page.waitForLoadState('networkidle');
  
  // Clear DB
  await page.evaluate(async () => {
    await new Promise(r => {
      const req = indexedDB.deleteDatabase('FormBridge_Backup_DB');
      req.onsuccess = r; req.onerror = r; req.onblocked = r;
    });
  });
  await page.reload();
  await page.waitForLoadState('networkidle');

  // Click Offline Mode
  await page.click('#fb-custom-offline-btn');
  await page.waitForTimeout(500);

  // Upload file
  console.log("Uploading file...");
  const fileInput = await page.locator('input[type="file"]').first();
  await fileInput.setInputFiles('dummy.jpg');
  await page.waitForTimeout(2000);

  // Check DB
  const dbData = await page.evaluate(async () => {
    const db = await new Promise((r,rj) => { const req = indexedDB.open('FormBridge_Backup_DB', 1); req.onsuccess = () => r(req.result); req.onerror = () => rj(); });
    const tx = db.transaction('record_backup', 'readonly');
    const store = tx.objectStore('record_backup');
    const req = store.get(location.pathname);
    return await new Promise((r) => { req.onsuccess = () => r(req.result); });
  });
  console.log("DB DATA AFTER UPLOAD:", JSON.stringify(dbData).substring(0, 100) + '...');

  // Reload
  console.log("Reloading...");
  await page.reload();
  await page.waitForTimeout(3000);
  
  const textHtml = await page.content();
  console.log("Restored HTML matching offline indicator:", textHtml.includes('オフライン一時保存済'));

  await browser.close();
})();
