'use strict';

const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen,
  globalShortcut, Notification, shell, safeStorage, nativeTheme, dialog, powerMonitor
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
let clockRollbackDetected = false;
const clockStateFile = () => path.join(app.getPath('userData'), 'clock-state.json');
const clockStateFiles = () => {
  if (!isWin) return [clockStateFile()];
  const machineClock = path.join(machineDir(), 'clock-state.json');
  // משתמש רגיל יכול לקרוא דגימה מוגנת קיימת, אך אינו אמור ליצור קובץ
  // חדש תחת ProgramData. כתיבה לשם תתבצע רק בהרצה מוגבהת.
  return isElevated() || fs.existsSync(machineClock)
    ? [clockStateFile(), machineClock]
    : [clockStateFile()];
};
function systemUptimeMs() {
  if (!isWin) return null;
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::TickCount64'], { encoding: 'utf8', windowsHide: true });
    const value = Number(String(raw || '').trim());
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}
const UPTIME_START = systemUptimeMs();
function currentSystemUptimeMs() {
  return Number.isFinite(UPTIME_START)
    ? UPTIME_START + Math.floor(Number(process.hrtime.bigint() - HR_START) / 1e6)
    : null;
}
function trustedNow() {
  return WALL_START + Math.floor(Number(process.hrtime.bigint() - HR_START) / 1e6);
}
function trustedDate() { return new Date(trustedNow()); }

// שעון מונוטוני תקף בתוך Session בלבד. בין הפעלות אין דרך מקומית לדעת אם
// השעה קפצה קדימה באופן לגיטימי או בעקבות חבלה, לכן מזהים לפחות קפיצה לאחור
// ומפעילים Fail Closed כאשר קיימת סיסמת הורה במקום להמשיך לפי זמן חשוד.
function loadClockState() {
  const wall = Date.now();
  const uptime = systemUptimeMs();
  for (const file of clockStateFiles()) {
    try {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!previous || !Number.isFinite(previous.wall)) continue;
      if (Number.isFinite(previous.uptime) && Number.isFinite(uptime) && uptime >= previous.uptime) {
        // באותו Boot יש לנו שעון מונוטוני שחוצה Restart של התהליך. הפער
        // בין TickCount64 לבין Date.now חושף קפיצה קדימה או אחורה.
        const expected = uptime - previous.uptime;
        const observed = wall - previous.wall;
        if (Math.abs(observed - expected) > 120000) clockRollbackDetected = true;
      } else if (wall + 120000 < previous.wall) {
        // תאימות לקובצי clock-state ישנים ולמקרה שאין גישה ל-TickCount64.
        clockRollbackDetected = true;
      }
    } catch { /* התקנה חדשה או קובץ לא קיים */ }
  }
  recordClockSample();
}
function recordClockSample() {
  const uptime = currentSystemUptimeMs();
  const content = JSON.stringify({ wall: Date.now(), trusted: trustedNow(), uptime });
  for (const file of clockStateFiles()) {
    try { atomicWrite(file, content); } catch { /* diagnostics בלבד */ }
  }
}

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
  // לאחר שהותקן מקור משותף, מחיקתו אינה מחזירה את התהליך לקובץ משתמש
  // שאפשר לעצב כרצוננו. נשארים נעולים למקור המשותף עד שהוא משוחזר או מתוקן.
  if (sharedSettingsRequired || fs.existsSync(machineSettingsFile())) return machineSettingsFile();
  return isElevated() ? machineSettingsFile() : path.join(app.getPath('userData'), 'settings.json');
};

function settingsSignatureFor(file) {
  try {
    const st = fs.statSync(file || settingsFile());
    return String(file || settingsFile()) + '|' + st.mtimeMs + '|' + st.size;
  } catch {
    return 'missing|' + String(file || settingsFile());
  }
}
function rememberSettingsSignature() { settingsSignature = settingsSignatureFor(settingsFile()); }
function reloadSettingsIfChanged() {
  if (!settingsSignature || settingsReloadBusy) return;
  const current = settingsSignatureFor(settingsFile());
  if (current === settingsSignature) return;
  settingsReloadBusy = true;
  try {
    loadSettings();
    logEvent('settings-reloaded', { source: 'external-change' });
    enforce();
  } finally {
    settingsReloadBusy = false;
  }
}

let schedule = S.defaultSchedule();
let configurationFault = null; // קובץ הגדרות פגום ללא Backup תקין — Fail Closed
let sharedSettingsRequired = false;
let settingsSignature = null;
let settingsReloadBusy = false;
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
let netBlockError = null;     // הסיבה האחרונה לכשל — מוצגת כדי שלא תהיה תחושת חסימה כוזבת
let netBlockWarned = false;   // הודעת השגיאה נשלחה פעם אחת (לא לשלוח כל 5 שניות)
let netDesired = false;       // המצב הרצוי האחרון של חוק חומת האש
let netOperation = null;      // Promise יחיד — מונע add/delete חופפים
let netNeedsValidation = false; // חוק קיים מסשן קודם חייב אימות מחדש
let netElevationRetryAt = 0;   // מניעת חלונות UAC חוזרים במקרה של ביטול/כשל
let lastNetActive = false;    // מעקב מצבי לזיהוי תחילת/סיום חסימת אינטרנט ביומן
let netIconWin = null;        // חלון האייקון הצף (מחשב פתוח + אינטרנט חסום)

// מצב "תוכנת לימוד מותרת": בזמן חסימה לפי הלוח, אם החלון הפעיל שייך לתוכנה
// תורנית שההורה התיר (למשל וורד, אוצריא, אוצר החכמה) — מסך החסימה מוסתר
// והתוכנה נשארת בשימוש. החסימה חוזרת מיד כשעוברים לתוכנה אחרת או סוגרים אותה.
let relaxed = false;          // האם אנחנו במצב "תוכנת לימוד פתוחה" עכשיו
let relaxedTimer = null;      // בדיקה תכופה יותר (1 שנייה) בזמן מצב רפוי
let enforceBusy = false;      // הגנה מפני ריצות חופפות של לולאת האכיפה
let enforceAgain = false;     // בקשה להרצה נוספת שהגיעה בזמן שהאכיפה הייתה עסוקה

// State Machine מרכזי: כל שינוי מדיניות עובר דרך Desired State, וכל פעולה
// מדווחת Actual State רק לאחר שהאכיפה הסתיימה בפועל.
const enforcementState = {
  phase: 'uninitialized', // uninitialized | transitioning | stable | error
  desired: 'unknown',      // allowed | blocked | netblocked
  actual: 'unknown',       // allowed | blocked | netblocked | relaxed | error
  transitionId: 0,
  error: null,
  changedAt: 0
};

function beginEnforcement(desired) {
  enforcementState.phase = 'transitioning';
  enforcementState.desired = desired;
  enforcementState.transitionId++;
  enforcementState.error = null;
  enforcementState.changedAt = Date.now();
  return enforcementState.transitionId;
}

function finishEnforcement(actual, error) {
  enforcementState.actual = actual;
  enforcementState.phase = error ? 'error' : 'stable';
  enforcementState.error = error ? String(error.message || error) : null;
  enforcementState.changedAt = Date.now();
}

function enforcementSnapshot() {
  return {
    phase: enforcementState.phase,
    desired: enforcementState.desired,
    actual: enforcementState.actual,
    transitionId: enforcementState.transitionId,
    error: enforcementState.error,
    changedAt: enforcementState.changedAt
  };
}

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
  configurationFault = null;
  // מקור אמת יחיד: אם נוצר קובץ משותף, קובץ משתמש לעולם אינו גובר עליו.
  // בחירה לפי mtime אפשרה למשתמש רגיל להחליף את מדיניות המחשב באמצעות
  // settings.json מקומי עם תאריך שינוי חדש יותר.
  const tryRead = (file) => {
    try {
      if (!file || !fs.existsSync(file)) return null;
      return S.normalizeSchedule(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch { return null; }
  };
  const userFile = path.join(app.getPath('userData'), 'settings.json');
  const machineFile = machineSettingsFile();
  let source = null;

  // קיום של קובץ משותף/גיבוי/עותק מוגן מסמן התקנה מנוהלת. מרגע זה
  // קובץ משתמש לעולם אינו יכול להפוך למקור האמת, גם אם machine settings נמחק.
  if (isWin && (fs.existsSync(machineFile) || fs.existsSync(protectedSettingsFile()) ||
      fs.existsSync(path.join(machineDir(), 'install.json')))) {
    sharedSettingsRequired = true;
  }
  const machineS = tryRead(machineFile);
  const userS = tryRead(userFile);
  if (!isWin && machineS && userS) {
    // סביבת פיתוח/בדיקות שאינה Windows אינה משתמשת במקור המשותף בפועל;
    // משמרים כאן תאימות לאחור בלבד. ב-Windows קובץ machine תמיד קודם.
    let m = 0, u = 0;
    try { m = fs.statSync(machineFile).mtimeMs; } catch { /* ignore */ }
    try { u = fs.statSync(userFile).mtimeMs; } catch { /* ignore */ }
    schedule = u > m ? userS : machineS;
    source = u > m ? 'user' : 'machine';
  } else if (machineS) {
    schedule = machineS;
    source = 'machine';
  } else if (fs.existsSync(machineFile) || sharedSettingsRequired) {
    // קובץ משותף קיים/נדרש אך פגום או נמחק: מנסים קודם את העותק המוגן.
    // אסור ליפול לקובץ משתמש שאינו מקור אמת, ואם אין Backup — Fail Closed.
    const backup = tryRead(protectedSettingsFile());
    if (backup) {
      schedule = backup;
      source = 'backup-recovered';
      logEvent('settings-recovered', { source: 'protected-backup' });
    } else {
      schedule = S.defaultSchedule();
      source = 'machine-invalid';
      configurationFault = 'קובץ ההגדרות המשותף חסר או פגום ואין עותק גיבוי תקין';
      logEvent('settings-error', { source: 'machine', reason: configurationFault });
    }
  } else if (fs.existsSync(userFile)) {
    if (userS) {
      schedule = userS;
      source = 'user';
    } else {
      schedule = S.defaultSchedule();
      source = 'user-invalid';
      configurationFault = 'קובץ ההגדרות פגום ואין עותק גיבוי תקין';
      logEvent('settings-error', { source: 'user', reason: configurationFault });
    }
  } else {
    // אף קובץ אינו קיים — התקנה חדשה. זהו המקרה היחיד שבו ברירת מחדל
    // פתוחה היא תקינה, משום שאין עדיין מדיניות שהוגדרה.
    schedule = S.defaultSchedule();
    if (isWin && isElevated()) {
      const backup = tryRead(protectedSettingsFile());
      if (backup) { schedule = backup; source = 'backup-recovered'; }
    }
  }

  // ניקוי "פתוח עד המעבר הבא" שנשאר מלוח קודם. הפתיחה נקבעת רק ע"י ההורה
  // (הזנת סיסמה במסך החסימה) — כאן רק מטפלים בערך הקיים:
  // - אם הלוח כבר לא חוסם — הערך חסר משמעות ויוצר "המעבר הבא" פנטום בממשק
  //   (שאריות של לוח שנמחק) → מנקים.
  // - אם הלוח חוסם וקיימת פתיחה — מסנכרנים אותה עם המעבר הבא האמיתי של
  //   הלוח הנוכחי, כך שפתיחה לא מחזיקה את המחשב פתוח מעבר לחלון החדש.
  const now = trustedDate();
  const rawState = S.stateAt(schedule, now);
  let dirty = false;
  // פתיחה ידנית היא Override של Session, לא מדיניות שצריכה לשרוד Restart.
  // אחרת כיבוי/הפעלה בזמן חסימה משאיר את המחשב פתוח לפי החלטה ישנה.
  if (schedule.manualUnlockUntil) {
    schedule.manualUnlockUntil = null;
    dirty = true;
  }
  // העלאת הקובץ העדכני למקור המשותף — כדי שהבחירה הבאה לפי שעת השינוי
  // תישאר עקבית, והתיקונים (מחיקת חלונות וכדומה) יישארו קבועים לכל המשתמשים.
  // בהרצה מוגבהת חייב להיווצר קובץ משותף גם בהתקנה חדשה עם לוח ריק —
  // השומר המערכתי משתמש בקיומו כסמן שהתוכנה הותקנה.
  if (isWin && isElevated() && (dirty || source === 'user' || source === 'backup' || source === 'backup-recovered' || !fs.existsSync(machineFile))) {
    saveSettings();
  }

  // ההפעלה עם Windows תמיד פעילה (ללא אפשרות לכיבוי), והרצה עם הרשאות
  // מנהל הוסרה מהממשק — כך שגם הגדרות ישנות לא יגרמו להרמה מוגבהת.
  schedule.startWithWindows = true;
  schedule.runAsAdmin = false;
  rememberSettingsSignature();
}

function writeProtectedSettingsBackup() {
  if (!isWin || !isElevated() || !fs.existsSync(protectedAppDir())) return;
  try {
    atomicWrite(protectedSettingsFile(), fs.readFileSync(machineSettingsFile()));
  } catch { /* העותק המוגן עדיין לא נוצר או אינו נגיש */ }
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, content, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* לא זמין בכל מערכת קבצים */ }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function saveSettings() {
  const serialized = JSON.stringify(schedule, null, 2);
  const target = settingsFile();
  try {
    // לאחר שנוצר קובץ משותף, תהליך לא מוגבה אינו רשאי ליצור מקור חלופי.
    if (isWin && fs.existsSync(machineSettingsFile()) && !isElevated()) {
      return { ok: false, error: 'הגדרות המחשב מנוהלות במצב מוגן — הפעילו את התוכנה כמנהל כדי לשנות אותן' };
    }
    atomicWrite(target, serialized);
    writeProtectedSettingsBackup();
    rememberSettingsSignature();
    return { ok: true, warning: null };
  } catch (err) {
    // התקנה חדשה ללא קובץ משותף עדיין יכולה לעבוד בפרופיל המשתמש.
    try {
      if (isWin && fs.existsSync(machineSettingsFile())) {
        return { ok: false, error: 'שמירת ההגדרות המשותפות נכשלה: ' + err.message };
      }
      atomicWrite(path.join(app.getPath('userData'), 'settings.json'), serialized);
      rememberSettingsSignature();
      return { ok: true, warning: null };
    } catch (err2) {
      console.error('שמירת הגדרות נכשלה', err2);
      return { ok: false, error: err2.message || err.message };
    }
  }
}

/* ================= חלונות חסימה (כל המסכים) ================= */

function isBlockedNow() {
  // נעילה ידנית או זמן לא מהימן (עם PIN) מחייבים החזרת חלון החסימה.
  return !!(manualLock || configurationFault || (clockRollbackDetected && schedule.pinHash) ||
    (schedule.enabled && S.getStatus(schedule, trustedDate()).state === 'blocked'));
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
    // אירוע blur מבטל מיד את מטמון ה-Foreground כדי שלא תישאר הקלה
    // לאחר מעבר לתהליך אחר.
    fgCache.at = 0;
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
  let registered = 0;
  for (const accel of BLOCK_SHORTCUTS) {
    try {
      const ok = globalShortcut.register(accel, () => {
        // הקיצור נבלע — החזרת חלון החסימה לקדמת המסך (עם כבוד לתוכנות מותרות)
        maybeStealFocus();
      });
      if (ok !== false) registered++;
    } catch { /* חלק מהקיצורים אינם ניתנים לרישום */ }
  }
  shortcutsRegistered = registered > 0;
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
   בדיוק כפי שהיו. החוק דורש הרשאת מנהל: בהרצה מוגבהת הוא מופעל ישירות,
   ובהרצה רגילה רק פקודת חומת האש מורמת באמצעות UAC — לא מסמנים חסימה
   פעילה לפני שהחוק נוצר ואומת בפועל. */
const NET_RULE = 'BenHazmanimNetBlock';

// האם קיים חוק חסימה בשם שלנו? (נקרא בעלייה כדי לסנכרן עם מצב קיים
// אחרי קריסה/סגירה — חוקי חומת אש נשארים גם אחרי שהתוכנה נסגרת)
function netRuleExists() {
  return new Promise((resolve) => {
    if (!isWin) return resolve(false);
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + NET_RULE], (err) => resolve(!err));
  });
}

// חוק יכול להיווצר גם כאשר כל פרופילי חומת האש כבויים — במקרה כזה הוא
// קיים אך אינו אוכף דבר. בדיקה זו אינה מנתחת פלט מקומי של netsh; אם גרסת
// Windows אינה מספקת את cmdlet, מחזירים null ומשאירים את בדיקת קיום החוק.
function firewallProfilesEnabled() {
  return new Promise((resolve) => {
    if (!isWin) return resolve(null);
    const script = '(Get-NetFirewallProfile | Where-Object { $_.Enabled -eq $true }).Count -gt 0';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      const value = String(stdout || '').trim().toLowerCase();
      resolve(value === 'true' ? true : value === 'false' ? false : null);
    });
  });
}

function reconcileNetBlock(desired) {
  netDesired = !!desired;
  if (netOperation) return netOperation;
  netOperation = (async () => {
    while (true) {
      const wanted = netDesired;
      const already = wanted
        ? netBlockApplied && !netBlockFailed && !netNeedsValidation
        : !netBlockApplied;
      if (already) break;
      const res = await netBlockSet(wanted);
      if (res.ok) {
        netBlockApplied = wanted;
        netNeedsValidation = false;
        netBlockFailed = false;
        netBlockError = null;
        netBlockWarned = false;
      } else {
        netBlockFailed = true;
        netBlockError = res.error || 'לא ניתן לאמת שחסימת האינטרנט פעילה';
        if (!netBlockWarned) {
          netBlockWarned = true;
          logEvent('netblock-fail', { desired: wanted, error: res.error || null });
          if (win && !win.isDestroyed()) {
            try { win.webContents.send('netblock-error', res.error); } catch { /* ignore */ }
          }
        }
        // אם היעד השתנה בזמן הפעולה, עוברים מיד ליעד החדש; אחרת משאירים
        // את הכשל מסומן כדי שהאכיפה הבאה תבצע Retry ולא תוותר לכל החלון.
        if (netDesired === wanted) break;
      }
      if (netDesired === wanted && netBlockApplied === wanted) break;
    }
  })().finally(() => { netOperation = null; });
  return netOperation;
}

// הפעלת netsh מתוך תהליך רגיל לא מחזיקה הרשאת מנהל. בעבר המצב הזה סומן
// כ"האינטרנט חסום" למרות שפקודת חומת האש כלל לא יכלה לרוץ — ולכן בפועל
// האינטרנט נשאר פתוח. כשאין הרשאה, מרימים רק את פקודת netsh דרך UAC
// (ולא את כל ממשק התוכנה), ומציגים כשל אם המשתמש ביטל את האישור.
function psSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function runNetsh(args) {
  return new Promise((resolve) => {
    if (isElevated()) {
      return execFile('netsh', args, { windowsHide: true }, (err, stdout, stderr) => {
        resolve({ err, stdout, stderr });
      });
    }
    if (Date.now() < netElevationRetryAt) {
      return resolve({ err: new Error('הרשאת מנהל לא אושרה — נסו שוב מתוך התוכנה כדי להציג בקשת UAC חדשה') });
    }
    // Start-Process -Verb RunAs מציג את בקשת UAC עבור פקודת החומה בלבד.
    // העברת הארגומנטים כמערך מצמצמת סיכוני quoting וערכי shell לא צפויים.
    const list = '@(' + args.map(psSingleQuote).join(',') + ')';
    const script =
      "$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath 'netsh.exe' " +
      '-ArgumentList ' + list + ' -Verb RunAs -Wait -PassThru; exit ([int]$p.ExitCode) } ' +
      'catch { Write-Error $_; exit 1223 }';
    netElevationRetryAt = Date.now() + 60000;
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (!err) netElevationRetryAt = 0;
      resolve({ err, stdout, stderr });
    });
  });
}

// הפעלה/כיבוי של חוק החסימה. נשען על קודי השגיאה של netsh (אמינים גם
// כשהפלט מקומי, למשל בעברית) ולא על ניתוח טקסט. אחרי שינוי מוצלח מאמתים
// שהחוק אכן קיים — לא מדווחים "חסום" על סמך יציאת פקודה בלבד.
async function netBlockSet(enable) {
  if (!isWin) return { ok: false, error: 'זמין רק בווינדוס' };
  const done = (err, msg) => err
    ? { ok: false, error: msg || 'חומת האש אינה זמינה, ההרשאה בוטלה או שהיא מנוהלת על ידי תוכנה אחרת — לא ניתן לשנות את חסימת האינטרנט' }
    : { ok: true };
  if (enable) {
    const exists = await netRuleExists();
    const args = exists
      ? ['advfirewall', 'firewall', 'set', 'rule', 'name=' + NET_RULE, 'new', 'enable=yes', 'action=block', 'dir=out', 'protocol=any', 'localip=any', 'remoteip=any', 'profile=any']
      : ['advfirewall', 'firewall', 'add', 'rule', 'name=' + NET_RULE, 'dir=out', 'action=block', 'enable=yes', 'protocol=any', 'localip=any', 'remoteip=any', 'profile=any'];
    const result = await runNetsh(args);
    if (result.err) return done(result.err);
    const present = await netRuleExists();
    if (!present) return done(new Error('חוק חסימת האינטרנט לא נמצא לאחר ההפעלה — ייתכן שחומת האש מנוהלת על ידי תוכנה אחרת'));
    const firewallOn = await firewallProfilesEnabled();
    return done(firewallOn === false
      ? new Error('חומת האש של Windows כבויה — החוק קיים אך אינו אוכף חסימה')
      : null);
  }
  const result = await runNetsh(['advfirewall', 'firewall', 'delete', 'rule', 'name=' + NET_RULE]);
  if (!result.err) return done(null);
  // אין חוק כזה = הרשת כבר פתוחה — זה בסדר (אלא אם החוק דווקא קיים)
  const exists = await netRuleExists();
  return done(exists ? result.err : null);
}

// סנכרון בעלייה: לדעת אם חוק החסימה נשאר פעיל מסשן קודם (חוקי חומת האש
// לא נמחקים מעצמם), כדי שהאכיפה תסיר/תפעיל אותו לפי הלוח הנוכחי.
async function reconcileNetBlockOnStartup() {
  if (!isWin) return;
  netBlockApplied = await netRuleExists();
  netNeedsValidation = netBlockApplied;
  // אם החוק קיים, הוא ייבדק/יופעל מחדש רק כאשר זה היעד הנוכחי; אם היעד
  // פתוח, reconcileNetBlock(false) יסיר אותו באופן סדרתי.
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

/* ---------- סריקה אוטומטית של תוכנות תורניות מוכרות ----------
   כדי שההורה לא יצטרך לחפש את קבצי ההתקנה, הסריקה מאתרת תוכנות
   תורניות מותקנות לפי שלושה מקורות (בסריקה גנרית אחת ב-PowerShell):
   1) רישום App Paths — תוכנות שרושמות שם את קובץ ההרצה שלהן (למשל וורד);
   2) רישום הסרת ההתקנה — שם התצוגה + מיקום ההתקנה + אייקון;  3) קיצורי
   דרך בתפריט התחל (כל המשתמשים + המשתמש הנוכחי). ההתאמה לתוכנה מוכרת
   מתבצעת בצד JS לפי הטבלה שלמטה — כך אפשר להוסיף תוכנות בלי לגעת בסקריפט. */

const KNOWN_APPS = [
  {
    id: 'word',
    name: 'Microsoft Word',
    exeNames: ['WINWORD.EXE'],
    displayPatterns: [/microsoft\s*(365|office)/i, /\bword\b/i],
    // וורד מזוהה לפי שם הקובץ (App Paths, קיצור דרך, רישום התקנה) — בלי
    // התאמת תיקיות, אחרת כל תוכנות Office (אקסל, אאוטלוק...) ייחשבו לוורד.
    folderPatterns: [],
    candidates: [
      (process.env.ProgramFiles || '') + '\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
      (process.env['ProgramFiles(x86)'] || '') + '\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
      (process.env.ProgramFiles || '') + '\\Microsoft Office\\root\\Office15\\WINWORD.EXE',
      (process.env['ProgramFiles(x86)'] || '') + '\\Microsoft Office\\root\\Office15\\WINWORD.EXE',
      (process.env.ProgramFiles || '') + '\\Microsoft Office\\Office16\\WINWORD.EXE',
      (process.env['ProgramFiles(x86)'] || '') + '\\Microsoft Office\\Office16\\WINWORD.EXE'
    ]
  },
  {
    id: 'otzaria',
    name: 'אוצריא',
    exeNames: ['otzaria.exe'],
    displayPatterns: [/otzaria/i, /אוצריא/],
    folderPatterns: [/otzaria/i, /אוצריא/],
    candidates: [
      (process.env.LOCALAPPDATA || '') + '\\Programs\\otzaria\\otzaria.exe',
      (process.env.LOCALAPPDATA || '') + '\\Programs\\Otzaria\\otzaria.exe',
      (process.env.ProgramFiles || '') + '\\Otzaria\\otzaria.exe',
      (process.env['ProgramFiles(x86)'] || '') + '\\Otzaria\\otzaria.exe',
      // גרסאות המותקנות תחת Program Files בשם התיקייה העברי
      (process.env.ProgramFiles || '') + '\\אוצריא\\otzaria.exe',
      (process.env['ProgramFiles(x86)'] || '') + '\\אוצריא\\otzaria.exe',
      (process.env.SystemDrive || 'C:') + '\\Program Files\\אוצריא\\otzaria.exe',
      (process.env.SystemDrive || 'C:') + '\\Otzaria\\otzaria.exe'
    ]
  },
  {
    id: 'zayit',
    name: 'זית',
    exeNames: ['Zayit.exe'],
    displayPatterns: [/zayit/i, /זית/],
    folderPatterns: [/zayit/i],
    candidates: [
      (process.env.LOCALAPPDATA || '') + '\\Programs\\zayit\\Zayit.exe',
      (process.env.LOCALAPPDATA || '') + '\\Programs\\Zayit\\Zayit.exe',
      (process.env.ProgramFiles || '') + '\\Zayit\\Zayit.exe',
      (process.env['ProgramFiles(x86)'] || '') + '\\Zayit\\Zayit.exe'
    ]
  },
  {
    id: 'barilan',
    name: 'שו"ת בר אילן',
    exeNames: ['Responsea.exe', 'Responsa.exe', 'BarIlan.exe', 'Barilan.exe'],
    displayPatterns: [/בר[ -]?אילן/u, /responsa/i, /bar[ -]?ilan/i],
    folderPatterns: [/bar[ -]?ilan/i, /responsa/i, /בר אילן/u],
    candidates: []
  },
  {
    id: 'otzar',
    name: 'אוצר החכמה',
    exeNames: ['Otzar.exe', 'OtzarHC.exe', 'OtzarHaChochma.exe'],
    displayPatterns: [/אוצר החכמה/u, /otzar/i],
    folderPatterns: [/otzar/i, /אוצר החכמה/u],
    candidates: [
      (process.env.ProgramFiles || '') + '\\Otzar\\Otzar.exe',
      (process.env['ProgramFiles(x86)'] || '') + '\\Otzar\\Otzar.exe',
      (process.env.ProgramFiles || '') + '\\Otzar HaChochma\\Otzar.exe',
      (process.env['ProgramFiles(x86)'] || '') + '\\Otzar HaChochma\\Otzar.exe',
      // מבנה ההתקנה של אוצר החכמה שנמצא בשימוש בפועל אצל משתמשים רבים
      (process.env.ProgramFiles || '') + '\\OtzarApp\\OtzarLocal\\launcher\\bin\\x64\\app\\otzar.exe',
      (process.env['ProgramFiles(x86)'] || '') + '\\OtzarApp\\OtzarLocal\\launcher\\bin\\x64\\app\\otzar.exe',
      (process.env.SystemDrive || 'C:') + '\\OtzarApp\\OtzarLocal\\launcher\\bin\\x64\\app\\otzar.exe'
    ]
  }
];

// סריקה גנרית אחת: מחזירה JSON עם כל רשומות App Paths, רשומות ההתקנה
// וקיצורי הדרך — בלי שום ידע על התוכנות. ההתאמה נעשית ב-JS (KNOWN_APPS).
const DETECT_PS_SCRIPT =
  "$ErrorActionPreference='SilentlyContinue'; " +
  '$out=[ordered]@{appPaths=@();uninstall=@();shortcuts=@()}; ' +
  "@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths') | ForEach-Object { Get-ChildItem $_ | ForEach-Object { $p=(Get-ItemProperty $_.PSPath).'(default)'; if ($p) { $out.appPaths += [string]$p } } }; " +
  "@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall') | ForEach-Object { Get-ChildItem $_ | ForEach-Object { $k=Get-ItemProperty $_.PSPath; if ($k.DisplayName) { $out.uninstall += [ordered]@{name=[string]$k.DisplayName;location=[string]$k.InstallLocation;icon=[string]$k.DisplayIcon} } } }; " +
  "$sh=New-Object -ComObject WScript.Shell; " +
  "@(\"$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\",\"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\") | ForEach-Object { Get-ChildItem $_ -Recurse -Filter *.lnk | ForEach-Object { try { $t=$sh.CreateShortcut($_.FullName).TargetPath; if ($t) { $out.shortcuts += [string]$t } } catch {} } }; " +
  'ConvertTo-Json -InputObject $out -Compress -Depth 4';

// איתור התוכנות התורניות המותקנות: מריצה את הסריקה, מתאימה לתוכנות
// המוכרות (לפי שם קובץ, שם תצוגה, קיצור דרך או נתיב אופייני), מסירה
// כפילויות ומחזירה רשימה של { id, name, path }.
function detectKnownApps() {
  return new Promise((resolve) => {
    if (!isWin) return resolve([]);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DETECT_PS_SCRIPT], { windowsHide: true, timeout: 25000 }, (err, stdout) => {
      let data = null;
      try { data = JSON.parse(String(stdout || '')); } catch { /* פלט לא תקין */ }
      const lists = {
        appPaths: Array.isArray(data && data.appPaths) ? data.appPaths : [],
        uninstall: Array.isArray(data && data.uninstall) ? data.uninstall : [],
        shortcuts: Array.isArray(data && data.shortcuts) ? data.shortcuts : []
      };
      const norm = (p) => String(p || '').trim().replace(/^"+|"+$/g, '').replace(/,\d+$/, '');
      const found = [];
      const seen = new Set();
      for (const app of KNOWN_APPS) {
        const paths = new Set();
        const collect = (p) => {
          const n = norm(p);
          if (!n || !/\.exe$/i.test(n) || !fs.existsSync(n)) return;
          paths.add(n);
        };
        // 1) App Paths — לפי שם קובץ ההרצה
        for (const p of lists.appPaths) {
          if (app.exeNames.some((n) => n.toLowerCase() === path.basename(String(p)).toLowerCase())) collect(p);
        }
        // 2) רשומות התקנה — לפי שם התצוגה; הקובץ במיקום ההתקנה או לפי האייקון
        for (const u of lists.uninstall) {
          if (!app.displayPatterns.some((re) => re.test(String(u.name || '')))) continue;
          const loc = norm(u.location);
          // מיקום ההתקנה יכול להיות תיקייה או קובץ הרצה — אבל הקובץ חייב
          // להתאים לשמות של התוכנה (אחרת למשל כל תוכנות Office ייחשבו לוורד)
          if (loc && /\.exe$/i.test(loc)) {
            if (app.exeNames.some((n) => n.toLowerCase() === path.basename(loc).toLowerCase())) collect(loc);
          } else if (loc) {
            for (const n of app.exeNames) {
              if (fs.existsSync(path.join(loc, n))) collect(path.join(loc, n));
            }
          }
          const icon = norm(u.icon).split(',')[0];
          if (icon && /\.exe$/i.test(icon) &&
              app.exeNames.some((n) => n.toLowerCase() === path.basename(icon).toLowerCase())) collect(icon);
        }
        // 3) קיצורי דרך — לפי שם קובץ או לפי תיקיית ההתקנה האופיינית
        for (const p of lists.shortcuts) {
          const b = path.basename(String(p)).toLowerCase();
          if (app.exeNames.some((n) => n.toLowerCase() === b)) collect(p);
          else if (app.folderPatterns.some((re) => re.test(String(p)))) collect(p);
        }
        // 4) נתיבי התקנה אופייניים ידועים
        for (const c of app.candidates) collect(c);
        for (const p of paths) {
          const lp = p.toLowerCase();
          if (seen.has(lp)) continue;
          seen.add(lp);
          found.push({ id: app.id, name: app.name, path: p });
        }
      }
      resolve(found);
    });
  });
}

/* ================= לולאת האכיפה ================= */

function buildStatus() {
  const calculated = S.getStatus(schedule, trustedDate());
  // כאשר זוהתה קפיצה לאחור בין הפעלות, עדיף לנעול עם PIN מאשר להסתמך על
  // זמן שאינו מהימן. ללא PIN נשמרת מדיניות ההתקנה הראשונית שאינה נועלת.
  const st = configurationFault
    ? { ...calculated, state: 'blocked', next: null, nextAt: null, secondsUntilNext: null, warning: false, warningSeconds: null, configError: true }
    : clockRollbackDetected && schedule.pinHash
      ? { ...calculated, state: 'blocked', next: null, nextAt: null, secondsUntilNext: null, warning: false, warningSeconds: null, clockError: true }
      : calculated;
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
    netBlockError: netBlockError,
    netBlockApplied: netBlockApplied,
    clockError: !!st.clockError,
    configError: !!configurationFault,
    enforcement: enforcementSnapshot(),
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
  } catch (err) {
    // שגיאה לא צפויה אינה משאירה את המצב כ"יציב". מנסים Fail Closed
    // כאשר קיימת מדיניות חסימה וסיסמת הורה; אם גם זה נכשל, המצב נשאר Error
    // ומתועד כדי שה-Watchdog/Diagnostics יוכלו לזהות אותו.
    const shouldFailClosed = !!(configurationFault || (schedule.pinHash && (manualLock ||
      (schedule.enabled && S.getStatus(schedule, trustedDate()).state === 'blocked'))));
    if (shouldFailClosed) {
      try {
        showBlockWindows(buildStatus());
        registerBlockShortcuts();
        finishEnforcement('blocked', err);
      } catch (fallbackError) {
        finishEnforcement('error', fallbackError);
      }
    } else {
      finishEnforcement('error', err);
    }
    logEvent('enforcement-error', { error: String(err && err.message || err), failClosed: shouldFailClosed });
  } finally {
    enforceBusy = false;
  }
}

async function enforceCore() {
  const status = buildStatus();
  // נעילה ידנית חלה תמיד — גם אם האכיפה לפי הלוח מושבתת
  const blocked = !!(configurationFault || manualLock || (schedule.enabled && status.state === 'blocked'));
  // חסימת אינטרנט בלבד — מחשב פתוח, רשת חסומה (לא במקביל לנעילה ידנית)
  const netblocked = !!(schedule.enabled && status.state === 'netblock' && !manualLock);
  const pinSet = !!schedule.pinHash;
  const activeBlock = blocked && (pinSet || !!configurationFault);
  const activeNet = netblocked && pinSet;
  const desired = activeBlock ? 'blocked' : activeNet ? 'netblocked' : 'allowed';
  beginEnforcement(desired);

  // אזהרה לפני חסימה — פעם אחת בכניסה לחלון האזהרה, ולא בזמן נעילה ידנית.
  if (status.warning && pinSet && !manualLock && !lastWarningActive) {
    lastWarningActive = true;
    logEvent('warning-start');
    showWarningNotification(status);
  } else if ((!status.warning || manualLock) && lastWarningActive) {
    lastWarningActive = false;
  }

  if (blocked !== lastBlockedState) {
    logEvent(blocked ? 'block-start' : 'block-end', { desired });
    lastBlockedState = blocked;
  }
  if (netblocked !== lastNetActive) {
    logEvent(netblocked ? 'netblock-start' : 'netblock-end', { desired });
    lastNetActive = netblocked;
  }

  // בנעילה ידנית מציגים את מסך החסימה לפני המתנה להסרת חוק רשת ישן;
  // כך אין חלון פתוח בזמן שפקודת Firewall מתחלפת.
  if (activeBlock && manualLock) {
    showBlockWindows(status);
    registerBlockShortcuts();
  }
  // ה-Reconciliation הוא חלק מהמעבר עצמו — לא מדווחים מצב יציב לפני
  // שהפעולה האסינכרונית של Firewall הסתיימה. אם אין חוק ואין פעולה ברקע,
  // מדלגים על Promise ריק כדי שנעילה ידנית תהיה מיידית.
  if (activeNet || netBlockApplied || netOperation || netDesired) {
    await reconcileNetBlock(activeNet);
  } else {
    netDesired = false;
  }
  showNetIcon(activeNet && netBlockApplied);
  const publish = () => {
    const current = buildStatus();
    if (tray) updateTray(current);
    if (win && !win.isDestroyed()) win.webContents.send('status', current);
    blockWins.forEach((bw) => { if (bw && !bw.isDestroyed()) bw.webContents.send('status', current); });
  };

  if (!activeBlock) {
    manualLock = false;
    exitRelaxed();
    hideBlockWindows();
    unregisterBlockShortcuts();
    finishEnforcement(activeNet && netBlockApplied ? 'netblocked' : 'allowed',
      activeNet && !netBlockApplied ? 'חוק חסימת האינטרנט לא הופעל' : null);
    publish();
    return;
  }

  // תוכנות תורניות מותרות: במצב זה מסך החסימה מוסתר, אך ה-State Machine
  // מדווח relaxed ולא blocked כדי שה-UI וה-Diagnostics ידעו מה קורה בפועל.
  const fgAllowed = (!manualLock && schedule.allowedAppsEnabled !== false && (schedule.allowedApps || []).length > 0)
    ? await isAllowedApp(await getForegroundApp())
    : false;
  if (fgAllowed) {
    enterRelaxed();
    finishEnforcement('relaxed');
    publish();
    return;
  }
  exitRelaxed();
  showBlockWindows(status);
  registerBlockShortcuts();
  finishEnforcement('blocked');
  publish();
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
const protectedManifestFile = () => path.join(protectedAppDir(), 'integrity.json');
function integrityTargets(dir) {
  const candidates = [
    sourceExecutable(dir),
    packageJsonPath(dir),
    path.join(dir, 'resources', 'app.asar'),
    path.join(dir, 'resources', 'app', 'main.js'),
    path.join(dir, 'resources', 'app', 'preload.js'),
    path.join(dir, 'resources', 'app', 'scheduler.js')
  ];
  const seen = new Set();
  return candidates.filter((file) => {
    if (!file || seen.has(file) || !fs.existsSync(file)) return false;
    seen.add(file);
    return fs.statSync(file).isFile();
  });
}
function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}
function buildIntegrityManifest(dir) {
  return {
    version: appVersion(),
    files: integrityTargets(dir).map((file) => {
      const st = fs.statSync(file);
      return {
        path: path.relative(dir, file),
        size: st.size,
        mtimeMs: st.mtimeMs,
        sha256: sha256File(file)
      };
    })
  };
}
function writeProtectedManifest() {
  if (!isWin || !fs.existsSync(protectedAppDir())) return;
  try {
    atomicWrite(protectedManifestFile(), JSON.stringify(buildIntegrityManifest(protectedAppDir()), null, 2));
  } catch { /* העותק עדיין אינו שלם */ }
}
function verifyIntegrityManifest(dir, manifest) {
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) return false;
  try {
    return manifest.files.every((entry) => {
      const file = path.resolve(dir, entry.path);
      const root = path.resolve(dir) + path.sep;
      if (!file.startsWith(root) || !fs.existsSync(file)) return false;
      const st = fs.statSync(file);
      if (!st.isFile() || st.size !== entry.size) return false;
      // mtime הוא בדיקת cheap path; Hash הוא מקור האמת כשמטא-דאטה השתנה.
      if (Number(st.mtimeMs) === Number(entry.mtimeMs)) return true;
      return sha256File(file) === String(entry.sha256 || '').toLowerCase();
    });
  } catch { return false; }
}
function protectedCopyIntegrity() {
  try {
    const manifest = JSON.parse(fs.readFileSync(protectedManifestFile(), 'utf8'));
    return verifyIntegrityManifest(protectedAppDir(), manifest);
  } catch { return false; }
}
function installDirMatchesProtectedManifest(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(protectedManifestFile(), 'utf8'));
    return verifyIntegrityManifest(dir, manifest);
  } catch { return false; }
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
    if (fs.existsSync(sourceExecutable(dst)) && appVersion() && appVersion() === protectedVersion() && protectedCopyIntegrity()) {
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
    writeProtectedManifest();
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
const GUARD_REG_KEY = 'HKLM\\Software\\BenHazmanim';
function saveInstallInfo() {
  try {
    // תהליך שהופעל מהעותק המוגן חייב לשמור על נתיב ההתקנה המקורי.
    if (isProtectedRuntime()) {
      const existing = installInfo();
      if (existing && existing.dir && path.resolve(existing.dir) !== path.resolve(protectedAppDir())) return;
      return;
    }
    const dir = installSourceDir();
    const info = { exe: sourceExecutable(dir), dir };
    fs.mkdirSync(machineDir(), { recursive: true });
    fs.writeFileSync(path.join(machineDir(), 'install.json'), JSON.stringify(info), 'utf8');
    if (isWin && isElevated()) {
      execFile('reg', ['add', GUARD_REG_KEY, '/v', 'InstallDir', '/t', 'REG_SZ', '/d', dir, '/f'], () => {});
    }
  } catch { /* ignore */ }
}
function installInfo() {
  try { return JSON.parse(fs.readFileSync(path.join(machineDir(), 'install.json'), 'utf8')); } catch { /* continue to registry */ }
  if (!isWin) return null;
  try {
    const out = execFileSync('reg', ['query', GUARD_REG_KEY, '/v', 'InstallDir'], { encoding: 'utf8', windowsHide: true });
    const m = String(out || '').match(/InstallDir\s+REG_SZ\s+(.+)\r?\n?/i);
    if (m && m[1].trim()) {
      const dir = m[1].trim();
      return { dir, exe: sourceExecutable(dir) };
    }
  } catch { /* no registry marker */ }
  return null;
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

// Renderer pages share the same preload bridge, so authentication must also
// bind each sensitive operation to the BrowserWindow that is allowed to call
// it. The missing sender in the Electron test double is intentionally treated
// as trusted for backwards-compatible unit tests only.
function senderAllowed(event, windows) {
  if (!event || !event.sender) return true;
  return windows.some((w) => w && !w.isDestroyed() && w.webContents === event.sender);
}
function mainSender(event) { return senderAllowed(event, [win]); }
function blockSender(event) { return senderAllowed(event, blockWins); }
function quitSender(event) { return senderAllowed(event, [quitWin]); }
function senderError() { return { ok: false, error: 'בקשת IPC אינה מורשית מהחלון הנוכחי' }; }
function uiSender(event) { return senderAllowed(event, [win, ...blockWins, quitWin, netIconWin]); }
function settingsSender(event) { return senderAllowed(event, [win, ...blockWins, netIconWin]); }
function recoverySender(event) { return senderAllowed(event, [win, ...blockWins]); }

function registerIpc() {
  ipcMain.handle('settings:get', (event) => {
    if (!senderAllowed(event, [win, ...blockWins])) return senderError();
    // passwordPlain/passwordEnc לא מועברים לממשק — נדרשים רק בתהליך הראשי לשחזור
    const safe = { ...schedule };
    delete safe.pinHash;
    delete safe.passwordPlain;
    delete safe.passwordEnc;
    return {
      ...safe,
      pinSet: !!schedule.pinHash,
      configError: !!configurationFault,
      sessionUnlocked: schedule.pinHash ? sessionUnlocked : true
    };
  });

  ipcMain.handle('settings:save', (event, data) => {
    if (!mainSender(event)) return senderError();
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
    // "פתוח עד המעבר הבא" (manualUnlockUntil) שייך ללוח שקבע אותו. אחרי כל
    // שמירת הגדרות מסנכרנים אותו עם הלוח החדש — רק אם כבר קיימת פתיחה
    // (הפתיחה נקבעת אך ורק ע"י הזנת סיסמה במסך החסימה, לא אוטומטית):
    // אם הלוח כבר לא חוסם — מנקים (מניעת "המעבר הבא" פנטום אחרי מחיקת
    // חלונות); אם הוא חוסם — מעדכנים למעבר הבא האמיתי של הלוח הנוכחי (כך
    // פתיחה "עד המעבר הבא" לא מחזיקה את המחשב פתוח מעבר לחלון החדש).
    const now = trustedDate();
    const raw = S.stateAt(schedule, now);
    if (raw === 'blocked' || raw === 'netblock') {
      if (schedule.manualUnlockUntil) {
        // ערך שעבר אינו תקף — הפתיחה כבר פגה. ניקוי שלו חיוני: אחרת פתיחה
        // חוזרת (unlock:now) הייתה ממשיכה להישען על הערך הישן ולא נפתחת.
        if (schedule.manualUnlockUntil <= now.getTime()) {
          schedule.manualUnlockUntil = null;
        } else {
          const t = S.nextTransition(schedule, now);
          if (t.at) schedule.manualUnlockUntil = t.at.getTime();
          // לוח נעול בלי מעבר מוגדר (למשל "התר" ריק) — שומרים את הערך הקיים
        }
      }
    } else if (schedule.manualUnlockUntil) {
      schedule.manualUnlockUntil = null;
    }
    const res = saveSettings();
    if (res.ok) configurationFault = null;
    logEvent('settings', { ok: !!res.ok });
    enforce();
    return res.ok ? { ok: true, warning: res.warning || null } : { ok: false, error: res.error || 'שמירה נכשלה' };
  });

  ipcMain.handle('status:get', (event) => {
    if (!uiSender(event)) return senderError();
    return buildStatus();
  });

  // שינוי רקע מסך החסימה — מתוך מסך החסימה עצמו (כפתור "רקע").
  // שינוי קוסמטי בלבד — אינו דורש סיסמה, והמשתמש יכול לבחור את הרקע
  // שמעניין אותו בזמן החסימה. השמירה מתבצעת בהגדרות המשותפות.
  ipcMain.handle('block:set-bg', (event, bg) => {
    if (!blockSender(event)) return senderError();
    const valid = ['blobs', 'fluid', 'particles', 'aurora'];
    const b = String(bg || '');
    if (!valid.includes(b)) return { ok: false, error: 'רקע לא ידוע' };
    const previous = schedule.blockBg;
    schedule.blockBg = b;
    const persisted = saveSettings();
    if (!persisted.ok) {
      schedule.blockBg = previous;
      return { ok: false, error: persisted.error || 'שמירת הרקע נכשלה' };
    }
    enforce(); // מפיץ את הסטטוס החדש (עם blockBg) לכל חלונות החסימה
    return { ok: true };
  });

  // בדיקת קובץ תוכנה ובניית רשומת האימות — משותפת לבחירה מהמחשב (בורר
  // הקבצים) ולסריקה האוטומטית (נתיב שנמצא). חותם דיגיטלי (מצב + מוציא לאור),
  // שם מוצר וטביעת SHA-256 — כדי לקבוע את מצב האימות (publisher לתוכנה
  // חתומה, path+hash לתוכנה לא חתומה).
  async function inspectPickPath(p) {
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
  }

  // בחירת תוכנת לימוד מהמחשב — בורר קבצים (.exe). מיד בוחרים את הקובץ נבדק:
  ipcMain.handle('allowed-apps:pick', async (event) => {
    if (!mainSender(event)) return senderError();
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
    return await inspectPickPath(res.filePaths[0]);
  });

  // סריקה אוטומטית — איתור תוכנות תורניות מוכרות המותקנות במחשב
  ipcMain.handle('allowed-apps:detect', async (event) => {
    if (!mainSender(event)) return senderError();
    if (!isWin) return { ok: false, error: 'זמין רק בווינדוס' };
    const apps = await detectKnownApps();
    return { ok: true, apps };
  });

  // בדיקת נתיב שנמצא בסריקה — מחזיר את אותה רשומת אימות כמו הבחירה ידנית
  ipcMain.handle('allowed-apps:inspect-path', async (event, p) => {
    if (!mainSender(event)) return senderError();
    if (!isWin) return { ok: false, error: 'זמין רק בווינדוס' };
    const pp = String(p || '').trim();
    if (!pp || !fs.existsSync(pp)) return { ok: false, error: 'הקובץ לא נמצא — בחרו מחדש' };
    return await inspectPickPath(pp);
  });

  // פתיחת תוכנת לימוד מותרת מתוך מסך החסימה. השרת אינו סומך על אובייקט
  // שהגיע מה-Renderer: הוא מחפש את הרשומה בקובץ ההגדרות ומעביר רק אותה
  // למנוע ההפעלה.
  ipcMain.handle('allowed-apps:launch', (event, candidate) => {
    if (!blockSender(event)) return senderError();
    if (manualLock || !schedule.pinHash) {
      return { ok: false, error: 'פתיחת תוכנות אינה זמינה בזמן נעילה ידנית או ללא סיסמת הורה' };
    }
    const st = S.getStatus(schedule, trustedDate());
    if (!schedule.enabled || st.state !== 'blocked') {
      return { ok: false, error: 'פתיחת תוכנות מורשות זמינה רק בזמן חסימת מחשב' };
    }
    const requested = String(candidate && candidate.exe || '').trim().toLowerCase();
    const allowed = (schedule.allowedApps || []).find((a) => String(a.exe || '').trim().toLowerCase() === requested);
    if (!allowed) return { ok: false, error: 'התוכנה אינה נמצאת ברשימת ההרשאות' };
    return launchAllowedApp(allowed);
  });

  ipcMain.handle('lock:now', async (event) => {
    if (!mainSender(event)) return senderError();
    // נעילה ידנית: מפעילה את מסך החסימה המלא של בין הזמנים על כל המסכים
    // (ולא רק את נעילת Windows הרגילה). הפתיחה מתבצעת עם סיסמה.
    if (!schedule.pinHash) {
      return { ok: false, error: 'לא הוגדרה סיסמה — הגדירו סיסמה בהגדרות לפני נעילה ידנית' };
    }
    manualLock = true;
    await enforce();
    logEvent('lock-manual');
    return { ok: true };
  });

  ipcMain.handle('unlock:now', (event, pin) => {
    if (!blockSender(event)) return senderError();
    if (configurationFault) {
      return { ok: false, error: 'לא ניתן לפתוח עד לתיקון קובץ ההגדרות' };
    }
    // ללא סיסמה מוגדרת אין מה לאמת — הפתיחה מתאפשרת תמיד, כדי שלעולם לא
    // יהיה מצב של חסימה בלי דרך החוצה (גם אם חלון חסימה נפתח בהיעדר סיסמה).
    if (!schedule.pinHash) {
      manualLock = false;
      const st = S.getStatus(schedule, trustedDate());
      schedule.manualUnlockUntil = isLockedState(st)
        ? (st.nextAt ? st.nextAt.getTime() : trustedNow() + 3600 * 1000)
        : null;
      const persisted = saveSettings();
      enforce();
      return persisted.ok
        ? { ok: true }
        : { ok: true, warning: persisted.error || 'הפתיחה זמינה כעת אך לא נשמרה לדיסק' };
    }
    const v = verifyPinServer(pin);
    if (!v.ok) {
      logEvent('unlock-fail');
      return { ok: false, error: v.error, locked: v.locked || 0 };
    }
    logEvent('unlock-success');
    manualLock = false; // סיום נעילה ידנית
    const now = trustedDate();
    const raw = S.stateAt(schedule, now);
    // "פתוח עד המעבר הבא" נשמר רק כשהמצב לפי הלוח הוא חסום (מחשב או
    // אינטרנט) — אחרת אין צורך. בדיקה לפי מצב הלוח הגולמי (ולא לפי הסטטוס
    // שכבר "פתוח"): פתיחה חוזרת בזמן שפתיחה קיימת לא מבטלת אותה.
    if (raw === 'blocked' || raw === 'netblock') {
      const t = S.nextTransition(schedule, now);
      if (t.at) {
        schedule.manualUnlockUntil = t.at.getTime();
      } else {
        // לוח נעול בלי מעבר הבא מוגדר (למשל מצב "התר" עם לוח ריק — חסום
        // תמיד): נותנים פתיחה לפרק זמן קבוע מעכשיו. חייב להיות ערך רענן —
        // ערך קיים שכבר עבר אינו פותח כלום (האכיפה רואה "הפתיחה פגה"), ופתיחה
        // "מוצלחת" הייתה משאירה את מסך החסימה על המסך לנצח.
        schedule.manualUnlockUntil = trustedNow() + 3600 * 1000;
      }
    } else {
      schedule.manualUnlockUntil = null;
    }
    const persisted = saveSettings();
    enforce();
    return persisted.ok
      ? { ok: true }
      : { ok: true, warning: persisted.error || 'הפתיחה זמינה כעת אך לא נשמרה לדיסק' };
  });

  ipcMain.handle('pin:set', (event, pin, oldPin) => {
    if (!mainSender(event)) return senderError();
    const newPin = String(pin || '');
    if (!S.isValidPassword(newPin)) return { ok: false, error: 'הסיסמה צריכה להיות 4-20 תווים ללא רווחים' };
    if (schedule.pinHash) {
      const v = verifyPinServer(oldPin);
      if (!v.ok) return { ok: false, error: v.error };
    }
    const previous = JSON.stringify(schedule);
    schedule.pinHash = S.sha256Hex(newPin);
    schedule.passwordPlain = null;
    schedule.passwordEnc = encryptPassword(newPin); // מוצפן — לצורך שחזור למייל בלבד
    // אם ההתקנה עבדה קודם ללא PIN והייתה פתיחה זמנית, לא משמרים אותה
    // לתוך המדיניות המוגנת החדשה.
    schedule.manualUnlockUntil = null;
    const persisted = saveSettings();
    if (!persisted.ok) {
      schedule = S.normalizeSchedule(JSON.parse(previous));
      return { ok: false, error: persisted.error || 'שמירת הסיסמה נכשלה' };
    }
    enforce();
    return { ok: true };
  });

  ipcMain.handle('pin:clear', (event, oldPin) => {
    if (!mainSender(event)) return senderError();
    if (schedule.pinHash) {
      const v = verifyPinServer(oldPin);
      if (!v.ok) return { ok: false, error: v.error };
    }
    const previous = JSON.stringify(schedule);
    schedule.pinHash = null;
    schedule.passwordPlain = null;
    schedule.passwordEnc = null;
    schedule.manualUnlockUntil = null;
    const persisted = saveSettings();
    if (!persisted.ok) {
      schedule = S.normalizeSchedule(JSON.parse(previous));
      return { ok: false, error: persisted.error || 'ניקוי הסיסמה נכשל' };
    }
    enforce();
    return { ok: true };
  });

  ipcMain.handle('pin:verify', (event, pin) => {
    if (!mainSender(event)) return senderError();
    return verifyPinServer(pin);
  });

  ipcMain.handle('session:get', (event) => {
    if (!mainSender(event)) return senderError();
    return { unlocked: schedule.pinHash ? sessionUnlocked : true };
  });

  ipcMain.handle('session:unlock', (event, pin) => {
    if (!mainSender(event)) return senderError();
    if (!schedule.pinHash) return { ok: true, unlocked: true };
    const v = verifyPinServer(pin);
    if (!v.ok) return { ok: false, unlocked: false, error: v.error, locked: v.locked || 0 };
    sessionUnlocked = true;
    return { ok: true, unlocked: true };
  });

  // נעילה מצד הממשק (למשל כשהחלון עבר לרקע): מחזירה את כל הפעולות
  // הרגישות (שמירת הגדרות, יציאה, הסרה) למצב הדורש סיסמה.
  ipcMain.handle('session:lock', (event) => {
    if (!mainSender(event)) return senderError();
    sessionUnlocked = false;
    return { ok: true };
  });

  ipcMain.handle('recovery:send', (event) => {
    if (!recoverySender(event)) return senderError();
    return sendRecovery();
  });

  ipcMain.handle('update:check', (event) => {
    if (!mainSender(event)) return senderError();
    return checkForUpdate();
  });

  ipcMain.handle('update:download', (event) => {
    if (!mainSender(event)) return Promise.resolve(senderError());
    if (schedule.pinHash && !sessionUnlocked) return Promise.resolve({ ok: false, error: 'נדרשת סיסמה כדי להתקין עדכון' });
    return downloadAndInstallUpdate();
  });

  ipcMain.handle('shell:open', (event, url) => {
    if (!mainSender(event)) return senderError();
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('app:quit', async (event, pin) => {
    if (!quitSender(event)) return senderError();
    // יציאה דורשת אימות סיסמה בתהליך הראשי — מניעת עקיפת חסימה על ידי ילדים
    if (schedule.pinHash) {
      const v = verifyPinServer(pin);
      if (!v.ok) return { ok: false, error: v.error };
    }
    await gracefulQuit();
    return { ok: true };
  });

  ipcMain.handle('app:uninstall', async (event, pin) => {
    if (!mainSender(event)) return senderError();
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
    await reconcileNetBlock(false);
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
    await gracefulQuit();
    return { ok: true };
  });

  ipcMain.handle('quit:cancel', (event) => {
    if (!quitSender(event)) return senderError();
    if (quitPromptOpen()) quitWin.destroy();
    return { ok: true };
  });
  // התאמת חלון היציאה לתוכן — החלון חסר מסגרת ולכן גודלו נקבע לפי ההודעה,
  // כך שכל התוכן נראה תמיד, בהתאמה למסך.
  ipcMain.handle('quit:fit', (event, w, h) => {
    if (!quitSender(event)) return senderError();
    if (quitPromptOpen()) {
      const cw = Math.max(280, Math.min(Math.round(w) || 0, 640));
      const ch = Math.max(240, Math.min(Math.round(h) || 0, 800));
      quitWin.setContentSize(cw, ch);
      quitWin.center();
    }
    return { ok: true };
  });
  ipcMain.handle('app:version', (event) => {
    if (!uiSender(event)) return senderError();
    return app.getVersion();
  });
  ipcMain.handle('app:hide', (event) => {
    if (!mainSender(event)) return senderError();
    if (win && !win.isDestroyed()) win.hide(); // ה-hide נועל את הסשן
    return { ok: true };
  });

  // פתיחת חלון ההגדרות — ממסך החסימה או מהאייקון של חסימת הרשת
  ipcMain.handle('settings:open', (event) => {
    if (!settingsSender(event)) return senderError();
    showMainWindow();
    return { ok: true };
  });

  // עדכון צבע הרקע של החלונות כשערכת הנושא משתנה (מניעת הבזקים בטעינה)
  ipcMain.handle('theme:apply', (event, resolved) => {
    if (!senderAllowed(event, [win, ...blockWins])) return senderError();
    const light = resolved === 'light';
    const bg = light ? '#eef0f9' : '#0a0a14';
    if (win && !win.isDestroyed()) win.setBackgroundColor(bg);
    blockWins.forEach((bw) => { if (bw && !bw.isDestroyed()) bw.setBackgroundColor(bg); });
    return { ok: true };
  });

  // דשבורד: יומן פעילות + מצב ההגנה + גיבוי ושחזור
  ipcMain.handle('activity:get', (event, limit) => {
    if (!mainSender(event)) return senderError();
    return readActivity(Number(limit) || 1500);
  });

  ipcMain.handle('security:get', (event) => {
    if (!mainSender(event)) return senderError();
    let protectedCopy = false;
    try {
      const exe = sourceExecutable(protectedAppDir());
      protectedCopy = isWin && fs.existsSync(exe) && appVersion() && appVersion() === protectedVersion() && protectedCopyIntegrity();
    } catch { /* ignore */ }
    return {
      pin: !!schedule.pinHash,
      enabled: schedule.enabled !== false,
      elevated: isElevated(),
      shared: isWin && fs.existsSync(machineSettingsFile()),
      recovery: !!schedule.recoveryEmail,
      netElevated: isElevated(),
      // גם תהליך רגיל יכול להפעיל את חוק הרשת באמצעות אישור UAC נקודתי.
      netUac: isWin,
      netActive: netBlockApplied,
      protectedCopy,
      lastTamper: lastTamper()
    };
  });

  ipcMain.handle('backup:export', async (event) => {
    if (!mainSender(event)) return senderError();
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

  ipcMain.handle('backup:import', async (event) => {
    if (!mainSender(event)) return senderError();
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
      const previous = JSON.stringify(schedule);
      schedule = S.normalizeSchedule(merged);
      const persisted = saveSettings();
      if (!persisted.ok) {
        schedule = S.normalizeSchedule(JSON.parse(previous));
        return { ok: false, error: persisted.error || 'שמירת הגיבוי נכשלה' };
      }
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

// דגלי העצירה וההפעלה מחדש נכתבים/נבדקים בכמה נתיבים, כדי שהמתקין והאפליקציה
// ימצאו תמיד זה את זה גם כששם המוצר משתנה בין package.json לבין build config,
// וגם כשסביבת המשתמש של האפליקציה ושל המתקין שונה (למשל הרצה מוגבהת):
//   1) userData של האפליקציה (הנתיב הקבוע שלה, לפי productName המלא)
//   2) %APPDATA%\BenHazmanim — נתיב ASCII יציב שה-NSIS כותב אליו.
//   3) %PROGRAMDATA%\BenHazmanim — נתיב משותף לכל המשתמשים; אותו נתיב שבו
//      כבר נשמר quit.flag עבור שומר-השער המערכתי. כך גם אם $APPDATA של
//      המתקין שונה משל האפליקציה (הרמה מוגבהת / סביבות שונות) — דגל ההפעלה
//      מחדש נמצא ונפתח, וההתקנה לא "משאירה" את התוכנה סגורה.
const flagPaths = (name) => {
  const paths = [path.join(stateDir(), name)];
  if (isWin && process.env.APPDATA) paths.push(path.join(process.env.APPDATA, 'BenHazmanim', name));
  if (isWin) paths.push(path.join(machineDir(), name));
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
  if (isWin && isElevated()) {
    try {
      execFile('reg', ['add', GUARD_REG_KEY, '/v', 'Quit', '/t', 'REG_SZ', '/d', String(Date.now()), '/f'], () => {});
    } catch { /* ignore */ }
  }
}
function clearQuitFlags() {
  for (const p of quitFlagPaths()) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  // דגל עצירה של השומר-השער המערכתי (קובץ + Registry) — מתנקה באתחול חדש,
  // כדי שהשומר לא ייצא על דגל ישן מתקינה/עדכון קודמים.
  try { fs.unlinkSync(machineQuitFlag()); } catch { /* ignore */ }
  if (isWin && isElevated()) {
    try { execFile('reg', ['delete', GUARD_REG_KEY, '/v', 'Quit', '/f'], () => {}); } catch { /* ignore */ }
  }
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
    recordClockSample();
    reloadSettingsIfChanged();
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
  // settings.json או אפילו כל תיקיית ProgramData אינה סיבה לצאת — אחרת
  // מנהל יכול לעצור את מנגנון השחזור פשוט במחיקה.
  if (fs.existsSync(machineQuitFlag())) return true;
  try {
    const out = execFileSync('reg', ['query', GUARD_REG_KEY, '/v', 'Quit'], { encoding: 'utf8', windowsHide: true });
    return /\bQuit\s+REG_\w+\s+/i.test(String(out || ''));
  } catch { return false; }
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
    fs.mkdirSync(machineDir(), { recursive: true });
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
  const dstCoreExists = fs.existsSync(sourceExecutable(dst)) && fs.existsSync(packageJsonPath(dst));
  // התקנות ישנות ללא Manifest עדיין יכולות להישמר: אם קבצי הליבה קיימים,
  // חותמים את העותק הנוכחי פעם אחת במקום למחוק גם את settings.backup.json.
  if (dstCoreExists && !fs.existsSync(protectedManifestFile())) writeProtectedManifest();
  const dstOk = dstCoreExists && protectedCopyIntegrity();
  if (srcOk && !dstOk) {
    logTamper('protected-copy-restored');
    try {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(dst, { recursive: true });
      fs.cpSync(info.dir, dst, { recursive: true });
      writeProtectedManifest();
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
  const dstOk = fs.existsSync(sourceExecutable(info.dir)) && fs.existsSync(packageJsonPath(info.dir)) && installDirMatchesProtectedManifest(info.dir);
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
      fs.mkdirSync(machineDir(), { recursive: true });
      writeHeartbeat(guardHbFile());
      // קודם משחזרים את העותק שממנו השומר עצמו יכול להמשיך לעבוד,
      // ורק אחר כך את ההתקנה/ההגדרות התלויות בו.
      await restoreProtectedCopy();
      restoreInstallDir();
      restoreSharedSettings();
      ensureGuardTasks();
    } finally {
      checking = false;
    }
  };
  setInterval(() => { check().catch(() => {}); }, 10000);
  await check();
}

async function gracefulQuit() {
  isQuitting = true;
  logEvent('app-quit');
  writeQuitFlag(); // בכל הנתיבים — כדי שהמתקין/השומר יראו את דגל העצירה
  if (ownWatchdogPid && isProcessAlive(ownWatchdogPid)) {
    try { process.kill(ownWatchdogPid); } catch { /* ignore */ }
  }
  // במסלול רגיל אין צורך להמתין ל-Promise ריק; כאשר קיים חוק או פעולה
  // בתהליך, ממתינים להסרה בפועל לפני יציאה.
  if (netBlockApplied || netOperation || netDesired) {
    try { await reconcileNetBlock(false); } catch (err) {
      logEvent('netblock-quit-error', { error: String(err && err.message || err) });
    }
  }
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

      // Wake הוא גבול Session: אין להמתין ל-Timer הישן לאחר Sleep/Hibernate.
      // מבטלים cache ומריצים Reconciliation מיידי.
      if (powerMonitor && typeof powerMonitor.on === 'function') {
        powerMonitor.on('resume', () => { fgCache.at = 0; enforce(); });
        powerMonitor.on('unlock-screen', () => { fgCache.at = 0; enforce(); });
      }

      loadClockState();
      loadSettings();
      loadPinLock(); // טעינת נעילה זמנית קיימת (אינה מתאפסת בהרצה מחדש)
      registerIpc();
      // סנכרון עם חוק חומת האש הקיים (אם נשאר מסשן קודם) — כך שהאכיפה
      // תפעיל/תסיר אותו לפי הלוח הנוכחי כבר מהבדיקה הראשונה.
      await reconcileNetBlockOnStartup();
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
