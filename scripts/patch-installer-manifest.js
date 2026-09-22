/**
 * תיקון מניפסט ההרשאה של קובץ ההתקנה (dist/Setup.<version>.exe).
 *
 * למה זה נדרש
 * -----------
 * המתקין נבנה עם perMachine: true, ו-electron-builder מנפיק לו מניפסט עם
 * requestedExecutionLevel="requireAdministrator". הפעלה של קובץ כזה מתהליך
 * שאינו מוגבר נכשלת **מיד** ב-CreateProcess (שגיאה 740) — בלי חלון UAC ובלי
 * חלון שגיאה. זו בדיוק התקלה שבגללה "עדכון מתוך התוכנה" הציג "מתקין…", סגר
 * את התוכנה ולא התקין כלום — בכל הגרסאות עד 1.7.1.
 *
 * לכן המתקין מופץ עם מניפסט asInvoker, והוא מרים את עצמו ב-preInit
 * (ראו build/installer.nsh): כל הפעלה שלו מתחילה בהצלחה — בין אם הופעל
 * מתהליך רגיל (גרסה ותיקה של התוכנה) ובין אם מוגבר — ורק אז מוצג חלון ה-UAC.
 * כך ההגנה לא תלויה יותר בכך שהמפעיל ביקש הרשאות.
 *
 * איך זה נעשה
 * -----------
 * החלפת המחרוזת shומרת על **אורך הקובץ בדיוק**: "requireAdministrator" מוחלף
 * ב-"asInvoker" ומרופד ברווחים מיד לאחר סגירת המרכאות, כלומר בין תכונות התג
 * (רווח בין תכונות הוא XML חוקי לחלוטין). לכן גודל ה-resource, טבלאות ה-PE
 * ומבנה הקובץ לא משתנים כלל — ומדובר בשינוי בטוח של 20 בתים.
 *
 * כישלון "בקול": אם המחרוזת לא נמצאות (למשל electron-builder ישנה בעתיד את
 * המניפסט, או שהקובץ כבר תוקן) הסקריפט נכשל עם שגיאה מפורשת — כדי שאף גרסה
 * "מתוקנת" לא תשוחרר בלי התיקון בשקט.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MANIFEST_FROM = 'level="requireAdministrator"';
const MANIFEST_TO_PREFIX = 'level="asInvoker"';
// ריפוד באותו אורך — כדי שגודל הקובץ יישאר זהה לחלוטין
const MANIFEST_TO = MANIFEST_TO_PREFIX + ' '.repeat(MANIFEST_FROM.length - MANIFEST_TO_PREFIX.length);

// האם זהו קובץ PE תקין? (MZ בכותרת + חתימת PE) — בדיקת שפיות לפני ואחרי
function isPeFile(buf) {
  if (buf.length < 0x40) return false;
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return false; // "MZ"
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff <= 0 || peOff + 4 > buf.length) return false;
  return buf.readUInt32LE(peOff) === 0x00004550; // "PE\0\0"
}

// מחליף את רמת ההרשאה במניפסט. מחזיר Buffer חדש באותו אורך.
function patchBuffer(input) {
  const buf = Buffer.from(input); // עובדים על עותק, הקלט לא משתנה
  if (!isPeFile(buf)) {
    throw new Error('patch-installer-manifest: הקובץ אינו קובץ PE תקין (MZ/PE) — לא ממשיכים');
  }

  const at = buf.indexOf(MANIFEST_FROM, 0, 'utf8');
  if (at === -1) {
    throw new Error(
      'patch-installer-manifest: לא נמצא מניפסט ' + MANIFEST_FROM + ' בקובץ. ' +
      'אפשרויות: (1) הקובץ כבר תוקן, (2) electron-builder שינה את מבנה המניפסט ' +
      '(למשל uiAccess/גרסה אחרת) — במקרה כזה יש לעדכן את MANIFEST_FROM כאן ' +
      'ולא לשחרר גרסה בלי התיקון.'
    );
  }
  if (buf.indexOf(MANIFEST_FROM, at + 1) !== -1) {
    throw new Error(
      'patch-installer-manifest: המניפסט מופיע יותר מפעם אחת בקובץ — ' +
      'לא ברור איזה מהם לתקן, ולא ממשיכים (כדי לא לפרסם מתקין חצי-מתוקן)'
    );
  }
  // בדיקת הקשר: שהמחרוזת היא באמת של מניפסט ההרשאה, ולא משהו אחר במקרה
  const context = buf.slice(Math.max(0, at - 400), at).toString('utf8');
  if (!context.includes('requestedExecutionLevel')) {
    throw new Error('patch-installer-manifest: המחרוזת נמצאה מחוץ למניפסט ההרשאה — לא ממשיכים');
  }

  buf.write(MANIFEST_TO, at, 'utf8');

  // אימות אחרי השינוי: אורך זהה, אין requireAdministrator, יש asInvoker תקין
  if (buf.length !== input.length) {
    throw new Error('patch-installer-manifest: אורך הקובץ השתנה — לא ממשיכים');
  }
  if (buf.indexOf('requireAdministrator', 0, 'utf8') !== -1) {
    throw new Error('patch-installer-manifest: המניפסט לא הוחלף (requireAdministrator נשאר)');
  }
  if (buf.indexOf(MANIFEST_TO_PREFIX, 0, 'utf8') === -1) {
    throw new Error('patch-installer-manifest: asInvoker לא נכתב כמצופה');
  }
  // הריפוד חייב לנחות *בין* תכונות התג — אחרת הערך היה "asInvoker   " ולא היה מזוהה
  const xmlAfter = buf.slice(at, at + 64).toString('utf8');
  if (!/^level="asInvoker"\s+uiAccess=/.test(xmlAfter)) {
    throw new Error('patch-installer-manifest: הריפוד לא נחת במקום תקין ב-XML: ' + JSON.stringify(xmlAfter));
  }
  return buf;
}

// מתקן קובץ בדיסק (בכתיבה אטומית: קובץ זמני ואז rename)
function patchFile(filePath) {
  const original = fs.readFileSync(filePath);
  const patched = patchBuffer(original);
  const tmp = filePath + '.patch-tmp';
  fs.writeFileSync(tmp, patched);
  fs.renameSync(tmp, filePath);
  return {
    file: filePath,
    size: patched.length,
    manifestFrom: MANIFEST_FROM,
    manifestTo: MANIFEST_TO_PREFIX
  };
}

// אחרי התיקון, קבצי המטא-דאטה ש-electron-builder מייצר מתארים את הקובץ
// **לפני** התיקון (טביעת sha512 וגודל ב-latest.yml, וטביעות של בלוקים
// ב-blockmap) ולכן אינם נכונים יותר. התוכנה אינה משתמשת ב-electron-updater
// — העדכון שלה מבוסס version.json ונכס המהדורה בגיטהאב — והקבצים האלה גם
// מעולם לא פורסמו. לכן מסירים אותם במקום להשאיר מטא-דאטה מטעה.
function removeStaleMetadata(filePath) {
  const removed = [];
  const candidates = [filePath + '.blockmap', path.join(path.dirname(filePath), 'latest.yml')];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      fs.unlinkSync(c);
      removed.push(path.basename(c));
    }
  }
  return removed;
}

function resolveDefaultInstallerPath() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return path.join(__dirname, '..', 'dist', 'Setup.' + pkg.version + '.exe');
}

function main() {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : resolveDefaultInstallerPath();
  if (!fs.existsSync(target)) {
    console.error('patch-installer-manifest: לא נמצא קובץ ההתקנה: ' + target);
    process.exit(1);
  }
  try {
    const res = patchFile(target);
    console.log('patch-installer-manifest: עודכן ' + res.file);
    console.log('  מניפסט: ' + res.manifestFrom + ' → ' + res.manifestTo);
    console.log('  גודל: ' + res.size + ' בתים (ללא שינוי)');
    const removed = removeStaleMetadata(target);
    if (removed.length) console.log('  הוסרו קבצי מטא-דאטה שהתיישנו בתיקון: ' + removed.join(', '));
  } catch (err) {
    console.error(String((err && err.message) || err));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  patchBuffer, patchFile, removeStaleMetadata, isPeFile,
  MANIFEST_FROM, MANIFEST_TO, MANIFEST_TO_PREFIX
};
