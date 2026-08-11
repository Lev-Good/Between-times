'use strict';

const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen,
  globalShortcut, Notification, shell, safeStorage, nativeTheme, dialog
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile, execFileSync } = require('child_process');
const S = require('./scheduler.js');

const isWin = process.platform === 'win32';

/* ================= מגן קריסה =================
   רשת ביטחון נגד "לולאת אתחול": שגיאה בלתי צפויה (למשל בתוך לולאת האכיפה
   שרצה כל 5 שניות, או בזמן יצירת חלון) אסור שתפיל את התהליך הראשי — אחרת
   שומר-השער היה מקפיץ אותו מחדש שוב ושוב, ונראה כאילו התוכנה "קורסת" עם
   חלון שחור שצץ כל כמה שניות. השגיאה מתועדת והתוכנה ממשיכה לפעול. */
// בעת בדיקות/טעינה מחדש של המודול לא להוסיף מאזינים כפולים ל-process.
// הלוג נכתב ישירות כדי שהמטפל לא יהיה תלוי בסדר האתחול של logEvent.
if (!process.__benHazmanimCrashHandlers) {
  const writeCrash = (kind, value) => {
    try {
      const msg = String((value && value.message) || value);
      console.error(kind, value && (value.stack || value.message) || value);
      const file = path.join(app.getPath('userData'), 'activity.log');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), type: 'crash', details: { msg } }) + '\n', 'utf8');
    } catch { /* ignore */ }
  };
  process.on('uncaughtException', (err) => writeCrash('uncaughtException', err));
  process.on('unhandledRejection', (reason) => writeCrash('unhandledRejection', reason));
  process.__benHazmanimCrashHandlers = true;
}

/* ================= ערכת נושא (בהיר / כהה / מערכת) ================= */

// הערכת הנושא בפועל — 'light' או 'dark' — לפי ההגדרה השמורה והמערכת
function resolvedTheme() {
  const t = schedule && schedule.theme;
  if (t === 'light') return 'light';
  if (t === 'dark') return 'dark';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function windowBg() {
  return resolvedTheme() === 'light' ? '#eef0f9' : '#0a0a14';
}

// האם התהליך רץ עם הרשאות מנהל (elevated)?
// `net session` מצליחה רק עם הרשאות מנהל — דרך פשוטה לבדיקת UAC.
// התוצאה נשמרת ב-cache כי הבדיקה חוסמת את התהליך הראשי (sync).
let elevatedCache = null;
function isElevated() {
  if (!isWin) return false;
  if (elevatedCache != null) return elevatedCache;
  try {
    execFileSync('net', ['session'], { stdio: 'pipe', windowsHide: true });
    elevatedCache = true;
  } catch {
    elevatedCache = false;
  }
  return elevatedCache;
}

/* ================= שעון מהימן (נגד שינוי שעון המערכת) =================
   enforcement נמדד לפי זמן מונוטוני (hrtime) שאינו מושפע משינוי השעה ב-Windows.
   אם המשתמש משנה את השעון — החסימה נשארת נכונה לפי הזמן האמיתי שחלף. */
const HR_START = process.hrtime.bigint();
const WALL_START = Date.now();
function trustedNow() {
  return WALL_START + Math.floor(Number(process.hrtime.bigint() - HR_START) / 1e6);
}
function trustedDate() { return new Date(trustedNow()); }

/* ================= הגדרות ================= */

// קובץ ההגדרות: כשהתוכנה רצה עם הרשאות מנהל (למשל דרך המשימה המתוזמנת) —
// ההגדרות נשמרות במיקום משותף לכל המשתמשים (%ProgramData%), כך שכל חשבון
// במחשב נחסם לפי אותו לוח זמנים. אחרת — בתיקיית הנתונים של המשתמש הנוכחי.
const machineDir = () => path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'BenHazmanim');
const machineSettingsFile = () => path.join(machineDir(), 'settings.json');
// עותק מוגן של קבצי התוכנה — נשמר אצל "כל המשתמשים" כדי שמחיקת תיקיית
// ההתקנה המקורית (שנמצאת בפרופיל המשתמש וניתנת למחיקה) לא תשבית את האכיפה.
const protectedAppDir = () => path.join(machineDir(), 'app');
const protectedSettingsFile = () => path.join(protectedAppDir(), 'settings.backup.json');
const settingsFile = () => {
  if (!isWin) return path.join(app.getPath('userData'), 'settings.json');
  // כשקיים קובץ משותף (נוצר ע"י הרצה מוגבהת) — תמיד לקרוא ממנו, כדי שכל
  // המשתמשים (וגם הרצה לא-מוגבהת) יראו ויאכפו את אותן הגדרות.
  if (fs.existsSync(machineSettingsFile())) return machineSettingsFile();
  return isElevated() ? machineSettingsFile() : path.join(app.getPath('userData'), 'settings.json');
};

let schedule = S.defaultSchedule();
let win = null;            // חלון ההגדרות
let blockWins = [];        // חלונות החסימה (אחד לכל מסך)
let tray = null;
let quitWin = null;        // חלון אימות היציאה (סיסמת הורה) — למניעת עקיפת חסימה
let isQuitting = false;
let sessionUnlocked = false; // כניסה מוצלחת עם סיסמה לניהול ההגדרות
let manualLock = false;      // נעילה ידנית (נעל עכשיו) — מפעילה את מסך החסימה המלא
let shortcutsRegistered = false;
let lastBlockedState = false; // מעקב מצבי לזיהוי תחילת/סיום חסימה ביומן
let lastWarningActive = false; // מעקב מצבי לזיהוי כניסה/יציאה מחלון האזהרה לפני חסימה
let netBlockApplied = false;  // חוק חסימת האינטרנט פעיל בפועל בחומת האש
let netBlockFailed = false;   // ניסיון הפעלה נכשל (חומת אש לא זמינה/מנוהלת ע"י תוכנה אחרת)
let netBlockWarned = false;   // הודעת השגיאה נשלחה פעם אחת (לא לשלוח כל 5 שניות)
let lastNetActive = false;    // מעקב מצבי לזיהוי תחילת/סיום חסימת אינטרנט ביומן
let netIconWin = null;        // חלון האייקון הצף (מחשב פתוח + אינטרנט חסום)

// מצב "תוכנת לימוד מותרת": בזמן חסימה לפי הלוח, אם החלון הפעיל שייך לתוכנה
// תורנית שההורה התיר (למשל וורד, אוצריא, אוצר החכמה) — מסך החסימה מוסתר
// והתוכנה נשארת בשימוש. החסימה חוזרת מיד כשעוברים לתוכנה אחרת או סוגרים אותה.
let relaxed = false;          // האם אנחנו במצב "תוכנת לימוד פתוחה" עכשיו
let relaxedTimer = null;      // בדיקה תכופה יותר (1 שנייה) בזמן מצב רפוי
let enforceBusy = false;      // הגנה מפני ריצות חופפות של לולאת האכיפה
let enforceAgain = false;     // בקשה להרצה נוספת שהגיעה בזמן שהאכיפה הייתה עסוקה

// מטמון קצר של התוכנה שבחלון הפעיל — כדי לא להריץ PowerShell כל הזמן.
// זיהוי נעשה רק לפי צורך (אירוע blur / בדיקת האכיפה) והתוצאה תקפה ~1.2 שניות.
let fgCache = { at: 0, path: null, busy: false };
const fgWaiters = [];

/* ================= יומן פעילות (activity.log) =================
   תיעוד אירועים: התחלת/סיום חסימה, נעילות ידניות, פתיחות,
   ניסיונות כושלים ושינויי הגדרות — עבור דשבורד הסטטיסטיקות. */
const activityFile = () => path.join(app.getPath('userData'), 'activity.log');

function logEvent(type, details) {
  try {
    const file = activityFile();
    const entry = JSON.stringify({ ts: Date.now(), type, details: details || null }) + '\n';
    fs.appendFileSync(file, entry, 'utf8');
    // מניעת נפיחות לאורך זמן: מעל 1MB — לשמור רק את 500 השורות האחרונות
    if (fs.statSync(file).size > 1024 * 1024) {
      const raw = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, raw.split('\n').slice(-500).join('\n'), 'utf8');
    }
  } catch { /* ignore */ }
}

function readActivity(limit) {
  try {
    const raw = fs.readFileSync(activityFile(), 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* ignore */ }
    }
    return out.slice(-(limit || 1500));
  } catch {
    return [];
  }
}
let updateNote = null;

// הגנה מפני ניחוש סיסמה (ברוט-פורס): מונה כישלונות + נעילה זמנית.
// הנעילה נשמרת לקובץ — כך שהיא לא מתאפסת באתחול או בהרגת התהליך.
let pinFailures = 0;
let pinLockUntil = 0;
const pinLockFile = () => path.join(app.getPath('userData'), 'pinlock.json');

// נעילת ה-PIN הזמנית נמדדת בזמן המהימן (trustedNow) — כמו שאר התוכנה —
// כדי שילד לא יוכל לשנות את שעון המערכת ולעקוף את הנעילה אחרי 5 ניסיונות.
function loadPinLock() {
  try {
    const data = JSON.parse(fs.readFileSync(pinLockFile(), 'utf8'));
    if (data && typeof data.until === 'number' && data.until > trustedNow()) pinLockUntil = data.until;
  } catch { /* ignore */ }
}
function savePinLock() {
  try { fs.writeFileSync(pinLockFile(), JSON.stringify({ until: pinLockUntil }), 'utf8'); } catch { /* ignore */ }
}
function clearPinLock() {
  try { fs.unlinkSync(pinLockFile()); } catch { /* ignore */ }
}

function checkPinLock() {
  if (trustedNow() < pinLockUntil) return Math.ceil((pinLockUntil - trustedNow()) / 1000);
  if (pinLockUntil) { pinLockUntil = 0; clearPinLock(); } // הנעילה פגה — ניקוי
  return 0;
}
function pinFail() {
  pinFailures++;
  if (pinFailures >= 5) {
    pinLockUntil = trustedNow() + 60000; // 5 כישלונות -> נעילה של דקה (זמן מהימן)
    pinFailures = 0;
    savePinLock();
  }
}
function pinSuccess() {
  pinFailures = 0;
  if (pinLockUntil) { pinLockUntil = 0; clearPinLock(); }
}

// אימות סיסמה בתהליך הראשי עם נעילה זמנית — לכל מקום שדורש סיסמה
function verifyPinServer(pin) {
  if (!schedule.pinHash) return { ok: true };
  const lock = checkPinLock();
  if (lock > 0) {
    return { ok: false, locked: lock, error: 'נעילה זמנית — נסו שוב בעוד ' + lock + ' שניות' };
  }
  if (S.sha256Hex(String(pin || '')) === schedule.pinHash) {
    pinSuccess();
    return { ok: true };
  }
  pinFail();
  return { ok: false, error: 'סיסמה שגויה' };
}

// אחסון הסיסמה מוצפן עם DPAPI (safeStorage של Windows) — לא טקסט מלא בדיסק
function encryptPassword(pw) {
  try {
    if (isWin && safeStorage && safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(String(pw)).toString('base64');
    }
  } catch { /* ignore */ }
  // אין fallback לטקסט גלוי: אם DPAPI אינה זמינה, שחזור למייל יישאר
  // מושבת עד שהאפליקציה תרוץ בסביבה נתמכת.
  return null;
}
function decryptPassword(store) {
  if (!store) return '';
  try {
    if (store.startsWith('enc:') && isWin && safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(store.slice(4), 'base64'));
    }
  } catch { /* ignore */ }
  return store.startsWith('plain:') ? store.slice(6) : store;
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    schedule = S.normalizeSchedule(JSON.parse(raw));
  } catch {
    schedule = S.defaultSchedule();
    // קודם לשחזר גיבוי מוגן של ההגדרות, אם קיים. אחרת לבצע הגירה
    // מקובץ המשתמש הישן. כך מחיקת settings.json אינה מאפסת את הלוח
    // לפני שהשומר המערכתי מספיק לפעול.
    if (isWin && isElevated()) {
      try {
        const backup = fs.readFileSync(protectedSettingsFile(), 'utf8');
        schedule = S.normalizeSchedule(JSON.parse(backup));
        saveSettings();
      } catch {
        try {
          const old = fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
          schedule = S.normalizeSchedule(JSON.parse(old));
          saveSettings();
        } catch { /* אין קובץ ישן — מתחילים בהגדרות ברירת מחדל */ }
      }
    }
  }
  // ההפעלה עם Windows תמיד פעילה (ללא אפשרות לכיבוי), והרצה עם הרשאות
  // מנהל הוסרה מהממשק — כך שגם הגדרות ישנות לא יגרמו להרמה מוגבהת.
  schedule.startWithWindows = true;
  schedule.runAsAdmin = false;
  // בהרצה מוגבהת חייב להיווצר קובץ משותף גם בהתקנה חדשה עם לוח ריק;
  // השומר המערכתי משתמש בקיומו כסמן שהתוכנה הותקנה ולא כסמן שניתן למחוקו.
  if (isWin && isElevated() && !fs.existsSync(machineSettingsFile())) saveSettings();
}

function writeProtectedSettingsBackup() {
  if (!isWin || !isElevated() || !fs.existsSync(protectedAppDir())) return;
  try {
    fs.copyFileSync(machineSettingsFile(), protectedSettingsFile());
  } catch { /* העותק המוגן עדיין לא נוצר או אינו נגיש */ }
}

function saveSettings() {
  const write = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(schedule, null, 2), 'utf8');
  };
  try {
    write(settingsFile());
    writeProtectedSettingsBackup();
    return { ok: true, warning: null };
  } catch (err) {
    // אין הרשאת כתיבה לקובץ המשותף (הרצה לא-מוגבהת) — נופלים לקובץ המשתמש
    try {
      const fallback = path.join(app.getPath('userData'), 'settings.json');
      write(fallback);
      return { ok: true, warning: 'נשמר לפרופיל המשתמש בלבד — כדי לשמור לכל המשתמשים הפעילו את התוכנה כמנהל' };
    } catch (err2) {
      console.error('שמירת הגדרות נכשלה', err);
      return { ok: false, error: err.message };
    }
  }
}

/* ================= חלונות חסימה (כל המסכים) ================= */

function isBlockedNow() {
  // נעילה ידנית חלה תמיד — גם אם האכיפה לפי הלוח מושבתת
  return !!(manualLock || (schedule.enabled && S.getStatus(schedule, trustedDate()).state === 'blocked'));
}

// מצב "נעול" לפי הלוח — חסימת מחשב מלאה או חסימת אינטרנט בלבד
// (בשני המקרים הפתיחה המוקדמת מתבצעת עם סיסמת ההורה)
function isLockedState(st) {
  return st.state === 'blocked' || st.state === 'netblock';
}

function createBlockWindow(display) {
  const bw = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    fullscreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    backgroundColor: windowBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  bw.setAlwaysOnTop(true, 'screen-saver');
  bw.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  bw.loadFile(path.join(__dirname, 'renderer', 'block.html'));

  // מניעת עקיפה: איבוד מיקוד = החזרה מיידית לחלון החסימה — אלא אם התוכנה
  // שקיבלה את הפוקוס היא תוכנת לימוד מותרת (ואז עוברים למצב רפוי).
  bw.on('blur', () => {
    // גניבת מיקוד מתבצעת רק כשיש סיסמה — ללא סיסמה החסימה אינה פעילה
    if (!isQuitting && isBlockedNow() && schedule.pinHash) maybeStealFocus();
  });
  bw.on('close', (e) => {
    if (!isQuitting && isBlockedNow()) e.preventDefault();
  });
  return bw;
}

function showBlockWindows(status) {
  // עדכון חלונות קיימים
  blockWins = blockWins.filter((bw) => bw && !bw.isDestroyed());
  blockWins.forEach((bw) => bw.webContents.send('status', status));

  // יצירת חלון לכל מסך מחובר, וניקוי חלונות של מסכים שהוסרו
  const displays = screen.getAllDisplays();
  const ids = new Set(displays.map((d) => d.id));
  blockWins = blockWins.filter((bw) => {
    if (!bw || bw.isDestroyed()) return false;
    if (!ids.has(bw.blockDisplayId)) { bw.destroy(); return false; }
    return true;
  });
  for (const d of displays) {
    const exists = blockWins.some((bw) => bw.blockDisplayId === d.id);
    if (!exists) {
      const bw = createBlockWindow(d);
      bw.blockDisplayId = d.id;
      blockWins.push(bw);
    }
  }
  focusBlockWindows();
}

function focusBlockWindows() {
  // בזמן חלון אימות היציאה — לא לגנוב את המיקוד מההורה (אחרת אי אפשר להקליד סיסמה)
  if (quitPromptOpen()) return;
  blockWins.forEach((bw) => {
    if (bw && !bw.isDestroyed()) {
      bw.show();
      bw.focus();
      bw.setAlwaysOnTop(true, 'screen-saver');
    }
  });
}

function hideBlockWindows() {
  blockWins.forEach((bw) => { if (bw && !bw.isDestroyed()) bw.destroy(); });
  blockWins = [];
}

/* ================= חסימת קיצורי מקשים ================= */

const BLOCK_SHORTCUTS = ['Alt+Tab', 'Alt+Esc', 'Meta+Tab', 'Ctrl+Esc', 'Meta+Space', 'Alt+F4'];

function registerBlockShortcuts() {
  if (shortcutsRegistered) return;
  for (const accel of BLOCK_SHORTCUTS) {
    try {
      globalShortcut.register(accel, () => {
        // הקיצור נבלע — החזרת חלון החסימה לקדמת המסך (עם כבוד לתוכנות מותרות)
        maybeStealFocus();
      });
    } catch { /* חלק מהקיצורים אינם ניתנים לרישום */ }
  }
  shortcutsRegistered = true;
}

function unregisterBlockShortcuts() {
  if (!shortcutsRegistered) return;
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  shortcutsRegistered = false;
}

/* ================= חסימת אינטרנט בלבד (חוק חומת אש) =================
   חלון מסוג "netblock" חוסם רק את הרשת — המחשב עצמו נשאר פתוח לשימוש.
   החסימה מתבצעת עם חוק חומת אש אחד ייעודי משלנו (dir=out) בשם ייחודי,
   כך שאין כל התנגשות עם סינונים/חוקים קיימים של המשתמש — בזמן החסימה
   כל היציאה חסומה ממילא, ולאחר הסרת החוק הסינונים הקיימים חוזרים לפעול
   בדיוק כפי שהיו. החוק דורש הרשאת מנהל (המשימה המתוזמנת מריצה את התוכנה
   מוגבהת בכניסה) — בהרצה רגילה החסימה מדווחת ככשלה במקום להיכשל בשקט. */
const NET_RULE = 'BenHazmanimNetBlock';

// האם קיים חוק חסימה בשם שלנו? (נקרא בעלייה כדי לסנכרן עם מצב קיים
// אחרי קריסה/סגירה — חוקי חומת אש נשארים גם אחרי שהתוכנה נסגרת)
function netRuleExists() {
  return new Promise((resolve) => {
    if (!isWin) return resolve(false);
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + NET_RULE], (err) => resolve(!err));
  });
}

// הפעלה/כיבוי של חוק החסימה. נשען על קודי השגיאה של netsh (אמינים גם
// כשהפלט מקומי, למשל בעברית) ולא על ניתוח טקסט.
function netBlockSet(enable) {
  return new Promise((resolve) => {
    if (!isWin) return resolve({ ok: false, error: 'זמין רק בווינדוס' });
    if (!isElevated()) {
      return resolve({ ok: false, error: 'חסימת אינטרנט דורשת הרצה כמנהל — הפעילו את התוכנה כמנהל פעם אחת כדי ליצור את המשימה המתוזמנת המוגבהת' });
    }
    const done = (err, msg) => resolve(err ? { ok: false, error: msg || err.message } : { ok: true });
    if (enable) {
      execFile('netsh', ['advfirewall', 'firewall', 'add', 'rule', 'name=' + NET_RULE, 'dir=out', 'action=block', 'enable=yes', 'profile=any'], (err) => {
        if (!err) return done(null);
        // החוק כבר קיים (למשל מסשן קודם) — להפעיל אותו
        execFile('netsh', ['advfirewall', 'firewall', 'set', 'rule', 'name=' + NET_RULE, 'new', 'enable=yes'], (err2) => {
          done(err2, 'חומת האש אינה זמינה או מנוהלת על ידי תוכנה אחרת — לא ניתן לחסום את האינטרנט');
        });
      });
    } else {
      execFile('netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=' + NET_RULE], (err) => {
        if (!err) return done(null);
        // אין חוק כזה = הרשת כבר פתוחה — זה בסדר (אלא אם החוק דווקא קיים)
        netRuleExists().then((exists) => done(exists ? err : null));
      });
    }
  });
}

// סנכרון בעלייה: לדעת אם חוק החסימה נשאר פעיל מסשן קודם (חוקי חומת האש
// לא נמחקים מעצמם), כדי שהאכיפה תסיר/תפעיל אותו לפי הלוח הנוכחי.
async function reconcileNetBlock() {
  if (!isWin) return;
  netBlockApplied = await netRuleExists();
}

// האייקון הצף הקטן שמודיע שהמחשב פתוח אבל האינטרנט חסום.
// מוצג בפינת המסך הראשי, לא גונב מיקוד (focusable:false), ולחיצה עליו
// פותחת את חלון ההגדרות. ניתן לכבות אותו מההגדרות (showNetIcon).
function showNetIcon(show) {
  if (!show || schedule.showNetIcon === false) {
    if (netIconWin && !netIconWin.isDestroyed()) { netIconWin.destroy(); netIconWin = null; }
    return;
  }
  if (netIconWin && !netIconWin.isDestroyed()) return;
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    const size = 76;
    netIconWin = new BrowserWindow({
      x: wa.x + wa.width - size - 16,
      y: wa.y + 16,
      width: size,
      height: size,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    netIconWin.setAlwaysOnTop(true, 'screen-saver');
    netIconWin.loadFile(path.join(__dirname, 'renderer', 'netblock-icon.html'));
    netIconWin.on('closed', () => { netIconWin = null; });
  } catch { /* האייקון הוא קוסמטי — כשלון אינו קריטי */ }
}

/* ================= תוכנות תורניות מותרות בזמן חסימה =================
   אפשרות להורה להתיר תוכנות לימוד וכתיבה תורניות (וורד, אוצריא, זית,
   אוצר החכמה, בר אילן ועוד) גם בזמן שהמחשב חסום לפי הלוח. הזיהוי נעשה
   לפי התוכנה שבחלון הפעיל (הפוקוס) — אם היא ברשימה המורשית, מסך החסימה
   מוסתר והתוכנה נשארת בשימוש; ברגע שעוברים לתוכנה אחרת (או סוגרים אותה)
   החסימה חוזרת מיד. נעילה ידנית ("נעל עכשיו") תמיד חוסמת הכל. */

// איתור התוכנה שבחלון הפעיל — דרך Win32 API (GetForegroundWindow) עם
// PowerShell. הפלט הוא הנתיב המלא של קובץ ההרצה של התהליך הפעיל.
const FG_PS_SCRIPT =
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class FgW{" +
  "[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();" +
  "[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);}'; " +
  "$h=[FgW]::GetForegroundWindow(); $pid2=0; [void][FgW]::GetWindowThreadProcessId($h,[ref]$pid2); " +
  "(Get-Process -Id $pid2 -ErrorAction SilentlyContinue).Path";

function getForegroundApp() {
  return new Promise((resolve) => {
    if (!isWin) return resolve(null);
    // מטמון קצר — לא להריץ PowerShell שוב ושוב על כל אירוע blur
    if (Date.now() - fgCache.at < 1200 && !fgCache.busy) return resolve(fgCache.path);
    fgWaiters.push(resolve);
    if (fgCache.busy) return; // בדיקה כבר רצה — הממתינים יקבלו את תוצאתה
    fgCache.busy = true;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', FG_PS_SCRIPT], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      fgCache.path = err ? null : (String(stdout || '').split(/\r?\n/)[0].trim() || null);
      fgCache.at = Date.now();
      fgCache.busy = false;
      const waiters = fgWaiters.splice(0);
      waiters.forEach((w) => w(fgCache.path));
    });
  });
}

// בדיקה מקיפה של קובץ הפעלה: שם מוצר (מפרט הגרסה), חותם Authenticode
// (מצב + שם הנושא), וטביעת SHA-256. התוצאה נשמרת במטמון לפי נתיב (דקה) —
// כדי שבדיקת החסימה החוזרת לא תכביד. Windows עצמו שומר גם מטמון חתימות.
const fileInfoCache = new Map();
const VERIFY_TTL = 60 * 1000;

function inspectAppFile(p) {
  return new Promise((resolve) => {
    if (!isWin) return resolve(null);
    const key = String(p || '').toLowerCase();
    const hit = fileInfoCache.get(key);
    if (hit && Date.now() - hit.at < VERIFY_TTL) return resolve(hit);
    const q = JSON.stringify(String(p || ''));
    const script =
      '$i = Get-Item -LiteralPath ' + q + ' -ErrorAction SilentlyContinue; if (-not $i) { exit 1 }; ' +
      '$s = Get-AuthenticodeSignature -LiteralPath ' + q + '; ' +
      '$h = (Get-FileHash -Algorithm SHA256 -LiteralPath ' + q + ').Hash; ' +
      "$i.VersionInfo.ProductName + '|' + $s.Status.ToString() + '|' + $s.SignerCertificate.Subject + '|' + $h";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      let res = null;
      if (!err && stdout) {
        const parts = String(stdout).split(/\r?\n/)[0].split('|');
        res = {
          product: String(parts[0] || '').trim(),
          status: String(parts[1] || '').trim() || 'NotSigned',
          subject: String(parts[2] || '').trim(),
          hash: String(parts[3] || '').trim().toLowerCase()
        };
      }
      if (fileInfoCache.size > 300) fileInfoCache.clear();
      fileInfoCache.set(key, Object.assign({ at: Date.now() }, res));
      resolve(res);
    });
  });
}

// חילוץ שם החותם (CN) מתוך נושא התעודה — למשל "Microsoft Corporation"
function cnOf(subject) {
  const m = String(subject || '').match(/CN=([^,]+)/);
  return m ? m[1].trim() : String(subject || '').trim();
}

// אימות של תוכנה אחת מול התוכנה שבחלון הפעיל, לפי מצב האימות שלה:
// - publisher: שם הקובץ חייב להתאים + חותם תקני של אותו מוציא לאור + אותו
//   שם מוצר. כך העתקה/שינוי שם של כל תוכנה אחרת (גם חתומה) נכשלת.
// - path: הנתיב המלא חייב להתאים במדויק; אם נשמרה טביעת קובץ — גם היא.
async function foregroundMatchesApp(app, fgPath) {
  if (!app || !app.exe || !fgPath) return false;
  const p = String(fgPath).trim().replace(/\\+$/, '');
  const exe = String(app.exe).trim().replace(/\\+$/, '');
  if (!p || !exe) return false;
  const pl = p.toLowerCase();
  const exeL = exe.toLowerCase();

  if (app.mode === 'publisher' && app.publisher && app.product) {
    if (path.basename(exeL) !== path.basename(p).toLowerCase()) return false;
    const info = await inspectAppFile(p);
    if (!info || info.status !== 'Valid') return false;
    if (cnOf(info.subject).toLowerCase() !== String(app.publisher).toLowerCase()) return false;
    if (String(info.product || '').toLowerCase() !== String(app.product).toLowerCase()) return false;
    return true;
  }

  // מצב נתיב: רק נתיב מלא מדויק (לעולם לא התאמת שם קובץ בלבד)
  if (pl !== exeL) return false;
  if (app.hash) {
    const info = await inspectAppFile(p);
    if (!info || !info.hash || info.hash !== String(app.hash).toLowerCase()) return false;
  }
  return true;
}

// האם התוכנה שבחלון הפעיל נמצאת ברשימה המורשית (או ברשימת התוכנות הנלוות
// שלהן — כמו תוספים לוורד שפועלים כתוכנה נפרדת)? כל תוכנה מאומתת לפי
// מצב האימות שלה. אם משהו לא תקין — החסימה נשארת פעילה (fail closed).
async function isAllowedApp(fgPath) {
  if (!fgPath) return false;
  if (schedule.allowedAppsEnabled === false) return false;
  const apps = schedule.allowedApps || [];
  if (!apps.length) return false;
  for (const app of apps) {
    if (await foregroundMatchesApp(app, fgPath)) return true;
    for (const c of (app.companions || [])) {
      if (await foregroundMatchesApp(c, fgPath)) return true;
    }
  }
  return false;
}

// כניסה למצב רפוי: מסתירים את חלונות החסימה, מבטלים קיצורי מקשים ומתחילים
// בדיקה תכופה (כל שנייה) כדי לחזור לחסימה מיד כשהתוכנה המותרת כבר לא פעילה.
function enterRelaxed() {
  if (relaxed) return;
  relaxed = true;
  hideBlockWindows();
  unregisterBlockShortcuts();
  if (!relaxedTimer) relaxedTimer = setInterval(() => { if (relaxed) enforce(); }, 1000);
}

function exitRelaxed() {
  if (!relaxed) return;
  relaxed = false;
  if (relaxedTimer) { clearInterval(relaxedTimer); relaxedTimer = null; }
}

// גניבת פוקוס חכמה: אם חלון התוכנה המותרת קיבל את הפוקוס — לא לגנוב אותו
// בחזרה, אלא להיכנס למצב רפוי. אחרת — להחזיר את מסך החסימה לקדמת המסך.
// בלי תוכנות מורשות מוגדרות אין טעם בבדיקת החלון הפעיל (חוסכת PowerShell).
async function maybeStealFocus() {
  if (manualLock) { focusBlockWindows(); return; } // נעילה ידנית — תמיד לחסום
  const appsOn = schedule.allowedAppsEnabled !== false && (schedule.allowedApps || []).length > 0;
  if (!appsOn) { focusBlockWindows(); return; }
  const fg = await getForegroundApp();
  if (await isAllowedApp(fg)) { enterRelaxed(); return; }
  focusBlockWindows();
}

// פתיחת תוכנת לימוד מותרת (מתוך מסך החסימה או בדיקה). לפני ההפעלה מבצעים
// אימות: חותם+מוצר לתוכנה חתומה, טביעת קובץ לתוכנה לא חתומה — כך אי אפשר
// להריץ במקומה קובץ שהוחלף. אם התוכנה כבר רצה — מעלים את החלון לחזית
// (לתוכנה חתומה: לפי שם התהליך, והאימות ממשיך בזמן אמת; ללא חתימה: רק לפי
// הנתיב המלא). ההפעלה המוצלחת מכניסה מיד למצב רפוי.
function launchAllowedApp(app) {
  return new Promise(async (resolve) => {
    const exe = String((app && app.exe) || '').trim();
    if (!exe) return resolve({ ok: false, error: 'התוכנה לא הוגדרה' });
    const isAbs = /^[a-zA-Z]:[\\/]/.test(exe) || /^\\\\/.test(exe);
    const base = path.basename(exe).replace(/\.exe$/i, '');
    const publisherMode = !!(app.mode === 'publisher' && app.publisher && app.product);

    // אימות הקובץ לפני הפעלה (אם הנתיב קיים)
    let startTarget = null;
    try {
      if (isAbs && fs.existsSync(exe)) {
        const info = await inspectAppFile(exe);
        if (publisherMode) {
          if (!info || info.status !== 'Valid' ||
              cnOf(info.subject).toLowerCase() !== String(app.publisher).toLowerCase() ||
              String(info.product || '').toLowerCase() !== String(app.product).toLowerCase()) {
            return resolve({ ok: false, error: 'התוכנה אינה תואמת את החותם המאומת — ייתכן שהוחלפה או עודכנה. בחרו אותה מחדש בהגדרות.' });
          }
        } else if (app.hash) {
          if (!info || !info.hash || info.hash !== String(app.hash).toLowerCase()) {
            return resolve({ ok: false, error: 'קובץ התוכנה שונה מהגרסה שאומתה — בחרו אותה מחדש בהגדרות.' });
          }
        }
        startTarget = exe;
      } else if (publisherMode) {
        // נתיב ההתקנה לא נמצא (למשל אחרי עדכון תוכנה) — פתיחה לפי שם דרך
        // App Paths; האימות המלא נעשה בזמן אמת כשהתוכנה הופכת לפעילה.
        startTarget = base;
      } else {
        return resolve({ ok: false, error: 'קובץ התוכנה לא נמצא — בחרו אותה מחדש בהגדרות.' });
      }
    } catch {
      return resolve({ ok: false, error: 'אימות התוכנה נכשל — נסו שוב.' });
    }

    // העלאה לחזית אם כבר רצה, אחרת פתיחה. לתוכנה חתומה מזהים לפי שם התהליך
    // (גם בנתיב מעודכן); לתוכנה לא חתומה — רק לפי הנתיב המלא המדויק.
    const matchCond = publisherMode
      ? '($_.ProcessName -ieq ' + JSON.stringify(base) + ' -or $_.Path -ieq ' + JSON.stringify(exe) + ')'
      : '($_.Path -ieq ' + JSON.stringify(exe) + ')';
    const script =
      "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);' -Name U -Namespace W; " +
      'try { $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ' + matchCond + ' } | Select-Object -First 1; ' +
      'if ($p) { [W.U]::SetForegroundWindow($p.MainWindowHandle) } else { Start-Process -FilePath ' + JSON.stringify(startTarget) + ' } } catch { Write-Error $_; exit 1 }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 15000 }, (err) => {
      if (err) return resolve({ ok: false, error: 'לא ניתן להפעיל את התוכנה — בדקו שהיא מותקנת במקום הנכון' });
      if (!manualLock) enterRelaxed();
      resolve({ ok: true });
    });
  });
}

/* ================= לולאת האכיפה ================= */

function buildStatus() {
  const st = S.getStatus(schedule, trustedDate());
  return {
    ...st,
    now: trustedNow(),
    manualLock: manualLock,
    theme: resolvedTheme(),
    blockMessage: schedule.blockMessage,
    stateLabel: st.state === 'blocked' ? 'חסום' : st.state === 'netblock' ? 'האינטרנט חסום' : 'מותר',
    nextLabel: st.next === 'blocked' ? 'חסום' : st.next === 'netblock' ? 'האינטרנט ייחסם' : st.next === 'allowed' ? 'מותר' : null,
    nextAtLabel: st.nextAt ? S.formatDate(st.nextAt) : null,
    secondsUntilLabel: st.secondsUntilNext != null ? S.formatDuration(st.secondsUntilNext) : null,
    pinSet: !!schedule.pinHash,
    netBlockFailed: netBlockFailed,
    blockBg: schedule.blockBg,
    showTorahQuotes: schedule.showTorahQuotes !== false,
    allowedAppsEnabled: schedule.allowedAppsEnabled !== false,
    // למסך החסימה מועברות רק תוכנות עם נתיב מלא תקין (אחרת לא ניתן לפתוח
    // אותן ולא ניתן לאמת אותן) — רשומות ישנות חסרות נתיב נשארות בהגדרות
    // עם סמן "בחרו מחדש" כדי שההורה יתקן אותן.
    allowedApps: (schedule.allowedApps || []).filter((a) =>
      /^[a-zA-Z]:[\\/]/.test(String(a.exe || '')) || /^\\\\/.test(String(a.exe || '')))
  };
}

// אזהרה לפני חסימה: כשהמחשב עדיין פתוח אבל עומד להיחסם בתוך warnMinutes —
// מציגים הודעה אחת בכניסה לחלון האזהרה שמזהירה לשמור קבצים ולסיים את העבודה.
function showWarningNotification(status) {
  try {
    const sec = status.warningSeconds != null ? status.warningSeconds : 0;
    const dur = S.formatDuration(sec);
    const net = status.next === 'netblock';
    const n = new Notification({
      title: net ? 'האינטרנט עומד להיחסם' : 'המחשב עומד להיחסם',
      body: net
        ? 'בעוד ' + dur + ' האינטרנט ייחסם — המחשב עצמו יישאר פתוח לשימוש כללי.'
        : 'בעוד ' + dur + ' המחשב ייחסם — שמרו את הקבצים וסיימו את העבודה.'
    });
    n.show();
  } catch { /* ignore */ }
}

// לולאת האכיפה — עם הגנה מפני ריצות חופפות: בדיקת התוכנה הפעילה רצה
// עם PowerShell (אסינכרוני), ולכן כל קריאה נוספת בזמן שהלולאה עסוקה רק
// מסומנת ומבוצעת מיד אחריה — כך החסימה לא "נפספסת" גם בעומס קריאות.
async function enforce() {
  if (enforceBusy) { enforceAgain = true; return; }
  enforceBusy = true;
  try {
    do {
      enforceAgain = false;
      await enforceCore();
    } while (enforceAgain);
  } finally {
    enforceBusy = false;
  }
}

async function enforceCore() {
  const status = buildStatus();
  // נעילה ידנית חלה תמיד — גם אם האכיפה לפי הלוח מושבתת
  const blocked = !!(manualLock || (schedule.enabled && status.state === 'blocked'));
  // חסימת אינטרנט בלבד — מחשב פתוח, רשת חסומה (לא במקביל לנעילה ידנית)
  const netblocked = !!(schedule.enabled && status.state === 'netblock' && !manualLock);

  // אזהרה לפני חסימה — פעם אחת בכניסה לחלון האזהרה, ולא בזמן נעילה ידנית.
  // ללא סיסמה החסימה אינה פעילה כלל (activeBlock = blocked && pinSet) —
  // לכן גם לא מציגים אזהרה על חסימה שלא תתרחש בפועל.
  if (status.warning && schedule.pinHash && !manualLock && !lastWarningActive) {
    lastWarningActive = true;
    logEvent('warning-start');
    showWarningNotification(status);
  } else if ((!status.warning || manualLock) && lastWarningActive) {
    lastWarningActive = false;
  }
  // ללא סיסמה מוגדרת (התקנה ראשונית) — החסימה אינה פעילה כלל, כדי שלעולם
  // לא יהיה מצב של חסימה בלי דרך החוצה. המשתמש מתבקש להגדיר סיסמה תחילה.
  const pinSet = !!schedule.pinHash;
  const activeBlock = blocked && pinSet;
  const activeNet = netblocked && pinSet;

  // תיעוד מעברים ביומן הפעילות (חסימת מחשב וחסימת אינטרנט בנפרד)
  if (blocked !== lastBlockedState) {
    logEvent(blocked ? 'block-start' : 'block-end');
    lastBlockedState = blocked;
  }
  if (netblocked !== lastNetActive) {
    logEvent(netblocked ? 'netblock-start' : 'netblock-end');
    lastNetActive = netblocked;
  }

  // חסימת האינטרנט — הפעלה/כיבוי של חוק חומת האש רק בשינוי מצב (לא כל 5
  // שניות), עם דיווח שגיאה חד-פעמי אם חומת האש אינה זמינה.
  if (activeNet && !netBlockApplied && !netBlockFailed) {
    netBlockSet(true).then((res) => {
      if (res.ok) {
        netBlockApplied = true;
      } else {
        netBlockFailed = true;
        if (!netBlockWarned) {
          netBlockWarned = true;
          logEvent('netblock-fail');
          if (win && !win.isDestroyed()) {
            win.webContents.send('netblock-error', res.error);
          }
        }
      }
      showNetIcon(activeNet && netBlockApplied);
    });
  } else if (!activeNet && netBlockApplied) {
    netBlockSet(false).then((res) => { if (res.ok) netBlockApplied = false; });
    showNetIcon(false);
  } else if (!activeNet) {
    // יציאה ממצב חסימה — מאפסים כדי שהחלון הבא ינסה מחדש
    netBlockFailed = false;
    netBlockWarned = false;
    showNetIcon(false);
  } else {
    showNetIcon(activeNet && netBlockApplied);
  }

  // עדכון מגש + חלון הגדרות
  if (tray) updateTray(status);
  if (win && !win.isDestroyed()) win.webContents.send('status', status);
  blockWins.forEach((bw) => { if (bw && !bw.isDestroyed()) bw.webContents.send('status', status); });

  if (!activeBlock) {
    manualLock = false;
    exitRelaxed();
    hideBlockWindows();
    unregisterBlockShortcuts();
    return;
  }

  // תוכנות תורניות מותרות: אם התוכנה שבחלון הפעיל נמצאת ברשימה המורשית —
  // מסתירים את מסך החסימה ומאפשרים להמשיך לעבוד איתה. נעילה ידנית תמיד
  // חוסמת הכל. ברגע שהתוכנה כבר לא פעילה (נסגרה או עברו לאחרת) — חוזרים
  // לחסימה מלאה בבדיקה הבאה. בלי תוכנות מורשות מוגדרות אין טעם בבדיקת
  // החלון הפעיל (חוסכת הפעלת PowerShell בכל בדיקה).
  const fgAllowed = (!manualLock && schedule.allowedAppsEnabled !== false && (schedule.allowedApps || []).length > 0)
    ? await isAllowedApp(await getForegroundApp())
    : false;
  if (fgAllowed) {
    enterRelaxed();
    return;
  }
  exitRelaxed();
  showBlockWindows(status);
  registerBlockShortcuts();
}

/* ================= מגש מערכת ================= */

function trayIcon() {
  const icon = path.join(__dirname, 'assets', 'icon.png');
  const img = nativeImage.createFromPath(icon);
  if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  return nativeImage.createEmpty();
}

function updateTray(status) {
  const color = (status.state === 'blocked' || status.manualLock) ? 'חסום' : status.state === 'netblock' ? 'האינטרנט חסום' : 'מותר';
  const warnTxt = status.warning
    ? (status.next === 'netblock' ? ' • האינטרנט ייחסם בקרוב' : ' • ייחסם בקרוב')
    : '';
  tray.setToolTip('בין הזמנים — מצב נוכחי: ' + color + warnTxt);
  const menu = Menu.buildFromTemplate([
    { label: 'בין הזמנים — ניהול זמן מחשב', enabled: false },
    { type: 'separator' },
    { label: 'מצב נוכחי: ' + color + warnTxt, enabled: false },
    {
      label: status.warning
        ? 'ייחסם בעוד ' + (status.secondsUntilLabel || 'רגע')
        : (status.secondsUntilLabel
          ? 'מעבר הבא בעוד ' + status.secondsUntilLabel
          : 'אין שינוי צפוי'),
      enabled: false
    },
    { type: 'separator' },
    { label: 'פתח הגדרות', click: () => showMainWindow() },
    {
      label: 'נעל עכשיו',
      click: () => { manualLock = true; enforce(); }
    },
    {
      label: 'בדוק עכשיו',
      click: () => enforce()
    },
    { type: 'separator' },
    { label: 'יציאה', click: () => showQuitPrompt() }
  ]);
  tray.setContextMenu(menu);
}

/* ================= יציאה עם אימות סיסמה =================
   כדי שילד לא יוכל לעקוף את החסימה בלחיצה על "יציאה" מתפריט המגש,
   היציאה דורשת סיסמת הורה. האימות מתבצע בתהליך הראשי (verifyPinServer)
   עם נעילה זמנית אחרי 5 ניסיונות שגויים — כמו בכל מקום אחר בתוכנה. */
function quitPromptOpen() {
  return !!(quitWin && !quitWin.isDestroyed());
}

function showQuitPrompt() {
  // ללא סיסמה מוגדרת — החסימה אינה פעילה בכל מקרה, יציאה חופשית (כמו במסך החסימה)
  if (!schedule.pinHash) { gracefulQuit(); return; }
  if (quitPromptOpen()) { quitWin.show(); quitWin.focus(); return; }
  quitWin = new BrowserWindow({
    width: 420,
    height: 360,
    frame: false, // ללא מסגרת חלון — נקי; הסגירה מתבצעת דרך "ביטול" או Escape
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    title: 'יציאה — בין הזמנים',
    backgroundColor: windowBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  quitWin.setAlwaysOnTop(true, 'screen-saver');
  quitWin.loadFile(path.join(__dirname, 'renderer', 'quit.html'));
  quitWin.on('closed', () => { quitWin = null; });
}

/* ================= חלון ראשי ================= */

function showMainWindow() {
  if (!win || win.isDestroyed()) createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// נעילת סשן ההגדרות: כשהחלון מוסתר (סגירה, מזעור או הסתרה) הכניסה להגדרות
// דורשת סיסמה מחדש. הנעילה מתאפסת את sessionUnlocked ומודיעה לממשק מיד,
// כך שגם פתיחה חוזרת דרך שורת המשימות, המגש או התראה תציג את מסך הכניסה
// (הממשק לא נטען מחדש בהסתרה — לכן חייבים להודיע לו במפורש).
function lockSession() {
  sessionUnlocked = false;
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('session-lock'); } catch { /* ignore */ }
  }
}

function createMainWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    title: 'בין הזמנים — ניהול זמן מחשב',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: windowBg(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // סגירה = מזעור למגש (אלא אם יוצאים באמת)
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      lockSession(); // נעילה מיידית — גם אם אירוע ה-hide לא יגיע
      win.hide();
    }
  });
  // כל הסתרה (סגירה ב-X, מזעור, app:hide) נועלת את הכניסה להגדרות —
  // הפתיחה מחדש משורת המשימות או מהמגש דורשת סיסמת הורה.
  win.on('hide', () => lockSession());
}

/* ================= הפעלה עם Windows (Registry + משימה מתוזמנת) ================= */

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_KEY_MACHINE = 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; // לכל המשתמשים
const RUN_NAME = 'BenHazmanim';
const TASK_NAME = 'BenHazmanim';
// משימה של שומר-השער המערכתי — רצה כ-SYSTEM מתוך העותק המוגן.
const GUARD_TASK_NAME = 'BenHazmanimGuard';

function startupValue() {
  const exe = process.execPath;
  const dir = app.getAppPath();
  return `"${exe}" "${dir}"`;
}

function setRegistry(enabled) {
  return new Promise((resolve) => {
    if (!isWin) return resolve({ ok: false, error: 'זמין רק בווינדוס' });
    if (enabled) {
      execFile('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', startupValue(), '/f'], (err) => {
        resolve(err ? { ok: false, error: err.message } : { ok: true });
      });
    } else {
      execFile('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'], () => resolve({ ok: true }));
    }
  });
}

// משימה מתוזמנת בעת כניסה — גיבוי ל-Registry, עמיד יותר למחיקה ידנית.
// /RL HIGHEST מרים את התוכנה עם הרשאות מנהל בכניסה — כך היא עולה מוקדם,
// לפני רוב התוכנות האחרות, ומשתמשת בהגדרות המשותפות של כל המשתמשים.
function setTask(enabled, highest) {
  return new Promise((resolve) => {
    if (!isWin) return resolve({ ok: false, error: 'זמין רק בווינדוס' });
    if (enabled) {
      execFile('schtasks',
        ['/Create', '/TN', TASK_NAME, '/TR', taskCommand(), '/SC', 'ONLOGON', '/RL', highest ? 'HIGHEST' : 'LIMITED', '/F'],
        (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
    } else {
      execFile('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], () => resolve({ ok: true }));
    }
  });
}

// רישום הפעלה עבור כל המשתמשים במחשב (HKLM Run) — כך שגם חשבון חדש
// שנוצר במחשב יריץ את התוכנה בכניסה וייחסם לפי אותו לוח זמנים.
function setRegistryMachine() {
  return new Promise((resolve) => {
    if (!isWin || !isElevated()) return resolve({ ok: false, error: 'נדרשת הרשאת מנהל' });
    execFile('reg', ['add', RUN_KEY_MACHINE, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', startupValue(), '/f'], (err) => {
      resolve(err ? { ok: false, error: err.message } : { ok: true });
    });
  });
}

/* ================= עותק מוגן (הגנה מפני מחיקת קבצי התוכנה) =================
   תיקיית ההתקנה המקורית נמצאת בפרופיל המשתמש (%LOCALAPPDATA%) — כך שמשתמש
   רגיל יכול למחוק אותה (למשל דרך Safe Mode). לכן, בהרצה עם הרשאות מנהל,
   התוכנה יוצרת עותק מלא של עצמה ב-%ProgramData%\BenHazmanim\app — מקום
   שמשתמש רגיל אינו יכול למחוק או לשנות (הרשאות NTFS נאכפות גם ב-Safe Mode).
   המשימה המתוזמנת (מנגנון ההפעלה המחייב) מצביעה על העותק המוגן, כך שגם אם
   מוחקים את תיקיית ההתקנה המקורית — האכיפה ממשיכה לעבוד בכניסה הבאה. */

// פקודת ההפעלה של המשימה המתוזמנת: העותק המוגן אם קיים, אחרת ההתקנה המקורית.
// (מקש ה-Run של המשתמש נשאר על ההתקנה המקורית — הוא נוחות בלבד; האכיפה
// המחייבת היא המשימה, והיא תמיד מצביעה על מקום שלא ניתן למחוק.)
function launchAppPath(dir) {
  const asar = path.join(dir, 'resources', 'app.asar');
  if (fs.existsSync(asar)) return asar;
  const unpacked = path.join(dir, 'resources', 'app');
  if (fs.existsSync(unpacked)) return unpacked;
  return dir;
}
function taskCommand() {
  const exe = path.join(protectedAppDir(), path.basename(process.execPath));
  if (isWin && fs.existsSync(exe)) return `"${exe}" "${launchAppPath(protectedAppDir())}"`;
  return startupValue();
}

// בגרסה ארוזה של Electron app.getAppPath() נמצא בתוך resources\\app.asar,
// אבל קובץ ההרצה נמצא בתיקיית האב של resources. העותק המוגן חייב לכלול את
// שני הדברים, אחרת מתקבלת תיקייה עם JavaScript בלבד ומשימה שאי אפשר להפעיל.
function installSourceDir() {
  const appPath = app.getAppPath();
  const execName = path.basename(process.execPath);
  if (fs.existsSync(path.join(appPath, execName))) return appPath; // סביבת בדיקה/פריסה לא-ארוזה
  const parent = path.dirname(appPath);
  if (path.basename(parent).toLowerCase() === 'resources') return path.dirname(parent);
  return appPath;
}
function packageJsonPath(dir) {
  const candidates = [
    path.join(dir, 'package.json'),
    path.join(dir, 'resources', 'app.asar', 'package.json'),
    path.join(dir, 'resources', 'app', 'package.json')
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}
function sourceExecutable(dir) {
  return path.join(dir, path.basename(process.execPath));
}
function isProtectedRuntime() {
  try { return path.resolve(installSourceDir()) === path.resolve(protectedAppDir()); } catch { return false; }
}
function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).version || '';
  } catch { return ''; }
}
function protectedVersion() {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath(protectedAppDir()), 'utf8')).version || '';
  } catch { return ''; }
}

// הרשאות העותק המוגן: בעלות של Administrators, קריאה/הרצה בלבד למשתמשים
// רגילים (ללא מחיקה וללא כתיבה). משתמשים ב-ALLOW בלבד (ולא DENY) כדי
// שהמתקין המוגבה יוכל להחליף קבצים בעדכון, והבעלות מועברת למנהלים כדי
// שמשתמש רגיל לא יוכל להחזיר לעצמו שליטה על התיקייה.
function runAclCommand(cmd, args) {
  return new Promise((resolve) => {
    try { execFile(cmd, args, () => resolve()); } catch { resolve(); }
  });
}
async function hardenMachineDir() {
  if (!isWin || !isElevated()) return;
  const dir = machineDir();
  const steps = [
    ['takeown', ['/f', dir, '/a']],
    ['icacls', [dir, '/inheritance:r', '/grant:r', '*S-1-5-32-545:(OI)(CI)RX', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '/grant:r', '*S-1-5-18:(OI)(CI)F', '/T', '/C']]
  ];
  for (const [cmd, args] of steps) await runAclCommand(cmd, args);
}

async function hardenProtectedCopy() {
  if (!isWin || !isElevated()) return;
  const dir = protectedAppDir();
  const steps = [
    ['takeown', ['/f', dir, '/a', '/r', '/d', 'y']],
    ['icacls', [dir, '/inheritance:r', '/grant:r', '*S-1-5-32-545:(OI)(CI)RX', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '/grant:r', '*S-1-5-18:(OI)(CI)F', '/T', '/C']]
  ];
  for (const [cmd, args] of steps) await runAclCommand(cmd, args);
}

// יצירה/רענון של העותק המוגן — רק בהרצה מוגבהת ורק כשהגרסה השתנתה.
async function ensureProtectedCopy() {
  if (!isWin || !isElevated()) return false;
  const dst = protectedAppDir();
  const src = installSourceDir();
  try {
    // כשהמשימה כבר מריצה את העותק המוגן — אסור להעתיק אותו לעצמו או
    // לדרוס את install.json עם הנתיב המוגן במקום הנתיב המקורי.
    if (isProtectedRuntime()) return fs.existsSync(sourceExecutable(dst));
    if (!fs.existsSync(sourceExecutable(src))) return false;
    if (fs.existsSync(sourceExecutable(dst)) && appVersion() && appVersion() === protectedVersion()) {
      await hardenMachineDir();
      await hardenProtectedCopy();
      writeProtectedSettingsBackup();
      saveInstallInfo();
      return true; // העותק עדכני — אין צורך להעתיק שוב
    }
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    // מעתיקים את כל שורש ההתקנה, כולל exe + resources\\app.asar.
    fs.cpSync(src, dst, { recursive: true });
    if (!fs.existsSync(sourceExecutable(dst))) throw new Error('קובץ ההרצה לא הועתק');
    await hardenMachineDir();
    await hardenProtectedCopy();
    writeProtectedSettingsBackup();
    saveInstallInfo();
    return true;
  } catch (err) {
    console.error('יצירת העותק המוגן נכשלה', err);
    return false;
  }
}

// מיקום תיקיית ההתקנה המקורית נשמר בקובץ קטן אצל "כל המשתמשים" — כך
// ששומר-השער המערכתי יודע לאן לשחזר קבצים שנמחקו, גם כשהוא רץ כ-SYSTEM.
function saveInstallInfo() {
  try {
    // תהליך שהופעל מהעותק המוגן חייב לשמור על נתיב ההתקנה המקורי.
    if (isProtectedRuntime()) {
      const existing = installInfo();
      if (existing && existing.dir && path.resolve(existing.dir) !== path.resolve(protectedAppDir())) return;
      return;
    }
    const dir = installSourceDir();
    fs.mkdirSync(machineDir(), { recursive: true });
    fs.writeFileSync(
      path.join(machineDir(), 'install.json'),
      JSON.stringify({ exe: sourceExecutable(dir), dir }),
      'utf8'
    );
  } catch { /* ignore */ }
}
function installInfo() {
  try { return JSON.parse(fs.readFileSync(path.join(machineDir(), 'install.json'), 'utf8')); } catch { return null; }
}

async function setStartup(enabled) {
  // ה-Registry הוא המנגנון המחייב; המשימה המתוזמנת היא גיבוי נוסף בלבד
  const a = await setRegistry(enabled);
  if (!a.ok) return { ok: false, error: a.error };
  const b = await setTask(enabled, false);
  return { ok: true, warning: b.ok ? null : (b.error || 'המשימה המתוזמנת נכשלה (ה-Registry פעיל)') };
}

// התאמת ההפעלה עם Windows למצב הרצה כמנהל:
// במצב הרשאות מנהל — משימה מתוזמנת ברמת HIGHEST (רצה מוגבהת בכניסה בלי UAC),
// וה-Registry מוסר כדי לא לפתוח את התוכנה פעמיים (פעם מוגבהת ופעם לא).
function taskExists() {
  return new Promise((resolve) => {
    execFile('schtasks', ['/Query', '/TN', TASK_NAME], (err) => resolve(!err));
  });
}

const taskXmlFile = () => path.join(machineDir(), 'main-task.xml');
function snapshotMainTask() {
  if (!isWin || !isElevated()) return;
  execFile('schtasks', ['/Query', '/TN', TASK_NAME, '/XML'], (err, stdout) => {
    if (err || !stdout) return;
    try {
      fs.mkdirSync(machineDir(), { recursive: true });
      fs.writeFileSync(taskXmlFile(), String(stdout), 'utf8');
    } catch { /* ignore */ }
  });
}

async function syncStartup() {
  // ההפעלה עם Windows תמיד פעילה: Registry (למשתמש הנוכחי) + משימה מתוזמנת
  // בעלת הרשאות גבוהות כדי שהתוכנה תעלה מוקדם בכניסה, + רישום לכל המשתמשים.
  // בהרצה מוגבהת — גם יצירת/רענון העותק המוגן, שהמשימה מצביעה עליו.
  await ensureProtectedCopy();
  const a = await setRegistry(true);
  if (!a.ok) return { ok: false, error: a.error };
  const warnings = [];
  // משימה ברמת HIGHEST — עולה מוקדם בכניסה (יצירתה דורשת מנהל).
  // נופלים חזרה לרמה רגילה רק אם אין משימה קיימת כלל — כדי לא להוריד
  // משימה קיימת ברמה גבוהה להרשאות נמוכות בהרצה לא-מוגבהת.
  let b = await setTask(true, true);
  if (!b.ok) {
    const exists = await taskExists();
    if (!exists) b = await setTask(true, false);
  }
  if (!b.ok) warnings.push(b.error || 'המשימה המתוזמנת נכשלה (ה-Registry פעיל)');
  if (isElevated()) snapshotMainTask();
  // רישום לכל המשתמשים — כך שכל חשבון במחשב מוגן
  if (isElevated()) {
    const m = await setRegistryMachine();
    if (!m.ok) warnings.push('רישום לכל המשתמשים נכשל: ' + m.error);
  }
  // שומר-שער מערכתי — משימה בעת אתחול (כ-SYSTEM, מתוך העותק המוגן).
  // הקפצה מיידית שלו אחרי עדכון/התקנה, כדי שיחזור לפעול מיד ולא רק באתחול.
  if (isElevated() && fs.existsSync(sourceExecutable(protectedAppDir()))) {
    const g = await setGuardTask(true);
    if (!g.ok) warnings.push('משימת שומר-השער המערכתי נכשלה: ' + g.error);
    else execFile('schtasks', ['/Run', '/TN', GUARD_TASK_NAME], () => { /* ignore */ });
  }
  return { ok: true, warning: warnings.length ? warnings.join(' | ') : null };
}

// חסימת יצירת חשבונות חדשים במחשב: מסתירה את דף "חשבונות" בהגדרות Windows,
// שהיא הדרך הרגילה להוסיף משתמש/חשבון חדש. (יצירת חשבון דורשת הרשאות מנהל
// בכל מקרה — הגדרה זו מונעת גם אותה בדרך הרגילה.)
async function applyAccountPolicies() {
  if (!isWin || !isElevated()) return;
  await new Promise((resolve) => {
    execFile('reg', ['add', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer', '/v', 'SettingsPageVisibility', '/t', 'REG_SZ', '/d', 'hide:accounts', '/f'], () => resolve());
  });
}

function getStartupStatus() {
  return new Promise((resolve) => {
    if (!isWin) return resolve(false);
    execFile('reg', ['query', RUN_KEY, '/v', RUN_NAME], (err) => {
      if (!err) return resolve(true);
      execFile('schtasks', ['/Query', '/TN', TASK_NAME], (err2) => resolve(!err2));
    });
  });
}

/* ================= הסרת התוכנה =================
   ההסרה מתבצעת מהתוכנה עצמה (עם סיסמת הורה) כדי שהמשתמש לא יוכל
   לעקוף את החסימה על ידי מחיקת התוכנה. התהליך:
   1) כתיבת דגל עצירה + הרג כלב השמירה — כדי שלא יקפיץ את התוכנה בחזרה.
   2) הסרת רישומי ההפעלה עם Windows (Registry + משימה מתוזמנת).
   3) הפעלת ה-Uninstaller של NSIS בשקט (מסיר את קבצי התוכנה והקיצורים).
   4) סגירה נקייה של התוכנה — וה-Uninstaller ממשיך לבד.
   מחיקת קבצי ההגדרות נעשית על ידי ה-Uninstaller עצמו (ראה build/installer.nsh
   וההגדרה deleteAppDataOnUninstall ב-package.json). */

// הסרת רישומי ההפעלה עם Windows — בסדר דרגי כדי לא לאבד רישומים שנמחקו כבר.
function removeStartupEntries() {
  return new Promise((resolve) => {
    if (!isWin) return resolve();
    execFile('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'], () => {
      execFile('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], () => {
        execFile('schtasks', ['/Delete', '/TN', GUARD_TASK_NAME, '/F'], () => {
          if (!isElevated()) return resolve();
          // רישומים ברמת כל המשתמשים — זמינים רק עם הרשאות מנהל
          execFile('reg', ['delete', RUN_KEY_MACHINE, '/v', RUN_NAME, '/f'], () => {
            // ביטול מדיניות ההסתרה של דף "חשבונות" (הוגדרה בעת ההתקנה)
            execFile('reg', ['delete', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer', '/v', 'SettingsPageVisibility', '/f'], resolve);
          });
        });
      });
    });
  });
}

// איתור ה-Uninstaller של NSIS — קודם כקובץ "Uninstall ..." לצד קובץ התוכנה
// (המיקום שבו electron-builder תמיד מניח אותו, עם נתיב Unicode אמין),
// ורק אחר כך דרך רישום מרכז התוכניות (פלט reg query הוא ANSI — עלול
// להשחית תווים עבריים בנתיב, ולכן הוא רק רשת ביטחון נוספת).
function findUninstaller() {
  const candidates = [];
  try {
    const dir = path.dirname(process.execPath);
    for (const name of fs.readdirSync(dir)) {
      if (/^Uninstall .*\.exe$/i.test(name)) candidates.push(path.join(dir, name));
    }
  } catch { /* ignore */ }
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.levtov.benhazmanim';
    const out = execFileSync('reg', ['query', key, '/v', 'UninstallString'], { encoding: 'utf8', windowsHide: true });
    const m = out.match(/([A-Za-z]:\\(?:[^"\r\n]*\))*[^"\r\n]*?\.exe)/);
    if (m) candidates.push(m[1]);
  } catch { /* המפתח אינו קיים */ }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/* ================= שחזור סיסמה למייל (Google Apps Script) ================= */

// כתובת קבועה של אפליקציית השחזור — כל הבקשות נשלחות לשרת זה בלבד.
// לב טוב דיגיטל — https://digital.levtov.uk/
const RECOVERY_URL = 'https://script.google.com/macros/s/AKfycbzn0E8JIRLsmJqlYXQMoqpNSqAKALUDbgdcxwBT2zn_1ZqZEpYCZ2pyBeNYyb2rfuvyGQ/exec';

// המפתח הסודי המשותף עם הסקריפט (SECRET_KEY).
// נטען מקובץ מקומי בלבד (secret.local.js) שאינו עולה לגיטהאב — כך
// שהקוד הציבורי אינו חושף את הסוד. לפני בניית ה-EXE ודאו שהקובץ קיים
// (הוא נכלל בהתקנה דרך רשימת files ב-package.json).
let RECOVERY_SECRET = '';
try {
  const local = require('./secret.local.js');
  if (local && typeof local.secret === 'string' && local.secret) {
    RECOVERY_SECRET = local.secret;
  }
} catch {
  /* אין קובץ מקומי — השחזור מושבת עם הודעת שגיאה ברורה */
}

// מקור העדכונים — URL לקובץ JSON עם גרסה. נקבע כאן בקוד בלבד
// (אין שדה בממשק) — הכפתור "בדוק עדכונים" משתמש בכתובת זו.
// הקובץ version.json מתגורר במאגר הגיטהאב הציבורי, וכל שינוי בו
// (גרסה חדשה) יימצא מיד על ידי כל העותקים המותקנים של התוכנה.
const UPDATE_URL = 'https://raw.githubusercontent.com/Lev-Good/Between-times/main/version.json';

async function sendRecovery() {
  const email = schedule.recoveryEmail;
  if (!email) return { ok: false, error: 'לא הוגדר מייל שחזור בהגדרות' };
  if (!RECOVERY_SECRET) return { ok: false, error: 'המפתח הסודי לא הוגדר בתוכנה (RECOVERY_SECRET ב-main.js)' };
  const password = decryptPassword(schedule.passwordEnc);
  if (!password) return { ok: false, error: 'לא הוגדרה סיסמה' };
  try {
    const res = await fetch(RECOVERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // המפתח הסודי מוגדר על ידי המפתח בלבד — דרך הקבוע RECOVERY_SECRET בקוד
        // (למשתמשים רגילים אין שדה להגדרה בממשק, כדי לשמור עליו חסוי).
        secret: RECOVERY_SECRET,
        email,
        password,
        app: 'BenHazmanim',
        time: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true) {
      // תרגום שגיאות ידועות מהשרת להודעה ברורה בעברית
      const raw = String(data.error || '');
      const msg = recoveryErrorToHebrew(raw);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'נדרשת גישה לאינטרנט לשחזור הסיסמה' };
  }
}

// תרגום שגיאות ידועות של שרת השחזור להודעה ברורה בעברית.
// "secret invalid" נגרם כשהמפתח הסודי בסקריפט הפרוס (SECRET_KEY)
// אינו תואם למפתח שמוגדר בתוכנה (secret.local.js).
function recoveryErrorToHebrew(raw) {
  const s = String(raw || '');
  if (/secret invalid/i.test(s)) {
    return 'השרת דחה את הבקשה (secret invalid) — המפתח הסודי ששולחת התוכנה אינו תואם למפתח שבשרת השחזור. בדקו: (1) שהגרסה המותקנת היא העדכנית ביותר (גרסה ישנה שולחת מפתח ישן — עדכנו את התוכנה); (2) ש-SECRET_KEY בסקריפט הפרוס (gas/PasswordRecovery.gs) זהה בדיוק למפתח ב-secret.local.js, ופרסו מחדש.';
  }
  if (/missing fields/i.test(s)) {
    return 'חסרים פרטים בבקשה — ודאו שמוגדרים מייל שחזור וסיסמה';
  }
  if (s) return 'שירות השחזור החזיר שגיאה: ' + s;
  return 'שירות השחזור החזיר שגיאה';
}

/* ================= בדיקת עדכונים ================= */

// שמירת ההודעה במודול: בלי התייחסות פעילה האובייקט עלול להיאסף לאשפה (GC),
// ואז אירוע הלחיצה לא מגיע אלינו כשהמשתמש לוחץ על ההודעה — מצב תיעודי בווינדוס.
let updateNotification = null;
let lastOpenedUpdateUrl = null;
let lastOpenedUpdateAt = 0;

// פתיחת דף ההורדה מההודעה: קודם מנסים את הדפדפן; אם זה נכשל — פותחים את
// חלון התוכנה שבו יש באנר עדכון עם כפתור הורדה (רשת ביטחון).
function openUpdatePage(note) {
  const url = (note && note.url && /^https?:\/\//.test(note.url)) ? note.url : null;
  if (!url) {
    // אין כתובת (למשל לחיצה על הודעה ישנה אחרי הפעלה מחדש) — לפחות לפתוח את התוכנה
    if (win && !win.isDestroyed()) showMainWindow();
    return;
  }
  // הגנה מפני פתיחה כפולה (כמה הודעות עדכון באותו URL או אירוע OS כפול)
  // — לוודא שהדפדפן נפתח פעם אחת בלבד.
  const now = Date.now();
  if (url === lastOpenedUpdateUrl && now - lastOpenedUpdateAt < 4000) return;
  lastOpenedUpdateUrl = url;
  lastOpenedUpdateAt = now;
  try {
    shell.openExternal(url).catch(() => { if (win && !win.isDestroyed()) showMainWindow(); });
  } catch {
    if (win && !win.isDestroyed()) showMainWindow();
  }
}

function isNewerVersion(remote, current) {
  const r = String(remote).split('.').map(Number);
  const c = String(current).split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    const a = r[i] || 0;
    const b = c[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

function notifyUpdate(note) {
  if (win && !win.isDestroyed()) win.webContents.send('update', note);
  blockWins.forEach((bw) => { if (bw && !bw.isDestroyed()) bw.webContents.send('update', note); });
  try {
    updateNotification = new Notification({
      title: 'עדכון זמין — בין הזמנים',
      body: 'גרסה ' + note.version + ' זמינה להורדה' + (note.url ? ' — לחצו על ההודעה כדי לפתוח את דף ההורדה' : '')
    });
    // לחיצה על ההודעה פותחת את דף ההורדה בדפדפן
    updateNotification.on('click', () => openUpdatePage(note));
    updateNotification.show();
  } catch { /* ignore */ }
}

async function checkForUpdate() {
  // מקור העדכונים מוגדר על ידי המפתח בלבד — דרך הקבוע UPDATE_URL בקוד
  // (למשתמשים רגילים אין שדה להגדרה בממשק, כדי למנוע שגיאות ובלבול).
  const url = UPDATE_URL;
  if (!url) return { ok: false, error: 'לא הוגדר מקור עדכונים', update: null };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json().catch(() => ({}));
    const remote = String(data.version || '');
    if (!remote || !isNewerVersion(remote, app.getVersion())) {
      return { ok: true, update: null };
    }
    const note = { version: remote, url: data.url || '', notes: data.notes || '' };
    updateNote = note;
    notifyUpdate(note);
    return { ok: true, update: note };
  } catch {
    return { ok: false, error: 'לא ניתן לבדוק עדכונים (אופליין?)', update: null };
  }
}

/* ================= הורדה והתקנה אוטומטית של עדכון =================
   במקום לפתוח את דף ההורדה בדפדפן — "הורד והתקן עכשיו" מוריד את
   המתקין ישירות לתיקיית Temp, מוודא שהקובץ תקין (EXE בגודל סביר),
   כותב דגל עצירה (כדי שהשומר-שער לא יקפיץ את התוכנה בחזרה בזמן
   ההתקנה), מפעיל את המתקין בשקט (/S) וסוגר את התוכנה — והמתקין
   משלים את ההתקנה לבד ופותח את הגרסה החדשה. */

const GITHUB_REPO = 'Lev-Good/Between-times';
const GITHUB_REPO_URL = 'https://github.com/' + GITHUB_REPO;

// איתור כתובת ההורדה הישירה של קובץ ההתקנה לגרסה נתונה.
// קודם דרך GitHub API (השם המדויק של הקובץ), ואם זה נכשל — נופלים
// לכתובת הקונבנציונלית "/releases/latest/download/Setup.<version>.exe".
async function resolveInstallerUrl(version) {
  try {
    const res = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/releases/tags/v' + version, {
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      const asset = (data.assets || []).find((a) => /^(Setup|.*Setup)[^"]*\.exe$/i.test(a.name));
      if (asset && asset.browser_download_url) return asset.browser_download_url;
    }
  } catch { /* נופלים לכתובת הקונבנציונלית */ }
  return GITHUB_REPO_URL + '/releases/latest/download/Setup.' + version + '.exe';
}

// הורדת קובץ לנתיב מקומי עם דיווח התקדמות (אחוזים) — סטרימינג מ-fetch.
// הכתיבה לדיסק היא סינכרונית (fd) כדי שהיא תהיה דטרמיניסטית: בכשלון
// באמצע ההורדה הקובץ החלקי נמחק מיד ואין דליפת handle או אירועי שגיאה
// א-סינכרוניים (שגיאות write א-סינכרוניות קשות לעקוב אחריהן ב-Windows).
async function downloadInstaller(url, dest, onProgress) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok) throw new Error('ההורדה נכשלה (HTTP ' + res.status + ')');
  if (!res.body) throw new Error('ההורדה נכשלה (אין תוכן)');
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const fd = fs.openSync(dest, 'w');
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(fd, Buffer.from(value));
      received += value.length;
      if (onProgress && total) onProgress(Math.round((received / total) * 100));
    }
    fs.closeSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(dest); } catch { /* ignore */ } // ניקוי הקובץ החלקי
    throw err;
  }
  return received;
}

// הורדה + התקנה שקטה של העדכון. נקרא מהממשק (update:download) — עם
// דיווח התקדמות לכל החלונות, וסגירה נקייה של התוכנה בסוף.
async function downloadAndInstallUpdate() {
  if (!updateNote) {
    const chk = await checkForUpdate();
    if (!chk.ok || !chk.update) {
      return { ok: false, error: (chk && chk.error) || 'אין עדכון זמין' };
    }
  }
  const version = updateNote.version;
  const dest = path.join(app.getPath('temp'), 'BenHazmanim-Setup-' + version + '.exe');
  const progress = (phase, percent) => {
    const payload = { phase, version, percent };
    [win, ...blockWins].forEach((w) => {
      if (w && !w.isDestroyed()) w.webContents.send('update-progress', payload);
    });
  };
  try {
    const url = await resolveInstallerUrl(version);
    // רק מקבצים של המאגר הרשמי שלנו — הגנה מפני כתובות זדוניות
    if (!/^https:\/\/github\.com\/Lev-Good\/Between-times\//.test(url)) {
      return { ok: false, error: 'מקור ההורדה אינו תקין' };
    }
    progress('download', 0);
    const size = await downloadInstaller(url, dest, (p) => progress('download', p));
    // בדיקות תקינות: גודל סביר (המתקין בפועל ~90MB) + חותמת PE (MZ) —
    // כך לא מריצים קובץ שגוי (דף 404, הורדה קטועה או קובץ שאינו EXE)
    const mz = fs.readFileSync(dest).subarray(0, 2).toString('ascii');
    if (size < 1024 * 1024 || mz !== 'MZ') {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      return { ok: false, error: 'הקובץ שהורד אינו תקין — נסו שוב או הורידו ידנית מהאתר' };
    }
    progress('install', 100);
    // דגל עצירה בכל הנתיבים — השומר-שער לא יקפיץ את התוכנה בזמן ההתקנה.
    // המתקין החדש (1.2.4+) גם הוא כותב את הדגל ב-preInit וממתין לסגירתנו.
    writeQuitFlag();
    // דגל "הפעל מחדש": ההתקנה השקטה (/S) לא מריצה את התוכנה מעצמה —
    // המתקין יבדוק את הדגל הזה בסוף ההתקנה ויפתח את הגרסה החדשה.
    writeRelaunchFlag();
    const child = spawn(dest, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* ignore */ });
    child.unref();
    // סגירה נקייה — המתקין משלים את ההתקנה לבד ופותח את הגרסה החדשה
    gracefulQuit();
    return { ok: true, installing: true };
  } catch (e) {
    return { ok: false, error: e.message || 'ההורדה נכשלה — בדקו את החיבור לאינטרנט' };
  }
}

/* ================= IPC ================= */

function registerIpc() {
  ipcMain.handle('settings:get', () => {
    // passwordPlain/passwordEnc לא מועברים לממשק — נדרשים רק בתהליך הראשי לשחזור
    const safe = { ...schedule };
    delete safe.pinHash;
    delete safe.passwordPlain;
    delete safe.passwordEnc;
    return {
      ...safe,
      pinSet: !!schedule.pinHash,
      sessionUnlocked: schedule.pinHash ? sessionUnlocked : true
    };
  });

  ipcMain.handle('settings:save', (_e, data) => {
    // אימות סיסמה בצד השרת — לא להסתמך על אימות קליינט בלבד
    if (schedule.pinHash && !sessionUnlocked) {
      return { ok: false, error: 'נדרשת סיסמה כדי לשנות הגדרות' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'מבנה הגדרות לא תקין' };
    }
    // סיסמה, סוד שחזור, פתיחה ידנית והרצה כמנהל לא ניתנים לשינוי דרך שמירה רגילה
    if (data && typeof data === 'object') {
      data.pinHash = schedule.pinHash;
      data.passwordPlain = schedule.passwordPlain;
      data.passwordEnc = schedule.passwordEnc;
      data.manualUnlockUntil = schedule.manualUnlockUntil;
      data.runAsAdmin = schedule.runAsAdmin;
    }
    schedule = S.normalizeSchedule(data);
    const res = saveSettings();
    logEvent('settings');
    enforce();
    return res.ok ? { ok: true, warning: res.warning || null } : { ok: false, error: res.error || 'שמירה נכשלה' };
  });

  ipcMain.handle('status:get', () => buildStatus());

  // שינוי רקע מסך החסימה — מתוך מסך החסימה עצמו (כפתור "רקע").
  // שינוי קוסמטי בלבד — אינו דורש סיסמה, והמשתמש יכול לבחור את הרקע
  // שמעניין אותו בזמן החסימה. השמירה מתבצעת בהגדרות המשותפות.
  ipcMain.handle('block:set-bg', (_e, bg) => {
    const valid = ['blobs', 'fluid', 'particles', 'aurora'];
    const b = String(bg || '');
    if (!valid.includes(b)) return { ok: false, error: 'רקע לא ידוע' };
    schedule.blockBg = b;
    saveSettings();
    enforce(); // מפיץ את הסטטוס החדש (עם blockBg) לכל חלונות החסימה
    return { ok: true };
  });

  // בחירת תוכנת לימוד מהמחשב — בורר קבצים (.exe). מיד בוחרים את הקובץ נבדק:
  // חותם דיגיטלי (מצב + מוציא לאור), שם מוצר וטביעת SHA-256 — כדי לקבוע את
  // מצב האימות (publisher לתוכנה חתומה, path+hash לתוכנה לא חתומה).
  ipcMain.handle('allowed-apps:pick', async () => {
    if (!isWin) return { ok: false, error: 'זמין רק בווינדוס' };
    const opts = {
      title: 'בחירת תוכנת לימוד תורנית',
      filters: [{ name: 'תוכניות', extensions: ['exe'] }],
      properties: ['openFile']
    };
    const res = (win && !win.isDestroyed())
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
    const p = res.filePaths[0];
    const name = path.basename(p).replace(/\.exe$/i, '');
    const info = await inspectAppFile(p);
    const publisher = (info && info.status === 'Valid' && cnOf(info.subject)) ? cnOf(info.subject) : '';
    const product = (publisher && info && info.product) ? info.product : '';
    return {
      canceled: false,
      path: p,
      name,
      mode: (publisher && product) ? 'publisher' : 'path',
      publisher,
      product,
      hash: (info && info.hash) || ''
    };
  });

  // פתיחת תוכנת לימוד מותרת מתוך מסך החסימה: אם היא כבר רצה — החלון שלה
  // מועלה לחזית (ולא נפתח עותק נוסף); אחרת היא נפתחת מחדש.
  ipcMain.handle('allowed-apps:launch', (_e, app) => launchAllowedApp(app));

  ipcMain.handle('lock:now', () => {
    // נעילה ידנית: מפעילה את מסך החסימה המלא של בין הזמנים על כל המסכים
    // (ולא רק את נעילת Windows הרגילה). הפתיחה מתבצעת עם סיסמה.
    if (!schedule.pinHash) {
      return { ok: false, error: 'לא הוגדרה סיסמה — הגדירו סיסמה בהגדרות לפני נעילה ידנית' };
    }
    manualLock = true;
    enforce();
    logEvent('lock-manual');
    return { ok: true };
  });

  ipcMain.handle('unlock:now', (_e, pin) => {
    // ללא סיסמה מוגדרת אין מה לאמת — הפתיחה מתאפשרת תמיד, כדי שלעולם לא
    // יהיה מצב של חסימה בלי דרך החוצה (גם אם חלון חסימה נפתח בהיעדר סיסמה).
    if (!schedule.pinHash) {
      manualLock = false;
      const st = S.getStatus(schedule, trustedDate());
      schedule.manualUnlockUntil = isLockedState(st)
        ? (st.nextAt ? st.nextAt.getTime() : trustedNow() + 3600 * 1000)
        : null;
      saveSettings();
      enforce();
      return { ok: true };
    }
    const v = verifyPinServer(pin);
    if (!v.ok) {
      logEvent('unlock-fail');
      return { ok: false, error: v.error, locked: v.locked || 0 };
    }
    logEvent('unlock-success');
    manualLock = false; // סיום נעילה ידנית
    const st = S.getStatus(schedule, trustedDate());
    // "פתוח עד המעבר הבא" נשמר רק כשהמצב לפי הלוח הוא חסום (מחשב או
    // אינטרנט) — אחרת אין צורך.
    schedule.manualUnlockUntil = isLockedState(st)
      ? (st.nextAt ? st.nextAt.getTime() : trustedNow() + 3600 * 1000)
      : null;
    saveSettings();
    enforce();
    return { ok: true };
  });

  ipcMain.handle('pin:set', (_e, pin, oldPin) => {
    const newPin = String(pin || '');
    if (!S.isValidPassword(newPin)) return { ok: false, error: 'הסיסמה צריכה להיות 4-20 תווים ללא רווחים' };
    if (schedule.pinHash) {
      const v = verifyPinServer(oldPin);
      if (!v.ok) return { ok: false, error: v.error };
    }
    schedule.pinHash = S.sha256Hex(newPin);
    schedule.passwordPlain = null;
    schedule.passwordEnc = encryptPassword(newPin); // מוצפן — לצורך שחזור למייל בלבד
    saveSettings();
    return { ok: true };
  });

  ipcMain.handle('pin:clear', (_e, oldPin) => {
    if (schedule.pinHash) {
      const v = verifyPinServer(oldPin);
      if (!v.ok) return { ok: false, error: v.error };
    }
    schedule.pinHash = null;
    schedule.passwordPlain = null;
    schedule.passwordEnc = null;
    saveSettings();
    return { ok: true };
  });

  ipcMain.handle('pin:verify', (_e, pin) => {
    return verifyPinServer(pin);
  });

  ipcMain.handle('session:get', () => ({
    unlocked: schedule.pinHash ? sessionUnlocked : true
  }));

  ipcMain.handle('session:unlock', (_e, pin) => {
    if (!schedule.pinHash) return { ok: true, unlocked: true };
    const v = verifyPinServer(pin);
    if (!v.ok) return { ok: false, unlocked: false, error: v.error, locked: v.locked || 0 };
    sessionUnlocked = true;
    return { ok: true, unlocked: true };
  });

  // נעילה מצד הממשק (למשל כשהחלון עבר לרקע): מחזירה את כל הפעולות
  // הרגישות (שמירת הגדרות, יציאה, הסרה) למצב הדורש סיסמה.
  ipcMain.handle('session:lock', () => {
    sessionUnlocked = false;
    return { ok: true };
  });

  ipcMain.handle('recovery:send', () => sendRecovery());

  ipcMain.handle('update:check', () => checkForUpdate());

  ipcMain.handle('update:download', () => {
    if (schedule.pinHash && !sessionUnlocked) return Promise.resolve({ ok: false, error: 'נדרשת סיסמה כדי להתקין עדכון' });
    return downloadAndInstallUpdate();
  });

  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('app:quit', (_e, pin) => {
    // יציאה דורשת אימות סיסמה בתהליך הראשי — מניעת עקיפת חסימה על ידי ילדים
    if (schedule.pinHash) {
      const v = verifyPinServer(pin);
      if (!v.ok) return { ok: false, error: v.error };
    }
    gracefulQuit();
    return { ok: true };
  });

  ipcMain.handle('app:uninstall', async (_e, pin) => {
    // הסרת התוכנה דורשת סיסמת הורה — כמו כל פעולה רגישה
    if (schedule.pinHash) {
      const v = verifyPinServer(pin);
      if (!v.ok) return { ok: false, error: v.error };
    }
    if (!isWin) return { ok: false, error: 'ההסרה זמינה רק בווינדוס' };
    // מתקין ההסרה חייב להיות קיים — אחרת לא נמחק כלום
    const uninstaller = findUninstaller();
    if (!uninstaller) {
      return { ok: false, error: 'לא נמצא מתקין ההסרה — הסירו את התוכנה דרך "התקן והסר תוכניות" בלוח הבקרה' };
    }
    // דגל עצירה לשומר-השער המערכתי (רץ כ-SYSTEM) — כדי שלא ישחזר
    // קבצים ומשימות בזמן שה-Uninstaller מסיר אותם. נכתב במיקום המשותף
    // שהוא בודק, לפני שמתחילה ההסרה בפועל.
    try {
      fs.mkdirSync(machineDir(), { recursive: true });
      fs.writeFileSync(machineQuitFlag(), String(Date.now()));
    } catch { /* ignore */ }
    // לעצור את תהליך השומר בפועל לפני מחיקת התיקייה המוגנת. מחיקת המשימה
    // בלבד אינה מבטיחה שתהליך שכבר רץ יסתיים.
    await stopGuardTask();
    // 1) הסרת רישומי ההפעלה עם Windows (Registry + משימה מתוזמנת) —
    //    לפני הפעלת ה-Uninstaller, כדי שלא יישארו רישומים לאחר ההסרה.
    await removeStartupEntries();
    // הסרת חוק חסימת האינטרנט (אם פעיל) — לא להשאיר את הרשת חסומה אחרי ההסרה
    if (netBlockApplied) await netBlockSet(false);
    // 2) הפעלת ה-Uninstaller בשקט (מסיר קבצים, קיצורים ונתונים) —
    //    בתהליך נפרד (detached) כך שהוא ממשיך גם אחרי שהתוכנה נסגרת.
    try {
      const child = spawn(uninstaller, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => { /* ignore */ });
      child.unref();
    } catch { /* ignore */ }
    // 3) סגירה נקייה: gracefulQuit כותב את דגל העצירה (כך שהשומר-שער לא
    //    יקפיץ את התוכנה בחזרה בזמן שה-Uninstaller מסיר את הקבצים) והורג
    //    את השומר — ולאחר מכן התוכנה נסגרת וה-Uninstaller ממשיך לבד.
    gracefulQuit();
    return { ok: true };
  });

  ipcMain.handle('quit:cancel', () => {
    if (quitPromptOpen()) quitWin.destroy();
    return { ok: true };
  });
  // התאמת חלון היציאה לתוכן — החלון חסר מסגרת ולכן גודלו נקבע לפי ההודעה,
  // כך שכל התוכן נראה תמיד, בהתאמה למסך.
  ipcMain.handle('quit:fit', (_e, w, h) => {
    if (quitPromptOpen()) {
      const cw = Math.max(280, Math.min(Math.round(w) || 0, 640));
      const ch = Math.max(240, Math.min(Math.round(h) || 0, 800));
      quitWin.setContentSize(cw, ch);
      quitWin.center();
    }
    return { ok: true };
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:hide', () => {
    if (win && !win.isDestroyed()) win.hide(); // ה-hide נועל את הסשן
    return { ok: true };
  });

  // פתיחת חלון ההגדרות — ממסך החסימה או מכל מקום אחר
  ipcMain.handle('settings:open', () => { showMainWindow(); return { ok: true }; });

  // עדכון צבע הרקע של החלונות כשערכת הנושא משתנה (מניעת הבזקים בטעינה)
  ipcMain.handle('theme:apply', (_e, resolved) => {
    const light = resolved === 'light';
    const bg = light ? '#eef0f9' : '#0a0a14';
    if (win && !win.isDestroyed()) win.setBackgroundColor(bg);
    blockWins.forEach((bw) => { if (bw && !bw.isDestroyed()) bw.setBackgroundColor(bg); });
    return { ok: true };
  });

  // דשבורד: יומן פעילות + מצב ההגנה + גיבוי ושחזור
  ipcMain.handle('activity:get', (_e, limit) => readActivity(Number(limit) || 1500));

  ipcMain.handle('security:get', () => {
    let protectedCopy = false;
    try {
      const exe = sourceExecutable(protectedAppDir());
      protectedCopy = isWin && fs.existsSync(exe) && appVersion() && appVersion() === protectedVersion();
    } catch { /* ignore */ }
    return {
      pin: !!schedule.pinHash,
      enabled: schedule.enabled !== false,
      elevated: isElevated(),
      shared: isWin && fs.existsSync(machineSettingsFile()),
      recovery: !!schedule.recoveryEmail,
      netElevated: isElevated(),
      netActive: netBlockApplied,
      protectedCopy,
      lastTamper: lastTamper()
    };
  });

  ipcMain.handle('backup:export', async () => {
    if (schedule.pinHash && !sessionUnlocked) return { ok: false, error: 'נדרשת סיסמה כדי לייצא גיבוי' };
    const parent = win && !win.isDestroyed() ? win : undefined;
    try {
      const res = await dialog.showSaveDialog(parent, {
        title: 'גיבוי הגדרות — בין הזמנים',
        defaultPath: 'ben-hazmanim-settings.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (res.canceled || !res.filePath) return { ok: false, error: 'הגיבוי בוטל' };
      // הסיסמה אינה מיוצאת — היא ממילא אינה ניתנת לשחזור מגיבוי, ויש לשמור עליה
      const exportData = { ...schedule };
      delete exportData.pinHash;
      delete exportData.passwordPlain;
      delete exportData.passwordEnc;
      fs.writeFileSync(res.filePath, JSON.stringify(exportData, null, 2), 'utf8');
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('backup:import', async () => {
    if (schedule.pinHash && !sessionUnlocked) return { ok: false, error: 'נדרשת סיסמה כדי לייבא גיבוי' };
    const parent = win && !win.isDestroyed() ? win : undefined;
    try {
      const res = await dialog.showOpenDialog(parent, {
        title: 'שחזור הגדרות — בין הזמנים',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, error: 'השחזור בוטל' };
      const data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      // בדיקת תקינות: הקובץ חייב להיות גיבוי אמיתי (לוח שבועי מלא), לא כל JSON
      if (!data || typeof data !== 'object' || !Array.isArray(data.week) || data.week.length !== 7) {
        return { ok: false, error: 'הקובץ שנבחר אינו גיבוי תקף של בין הזמנים' };
      }
      // הסיסמה והפתיחה הידנית נשמרות במחשב בלבד ואינן מוחלפות מגיבוי
      const merged = {
        ...schedule,
        ...data,
        pinHash: schedule.pinHash,
        passwordPlain: schedule.passwordPlain,
        passwordEnc: schedule.passwordEnc,
        manualUnlockUntil: schedule.manualUnlockUntil
      };
      schedule = S.normalizeSchedule(merged);
      saveSettings();
      logEvent('settings', { from: 'backup-import' });
      enforce();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: 'קובץ גיבוי לא תקין: ' + err.message };
    }
  });
}

/* ================= שומר-שער (הגנה מפני סגירה ממנהל המשימות) =================
   שני תהליכים משגיחים זה על זה באמצעות קבצי heartbeat בתיקיית הנתונים:
   - תהליך ראשי: כותב heartbeat כל 3 שניות ומקפיץ את השומר אם נסגר.
   - שומר-שער (--watchdog): כותב heartbeat כל 2 שניות, ואם heartbeat הראשי
     התיישן (התהליך נהרג ממנהל המשימות) — מקפיץ את הראשי מחדש.
   סגירה לגיטימית (תפריט "יציאה") כותבת דגל עצירה כך שהשומר לא מקפיץ. */

const isWatchdog = process.argv.includes('--watchdog');
const isSystemWatchdog = process.argv.includes('--watchdog-system');
const stateDir = () => app.getPath('userData');
const mainHbFile = () => path.join(stateDir(), 'main.heartbeat');
const watchHbFile = () => path.join(stateDir(), 'watchdog.heartbeat');

// דגל העצירה נבדק/נכתב בכמה נתיבים, כדי שהמתקין והאפליקציה ימצאו תמיד
// זה את זה גם כששם המוצר משתנה בין package.json לבין build config:
//   1) userData של האפליקציה (הנתיב הקבוע שלה, לפי productName המלא)
//   2) %APPDATA%\BenHazmanim — נתיב ASCII יציב שה-NSIS כותב אליו.
// כל הדגלים נכתבים באותם נתיבים (userData + נתיב ASCII יציב ל-NSIS) —
// הבדל בשם הקובץ בלבד, אז הבנייה מרוכזת בפונקציה אחת.
const flagPaths = (name) => {
  const paths = [path.join(stateDir(), name)];
  if (isWin && process.env.APPDATA) paths.push(path.join(process.env.APPDATA, 'BenHazmanim', name));
  return paths;
};
const quitFlagPaths = () => flagPaths('quit.flag');
const quitFlagExists = () => quitFlagPaths().some(fs.existsSync);
function writeQuitFlag() {
  for (const p of quitFlagPaths()) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(Date.now()));
    } catch { /* ignore */ }
  }
}
function clearQuitFlags() {
  for (const p of quitFlagPaths()) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  // דגל עצירה של השומר-השער המערכתי (במיקום המשותף) — מתנקה באתחול חדש,
  // כדי שהשומר לא ייצא על דגל ישן מתקינה/עדכון קודמים.
  try { fs.unlinkSync(machineQuitFlag()); } catch { /* ignore */ }
}

// דגל "הפעל מחדש אחרי התקנה": האפליקציה כותבת אותו (באותם נתיבים כמו דגל
// העצירה) ממש לפני שהיא מפעילה עדכון. הסיבה: בהתקנה שקטה (/S) NSIS מדלגת
// על שלב "הפעל את התוכנה אחרי ההתקנה" — לכן ה-installer בודק את הדגל הזה
// בסוף ההתקנה (customInstall) ומפעיל את הגרסה החדשה מעצמו.
const relaunchFlagPaths = () => flagPaths('relaunch.flag');
function writeRelaunchFlag() {
  for (const p of relaunchFlagPaths()) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(Date.now()));
    } catch { /* ignore */ }
  }
}
function clearRelaunchFlags() {
  for (const p of relaunchFlagPaths()) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

function writeHeartbeat(file) {
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() })); } catch { /* ignore */ }
}

function readHeartbeat(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function heartbeatStale(file, maxAgeMs) {
  const hb = readHeartbeat(file);
  if (!hb) return true;
  return Date.now() - hb.ts > maxAgeMs || !isProcessAlive(hb.pid);
}

function spawnMainApp() {
  // הקפצה של האפליקציה הראשית (בפורמט זהה ל-Run key)
  const child = spawn(process.execPath, [app.getAppPath()], {
    detached: true, windowsHide: true, stdio: 'ignore'
  });
  child.on('error', () => { /* אם ההקפצה נכשלת — לא לקרוס */ });
  child.unref();
}

function spawnWatchdog() {
  const child = spawn(process.execPath, [app.getAppPath(), '--watchdog'], {
    detached: true, windowsHide: true, stdio: 'ignore'
  });
  child.on('error', () => { /* ignore */ });
  child.unref();
  return child.pid || null;
}

let lastMainSpawn = 0;
async function runWatchdog() {
  // מניעת שומרים כפולים: אם כבר רץ שומר חי אחר (לא אני) — לחכות שייסגר
  // (במסירת הרשאות מוגבהת השומר הישן נסגר תוך פחות משנייה) ורק אז להמשיך.
  const existing = readHeartbeat(watchHbFile());
  if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    const started = Date.now();
    while (Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 500));
      const hb = readHeartbeat(watchHbFile());
      if (!hb || !isProcessAlive(hb.pid)) return runWatchdog(); // הישן נסגר — מתחילים נקי
    }
    app.exit(0); // שומר אחר עדיין חי אחרי ההמתנה — לצאת בשקט
    return;
  }
  // שומר-שער: ללא חלונות וללא מגש — רק מעקב והקפצה
  writeHeartbeat(watchHbFile());
  const check = () => {
    if (quitFlagExists()) { app.exit(0); return; } // עצירה מוסכמת
    writeHeartbeat(watchHbFile());
    if (heartbeatStale(mainHbFile(), 8000) && Date.now() - lastMainSpawn > 5000) {
      lastMainSpawn = Date.now();
      // אם הראשי תקוע (לא מת) — לחסל אותו כדי שישתחרר ה-instance lock
      const hb = readHeartbeat(mainHbFile());
      if (hb && isProcessAlive(hb.pid)) { try { process.kill(hb.pid); } catch { /* ignore */ } }
      spawnMainApp();
    }
  };
  setInterval(check, 2000);
  check();
}

let lastWatchSpawn = 0;
let ownWatchdogPid = null; // ה-PID של השומר שהתהליך הזה הקים (לסגירה מדויקת)
function superviseWatchdog() {
  // בתהליך הראשי: לוודא שהשומר חי, ואם נסגר — להקים אותו מחדש
  writeHeartbeat(mainHbFile());
  const check = () => {
    writeHeartbeat(mainHbFile());
    // דגל עצירה (נכתב ע"י מתקין העדכון לפני ההתקנה) — לצאת בשקט,
    // כדי שההתקנה תצליח גם כשהתוכנה רצה ברקע (ואפילו עם הרשאות מנהל).
    if (isQuitting) return;
    if (quitFlagExists()) { gracefulQuit(); return; }
    if (heartbeatStale(watchHbFile(), 8000) && Date.now() - lastWatchSpawn > 5000) {
      lastWatchSpawn = Date.now();
      ownWatchdogPid = spawnWatchdog();
    }
  };
  setInterval(check, 3000);
  check();
}

/* ================= שומר-שער מערכתי (הגנה מפני משתמש עם הרשאות מנהל) =================
   למנהל מערכת יש תמיד את היכולת לקחת בעלות על קבצים ולמחוק אותם — לכן
   אי אפשר למנוע ממנו מחיקה, אבל אפשר להפוך אותה לחסרת תועלת:
   - המשימה BenHazmanimGuard מריצה את התוכנה כ-SYSTEM (חשבון מערכת) מתוך
     העותק המוגן כבר באתחול המחשב. כל עוד התהליך רץ, קבצי הליבה של העותק
     המוגן נעולים בידי Windows ואי אפשר למחוק אותם — אפילו כמנהל.
   - השומר המערכתי בודק כל כמה שניות את תקינות הקבצים והמשימות:
     אם תיקיית ההתקנה או העותק המוגן נמחקו/ניזוקו — משחזר אותם מהעותק השני.
     אם המשימות המתוזמנות נמחקו — יוצר אותן מחדש.
   - השומר יוצא רק כשיש דגל עצירה (הסרה לגיטימית עם סיסמת הורה) או כשקובץ
     ההגדרות המשותף נמחק (הסרה) — כדי שלא ישחזר קבצים בזמן ה-Uninstaller. */

const guardHbFile = () => path.join(machineDir(), 'guard.heartbeat');
const machineQuitFlag = () => path.join(machineDir(), 'quit.flag');
function guardShouldExit() {
  // עצירה לגיטימית מסומנת במפורש על ידי המתקין/מסלול ההסרה. מחיקת
  // settings.json לבדה אינה סיבה לצאת — אחרת מנהל יכול למחוק רק את הקובץ
  // ולעצור את כל מנגנון השחזור.
  if (fs.existsSync(machineQuitFlag())) return true;
  // אם תיקיית הנתונים עצמה הוסרה (למשל בסיום הסרה), אין מה לשחזר ממנה.
  if (!fs.existsSync(machineDir())) return true;
  return false;
}

// השומר המערכתי רץ מתוך העותק המוגן, ולכן process.execPath שלו הוא העותק המוגן.
function guardTaskCommand() {
  const exe = sourceExecutable(protectedAppDir());
  return `"${exe}" "${launchAppPath(protectedAppDir())}" --watchdog-system`;
}

function stopGuardTask() {
  return new Promise((resolve) => {
    if (!isWin) return resolve();
    execFile('schtasks', ['/End', '/TN', GUARD_TASK_NAME], () => resolve());
  });
}

function setGuardTask(enabled) {
  return new Promise((resolve) => {
    if (!isWin || !isElevated()) return resolve({ ok: false, error: 'נדרשת הרשאת מנהל' });
    if (enabled) {
      // ONSTART + /RU SYSTEM: רץ כ-SYSTEM כבר באתחול המחשב, לפני כל כניסה.
      execFile('schtasks',
        ['/Create', '/TN', GUARD_TASK_NAME, '/TR', guardTaskCommand(), '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F'],
        (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
    } else {
      execFile('schtasks', ['/Delete', '/TN', GUARD_TASK_NAME, '/F'], () => resolve({ ok: true }));
    }
  });
}

// רישום אירועי חבלה ליומן משותף — כדי שההורה יוכל לראות שניסו למחוק קבצים
function logTamper(kind) {
  try {
    fs.mkdirSync(machineDir(), { recursive: true });
    fs.appendFileSync(path.join(machineDir(), 'tamper.log'), JSON.stringify({ ts: Date.now(), kind }) + '\n', 'utf8');
  } catch { /* ignore */ }
}
function lastTamper() {
  try {
    const lines = fs.readFileSync(path.join(machineDir(), 'tamper.log'), 'utf8').split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return null;
    const e = JSON.parse(last);
    return { ts: e.ts, kind: e.kind };
  } catch { return null; }
}

function restoreSharedSettings() {
  if (fs.existsSync(machineSettingsFile()) || !fs.existsSync(protectedSettingsFile())) return;
  try {
    fs.copyFileSync(protectedSettingsFile(), machineSettingsFile());
    logTamper('settings-restored');
  } catch { /* ignore */ }
}

async function restoreProtectedCopy() {
  // העותק המוגן נמחק/ניזוק — לשחזר מתיקיית ההתקנה המקורית (אם היא שלמה)
  const info = installInfo();
  const dst = protectedAppDir();
  if (!info || !info.dir) return;
  const srcOk = fs.existsSync(sourceExecutable(info.dir)) && fs.existsSync(packageJsonPath(info.dir));
  const dstOk = fs.existsSync(sourceExecutable(dst)) && fs.existsSync(packageJsonPath(dst));
  if (srcOk && !dstOk) {
    logTamper('protected-copy-restored');
    try {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(dst, { recursive: true });
      fs.cpSync(info.dir, dst, { recursive: true });
      try { fs.copyFileSync(machineSettingsFile(), protectedSettingsFile()); } catch { /* ignore */ }
      await hardenProtectedCopy();
    } catch { /* ignore */ }
  }
}

function restoreInstallDir() {
  // תיקיית ההתקנה המקורית נמחקה — לשחזר מהעותק המוגן
  const info = installInfo();
  if (!info || !info.dir) return;
  const srcOk = fs.existsSync(sourceExecutable(protectedAppDir())) && fs.existsSync(packageJsonPath(protectedAppDir()));
  const dstOk = fs.existsSync(sourceExecutable(info.dir)) && fs.existsSync(packageJsonPath(info.dir));
  if (srcOk && !dstOk) {
    logTamper('install-dir-restored');
    try {
      fs.rmSync(info.dir, { recursive: true, force: true });
      fs.mkdirSync(info.dir, { recursive: true });
      fs.cpSync(protectedAppDir(), info.dir, { recursive: true });
    } catch { /* ignore */ }
  }
}

function ensureGuardTasks() {
  // המשימות נמחקו — לשחזר את המשימה הראשית מה-XML שנשמר בעת ההתקנה.
  // חשוב: יצירה מחדש מתוך SYSTEM ללא ה-XML המקורי הייתה יוצרת משימה
  // שרצה כ-SYSTEM ללא ממשק משתמש. אם אין תבנית, משאירים את HKLM Run
  // כמנגנון גיבוי ומדווחים במקום ליצור משימה לא-שמישה.
  execFile('schtasks', ['/Query', '/TN', TASK_NAME], (err) => {
    if (!err) return;
    try {
      if (!fs.existsSync(taskXmlFile())) {
        logTamper('main-task-missing-no-template');
        return;
      }
      execFile('schtasks',
        ['/Create', '/TN', TASK_NAME, '/XML', taskXmlFile(), '/F'],
        () => { /* ignore */ });
    } catch { logTamper('main-task-restore-failed'); }
  });
  execFile('schtasks', ['/Query', '/TN', GUARD_TASK_NAME], (err) => {
    if (err) {
      execFile('schtasks',
        ['/Create', '/TN', GUARD_TASK_NAME, '/TR', guardTaskCommand(), '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F'],
        () => { /* ignore */ });
    }
  });
}

async function runSystemWatchdog() {
  // שומר-שער מערכתי: ללא חלונות וללא מגש — רק שחזור קבצים ומשימות
  writeHeartbeat(guardHbFile());
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      if (guardShouldExit()) { app.exit(0); return; }
      writeHeartbeat(guardHbFile());
      restoreSharedSettings();
      await restoreProtectedCopy();
      restoreInstallDir();
      ensureGuardTasks();
    } finally {
      checking = false;
    }
  };
  setInterval(() => { check().catch(() => {}); }, 10000);
  await check();
}

function gracefulQuit() {
  isQuitting = true;
  logEvent('app-quit');
  writeQuitFlag(); // בכל הנתיבים — כדי שהמתקין/השומר יראו את דגל העצירה
  // סגירת השומר שלנו כדי שלא יקפיץ מחדש
  if (ownWatchdogPid && isProcessAlive(ownWatchdogPid)) {
    try { process.kill(ownWatchdogPid); } catch { /* ignore */ }
  }
  // ניקוי חוק חסימת האינטרנט בסגירה לגיטימית — "התוכנה לא תחסום עד להפעלה
  // הבאה". (התהליך של netsh ממשיך לפעול גם אחרי שהאפליקציה נסגרת.)
  if (netBlockApplied) { try { netBlockSet(false); } catch { /* ignore */ } }
  app.quit();
}

/* ================= אתחול ================= */

if (isSystemWatchdog) {
  // מצב שומר-שער מערכתי (SYSTEM) — אינו נועל את ה-instance ואינו יוצר
  // חלונות: רק משחזר את קבצי התוכנה והמשימות המתוזמנות שנמחקו.
  app.whenReady().then(() => runSystemWatchdog());
  app.on('window-all-closed', () => { /* נשאר פעיל */ });
} else if (isWatchdog) {
  // מצב שומר-שער — אינו נועל את ה-instance ואינו יוצר חלונות
  app.whenReady().then(() => { runWatchdog(); });
  app.on('window-all-closed', () => { /* נשאר פעיל */ });
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => showMainWindow());

    // איבוד מיקוד מכל חלון בזמן חסימה = החזרת מסך החסימה (מניעת Alt+Tab וכיו"ב)
    app.on('browser-window-blur', () => {
      // גניבת מיקוד מתבצעת רק כשיש סיסמה — ללא סיסמה החסימה אינה פעילה
      if (!isQuitting && isBlockedNow() && schedule.pinHash) {
        setTimeout(focusBlockWindows, 60);
      }
    });

    app.whenReady().then(async () => {
      if (isWin) app.setAppUserModelId('com.levtov.benhazmanim');

      loadSettings();
      loadPinLock(); // טעינת נעילה זמנית קיימת (אינה מתאפסת בהרצה מחדש)
      registerIpc();
      // סנכרון עם חוק חומת האש הקיים (אם נשאר מסשן קודם) — כך שהאכיפה
      // תפעיל/תסיר אותו לפי הלוח הנוכחי כבר מהבדיקה הראשונה.
      await reconcileNetBlock();
      logEvent('app-start');

      // חסימת יצירת חשבונות חדשים במחשב (כשהתוכנה רצה עם הרשאות מנהל)
      applyAccountPolicies();

      const isSmokeTest = process.argv.includes('--smoke-test');
      const isVerifyStartup = process.argv.includes('--verify-startup');
      const isVerifyElevation = process.argv.includes('--verify-elevation');
      if (isSmokeTest || isVerifyStartup || isVerifyElevation) {
        if (isVerifyElevation) {
          console.log('VERIFY_ELEVATION', JSON.stringify({
            elevated: isElevated(),
            runAsAdmin: !!schedule.runAsAdmin,
            supported: isWin
          }));
        } else if (isVerifyStartup) {
          const want = schedule.startWithWindows;
          const before = await getStartupStatus();
          let setRes = null;
          if (want !== before) setRes = await setStartup(want);
          const after = await getStartupStatus();
          console.log('VERIFY_STARTUP', JSON.stringify({
            wantStartup: want,
            registeredBefore: before,
            registeredAfter: after,
            ok: after === want,
            task: setRes ? (setRes.warning || 'ok') : 'unchanged'
          }));
        } else {
          console.log('SMOKE_OK', JSON.stringify({
            status: S.getStatus(schedule, trustedDate()),
            iconExists: fs.existsSync(path.join(__dirname, 'assets', 'icon.png')),
            trustedClock: { wall: WALL_START, hr: HR_START.toString() }
          }));
        }
        app.quit();
        return;
      }

      // ניקוי דגלי עצירה מהסשן הקודם (אתחול חדש = רוצים את השומר)
      clearQuitFlags();
      // ניקוי דגלי "הפעל מחדש" שנשארו — המתקין כבר הפעיל את הגרסה החדשה
      clearRelaunchFlags();

      createMainWindow();
      tray = new Tray(trayIcon());
      updateTray(S.getStatus(schedule, trustedDate()));

      enforce();
      setInterval(enforce, 5000); // בדיקה כל 5 שניות

      superviseWatchdog(); // הגנה הדדית: הראשי מקפיץ את השומר

      // הפעלה עם Windows — בהתאם להגדרה השמורה ומצב ההרשאות
      await syncStartup();

      // בדיקת עדכונים ברקע (אינה חוסמת, אופליין = שקט) — רק אם המפתח הגדיר מקור
      if (UPDATE_URL) setTimeout(() => checkForUpdate(), 8000);

      app.on('activate', () => showMainWindow());
    });

    app.on('will-quit', () => {
      try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
    });

    app.on('window-all-closed', () => {
      // נשאר במגש
    });
  }
}
