/**
 * ============================================================
 *  בין הזמנים — אפליקציית שחזור סיסמה (Google Apps Script)
 *  יוצר: לב טוב דיגיטל — https://digital.levtov.uk/
 * ============================================================
 *
 * איך לפרוס:
 * 1. פתחו גיליון Google Sheets חדש (חינם).
 * 2. תפריט: extensions → Apps Script (הרחבות → אפליקציות סקריפט).
 * 3. הדביקו את הקוד הזה במקום הקוד הקיים, ושנו את SECRET_KEY
 *    לערך ארוך ואקראי שמשמש אתכם בלבד.
 * 4. לחצו: Deploy → New deployment (פריסה → פריסה חדשה).
 *    סוג: Web app. הרשאות: "Anyone" (כל אחד) + Execute as: Me (כיוצר).
 * 5. העתיקו את כתובת ה-URL שנוצרה (…/exec) והדביקו אותה בתוכנה
 *    בשדה "כתובת אפליקציית השחזור".
 * 6. בכל פעם שתלחצו "שכחו סיסמה" בתוכנה — הסיסמה תישלח למייל
 *    המוגדר, והבקשה תירשם בגיליון (שעון, מייל, סיסמה, תאריך).
 *
 * כתובת הפריסה של אפליקציה זו נקבעה מראש בתוכנה (ב-main.js,
 * הקבוע RECOVERY_URL), כך שכל בקשת שחזור של כל המשתמשים
 * נשלחת לכאן בלבד — וכל הסיסמאות נשמרות בגיליון שלכם.
 *
 * שימו לב: הגיליון מכיל סיסמאות — שמרו אותו פרטי (לא לשתף!).
 * ============================================================
 */

/** סוד משותף — חייב להיות זהה בדיוק לסוד בתוכנה (secret.local.js → RECOVERY_SECRET).
 *  שימו לב: כאן מופיע ערך פלצהולדר! בקובץ הזה שבמאגר הציבורי אין את הסוד האמיתי.
 *  לפני הפריסה (Deploy) — החליפו את הערך למפתח הסודי האמיתי שלכם, אותו אחד
 *  שמוגדר ב-secret.local.js במחשב שלכם. */
var SECRET_KEY = 'CHANGE_ME_BEFORE_DEPLOY';

/** שם הגיליון שבו נרשמות הבקשות */
var SHEET_NAME = 'RecoveryLog';

/**
 * נקודת קצה שמקבלת POST מהתוכנה.
 * גוף הבקשה (JSON):
 *   { secret, email, password, app, time }
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!body.secret || body.secret !== SECRET_KEY) {
      return jsonResponse({ ok: false, error: 'secret invalid' });
    }
    if (!body.email || !body.password) {
      return jsonResponse({ ok: false, error: 'missing fields' });
    }

    // רישום לגיליון
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    sheet.appendRow([
      new Date(),
      body.app || 'BenHazmanim',
      body.email,
      body.password,
      'sent'
    ]);

    // שליחת המייל
    GmailApp.sendEmail(
      body.email,
      'בין הזמנים — שחזור סיסמה',
      'שלום,\n\nזוהי הסיסמה שלכם לאפליקציית "בין הזמנים" לניהול זמן המחשב:\n\n' +
      body.password +
      '\n\nמומלץ לשנות את הסיסמה לאחר הכניסה.\n\nבברכה,\nלב טוב דיגיטל — digital.levtov.uk'
    );

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
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
