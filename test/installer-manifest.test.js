// בדיקות לחיזוק נתיב ההתקנה/העדכון:
//   1) אימות מניפסט ההרשאה של קובץ ההתקנה — **ללא נגיעה בקובץ**
//   2) שהמניפסט נקבע בזמן הקומפילציה (החלה של קובץ המקור של תבנית
//      electron-builder), ולא בתיקון בדיעבד של ה-EXE — ושה"תיקון" הזה מזוהה
//      ונחסם
//   3) ההרמה העצמית של המתקין ב-preInit, בסדר הנכון (לפני דגלי העצירה)
//   4) שהבנייה (npm run dist) אכן מריצה את האימות — לפני ואחרי — כדי שלא
//      ישוחרר מתקין פגום בשקט.
//
// הסיבה לקיומה: שלושה כשלים שקטים כבר קרו כאן בפועל ולא הפילו שום בדיקה —
//   (א) עדכון שהצהיר "מתקין", סגר את התוכנה ולא התקין כלום (עד 1.7.1);
//   (ב) מתקין 1.7.2 שתוקן **אחרי** הבנייה, ועקב כך יצא מיד עם קוד 2 לפני
//       שרץ ולו שורת סקריפט אחת — בלי חלון UAC, בלי שגיאה ובלי התקנה,
//       בכל מחשב וגם בהתקנה ידנית;
//   (ג) ניסיון לתקן את המניפסט בעותק של תבנית electron-builder (nsis.script),
//       שמבטל את בניית המסיר והפיל את הבנייה עצמה.
// הבדיקות כאן נופלות מיד אם ההגנות האלה מוסרות או מפסיקות להתאים למציאות.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  verifyBuffer, verifyFile, removeUnusedMetadata, isPeFile,
  sha512Base64, checkInclude, checkBuildConfig, checkTemplate, preflight,
  MANIFEST_AS_INVOKER, NSIS_INCLUDE, TEMPLATE_DIR
} = require('../scripts/verify-installer-manifest.js');

const {
  patchTemplateText, findOtherAdminLevels, PATCH_MARK, PATCHED_RE, PATCHED_LINE,
  ADMIN_LINE, INSTALLER_TEMPLATE
} = require('../scripts/patch-nsis-template.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ==================== 1) לוגיקת האימות ==================== */

// קובץ PE מדומה עם מניפסט בדיוק כמו זה ש-NSIS מנפיק
function fakeInstaller(level) {
  const manifest =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">' +
    '<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges>' +
    '<requestedExecutionLevel level="' + level + '" uiAccess="false"/>' +
    '</requestedPrivileges></security></trustInfo></assembly>';
  const buf = Buffer.alloc(0x100 + Buffer.byteLength(manifest, 'latin1') + 64, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew
  buf.writeUInt32LE(0x00004550, 0x80); // "PE\0\0"
  buf.write(manifest, 0x100, 'latin1');
  return buf;
}

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('installer-manifest: מתקין עם asInvoker עובר אימות', () => {
  const res = verifyBuffer(fakeInstaller('asInvoker'));
  assert.ok(res.size > 0, 'האימות צריך להחזיר את גודל הקובץ');
});

test('installer-manifest: מתקין עם requireAdministrator נדחה בקול', () => {
  assert.throws(() => verifyBuffer(fakeInstaller('requireAdministrator')), /requireAdministrator/);
});

test('installer-manifest: קובץ שאינו PE נדחה', () => {
  assert.throws(() => verifyBuffer(Buffer.from('not-an-exe-at-all', 'utf8')), /PE/);
  assert.equal(isPeFile(Buffer.from('nope', 'utf8')), false);
});

test('installer-manifest: האימות אינו כותב לקובץ (בתים ו-mtime ללא שינוי)', () => {
  withTempDir('bh-verify-', (dir) => {
    const file = path.join(dir, 'Setup.test.exe');
    const original = fakeInstaller('asInvoker');
    fs.writeFileSync(file, original);
    const before = fs.statSync(file);

    const res = verifyFile(file);

    const after = fs.readFileSync(file);
    const statAfter = fs.statSync(file);
    assert.ok(after.equals(original), 'תוכן הקובץ חייב להישאר זהה לחלוטין');
    assert.equal(statAfter.mtimeMs, before.mtimeMs, 'זמן השינוי לא אמור להשתנות');
    assert.equal(res.size, original.length);
    assert.equal(res.integrity, 'not-checked', 'בלי latest.yml אין מה להשוות');
  });
});

test('installer-manifest: קובץ שנערך אחרי הבנייה מזוהה לפי latest.yml', () => {
  withTempDir('bh-verify-int-', (dir) => {
    const file = path.join(dir, 'Setup.test.exe');
    const original = fakeInstaller('asInvoker');
    fs.writeFileSync(file, original);
    fs.writeFileSync(path.join(dir, 'latest.yml'),
      'version: 1.2.3\nfiles:\n  - url: Setup.test.exe\n    sha512: ' + sha512Base64(original) +
      '\n    size: ' + original.length + '\n');

    const res = verifyFile(file);
    assert.equal(res.integrity, 'ok', 'קובץ שהוא בדיוק פלט הבנייה מאושר');

    // עכשיו "נתקן" את הקובץ בדיעבד — כמו התקלה של 1.7.2
    const tampered = Buffer.from(original);
    const at = tampered.indexOf(Buffer.from('level="asInvoker"', 'utf8'));
    tampered.write('level="asInvoker"  ', at, 'utf8');
    fs.writeFileSync(file, tampered);
    assert.throws(() => verifyFile(file), /שונה אחרי הבנייה/);
  });
});

test('installer-manifest: מסיר מטא-דאטה שאינו נפרס (blockmap ו-latest.yml)', () => {
  withTempDir('bh-meta-', (dir) => {
    const file = path.join(dir, 'Setup.test.exe');
    fs.writeFileSync(file, fakeInstaller('asInvoker'));
    fs.writeFileSync(file + '.blockmap', 'unused');
    fs.writeFileSync(path.join(dir, 'latest.yml'), 'unused');
    const removed = removeUnusedMetadata(file);
    assert.deepEqual(removed.sort(), ['Setup.test.exe.blockmap', 'latest.yml']);
    assert.ok(!fs.existsSync(file + '.blockmap'));
    assert.ok(!fs.existsSync(path.join(dir, 'latest.yml')));
    assert.ok(fs.existsSync(file), 'קובץ ההתקנה עצמו לא נגע');
  });
});

/* ==================== 2) המניפסט נקבע בזמן הקומפילציה ==================== */

const installerNsh = read('build/installer.nsh');
const TEMPLATE_HEADER = [
  '!ifdef INSTALL_MODE_PER_ALL_USERS',
  '  !ifdef BUILD_UNINSTALLER',
  '    RequestExecutionLevel user',
  '  !else',
  '    RequestExecutionLevel admin',
  '  !endif',
  '!else',
  '  RequestExecutionLevel user',
  '!endif',
  ''
].join('\n');

test('installer-nsh: ההחלה הופכת admin ל-user (asInvoker) ומסמנת את השורה', () => {
  const { text, state } = patchTemplateText(TEMPLATE_HEADER);
  assert.equal(state, 'patched-now');
  assert.ok(text.includes('RequestExecutionLevel user ; ' + PATCH_MARK),
    'השורה שהופכת את המניפסט ל-asInvoker חייבת להיות מסומנת');
  assert.equal(/RequestExecutionLevel[ \t]+admin/m.test(text), false,
    'לא נשאר אף RequestExecutionLevel admin בתבנית');
  // שאר התבנית לא זזה
  assert.equal(text.replace(/^[ \t]*RequestExecutionLevel.*$/gm, ''),
    TEMPLATE_HEADER.replace(/^[ \t]*RequestExecutionLevel.*$/gm, ''));
});

test('installer-nsh: ההחלה אידמפוטנטית — הרצה חוזרת לא מזיקה ולא מוסיפה שורות', () => {
  const once = patchTemplateText(TEMPLATE_HEADER).text;
  // זיהוי ההחלה חייב לעבוד: אחרת הרצה חוזרת הייתה נכשלת (או מכפילה את השורה)
  assert.ok(PATCHED_RE.test(once), 'סימן ההחלה חייב להיות מזוהה');
  const twice = patchTemplateText(once);
  assert.equal(twice.state, 'patched');
  assert.equal(twice.text, once, 'ההחלה החוזרת מחזירה את אותו קובץ בדיוק');
});

test('installer-nsh: השורה המוחלפת והסימן תואמים זה לזה', () => {
  // בדיקת "הלוך-חזור": השורה שההחלה כותבת חייבת להיות מזוהה ע"י הביטוי
  // שמזהה החלה — אחרת ההחלה אינה אידמפוטנטית והיא נכשלת בהרצה שנייה
  const line = PATCHED_LINE.replace('$1', '    ');
  assert.ok(PATCHED_RE.test(line), 'הסימן ' + PATCH_MARK + ' חייב להיות מזוהה בשורה שהוכתבה');
  assert.equal(ADMIN_LINE.test(line), false, 'השורה המוחלפת אינה מכילה יותר admin');
});

test('installer-nsh: ההחלה נכשלת בקול אם השורה אינה בתבנית', () => {
  assert.throws(() => patchTemplateText('Name "x"\nRequestExecutionLevel user\n'), /RequestExecutionLevel admin/);
});

test('installer-nsh: קובץ ההרחבה אינו מנסה לקבוע מניפסט בעצמו', () => {
  assert.doesNotThrow(() => checkInclude(installerNsh));
  assert.throws(() => checkInclude('RequestExecutionLevel user\n'), /RequestExecutionLevel/);
  // !define admin — נבדק ולא עובד (המעבד המקדים של NSIS מחליף סמל רק בראש שורה)
  assert.throws(() => checkInclude('!define admin user\n'), /!define admin/);
  assert.ok(read('package.json').includes('"perMachine": true'), 'ההתקנה נשארת perMachine');
  assert.equal(read('package.json').includes('"script"'), false,
    'אסור nsis.script: נתיב זה מבטל את בניית המסיר של electron-builder וההתקנה נכשלת');
});

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

test('installer-nsh: התבנית שבחבילה מוחלת (ושום מקום אחר לא דורש הרשאות)', () => {
  const template = checkTemplate();
  if (!template.checked) return; // node_modules חסר (למשל CI בלי התקנה)
  assert.equal(template.checked, true);
  assert.equal(template.file.replace(/\\/g, '/'), 'node_modules/app-builder-lib/templates/nsis/installer.nsi');
  assert.deepEqual(findOtherAdminLevels(TEMPLATE_DIR, INSTALLER_TEMPLATE), [],
    'אסור שיהיה RequestExecutionLevel admin במקום נוסף בתבניות');
});

test('installer-nsh: אימות הבנייה נופל אם חוזר nsis.script', () => {
  const cfg = JSON.parse(read('package.json'));
  assert.doesNotThrow(() => checkBuildConfig());
  assert.equal(!!cfg.build.nsis.script, false);
  assert.equal(cfg.build.nsis.include, 'build/installer.nsh');
  assert.ok(String(cfg.scripts.postinstall).includes('patch-nsis-template.js'),
    'postinstall חייב להחיל את התבנית — אחרת npm ci מחזיר מניפסט requireAdministrator');
});

test('installer-nsh: בדיקת הקדם (preflight) עוברת במצב הנוכחי של הפרויקט', () => {
  const res = preflight();
  assert.equal(res.include, NSIS_INCLUDE);
  if (fs.existsSync(TEMPLATE_DIR)) assert.equal(res.template.checked, true);
});

/* ========== 2ב) עצירת התוכנה, אימות ההתקנה ותיקון (התקלה של 23/9/2026) ==========
   השתלשלות הכשל שדווח: "מוריד את הגרסה וסוגר את התוכנה אבל לא מתקין".
   1) במחשב שבו מאגר WBEM פגום נכשלים `tasklist` ו-`Get-CimInstance` ("Invalid
      class") בשקט — ואז המתקין *לא רואה* את התוכנה שרצה;
   2) התוכנה (או השומר שלה, או המשתמש שלחץ על הסמל) עולה מחדש בזמן ההעתקה;
   3) קובץ הרצה פתוח ו-asar ממופה אינם ניתנים להחלפה, ולכן electron-builder
      עובר למסלול שמתעלם משגיאות — התקנה חלקית שקטה, קוד 0, המצהירה הצלחה.
   ההגנות שנבדקות כאן הן מה שמונע כל אחד מהשלבים האלה. */

const macroBody = (name) => {
  const at = installerNsh.indexOf('!macro ' + name);
  assert.ok(at !== -1, 'המאקרו ' + name + ' חייב להתקיים');
  return installerNsh.slice(at, installerNsh.indexOf('!macroend', at));
};

const functionBody = (name) => {
  const at = installerNsh.indexOf('Function ' + name);
  assert.ok(at !== -1, 'הפונקציה ' + name + ' חייבת להתקיים');
  return installerNsh.slice(at, installerNsh.indexOf('FunctionEnd', at));
};

test('installer-nsh: עצירת התוכנה אינה תלויה ב-WMI/tasklist', () => {
  // העצירה היא Function (נקראת משני מקומות במקטע ההתקנה)
  assert.ok(macroBody('BENHAZ_STOP_APP').includes('Call BENHAZ_StopApp'),
    'המאקרו חייב לקרוא לפונקציית העצירה');
  // העצירה עצמה יושבת במאקרו BENHAZ_STOPAPP_BODY, שמוטמע בשני עותקים —
  // installer (BENHAZ_StopApp) ו-un (un.BENHAZ_StopApp); רק אחד נבנה בכל מעבר.
  const installerCopy = functionBody('BENHAZ_StopApp');
  assert.ok(installerCopy.includes('BENHAZ_STOPAPP_BODY'), 'הפונקציה חייבת להטמיע את מאקרו העצירה');
  const unCopy = installerNsh.slice(installerNsh.indexOf('Function un.BENHAZ_StopApp'));
  assert.ok(unCopy.slice(0, 200).includes('BENHAZ_STOPAPP_BODY'),
    'גם המסיר צריך עותק (מאקרו עם תויות היה מתנגש בשתי ההזמנות)');
  const stop = macroBody('BENHAZ_STOPAPP_BODY');
  assert.ok(stop.includes('Get-Process'), 'העצירה חייבת להשתמש ב-Get-Process (אינו תלוי WMI)');
  assert.equal(/tasklist|Get-CimInstance/.test(stop), false, 'אסור להסתמך על tasklist/CIM — הם נכשלים בשקט');
  assert.ok(stop.includes('$INSTDIR\\*'), 'חייבים לחסל תהליכים מתיקיית ההתקנה');
  assert.ok(stop.includes('BenHazmanim\\app\\*'), 'וגם את העותק המוגן (השומר המערכתי)');
  assert.ok(stop.includes('BenhazStopLoop') && stop.includes('Stop-Process -Force'),
    'חייבת לולאת חיסול: שומר-השער מקפיץ את התוכנה חזרה תוך שניות');
});

test('installer-nsh: בדיקת "התוכנה רצה" של electron-builder מוחלפת', () => {
  const body = macroBody('customCheckAppRunning');
  assert.ok(body.includes('BENHAZ_QUIT_FLAGS'), 'העקיפה חייבת קודם כל לכתוב את דגלי העצירה (התוכנה יוצאת לבד)');
  assert.ok(body.includes('BENHAZ_STOP_APP'), 'ואחר כך לחסל את מי שלא יצא');
});

test('installer-nsh: ההתקנה נאמתת ומתוקנת — ואסור "להצליח" עם קבצים נעולים', () => {
  const install = macroBody('customInstall');
  assert.ok(install.includes('BENHAZ_VERIFY_INSTALL'), 'customInstall חייב לאמת את ההתקנה לפני ההפעלה מחדש');
  const verify = macroBody('BENHAZ_VERIFY_INSTALL');
  assert.ok(verify.includes('$PLUGINSDIR\\7z-out'),
    'זיהוי העתקה חלקית: electron-builder מוחק את 7z-out רק במסלול שמתעלם משגיאות');
  assert.ok(verify.includes('app-*.7z'), 'התיקון מחלץ מחדש את החבילה שנארזה במתקין עצמו');
  assert.ok(verify.includes('FileSeek'), 'אימות לפי גודל app.asar שהותקן מול זה שבחבילה');
  assert.ok(verify.includes('BENHAZ_WRITE_RESULT'), 'נכתב דוח תוצאה שהתוכנה מדווחת ממנו');
  assert.ok(macroBody('BENHAZ_WRITE_RESULT').includes('update-result.json'), 'הדוח נכתב לנתיב שהתוכנה קוראת');
  assert.ok(verify.includes('BENHAZ_WRITE_RESULT false'), 'כשל מדווח כדוח כשל (ok:false)');
  assert.ok(verify.includes('MessageBox'), 'כשל חייב להיות גלוי למשתמש');
  const msgLine = verify.split(/\r?\n/).find((l) => l.trim().startsWith('MessageBox'));
  assert.ok(msgLine && !msgLine.includes('/SD'),
    'אסור /SD על הודעת הכשל: הוא משתיק אותה בהתקנה שקטה — וזה בדיוק הכשל השקט שאסור לחזור עליו');
});

test('installer-nsh: "התקנה בעיצומה" נכתב לפני ההעתקה ונמחק בסיומה', () => {
  const preInit = installerNsh.indexOf('!macro preInit');
  const mark = installerNsh.indexOf('BENHAZ_WRITE_PROGRESS', preInit);
  const wait = installerNsh.indexOf('Sleep 4000', preInit);
  assert.ok(mark !== -1 && wait !== -1 && mark < wait,
    'הסימון נכתב לפני ההמתנה לסגירת התוכנה — אחרת חלון ההתקנה נשאר פתוח לעלייה מחדש');
  assert.ok(installerNsh.includes('Delete "$R2\\BenHazmanim\\update-in-progress.json"'),
    'הסימון מוסר בסוף ההתקנה, אחרת התוכנה לא תעלה מחדש');
});

test('main: התוכנה לא עולה בזמן התקנה, ומדווחת אם ההתקנה נכשלה', () => {
  const main = read('main.js');
  assert.ok(main.includes('const updateProgressFile'), 'חייב קובץ תיאום "התקנה בעיצומה"');
  const guard = main.indexOf('if (updateInProgress()) {');
  assert.ok(guard !== -1, 'באתחול חייבת להיות בדיקת "התקנה בעיצומה"');
  assert.ok(main.slice(guard, guard + 260).includes('app.exit(0)'),
    'התוכנה יוצאת מיד בזמן התקנה — אחרת היא נועלת את הקבצים שהמתקין מחליף');
  assert.ok(main.includes("logEvent('update-failed'"), 'כשל התקנה נרשם ביומן הפעילות');
  assert.ok(main.includes('reportUpdateResult'), 'והמשתמש מקבל הודעה — ולא נשאר על גרסה ישנה בשקט');
});

test('installer-nsh: כל שלב נרשם ליומן, וה-pid נכתב לרגיסטר הנכון', () => {
  const log = macroBody('BENHAZ_LOG');
  assert.ok(log.includes('BenHazmanim-Update.log'),
    'כל שלב נרשם לקובץ שהמשתמש יכול לשלוח — כשל שקט חייב להשאיר עקבה');
  for (const stage of ['preinit-start', 'preinit-elevate-dispatched', 'preinit-inner-no-admin',
    'preinit-elevate-failed', 'preinit-proceed-elevated', 'app-check-running',
    'install-section', 'verify-atomic-ok', 'verify-needs-repair', 'verify-repaired-ok', 'verify-FAIL']) {
    assert.ok(installerNsh.includes('"' + stage + '"'), 'חסר שלב ביומן ההתקנה: ' + stage);
  }
  // System::Call: r7 (אות קטנה) = $7, ולא $R7. עם אות קטנה ה-pid נכתב ריק,
  // update-in-progress.json יצא כ-{"pid":} — JSON פגום שהתוכנה מפרשת כ"אין
  // התקנה בעיצומה", עולה בזמן ההעתקה ונועלת את הקבצים. זה נמדד בפועל.
  assert.equal(/\.r\d'/.test(installerNsh), false,
    'System::Call עם אות קטנה כותב ל-$7 ולא ל-$R7 — ה-pid/המונה יוצאים ריקים');
  assert.ok(/GetCurrentProcessId\(\) i \.R7'/.test(installerNsh), 'ה-pid של המתקין חייב להיות נרשם');
  assert.ok(installerNsh.includes('{"pid":$R7,"version":"${VERSION}"}'),
    'update-in-progress.json חייב pid אמיתי — אחרת ה-JSON פגום וההגנה מושבתת');
});

test('main: עדכון שלא רץ בכלל מדווח למשתמש (סימן "עדכון ממתין")', () => {
  const main = read('main.js');
  assert.ok(main.includes('update-pending.json'), 'חייב סימן עדכון ממתין שנשאר על הדיסק');
  const launch = main.indexOf("logEvent('update-launch'");
  const mark = main.indexOf('markUpdatePending(version)');
  assert.ok(launch !== -1 && mark > launch,
    'הסימן נכתב רק אחרי שהמתקין אומת רץ — כישלון הרמה אינו "עדכון שלא הותקן"');
  const quit = main.indexOf('writeQuitFlag()', mark);
  assert.ok(quit !== -1 && mark < quit, 'הסימן נכתב לפני סגירת התוכנה — אחרת לא נכתב כלל');
  assert.ok(main.includes("notifyUpdateFailed(wanted, 'no-install')"),
    'אם נחזור לאותה גרסה — המשתמש מקבל התראה ולא נשאר בשקט');
  assert.ok(main.includes("logEvent('update-installed'"), 'עדכון שהצליח נרשם ביומן');
});

/* ==================== 3) הבנייה מאמתת את המתקין ==================== */

test('installer-build: npm run dist מחיל, מאמת לפני ואחרי, ואין תיקון בדיעבד של ה-EXE', () => {
  const pkg = JSON.parse(read('package.json'));
  const dist = (pkg.scripts && pkg.scripts.dist) || '';
  const parts = dist.split('&&').map((s) => s.trim());
  assert.ok(dist.includes('electron-builder'), 'dist חייב לבנות עם electron-builder');
  assert.ok(dist.indexOf('patch-nsis-template.js') < dist.indexOf('electron-builder'),
    'ההחלה חייבת לרוץ לפני הבנייה (וגם ב-postinstall, למקרה שמבנים ידנית)');
  const buildAt = parts.findIndex((s) => s.includes('electron-builder'));
  const verifyAt = parts.map((s, i) => (s.includes('verify-installer-manifest.js') ? i : -1)).filter((i) => i >= 0);
  assert.ok(buildAt > 0 && verifyAt.includes(buildAt + 1),
    'dist חייב להריץ את scripts/verify-installer-manifest.js גם לפני הבנייה וגם אחריה — ' +
    'אחרת מתקין פגום עלול להישתחרר בשקט');
  assert.ok(verifyAt.some((i) => i < buildAt), 'אימות ההקדם (--pre) חייב לרוץ לפני הבנייה');
  assert.ok(dist.includes('--pre'), 'אימות ההקדם מסומן ב---pre');
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'patch-installer-manifest.js')), false,
    'אסור שיהיה סקריפט שמתקן את ה-EXE אחרי הבנייה: כל שינוי בתים במתקין מפיל אותו ' +
    '(NSIS בודק את שלמות המתקין, והמתקין יוצא בקוד 2 לפני שרץ — זו התקלה של 1.7.2)');
});

test('installer-build: המתקין שנבנה ב-dist מופץ עם asInvoker (בלי requireAdministrator)', () => {
  const pkg = JSON.parse(read('package.json'));
  const file = path.join(ROOT, 'dist', 'Setup.' + pkg.version + '.exe');
  if (!fs.existsSync(file)) return; // אין בנייה מקומית — אין מה לבדוק
  const buf = fs.readFileSync(file);
  const text = buf.toString('latin1');
  assert.ok(!text.includes('requireAdministrator'),
    'המתקין שנבנה עדיין דורש הרשאות מנהל — כנראה נבנה בלי npm run dist');
  assert.ok(text.includes(MANIFEST_AS_INVOKER), 'המתקין צריך להיות מופץ עם מניפסט asInvoker');
});
