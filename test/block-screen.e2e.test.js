// בדיקת עשן E2E של מסך החסימה מול דפדפן אמיתי — Electron (כתלות קיימת).
// מריצה את renderer/block.html עם preload.js האמיתי ועם IPC אמיתי בתוך חלון
// Electron, ושולחת אליו סטטוסים בדיוק כמו התהליך הראשי (כולל מצב קובץ פגום).
// ה-harness מדווח E2E_RESULT <json> וקוד יציאה; כאן רק טוענים שהכול עבר.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');

// במוד Node, 'electron' מייצא את הנתיב לקובץ ההרצה עצמו
const electron = require('electron');

test('block E2E: מסך החסימה האמיתי ב-Electron — קובץ פגום וחזרה לקדמותו', async () => {
  const child = spawn(electron, [path.join(__dirname, 'e2e', 'block-harness.js')], {
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
  assert.ok(report.checks.length >= 12, 'צפויים לפחות 12 בדיקות E2E, התקבלו ' + report.checks.length);
  for (const c of report.checks) {
    assert.ok(c.ok, c.name + ' — ' + c.detail);
  }
});
