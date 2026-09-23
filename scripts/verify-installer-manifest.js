/**
 * אימות מניפסט ההרשאה של המתקין — לפני הבנייה ואחריה.
 *
 * למה זה נדרש
 * -----------
 * התוכנה מפעילה את מתקין העדכון בעצמה. גרסאות ותיקות (כמו 1.6.5, שעדיין
 * מותקנת אצל חלק מהמשתמשים) עושות זאת ב-spawn רגיל — כלומר CreateProcess,
 * שאינו מרים הרשאות: הפעלה של קובץ עם מניפסט `requireAdministrator` נכשלת מיד
 * (ERROR_ELEVATION_REQUIRED / 740), בלי חלון UAC ובלי חלון שגיאה. זו התקלה
 * שבגללה "עדכן" סגר את התוכנה ולא התקין דבר.
 *
 * לכן המתקין מופץ עם מניפסט `asInvoker` והוא מרים את עצמו ב-preInit
 * (build/installer.nsh) — הנתיב היחיד שמציג את חלון ה-UAC.
 *
 * **ומה שאסור בתכלית האיסור:** לתקן את המניפסט *אחרי* הבנייה, בנגיעה בבתים של
 * ה-EXE. זה מה שנעשה ב-1.7.2 (scripts/patch-installer-manifest.js) — והמתקין
 * ששוחרר לא עבד בכלל: הוא יצא מיד עם קוד 2, בלי חלון, בלי שגיאה ובלי התקנה,
 * בכל מחשב וגם בהתקנה ידנית. הסיבה: NSIS בודק את שלמות המתקין שלו בזמן ההרצה,
 * וכל שינוי בית בודד (בכל מקום בקובץ) מפיל אותו.
 * אומת במבחן מבוקר (23/9/2026) על מתקין נסיוני: שינוי בית בודד ב-stub, במניפסט,
 * באמצע הקובץ ובסופו — כולם הסתיימו בקוד יציאה 2, ובהרצה רגילה (בלי /S) בלי
 * שום חלון; הקובץ המקורי הסתיים ב-0.
 *
 * לכן המניפסט נקבע **בזמן הקומפילציה**: scripts/patch-nsis-template.js משנה את
 * קובץ המקור של התבנית של electron-builder (השורה `RequestExecutionLevel admin`
 * הופכת ל-`user`) — וזו פעולה בטוחה, כי היא נוגעת בקלט הבנייה ולא בקובץ שנבנה.
 *
 * הסקריפט הזה אינו כותב דבר בעצמו: הוא מאמת לפני הבנייה שהמנגנון תקף (התבנית
 * הוחלה, אין nsis.script, אין סקריפט שמתקן EXE), ואחריה שהמתקין שנבנה הוא באמת
 * asInvoker ושהוא לא נערך אחרי שהבנייה הסתיימה.
 *
 * שימוש:
 *   node scripts/verify-installer-manifest.js --pre      # לפני הבנייה
 *   node scripts/verify-installer-manifest.js [file.exe] # אחרי הבנייה
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const { patchTemplateText, findOtherAdminLevels, TEMPLATE_DIR, INSTALLER_TEMPLATE, PATCHED_RE } =
  require('./patch-nsis-template.js');

const ROOT = path.join(__dirname, '..');
const NSIS_INCLUDE = path.join(ROOT, 'build', 'installer.nsh');
const PATCH_SCRIPT = path.join(ROOT, 'scripts', 'patch-installer-manifest.js');
const TEMPLATE_PATCHER = 'patch-nsis-template.js';

const MANIFEST_AS_INVOKER = 'level="asInvoker"';
const FORBIDDEN_LEVEL = 'requireAdministrator';

/* ==================== כלים ==================== */

// האם זהו קובץ PE תקין? (MZ בכותרת + חתימת PE) — בדיקת שפיות
function isPeFile(buf) {
  if (buf.length < 0x40) return false;
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return false; // "MZ"
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff <= 0 || peOff + 4 > buf.length) return false;
  return buf.readUInt32LE(peOff) === 0x00004550; // "PE\0\0"
}

// מאמת את תוכן הקובץ בזיכרון. לא נוגע בקובץ עצמו.
function verifyBuffer(input) {
  if (!isPeFile(input)) {
    throw new Error('verify-installer-manifest: הקובץ אינו קובץ PE תקין (MZ/PE) — לא ממשיכים');
  }
  const text = input.toString('latin1');
  if (text.includes(FORBIDDEN_LEVEL)) {
    throw new Error(
      'verify-installer-manifest: המתקין שנבנה דורש הרשאות מנהל ' +
      '(requestedExecutionLevel="requireAdministrator").\n' +
      '  המשמעות: הפעלה שלו מתהליך רגיל נכשלת מיד (שגיאה 740), בלי חלון UAC — ' +
      'וזה בדיוק מה שמשאיר עדכון מתוך התוכנה בלי התקנה.\n' +
      '  כנראה התבנית של electron-builder לא הוחלה (scripts/patch-nsis-template.js) — ' +
      'ראו גם build/installer.nsh.\n' +
      '  אין לתקן את ה-EXE בדיעבד: כל שינוי בתים בו מפיל את המתקין לגמרי ' +
      '(זה מה שקרה למתקין של 1.7.2).'
    );
  }
  if (!text.includes(MANIFEST_AS_INVOKER)) {
    throw new Error(
      'verify-installer-manifest: לא נמצא מניפסט asInvoker בקובץ.\n' +
      '  ייתכן ש-electron-builder שינה את מבנה המניפסט — יש לבדוק את ' +
      'scripts/patch-nsis-template.js ואת build/installer.nsh, ולא לשחרר גרסה בלי אימות.'
    );
  }
  return { size: input.length };
}

// האם הקובץ זהה לזה ש-electron-builder דיווח עליו? (מונע "תיקון" שקט בדיעבד)
function expectedSha512FromLatestYml(dir) {
  try {
    const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
    const m = yml.match(/sha512:\s*(\S+)/);
    if (!m) return null;
    // electron-builder כותב base64; המשווים באותו ייצוג
    return m[1].replace(/^['"]|['"]$/g, '');
  } catch {
    return null;
  }
}

function sha512Base64(buf) {
  return crypto.createHash('sha512').update(buf).digest('base64');
}

/* ==================== אימות לפני הבנייה ==================== */

// קובץ ההרחבה שלנו אינו קובע את המניפסט (הוא נכלל לפני התבנית, ולכן שורה
// משלו שם חסרת תוקף), וגם לא מנסה להגדיר סמל בשם admin — נבדק ולא עובד:
// מעבד המקדים של NSIS מחליף סמל רק בראש שורה, לא כארגומנט של פקודה.
function checkInclude(text) {
  if (/^[ \t]*RequestExecutionLevel/m.test(text)) {
    throw new Error(
      'verify-installer-manifest: אין לקבוע RequestExecutionLevel ב-build/installer.nsh.\n' +
      '  הקובץ נכלל *לפני* התבנית של electron-builder, ולכן שורה משלו שם חסרת תוקף ' +
      '(השורה האחרונה בסקריפט היא הקובעת). את המניפסט קובעת ההחלה ' +
      'ב-scripts/patch-nsis-template.js.'
    );
  }
  if (/^[ \t]*!define[ \t]+admin[ \t]/m.test(text)) {
    throw new Error(
      'verify-installer-manifest: אין להגדיר "!define admin" ב-build/installer.nsh.\n' +
      '  נבדק ואינו עובד: מעבד המקדים של NSIS מחליף סמל שהוגדר ב-!define רק בראש ' +
      'שורה (הגדרת פקודה), ולא כארגומנט של RequestExecutionLevel — והמניפסט נשאר ' +
      'requireAdministrator בשקט.'
    );
  }
}

// אימות שהבנייה עצמה מוגדרת נכון: התבנית מוחלת לפני הבנייה (אוטומטית
// ב-postinstall), בלי nsis.script (שמבטל את בניית המסיר), כשההתקנה נשארת
// perMachine ובלי שום סקריפט שתיקן את ה-EXE בדיעבד.
function checkBuildConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const nsis = cfg.build.nsis;
  const scripts = cfg.scripts || {};
  if (nsis.script) {
    throw new Error(
      'verify-installer-manifest: build.nsis.script מוגדר (' + nsis.script + ').\n' +
      '  הנתיב הזה *מבטל* את בניית המסיר של electron-builder (הוא מחזיר מיד לפני ' +
      'שהמסיר נבנה), וההתקנה נכשלת עם שגיאה על ${UNINSTALLER_OUT_FILE} ריק.\n' +
      '  את מניפסט ההרשאה קובעים בהחלה שב-scripts/patch-nsis-template.js.'
    );
  }
  if (nsis.include !== 'build/installer.nsh') {
    throw new Error(
      'verify-installer-manifest: build.nsis.include חייב להיות build/installer.nsh ' +
      '(הוא זה שמרים את המתקין ב-preInit ומטפל בדגלי העצירה).'
    );
  }
  if (nsis.perMachine !== true) {
    throw new Error(
      'verify-installer-manifest: build.nsis.perMachine חייב להישאר true — ' +
      'ההתקנה היא ברמת המחשב (Program Files, משימות מערכת, שומר-השער).'
    );
  }
  if (!String(scripts.postinstall || '').includes(TEMPLATE_PATCHER)) {
    throw new Error(
      'verify-installer-manifest: postinstall חייב להריץ את scripts/' + TEMPLATE_PATCHER + '.\n' +
      '  בלעדיו התבנית של electron-builder חוזרת למצב requireAdministrator אחרי כל ' +
      'התקנה מחדש של החבילות (npm ci / npm install).'
    );
  }
  if (fs.existsSync(PATCH_SCRIPT)) {
    throw new Error(
      'verify-installer-manifest: קיים scripts/patch-installer-manifest.js.\n' +
      '  אסור שיהיה סקריפט שנגע ב-EXE אחרי הבנייה: כל שינוי בתים במתקין מפיל ' +
      'אותו לגמרי (NSIS בודק שלמות), והמתקין יוצא בקוד 2 לפני שרץ — זו התקלה של 1.7.2.'
    );
  }
}

// אימות התבנית שבחבילה: ההחלה חייבת להיות מיושמת (ו-idempotentית), ואסור
// שיהיה RequestExecutionLevel admin במקום נוסף כלשהו בתבניות — אחרת הוא
// יופיע גם בקובץ שנבנה. patchTemplateText זורק בקול אם השורה נעלמה מהתבנית.
function checkTemplate() {
  if (!fs.existsSync(TEMPLATE_DIR)) {
    return { checked: false, reason: 'electron-builder אינו מותקן (node_modules חסר)' };
  }
  const text = fs.readFileSync(INSTALLER_TEMPLATE, 'utf8');
  const { state } = patchTemplateText(text);
  if (state !== 'patched') {
    throw new Error(
      'verify-installer-manifest: התבנית של electron-builder טרם הוחלה.\n' +
      '  הריצו "npm run dist" (שמחיל לפני הבנייה) או "npm install" (postinstall), ' +
      'או ישירות: node scripts/' + TEMPLATE_PATCHER
    );
  }
  const other = findOtherAdminLevels(TEMPLATE_DIR, INSTALLER_TEMPLATE);
  if (other.length) {
    throw new Error(
      'verify-installer-manifest: נמצא RequestExecutionLevel admin גם ב-' + other.join(', ') + '.\n' +
      '  ההחלה חייבת לכסות כל מקום כזה, אחרת המתקין ייצא עם מניפסט של הרשאות מנהל.'
    );
  }
  const m = text.match(PATCHED_RE);
  const line = text.slice(0, m.index).split(/\r?\n/).length;
  return { checked: true, file: path.relative(ROOT, INSTALLER_TEMPLATE), line };
}

function preflight() {
  checkInclude(fs.readFileSync(NSIS_INCLUDE, 'utf8'));
  checkBuildConfig();
  const template = checkTemplate();
  return { include: NSIS_INCLUDE, template };
}

/* ==================== אימות אחרי הבנייה ==================== */

function verifyFile(filePath) {
  const before = fs.readFileSync(filePath);
  const statBefore = fs.statSync(filePath);

  const res = verifyBuffer(before);

  // ודאות שלא שינינו את הקובץ בעצמנו: אימות הוא פעולה קריאה בלבד
  const after = fs.readFileSync(filePath);
  if (!before.equals(after)) {
    throw new Error('verify-installer-manifest: הקובץ השתנה בזמן האימות — אסור שסקריפט האימות יכתוב');
  }

  // ואם electron-builder השאיר מטא-דאטה — שהקובץ זהה למה שהוא דיווח (כלומר
  // שהקובץ הוא פלט הבנייה עצמו, ולא עותק שנערך אחריה).
  const dir = path.dirname(filePath);
  const expected = expectedSha512FromLatestYml(dir);
  let integrity = 'not-checked';
  if (expected) {
    if (sha512Base64(before) !== expected) {
      throw new Error(
        'verify-installer-manifest: הקובץ שונה אחרי הבנייה!\n' +
        '  ה-sha512 שלו אינו תואם לזה ש-electron-builder רשם ב-latest.yml.\n' +
        '  זו בדיוק התקלה של 1.7.2: כל שינוי בתים במתקין (למשל תיקון מניפסט ' +
        'בדיעבד) מפיל אותו — המתקין יוצא בקוד 2 לפני שרץ, בלי חלון ובלי התקנה.'
      );
    }
    integrity = 'ok';
  }

  return { file: filePath, size: res.size, mtime: statBefore.mtimeMs, integrity };
}

// קובצי המטא-דאטה של electron-builder אינם בשימוש אצלנו (העדכון מבוסס
// version.json ונכס המהדורה בגיטהאב, ומופץ רק ה-EXE). הם נשארים לתיעוד מעט
// ואז מתיישנים מול הקובץ — לכן מוסרים בתום הבנייה, כדי שלא יישאר ב-dist
// תיעוד מטעה של קובץ שאינו זה שמופץ.
function removeUnusedMetadata(filePath) {
  const removed = [];
  for (const c of [filePath + '.blockmap', path.join(path.dirname(filePath), 'latest.yml')]) {
    if (fs.existsSync(c)) {
      fs.unlinkSync(c);
      removed.push(path.basename(c));
    }
  }
  return removed;
}

function resolveDefaultInstallerPath() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return path.join(ROOT, 'dist', 'Setup.' + pkg.version + '.exe');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--pre')) {
    try {
      const res = preflight();
      console.log('verify-installer-manifest (pre): המנגנון תקף');
      console.log('  build/installer.nsh: הרמה עצמית ב-preInit, בלי לקבוע מניפסט בעצמו');
      console.log(res.template.checked
        ? '  תבנית electron-builder: מוחלת (RequestExecutionLevel user) — ' +
          res.template.file + ':' + res.template.line
        : '  תבנית electron-builder: ' + res.template.reason);
      console.log('  הבנייה: perMachine, בלי nsis.script, בלי תיקון EXE בדיעבד');
      return;
    } catch (err) {
      console.error(String((err && err.message) || err));
      process.exit(1);
    }
  }

  const target = args[0] ? path.resolve(args[0]) : resolveDefaultInstallerPath();
  if (!fs.existsSync(target)) {
    console.error('verify-installer-manifest: לא נמצא קובץ ההתקנה: ' + target);
    process.exit(1);
  }
  try {
    const res = verifyFile(target);
    console.log('verify-installer-manifest: ' + res.file);
    console.log('  מניפסט: asInvoker (נקבע בזמן הקומפילציה) — ללא requireAdministrator');
    console.log('  שלמות מול מטא-דאטה של הבנייה: ' + res.integrity);
    console.log('  גודל: ' + res.size + ' בתים');
    const removed = removeUnusedMetadata(target);
    if (removed.length) console.log('  הוסרו קבצי מטא-דאטה שאינם נפרסים: ' + removed.join(', '));
  } catch (err) {
    console.error(String((err && err.message) || err));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  verifyBuffer, verifyFile, removeUnusedMetadata, isPeFile,
  sha512Base64, expectedSha512FromLatestYml,
  checkInclude, checkBuildConfig, checkTemplate, preflight,
  resolveDefaultInstallerPath,
  MANIFEST_AS_INVOKER, FORBIDDEN_LEVEL,
  NSIS_INCLUDE, TEMPLATE_DIR, TEMPLATE_PATCHER
};
