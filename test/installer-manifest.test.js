// בדיקות לחיזוק נתיב ההתקנה/העדכון:
//   1) לוגיקת תיקון מניפסט ההרשאה של קובץ ההתקנה (requireAdministrator → asInvoker)
//   2) הרמה עצמית של המתקין ב-preInit, בסדר הנכון (לפני דגלי העצירה)
//   3) שהבנייה (npm run dist) אכן מריצה את התיקון — כדי שלא ישוחרר מתקין
//      "שדורש הרשאות" שוב, ושעדכון מתוך התוכנה לא ייכשל שוב בשקט.
//
// הסיבה לקיומה: התקלה המקורית (עדכון שהצהיר "מתקין", סגר את התוכנה ולא התקין
// כלום) לא הפילה שום בדיקה — היא פשוט לא עבדה, בשקט. הבדיקות כאן נופלות מיד
// אם ההגנות האלה מוסרות או מפסיקות להתאים למציאות.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { patchBuffer, patchFile, removeStaleMetadata, MANIFEST_FROM } = require('../scripts/patch-installer-manifest.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ==================== 1) לוגיקת התיקון ==================== */

// קובץ PE מדומה עם מניפסט בדיוק כמו זה ש-NSIS מנפיק
function fakeInstaller(level) {
  const manifest =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">' +
    '<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>' +
    '<requestedExecutionLevel level="' + level + '" uiAccess="false"/>' +
    '</requestedPrivileges></security></trustInfo></assembly>';
  const buf = Buffer.alloc(0x100 + Buffer.byteLength(manifest, 'utf8') + 64, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew
  buf.writeUInt32LE(0x00004550, 0x80); // "PE\0\0"
  buf.write(manifest, 0x100, 'utf8');
  return buf;
}
const contains = (buf, str) => buf.indexOf(str, 0, 'utf8') !== -1;

test('installer-manifest: requireAdministrator מוחלף ל-asInvoker בלי לשנות את גודל הקובץ', () => {
  const original = fakeInstaller('requireAdministrator');
  const patched = patchBuffer(original);
  assert.equal(patched.length, original.length, 'גודל הקובץ חייב להישאר זהה (מבנה PE ו-resource)');
  assert.ok(!contains(patched, 'requireAdministrator'), 'requireAdministrator לא אמור להישאר');
  // הריפוד חייב לנחות *בין* תכונות התג — אחרת הערך היה "asInvoker   " ולא תקין
  assert.match(
    patched.toString('utf8'),
    /level="asInvoker"\s+uiAccess="false"/,
    'הערך asInvoker חייב להיות נקי, והריפוד בין התכונות'
  );
  // הקלט לא משתנה
  assert.ok(contains(original, 'requireAdministrator'), 'הקלט המקורי לא אמור להשתנות');
});

test('installer-manifest: נכשל בקול כשהמניפסט לא נמצא — שינוי upstream לא יעבור בשקט', () => {
  const already = fakeInstaller('asInvoker');
  assert.throws(() => patchBuffer(already), new RegExp(MANIFEST_FROM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('installer-manifest: נכשל כשהמניפסט מופיע יותר מפעם אחת', () => {
  const twice = Buffer.concat([fakeInstaller('requireAdministrator'), fakeInstaller('requireAdministrator')]);
  assert.throws(() => patchBuffer(twice), /יותר מפעם אחת/);
});

test('installer-manifest: נכשל בקובץ שאינו PE', () => {
  assert.throws(() => patchBuffer(Buffer.from('not-an-exe-at-all', 'utf8')), /PE/);
});

test('installer-manifest: המתקין שנבנה ב-dist אכן מופץ עם asInvoker', () => {
  const pkg = JSON.parse(read('package.json'));
  const file = path.join(ROOT, 'dist', 'Setup.' + pkg.version + '.exe');
  if (!fs.existsSync(file)) return; // אין בנייה מקומית — אין מה לבדוק
  const buf = fs.readFileSync(file);
  assert.ok(!contains(buf, 'requireAdministrator'),
    'המתקין שנבנה עדיין דורש הרשאות מנהל — כנראה נבנה בלי npm run dist (התיקון לא רץ)');
  assert.ok(contains(buf, 'level="asInvoker"'), 'המתקין צריך להיות מופץ עם מניפסט asInvoker');
});

test('installer-manifest: patchFile מתקן קובץ בדיסק ומחזיר דוח', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-manifest-'));
  const file = path.join(dir, 'Setup.test.exe');
  fs.writeFileSync(file, fakeInstaller('requireAdministrator'));
  const res = patchFile(file);
  assert.equal(res.size, fs.statSync(file).size, 'הגודל בדיסק זהה');
  assert.ok(!contains(fs.readFileSync(file), 'requireAdministrator'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installer-manifest: מסיר מטא-דאטה שהתיישן בתיקון (blockmap ו-latest.yml)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-meta-'));
  const file = path.join(dir, 'Setup.test.exe');
  fs.writeFileSync(file, fakeInstaller('requireAdministrator'));
  fs.writeFileSync(file + '.blockmap', 'stale');
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'stale');
  const removed = removeStaleMetadata(file);
  assert.deepEqual(removed.sort(), ['Setup.test.exe.blockmap', 'latest.yml']);
  assert.ok(!fs.existsSync(file + '.blockmap'), 'blockmap שאינו מעודכן חייב להיות מוסר');
  assert.ok(!fs.existsSync(path.join(dir, 'latest.yml')), 'latest.yml שאינו מעודכן חייב להיות מוסר');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ==================== 2) ההרמה העצמית במתקין ==================== */

const installerNsh = read('build/installer.nsh');

test('installer-nsh: המתקין מרים את עצמו כשהתהליך אינו מוגבר', () => {
  assert.ok(installerNsh.includes('${UAC_IsAdmin}'), 'חייבת להיות בדיקת הרשאות');
  assert.ok(installerNsh.includes('ExecShell "runas"'), 'ההרמה חייבת לעבור דרך runas (שמציג את ה-UAC)');
  assert.ok(installerNsh.includes('${GetParameters}'), 'הארגומנטים (למשל /S) חייבים לעבור הלאה');
});

test('installer-nsh: ההרמה רצה לפני כתיבת דגלי העצירה — ביטול UAC לא יסגור את התוכנה', () => {
  const preInit = installerNsh.indexOf('!macro preInit');
  const elevation = installerNsh.indexOf('ExecShell "runas"');
  // כתיבת הדגל בפועל (ולא אזכור בהערות) — בתוך גוף preInit
  const quitFlag = installerNsh.indexOf('"$APPDATA\\BenHazmanim\\quit.flag"', preInit);
  assert.ok(elevation !== -1 && quitFlag !== -1, 'שני החלקים חייבים להתקיים');
  assert.ok(elevation < quitFlag,
    'ההרמה חייבת להיות לפני כתיבת quit.flag: אחרת ביטול ה-UAC סוגר את התוכנה בלי התקנה');
});

test('installer-nsh: ההרמה נמצאת בתוך preInit ומוגנת ב-BUILD_UNINSTALLER', () => {
  const preInit = installerNsh.indexOf('!macro preInit');
  const preInitEnd = installerNsh.indexOf('!macroend', preInit);
  const elevation = installerNsh.indexOf('ExecShell "runas"');
  assert.ok(preInit !== -1 && preInitEnd !== -1, 'גוף preInit חייב להתקיים ולהיסגר');
  assert.ok(preInit < elevation && elevation < preInitEnd, 'ההרמה חייבת להיות בגוף preInit');
  const guard = installerNsh.indexOf('!ifndef BUILD_UNINSTALLER', preInit);
  assert.ok(guard !== -1 && guard < elevation,
    'ההרמה חייבת להיות מוגנת ב-!ifndef BUILD_UNINSTALLER (בניית המסיר רצה בלי הרשאות)');
});

/* ==================== 3) הבנייה מריצה את התיקון ==================== */

test('installer-build: npm run dist מריץ את תיקון המניפסט (ולא בונה מתקין בלי התיקון)', () => {
  const pkg = JSON.parse(read('package.json'));
  const dist = (pkg.scripts && pkg.scripts.dist) || '';
  assert.ok(dist.includes('electron-builder'), 'dist חייב לבנות עם electron-builder');
  assert.ok(dist.includes('patch-installer-manifest.js'),
    'dist חייב להריץ את scripts/patch-installer-manifest.js — אחרת המתקין ייצא עם requireAdministrator');
});
