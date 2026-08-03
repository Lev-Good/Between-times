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
const machineSettingsFile = () => path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'BenHazmanim', 'settings.json');
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
let lockedAt = null;       // מתי נכנסנו למצב חסום (לזמן התראה)
let lastLockCall = 0;
let isQuitting = false;
let sessionUnlocked = false; // כניסה מוצלחת עם סיסמה לניהול ההגדרות
let manualLock = false;      // נעילה ידנית (נעל עכשיו) — מפעילה את מסך החסימה המלא
let shortcutsRegistered = false;
let lastBlockedState = false; // מעקב מצבי לזיהוי תחילת/סיום חסימה ביומן
let lastWarningActive = false; // מעקב מצבי לזיהוי כניסה/יציאה מחלון האזהרה לפני חסימה

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

function loadPinLock() {
  try {
    const data = JSON.parse(fs.readFileSync(pinLockFile(), 'utf8'));
    if (data && typeof data.until === 'number' && data.until > Date.now()) pinLockUntil = data.until;
  } catch { /* ignore */ }
}
function savePinLock() {
  try { fs.writeFileSync(pinLockFile(), JSON.stringify({ until: pinLockUntil }), 'utf8'); } catch { /* ignore */ }
}
function clearPinLock() {
  try { fs.unlinkSync(pinLockFile()); } catch { /* ignore */ }
}

function checkPinLock() {
  if (Date.now() < pinLockUntil) return Math.ceil((pinLockUntil - Date.now()) / 1000);
  if (pinLockUntil) { pinLockUntil = 0; clearPinLock(); } // הנעילה פגה — ניקוי
  return 0;
}
function pinFail() {
  pinFailures++;
  if (pinFailures >= 5) {
    pinLockUntil = Date.now() + 60000; // 5 כישלונות -> נעילה של דקה
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
  return 'plain:' + String(pw);
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
    // הגירה מקובץ המשתמש הישן לקובץ המשותף (כשהתוכנה רצה מוגבהת)
    if (isWin && isElevated()) {
      try {
        const old = fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
        schedule = S.normalizeSchedule(JSON.parse(old));
        saveSettings();
      } catch { /* אין קובץ ישן — מתחילים בהגדרות ברירת מחדל */ }
    }
  }
  // ההפעלה עם Windows תמיד פעילה (ללא אפשרות לכיבוי), והרצה עם הרשאות
  // מנהל הוסרה מהממשק — כך שגם הגדרות ישנות לא יגרמו להרמה מוגבהת.
  schedule.startWithWindows = true;
  schedule.runAsAdmin = false;
}

function saveSettings() {
  const write = (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(schedule, null, 2), 'utf8');
  };
  try {
    write(settingsFile());
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

/* ================= נעילת המחשב ================= */

function lockWorkstation(force) {
  if (!isWin) return;
  if (!force && !schedule.lockWorkstation) return;
  const now = trustedNow();
  // חנק (throttle) מופעל רק לנעילות אוטומטיות — נעילה ידנית/כפויה תמיד מתבצעת
  if (!force && now - lastLockCall < 20000) return; // לא להציף
  lastLockCall = now;
  try {
    spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true });
  } catch {
    /* ignore */
  }
}

/* ================= חלונות חסימה (כל המסכים) ================= */

function isBlockedNow() {
  // נעילה ידנית חלה תמיד — גם אם האכיפה לפי הלוח מושבתת
  return !!(manualLock || (schedule.enabled && S.getStatus(schedule, trustedDate()).state === 'blocked'));
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

  // מניעת עקיפה: איבוד מיקוד = החזרה מיידית לחלון החסימה
  bw.on('blur', () => {
    // גניבת מיקוד מתבצעת רק כשיש סיסמה — ללא סיסמה החסימה אינה פעילה
    if (!isQuitting && isBlockedNow() && schedule.pinHash) focusBlockWindows();
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
        // הקיצור נבלע — החזרת חלון החסימה לקדמת המסך
        focusBlockWindows();
        if (isWin) lockWorkstation(true);
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

/* ================= לולאת האכיפה ================= */

function buildStatus() {
  const st = S.getStatus(schedule, trustedDate());
  return {
    ...st,
    now: trustedNow(),
    manualLock: manualLock,
    theme: resolvedTheme(),
    blockMessage: schedule.blockMessage,
    stateLabel: st.state === 'blocked' ? 'חסום' : 'מותר',
    nextLabel: st.next === 'blocked' ? 'חסום' : st.next === 'allowed' ? 'מותר' : null,
    nextAtLabel: st.nextAt ? S.formatDate(st.nextAt) : null,
    secondsUntilLabel: st.secondsUntilNext != null ? S.formatDuration(st.secondsUntilNext) : null,
    pinSet: !!schedule.pinHash
  };
}

// אזהרה לפני חסימה: כשהמחשב עדיין פתוח אבל עומד להיחסם בתוך warnMinutes —
// מציגים הודעה אחת בכניסה לחלון האזהרה שמזהירה לשמור קבצים ולסיים את העבודה.
function showWarningNotification(status) {
  try {
    const sec = status.warningSeconds != null ? status.warningSeconds : 0;
    const dur = S.formatDuration(sec);
    const n = new Notification({
      title: 'המחשב עומד להיחסם',
      body: 'בעוד ' + dur + ' המחשב ייחסם — שמרו את הקבצים וסיימו את העבודה.'
    });
    n.show();
  } catch { /* ignore */ }
}

function enforce() {
  const status = buildStatus();
  // נעילה ידנית חלה תמיד — גם אם האכיפה לפי הלוח מושבתת
  const blocked = !!(manualLock || (schedule.enabled && status.state === 'blocked'));

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

  // תיעוד מעברים ביומן הפעילות
  if (blocked !== lastBlockedState) {
    logEvent(blocked ? 'block-start' : 'block-end');
    lastBlockedState = blocked;
  }

  // עדכון מגש + חלון הגדרות
  if (tray) updateTray(status);
  if (win && !win.isDestroyed()) win.webContents.send('status', status);
  blockWins.forEach((bw) => { if (bw && !bw.isDestroyed()) bw.webContents.send('status', status); });

  if (!activeBlock) {
    lockedAt = null;
    manualLock = false;
    hideBlockWindows();
    unregisterBlockShortcuts();
    return;
  }

  showBlockWindows(status);
  registerBlockShortcuts();
  if (!lockedAt) lockedAt = trustedNow();
  // נעילה ידנית: ללא זמן התראה — נעילה מיידית (גם אם נעילת המסך האוטומטית כבויה)
  const grace = (manualLock ? 0 : (schedule.graceSeconds || 0) * 1000);
  if (trustedNow() - lockedAt >= grace) {
    lockWorkstation(manualLock);
  }
}

/* ================= מגש מערכת ================= */

function trayIcon() {
  const icon = path.join(__dirname, 'assets', 'icon.png');
  const img = nativeImage.createFromPath(icon);
  if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  return nativeImage.createEmpty();
}

function updateTray(status) {
  const color = (status.state === 'blocked' || status.manualLock) ? 'חסום' : 'מותר';
  const warnTxt = status.warning ? ' • ייחסם בקרוב' : '';
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
      click: () => { manualLock = true; lockedAt = 0; enforce(); }
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
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
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
      sessionUnlocked = false; // כניסה להגדרות דורשת סיסמה בכל פתיחה מחדש
      win.hide();
    }
  });
}

/* ================= הפעלה עם Windows (Registry + משימה מתוזמנת) ================= */

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_KEY_MACHINE = 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; // לכל המשתמשים
const RUN_NAME = 'BenHazmanim';
const TASK_NAME = 'BenHazmanim';

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
        ['/Create', '/TN', TASK_NAME, '/TR', startupValue(), '/SC', 'ONLOGON', '/RL', highest ? 'HIGHEST' : 'LIMITED', '/F'],
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
    if (!isWin || !isElevated()) return resolve({ ok: false, error: 'נדרשות הרשאות מנהל' });
    execFile('reg', ['add', RUN_KEY_MACHINE, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', startupValue(), '/f'], (err) => {
      resolve(err ? { ok: false, error: err.message } : { ok: true });
    });
  });
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

async function syncStartup() {
  // ההפעלה עם Windows תמיד פעילה: Registry (למשתמש הנוכחי) + משימה מתוזמנת
  // בעלת הרשאות גבוהות כדי שהתוכנה תעלה מוקדם בכניסה, + רישום לכל המשתמשים.
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
  // רישום לכל המשתמשים — כך שכל חשבון במחשב מוגן
  if (isElevated()) {
    const m = await setRegistryMachine();
    if (!m.ok) warnings.push('רישום לכל המשתמשים נכשל: ' + m.error);
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
  const password = decryptPassword(schedule.passwordEnc) || schedule.passwordPlain;
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
    const n = new Notification({
      title: 'עדכון זמין — בין הזמנים',
      body: 'גרסה ' + note.version + ' זמינה להורדה' + (note.url ? ' — לחצו על ההודעה כדי לפתוח את דף ההורדה' : '')
    });
    // לחיצה על ההודעה פותחת את דף ההורדה בדפדפן — כך שההודעה אכן עובדת
    if (note.url && /^https?:\/\//.test(note.url)) {
      n.on('click', () => shell.openExternal(note.url));
    }
    n.show();
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

/* ================= IPC ================= */

function registerIpc() {
  ipcMain.handle('settings:get', () => {
    // passwordPlain/passwordEnc לא מועברים לממשק — נדרשים רק בתהליך הראשי לשחזור
    const safe = { ...schedule };
    delete safe.passwordPlain;
    delete safe.passwordEnc;
    return { ...safe, sessionUnlocked: schedule.pinHash ? sessionUnlocked : true };
  });

  ipcMain.handle('settings:save', (_e, data) => {
    // אימות סיסמה בצד השרת — לא להסתמך על אימות קליינט בלבד
    if (schedule.pinHash && !sessionUnlocked) {
      return { ok: false, error: 'נדרשת סיסמה כדי לשנות הגדרות' };
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

  ipcMain.handle('lock:now', () => {
    // נעילה ידנית: מפעילה את מסך החסימה המלא של בין הזמנים על כל המסכים
    // (ולא רק את נעילת Windows הרגילה). הפתיחה מתבצעת עם סיסמה.
    if (!schedule.pinHash) {
      return { ok: false, error: 'לא הוגדרה סיסמה — הגדירו סיסמה בהגדרות לפני נעילה ידנית' };
    }
    manualLock = true;
    lockedAt = 0;
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
      schedule.manualUnlockUntil = st.state === 'blocked'
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
    // "פתוח עד המעבר הבא" נשמר רק כשהמצב לפי הלוח הוא חסום — אחרת אין צורך
    schedule.manualUnlockUntil = st.state === 'blocked'
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

  ipcMain.handle('recovery:send', () => sendRecovery());

  ipcMain.handle('update:check', () => checkForUpdate());

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

  ipcMain.handle('quit:cancel', () => {
    if (quitPromptOpen()) quitWin.destroy();
    return { ok: true };
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:hide', () => {
    if (win && !win.isDestroyed()) win.hide();
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

  ipcMain.handle('security:get', () => ({
    pin: !!schedule.pinHash,
    lockWs: schedule.lockWorkstation !== false,
    enabled: schedule.enabled !== false,
    elevated: isElevated(),
    shared: isWin && fs.existsSync(machineSettingsFile()),
    recovery: !!schedule.recoveryEmail
  }));

  ipcMain.handle('backup:export', async () => {
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
const stateDir = () => app.getPath('userData');
const mainHbFile = () => path.join(stateDir(), 'main.heartbeat');
const watchHbFile = () => path.join(stateDir(), 'watchdog.heartbeat');
const quitFlagFile = () => path.join(stateDir(), 'quit.flag');

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
    if (fs.existsSync(quitFlagFile())) { app.exit(0); return; } // עצירה מוסכמת
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
    if (fs.existsSync(quitFlagFile())) { gracefulQuit(); return; }
    if (heartbeatStale(watchHbFile(), 8000) && Date.now() - lastWatchSpawn > 5000) {
      lastWatchSpawn = Date.now();
      ownWatchdogPid = spawnWatchdog();
    }
  };
  setInterval(check, 3000);
  check();
}

function gracefulQuit() {
  isQuitting = true;
  logEvent('app-quit');
  try { fs.writeFileSync(quitFlagFile(), String(Date.now())); } catch { /* ignore */ }
  // סגירת השומר שלנו כדי שלא יקפיץ מחדש
  if (ownWatchdogPid && isProcessAlive(ownWatchdogPid)) {
    try { process.kill(ownWatchdogPid); } catch { /* ignore */ }
  }
  app.quit();
}

/* ================= אתחול ================= */

if (isWatchdog) {
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

      // ניקוי דגל עצירה מהסשן הקודם (אתחול חדש = רוצים את השומר)
      try { fs.unlinkSync(quitFlagFile()); } catch { /* ignore */ }

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
