// בדיקת E2E אמיתית של הדפדפן המוגבל — Electron + Chromium אמיתיים.
// ה-harness (test/e2e/locked-browser-harness.js) מריץ את הגנות הניווט האמיתיות
// מ-locked-browser.js מול שרת HTTP מקומי (אין תלות באינטרנט) — פעמיים, בשני
// המצבים של רשימת האתרים שחולקים את אותן הגנות: רשימת חסימה (הדפדפן המוגבל)
// ורשימת היתר (אתר מאושר). בכל תרחיש נבדק שניווט לאתר האסור נחסם בפועל —
// ניווט ישיר, הפניה, meta-refresh, מסגת iframe ופתיחת חלון חדשה — ושאין
// חסימת-יתר לכתובות המותרות.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');

// במוד Node, 'electron' מייצא את הנתיב לקובץ ההרצה עצמו
const electron = require('electron');

test('locked browser E2E: שני מצבי רשימת האתרים חוסמים ניווט לאתר האסור בדפדפן אמיתי', async () => {
  const child = spawn(electron, [path.join(__dirname, 'e2e', 'locked-browser-harness.js')], {
    env: { ...process.env, ELECTRON_E2E: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });

  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill();
      reject(new Error('E2E פסק זמן — Electron לא נסגר תוך 90 שניות'));
    }, 90000);
    child.on('close', (c) => { clearTimeout(t); resolve(c); });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });

  const m = /E2E_RESULT (\{.*\})/.exec(stdout);
  assert.ok(m,
    'דוח E2E חסר בפלט.\n--- stderr ---\n' + stderr.slice(-1500) +
    '\n--- stdout ---\n' + stdout.slice(-1500));

  const report = JSON.parse(m[1]);
  assert.equal(code, 0, 'קוד יציאה של ה-harness: ' + code + ' — ' + stderr.slice(-500));
  for (const c of report.checks) {
    assert.ok(c.ok, c.name + ' — ' + c.detail);
  }
  assert.ok(report.checks.length >= 35, 'צפויים לפחות 35 אימותי E2E, התקבלו ' + report.checks.length);

  // שני המצבים חייבים להיות מכוסים, וכל אחד מהם עם אימות חסימה ואימות אי-חסימת-יתר
  const names = report.checks.map((c) => c.name).join(' | ');
  for (const mode of ['רשימת חסימה', 'רשימת היתר']) {
    assert.ok(names.indexOf(mode) >= 0, 'התרחיש "' + mode + '" לא רץ: ' + names);
    const forMode = report.checks.filter((c) => c.name.indexOf(mode) === 0).map((c) => c.name).join(' | ');
    assert.match(forMode, /נחסם/, mode + ': חסרים אימותים של חסימה: ' + forMode);
    assert.match(forMode, /מותר/, mode + ': חסר אימות שאין חסימת-יתר: ' + forMode);
  }
});
