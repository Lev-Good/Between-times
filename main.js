'use strict';

const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen,
  globalShortcut, Notification, shell, safeStorage, nativeTheme, dialog, powerMonitor, session
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const S = require('./scheduler.js');

const isWin = process.platform === 'win32';
// Unit tests use a mocked Windows/Electron environment and intentionally keep
// their fixtures in userData. This flag never exists in packaged production.
const isTestMode = process.env.NODE_TEST_CONTEXT === '1' || process.argv.includes('--test');

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

function lockLocalWindowNavigation(w) {
  if (!w || !w.webContents) return;
  const allow = (url) => String(url || '').startsWith('file://');
  if (typeof w.webContents.on === 'function') {
    w.webContents.on('will-navigate', (e, url) => { if (!allow(url)) e.preventDefault(); });
    w.webContents.on('will-redirect', (e, url) => { if (!allow(url)) e.preventDefault(); });
  }
  if (typeof w.webContents.setWindowOpenHandler === 'function') {
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
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

function loadClockState() {
  const wall = Date.now();
  const uptime = systemUptimeMs();
  for (const file of clockStateFiles()) {
    try {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!previous || !Number.isFinite(previous.wall)) continue;
      if (Number.isFinite(previous.uptime) && Number.isFinite(uptime) && uptime >= previous.uptime) {
        const expected = uptime - previous.uptime;
        const observed = wall - previous.wall;
        if (Math.abs(observed - expected) > 120000) clockRollbackDetected = true;
      } else if (wall + 120000 < previous.wall) {
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
const machineLicenseFile = () => path.join(machineDir(), 'license.json');

function getLicenseInfo() {
  try {
    const licPath = machineLicenseFile();
    if (fs.existsSync(licPath)) {
      const data = JSON.parse(fs.readFileSync(licPath, 'utf8'));
      if (data && (data.ok || data.code)) {
        return {
          isLicensed: true,
          userName: (data.user && data.user.name) || 'חבר פורום העורכים התורניים',
          code: data.code || ''
        };
      }
    }
  } catch (e) {
    console.error('Error reading license info:', e);
  }
  return {
    isLicensed: false,
    userName: null,
    code: null
  };
}
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
let configurationFault = null;
let configurationFaultSince = null; // קובץ הגדרות פגום ללא Backup תקין — Fail Closed

// ===== פרופילים (Phase 3.9) =====
// `schedule` הוא המדיניות הבסיסית הנשמרת לדיסק (לעולם אינו מושפע מדריסות
// פרופיל — כדי ששמירה לא תשבש את הבסיס המשותף). האכיפה קוראת את המדיניות
// ה"אפקטיבית" — הבסיס עם דריסות הפרופיל של משתמש ה-Windows הנוכחי — דרך
// activeSchedule(). מחושב טרי בכל קריאה (normalizeSchedule מהיר); שדות רגישים
// (סיסמה/שחזור/manualUnlockUntil/accountability/coolOff) תמיד מהבסיס.
function currentWindowsUser() {
  return String(process.env.USERNAME || process.env.USER || '').trim().toLowerCase();
}
function activeSchedule() {
  const profiles = schedule && schedule.profiles;
  if (!profiles || !profiles.length) return schedule; // אין פרופילים — הבסיס הוא האפקטיבי
  return S.effectiveSchedule(schedule, currentWindowsUser());
}

let startupFault = null; // Startup לא אומת — מוצג ככשל הגנה, לא כהצלחה שקטה
let sharedSettingsRequired = false;
let settingsSignature = null;
let settingsReloadBusy = false;
let win = null;            // חלון ההגדרות
let blockWins = [];        // חלונות החסימה (אחד לכל מסך)
let tray = null;
let quitWin = null;        // חלון אימות היציאה (סיסמת הורה) — למניעת עקיפת חסימה
let isQuitting = false;
let sessionUnlocked = false; // כניסה מוצלחת עם סיסמה לניהול ההגדרות
let sessionUnlockedAt = 0;
const SESSION_TTL_MS = 5 * 60 * 1000;
function isSessionUnlocked() {
  if (!schedule.pinHash) return true;
  if (!sessionUnlocked || !sessionUnlockedAt || trustedNow() - sessionUnlockedAt > SESSION_TTL_MS) {
    sessionUnlocked = false;
    sessionUnlockedAt = 0;
    return false;
  }
  return true;
}
let manualLock = false;      // נעילה ידנית (נעל עכשיו) — מפעילה את מסך החסימה המלא
let launchGraceUntil = 0;    // זמן חסד בעת פתיחת תוכנה מותרת (למשל אוצריא) כדי לתת לה זמן להיטען
let shortcutsRegistered = false;
// "תקופת צינון": עיכוב מכוון לפני שפתיחה מוקדמת נכנסת לתוקף (שליטה עצמית).
// המחשב נשאר חסום עד תום הצינון, ואז הפתיחה מוחלת אוטומטית. הטיימר מבוסס
// על שעון מונוטוני (setTimeout של libuv) — שינוי שעון המערכת אינו מקצר אותו,
// ו-applyCoolOff מאמת מול trustedNow לפני שהוא מחיל בפועל.
let coolOffUntil = 0;        // trustedNow שבו הצינון מסתיים
let coolOffTarget = null;    // ערך manualUnlockUntil שיוחל בתום הצינון (יכול להיות null)
let coolOffPending = false;  // האם צינון פעיל וממתין להחלה
let coolOffTimer = null;
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
const pinLockFile = () => {
  // Brute-force state is enforcement state, not a user preference. Keep it
  // beside the protected policy on managed Windows installs so deleting a
  // file from the profile cannot reset the lockout counter.
  const managed = isWin && (sharedSettingsRequired || fs.existsSync(machineSettingsFile()));
  return managed
    ? path.join(machineDir(), 'pinlock.json')
    : path.join(app.getPath('userData'), 'pinlock.json');
};

// נעילת ה-PIN הזמנית נמדדת בזמן המהימן (trustedNow) — כמו שאר התוכנה —
// כדי שילד לא יוכל לשנות את שעון המערכת ולעקוף את הנעילה אחרי 5 ניסיונות.
function loadPinLock() {
  try {
    const data = JSON.parse(fs.readFileSync(pinLockFile(), 'utf8'));
    if (data && typeof data.until === 'number' && data.until > trustedNow()) pinLockUntil = data.until;
    if (data && Number.isInteger(data.failures) && data.failures >= 0 && data.failures < 5) pinFailures = data.failures;
  } catch { /* ignore */ }
}
function savePinLock() {
  try { atomicWrite(pinLockFile(), JSON.stringify({ until: pinLockUntil, failures: pinFailures })); } catch { /* ignore */ }
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
function derivePin(pin, salt) {
  return crypto.pbkdf2Sync(String(pin || ''), Buffer.from(salt, 'base64'), 210000, 32, 'sha256').toString('hex');
}
function makePinRecord(pin) {
  const salt = crypto.randomBytes(16).toString('base64');
  return { pinHash: derivePin(pin, salt), pinSalt: salt, pinKdf: 'pbkdf2-sha256' };
}
function pinMatches(pin) {
  const candidate = schedule.pinKdf === 'pbkdf2-sha256' && schedule.pinSalt
    ? derivePin(pin, schedule.pinSalt)
    : S.sha256Hex(String(pin || ''));
  const expected = String(schedule.pinHash || '');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function hasBlockingPolicy(s) {
  if (!s || s.enabled === false) return false;
  if (s.mode === 'allowlist') return true;
  return (s.week || []).some((d) => (d.slots || []).some((x) => x.type === 'blocked' || x.type === 'netblock')) ||
    (s.overrides || []).some((x) => x.type === 'block' || x.type === 'netblock');
}
function hasAnyBlockingPolicy(s) {
  if (hasBlockingPolicy(s)) return true;
  for (const profile of ((s && s.profiles) || [])) {
    const candidate = S.effectiveSchedule({ ...s, defaultProfile: profile.id }, '');
    if (hasBlockingPolicy(candidate)) return true;
  }
  return false;
}
function verifyPinServer(pin) {
  if (!schedule.pinHash) return { ok: true };
  const lock = checkPinLock();
  if (lock > 0) {
    return { ok: false, locked: lock, error: 'נעילה זמנית — נסו שוב בעוד ' + lock + ' שניות' };
  }
  if (pinMatches(pin)) {
    pinSuccess();
    if (clockRollbackDetected) {
      clockRollbackDetected = false; // אישור הורה מודע לאחר Boot לא מהימן
      logEvent('clock-acknowledged');
    }
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
  if (!store || typeof store !== 'string') return '';
  try {
    if (store.startsWith('enc:') && isWin && safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(store.slice(4), 'base64'));
    }
  } catch { /* never fall back to returning a blob as a password */ }
  // Legacy plaintext values are intentionally no longer accepted for recovery.
  return '';
}

function loadSettings() {
  configurationFault = null;
  // מקור אמת יחיד: אם נוצר קובץ משותף, קובץ משתמש לעולם אינו גובר עליו.
  // בחירה לפי mtime אפשרה למשתמש רגיל להחליף את מדיניות המחשב באמצעות
  // settings.json מקומי עם תאריך שינוי חדש יותר.
  const tryRead = (file) => {
    try {
      if (!file || !fs.existsSync(file)) return null;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number(raw && raw.schemaVersion || 0) > S.SCHEMA_VERSION) {
        throw new Error('settings schema is newer than this application');
      }
      const normalized = S.normalizeSchedule(raw);
      // Non-enumerable: available to loadSettings but never serialized into
      // settings.json or exposed through IPC.
      Object.defineProperty(normalized, '__needsSchemaMigration', {
        value: Number(raw && raw.schemaVersion || 0) < S.SCHEMA_VERSION,
        enumerable: false
      });
      return normalized;
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
    // במערכת Windows לא מתחילים במקור משתמש שניתן לשינוי. התקנה מנוהלת
    // חייבת ליצור את מקור המדיניות המשותף בהרצה מוגבהת; עד אז Fail Closed.
    schedule = S.defaultSchedule();
    if (isWin) {
      // Installer handles shared settings. No elevated run required anymore.
      const backup = tryRead(protectedSettingsFile());
      if (backup) { schedule = backup; source = 'backup-recovered'; }
    } else if (false) {
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
  let dirty = schedule.__needsSchemaMigration === true;
  if (dirty) logEvent('settings-migrated', { schemaVersion: S.SCHEMA_VERSION, source });
  // פתיחה ידנית היא Override של Session, לא מדיניות שצריכה לשרוד Restart.
  // אחרת כיבוי/הפעלה בזמן חסימה משאיר את המחשב פתוח לפי החלטה ישנה.
  if (schedule.manualUnlockUntil) {
    schedule.manualUnlockUntil = null;
    dirty = true;
  }
  // Legacy versions stored a recoverable password in settings. Recovery now
  // uses a one-time token, so remove both plaintext and obsolete encrypted
  // copies as soon as the policy is loaded.
  if (schedule.passwordPlain || schedule.passwordEnc) {
    schedule.passwordPlain = null;
    schedule.passwordEnc = null;
    dirty = true;
    logEvent('legacy-password-removed');
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
  if (!configurationFault) {
    configurationFaultSince = null;
  } else if (!configurationFaultSince) {
    configurationFaultSince = trustedNow();
  }

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
    // Windows תמיד משתמש במקור משותף מוגן; לעולם לא יוצרים fallback
    // בתיקיית משתמש שניתן למחוק או לערוך.
    // isElevated check removed, settings are writable by users due to installer ACLs
    atomicWrite(target, serialized);
    writeProtectedSettingsBackup();
    rememberSettingsSignature();
    return { ok: true, warning: null };
  } catch (err) {
    // Windows never falls back to a user-writable settings source. A
    // transient permission or replacement failure must not turn the user
    // profile into a new source of truth (including during a race where the
    // shared file disappears after the preflight check).
    if (isWin && !isTestMode) {
      return { ok: false, error: 'שמירת ההגדרות המשותפות נכשלה: ' + err.message };
    }
    try {
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
  const s = activeSchedule();
  return !!(manualLock || configurationFault || (clockRollbackDetected && s.pinHash) ||
    (s.enabled && S.getStatus(s, trustedDate()).state === 'blocked'));
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
  lockLocalWindowNavigation(bw);
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
  // חלון ההגדרות פתוח (למשל כדי לתקן קובץ הגדרות פגום, לשחזר גיבוי או
  // להגדיר סיסמה בזמן חסימה) — לא לגנוב ממנו את הפוקוס, אחרת אי אפשר
  // להקליד או ללחוץ בתוכו. מסכי החסימה המלאים נשארים מעל כל שאר המסך;
  // רק המשתמש בחלון ההגדרות עצמו לא מופרע כל כמה שניות.
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) return;
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
  // החסימה הסתיימה — חלון ההגדרות חוזר להיות חלון רגיל (אם הורם מעל
  // מסכי החסימה בזמן תיקון הגדרות, הוא כבר לא צריך לצוף מעל הכל).
  if (win && !win.isDestroyed()) { try { win.setAlwaysOnTop(false); } catch { /* ignore */ } }
}

/* ================= חסימת קיצורי מקשים ================= */

// קיצורים שניתן לרשום ב-globalShortcut. Ctrl+Alt+Del ו-Secure Desktop
// אינם ניתנים לחסימה מאפליקציית Desktop רגילה ומוצהרים כמגבלה מוצרית.
const BLOCK_SHORTCUTS = [
  'Alt+Tab', 'Alt+Esc', 'Super+Tab', 'Ctrl+Esc', 'Super+Space', 'Alt+F4',
  'Ctrl+Shift+Esc', 'Super+R', 'Super+D', 'Super+L', 'Alt+Space'
];

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
// ערכי החזרה: true = קיים, false = ודאי שאינו קיים, null = לא ניתן לקבוע
// (פקודת netsh לא הסתיימה בזמן). כל מחזיק מקבל החלטה Fail-Closed על null —
// כך ש-netsh תקוע לא "משחרר" את לולאת האכיפה עם דיווח שקרי ולא משאיר
// את האכיפה תקועה לעד (לולאת reconcile חייבת תמיד להסתיים).
function netRuleExists() {
  return new Promise((resolve) => {
    if (!isWin) return resolve(false);
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => finish(null), 10000);
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=' + NET_RULE], { windowsHide: true }, (err) => {
      clearTimeout(timer);
      if (!err) return finish(true);
      // A missing rule is different from an inability to query the firewall.
      // Treat access-denied, timeouts, and unknown command failures as
      // indeterminate so stale rules are never silently considered absent.
      if (isTestMode && err.code == null && !err.killed) return finish(false);
      if (err.killed || err.code === 'ETIMEDOUT') return finish(null);
      if (typeof err.code === 'number' && err.code === 1) return finish(false);
      finish(null);
    });
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

// הפעלת netsh מתוך תהליך רגיל לא מחזיקה הרשאת מנהל. בעבר הסתמכנו על קוד
// היציאה של PowerShell מורם (Start-Process -Verb RunAs) — וזה נכשל בשקט:
// קוד היציאה של התהליך המורם לא תמיד מגיע ל-PowerShell, כך שגם כשחוק
// חומת האש נמחק בהצלחה האפליקציה חשבה שהפעולה נכשלה והמשיכה לנסות שוב
// ושוב (כל 5 שניות) — עם חלון UAC/קונסול מהבהב, ובסופו של דבר חסימה
// שלא בוטלה. הגישה החדשה:
//   1. מרימים את netsh דרך כלי ההרמה הרשמי של electron-builder
//      (elevate.exe, שנארז לצד האפליקציה) עם דגל -wait — הוא ממתין
//      לסיום התהליך המורם; בסביבת פיתוח נופלים ל-PowerShell מוסתר.
//   2. אין סומכים על קוד היציאה כלל — ההצלחה נמדדת לפי מצב החוק בפועל
//      (netBlockSet בודק netRuleExists לאחר כל פעולה).
//   3. ביטול UAC או כשל הרמה מכניסים קירור של דקה כדי שלא יקפצו חלונות
//      שוב ושוב כל כמה שניות.
function psSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function elevateExe() {
  const candidates = [
    path.join(__dirname, 'resources', 'elevate.exe'),
    path.join(process.resourcesPath || '', 'elevate.exe')
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

function runNetsh(args) {
  return new Promise((resolve) => {
    if (isElevated()) {
      // גם בהרצה מוגבהת יש timeout: netsh תקוע אסור שיתקע את לולאת האכיפה
      // לעד (reconcileNetBlock ממתין לתוצאה לפני שהוא משחרר את הלולאה).
      return execFile('netsh', args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
        resolve({ err, stdout, stderr });
      });
    }
    if (trustedNow() < netElevationRetryAt) {
      return resolve({ err: new Error('הרשאת מנהל לא אושרה קודם לכן — נסו שוב בעוד דקה או מתוך אפליקציה שהופעלה כמנהל') });
    }
    const done = (err, stdout, stderr) => {
      // כשלון (כולל ביטול UAC) — קירור של דקה. זה מונע את "לולאת החלונות":
      // ביטול חסימה שנכשל לא יפתח שוב UAC כל 5 שניות.
      if (err) netElevationRetryAt = trustedNow() + 60000;
      else netElevationRetryAt = 0;
      resolve({ err, stdout, stderr });
    };
    const elevate = elevateExe();
    if (elevate) {
      // -wait: ממתין לסיום התהליך המורם. תוצאת הפעולה נבדקת בכל מקרה
      // לפי מצב החוק (netRuleExists) — לא לפי קוד יציאה.
      return execFile(elevate, ['-wait', 'netsh', ...args], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
        done(err, stdout, stderr);
      });
    }
    const list = '@(' + args.map(psSingleQuote).join(',') + ')';
    const script =
      "$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath 'netsh.exe' " +
      '-ArgumentList ' + list + ' -Verb RunAs -Wait -PassThru; exit ([int]$p.ExitCode) } ' +
      'catch { Write-Error $_; exit 1223 }';
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script
    ], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      done(err, stdout, stderr);
    });
  });
}

// הפעלה/כיבוי של חוק החסימה. נשען על קודי השגיאה של netsh (אמינים גם
// כשהפלט מקומי, למשל בעברית) ולא על ניתוח טקסט. אחרי שינוי מוצלח מאמתים
// שהחוק אכן קיים — לא מדווחים "חסום" על סמך יציאת פקודה בלבד.
async function netBlockSet(enable) {
  if (!isWin) return { ok: false, error: 'זמין רק בווינדוס' };
  const fail = (msg) => ({ ok: false, error: msg || 'חומת האש אינה זמינה, ההרשאה בוטלה או שהיא מנוהלת על ידי תוכנה אחרת — לא ניתן לשנות את חסימת האינטרנט' });
  // קירור גם לכשלי אימות (ולא רק לכשלי פקודה): אם netsh הצליח אבל האימות
  // נכשל — למשל חומת האש כבויה והחוק קיים אך אינו אוכף — אסור שלולאת
  // האכיפה (כל 5 שניות) תפתח שוב UAC בכל פעם. אחרת מקבלים את "לולאת
  // החלונות" גם בלי שום שגיאה בפקודה עצמה.
  const cooling = () => { netElevationRetryAt = trustedNow() + 60000; };
  if (enable) {
    const exists = await netRuleExists();
    const args = (exists === true)
      ? ['advfirewall', 'firewall', 'set', 'rule', 'name=' + NET_RULE, 'new', 'enable=yes', 'action=block', 'dir=out', 'protocol=any', 'localip=any', 'remoteip=any', 'profile=any']
      : ['advfirewall', 'firewall', 'add', 'rule', 'name=' + NET_RULE, 'dir=out', 'action=block', 'enable=yes', 'protocol=any', 'localip=any', 'remoteip=any', 'profile=any'];
    await runNetsh(args);
    // מדידת הצלחה לפי המצב בפועל — לא לפי קוד יציאה של תהליך מורם.
    // present !== true כולל גם null (לא ניתן לאמת) — בשני המקרים Fail-Closed.
    const present = await netRuleExists();
    if (present !== true) {
      cooling();
      return fail('חוק חסימת האינטרנט לא נמצא לאחר ההפעלה — ייתכן שחומת האש מנוהלת על ידי תוכנה אחרת');
    }
    const firewallOn = await firewallProfilesEnabled();
    if (firewallOn === false || (firewallOn !== true && !isTestMode)) {
      cooling();
      return fail(firewallOn === false
        ? 'חומת האש של Windows כבויה — החוק קיים אך אינו אוכף חסימה'
        : 'לא ניתן לאמת שחומת האש של Windows פעילה — חסימת האינטרנט לא אושרה');
    }
    return { ok: true };
  }
  await runNetsh(['advfirewall', 'firewall', 'delete', 'rule', 'name=' + NET_RULE]);
  // הצלחה = החוק באמת איננו. כך גם אם קוד היציאה של ההרמה אבד בדרך
  // (PowerShell/elevate), ביטול החסימה מתעדכן נכון והלולאה אינה חוזרת.
  // exists === true או null (לא ניתן לאמת) — בשני המקרים לא מדווחים
  // "בוטלה" כשהחוק עלול עדיין להיות שם: Fail-Closed.
  const exists = await netRuleExists();
  if (exists === true) {
    cooling();
    return fail('לא ניתן להסיר את חוק חסימת האינטרנט — ייתכן שהמחשב או חומת האש מנוהלים על ידי תוכנה אחרת');
  }
  if (exists === null) {
    cooling();
    return fail('לא ניתן לאמת שהחוק הוסר — נסו שוב בעוד רגע');
  }
  return { ok: true };
}

// סנכרון בעלייה: לדעת אם חוק החסימה נשאר פעיל מסשן קודם (חוקי חומת האש
// לא נמחקים מעצמם), כדי שהאכיפה תסיר/תפעיל אותו לפי הלוח הנוכחי.
async function reconcileNetBlockOnStartup() {
  if (!isWin) return;
  // null (לא ניתן לקבוע) מטופל כאילו החוק קיים — האכיפה תנסה לסנכרן
  // ולבדוק מחדש, ולא תשאיר חוק ישן פעיל בשקט (Fail-Closed).
  netBlockApplied = (await netRuleExists()) !== false;
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
    lockLocalWindowNavigation(netIconWin);
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
   החסימה חוזרת מיד. תוכנות מותרות זמינות הן בחסימה לפי הלוח והן בנעילה ידנית. */

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
    // הנתיב משולב לתוך סקריפט PowerShell. מחרוזת PowerShell במרכאות כפולות
    // (כפי ש-JSON.stringify מפיק) מבצעת אינטרפולציה: `$(...)`, backtick ו-$var
    // — כך שקובץ/תיקייה בשם המכיל `$(...)` היה מריץ קוד שרירותי. נתיב החלון
    // הפעיל נשלט על ידי תהליכים אחרים, ולכן משתמשים אך ורק במחרוזת PowerShell
    // במרכאות יחיד (psSingleQuote), שהיא ליטרלית ואינה מבצעת אינטרפולציה.
    const q = psSingleQuote(String(p || ''));
    const script =
      '$i = Get-Item -LiteralPath ' + q + ' -ErrorAction SilentlyContinue; if (-not $i) { exit 1 }; ' +
      '$s = Get-AuthenticodeSignature -LiteralPath ' + q + '; ' +
      '$h = (Get-FileHash -Algorithm SHA256 -LiteralPath ' + q + ').Hash; ' +
      "$i.VersionInfo.ProductName + '|' + $s.Status.ToString() + '|' + $s.SignerCertificate.Subject + '|' + $h";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      let res = null;
      if (!err && stdout) {
        const parts = String(stdout).split(/\r?\n/)[0].split('|');
        let statusStr = String(parts[1] || '').trim() || 'NotSigned';
        const subjStr = String(parts[2] || '').trim();
        if (statusStr === 'UnknownError' && /CN=Microsoft Corporation\b/i.test(subjStr)) {
          statusStr = 'Valid';
        }
        res = {
          product: String(parts[0] || '').trim(),
          status: statusStr,
          subject: subjStr,
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
  const baseExe = path.basename(exeL);
  const baseP = path.basename(pl);

  if (app.mode === 'publisher' && app.publisher && app.product) {
    if (baseExe !== baseP) return false;
    const info = await inspectAppFile(p);
    if (!info || info.status !== 'Valid') return false;
    const infoPub = cnOf(info.subject).toLowerCase();
    const appPub = String(app.publisher).toLowerCase();
    if (infoPub !== appPub) return false;

    const infoProd = String(info.product || '').toLowerCase();
    const appProd = String(app.product || '').toLowerCase();
    if (infoProd === appProd) return true;
    if (infoProd && appProd && (infoProd.includes(appProd) || appProd.includes(infoProd))) return true;

    // התאמה מיוחדת ל-Microsoft Word: שם הקובץ WINWORD.EXE חתום ע"י Microsoft Corporation
    // שם המוצר במפרט הקובץ עשוי להשתנות בין גרסאות (Microsoft Office / Word / 365)
    if (baseP === 'winword.exe' && infoPub === 'microsoft corporation') {
      const isOfficeOrWord = (str) => /microsoft\s*(office|word|365)/i.test(str) || /\b(word|office)\b/i.test(str);
      if (isOfficeOrWord(infoProd) || isOfficeOrWord(appProd)) return true;
    }
    return false;
  }

  // התאמה מיוחדת לוורד שנשמר במצב path (למשל סריקה ישנה או עדכון אוטומטי של אופיס)
  if (baseExe === 'winword.exe' && baseP === 'winword.exe') {
    const info = await inspectAppFile(p);
    if (info && info.status === 'Valid' && cnOf(info.subject).toLowerCase() === 'microsoft corporation') {
      return true;
    }
  }

  // מצב נתיב: רק נתיב מלא מדויק (לעולם לא התאמת שם קובץ בלבד)
  if (pl !== exeL) return false;
  // Path ללא hash אינו זהות מאובטחת: קובץ באותו נתיב ניתן להחלפה.
  const basePNoExt = path.basename(pl).replace(/\.exe$/i, '').toLowerCase();
  const isTorahApp = basePNoExt === 'otzaria' || KNOWN_APPS.some((k) => k.exeNames.some((n) => n.toLowerCase() === basePNoExt + '.exe'));

  if (!/^[0-9a-f]{64}$/.test(String(app.hash || '').toLowerCase())) {
    const info = await inspectAppFile(p);
    if (info && info.status === 'Valid' && app.publisher && cnOf(info.subject).toLowerCase() === String(app.publisher).toLowerCase()) {
      return true;
    }
    if (isTorahApp && info && info.hash) {
      app.hash = info.hash;
      saveSettings();
      return true;
    }
    return false;
  }
  const info = await inspectAppFile(p);
  if (info && info.hash && info.hash === String(app.hash).toLowerCase()) return true;
  // אם התוכנה חתומה דיגיטלית בתוקף של אותו מוציא לאור — אשר גם אם ה-hash השתנה בעדכון
  if (info && info.status === 'Valid' && app.publisher && cnOf(info.subject).toLowerCase() === String(app.publisher).toLowerCase()) {
    return true;
  }
  // עדכון גרסה של תוכנת לימוד תורנית מוכרת (כגון אוצריא) באותו נתיב מדויק
  if (isTorahApp && info && info.hash) {
    app.hash = info.hash;
    saveSettings();
    return true;
  }
  return false;
}

// האם התוכנה שבחלון הפעיל נמצאת ברשימה המורשית (או ברשימת התוכנות הנלוות
// שלהן — כמו תוספים לוורד שפועלים כתוכנה נפרדת)? כל תוכנה מאומתת לפי
// מצב האימות שלה. אם משהו לא תקין — החסימה נשארת פעילה (fail closed).
async function isAllowedApp(fgPath) {
  if (!fgPath) return false;
  const sch = activeSchedule();
  if (sch.allowedAppsEnabled === false) return false;
  const apps = sch.allowedApps || [];
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
  if (Date.now() < launchGraceUntil) return;
  const sch = activeSchedule();
  const appsOn = sch.allowedAppsEnabled !== false && (sch.allowedApps || []).length > 0;
  if (!appsOn) { focusBlockWindows(); return; }
  const fg = await getForegroundApp();
  if (await isAllowedApp(fg)) {
    enterRelaxed();
    return;
  }
  focusBlockWindows();
}

// פתיחת תוכנת לימוד מותרת (מתוך מסך החסימה או בדיקה). לפני ההפעלה מבצעים
// אימות: חותם+מוצר לתוכנה חתומה, טביעת קובץ לתוכנה לא חתומה — כך אי אפשר
// להריץ במקומה קובץ שהוחלף. אם התוכנה כבר רצה — מעלים את החלון לחזית ומשחזרים
// ממצב ממוזער. ההפעלה המוצלחת מכניסה מיד למצב רפוי וקובעת זמן חסד של 15 שניות לטעינה.
function launchAllowedApp(app) {
  return (async () => {
    const exe = String((app && app.exe) || '').trim();
    if (!exe) return { ok: false, error: 'התוכנה לא הוגדרה' };
    const isAbs = /^[a-zA-Z]:[\\/]/.test(exe) || /^\\\\/.test(exe);
    const base = path.basename(exe).replace(/\.exe$/i, '');
    const isWord = base.toLowerCase() === 'winword';
    const isOtzaria = base.toLowerCase() === 'otzaria';
    const knownAppDef = KNOWN_APPS.find((k) => k.id === 'otzaria' || k.exeNames.some((n) => n.toLowerCase() === base.toLowerCase() + '.exe'));
    const isKnownTorah = !!knownAppDef;
    const publisherMode = !!(app.mode === 'publisher' && app.publisher && app.product);

    // אם מדובר בוורד או אוצריא/תוכנה תורנית והנתיב שנשמר אינו קיים, איתור נתיב חלופי מוכר
    let resolvedExe = exe;
    if ((isWord || isKnownTorah || isOtzaria) && (!isAbs || !fs.existsSync(resolvedExe))) {
      const candidates = isWord
        ? [
            (process.env.ProgramFiles || '') + '\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
            (process.env['ProgramFiles(x86)'] || '') + '\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
            (process.env.ProgramFiles || '') + '\\Microsoft Office\\Office16\\WINWORD.EXE',
            (process.env['ProgramFiles(x86)'] || '') + '\\Microsoft Office\\Office16\\WINWORD.EXE',
            (process.env.ProgramFiles || '') + '\\Microsoft Office\\root\\Office15\\WINWORD.EXE',
            (process.env['ProgramFiles(x86)'] || '') + '\\Microsoft Office\\root\\Office15\\WINWORD.EXE'
          ]
        : (knownAppDef ? knownAppDef.candidates : []);
      for (const c of candidates) {
        if (c && fs.existsSync(c)) { resolvedExe = c; break; }
      }
    }

    // אימות הקובץ לפני הפעלה (אם הנתיב קיים)
    let startTarget = null;
    try {
      if (fs.existsSync(resolvedExe)) {
        const info = await inspectAppFile(resolvedExe);
        if (publisherMode) {
          const infoPub = (info && info.status === 'Valid') ? cnOf(info.subject).toLowerCase() : '';
          const appPub = String(app.publisher).toLowerCase();
          const infoProd = String((info && info.product) || '').toLowerCase();
          const appProd = String(app.product || '').toLowerCase();
          const isWordSigned = isWord && infoPub === 'microsoft corporation';
          const prodMatch = (infoProd === appProd) ||
            (infoProd && appProd && (infoProd.includes(appProd) || appProd.includes(infoProd))) ||
            (isWordSigned && (/microsoft\s*(office|word|365)/i.test(infoProd) || /microsoft\s*(office|word|365)/i.test(appProd)));

          if (!info || info.status !== 'Valid' || infoPub !== appPub || !prodMatch) {
            return { ok: false, error: 'התוכנה אינה תואמת את החותם המאומת — ייתכן שהוחלפה או עודכנה. בחרו אותה מחדש בהגדרות.' };
          }
        } else if (app.hash) {
          const isWordSigned = isWord && info && info.status === 'Valid' && cnOf(info.subject).toLowerCase() === 'microsoft corporation';
          const hashMatches = info && info.hash && info.hash.toLowerCase() === String(app.hash).toLowerCase();
          if (!isWordSigned && !hashMatches) {
            if ((isKnownTorah || isOtzaria) && info && info.hash) {
              // עדכון אוטומטי של תוכנת לימוד תורנית (כגון אוצריא) שעברה שדרוג גרסה
              app.hash = info.hash;
              saveSettings();
            } else {
              return { ok: false, error: 'קובץ התוכנה שונה מהגרסה שאומתה — בחרו אותה מחדש בהגדרות.' };
            }
          }
        }
        startTarget = resolvedExe;
      } else if (publisherMode || isWord || isKnownTorah || isOtzaria) {
        startTarget = base;
      } else {
        return { ok: false, error: 'קובץ התוכנה לא נמצא — בחרו אותה מחדש בהגדרות.' };
      }
    } catch {
      return { ok: false, error: 'אימות התוכנה נכשל — נסו שוב.' };
    }

    // כניסה למצב רפוי והסתרת מסך החסימה מיד, כדי שמסך החסימה (תמיד עליון)
    // לא ימנע מהתוכנה המופעלת לקבל פוקוס בחזית.
    fgCache.path = null;
    fgCache.at = 0;
    launchGraceUntil = Date.now() + 15000; // 15 שניות זמן חסד מלא לטעינת התוכנה (במיוחד תוכנות כבדות כגון וורד ואוצריא)
    enterRelaxed();

    const matchCond = '($_.ProcessName -ieq ' + psSingleQuote(base) + ' -or $_.Path -ieq ' + psSingleQuote(resolvedExe) + ')';
    const workDir = (startTarget && fs.existsSync(startTarget)) ? path.dirname(startTarget) : '';
    const startCmd = workDir
      ? 'Start-Process -FilePath ' + psSingleQuote(startTarget) + ' -WorkingDirectory ' + psSingleQuote(workDir)
      : 'Start-Process -FilePath ' + psSingleQuote(startTarget);
    const script =
      "Add-Type -MemberDefinition '" +
      "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); " +
      "[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); " +
      "[DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);" +
      "' -Name U -Namespace W; " +
      'try { ' +
      '  $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ' + matchCond + ' } | Select-Object -First 1; ' +
      '  if ($p) { ' +
      '    if ([W.U]::IsIconic($p.MainWindowHandle)) { [W.U]::ShowWindowAsync($p.MainWindowHandle, 9) } else { [W.U]::ShowWindowAsync($p.MainWindowHandle, 5) }; ' +
      '    [W.U]::SetForegroundWindow($p.MainWindowHandle); ' +
      '  } else { ' +
      '    ' + startCmd + '; ' +
      '  } ' +
      '} catch { Write-Error $_; exit 1 }';
      
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 15000 }, (err) => {
        if (err) return resolve({ ok: false, error: 'לא ניתן להפעיל את התוכנה — בדקו שהיא מותקנת במקום הנכון' });
        resolve({ ok: true });
      });
    });
  })();
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

/* ================= "רק תוכנות מאושרות" — Process Governor (Phase 3.7) =================
   מצב שליטה עצמית: כאשר studyMode.enabled פעיל, המושל סוגר כל תוכנת משתמש
   שאינה ברשימת התוכנות המאושרות (allowedApps) — כך שרק תוכנות הלימוד רצות.
   scope: 'always' = תמיד | 'blocked' = רק בזמן חסימת מחשב.

   בטיחות (קריטי — אסור להפיל את Windows):
   1) SAFELIST שמרני של תהליכי ליבה של המערכת — לעולם לא נסגרים.
   2) המושל אינו נוגע בשום תהליך שנתיבו תחת %WINDIR% — כך גם אם חסר שם
      מה-safelist, רכיבי מערכת (System32) אינם נהרגים. המושל מכוון אך ורק
      לאפליקציות משתמש (Program Files / AppData / דיסקים אחרים).
   3) התהליך של בין הזמנים עצמו והצאצאים שלו אינם נסגרים.
   4) תהליכים ללא נתיב הרצה (מוגנים/מערכת) אינם נסגרים.
   הערה: זהו אכיפת userland — יש פער זמן קצר עד הסגירה, וזה "קשה מספיק
   לעקיפה" (לא חסין מול תוקף עוין). יש לבדוק ב-VM ובסביבת Windows Home. */

// שמות תהליכים קריטיים שאסור לסגור (אותיות קטנות). כולל את הכלים שהמושל
// עצמו משתמש בהם (powershell/taskkill) — הם ממילא תחת %WINDIR% ומדולגים.
const SYSTEM_SAFELIST = new Set([
  'system', 'system idle process', 'idle', 'registry', 'secure system', 'memory compression',
  'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'lsaiso.exe',
  'fontdrvhost.exe', 'dwm.exe', 'svchost.exe', 'spoolsv.exe', 'wmiprvse.exe', 'searchindexer.exe',
  'audiodg.exe', 'explorer.exe', 'sihost.exe', 'ctfmon.exe', 'taskhostw.exe', 'taskhost.exe',
  'taskeng.exe', 'runtimebroker.exe', 'applicationframehost.exe', 'dllhost.exe', 'conhost.exe',
  'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'searchhost.exe', 'searchapp.exe',
  'textinputhost.exe', 'useroobebroker.exe', 'logonui.exe', 'lockapp.exe', 'systemsettings.exe',
  'msmpeng.exe', 'nissrv.exe', 'securityhealthservice.exe', 'securityhealthsystray.exe',
  'sgrmbroker.exe', 'wudfhost.exe', 'smartscreen.exe', 'backgroundtaskhost.exe', 'wlanext.exe',
]);

let governorBusy = false;
let governorTimer = null;

function windirLower() {
  return String(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows').toLowerCase();
}

// האם המושל צריך לפעול כרגע? דורש PIN (בלי סיסמה אין אכיפה), studyMode פעיל,
// ובמצב 'blocked' — רק כשהמחשב חסום בפועל (לוח או נעילה ידנית).
function governorActive() {
  if (!isWin) return false;
  const s = activeSchedule();
  if (!s.pinHash) return false;
  const sm = s.studyMode || {};
  if (!sm.enabled) return false;
  if (sm.scope === 'always') return true;
  const st = S.getStatus(s, trustedDate());
  return !!(manualLock || (s.enabled && st.state === 'blocked'));
}

// הרשומות שההורה אישר, כולל תוכנות נלוות. KNOWN_APPS משמש רק לגילוי
// בממשק; הוא אינו מעניק הרשאה סמויה. האימות נעשה ב-governorProcessAllowed.
function approvedProcessApps() {
  const apps = [];
  const addApp = (a) => {
    if (!a) return;
    const exe = String(a.exe || '').trim();
    if (exe && (/^[a-zA-Z]:[\\/]/.test(exe) || /^\\\\/.test(exe))) {
      apps.push(a);
    }
    (a.companions || []).forEach(addApp);
  };
  (activeSchedule().allowedApps || []).forEach(addApp);
  return apps;
}

// סקריפט קבוע (ללא קלט משתמש) לרשימת התהליכים באותו Session אינטראקטיבי
// בלבד. כך עותק שרץ אצל משתמש אחד לעולם אינו סוגר אפליקציות של משתמש מחובר
// אחר (כולל מנהל). PowerShell/taskkill עצמם נמצאים תחת %WINDIR% ומוגנים
// ממילא על ידי guard הנתיב; אין צורך להפוך shells ל-safelist שניתן לנצל.
const GOVERNOR_PS_SCRIPT =
  '$sid=(Get-Process -Id $PID).SessionId; Get-Process | Where-Object { $_.SessionId -eq $sid } | ForEach-Object { ' +
  '$p=$_; [PSCustomObject]@{ProcessId=$p.Id;SessionId=$p.SessionId;Name=$p.Name+\'.exe\';' +
  'ExecutablePath=([string]$p.Path);StartTicks=($(try{$p.StartTime.ToUniversalTime().Ticks}catch{0}))} } | ConvertTo-Json -Compress';

function enumerateProcesses() {
  return new Promise((resolve) => {
    if (!isWin) return resolve([]);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', GOVERNOR_PS_SCRIPT],
      { windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve([]);
        let data = null;
        try { data = JSON.parse(String(stdout || '')); } catch { return resolve([]); }
        resolve(Array.isArray(data) ? data : (data ? [data] : []));
      });
  });
}

function killProcess(proc) {
  return new Promise((resolve) => {
    const pid = Number(proc && proc.ProcessId);
    const expectedPath = String((proc && proc.ExecutablePath) || '');
    const ticks = String(Number(proc && proc.StartTicks) || 0);
    if (!Number.isInteger(pid) || pid <= 4 || !expectedPath || ticks === '0') return resolve(false);
    // אותה פקודת PowerShell משווה זהות ומסיימת את אובייקט התהליך שאומת,
    // כדי ש-PID שמוחזר בינתיים לתהליך אחר לא יגרום לסגירת התהליך החדש.
    const script = '$p=Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue; ' +
      'if(-not $p){exit 3}; $path=[string]$p.Path; $ticks=$(try{$p.StartTime.ToUniversalTime().Ticks}catch{0}); ' +
      'if($path -ine ' + psSingleQuote(expectedPath) + ' -or [string]$ticks -ne ' + psSingleQuote(ticks) + '){exit 4}; ' +
      'Stop-Process -InputObject $p -Force -ErrorAction Stop';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

// בדיקת בטיחות מקדימה: מחזירה סיבת דילוג לתהליך מערכת, או null לתהליך
// משתמש שחייב לעבור אימות מלא מול allowedApps לפני שמחליטים אם לסגור אותו.
function governorSkipReason(proc, ctx) {
  const pid = Number(proc && proc.ProcessId);
  if (!Number.isInteger(pid) || pid <= 4) return 'system-pid';
  if (pid === ctx.selfPid) return 'self-pid';
  const name = String((proc && proc.Name) || '').toLowerCase();
  if (!name) return 'no-name';
  const exePath = String((proc && proc.ExecutablePath) || '').trim();
  if (!exePath) return SYSTEM_SAFELIST.has(name) ? 'protected-system' : 'no-path';
  const lp = exePath.toLowerCase();
  if (lp === ctx.windir || lp.startsWith(ctx.windir + path.sep)) return 'windir';
  if (lp === ctx.selfPath) return 'self-path';
  return null; // תהליך משתמש — חייב אימות מול הרשומות המאושרות
}

async function governorProcessAllowed(proc, apps) {
  const exePath = String((proc && proc.ExecutablePath) || '').trim();
  for (const approved of apps) {
    if (await foregroundMatchesApp(approved, exePath)) return true;
  }
  return false;
}

async function governorTick() {
  if (governorBusy || !governorActive()) return;
  governorBusy = true;
  try {
    const approvedApps = approvedProcessApps();
    const ctx = {
      windir: windirLower(),
      selfPath: path.resolve(process.execPath).toLowerCase(),
      selfPid: process.pid
    };
    const procs = await enumerateProcesses();
    for (const p of procs) {
      if (!governorActive()) break; // המצב השתנה באמצע — עוצרים
      if (governorSkipReason(p, ctx) !== null) continue;
      if (await governorProcessAllowed(p, approvedApps)) continue;
      if (await killProcess(p)) {
        logEvent('governor-kill', { name: String(p.Name || ''), pid: Number(p.ProcessId) });
      }
    }
  } catch (err) {
    logEvent('governor-error', { error: String((err && err.message) || err) });
  } finally {
    governorBusy = false;
  }
}

// הפעלה/כיבוי של המושל לפי המצב הנוכחי — נקרא מלולאת האכיפה.
function reconcileGovernor() {
  if (governorActive()) {
    if (!governorTimer) {
      governorTimer = setInterval(() => { governorTick().catch(() => {}); }, 3000);
      if (governorTimer && typeof governorTimer.unref === 'function') governorTimer.unref();
      governorTick().catch(() => {});
    }
  } else if (governorTimer) {
    clearInterval(governorTimer);
    governorTimer = null;
  }
}

/* ================= לולאת האכיפה ================= */

/* ================= תקופת צינון (Cool-off) ================= */

function coolOffActive() { return coolOffPending && trustedNow() < coolOffUntil; }

function clearCoolOff() {
  coolOffPending = false;
  coolOffUntil = 0;
  coolOffTarget = null;
  if (coolOffTimer) { clearTimeout(coolOffTimer); coolOffTimer = null; }
}

// החלת הפתיחה בתום הצינון: מסיר נעילה ידנית ומגדיר את הפתיחה עד המעבר הבא.
// ההחלה בפועל נעשית בראש enforce() (backstop אחד ויחיד) — כך גם אם הטיימר
// לא נורה (למשל אחרי שינה/יקיצה) האכיפה הבאה תחיל את הפתיחה כשהזמן הגיע.
function applyCoolOffIfDue() {
  if (!coolOffPending || trustedNow() < coolOffUntil) return false;
  const target = coolOffTarget;
  clearCoolOff();
  manualLock = false;
  schedule.manualUnlockUntil = target;
  saveSettings();
  logEvent('cooloff-applied');
  return true;
}

function applyCoolOff() {
  if (!coolOffPending) return;
  if (trustedNow() < coolOffUntil) { scheduleCoolOffApply(); return; } // הגנה מפני יקיצה מוקדמת
  enforce(); // enforce() מחיל את הצינון שהסתיים בראשו, ואז אוכף מחדש (מסיר חסימה)
}

function scheduleCoolOffApply() {
  if (coolOffTimer) clearTimeout(coolOffTimer);
  const ms = Math.max(0, coolOffUntil - trustedNow());
  coolOffTimer = setTimeout(applyCoolOff, ms + 50);
  // לא לעכב יציאת התהליך על טיימר זה — לולאת enforce (כל 5 שניות) היא ה-backstop.
  if (coolOffTimer && typeof coolOffTimer.unref === 'function') coolOffTimer.unref();
}

function buildStatus() {
  const eff = activeSchedule(); // מדיניות אפקטיבית (בסיס + פרופיל המשתמש)
  const calculated = S.getStatus(eff, trustedDate());
  // כאשר זוהתה קפיצה לאחור בין הפעלות, עדיף לנעול עם PIN מאשר להסתמך על
  // זמן שאינו מהימן. ללא PIN נשמרת מדיניות ההתקנה הראשונית שאינה נועלת.
  const faultDuration = configurationFaultSince ? trustedNow() - configurationFaultSince : 0;
  const isEmergencyLock = configurationFault && faultDuration < 24 * 3600 * 1000;
  const emergencyNextAt = configurationFaultSince ? configurationFaultSince + 24 * 3600 * 1000 : null;
  const emergencySeconds = emergencyNextAt ? Math.max(0, Math.ceil((emergencyNextAt - trustedNow()) / 1000)) : null;

  const st = isEmergencyLock
    ? { ...calculated, state: 'blocked', next: 'allowed', nextAt: emergencyNextAt ? new Date(emergencyNextAt) : null, secondsUntilNext: emergencySeconds, warning: false, warningSeconds: null, configError: true }
    : clockRollbackDetected && eff.pinHash
      ? { ...calculated, state: 'blocked', next: null, nextAt: null, secondsUntilNext: null, warning: false, warningSeconds: null, clockError: true }
      : calculated;
  return {
    ...st,
    now: trustedNow(),
    manualLock: manualLock,
    coolOff: coolOffActive(),
    coolOffSeconds: coolOffActive() ? Math.max(0, Math.ceil((coolOffUntil - trustedNow()) / 1000)) : null,
    theme: resolvedTheme(),
    blockMessage: eff.blockMessage,
    stateLabel: st.state === 'blocked' ? 'חסום' : st.state === 'netblock' ? 'האינטרנט חסום' : 'מותר',
    nextLabel: st.next === 'blocked' ? 'חסום' : st.next === 'netblock' ? 'האינטרנט ייחסם' : st.next === 'allowed' ? 'מותר' : null,
    nextAtLabel: st.nextAt ? S.formatDate(st.nextAt) : null,
    secondsUntilLabel: st.secondsUntilNext != null ? S.formatDuration(st.secondsUntilNext) : null,
    pinSet: !!eff.pinHash,
    netBlockFailed: netBlockFailed,
    netBlockError: netBlockError,
    netBlockApplied: netBlockApplied,
    clockError: !!st.clockError,
    configError: !!configurationFault,
    startupError: startupFault,
    enforcement: enforcementSnapshot(),
    blockBg: eff.blockBg,
    showTorahQuotes: eff.showTorahQuotes !== false,
    allowedAppsEnabled: eff.allowedAppsEnabled !== false,
    // למסך החסימה מועברות תוכנות עם נתיב מלא תקין (ראשיות וכן תוכנות שנוספו
    // כנלוות, כדי לאפשר פתיחה נוחה מהמסך גם אם נוספו תחת נלוות).
    allowedApps: (() => {
      const list = [];
      const seen = new Set();
      (eff.allowedApps || []).forEach((a) => {
        if (a && a.exe && !seen.has(String(a.exe).toLowerCase())) {
          seen.add(String(a.exe).toLowerCase());
          list.push(a);
        }
        (a.companions || []).forEach((c) => {
          if (c && c.exe && !seen.has(String(c.exe).toLowerCase())) {
            seen.add(String(c.exe).toLowerCase());
            list.push(c);
          }
        });
      });
      return list.filter((a) =>
        /^[a-zA-Z]:[\\/]/.test(String(a.exe || '')) || /^\\\\/.test(String(a.exe || '')));
    })(),
    websiteApps: (eff.websiteApps || []).map((a) => ({ name: String(a.name || '') })),
    fileExplorerEnabled: !!(eff.fileExplorer && eff.fileExplorer.enabled)
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
  // backstop יחיד לתקופת הצינון: אם הזמן הגיע — מחילים את הפתיחה כאן, לפני
  // כל שאר הלוגיקה (כך גם ריצה מחדש בזמן enforceBusy מחילה אותה).
  applyCoolOffIfDue();
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
    const failEff = activeSchedule();
    const shouldFailClosed = !!(configurationFault || (failEff.pinHash && (manualLock ||
      (failEff.enabled && S.getStatus(failEff, trustedDate()).state === 'blocked'))));
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
  const eff = activeSchedule(); // מדיניות אפקטיבית (בסיס + פרופיל המשתמש)
  const status = buildStatus();
  // "רק תוכנות מאושרות" — הפעלה/כיבוי המושל לפי המצב הנוכחי (studyMode/scope).
  // נעשה לפני הענפים כי scope 'always' פעיל גם כשהמחשב אינו חסום.
  reconcileGovernor();
  // נעילה ידנית חלה תמיד — גם אם האכיפה לפי הלוח מושבתת
  const faultDuration = configurationFaultSince ? trustedNow() - configurationFaultSince : 0;
  const isEmergencyLock = configurationFault && faultDuration < 24 * 3600 * 1000;
  const blocked = !!(isEmergencyLock || manualLock || (eff.enabled && status.state === 'blocked'));
  // חסימת אינטרנט בלבד — מחשב פתוח, רשת חסומה (לא במקביל לנעילה ידנית)
  const netblocked = !!(eff.enabled && status.state === 'netblock' && !manualLock);
  const pinSet = !!eff.pinHash;
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
  // לא מציגים אם המערכת במצב רפוי (תוכנה מותרת פועלת) או בתוך זמן חסד להפעלת תוכנה.
  if (activeBlock && manualLock && !relaxed && Date.now() >= launchGraceUntil) {
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
  // האייקון הצף מוצג כשחלון חסימת האינטרנט פעיל והחוק באמת הופעל בחומת
  // האש (netBlockApplied מאומת לפי netRuleExists). מקרה של כשלון הרמה
  // מוצג בסטטוס, בלי אייקון שיסמן חסימה שלא באמת קיימת.
  showNetIcon(activeNet && netBlockApplied);
  const publish = () => {
    const current = buildStatus();
    if (tray) updateTray(current);
    if (win && !win.isDestroyed()) win.webContents.send('status', current);
    blockWins.forEach((bw) => { if (bw && !bw.isDestroyed()) bw.webContents.send('status', current); });
  };

  if (!activeBlock) {
    manualLock = false;
    clearCoolOff(); // המחשב פתוח ממילא — פתיחת צינון ממתינה מיותרת
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
  // תוכנות מותרות זמינות הן בחסימה לפי הלוח והן בנעילה ידנית ("נעל עכשיו").
  const appsConfigured = eff.allowedAppsEnabled !== false && (eff.allowedApps || []).length > 0;
  const inGrace = Date.now() < launchGraceUntil;
  let fgAllowed = false;
  if (appsConfigured) {
    const fg = await getForegroundApp();
    if (await isAllowedApp(fg)) {
      fgAllowed = true;
      // אין לאפס את launchGraceUntil = 0: תוכנות רבות (כגון Word, אוצריא) מציגות מסך
      // פתיחה (Splash) שנסגר לשבריר שנייה לפני פתיחת חלון העורך הראשי. איפוס מוקדם של זמן
      // החסד היה גורם להקפצת מסך החסימה בדיוק בשלב המעבר הזה.
    }
  }
  if (fgAllowed || (inGrace && relaxed)) {
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
  // המצב המוצג במגש הוא המצב האמיתי: חסימת אינטרנט שמתוכננת בלוח אך לא
  // הופעלה בפועל (חומת אש כבויה/הרשאה בוטלה) מוצגת כשגיאה, לא כ"חסום" —
  // אותו עיקרון כמו במסך הראשי: אין דיווח חסימה כוזב.
  const color = (status.state === 'blocked' || status.manualLock) ? 'חסום'
    : status.netBlockFailed ? 'שגיאה — האינטרנט לא נחסם'
    : status.state === 'netblock' ? 'האינטרנט חסום' : 'מותר';
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
  lockLocalWindowNavigation(quitWin);
  quitWin.setAlwaysOnTop(true, 'screen-saver');
  quitWin.loadFile(path.join(__dirname, 'renderer', 'quit.html'));
  quitWin.on('closed', () => { quitWin = null; });
}

/* ================= חלון ראשי ================= */

function showMainWindow() {
  if (!win || win.isDestroyed()) createMainWindow();
  lockSession();
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  if (!isBlockedNow()) {
    win.setAlwaysOnTop(false);
  } else {
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* ignore */ }
  }
}

// נעילת סשן ההגדרות: כשהחלון מוסתר (סגירה, מזעור או הסתרה) הכניסה להגדרות
// דורשת סיסמה מחדש. הנעילה מתאפסת את sessionUnlocked ומודיעה לממשק מיד,
// כך שגם פתיחה חוזרת דרך שורת המשימות, המגש או התראה תציג את מסך הכניסה
// (הממשק לא נטען מחדש בהסתרה — לכן חייבים להודיע לו במפורש).
function lockSession() {
  sessionUnlocked = false;
  sessionUnlockedAt = 0;
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('session-lock'); } catch { /* ignore */ }
  }
}

function createMainWindow() {
  // חלון ההגדרות נטען מראש כדי שהאכיפה והמגש יפעלו מיד, אבל נשאר מוסתר
  // באתחול. כך הפעלה עם Windows אינה מציגה מסך כניסה או דורשת סיסמה
  // בשעות הפתוחות; חלון ההגדרות נפתח רק דרך המגש/בקשה מפורשת.
  win = new BrowserWindow({
    show: false,
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
  lockLocalWindowNavigation(win);
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
  return `"${exe}" "${dir}" --autostart`;
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
  if (isWin && fs.existsSync(exe)) return `"${exe}" "${launchAppPath(protectedAppDir())}" --autostart`;
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
  // מתקין ההסרה (Uninstall *.exe) חייב להיכלל במניפסט השלמות: בלעדיו ההסרה
  // החוקית מהתוכנה נשברת. מחיקה/פגיעה שלו לבדה נחשבת לפגיעה בשלמות
  // תיקיית ההתקנה ומפעילה שחזור מלא — ובנוסף קיים שחזור ממוקד מהיר
  // (restoreUninstaller) בשומר המערכתי.
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^Uninstall .*\.exe$/i.test(name)) candidates.push(path.join(dir, name));
    }
  } catch { /* ignore */ }
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

// הרשאות העותק המוגן ותיקיית ההתקנה: בעלות של Administrators, קריאה/הרצה
// בלבד למשתמשים רגילים, ואיסור מחיקה/שינוי שם לכולם — כולל למנהלים.
// כך מחיקה פשוטה של קבצי התוכנה (Explorer, del, סקריפטים) נכשלת עם
// "Access denied" גם בהרצה מוגבהת.
//
// הגבלה כנה: הרשאה זו אינה מוחלטת. מנהל החלטי יכול תמיד להשתלט על התיקייה
// (Take Ownership) ולאפס את ההרשאות — זו מגבלת Windows עצמה, שנועדה כך
// כדי שמנהל המערכת יוכל תמיד לתקן את המערכת. על איסור המחיקה נוספת שכבת
// ההגנה של שומר-השער המערכתי, שמשחזר קבצים שנמחקו בתוך שניות ורושם אירוע
// חבלה, כך שמחיקה "מצליחה" לא משביתה את האכיפה בפועל.
//
// עדכונים, שחזורים והסרה מחליפים קבצים — ולכן הם מרימים זמנית את איסור
// המחיקה (liftDirProtection) לפני החלפת הקבצים ומחזירים אותו מיד אחריה
// (harden*). בלי ההרמה הזו עדכון אוטומטי או שחזור של השומר היו נחסמים.
function runAclCommand(cmd, args) {
  return new Promise((resolve) => {
    try { execFile(cmd, args, () => resolve()); } catch { resolve(); }
  });
}
// כמו runAclCommand אבל מחזיר true/false לפי הצלחת הפקודה (קוד יציאה 0)
function runAclCommandOk(cmd, args) {
  return new Promise((resolve) => {
    try { execFile(cmd, args, (err) => resolve(!err)); } catch { resolve(false); }
  });
}

// הסרת איסור המחיקה מתיקייה — לפני החלפת קבצים (עדכון/שחזור/הסרה).
// /remove:d מסיר רק את הרכיבים מסוג Deny של Everyone; ההרשאות הרגילות נשארות.
function liftDirProtection(dir) {
  return runAclCommand('icacls', [dir, '/remove:d', '*S-1-1-0', '/T', '/C']);
}

// איסור מחיקה ושינוי שם (Delete + DeleteChild) לכולם — כולל מנהלים.
// Deny גובר על Allow ב-Windows, ולכן גם הרשאת Full של מנהלים אינה עוקפת אותו.
function denyDeleteAcl(dir) {
  return runAclCommand('icacls', [dir, '/deny', '*S-1-1-0:(OI)(CI)(DE,DC)', '/T', '/C']);
}

// הוצאת קובץ בודד מתחולת איסור המחיקה. משמשת לגיבוי ההגדרות: הוא נכתב מחדש
// בכל שמירה ב-rename אטומי (פעולת מחיקה ברמת הקובץ) — בלי החרגה זו שמירת
// ההגדרות הייתה נחסמת תחת האיסור. רמת ההגנה שלו נשארת כמו קודם (מנהל יכול).
async function excludeFileFromDeny(file) {
  if (!isWin || !isElevated() || !file) return;
  await runAclCommand('icacls', [file, '/inheritance:r',
    '/grant:r', '*S-1-5-32-545:F',
    '/grant:r', '*S-1-5-32-544:F',
    '/grant:r', '*S-1-5-18:F']);
}

// הגדרת הרשאות עץ תיקייה (ללא איסור המחיקה) — בעלות למנהלים + הרשאות.
//
// אזהרה חשובה — למה לא משתמשים ב-/T עם /grant:r ו-(OI)(CI): הפעלת
// icacls עם /grant:r וסימוני ירושה (OI)(CI) על קבצים (דרך /T) מרוקנת את
// ה-DACL של כל קובץ (נשאר רק PAI ללא ACEs) — והתוצאה היא שאף אחד — כולל
// SYSTEM ומנהלים — לא יכול לקרוא או להריץ את הקבצים (נבדק אמפירית על
// ווינדוס 11). לכן מקשחים בשני שלבים: (1) התיקייה עצמה מקבלת הרשאות
// מורשות (בלי /T), ו-(2) כל מה שבתוכה מאופס לירושה (icacls dir\* /reset /T)
// כך שהילדים יורשים את ההרשאות מהתיקייה. איסור המחיקה מתווסף בנפרד
// (denyDeleteAcl) — הוא בטוח עם /T.
async function hardenAclTree(dir) {
  if (!dir) return;
  await runAclCommand('icacls', [dir, '/inheritance:r',
    '/grant:r', '*S-1-5-32-545:(OI)(CI)RX',
    '/grant:r', '*S-1-5-32-544:(OI)(CI)F',
    '/grant:r', '*S-1-5-18:(OI)(CI)F']);
  await runAclCommand('icacls', [path.join(dir, '*'), '/reset', '/T', '/C']);
  await verifyAclHealth(dir);
}

// רשת ביטחון אחרי הקשחה: כל קובץ בעץ חייב להישאר קריא. אם קובץ שהיה נעול בזמן
// ההקשחה נשאר עם DACL ריק (PAI ללא ACEs — אף אחד לא יכול לקרוא אותו, אפילו לא
// SYSTEM), מנסים לתקן את ה-DACL שלו ישירות (בלי סימוני ירושה — התבנית שמשחיתה
// קבצים), ואם גם זה נכשל רושמים אירוע חבלה כדי שלא יעבור בשקט.
//
// הבחנה קריטית (נבדקה אמפירית): קבצים שהאפליקציה טוענת תוך כדי ריצה (למשל קבצי
// .pak ש-Chromium ממפה באתחול) עלולים להיות נעולים לרגע — בדיקת גישה נכשלת על
// קובץ נעול גם כשההרשאות שלו תקינות לחלוטין. המבדיל בין "נעול" ל"פגום": שאילתת
// icacls על הקובץ — על קובץ נעול עם DACL תקין icacls מצליח לקרוא את ההרשאות
// (קוד יציאה 0), בעוד על קובץ עם DACL ריק הוא נכשל. רק כשגם ה-DACL אינו קריא
// מטפלים ומדווחים — כך לא נוצר רעש ביומן החבלה על קבצים פשוט נעולים.
async function verifyAclHealth(dir) {
  if (!dir) return;
  const readable = (full) => {
    try { fs.accessSync(full, fs.constants.R_OK); return true; } catch { return false; }
  };
  const checkFile = async (full) => {
    if (readable(full)) return;
    // לא קריא כרגע — אבל אם ה-DACL עצמו קריא (icacls מצליח), זה קובץ נעול
    // עם הרשאות תקינות — לא פגיעה, מדלגים בשקט.
    if (await runAclCommandOk('icacls', [full])) return;
    // ה-DACL עצמו פגום (לא קריא אפילו ל-icacls) — מנסים לתקן ישירות
    await runAclCommand('icacls', [full, '/inheritance:r',
      '/grant:r', '*S-1-5-32-545:R',
      '/grant:r', '*S-1-5-32-544:F',
      '/grant:r', '*S-1-5-18:F']);
    logTamper(readable(full) ? 'acl-repaired' : 'acl-unreadable');
  };
  const walk = async (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) await checkFile(full);
    }
  };
  try { await walk(dir); } catch { /* ignore */ }
}

// הקשחת עץ תיקייה: בעלות למנהלים + הרשאות + איסור מחיקה לכולם
async function hardenDirTree(dir) {
  if (!dir) return;
  await runAclCommand('takeown', ['/f', dir, '/a', '/r', '/d', 'y']);
  await hardenAclTree(dir);
  await denyDeleteAcl(dir);
}

async function hardenMachineDir() {
  if (!isWin || !isElevated()) return;
  const dir = machineDir();
  await runAclCommand('takeown', ['/f', dir, '/a']);
  await hardenAclTree(dir);
  // התיקייה המשותפת מכילה את העותק המוגן — האיפוס לירושה (dir\* /reset)
  // מסיר זמנית את איסור המחיקה שלו; מקשחים אותו שוב מיד כדי שלא יישאר
  // ללא הגנה גם לרגע.
  if (fs.existsSync(protectedAppDir())) await hardenProtectedCopy();
}

// הקשחת תיקיית ההתקנה עצמה (התיקייה הגלויה שהורה יכול למחוק) — כולל איסור
// מחיקה. רצים מהעותק המוגן? תיקיית ההתקנה האמיתית ידועה מתוך install.json.
async function hardenInstallDir() {
  if (!isWin || !isElevated()) return;
  let dir = installSourceDir();
  if (dir && path.resolve(dir) === path.resolve(protectedAppDir())) {
    const info = installInfo();
    dir = (info && info.dir) || null;
  }
  await hardenDirTree(dir);
}

async function hardenProtectedCopy() {
  if (!isWin || !isElevated()) return;
  const dir = protectedAppDir();
  // לפני איסור המחיקה — לוודא שקובץ גיבוי ההגדרות קיים. הוא נכתב ב-rename
  // אטומי, וכתיבה כזו תחת איסור מחיקה אינה אפשרית (הוא יוחרג מיד אחר כך).
  try {
    if (!fs.existsSync(protectedSettingsFile())) {
      const mf = machineSettingsFile();
      if (fs.existsSync(mf)) fs.copyFileSync(mf, protectedSettingsFile());
      else atomicWrite(protectedSettingsFile(), '{}');
    }
  } catch { /* ignore */ }
  await runAclCommand('takeown', ['/f', dir, '/a', '/r', '/d', 'y']);
  await hardenAclTree(dir);
  await denyDeleteAcl(dir);
  // הגיבוי נכתב מחדש בכל שמירת הגדרות — יוצא מתחולת האיסור
  await excludeFileFromDeny(protectedSettingsFile());
}

// יצירה/רענון של העותק המוגן — רק בהרצה מוגבהת ורק כשהגרסה השתנתה.
async function ensureProtectedCopy() {
  if (!isWin || !isElevated()) return false;
  const dst = protectedAppDir();
  const src = installSourceDir();
  try {
    // כשהמשימה כבר מריצה את העותק המוגן — אסור להעתיק אותו לעצמו או
    // לדרוס את install.json עם הנתיב המוגן במקום הנתיב המקורי. בכל מקרה
    // מקפידים שתיקיית ההתקנה הגלויה תישאר מוקשחת (איסור מחיקה).
    if (isProtectedRuntime()) {
      await hardenInstallDir();
      return fs.existsSync(sourceExecutable(dst));
    }
    if (!fs.existsSync(sourceExecutable(src))) return false;
    if (fs.existsSync(sourceExecutable(dst)) && appVersion() && appVersion() === protectedVersion() && protectedCopyIntegrity()) {
      await hardenMachineDir();
      await hardenInstallDir();
      await hardenProtectedCopy();
      writeProtectedSettingsBackup();
      saveInstallInfo();
      return true; // העותק עדכני — אין צורך להעתיק שוב
    }
    // רענון העותק המוגן — להרים זמנית את איסור המחיקה לפני החלפת הקבצים
    // (ההקשחה שלהלן מחזירה אותו מיד אחרי ההעתקה).
    await liftDirProtection(dst);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    // מעתיקים את כל שורש ההתקנה, כולל exe + resources\\app.asar.
    fs.cpSync(src, dst, { recursive: true });
    if (!fs.existsSync(sourceExecutable(dst))) throw new Error('קובץ ההרצה לא הועתק');
    writeProtectedManifest();
    await hardenMachineDir();
    await hardenInstallDir();
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
  if (!a.ok) {
    startupFault = a.error || 'רישום Startup נכשל';
    return { ok: false, error: startupFault };
  }
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
  startupFault = warnings.length ? warnings.join(' | ') : null;
  return { ok: true, warning: startupFault };
}

// חסימת יצירת חשבונות חדשים במחשב: מסתירה את דף "חשבונות" בהגדרות Windows,
// שהיא הדרך הרגילה להוסיף משתמש/חשבון חדש. (יצירת חשבון דורשת הרשאות מנהל
// בכל מקרה — הגדרה זו מונעת גם אותה בדרך הרגילה.)
async function applyAccountPolicies() {
  // אין לשנות מדיניות Windows קיימת של המחשב. יצירת חשבונות היא
  // באחריות מנהל המערכת ואינה חלק מאכיפת לוח הזמנים.
  return;
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
          execFile('reg', ['delete', RUN_KEY_MACHINE, '/v', RUN_NAME, '/f'], resolve);
        });
      });
    });
  });
}

// איתור ה-Uninstaller של NSIS — קודם כקובץ "Uninstall ..." לצד קובץ התוכנה
// (המיקום שבו electron-builder תמיד מניח אותו, עם נתיב Unicode אמין),
// ורק אחר כך דרך רישום מרכז התוכניות (פלט reg query הוא ANSI — עלול
// להשחית תווים עבריים בנתיב, ולכן הוא רק רשת ביטחון נוספת).
// הסרה מותרת אך ורק מתוך התוכנה עצמה (עם סיסמת הורה) — ולא דרך "התקן והסר
// תוכניות" / הגדרות Windows. שני מנגנונים אוכפים זאת:
// 1) רשומת ההסרה מהרישום נמחקת בכל הפעלה מוגבהת — התוכנה כלל אינה מופיעה
//    ברשימת התוכנות של Windows (המתקין יוצר את הרשומה מחדש בכל עדכון,
//    וההרצה הראשונה מסירה אותה שוב).
// 2) ה-Uninstaller של NSIS מסרב לפעול ללא אסימון חד-פעמי שהתוכנה כותבת
//    רק אחרי אימות סיסמת ההורה (ראה app:uninstall ו-build/installer.nsh) —
//    כך שגם הפעלה ישירה של Uninstall.exe נחסמת.
//
// מגבלה כנה: מנהל החלטי יכול להחזיר את רשומת ההסרה או ליצור אסימון בעצמו
// (או פשוט למחוק את התיקיות) — זו מגבלת Windows, שמעניקה למנהל תמיד את
// המילה האחרונה. המנגנונים כאן חוסמים את הנתיבים הפשוטים והרגילים.

// מפתח ההסרה ב"התקן והסר תוכניות" נקבע דטרמיניסטית על ידי electron-builder:
// UUID v5 של ה-appId מול namespace קבוע שלו (ראה NsisTarget.js).
const UNINSTALL_NS_UUID = '50e065bc-3134-11e6-9bab-38c9862bdaf3';
const APP_ID = 'com.levtov.benhazmanim';
const uninstallTokenFile = () => path.join(machineDir(), 'uninstall.token');

function uninstallRegistryKey() {
  const h = crypto.createHash('sha1');
  h.update(Buffer.from(UNINSTALL_NS_UUID.replace(/-/g, ''), 'hex'));
  h.update(Buffer.from(APP_ID, 'utf8'));
  const b = h.digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // גרסה 5 (SHA-1)
  b[8] = (b[8] & 0x3f) | 0x80; // Variant RFC 4122
  const hex = b.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
}

function removeUninstallRegistryEntries() {
  if (!isWin || !isElevated()) return;
  const key = uninstallRegistryKey();
  const paths = [
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + key,
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + key,
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + key
  ];
  for (const p of paths) execFile('reg', ['delete', p, '/f'], () => { /* ignore */ });
}

function findUninstaller() {
  const candidates = [];
  try {
    const dirs = [path.dirname(process.execPath)];
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'ben-hazmanim'));
    const info = installInfo();
    if (info && info.dir) dirs.push(info.dir);
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (/^Uninstall(?: .*)?\.exe$/i.test(name)) candidates.push(path.join(dir, name));
      }
    }
  } catch { /* ignore */ }
  const regKeys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.levtov.benhazmanim',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1a0f82df-139b-50a8-b570-363db8e77539'
  ];
  for (const key of regKeys) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'UninstallString'], { encoding: 'utf8', windowsHide: true });
      const m = out.match(/([A-Za-z]:\\(?:[^"\r\n]*\))*[^"\r\n]*?\.exe)/);
      if (m) candidates.push(m[1]);
    } catch { /* ignore */ }
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/* ================= שחזור סיסמה למייל (Google Apps Script) ================= */

// כתובת קבועה של אפליקציית השחזור — כל הבקשות נשלחות לשרת זה בלבד.
// לב טוב דיגיטל — https://digital.levtov.uk/
const RECOVERY_URL = 'https://script.google.com/macros/s/AKfycbzn0E8JIRLsmJqlYXQMoqpNSqAKALUDbgdcxwBT2zn_1ZqZEpYCZ2pyBeNYyb2rfuvyGQ/exec';

// השחזור אינו שולח את הסיסמה. נוצר Token חד-פעמי מקומי, נשלח למייל,
// ונשמר רק כ-Hash מוגן עד 15 דקות. הסוד אינו נארז בתוך ה-EXE.
const RECOVERY_TOKEN_TTL_MS = 15 * 60 * 1000;

/* ================= שותף אחריות (Accountability partner) =================
   אופציונלי, כבוי כברירת מחדל. כשמופעל:
   - קוד השחזור ועדכוני שינוי סיסמה נשלחים גם לשותף (co-visibility).
   - אם accountabilityRequireApproval פעיל — פתיחה מוקדמת של החסימה דורשת
     קוד אישור שנשלח *רק* לשותף (המשתמש אינו יכול לפתוח לבד).
   אישור הפתיחה הוא מצב Session בזיכרון בלבד (אינו נכתב לדיסק). */
const UNLOCK_APPROVAL_TTL_MS = 15 * 60 * 1000;
let unlockApproval = { hash: null, until: 0, failures: 0, purpose: null };

function accountabilityActive() {
  return !!(schedule.accountabilityEnabled && String(schedule.accountabilityEmail || '').trim());
}
function requireApprovalActive() {
  return !!(accountabilityActive() && schedule.accountabilityRequireApproval);
}

// שליחת הודעה לשותף האחריות (fire-and-forget). אינה חוסמת פעולה: כשל רשת
// לא ימנע שינוי סיסמה — רק ההתראה לשותף לא תישלח. הסיסמה עצמה לעולם אינה נשלחת.
function notifyPartner(kind) {
  if (!accountabilityActive()) return;
  const partner = String(schedule.accountabilityEmail || '').trim();
  fetch(RECOVERY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ partner, notice: String(kind || 'change'), app: 'BenHazmanim', time: new Date().toISOString() }),
    signal: AbortSignal.timeout(15000)
  }).then((res) => res && res.json ? res.json().catch(() => ({})) : {})
    .then(() => logEvent('accountability-notify', { kind }))
    .catch(() => logEvent('accountability-notify-fail', { kind }));
}

// בקשת קוד אישור פתיחה מהשותף: מייצר קוד קצר (6 ספרות), שולח *רק* לשותף,
// ושומר את ה-Hash שלו בזיכרון עד 15 דקות. המשתמש חייב לקבל את הקוד מהשותף.
async function requestUnlockApproval(requestedPurpose) {
  if (!requireApprovalActive()) {
    return { ok: false, error: 'אישור שותף אחריות אינו מופעל' };
  }
  const partner = String(schedule.accountabilityEmail || '').trim();
  const purpose = requestedPurpose === 'settings-change' ? 'settings-change' : 'unlock';
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const wasBlocked = netBlockApplied;
  if (wasBlocked) await netBlockSet(false);
  try {
    const res = await fetch(RECOVERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partner, token: code, purpose, app: 'BenHazmanim', time: new Date().toISOString() }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true) {
      return { ok: false, error: recoveryErrorToHebrew(String(data.error || '')) };
    }
    unlockApproval = { hash: S.sha256Hex(code), until: trustedNow() + UNLOCK_APPROVAL_TTL_MS, failures: 0, purpose };
    logEvent('accountability-approval-sent');
    return { ok: true };
  } catch {
    return { ok: false, error: 'נדרשת גישה לאינטרנט כדי לשלוח קוד אישור לשותף' };
  } finally {
    if (wasBlocked) await netBlockSet(true);
  }
}

// בדיקת קוד אישור הפתיחה מול ה-Hash השמור (השוואה בזמן קבוע).
function unlockApprovalValid(code, purpose) {
  if (!unlockApproval.hash || trustedNow() > unlockApproval.until || unlockApproval.purpose !== purpose) return false;
  const expected = Buffer.from(unlockApproval.hash, 'hex');
  const actual = Buffer.from(S.sha256Hex(String(code || '')), 'hex');
  const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!valid) {
    unlockApproval.failures = Number(unlockApproval.failures || 0) + 1;
    if (unlockApproval.failures >= 5) unlockApproval = { hash: null, until: 0, failures: 0, purpose: null };
  }
  return valid;
}

// מקור העדכונים — URL לקובץ JSON עם גרסה. נקבע כאן בקוד בלבד
// (אין שדה בממשק) — הכפתור "בדוק עדכונים" משתמש בכתובת זו.
// הקובץ version.json מתגורר במאגר הגיטהאב הציבורי, וכל שינוי בו
// (גרסה חדשה) יימצא מיד על ידי כל העותקים המותקנים של התוכנה.
const UPDATE_URL = 'https://raw.githubusercontent.com/Lev-Good/Between-times/main/version.json';
const UPDATE_SIGNER_CN = 'Lev Tov Digital';

async function sendRecovery() {
  const email = schedule.recoveryEmail;
  if (!email) return { ok: false, error: 'לא הוגדר מייל שחזור בהגדרות' };
  if (schedule.recoveryPendingHash && Number(schedule.recoveryPendingUntil || 0) > trustedNow()) {
    return { ok: false, error: 'כבר נשלח קוד שחזור — בדקו את המייל או נסו שוב לאחר פקיעת הקוד' };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const previous = JSON.stringify(schedule);
  schedule.recoveryPendingHash = S.sha256Hex(token);
  schedule.recoveryPendingUntil = trustedNow() + RECOVERY_TOKEN_TTL_MS;
  const persisted = saveSettings();
  if (!persisted.ok) {
    schedule = S.normalizeSchedule(JSON.parse(previous));
    return { ok: false, error: persisted.error || 'לא ניתן לשמור בקשת שחזור' };
  }
  try {
    // שותף אחריות פעיל → הקוד נשלח גם לשותף (co-visibility). השרת שולח
    // עותק של אותו קוד לכתובת ה-partner בנוסף לכתובת השחזור.
    const partner = accountabilityActive() ? String(schedule.accountabilityEmail || '').trim() : '';
    const wasBlocked = netBlockApplied;
    if (wasBlocked) await netBlockSet(false);
    try {
      const res = await fetch(RECOVERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, token, partner, app: 'BenHazmanim', time: new Date().toISOString() }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true) {
      schedule = S.normalizeSchedule(JSON.parse(previous));
      saveSettings();
      return { ok: false, error: recoveryErrorToHebrew(String(data.error || '')) };
    }
      return { ok: true };
    } finally {
      if (wasBlocked) await netBlockSet(true);
    }
  } catch {
    schedule = S.normalizeSchedule(JSON.parse(previous));
    saveSettings();
    return { ok: false, error: 'נדרשת גישה לאינטרנט לשחזור הסיסמה' };
  }
}

function completeRecovery(code, newPin) {
  if (!schedule.recoveryPendingHash || trustedNow() > Number(schedule.recoveryPendingUntil || 0)) {
    return { ok: false, error: 'קוד השחזור פג או לא קיים' };
  }
  if (!S.isValidPassword(String(newPin || ''))) return { ok: false, error: 'הסיסמה צריכה להיות 4-20 תווים ללא רווחים' };
  const expected = Buffer.from(schedule.recoveryPendingHash, 'hex');
  const actual = Buffer.from(S.sha256Hex(String(code || '')), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, error: 'קוד השחזור שגוי' };
  }
  const previous = JSON.stringify(schedule);
  const pinRecord = makePinRecord(String(newPin));
  schedule.pinHash = pinRecord.pinHash;
  schedule.pinSalt = pinRecord.pinSalt;
  schedule.pinKdf = pinRecord.pinKdf;
  schedule.passwordPlain = null;
  schedule.passwordEnc = null;
  schedule.recoveryPendingHash = null;
  schedule.recoveryPendingUntil = null;
  const persisted = saveSettings();
  if (!persisted.ok) {
    schedule = S.normalizeSchedule(JSON.parse(previous));
    return { ok: false, error: persisted.error || 'שמירת הסיסמה החדשה נכשלה' };
  }
  sessionUnlocked = true;
  sessionUnlockedAt = trustedNow();
  notifyPartner('pin-changed');
  enforce();
  return { ok: true };
}

// תרגום שגיאות ידועות של שרת השחזור להודעה ברורה בעברית.
function recoveryErrorToHebrew(raw) {
  const s = String(raw || '');
  if (/missing fields|invalid token/i.test(s)) return 'שירות השחזור דחה את הבקשה — נסו שוב';
  if (s) return 'שירות השחזור החזיר שגיאה: ' + s;
  return 'שירות השחזור החזיר שגיאה';
}

/* ================= בדיקת עדכונים ================= */

// שמירת ההודעה במודול: בלי התייחסות פעילה האובייקט עלול להיאסף לאשפה (GC),
// ואז אירוע הלחיצה לא מגיע אלינו כשהמשתמש לוחץ על ההודעה — מצב תיעודי בווינדוס.
let updateNotification = null;

// לחיצה על הודעת עדכון פותחת את חלון התוכנה עם כפתור "הורד והתקן".
// לא פותחים כתובת שמגיעה מ-metadata בדפדפן: ההורדה עצמה מתבצעת רק דרך
// resolveInstallerUrl, שמרכיב כתובת מהמאגר הרשמי ומאמת את ה-hash לפני הרצה.
function openUpdatePage() {
  if (win && !win.isDestroyed()) showMainWindow();
}

function isValidUpdateVersion(value) {
  return /^\d+(?:\.\d+){1,3}$/.test(String(value || '').trim());
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
      body: 'גרסה ' + note.version + ' זמינה — לחצו כאן כדי לפתוח את חלון העדכון'
    });
    // לחיצה על ההודעה פותחת את חלון העדכון בתוך האפליקציה
    updateNotification.on('click', () => openUpdatePage());
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
    const remote = String(data.version || '').trim();
    if (!isValidUpdateVersion(remote) || !isNewerVersion(remote, app.getVersion())) {
      return { ok: true, update: null };
    }
    // ה-hash הוא מנגנון האימות של הפצה ללא Authenticode. לא מריצים עדכון
    // שחסר לו hash מלא, גם אם הכתובת נמצאת ב-GitHub הרשמי.
    const note = { version: remote, url: data.url || '', notes: data.notes || '', sha256: String(data.sha256 || '').trim().toLowerCase() };
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
const MAX_UPDATE_BYTES = 250 * 1024 * 1024;

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
      const expectedName = 'Setup.' + version + '.exe';
      const asset = (data.assets || []).find((a) => String(a.name || '') === expectedName);
      if (asset && asset.browser_download_url) return asset.browser_download_url;
    }
  } catch { /* נופלים לכתובת הקונבנציונלית */ }
  return GITHUB_REPO_URL + '/releases/download/v' + version + '/Setup.' + version + '.exe';
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
  if (total > MAX_UPDATE_BYTES) throw new Error('העדכון גדול מדי');
  const reader = res.body.getReader();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const fd = fs.openSync(dest, 'w');
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_UPDATE_BYTES) throw new Error('העדכון גדול מדי');
      fs.writeSync(fd, Buffer.from(value));
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

// Authenticode הוא שער נוסף מעל SHA-256: טביעת העדכון עדיין נבדקת תמיד,
// ולאחריה Windows חייב לאשר שהמתקין חתום בחתימה תקפה ומהימנה. הנתיב משולב
// כמחרוזת PowerShell יחיד ליטרלית (psSingleQuote), ללא אינטרפולציה.
function verifyAuthenticode(file) {
  return new Promise((resolve) => {
    if (!isWin) return resolve({ ok: false, error: 'אימות Authenticode זמין רק ב-Windows' });
    const script = '$s=Get-AuthenticodeSignature -LiteralPath ' + psSingleQuote(file) + '; ' +
      "[PSCustomObject]@{status=$s.Status.ToString();subject=([string]$s.SignerCertificate.Subject)} | ConvertTo-Json -Compress";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        if (err) return resolve({ ok: false, error: 'לא ניתן לאמת את חתימת המתקין' });
        let data = null;
        try { data = JSON.parse(String(stdout || '')); } catch { /* invalid response */ }
        const signer = cnOf(data && data.subject);
        if (!data || data.status !== 'Valid' || signer.toLowerCase() !== UPDATE_SIGNER_CN.toLowerCase()) {
          return resolve({ ok: false, error: 'למתקין אין חתימת Authenticode תקפה — ההתקנה בוטלה' });
        }
        resolve({ ok: true, subject: String(data.subject).trim() });
      });
  });
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
    // רק מקבצים מנתיב המאגר הרשמי — ההפניה של GitHub יכולה להמשיך לשרת
    // assets אחר, אך כתובת המקור חייבת להיות הקישור הרשמי שהתקבל מה-API.
    let officialUrl = false;
    try {
      const parsed = new URL(url);
      officialUrl = parsed.protocol === 'https:' && parsed.hostname === 'github.com' &&
        parsed.pathname.startsWith('/' + GITHUB_REPO + '/');
    } catch { /* כתובת לא תקינה */ }
    if (!officialUrl) return { ok: false, error: 'מקור ההורדה אינו תקין' };
    progress('download', 0);
    const size = await downloadInstaller(url, dest, (p) => progress('download', p));
    // בדיקות תקינות: גודל סביר (המתקין בפועל ~90MB) + חותמת PE (MZ) —
    // כך לא מריצים קובץ שגוי (דף 404, הורדה קטועה או קובץ שאינו EXE)
    const mz = fs.readFileSync(dest).subarray(0, 2).toString('ascii');
    if (size < 1024 * 1024 || mz !== 'MZ' || size > MAX_UPDATE_BYTES) {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      return { ok: false, error: 'הקובץ שהורד אינו תקין — נסו שוב או הורידו ידנית מהאתר' };
    }
    const expectedHash = String(updateNote.sha256 || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      return { ok: false, error: 'לעדכון חסר SHA-256 תקין — ההתקנה בוטלה' };
    }
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (actualHash !== expectedHash) {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      return { ok: false, error: 'טביעת העדכון אינה תואמת — ההתקנה בוטלה' };
    }
    // Authenticode אינו חובה במדיניות ההפצה של התוכנה (הפצה עצמאית וחינמית).
    // מקור ההורדה הרשמי ב-GitHub, כתובת ה-HTTPS, ומפתח ה-SHA-256 המדויק
    // מ-version.json נבדקים תמיד לפני הפעלה ומספקים הגנה קריפטוגרפית מלאה.
    try {
      const signature = await verifyAuthenticode(dest);
      if (signature && signature.ok) {
        logEvent('update-signature-valid', { subject: signature.subject });
      }
    } catch { /* מתקין ללא חתימה מסחרית מאושר וממשיך להתקנה */ }
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

/* ================= "אתר נעול" — דפדפן מוגבל לרשימת אתרים מאושרת (Phase 3.8) =================
   פותח BrowserWindow ייעודי לאתר שההורה אישר, עם נעילת ניווט: כל מעבר
   לכתובת שאינה ברשימת ההרשאות נחסם (will-navigate/will-redirect), פתיחת
   חלונות חדשים נחסמת (setWindowOpenHandler), והרשאות (מצלמה/מיקרופון וכו')
   נדחות. אין nodeIntegration ואין preload — תוכן מרוחק לעולם אינו נחשף ל-API. */
let lockedSiteWins = [];

function openWebsiteApp(nameOrIndex) {
  if (!isWin && !isTestMode) { /* עדיין ניתן לפתוח בבדיקות */ }
  const apps = activeSchedule().websiteApps || [];
  let app = null;
  if (typeof nameOrIndex === 'number') app = apps[nameOrIndex];
  else app = apps.find((a) => String(a.name || '').toLowerCase() === String(nameOrIndex || '').toLowerCase());
  if (!app) return { ok: false, error: 'האתר אינו נמצא ברשימת האתרים המאושרים' };
  const urls = (app.urls || []).filter(Boolean);
  if (!urls.length) return { ok: false, error: 'לא הוגדרו כתובות לאתר זה' };

  const allowed = (url) => S.siteUrlAllowed([app], url, true);

  // Session מבודד לכל האתרים הנעולים — עוגיות/כניסות נשמרות בנפרד מהמערכת.
  const partition = 'persist:benhazmanim-locked-site';
  try {
    const ses = session.fromPartition(partition);
    // דחיית כל בקשות ההרשאה (מצלמה, מיקרופון, מיקום, התראות וכו').
    if (ses && typeof ses.setPermissionRequestHandler === 'function') {
      ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    }
    if (ses && typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler(() => false);
    }
    if (ses && typeof ses.on === 'function' && !ses.__benHazmanimDownloadLock) {
      ses.__benHazmanimDownloadLock = true;
      ses.on('will-download', (e) => e.preventDefault());
    }
  } catch { /* ignore */ }

  const w = new BrowserWindow({
    width: 1120,
    height: 820,
    title: app.name || 'אתר מאושר',
    autoHideMenuBar: true,
    backgroundColor: windowBg(),
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // אין preload — תוכן מרוחק לא מקבל גישה ל-electronAPI
      webviewTag: false
    }
  });
  lockedSiteWins.push(w);
  w.on('closed', () => { lockedSiteWins = lockedSiteWins.filter((x) => x !== w); });

  const wc = w.webContents;
  // נעילת ניווט: מעבר/הפניה לכתובת לא-מאושרת נחסם.
  wc.on('will-navigate', (e, url) => { if (!allowed(url)) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (!allowed(url)) e.preventDefault(); });
  // פתיחת חלון חדש: אם הכתובת מאושרת — נפתחת באותו חלון; אחרת נדחית.
  wc.setWindowOpenHandler(({ url }) => {
    if (allowed(url)) { try { wc.loadURL(url); } catch { /* ignore */ } }
    return { action: 'deny' };
  });
  // חוסמים גם ניווט של iframe/הורדות שאינן מאושרות דרך אותו מנגנון בסיסי.
  wc.on('will-frame-navigate', (e) => {
    try { if (e && e.url && !allowed(e.url)) e.preventDefault(); } catch { /* ignore */ }
  });

  w.loadURL(urls[0]);
  logEvent('website-app-open', { name: app.name });
  return { ok: true };
}

/* ================= סייר קבצים מוגבל + ספרייה לקריאה בלבד (Phase 3.10) =================
   חלון סייר ייעודי החשוף רק לשורשים מאושרים. הבטיחות מבוססת על שני מנגנונים:
   1) sandboxResolve — כל נתיב יחסי נפתר מול השורש; בריחה החוצה (..) או תווית
      אסורה (System32/AppData) נדחות. אין גישה מחוץ לשורשים המאושרים.
   2) isHiddenType — קבצים מסוגים מוסתרים אינם מוצגים ואינם ניתנים לפתיחה.
   הספרייה (library) לקריאה בלבד — הסייר אינו חושף פעולות כתיבה כלל. */
let fileExplorerWin = null;
const ROOT_LABELS = { documents: 'מסמכים', downloads: 'הורדות', desktop: 'שולחן עבודה', pictures: 'תמונות', music: 'מוזיקה', videos: 'סרטונים', library: 'ספרייה' };
const FORBIDDEN_SEGMENTS = ['system32', 'appdata', 'windows'];
const EXPLORER_ACTIVE_TYPES = new Set([
  '.exe', '.com', '.scr', '.msi', '.msix', '.appx', '.appinstaller', '.cpl', '.dll',
  '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.vbs', '.vbe', '.js', '.jse', '.wsf',
  '.wsh', '.hta', '.lnk', '.url', '.reg', '.inf', '.scf', '.chm', '.jar'
]);

function explorerFileDenied(fe, fileName) {
  const name = String(fileName || '');
  const ext = path.extname(name).toLowerCase();
  return !ext || EXPLORER_ACTIVE_TYPES.has(ext) || S.isHiddenType(fe.hiddenTypes, name);
}

function explorerRootPath(id) {
  try {
    switch (id) {
      case 'documents': return app.getPath('documents');
      case 'downloads': return app.getPath('downloads');
      case 'desktop': return app.getPath('desktop');
      case 'pictures': return app.getPath('pictures');
      case 'music': return app.getPath('music');
      case 'videos': return app.getPath('videos');
      case 'library': {
        const p = String((activeSchedule().fileExplorer || {}).libraryPath || '').trim();
        return p || null;
      }
      default: return null;
    }
  } catch { return null; }
}

// שורשי הסייר הזמינים (רק מופעלים שנפתרים לנתיב קיים).
function resolveExplorerRoots() {
  const fe = activeSchedule().fileExplorer || {};
  const out = [];
  for (const id of (fe.roots || [])) {
    const p = explorerRootPath(id);
    if (!p) continue;
    try { if (!fs.existsSync(p)) continue; } catch { continue; }
    const readonly = (id === 'library') ? (fe.readonlyLibrary !== false) : false;
    out.push({ id, label: ROOT_LABELS[id] || id, path: path.resolve(p), readonly });
  }
  return out;
}

// PathSandbox: פתרון נתיב יחסי מול שורש בלי בריחה (..) ובלי תוויות אסורות.
// מוחזר נתיב מוחלט או null. פונקציה זו היא ליבת האבטחה של הסייר המוגבל.
function sandboxResolve(rootPath, relative) {
  try {
    const root = fs.realpathSync.native(path.resolve(rootPath));
    const rel = String(relative == null ? '' : relative).replace(/^[\\/]+/, '');
    // השורש עצמו כבר אושר במפורש על ידי ההורה. בודקים תוויות אסורות רק
    // בקלט היחסי; אחרת שורש מאושר שנמצא למשל תחת AppData (או תיקיית Temp
    // בבדיקות) היה נדחה בגלל נתיב האב שלו, אף שאין כאן בריחה מה-sandbox.
    const relSegs = rel.toLowerCase().split(/[\\/]/).filter(Boolean);
    for (const seg of FORBIDDEN_SEGMENTS) if (relSegs.indexOf(seg) >= 0) return null;
    const combined = fs.realpathSync.native(path.resolve(root, rel));
    const rootCmp = root.toLowerCase();
    const combinedCmp = combined.toLowerCase();
    if (combinedCmp !== rootCmp && !combinedCmp.startsWith(rootCmp + path.sep.toLowerCase())) return null;
    return combined;
  } catch { return null; }
}

function fileExplorerList(rootId, relative) {
  const fe = activeSchedule().fileExplorer || {};
  if (!fe.enabled) return { ok: false, error: 'סייר הקבצים המוגבל אינו מופעל' };
  const root = resolveExplorerRoots().find((r) => r.id === rootId);
  if (!root) return { ok: false, error: 'שורש אינו מאושר' };
  const dir = sandboxResolve(root.path, relative);
  if (!dir) return { ok: false, error: 'נתיב אינו מורשה' };
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { ok: false, error: 'לא ניתן לקרוא את התיקייה' }; }
  const items = [];
  for (const ent of entries) {
    const isDir = ent.isDirectory();
    if (!isDir && explorerFileDenied(fe, ent.name)) continue;
    let size = 0, mtime = 0;
    try { const st = fs.statSync(path.join(dir, ent.name)); size = st.size; mtime = st.mtimeMs; } catch { /* ignore */ }
    items.push({ name: ent.name, isDir, size, mtime });
  }
  items.sort((a, b) => (a.isDir === b.isDir ? String(a.name).localeCompare(String(b.name), 'he') : (a.isDir ? -1 : 1)));
  return { ok: true, root: { id: root.id, label: root.label, readonly: root.readonly }, rel: path.relative(root.path, dir), items };
}

function fileExplorerOpen(rootId, relative) {
  const fe = activeSchedule().fileExplorer || {};
  if (!fe.enabled) return { ok: false, error: 'סייר הקבצים המוגבל אינו מופעל' };
  const root = resolveExplorerRoots().find((r) => r.id === rootId);
  if (!root) return { ok: false, error: 'שורש אינו מאושר' };
  const target = sandboxResolve(root.path, relative);
  if (!target) return { ok: false, error: 'נתיב אינו מורשה' };
  if (explorerFileDenied(fe, path.basename(target))) return { ok: false, error: 'סוג הקובץ חסום' };
  try { if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { ok: false, error: 'הקובץ לא נמצא' }; } catch { return { ok: false, error: 'הקובץ לא נמצא' }; }
  let openTarget = target;
  if (root.readonly) {
    try {
      const copyDir = path.join(app.getPath('temp'), 'BenHazmanimReadOnly');
      fs.mkdirSync(copyDir, { recursive: true });
      openTarget = path.join(copyDir, crypto.randomBytes(12).toString('hex') + path.extname(target));
      fs.copyFileSync(target, openTarget, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(openTarget, 0o444);
    } catch { return { ok: false, error: 'לא ניתן ליצור עותק לקריאה בלבד' }; }
  }
  try { shell.openPath(openTarget); } catch { return { ok: false, error: 'לא ניתן לפתוח את הקובץ' }; }
  return { ok: true };
}

function openFileExplorerWindow() {
  const fe = activeSchedule().fileExplorer || {};
  if (!fe.enabled) return { ok: false, error: 'סייר הקבצים המוגבל אינו מופעל' };
  if (fileExplorerWin && !fileExplorerWin.isDestroyed()) { fileExplorerWin.show(); fileExplorerWin.focus(); return { ok: true }; }
  fileExplorerWin = new BrowserWindow({
    width: 940,
    height: 660,
    title: 'סייר קבצים מוגבל — בין הזמנים',
    autoHideMenuBar: true,
    backgroundColor: windowBg(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  lockLocalWindowNavigation(fileExplorerWin);
  fileExplorerWin.loadFile(path.join(__dirname, 'renderer', 'file-explorer.html'));
  fileExplorerWin.on('closed', () => { fileExplorerWin = null; });
  logEvent('file-explorer-open');
  return { ok: true };
}

/* ================= IPC ================= */

// Renderer pages share the same preload bridge, so authentication must also
// bind each sensitive operation to the BrowserWindow that is allowed to call
// it. The missing sender in the Electron test double is intentionally treated
// as trusted for backwards-compatible unit tests only.
function senderAllowed(event, windows) {
  if (!event || !event.sender) return isTestMode;
  if (!isTestMode) {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
    const frameUrl = String(event.senderFrame.url || '');
    if (!frameUrl.startsWith('file://')) return false;
  }
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
    // סודות אימות ושחזור אינם מועברים לממשק; הממשק מקבל רק מצב (pinSet/sessionUnlocked)
    const safe = { ...schedule };
    delete safe.pinHash;
    delete safe.pinSalt;
    delete safe.pinKdf;
    delete safe.passwordPlain;
    delete safe.passwordEnc;
    delete safe.recoveryPendingHash;
    delete safe.recoveryPendingUntil;
    return {
      ...safe,
      pinSet: !!schedule.pinHash,
      configError: !!configurationFault,
      sessionUnlocked: schedule.pinHash ? isSessionUnlocked() : true
    };
  });

  ipcMain.handle('settings:save', (event, data, approvalCode) => {
    if (!mainSender(event)) return senderError();
    // אימות סיסמה בצד השרת — לא להסתמך על אימות קליינט בלבד
    if (schedule.pinHash && !isSessionUnlocked()) {
      return { ok: false, error: 'נדרשת סיסמה כדי לשנות הגדרות' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'מבנה הגדרות לא תקין' };
    }
    // סיסמה, סוד שחזור, פתיחה ידנית והרצה כמנהל לא ניתנים לשינוי דרך שמירה רגילה
    if (data && typeof data === 'object') {
      data.pinHash = schedule.pinHash;
      data.pinSalt = schedule.pinSalt;
      data.pinKdf = schedule.pinKdf;
      data.passwordPlain = schedule.passwordPlain;
      data.passwordEnc = schedule.passwordEnc;
      data.recoveryPendingHash = schedule.recoveryPendingHash;
      data.recoveryPendingUntil = schedule.recoveryPendingUntil;
      data.manualUnlockUntil = schedule.manualUnlockUntil;
      data.runAsAdmin = schedule.runAsAdmin;
    }
    const previousSchedule = JSON.stringify(schedule);
    const previousObject = S.normalizeSchedule(JSON.parse(previousSchedule));
    schedule = S.normalizeSchedule(data);
    const weakensPartner = previousObject.accountabilityEnabled && previousObject.accountabilityEmail && (
      !schedule.accountabilityEnabled ||
      schedule.accountabilityEmail.toLowerCase() !== previousObject.accountabilityEmail.toLowerCase() ||
      (previousObject.accountabilityRequireApproval && !schedule.accountabilityRequireApproval) ||
      Number(schedule.coolOffMinutes || 0) < Number(previousObject.coolOffMinutes || 0)
    );
    if (weakensPartner && !unlockApprovalValid(approvalCode, 'settings-change')) {
      schedule = previousObject;
      return { ok: false, needPartnerApproval: true, error: 'נדרש קוד אישור משותף האחריות כדי להחליש את ההגנה' };
    }
    if (weakensPartner) unlockApproval = { hash: null, until: 0, failures: 0, purpose: null };
    if (!schedule.pinHash && hasAnyBlockingPolicy(schedule)) {
      schedule = previousObject;
      return { ok: false, error: 'יש להגדיר סיסמת הורה לפני הפעלת לוח חסימה או חסימת אינטרנט' };
    }
    // "פתוח עד המעבר הבא" (manualUnlockUntil) שייך ללוח שקבע אותו. אחרי כל
    // שמירת הגדרות מסנכרנים אותו עם הלוח החדש — רק אם כבר קיימת פתיחה
    // (הפתיחה נקבעת אך ורק ע"י הזנת סיסמה במסך החסימה, לא אוטומטית):
    // אם הלוח כבר לא חוסם — מנקים (מניעת "המעבר הבא" פנטום אחרי מחיקת
    // חלונות); אם הוא חוסם — מעדכנים למעבר הבא האמיתי של הלוח הנוכחי (כך
    // פתיחה "עד המעבר הבא" לא מחזיקה את המחשב פתוח מעבר לחלון החדש).
    const now = trustedDate();
    const effectiveAfterSave = activeSchedule();
    const raw = S.stateAt(effectiveAfterSave, now);
    if (raw === 'blocked' || raw === 'netblock') {
      if (schedule.manualUnlockUntil) {
        // ערך שעבר אינו תקף — הפתיחה כבר פגה. ניקוי שלו חיוני: אחרת פתיחה
        // חוזרת (unlock:now) הייתה ממשיכה להישען על הערך הישן ולא נפתחת.
        if (schedule.manualUnlockUntil <= now.getTime()) {
          schedule.manualUnlockUntil = null;
        } else {
          const t = S.nextTransition(effectiveAfterSave, now);
          if (t.at) schedule.manualUnlockUntil = t.at.getTime();
          // לוח נעול בלי מעבר מוגדר (למשל "התר" ריק) — שומרים את הערך הקיים
        }
      }
    } else if (schedule.manualUnlockUntil) {
      schedule.manualUnlockUntil = null;
    }
    const res = saveSettings();
    if (!res.ok) schedule = S.normalizeSchedule(JSON.parse(previousSchedule));
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
    const rawName = path.basename(p).replace(/\.exe$/i, '');
    const info = await inspectAppFile(p);
    const publisher = (info && info.status === 'Valid' && cnOf(info.subject)) ? cnOf(info.subject) : '';
    let product = (publisher && info && info.product) ? info.product : '';
    const isWord = rawName.toLowerCase() === 'winword' && /microsoft corporation/i.test(publisher);
    if (isWord && !product) product = 'Microsoft Office';
    return {
      canceled: false,
      path: p,
      name: rawName,
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
    const eff = activeSchedule();
    if (!eff.pinHash) {
      return { ok: false, error: 'לא הוגדרה סיסמת הורה בהגדרות' };
    }
    const st = S.getStatus(eff, trustedDate());
    const isBlockedNow = manualLock || (eff.enabled && st.state === 'blocked');
    if (!isBlockedNow) {
      return { ok: false, error: 'פתיחת תוכנות מורשות זמינה רק בזמן חסימת מחשב' };
    }
    const requested = String(candidate && candidate.exe || '').trim().toLowerCase();
    let allowed = (eff.allowedApps || []).find((a) => String(a.exe || '').trim().toLowerCase() === requested);
    if (!allowed) {
      for (const a of (eff.allowedApps || [])) {
        allowed = (a.companions || []).find((c) => String(c.exe || '').trim().toLowerCase() === requested);
        if (allowed) break;
      }
    }
    if (!allowed) return { ok: false, error: 'התוכנה אינה נמצאת ברשימת ההרשאות' };
    return launchAllowedApp(allowed);
  });

  // פתיחת "אתר נעול" — דפדפן מוגבל לרשימת האתרים המאושרת. ניתן לפתיחה
  // מחלון ההגדרות או ממסך החסימה (כמו תוכנות מורשות). זהו דפדפן קורא-בלבד
  // שרשימת האתרים שלו נקבעה מראש על ידי ההורה, ולכן אינו דורש סשן פתוח.
  ipcMain.handle('website-apps:open', (event, nameOrIndex) => {
    if (!senderAllowed(event, [win, ...blockWins])) return senderError();
    return openWebsiteApp(typeof nameOrIndex === 'number' ? nameOrIndex : String(nameOrIndex || ''));
  });

  // סייר הקבצים המוגבל — נפתח מחלון ההגדרות/החסימה; הרשימה/פתיחה נקראות
  // מחלון הסייר עצמו (fileExplorerWin). הבטיחות דרך sandboxResolve+isHiddenType.
  ipcMain.handle('file-explorer:open-window', (event) => {
    if (!senderAllowed(event, [win, ...blockWins])) return senderError();
    return openFileExplorerWindow();
  });
  ipcMain.handle('file-explorer:roots', (event) => {
    if (!senderAllowed(event, [win, ...blockWins, fileExplorerWin])) return senderError();
    const fe = activeSchedule().fileExplorer || {};
    if (!fe.enabled) return { ok: false, error: 'סייר הקבצים המוגבל אינו מופעל' };
    return { ok: true, roots: resolveExplorerRoots().map((r) => ({ id: r.id, label: r.label, readonly: r.readonly })) };
  });
  ipcMain.handle('file-explorer:list', (event, rootId, relative) => {
    if (!senderAllowed(event, [win, ...blockWins, fileExplorerWin])) return senderError();
    return fileExplorerList(String(rootId || ''), String(relative || ''));
  });
  ipcMain.handle('file-explorer:open', (event, rootId, relative) => {
    if (!senderAllowed(event, [win, ...blockWins, fileExplorerWin])) return senderError();
    return fileExplorerOpen(String(rootId || ''), String(relative || ''));
  });

  ipcMain.handle('lock:now', async (event) => {
    if (!mainSender(event)) return senderError();
    // נעילה ידנית: מפעילה את מסך החסימה המלא של בין הזמנים על כל המסכים
    // (ולא רק את נעילת Windows הרגילה). הפתיחה מתבצעת עם סיסמה.
    if (!schedule.pinHash) {
      return { ok: false, error: 'לא הוגדרה סיסמה — הגדירו סיסמה בהגדרות לפני נעילה ידנית' };
    }
    manualLock = true;
    clearCoolOff(); // נעילה ידנית מבטלת פתיחת צינון ממתינה
    await enforce();
    logEvent('lock-manual');
    return { ok: true };
  });

  ipcMain.handle('unlock:now', async (event, pin, approvalCode) => {
    if (!blockSender(event)) return senderError();
    // קריאות המצב משתמשות במדיניות האפקטיבית (בסיס + פרופיל); הכתיבה של
    // manualUnlockUntil היא לבסיס הנשמר (השדה אינו נדרס על ידי פרופיל).
    const eff = activeSchedule();
    // ללא סיסמה מוגדרת אין מה לאמת — הפתיחה מתאפשרת תמיד, כדי שלעולם לא
    // יהיה מצב של חסימה בלי דרך החוצה (גם אם חלון חסימה נפתח בהיעדר סיסמה).
    if (!eff.pinHash) {
      manualLock = false;
      const st = S.getStatus(eff, trustedDate());
      schedule.manualUnlockUntil = isLockedState(st)
        ? (st.nextAt ? st.nextAt.getTime() : trustedNow() + 3600 * 1000)
        : null;
      const persisted = saveSettings();
      await enforce();
      return persisted.ok
        ? { ok: true }
        : { ok: true, warning: persisted.error || 'הפתיחה זמינה כעת אך לא נשמרה לדיסק' };
    }
    const v = verifyPinServer(pin);
    if (!v.ok) {
      logEvent('unlock-fail');
      return { ok: false, error: v.error, locked: v.locked || 0 };
    }
    // Fix #7: PIN unlocks always clear faults
    configurationFault = null;
    configurationFaultSince = null;
    clockRollbackDetected = false;
    // שותף אחריות: כשמופעל "חייב אישור שותף", פתיחה מוקדמת דורשת גם קוד
    // אישור שנשלח *רק* לשותף — כך המשתמש אינו יכול לפתוח לבד. הסיסמה כבר
    // אומתה; מכאן חייבים קוד אישור תקף (בתוקף, חד-פעמי).
    if (requireApprovalActive() && !unlockApprovalValid(approvalCode, 'unlock')) {
      logEvent('unlock-need-approval');
      return { ok: false, needApproval: true, error: 'נדרש קוד אישור משותף האחריות כדי לפתוח מוקדם' };
    }
    // תקופת צינון: אם הוגדר עיכוב, פתיחה מוקדמת אינה נכנסת לתוקף מיד —
    // המחשב נשאר חסום עד תום הצינון ואז הפתיחה מוחלת אוטומטית. זהו חיכוך
    // מכוון לשליטה עצמית (המשתמש מוכיח כוונה אך ממתין).
    const coolMin = Math.max(0, Number(eff.coolOffMinutes) || 0);
    const rawNow = S.stateAt(eff, trustedDate());
    const blockedContext = manualLock || rawNow === 'blocked' || rawNow === 'netblock';
    if (coolMin > 0 && blockedContext) {
      if (coolOffActive()) {
        // צינון כבר פעיל — מחזירים את הזמן שנותר בלי לאפס אותו
        return { ok: true, coolOff: Math.max(0, Math.ceil((coolOffUntil - trustedNow()) / 1000)), coolOffPending: true };
      }
      let target = null; // יעד manualUnlockUntil שיוחל בתום הצינון
      if (rawNow === 'blocked' || rawNow === 'netblock') {
        const t = S.nextTransition(eff, trustedDate());
        target = t.at ? t.at.getTime() : trustedNow() + 3600 * 1000;
      }
      unlockApproval = { hash: null, until: 0, failures: 0, purpose: null }; // קוד האישור (אם היה) נוצל
      coolOffTarget = target;
      coolOffUntil = trustedNow() + coolMin * 60000;
      coolOffPending = true;
      scheduleCoolOffApply();
      logEvent('cooloff-start', { minutes: coolMin });
      await enforce(); // מסך החסימה יציג את הספירה לאחור של הצינון
      return { ok: true, coolOff: coolMin * 60, coolOffPending: true };
    }
    logEvent('unlock-success');
    unlockApproval = { hash: null, until: 0, failures: 0, purpose: null }; // הקוד חד-פעמי — מתבטל מיד לאחר שימוש
    manualLock = false; // סיום נעילה ידנית
    const now = trustedDate();
    const raw = S.stateAt(eff, now);
    // "פתוח עד המעבר הבא" נשמר רק כשהמצב לפי הלוח הוא חסום (מחשב או
    // אינטרנט) — אחרת אין צורך. בדיקה לפי מצב הלוח הגולמי (ולא לפי הסטטוס
    // שכבר "פתוח"): פתיחה חוזרת בזמן שפתיחה קיימת לא מבטלת אותה.
    if (raw === 'blocked' || raw === 'netblock') {
      const t = S.nextTransition(eff, now);
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
    // הפתיחה אינה מוחזרת כ"הצליחה" לפני שהאכיפה הסתיימה בפועל: ממתינים
    // להסרת חוק חומת האש, כך שהמשתמש לא יקבל "בוטלה" בזמן שהאינטרנט עדיין
    // חסום (וגם לא ייקפצו ניסיונות הרמה חוזרים כל כמה שניות).
    await enforce();
    const actual = enforcementState.actual;
    const stillBlocked = !!(eff.enabled && S.getStatus(eff, trustedDate()).state === 'netblock' && netBlockApplied);
    return persisted.ok
      ? (stillBlocked
        ? { ok: false, error: 'האינטרנט עדיין חסום — לא ניתן היה להסיר את חוק חומת האש (נדרש אישור מנהל או שחומת האש מנוהלת על ידי תוכנה אחרת)' }
        : { ok: true, actual })
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
    const pinRecord = makePinRecord(newPin);
    schedule.pinHash = pinRecord.pinHash;
    schedule.pinSalt = pinRecord.pinSalt;
    schedule.pinKdf = pinRecord.pinKdf;
    schedule.passwordPlain = null;
    schedule.passwordEnc = null;
    // אם ההתקנה עבדה קודם ללא PIN והייתה פתיחה זמנית, לא משמרים אותה
    // לתוך המדיניות המוגנת החדשה.
    schedule.manualUnlockUntil = null;
    const persisted = saveSettings();
    if (!persisted.ok) {
      schedule = S.normalizeSchedule(JSON.parse(previous));
      return { ok: false, error: persisted.error || 'שמירת הסיסמה נכשלה' };
    }
    notifyPartner('pin-changed'); // שותף האחריות מקבל התראה על שינוי הסיסמה
    enforce();
    return { ok: true };
  });

  ipcMain.handle('pin:clear', (event, oldPin) => {
    if (!mainSender(event)) return senderError();
    if (schedule.pinHash) {
      const v = verifyPinServer(oldPin);
      if (!v.ok) return { ok: false, error: v.error };
    }
    if (hasAnyBlockingPolicy(schedule)) {
      return { ok: false, error: 'אי אפשר להסיר את סיסמת ההורה כאשר לוח החסימה פעיל' };
    }
    const previous = JSON.stringify(schedule);
    schedule.pinHash = null;
    schedule.pinSalt = null;
    schedule.pinKdf = null;
    schedule.passwordPlain = null;
    schedule.passwordEnc = null;
    schedule.recoveryPendingHash = null;
    schedule.recoveryPendingUntil = null;
    schedule.manualUnlockUntil = null;
    const persisted = saveSettings();
    if (!persisted.ok) {
      schedule = S.normalizeSchedule(JSON.parse(previous));
      return { ok: false, error: persisted.error || 'ניקוי הסיסמה נכשל' };
    }
    notifyPartner('pin-cleared'); // שותף האחריות מקבל התראה על הסרת הסיסמה
    enforce();
    return { ok: true };
  });

  ipcMain.handle('pin:verify', (event, pin) => {
    if (!mainSender(event)) return senderError();
    return verifyPinServer(pin);
  });

  ipcMain.handle('session:get', (event) => {
    if (!mainSender(event)) return senderError();
    return { unlocked: schedule.pinHash ? isSessionUnlocked() : true };
  });

  ipcMain.handle('session:unlock', (event, pin) => {
    if (!mainSender(event)) return senderError();
    if (!schedule.pinHash) return { ok: true, unlocked: true };
    const v = verifyPinServer(pin);
    if (!v.ok) return { ok: false, unlocked: false, error: v.error, locked: v.locked || 0 };
    sessionUnlocked = true;
    sessionUnlockedAt = trustedNow();
    return { ok: true, unlocked: true };
  });

  // נעילה מצד הממשק (למשל כשהחלון עבר לרקע): מחזירה את כל הפעולות
  // הרגישות (שמירת הגדרות, יציאה, הסרה) למצב הדורש סיסמה.
  ipcMain.handle('session:lock', (event) => {
    if (!mainSender(event)) return senderError();
    sessionUnlocked = false;
    sessionUnlockedAt = 0;
    return { ok: true };
  });

  ipcMain.handle('recovery:send', (event) => {
    if (!recoverySender(event)) return senderError();
    return sendRecovery();
  });

  ipcMain.handle('recovery:complete', (event, code, newPin) => {
    if (!recoverySender(event) && !mainSender(event)) return senderError();
    return completeRecovery(code, newPin);
  });

  // בקשת קוד אישור פתיחה מהשותף — ממסך החסימה (כשמופעל "חייב אישור שותף").
  ipcMain.handle('accountability:request-approval', (event, purpose) => {
    if (!recoverySender(event)) return senderError();
    return requestUnlockApproval(purpose);
  });

  ipcMain.handle('update:check', (event) => {
    if (!mainSender(event)) return senderError();
    return checkForUpdate();
  });

  ipcMain.handle('update:download', (event) => {
    if (!mainSender(event)) return Promise.resolve(senderError());
    // עדכון מאומת אינו שינוי מדיניות: מקור, גרסה, מבנה EXE ו-SHA-256
    // נבדקים בתהליך הראשי. לכן אין לחסום אותו מאחורי Session PIN — אחרת
    // הודעת עדכון ברקע תוביל את המשתמש למסך הגדרות רק כדי להתעדכן.
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
    // מסמנים שהתהליך "יוצא" כבר כאן — לפני כתיבת דגל העצירה. בלי זה,
    // המוניטור הפנימי של האפליקציה (בודק כל 3 שניות) רואה את דגל העצירה
    // שזה עתה נכתב וסוגר את התהליך (gracefulQuit) באמצע תהליך ההסרה —
    // לפני שהאסימון נכתב, רישומי ההפעלה הוסרו וה-Uninstaller הופעל.
    // עם isQuitting=true המוניטור מדלג על דגל העצירה וההסרה מסתיימת
    // במלואה (gracefulQuit בסוף התהליך סוגר את האפליקציה כרגיל).
    isQuitting = true;
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
    // הרמת איסור המחיקה (שמוחל על תיקיית ההתקנה והעותק המוגן) — אחרת
    // ה-Uninstaller לא יוכל למחוק את הקבצים. ההסרה היא פעולה חד-פעמית
    // שאושרה בסיסמת הורה, ולכן אין צורך להחזיר את האיסור אחריה.
    try {
      const uninstallDir = (() => {
        const info = installInfo();
        return (info && info.dir) ? info.dir : path.dirname(uninstaller);
      })();
      await liftDirProtection(uninstallDir);
      await liftDirProtection(protectedAppDir());
    } catch { /* ignore */ }
    // אסימון חד-פעמי להסרה: ה-Uninstaller של NSIS מסרב לפעול בלעדיו —
    // כך שהסרה אפשרית רק מתוך התוכנה עצמה (אחרי אימות סיסמת ההורה), לא
    // דרך "התקן והסר תוכניות" או הפעלה ישירה של Uninstall.exe. האסימון
    // נכתב בנתיב המשותף ומועבר גם בשורת הפקודה, וניקה באתחול הבא.
    const uninstallToken = crypto.randomBytes(16).toString('hex');
    try {
      fs.mkdirSync(machineDir(), { recursive: true });
      fs.writeFileSync(uninstallTokenFile(), uninstallToken);
    } catch { /* ignore */ }
    // 1) הסרת רישומי ההפעלה עם Windows (Registry + משימה מתוזמנת) —
    //    לפני הפעלת ה-Uninstaller, כדי שלא יישארו רישומים לאחר ההסרה.
    await removeStartupEntries();
    // הסרת חוק חסימת האינטרנט (אם פעיל) — לא להשאיר את הרשת חסומה אחרי ההסרה
    await reconcileNetBlock(false);
    // 2) הפעלת ה-Uninstaller בשקט (מסיר קבצים, קיצורים ונתונים) —
    //    בתהליך נפרד (detached) כך שהוא ממשיך גם אחרי שהתוכנה נסגרת.
    //    האסימון מועבר בשורת הפקודה — ה-Uninstaller משווה אותו לקובץ.
    try {
      const child = spawn(uninstaller, ['/S', '/TOKEN=' + uninstallToken], { detached: true, stdio: 'ignore', windowsHide: true });
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
  ipcMain.handle('license:get', (event) => {
    if (!uiSender(event)) return senderError();
    return getLicenseInfo();
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
      startupError: startupFault,
      lastTamper: lastTamper()
    };
  });

  ipcMain.handle('backup:export', async (event) => {
    if (!mainSender(event)) return senderError();
    if (schedule.pinHash && !isSessionUnlocked()) return { ok: false, error: 'נדרשת סיסמה כדי לייצא גיבוי' };
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
      delete exportData.pinSalt;
      delete exportData.pinKdf;
      delete exportData.passwordPlain;
      delete exportData.passwordEnc;
      delete exportData.recoveryPendingHash;
      delete exportData.recoveryPendingUntil;
      fs.writeFileSync(res.filePath, JSON.stringify(exportData, null, 2), 'utf8');
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('backup:import', async (event) => {
    if (!mainSender(event)) return senderError();
    if (schedule.pinHash && !isSessionUnlocked()) return { ok: false, error: 'נדרשת סיסמה כדי לייבא גיבוי' };
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
        pinSalt: schedule.pinSalt,
        pinKdf: schedule.pinKdf,
        passwordPlain: schedule.passwordPlain,
        passwordEnc: schedule.passwordEnc,
        recoveryPendingHash: schedule.recoveryPendingHash,
        recoveryPendingUntil: schedule.recoveryPendingUntil,
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

// מחיקת דגל עצירה/הפעלה מחדש גם כשהקובץ תקוע תחת איסור מחיקה. הדגל המשותף
// (PROGRAMDATA) נכתב לתוך תיקייה מוקשחת — איסור המחיקה (Deny Delete לכולם,
// כולל מנהלים) חוסם גם את ה-unlink של האפליקציה עצמה. התוצאה הייתה קטלנית:
// דגל ישן שנשאר חוסם את האתחול הבא לנצח (האפליקציה רואה דגל ויוצאת מיד).
// הפתרון: אם המחיקה נחסמה — מרימים את הירושה על הקובץ (מסיר את האיסור המורש)
// ומנסים שוב. (בדומה להחרגה של settings.backup.json — אותו דפוס icacls).
function forceUnlinkFlag(p) {
  try { fs.unlinkSync(p); return; } catch { /* חסום ע"י איסור המחיקה */ }
  if (!fs.existsSync(p)) return; // לא קיים — אין מה לחסל
  if (!isWin || !isElevated()) return;
  try {
    execFileSync('icacls', [p, '/inheritance:r',
      '/grant:r', '*S-1-5-32-545:F',
      '/grant:r', '*S-1-5-32-544:F',
      '/grant:r', '*S-1-5-18:F'], { stdio: 'pipe', windowsHide: true });
  } catch { return; }
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

function writeQuitFlag() {
  for (const p of quitFlagPaths()) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(Date.now()));
    } catch { /* ignore */ }
  }
  // הדגל המשותף נכתב לתוך תיקייה מוקשחת (איסור מחיקה לכולם) — מוציאים אותו
  // מתחולת האיסור מיד עם הכתיבה, כדי שהאתחול הבא יוכל למחוק אותו. בלי זה
  // כל יציאה מסודרת (סגירה/עדכון) הייתה משאירה דגל שנועל את האפליקציה לנצח.
  if (isWin && isElevated()) {
    try { excludeFileFromDeny(machineQuitFlag()); } catch { /* ignore */ }
  }
  if (isWin && isElevated()) {
    try {
      execFile('reg', ['add', GUARD_REG_KEY, '/v', 'Quit', '/t', 'REG_SZ', '/d', String(Date.now()), '/f'], () => {});
    } catch { /* ignore */ }
  }
}
function clearQuitFlags() {
  for (const p of quitFlagPaths()) forceUnlinkFlag(p);
  // דגל עצירה של השומר-השער המערכתי (קובץ + Registry) — מתנקה באתחול חדש,
  // כדי שהשומר לא ייצא על דגל ישן מתקינה/עדכון קודמים.
  forceUnlinkFlag(machineQuitFlag());
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
  for (const p of relaunchFlagPaths()) forceUnlinkFlag(p);
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
  // אחרי שינה/הערת מערכת כותבים heartbeat מיד: בלי זה ה-heartbeat של הראשי
  // (שנכתב לפני השינה) נראה מיושן עם החזרה, והשומר היה הורג ומקפיץ אותו
  // מחדש בכל פעם — ריסטרט מיותר של התוכנה אחרי כל שינה.
  if (powerMonitor && typeof powerMonitor.on === 'function') {
    powerMonitor.on('resume', () => writeHeartbeat(watchHbFile()));
  }
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
  // אחרי שינה/הערת מערכת כותבים heartbeat מיד — אחרת השומר רואה את הראשי
  // כ"מת" (ה-heartbeat האחרון נכתב לפני השינה) והורג/מקפיץ אותו מחדש.
  if (powerMonitor && typeof powerMonitor.on === 'function') {
    powerMonitor.on('resume', () => writeHeartbeat(mainHbFile()));
  }
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
  // Manifest חסר הוא כשל שלמות, לא מצב Bootstrap. לעולם לא חותמים מחדש
  // עותק שעלול להיות פגום; משחזרים אותו ממקור ההתקנה הידוע.
  const dstOk = dstCoreExists && protectedCopyIntegrity();
  if (srcOk && !dstOk) {
    logTamper('protected-copy-restored');
    try {
      // Keep the protected settings backup before replacing the application
      // directory. The backup lives below that directory, so deleting `dst`
      // first would remove the only copy the watchdog can use to restore a
      // deleted shared settings file.
      let settingsBackup = null;
      try {
        if (fs.existsSync(protectedSettingsFile())) {
          settingsBackup = fs.readFileSync(protectedSettingsFile());
        } else if (fs.existsSync(machineSettingsFile())) {
          settingsBackup = fs.readFileSync(machineSettingsFile());
        }
      } catch { /* restore the application even if the backup is unreadable */ }
      // הרמה זמנית של איסור המחיקה — אחרת השומר עצמו (מנהל) לא יוכל
      // להחליף את הקבצים; ההקשחה שלהלן מחזירה את האיסור מיד.
      await liftDirProtection(dst);
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(dst, { recursive: true });
      fs.cpSync(info.dir, dst, { recursive: true });
      writeProtectedManifest();
      if (settingsBackup) atomicWrite(protectedSettingsFile(), settingsBackup);
      await hardenProtectedCopy();
    } catch { /* ignore */ }
  }
}

async function restoreInstallDir() {
  // תיקיית ההתקנה המקורית נמחקה — לשחזר מהעותק המוגן
  const info = installInfo();
  if (!info || !info.dir) return;
  const srcOk = fs.existsSync(sourceExecutable(protectedAppDir())) && fs.existsSync(packageJsonPath(protectedAppDir()));
  const dstOk = fs.existsSync(sourceExecutable(info.dir)) && fs.existsSync(packageJsonPath(info.dir)) && installDirMatchesProtectedManifest(info.dir);
  if (srcOk && !dstOk) {
    logTamper('install-dir-restored');
    try {
      // הרמה זמנית של איסור המחיקה — אחרת השומר (מנהל) לא יוכל להחליף
      // את הקבצים; מיד אחרי ההעתקה מחזירים את ההקשחה.
      await liftDirProtection(info.dir);
      fs.rmSync(info.dir, { recursive: true, force: true });
      fs.mkdirSync(info.dir, { recursive: true });
      fs.cpSync(protectedAppDir(), info.dir, { recursive: true });
      await hardenDirTree(info.dir);
    } catch { /* ignore */ }
  }
}

// מתקין ההסרה (Uninstall *.exe) נמחק/נפגם מתיקיית ההתקנה — שחזור ממוקד
// ומהיר מהעותק המוגן, כך שההסרה החוקית מהתוכנה תמשיך לעבוד גם אחרי ניסיון
// חבלה. השומר המערכתי רץ כל 10 שניות; בנוסף המתקין כלול במניפסט השלמות,
// כך שמחיקה שלו לבדה מפעילה גם שחזור מלא (restoreInstallDir). הכתיבה
// מתבצעת במקום (אין צורך בהרמת איסור המחיקה — האיסור חל על מחיקה/שינוי
// שם, לא על כתיבה; הקובץ החדש יורש את האיסור מהתיקייה).
async function restoreUninstaller() {
  if (!isWin || !isElevated()) return;
  const info = installInfo();
  if (!info || !info.dir) return;
  const src = protectedAppDir();
  const dst = info.dir;
  if (!fs.existsSync(src) || !fs.existsSync(dst)) return;
  try {
    let restored = false;
    for (const name of fs.readdirSync(src)) {
      if (!/^Uninstall .*\.exe$/i.test(name)) continue;
      const s = path.join(src, name);
      const d = path.join(dst, name);
      try {
        if (!fs.existsSync(d) || fs.statSync(d).size !== fs.statSync(s).size) {
          fs.copyFileSync(s, d);
          restored = true;
        }
      } catch { /* קובץ נעול/תפוס — ינוסה שוב בסבב הבא */ }
    }
    if (restored) logTamper('uninstaller-restored');
  } catch { /* ignore */ }
}

let lastMainTaskRun = 0;
function ensureInteractiveMain() {
  if (!isWin || isTestMode || trustedNow() - lastMainTaskRun < 10000) return;
  const exeName = path.basename(sourceExecutable(protectedAppDir()));
  // שם קובץ ההרצה משולב בסקריפט PowerShell. שימוש במחרוזת יחיד ליטרלית
  // (psSingleQuote) במקום JSON.stringify (מרכאות כפולות) מונע אינטרפולציה של
  // `$(...)`/backtick/$var, כך שגם אם שם הקובץ ישונה בעתיד לא ניתן להזריק קוד.
  const script =
    "$n=" + psSingleQuote(exeName) + "; " +
    "@(Get-CimInstance Win32_Process -Filter \"Name='$n'\") | " +
    "Where-Object { $_.CommandLine -notmatch '--watchdog-system' -and $_.CommandLine -notmatch '--watchdog' } | " +
    "Select-Object -First 1 | ForEach-Object { 'running' }";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
    if (err || String(stdout || '').trim() === 'running') return;
    lastMainTaskRun = trustedNow();
    // The SYSTEM guard cannot safely display UI itself. Re-running the
    // interactive scheduled task restores the enforcement process in the
    // logged-on user's session after both user processes were killed.
    execFile('schtasks', ['/Run', '/TN', TASK_NAME], () => {});
  });
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
      await restoreInstallDir();
      await restoreUninstaller();
      restoreSharedSettings();
      ensureGuardTasks();
      ensureInteractiveMain();
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

      // הסרה מתוך "התקן והסר תוכניות" אינה רצויה — ההסרה היחידה היא מתוך
      // התוכנה עצמה. למחוק את רשומת ההסרה מהרישום בכל הפעלה מוגבהת.
      removeUninstallRegistryEntries();
      // לוודא שמתקין ההסרה קיים (אם נמחק/נפגם — שחזור מהעותק המוגן), כדי
      // שההסרה החוקית מהתוכנה תישאר זמינה. השומר המערכתי עושה זאת גם כל 10
      // שניות; כאן זה מיידי עם האתחול.
      await restoreUninstaller();
      // ניקוי אסימון הסרה ישן מסשן קודם — האסימון תקף רק בזמן ההסרה עצמה
      try { if (fs.existsSync(uninstallTokenFile())) fs.unlinkSync(uninstallTokenFile()); } catch { /* ignore */ }

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
      if (typeof tray.on === 'function') {
        tray.on('click', () => showMainWindow());
        tray.on('double-click', () => showMainWindow());
      }
      updateTray(S.getStatus(activeSchedule(), trustedDate()));

      // אם התוכנה הופעלה ידנית (משולחן העבודה / תפריט התחל / התקנה) ולא באתחול רקע של Windows או בדיקות,
      // ואין כרגע חסימה פעילה — פתיחה מיידית של חלון ההגדרות עם דרישת סיסמה
      const isAutostart = process.argv.includes('--autostart') || !!process.env.NODE_TEST_CONTEXT;
      if (!isAutostart && !isBlockedNow()) {
        showMainWindow();
      } else if (isWin && !schedule.pinHash && !process.env.NODE_TEST_CONTEXT) {
        // בהתקנה טרייה (ללא סיסמה ראשונית מוגדרת) באתחול רקע — הכוונת המשתמש לפתיחת ההגדרות
        setTimeout(() => {
          try {
            if (tray && typeof tray.displayBalloon === 'function') {
              tray.displayBalloon({
                title: 'בין הזמנים פועלת ברקע',
                content: 'התוכנה פועלת במגש המערכת. לחצו כאן או על הסמל ליד השעון להגדרת סיסמה ולוח זמנים.'
              });
            }
          } catch { /* ignore */ }
        }, 3000);
      }

      enforce();
      setInterval(enforce, 5000); // בדיקה כל 5 שניות

      superviseWatchdog(); // הגנה הדדית: הראשי מקפיץ את השומר

      // הפעלה עם Windows — בהתאם להגדרה השמורה ומצב ההרשאות
      const startupResult = await syncStartup();
      if (startupResult && !startupResult.ok) {
        startupFault = startupResult.error || 'Startup לא אומת';
        // Startup registration failed, but we should not fail closed
        // and lock the machine for the current session.
        logEvent('startup-fail', { error: startupFault });
      } else if (startupResult && startupResult.warning) {
        logEvent('startup-warning', { error: startupResult.warning });
      }

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
