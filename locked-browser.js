'use strict';

/**
 * locked-browser.js — הגנות הדפדפן המוגבל („אתר נעול” / רשימת חסימה).
 *
 * שני המצבים של רשימת האתרים חולקים את אותן הגנות בדיוק:
 *   • רשימת היתר (allowlist) — מותר רק מה שברשימה.
 *   • רשימת חסימה (blocklist) — מותר הכול חוץ ממה שברשימה.
 *
 * כדי שלא ייווצרו שני עותקים של אותה לוגיקה (ומכאן גם שני מקומות לתקן בהם),
 * שתי הפרימיטיביות כאן משותפות ל-main.js ולבדיקת ה-E2E שמריצה Chromium אמיתי.
 * המודול אינו תלוי ב-electron ברמת המודול: ה-session וה-webContents מוזרקים
 * כפרמטרים — כך אפשר לבדוק אותו מול Electron אמיתי, וגם אין תלות במטמון
 * ה-require של בדיקות היחידה שמדמות את electron.
 */

/**
 * הגנות הניווט על webContents של תוכן מרוחק:
 *   - will-navigate / will-redirect — ניווט ישיר או הפניה לכתובת אסורה נחסמים.
 *   - will-frame-navigate — מסגות (iframes) אסורות נחסמות.
 *   - setWindowOpenHandler — חלון חדש נדחה תמיד; כתובת מותרת נטענת באותו חלון.
 * @param {object} webContents  ה-webContents של התוכן
 * @param {{allows:(url:string)=>boolean, onBlocked?:(url:string)=>void}} opts
 */
function applyLockedNavigationGuards(webContents, opts) {
  const options = opts || {};
  const allows = typeof options.allows === 'function' ? options.allows : () => false;
  const onBlocked = typeof options.onBlocked === 'function' ? options.onBlocked : () => {};
  const prevent = (event) => { try { event.preventDefault(); } catch { /* ignore */ } };

  const urlGuard = (event, url) => {
    if (!allows(String(url == null ? '' : url))) {
      prevent(event);
      onBlocked(String(url == null ? '' : url));
    }
  };
  // will-frame-navigate מקבל אירוע שנושא את הכתובת בתוכו (אין ארגומנט שני)
  const frameGuard = (event) => {
    const url = event && event.url ? String(event.url) : '';
    if (url && !allows(url)) {
      prevent(event);
      onBlocked(url);
    }
  };

  webContents.on('will-navigate', urlGuard);
  webContents.on('will-redirect', urlGuard);
  webContents.on('will-frame-navigate', frameGuard);

  webContents.setWindowOpenHandler((details) => {
    const url = details && details.url ? String(details.url) : '';
    if (allows(url)) {
      try { webContents.loadURL(url); } catch { /* ignore */ }
    } else {
      onBlocked(url);
    }
    return { action: 'deny' };
  });

  return { urlGuard, frameGuard };
}

/**
 * נעילת ה-Session של הדפדפן המוגבל: בלי הרשאות (מצלמה/מיקרופון/מיקום),
 * ובלי הורדות. מבודד מהמערכת (partition נפרד), כדי שגלישה מוגבלת לא
 * תשאיר עוגיות/התחברויות בדפדפן הרגיל.
 * @param {object} ses  אובייקט session של Electron (session.fromPartition(...))
 */
function hardenLockedSession(ses) {
  try {
    if (!ses) return;
    if (typeof ses.setPermissionRequestHandler === 'function') {
      ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    }
    if (typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler(() => false);
    }
    if (typeof ses.on === 'function' && !ses.__benHazmanimDownloadLock) {
      ses.__benHazmanimDownloadLock = true;
      ses.on('will-download', (e) => e.preventDefault());
    }
  } catch { /* ignore */ }
}

module.exports = { applyLockedNavigationGuards, hardenLockedSession };
