/**
 * החלת מניפסט asInvoker על המתקין — **בזמן הקומפילציה**.
 *
 * למה זה נדרש
 * -----------
 * התוכנה מפעילה את מתקין העדכון בעצמה. גרסאות ותיקות (למשל 1.6.5, שעדיין
 * מותקנת אצל חלק מהמשתמשים) עושות זאת ב-spawn רגיל — כלומר CreateProcess,
 * שאינו מרים הרשאות: הפעלה של קובץ עם מניפסט `requireAdministrator` נכשלת מיד
 * (ERROR_ELEVATION_REQUIRED / 740), בלי חלון UAC ובלי חלון שגיאה. זו התקלה
 * שבגללה "עדכן" סגר את התוכנה ולא התקין דבר.
 *
 * לכן המתקין מופץ עם מניפסט `asInvoker` והוא מרים את עצמו ב-preInit
 * (build/installer.nsh) — שהוא הנתיב היחיד שמציג את חלון ה-UAC. כך ההפעלה שלו
 * מצליחה מכל הקשר, וההתקנה נשארת ברמת המחשב.
 *
 * **ומה שאסור בתכלית האיסור:** לתקן את המניפסט *אחרי* הבנייה, בנגיעה בבתים
 * של ה-EXE. זה מה שנעשה ב-1.7.2 — והמתקין ששוחרר לא עבד בכלל: הוא יצא מיד עם
 * קוד 2, בלי חלון, בלי שגיאה ובלי התקנה, בכל מחשב וגם בהתקנה ידנית. הסיבה:
 * NSIS בודק את שלמות המתקין שלו בזמן ההרצה. אומת במבחן מבוקר (23/9/2026):
 * שינוי בית בודד ב-stub, במניפסט, באמצע הקובץ ובסופו — כולם הסתיימו בקוד
 * יציאה 2; הקובץ המקורי הסתיים ב-0.
 *
 * למה כאן, ולא בהגדרה ב-build/installer.nsh
 * ------------------------------------------
 * התבנית של electron-builder מנפיקה `RequestExecutionLevel admin` כש-perMachine
 * פעיל, ואין לה מתג לכך. נבדקו ונפסלו:
 *   • `nsis.script` (עותק של התבנית) — הנתיב הזה מבטל את בניית המסיר של
 *     electron-builder, וההתקנה נכשלת עם ${UNINSTALLER_OUT_FILE} ריק.
 *   • `!define admin user` בקובץ ההרחבה — מעבד המקדים של NSIS מחליף סמל שהוגדר
 *     ב-!define רק בראש שורה (הגדרת "פקודה"), ולא כארגומנט של פקודה. אומת
 *     במפורש: המניפסט נשאר requireAdministrator, והאימות שאחרי הבנייה תפס זאת.
 *   • תיקון ה-EXE אחרי הבנייה — מפיל את המתקין לגמרי (ראו לעיל).
 *
 * מה שנשאר הוא לשנות את **קובץ המקור** של התבנית, כלומר את מה שמקומפל —
 * וזה בטוח לחלוטין: הסקריפט הזה אינו נוגע בקובץ ההתקנה שנבנה, אלא רק בקלט
 * הבנייה. ההחלפה מוגבלת לשורה אחת ולכן היא שקופה: מבנה ההתקנה, perMachine,
 * ${PROGRAMFILES64}\ben-hazmanim, המשימות והקיצורים לא משתנים; רק מי שמבקש
 * את ההרשאה משתנה — המתקין עצמו במקום Windows.
 *
 * הסקריפט אידמפוטנטי (הרצה חוזרת לא מזיקה) ורץ אוטומטית ב-postinstall, כך
 * שההחלה חוזרת מעצמה אחרי כל התקנה מחדש של החבילות. אם השורה לא נמצאה —
 * הסקריפט **נכשל בקול** ולא ממשיך בשקט, כדי שלא ייבנה מתקין שדורש הרשאות.
 *
 * שימוש:
 *   node scripts/patch-nsis-template.js          # להחיל (או לוודא שהוחל)
 *   node scripts/patch-nsis-template.js --check  # לבדוק בלבד, בלי לשנות דבר
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
const INSTALLER_TEMPLATE = path.join(TEMPLATE_DIR, 'installer.nsi');

// הסימן שמזהה שהתבנית כבר הוחלה — מחרוזת אחת, משותפת עם האימות והבדיקות
const PATCH_MARK = 'patched by ben-hazmanim';
const PATCHED_RE = new RegExp('^[ \\t]*RequestExecutionLevel[ \\t]+user[ \\t]*;[ \\t]*' + PATCH_MARK + '.*$', 'm');
// השורה בתבנית שאותה מחליפים (perMachine, בניית המתקין — לא בניית המסיר)
const ADMIN_LINE = /^([ \t]*)RequestExecutionLevel[ \t]+admin[ \t]*$/m;

const PATCHED_LINE = '$1RequestExecutionLevel user ; ' + PATCH_MARK +
  ' — manifest asInvoker, ההרמה עצמית ב-preInit (ראו build/installer.nsh)';

// מחזיר { text, state } בלי לגעת בקובץ:
//   'patched'  — התבנית כבר מוחלת
//   'patched-now' — הוחלה עכשיו (text שונה)
// זורק שגיאה בקול אם השורה לא נמצאה — כדי שלא ייבנה מתקין שדורש הרשאות בשקט
function patchTemplateText(text) {
  if (PATCHED_RE.test(text)) return { text, state: 'patched' };
  if (!ADMIN_LINE.test(text)) {
    throw new Error(
      'patch-nsis-template: לא נמצאה בתבנית של electron-builder השורה ' +
      '"RequestExecutionLevel admin" (perMachine).\n' +
      '  ייתכן שהחבילה עודכנה ושינתה את התבנית. אין לבנות כך גרסה: המתקין ' +
      'ייצא עם מניפסט requireAdministrator, והפעלה שלו מתהליך רגיל נכשלת בשקט ' +
      '(שגיאה 740) — זו התקלה שהמתקין של 1.7.2 נועד לפתור.\n' +
      '  יש לעדכן את הסקריפט הזה לפי התבנית החדשה, ולהשאיר את האימות ' +
      '(scripts/verify-installer-manifest.js) כפי שהוא.'
    );
  }
  return { text: text.replace(ADMIN_LINE, PATCHED_LINE), state: 'patched-now' };
}

// מאתר שימוש נוסף ב-RequestExecutionLevel admin במקום אחר בתבניות — אם יש
// כזה, ההחלה שלנו לא מספיקה (והוא יופיע גם בקובץ שנבנה)
function findOtherAdminLevels(dir, skipFile) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.(nsi|nsh)$/i.test(entry.name)) continue;
      if (path.resolve(p) === path.resolve(skipFile)) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (/^[ \t]*RequestExecutionLevel[ \t]+admin/m.test(text)) {
        found.push(path.relative(ROOT, p));
      }
    }
  };
  walk(dir);
  return found;
}

function apply({ check = false, quiet = false } = {}) {
  if (!fs.existsSync(INSTALLER_TEMPLATE)) {
    const reason = 'electron-builder אינו מותקן (node_modules חסר) — אין מה להחיל';
    if (!quiet) console.log('patch-nsis-template: ' + reason);
    return { state: 'missing', reason };
  }

  const original = fs.readFileSync(INSTALLER_TEMPLATE, 'utf8');
  const other = findOtherAdminLevels(TEMPLATE_DIR, INSTALLER_TEMPLATE);
  if (other.length) {
    throw new Error(
      'patch-nsis-template: נמצא RequestExecutionLevel admin גם ב-' + other.join(', ') + '.\n' +
      '  יש לעדכן את ההחלה ואת האימות לפני בנייה.'
    );
  }

  const { text, state } = patchTemplateText(original);
  if (state === 'patched-now' && !check) {
    fs.writeFileSync(INSTALLER_TEMPLATE, text, 'utf8');
  }
  if (!quiet) {
    console.log('patch-nsis-template: ' + path.relative(ROOT, INSTALLER_TEMPLATE) + ' — ' +
      (state === 'patched'
        ? 'כבר הוחל (RequestExecutionLevel user)'
        : (check ? 'טרם הוחל (נדרשת החלה)' : 'הוחל כעת (RequestExecutionLevel user)')));
  }
  return { state, file: INSTALLER_TEMPLATE };
}

function main() {
  const check = process.argv.slice(2).includes('--check');
  try {
    const res = apply({ check });
    if (check && res.state === 'patched-now') process.exit(1);
  } catch (err) {
    console.error(String((err && err.message) || err));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  apply, patchTemplateText, findOtherAdminLevels,
  PATCH_MARK, PATCHED_RE, PATCHED_LINE, ADMIN_LINE, TEMPLATE_DIR, INSTALLER_TEMPLATE
};
