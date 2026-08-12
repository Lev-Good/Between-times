/**
 * ============================================================
 *  בין הזמנים — אפליקציית שחזור סיסמה (Google Apps Script)
 *  יוצר: לב טוב דיגיטל — https://digital.levtov.uk/
 * ============================================================
 *
 * איך לפרוס:
 * 1. פתחו גיליון Google Sheets חדש (חינם).
 * 2. תפריט: extensions → Apps Script (הרחבות → אפליקציות סקריפט).
 * 3. הדביקו את הקוד הזה במקום הקוד הקיים.
 * 4. לחצו: Deploy → New deployment (פריסה → פריסה חדשה).
 *    סוג: Web app. הרשאות: "Anyone" (כל אחד) + Execute as: Me (כיוצר).
 * 5. העתיקו את כתובת ה-URL שנוצרה (…/exec) והדביקו אותה בתוכנה
 *    בשדה "כתובת אפליקציית השחזור".
 * 6. בכל פעם שתלחצו "שכחו סיסמה" בתוכנה — קוד חד-פעמי יישלח למייל
 *    המוגדר. הסיסמה עצמה לעולם אינה נשלחת או נשמרת בשרת.
 *
 * כתובת הפריסה של אפליקציה זו נקבעה מראש בתוכנה (ב-main.js,
 * הקבוע RECOVERY_URL), כך שכל בקשת שחזור נשלחת לכאן בלבד.
 *
 * שימו לב: הגיליון מכיל כתובות מייל ומטא-נתוני שחזור בלבד — שמרו אותו פרטי.
 * ============================================================
 */

/** שם הגיליון שבו נרשמות הבקשות */
var SHEET_NAME = 'RecoveryLog';
var RATE_LIMIT_MS = 5 * 60 * 1000;

function recoveryEmailKey(email) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    email,
    Utilities.Charset.UTF_8
  );
  return 'recovery-last-' + bytes.map(function (b) {
    return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0');
  }).join('');
}

/**
 * נקודת קצה שמקבלת POST מהתוכנה.
 * גוף הבקשה (JSON):
 *   { email, token, app, time }
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var email = String(body.email || '').trim().toLowerCase();
    var token = String(body.token || '');
    // Require a normal address beginning with an alphanumeric character;
    // this also prevents spreadsheet formula injection through the log.
    if (!/^[a-z0-9][^\\s@]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email) ||
        !/^[0-9a-f]{64}$/i.test(token)) {
      return jsonResponse({ ok: false, error: 'invalid fields' });
    }

    // A public web-app endpoint must not become an email-spam relay. The
    // timestamp is keyed by a hash, so the script properties do not duplicate
    // the email address, and no token is ever stored server-side.
    var lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      var props = PropertiesService.getScriptProperties();
      var key = recoveryEmailKey(email);
      var last = Number(props.getProperty(key) || 0);
      if (Date.now() - last < RATE_LIMIT_MS) {
        return jsonResponse({ ok: false, error: 'rate limited' });
      }
      props.setProperty(key, String(Date.now()));
    } finally {
      lock.releaseLock();
    }

    // רישום מטא-נתונים בלבד — לעולם לא שומרים את הקוד או את הסיסמה.
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    sheet.appendRow([new Date(), 'BenHazmanim', email, 'token-sent']);

    GmailApp.sendEmail(
      email,
      'בין הזמנים — קוד שחזור',
      'שלום,\n\nקוד השחזור החד-פעמי שלכם הוא:\n\n' +
      token +
      '\n\nהקוד תקף לזמן קצר ומשמש להגדרת סיסמה חדשה.\n\nבברכה,\nלב טוב דיגיטל — digital.levtov.uk'
    );

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'recovery service error' });
  }
}

/** בדיקת תקינות — GET פשוט */
function doGet() {
  return jsonResponse({ ok: true, name: 'BenHazmanim recovery', status: 'deployed' });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
