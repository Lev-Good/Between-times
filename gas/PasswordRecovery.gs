/**
 * ============================================================
 *  בין הזמנים — אפליקציית שחזור סיסמה + שותף אחריות (Google Apps Script)
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
 * שותף אחריות (Accountability): הבקשה יכולה לכלול גם כתובת partner —
 * ואז קוד השחזור נשלח גם לשותף. בנוסף התוכנה שולחת:
 *   - notice: התראה לשותף על שינוי סיסמה (ללא קוד).
 *   - purpose:'unlock' + token מספרי: קוד אישור פתיחה שנשלח לשותף בלבד.
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
var GLOBAL_HOURLY_LIMIT = 100;

function recoveryEmailKey(email, bucket) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    email,
    Utilities.Charset.UTF_8
  );
  return 'recovery-last-' + String(bucket || 'recovery') + '-' + bytes.map(function (b) {
    return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0');
  }).join('');
}

// Require a normal address beginning with an alphanumeric character;
// this also prevents spreadsheet formula injection through the log.
// NOTE: this is a regex literal, so use \s (whitespace) and \. (literal
// dot) — the earlier \\s / \\. matched a literal backslash and rejected
// every valid address, silently breaking password recovery.
function isEmail(s) {
  return /^[a-z0-9][^\s@]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(String(s || ''));
}

// A recovery token is a 64-hex string; an unlock-approval code is 4–8 digits
// (human-friendly, read to the user by the accountability partner).
function isToken(t) {
  t = String(t || '');
  return /^[0-9a-f]{64}$/i.test(t) || /^\d{4,8}$/.test(t);
}

// A public web-app endpoint must not become an email-spam relay. The
// timestamp is keyed by a hash, so the script properties do not duplicate
// the email address, and no token is ever stored server-side.
function rateLimited(emailLower, bucket) {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var props = PropertiesService.getScriptProperties();
    var key = recoveryEmailKey(emailLower, bucket);
    var last = Number(props.getProperty(key) || 0);
    if (Date.now() - last < RATE_LIMIT_MS) return true;
    props.setProperty(key, String(Date.now()));
    return false;
  } finally {
    lock.releaseLock();
  }
}

function globalRateLimited() {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var props = PropertiesService.getScriptProperties();
    var hour = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
    var key = 'global-hour-' + hour;
    var count = Number(props.getProperty(key) || 0);
    if (count >= GLOBAL_HOURLY_LIMIT) return true;
    props.setProperty(key, String(count + 1));
    return false;
  } finally {
    lock.releaseLock();
  }
}

// רישום מטא-נתונים בלבד — לעולם לא שומרים את הקוד או את הסיסמה.
function logRow(app, email, kind) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  sheet.appendRow([new Date(), app, email, kind]);
}

function noticeBody(kind) {
  var what = kind === 'pin-changed' ? 'סיסמת ההורה שונתה'
    : kind === 'pin-cleared' ? 'סיסמת ההורה הוסרה'
    : 'בוצע שינוי בהגדרות ההגנה';
  return 'שלום,\n\nכשותף אחריות אתם מקבלים עדכון: ' + what + ' במחשב המנוהל.\n\n' +
    'הסיסמה עצמה אינה נשלחת ואינה נשמרת בשרת.\n\nבברכה,\nלב טוב דיגיטל — digital.levtov.uk';
}

/**
 * נקודת קצה שמקבלת POST מהתוכנה.
 * גוף הבקשה (JSON) — אחד מהמצבים:
 *   שחזור/פתיחה: { email?, partner?, token, purpose?, app, time }
 *   התראת שותף:  { partner, notice, app, time }
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var app = String(body.app || 'BenHazmanim').slice(0, 40);
    var email = String(body.email || '').trim().toLowerCase();
    var partner = String(body.partner || '').trim().toLowerCase();
    var token = String(body.token || '');
    var notice = String(body.notice || '').trim();
    var purpose = String(body.purpose || 'recovery').trim();
    if (globalRateLimited()) return jsonResponse({ ok: false, error: 'rate limited' });

    // מצב 1 — התראת שותף אחריות (ללא קוד): נשלחת לשותף בלבד.
    if (notice) {
      if (notice !== 'pin-changed' && notice !== 'pin-cleared') {
        return jsonResponse({ ok: false, error: 'invalid fields' });
      }
      if (!isEmail(partner)) return jsonResponse({ ok: false, error: 'invalid fields' });
      if (rateLimited(partner, 'notice')) return jsonResponse({ ok: false, error: 'rate limited' });
      logRow(app, partner, 'notice:' + notice);
      GmailApp.sendEmail(partner, 'בין הזמנים — עדכון שותף אחריות', noticeBody(notice));
      return jsonResponse({ ok: true });
    }

    // מצב 2 — שליחת קוד חד-פעמי (שחזור סיסמה או אישור פתיחה).
    if (purpose !== 'recovery' && purpose !== 'unlock' && purpose !== 'settings-change') {
      return jsonResponse({ ok: false, error: 'invalid fields' });
    }
    if (!isToken(token)) return jsonResponse({ ok: false, error: 'invalid fields' });
    var recipients = [];
    if (isEmail(email)) recipients.push(email);
    if (isEmail(partner) && partner !== email) recipients.push(partner);
    if (recipients.length === 0) return jsonResponse({ ok: false, error: 'invalid fields' });

    // הגבלת קצב לפי הנמען הראשי (כתובת השחזור אם קיימת, אחרת השותף).
    if (rateLimited(recipients[0], purpose === 'unlock' ? 'unlock' : 'recovery')) {
      return jsonResponse({ ok: false, error: 'rate limited' });
    }

    var approval = purpose === 'unlock' || purpose === 'settings-change';
    var subject = approval ? 'בין הזמנים — קוד אישור פעולה' : 'בין הזמנים — קוד שחזור';
    var intro = purpose === 'settings-change'
      ? 'התבקש אישור להחלשת הגנות שותף האחריות במחשב. קוד האישור החד-פעמי:'
      : purpose === 'unlock'
        ? 'התבקש אישור לפתיחת החסימה במחשב. קוד האישור החד-פעמי:'
        : 'קוד השחזור החד-פעמי שלכם הוא:';
    for (var i = 0; i < recipients.length; i++) {
      logRow(app, recipients[i], approval ? purpose + '-code-sent' : 'token-sent');
      GmailApp.sendEmail(recipients[i], subject,
        'שלום,\n\n' + intro + '\n\n' + token +
        '\n\nהקוד תקף לזמן קצר.\n\nבברכה,\nלב טוב דיגיטל — digital.levtov.uk');
    }
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
