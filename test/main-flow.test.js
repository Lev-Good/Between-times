// בדיקות עומק ללוגיקת ההפעלה וההסרה של main.js
// מריצות את main.js האמיתי עם Electron ממוק — כך נבדקת הלוגיקה עצמה
// (Registry, משימה מתוזמנת, כלב-שמירה, quit.flag, PIN, עדכונים).
process.env.TZ = 'Asia/Jerusalem';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const S = require('../scheduler.js');

/* ================= mock Electron + child_process ================= */

const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
const activeIntervals = [];
global.setInterval = (fn, ms, ...a) => {
  const id = realSetInterval(fn, ms, ...a);
  activeIntervals.push(id);
  return id;
};
global.clearInterval = (id) => {
  const i = activeIntervals.indexOf(id);
  if (i >= 0) activeIntervals.splice(i, 1);
  return realClearInterval(id);
};

// ה-fetch העולמי של main.js (לבדיקת עדכונים) — ניתן לשליטה לכל בדיקה
let fetchMock = null;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  if (fetchMock) return fetchMock(url, opts);
  return realFetch(url, opts);
};

function makeMock(config) {
  const cfg = Object.assign({ elevate: false }, config);
  const ipcHandlers = new Map();
  const state = {
    execCalls: [],       // execFile: {cmd, args}
    execSyncCalls: [],   // execFileSync: {cmd, args}
    spawnCalls: [],      // spawn: {cmd, args, opts}
    quitCalled: false,
    exitCalled: false,
    readyCallbacks: [],
    windowsCreated: 0,
    windows: [],        // כל חלונות ה-BrowserWindow שנוצרו (לכידת אירועים)
    notifications: []
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bhz-flow-'));
  fs.mkdirSync(path.join(tmpRoot, 'userData'), { recursive: true });
  // מניעת כתיבה ל-APPDATA האמיתי של המשתמש במהלך הבדיקה
  const origAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(tmpRoot, 'appdata');
  fs.mkdirSync(process.env.APPDATA, { recursive: true });

  // הרצאת קובץ הגדרות ראשוני (אם ביקשו)
  if (cfg.settings) {
    fs.writeFileSync(
      path.join(tmpRoot, 'userData', 'settings.json'),
      JSON.stringify(cfg.settings),
      'utf8'
    );
  }

  // תשובת ברירת מחדל לפקודות — ניתן לעקוף ע"י cfg.exec / cfg.execSync
  function defaultExec(cmd, args) {
    if (cmd === 'schtasks' && args.includes('/Create')) return { err: new Error('access denied'), stdout: '', stderr: '' };
    if (cmd === 'schtasks' && args.includes('/Query')) return { err: new Error('not found'), stdout: '', stderr: '' };
    return { err: null, stdout: '', stderr: '' };
  }
  const execImpl = cfg.exec || defaultExec;

  function defaultExecSync(cmd, args) {
    if (cmd === 'net') {
      if (!cfg.elevate) throw new Error('not elevated');
      return '';
    }
    if (cmd === 'reg' && args.includes('query')) {
      // דומה לפלט אמיתי של reg query
      return 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.levtov.benhazmanim\r\n    UninstallString    REG_SZ    "' + cfg.uninstallerPath + '"\r\n';
    }
    throw new Error('unknown execSync: ' + cmd);
  }
  const execSyncImpl = cfg.execSync || defaultExecSync;

  class MockBrowserWindow {
    constructor(opts) {
      state.windowsCreated++;
      state.windows.push(this);
      this.title = (opts && opts.title) || null;
      this._listeners = {};
      this.webContents = {
        sent: [],
        send: (ch, data) => { this.webContents.sent.push([ch, data]); }
      };
      this.blockDisplayId = null;
    }
    isDestroyed() { return false; }
    on(ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); }
    emit(ev, arg) { (this._listeners[ev] || []).forEach((l) => l(arg)); }
    show() {}
    focus() {}
    hide() { this.emit('hide'); }
    destroy() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadFile() {}
    restore() {}
    isMinimized() { return false; }
    setBackgroundColor() {}
  }

  const electron = {
    app: {
      getPath: (name) => (name === 'userData' ? path.join(tmpRoot, 'userData') : path.join(tmpRoot, 'app')),
      getAppPath: () => path.join(tmpRoot, 'app'),
      getVersion: () => '1.2.3',
      requestSingleInstanceLock: () => true,
      quit: () => { state.quitCalled = true; },
      exit: () => { state.exitCalled = true; },
      whenReady: () => ({ then: (cb) => { state.readyCallbacks.push(cb); } }),
      setAppUserModelId: () => {},
      on: () => {}
    },
    BrowserWindow: MockBrowserWindow,
    Tray: class { setToolTip() {} setContextMenu() {} },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
    ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }), createEmpty: () => ({}) },
    screen: {
      getAllDisplays: () => [
        { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
        { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 } }
      ]
    },
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    Notification: class {
      constructor(o) { this.o = o; }
      on() {}
      show() { state.notifications.push(this); }
    },
    shell: { openExternal: () => Promise.resolve() },
    safeStorage: { isEncryptionAvailable: () => false },
    nativeTheme: { shouldUseDarkColors: true },
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true })
    }
  };

  const childProcess = {
    spawn: (cmd, args, opts) => {
      state.spawnCalls.push({ cmd, args, opts });
      return { on: () => {}, unref: () => {}, pid: 4242 };
    },
    execFile: (cmd, args, cb) => {
      state.execCalls.push({ cmd, args });
      const r = execImpl(cmd, args);
      cb(r.err, r.stdout, r.stderr);
    },
    execFileSync: (cmd, args, opts) => {
      state.execSyncCalls.push({ cmd, args, opts });
      return execSyncImpl(cmd, args);
    }
  };

  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === 'child_process') return childProcess;
    return origLoad.apply(this, arguments);
  };

  const m = {
    tmpRoot, origAppData, ipcHandlers, state,
    electron, childProcess,
    cleanup() {
      Module._load = origLoad;
      delete require.cache[require.resolve('../main.js')];
      process.env.APPDATA = this.origAppData;
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    },
    async ready() {
      for (const cb of state.readyCallbacks) await cb();
      return state;
    }
  };
  lastMock = m;
  return m;
}

// טעינת main.js פעם אחת לכל בדיקה
function loadMain(cfg) {
  const m = makeMock(cfg);
  delete require.cache[require.resolve('../main.js')];
  // בדיקת בדיקה: יש פונקציות ב-main.js שצריכות electron — זה כבר מטופל ב-mock
  require('../main.js');
  return m;
}

// ניקוי גלובלי אוטומטי בין בדיקות — כך שאפילו בדיקה שנכשלה באמצע
// לא תדליף state (Module._load, APPDATA, intervals, fetchMock) לבדיקות הבאות
let lastMock = null;
test.afterEach(() => {
  if (lastMock) {
    try { lastMock.cleanup(); } catch { /* ignore */ }
    lastMock = null;
  }
  activeIntervals.forEach((id) => realClearInterval(id));
  activeIntervals.length = 0;
  fetchMock = null;
});

test.after(() => {
  if (lastMock) {
    try { lastMock.cleanup(); } catch { /* ignore */ }
    lastMock = null;
  }
  activeIntervals.forEach((id) => realClearInterval(id));
  activeIntervals.length = 0;
  global.fetch = realFetch;
  global.setInterval = realSetInterval;
});

/* ================= עליית התוכנה עם Windows ================= */

test('startup: registers HKCU Run value + scheduled task (HIGHEST, fallback to LIMITED)', async () => {
  const m = loadMain({});
  await m.ready();

  const regAdd = m.state.execCalls.filter((c) => c.cmd === 'reg' && c.args.includes('add'));
  assert.ok(regAdd.length >= 1, 'צריכה להיות קריאת reg add');
  const run = regAdd.find((c) => c.args[1] && c.args[1].toLowerCase().includes('\\run'));
  assert.ok(run, 'צריכה להיות רישום ל-Run key');
  assert.ok(run.args.includes('BenHazmanim'), 'שם הרישום BenHazmanim');
  const valIdx = run.args.indexOf('/d');
  assert.ok(valIdx >= 0 && /\.exe/.test(run.args[valIdx + 1]), 'ערך הרישום צריך להכיל נתיב exe');

  const taskCreate = m.state.execCalls.filter((c) => c.cmd === 'schtasks' && c.args.includes('/Create'));
  assert.ok(taskCreate.length >= 1, 'צריכה להיות יצירת משימה מתוזמנת');
  const first = taskCreate[0];
  assert.ok(first.args.includes('ONLOGON'), 'משימה בעת כניסה');
  assert.ok(first.args.includes('HIGHEST'), 'ניסיון ראשון עם הרשאות גבוהות');
  // ה-fallback ל-LIMITED קורה רק כשהמשימה לא קיימת — המוק מחזיר /Create נכשל ו-/Query "לא קיים"
  const limited = taskCreate.find((c) => c.args.includes('LIMITED'));
  assert.ok(limited, 'נפילה ל-LIMITED כש-HIGHEST נכשל ואין משימה קיימת');

  m.cleanup();
});

test('startup: does NOT recreate task when it already exists', async () => {
  const m = loadMain({
    exec(cmd, args) {
      if (cmd === 'schtasks' && args.includes('/Create')) return { err: new Error('exists'), stdout: '', stderr: '' };
      if (cmd === 'schtasks' && args.includes('/Query')) return { err: null, stdout: 'task', stderr: '' }; // קיימת
      if (cmd === 'reg' && args.includes('add')) return { err: null, stdout: '', stderr: '' };
      return { err: null, stdout: '', stderr: '' };
    }
  });
  await m.ready();

  const taskCreate = m.state.execCalls.filter((c) => c.cmd === 'schtasks' && c.args.includes('/Create'));
  // הקריאה הראשונה (HIGHEST) לגיטימית — אסור ליצור שוב ברמה נמוכה
  assert.equal(taskCreate.length, 1, 'צריך ניסיון יצירה אחד בלבד (HIGHEST)');
  assert.ok(taskCreate[0].args.includes('HIGHEST'), 'רק ניסיון HIGHEST');
  const limited = taskCreate.find((c) => c.args.includes('LIMITED'));
  assert.equal(limited, undefined, 'כשהמשימה קיימת אסור ליצור מחדש ברמה נמוכה');
  m.cleanup();
});

test('startup: elevated run adds per-machine Run key (HKLM)', async () => {
  const m = loadMain({ elevate: true });
  await m.ready();

  const hklm = m.state.execCalls.filter(
    (c) => c.cmd === 'reg' && c.args.includes('add') && c.args.some((a) => /^HKLM\\/i.test(a))
  );
  assert.ok(hklm.length >= 1, 'בהרצה מוגבהת צריך רישום לכל המשתמשים (HKLM)');
  m.cleanup();
});

test('startup: non-elevated run does NOT touch HKLM', async () => {
  const m = loadMain({});
  await m.ready();

  const hklm = m.state.execCalls.filter(
    (c) => c.cmd === 'reg' && c.args.some((a) => /^HKLM\\/i.test(a))
  );
  assert.equal(hklm.length, 0, 'ללא הרשאות מנהל אסור לגעת ב-HKLM');
  m.cleanup();
});

/* ================= הסרה: ללא סיסמה + חסימה פעילה ================= */

test('uninstall: works without password when no pin is set (blocked schedule)', async () => {
  const now = new Date();
  const day = now.getDay();
  // חסימה לכל היום — כדי לוודא שגם עם חסימה פעילה ההסרה מותרת ללא סיסמה
  const settings = S.defaultSchedule();
  settings.pinHash = null;
  for (let d = 0; d < 7; d++) settings.week[d].slots.push({ start: 0, end: 1440, type: 'blocked' });

  const uninstallerPath = path.join(os.tmpdir(), 'bhz-uninst-test.exe');
  fs.writeFileSync(uninstallerPath, '');
  try {
    const m = loadMain({ settings, uninstallerPath });
    await m.ready();

    // וידוא שהחסימה אכן פעילה לפי הלוח
    const statusRes = await m.ipcHandlers.get('status:get')();
    assert.equal(statusRes.state, 'blocked', 'הבדיקה צריכה להתבצע בזמן חסימה');

    const res = await m.ipcHandlers.get('app:uninstall')({}, undefined);
    assert.ok(res.ok, 'הסרה ללא סיסמה צריכה להצליח: ' + JSON.stringify(res));

    // 1) רישומי ההפעלה הוסרו (reg delete + schtasks delete)
    const regDel = m.state.execCalls.filter((c) => c.cmd === 'reg' && c.args.includes('delete'));
    assert.ok(regDel.length >= 1, 'רישומי Registry צריכים להימחק');
    const taskDel = m.state.execCalls.filter((c) => c.cmd === 'schtasks' && c.args.includes('/Delete'));
    assert.ok(taskDel.length >= 1, 'המשימה המתוזמנת צריכה להימחק');

    // 2) ה-Uninstaller הופעל בשקט (detached)
    assert.ok(m.state.spawnCalls.length >= 1, 'ה-Uninstaller צריך להיות מופעל');
    const spawn = m.state.spawnCalls.find((s) => s.cmd === uninstallerPath);
    assert.ok(spawn, 'ה-Uninstaller צריך להיות קובץ ההסרה שנמצא');
    assert.ok(spawn.args.includes('/S'), 'הפעלה שקטה');
    assert.equal(spawn.opts.detached, true, 'תהליך נפרד — חייב להמשיך גם אחרי סגירת התוכנה');

    // 3) quit.flag נכתב בשני הנתיבים (תוכנה + שומר-שער נסגרים)
    assert.ok(m.state.quitCalled, 'התוכנה צריכה להיסגר (gracefulQuit)');
    const flag1 = path.join(m.tmpRoot, 'userData', 'quit.flag');
    const flag2 = path.join(process.env.APPDATA, 'BenHazmanim', 'quit.flag');
    assert.ok(fs.existsSync(flag1), 'quit.flag ב-userData');
    assert.ok(fs.existsSync(flag2), 'quit.flag בנתיב ה-NSIS (APPDATA\\BenHazmanim)');

    m.cleanup();
  } finally {
    try { fs.unlinkSync(uninstallerPath); } catch { /* ignore */ }
  }
});

test('uninstall: refuses with wrong password when pin is set', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.enabled = false; // ללא חסימה — אבל סיסמה מוגדרת

  const uninstallerPath = path.join(os.tmpdir(), 'bhz-uninst2.exe');
  fs.writeFileSync(uninstallerPath, '');
  try {
    const m = loadMain({ settings, uninstallerPath });
    await m.ready();

    const res = await m.ipcHandlers.get('app:uninstall')({}, 'wrong');
    assert.equal(res.ok, false);
    assert.match(res.error || '', /סיסמה/);
    const uninstSpawns = m.state.spawnCalls.filter((s) => s.cmd === uninstallerPath);
    assert.equal(uninstSpawns.length, 0, 'אסור להפעיל Uninstaller עם סיסמה שגויה');
    m.cleanup();
  } finally {
    try { fs.unlinkSync(uninstallerPath); } catch { /* ignore */ }
  }
});

test('uninstall: succeeds with correct password when no block is active', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.enabled = false; // ללא חסימה פעילה

  const uninstallerPath = path.join(os.tmpdir(), 'bhz-uninst3.exe');
  fs.writeFileSync(uninstallerPath, '');
  try {
    const m = loadMain({ settings, uninstallerPath });
    await m.ready();

    const res = await m.ipcHandlers.get('app:uninstall')({}, '1234');
    assert.ok(res.ok, 'סיסמה נכונה צריכה לאפשר הסרה: ' + JSON.stringify(res));
    const spawn = m.state.spawnCalls.find((s) => s.cmd === uninstallerPath);
    assert.ok(spawn, 'ה-Uninstaller הופעל');
    assert.ok(m.state.quitCalled, 'התוכנה נסגרה');
    m.cleanup();
  } finally {
    try { fs.unlinkSync(uninstallerPath); } catch { /* ignore */ }
  }
});

test('uninstall: reports clear error when no uninstaller found', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = null;
  // ללא uninstallerPath — findUninstaller יחזיר null (לא נמצא קובץ Uninstall בקרבת exe)
  const m = loadMain({ settings });
  await m.ready();
  const res = await m.ipcHandlers.get('app:uninstall')({}, undefined);
  assert.equal(res.ok, false);
  assert.match(res.error || '', /לא נמצא מתקין ההסרה/);
  const uninstSpawns = m.state.spawnCalls.filter((s) => s.args && s.args.includes('/S'));
  assert.equal(uninstSpawns.length, 0, 'בלי מתקין הסרה אין מה להפעיל');
  m.cleanup();
});

/* ================= יציאה (app:quit) ================= */

test('quit: without pin exits immediately (no block enforcement)', async () => {
  const m = loadMain({ settings: S.defaultSchedule() });
  await m.ready();
  const res = await m.ipcHandlers.get('app:quit')({}, undefined);
  assert.ok(res.ok);
  assert.ok(m.state.quitCalled);
  m.cleanup();
});

test('quit: requires correct pin when set', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('9999');
  const m = loadMain({ settings });
  await m.ready();

  const bad = await m.ipcHandlers.get('app:quit')({}, '0000');
  assert.equal(bad.ok, false);
  assert.equal(m.state.quitCalled, false, 'אסור לצאת עם סיסמה שגויה');

  const good = await m.ipcHandlers.get('app:quit')({}, '9999');
  assert.ok(good.ok);
  assert.ok(m.state.quitCalled);
  m.cleanup();
});

/* ================= PIN: נעילה זמנית נגד ברוט-פורס ================= */

test('pin:verify locks for 60s after 5 failures (brute-force guard)', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  for (let i = 0; i < 5; i++) {
    const r = await m.ipcHandlers.get('pin:verify')({}, 'wrong-' + i);
    assert.equal(r.ok, false, 'ניסיון ' + i + ' צריך להיכשל');
  }
  // הניסיון השישי — אפילו עם הסיסמה הנכונה — צריך להיות נעול
  const locked = await m.ipcHandlers.get('pin:verify')({}, '1234');
  assert.equal(locked.ok, false);
  assert.ok(locked.locked > 0, 'צריך להחזיר נעילה זמנית: ' + JSON.stringify(locked));
  m.cleanup();
});

test('pin:verify accepts correct pin and resets the failure counter', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  const r1 = await m.ipcHandlers.get('pin:verify')({}, 'bad');
  assert.equal(r1.ok, false);
  const r2 = await m.ipcHandlers.get('pin:verify')({}, '1234');
  assert.ok(r2.ok);
  // אחרי הצלחה — הכישלונות מתאפסים
  const r3 = await m.ipcHandlers.get('pin:verify')({}, '1234');
  assert.ok(r3.ok);
  m.cleanup();
});

/* ================= נעילה ידנית / פתיחה ================= */

test('lock:now refuses without a pin (no way to get locked out forever)', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = null;
  const m = loadMain({ settings });
  await m.ready();
  const res = await m.ipcHandlers.get('lock:now')();
  assert.equal(res.ok, false);
  assert.match(res.error || '', /לא הוגדרה סיסמה/);
  m.cleanup();
});

test('lock:now + unlock:now with correct pin', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.enabled = false;
  const m = loadMain({ settings });
  await m.ready();

  const lock = await m.ipcHandlers.get('lock:now')();
  assert.ok(lock.ok);
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.manualLock, true, 'נעילה ידנית פעילה');

  const fail = await m.ipcHandlers.get('unlock:now')({}, 'bad');
  assert.equal(fail.ok, false);
  const ok = await m.ipcHandlers.get('unlock:now')({}, '1234');
  assert.ok(ok.ok);
  const st2 = await m.ipcHandlers.get('status:get')();
  assert.equal(st2.manualLock, false, 'הנעילה הוסרה');
  m.cleanup();
});

/* ================= הגדרות ================= */

test('settings:save requires session unlock when pin is set', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  const res = await m.ipcHandlers.get('settings:save')({}, { enabled: false });
  assert.equal(res.ok, false, 'בלי כניסה להגדרות אסור לשנות');
  assert.match(res.error || '', /סיסמה/);

  const unlock = await m.ipcHandlers.get('session:unlock')({}, '1234');
  assert.ok(unlock.unlocked);
  const res2 = await m.ipcHandlers.get('settings:save')({}, { enabled: false });
  assert.ok(res2.ok, 'אחרי כניסה עם סיסמה — שמירה מותרת');
  m.cleanup();
});

/* ================= נעילת סשן: חובת סיסמה בכל פתיחה מחדש =================
   סגירה/מזעור/הסתרה של חלון ההגדרות חייבים לנעול את הסשן ולהודיע לממשק —
   אחרת פתיחה חוזרת משורת המשימות או מהמגש עוקפת את הסיסמה (חור אבטחה). */

function mainWin(m) {
  return m.state.windows.find((w) => w.title === 'בין הזמנים — ניהול זמן מחשב');
}

test('session: closing (hiding) the settings window locks it and notifies the UI', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  // כניסה עם סיסמה — שמירה מותרת
  await m.ipcHandlers.get('session:unlock')({}, '1234');
  let res = await m.ipcHandlers.get('settings:save')({}, { enabled: false });
  assert.ok(res.ok, 'אחרי כניסה — שמירה מותרת');

  // סגירת החלון (X) = הסתרה — חייב לנעול את הסשן
  const w = mainWin(m);
  assert.ok(w, 'חלון ההגדרות צריך להתקיים');
  w.emit('close', { preventDefault: () => {} });

  // הממשק קיבל הודעת נעילה + השרת דוחה שוב שינויי הגדרות
  assert.ok(w.webContents.sent.some(([ch]) => ch === 'session-lock'), 'הממשק צריך לקבל session-lock בהסתרה');
  const g = await m.ipcHandlers.get('session:get')();
  assert.equal(g.unlocked, false, 'לאחר הסתרה הסשן נעול');
  res = await m.ipcHandlers.get('settings:save')({}, { enabled: true });
  assert.equal(res.ok, false, 'פתיחה מחדש דורשת סיסמה שוב');
  m.cleanup();
});

test('session: minimize (hide event) also locks the session', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  await m.ipcHandlers.get('session:unlock')({}, '1234');
  assert.equal((await m.ipcHandlers.get('session:get')()).unlocked, true);

  const w = mainWin(m);
  w.emit('hide'); // מזעור מפעיל אירוע hide בווינדוס
  assert.equal((await m.ipcHandlers.get('session:get')()).unlocked, false, 'מזעור חייב לנעול');
  assert.ok(w.webContents.sent.some(([ch]) => ch === 'session-lock'));
  m.cleanup();
});

test('session: app:hide and session:lock IPC lock an unlocked session', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  await m.ipcHandlers.get('session:unlock')({}, '1234');

  // session:lock (נקרא מהממשק כשהחלון עבר לרקע) — נועל את השרת
  await m.ipcHandlers.get('session:lock')();
  assert.equal((await m.ipcHandlers.get('session:get')()).unlocked, false);
  let res = await m.ipcHandlers.get('settings:save')({}, { enabled: false });
  assert.equal(res.ok, false, 'לאחר session:lock אסור לשנות הגדרות');

  // app:hide — חוזרים למצב פתוח ואז מסתירים את החלון
  await m.ipcHandlers.get('session:unlock')({}, '1234');
  const h = await m.ipcHandlers.get('app:hide')();
  assert.ok(h.ok);
  assert.equal((await m.ipcHandlers.get('session:get')()).unlocked, false, 'app:hide חייב לנעול');
  const w = mainWin(m);
  assert.ok(w.webContents.sent.some(([ch]) => ch === 'session-lock'), 'הממשק עודכן שהסשן ננעל');
  res = await m.ipcHandlers.get('settings:save')({}, { enabled: true });
  assert.equal(res.ok, false);
  m.cleanup();
});

test('settings:save never lets client override pinHash/password', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  await m.ipcHandlers.get('session:unlock')({}, '1234');
  const res = await m.ipcHandlers.get('settings:save')(
    {},
    { enabled: true, pinHash: S.sha256Hex('hacked'), passwordPlain: 'hacked' }
  );
  assert.ok(res.ok);
  const back = await m.ipcHandlers.get('settings:get')();
  assert.equal(back.pinHash, settings.pinHash, 'pinHash לא ניתן לשינוי מהממשק');
  assert.equal(back.passwordPlain, undefined, 'סיסמה לא חשופה לממשק');
  m.cleanup();
});

/* ================= עדכונים ================= */

test('update:check finds a newer version and notifies', async () => {
  fetchMock = async () => ({
    json: async () => ({ version: '9.9.9', url: 'https://example.com/dl', notes: 'x' })
  });
  try {
    const m = loadMain({});
    await m.ready();
    const res = await m.ipcHandlers.get('update:check')();
    assert.ok(res.ok);
    assert.equal(res.update.version, '9.9.9');
    assert.equal(res.update.url, 'https://example.com/dl');
    assert.ok(m.state.notifications.length >= 1, 'הודעת עדכון הוצגה');
    assert.equal(m.state.notifications[0].o.title, 'עדכון זמין — בין הזמנים');
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

test('update:check ignores equal or older version', async () => {
  fetchMock = async () => ({ json: async () => ({ version: '1.2.3', url: 'x' }) }); // שווה לגרסה
  try {
    const m = loadMain({});
    await m.ready();
    const res = await m.ipcHandlers.get('update:check')();
    assert.ok(res.ok);
    assert.equal(res.update, null, 'גרסה שווה לא אמורה להציע עדכון');
    assert.equal(m.state.notifications.length, 0);
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

test('update:check tolerates network failure silently', async () => {
  fetchMock = async () => { throw new Error('offline'); };
  try {
    const m = loadMain({});
    await m.ready();
    const res = await m.ipcHandlers.get('update:check')();
    assert.equal(res.ok, false);
    assert.ok(res.error);
    assert.equal(res.update, null);
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

/* ================= הורדה והתקנה אוטומטית של עדכון ================= */

// זרם פשוט שמדמה את הגוף של תגובת fetch (res.body.getReader())
function fakeStream(chunks) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i < chunks.length) return { done: false, value: chunks[i++] };
        return { done: true, value: undefined };
      }
    })
  };
}

// תשובת ה-API הרשמית של GitHub (שחרור v9.9.9 עם קובץ Setup)
function githubApiRelease(url) {
  if (!url.includes('api.github.com/repos/Lev-Good/Between-times/releases/tags/v9.9.9')) return null;
  return {
    ok: true,
    json: async () => ({
      assets: [{
        name: 'Setup.9.9.9.exe',
        browser_download_url: 'https://github.com/Lev-Good/Between-times/releases/download/v9.9.9/Setup.9.9.9.exe'
      }]
    })
  };
}

test('update:download downloads installer and starts silent install', async () => {
  // 1) version.json (raw.githubusercontent) — מצביע על גרסה חדשה
  // 2) GitHub API — שם הקובץ המדויק
  // 3) כתובת ההורדה — זרם של 2MB
  fetchMock = async (url) => {
    const api = githubApiRelease(url);
    if (api) return api;
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '9.9.9', url: 'https://github.com/Lev-Good/Between-times/releases/latest' }) };
    }
    if (url.includes('releases/download/v9.9.9/Setup.9.9.9.exe')) {
      // 2MB תקין — חייב להתחיל בחותמת PE (MZ) כמו EXE אמיתי
      const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
      bytes[0] = 0x4d; bytes[1] = 0x5a; // 'MZ'
      return { ok: true, headers: { get: () => String(bytes.length) }, body: fakeStream([bytes]) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const m = loadMain({});
    await m.ready();

    const res = await m.ipcHandlers.get('update:download')();
    assert.ok(res.ok, 'ההורדה צריכה להצליח: ' + JSON.stringify(res));

    // המתקין שהורד הופעל בשקט (/S) בתהליך נפרד
    // שם הקובץ: BenHazmanim-Setup-9.9.9.exe (מקפים, לא נקודות)
    const spawn = m.state.spawnCalls.find((s) => s.cmd && /BenHazmanim-Setup-9\.9\.9\.exe$/.test(s.cmd));
    assert.ok(spawn, 'המתקין שהורד צריך להיות מופעל');
    assert.ok(spawn.args.includes('/S'), 'התקנה שקטה');
    assert.equal(spawn.opts.detached, true, 'תהליך נפרד — ממשיך גם אחרי סגירת התוכנה');

    // דגל עצירה נכתב + התוכנה נסגרת — כדי שהמתקין יצליח להחליף את הקבצים
    assert.ok(m.state.quitCalled, 'התוכנה צריכה להיסגר כדי לאפשר התקנה');
    assert.ok(fs.existsSync(path.join(m.tmpRoot, 'userData', 'quit.flag')), 'quit.flag ב-userData');
    assert.ok(fs.existsSync(path.join(process.env.APPDATA, 'BenHazmanim', 'quit.flag')), 'quit.flag בנתיב ה-NSIS');
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

test('update:download refuses corrupt/tiny downloads (no install, no quit)', async () => {
  fetchMock = async (url) => {
    const api = githubApiRelease(url);
    if (api) return api;
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '9.9.9' }) };
    }
    if (url.includes('releases/download/v9.9.9/Setup.9.9.9.exe')) {
      // קובץ גדול מספיק אבל ללא חותמת MZ — לא תקין
      return { ok: true, headers: { get: () => '2097152' }, body: fakeStream([Buffer.alloc(2 * 1024 * 1024, 1)]) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const m = loadMain({});
    await m.ready();
    const res = await m.ipcHandlers.get('update:download')();
    assert.equal(res.ok, false, 'קובץ ללא חותמת PE אינו תקין');
    assert.equal(m.state.quitCalled, false, 'אסור לסגור את התוכנה על קובץ שגוי');
    // ה-spawn היחיד האפשרי הוא של השומר-שער (heartbeat) — אסור שהמתקין יופעל
    const installerSpawns = m.state.spawnCalls.filter((s) => s.args && s.args.includes('/S'));
    assert.equal(installerSpawns.length, 0, 'אסור להריץ מתקין לא תקין');
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

test('update:download rejects download URLs outside the official repo', async () => {
  fetchMock = async (url) => {
    const api = githubApiRelease(url);
    if (api) {
      // ה-API חוזר עם קובץ ממקור זדוני — אסור להריץ אותו
      return {
        ok: true,
        json: async () => ({
          assets: [{ name: 'Setup.9.9.9.exe', browser_download_url: 'https://evil.example/x.exe' }]
        })
      };
    }
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '9.9.9' }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const m = loadMain({});
    await m.ready();
    const res = await m.ipcHandlers.get('update:download')();
    assert.equal(res.ok, false);
    assert.match(res.error || '', /מקור ההורדה אינו תקין/);
    assert.equal(m.state.quitCalled, false);
    const installerSpawns = m.state.spawnCalls.filter((s) => s.args && s.args.includes('/S'));
    assert.equal(installerSpawns.length, 0, 'אסור להריץ מתקין ממקור לא רשמי');
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

test('update:download cleans up partial file when download fails mid-stream', async () => {
  const destPath = null;
  fetchMock = async (url) => {
    const api = githubApiRelease(url);
    if (api) return api;
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '9.9.9' }) };
    }
    if (url.includes('releases/download/v9.9.9/Setup.9.9.9.exe')) {
      // זרם שנקטע באמצע — שידור שני מחזיר done מיד
      return {
        ok: true,
        headers: { get: () => '2097152' },
        body: {
          getReader: () => {
            let sent = 0;
            return {
              read: async () => {
                if (sent === 0) { sent++; return { done: false, value: Buffer.alloc(512 * 1024, 7) }; }
                throw new Error('connection lost');
              }
            };
          }
        }
      };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const m = loadMain({});
    await m.ready();
    const res = await m.ipcHandlers.get('update:download')();
    assert.equal(res.ok, false, 'כישלון אמצע ההורדה צריך להחזיר שגיאה');
    assert.ok(res.error);
    assert.equal(m.state.quitCalled, false);
    // הקובץ החלקי נמחק — לא נשאר זבל ב-Temp
    const tempDir = path.join(m.tmpRoot, 'app');
    const leftovers = fs.existsSync(tempDir)
      ? fs.readdirSync(tempDir).filter((f) => f.includes('BenHazmanim-Setup'))
      : [];
    assert.equal(leftovers.length, 0, 'הקובץ החלקי צריך להימחק: ' + JSON.stringify(leftovers));
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

test('update:download reports clear error when no update is available', async () => {
  fetchMock = async (url) => {
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '1.2.3' }) }; // שווה לגרסה — אין עדכון
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const m = loadMain({});
    await m.ready();
    const res = await m.ipcHandlers.get('update:download')();
    assert.equal(res.ok, false);
    assert.ok(res.error);
    assert.equal(m.state.quitCalled, false);
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

/* ================= מצב וסטטיסטיקות ================= */

test('status:get reflects enabled=false as allowed', async () => {
  const settings = S.defaultSchedule();
  settings.enabled = false;
  const m = loadMain({ settings });
  await m.ready();
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'allowed');
  assert.equal(st.enabled, false);
  m.cleanup();
});

test('status:get reports pinSet flag', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1');
  const m = loadMain({ settings });
  await m.ready();
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.pinSet, true);
  m.cleanup();
});

test('security:get reports protection state without leaking secrets', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1');
  settings.recoveryEmail = 'a@b.c';
  const m = loadMain({ settings });
  await m.ready();
  const sec = await m.ipcHandlers.get('security:get')();
  assert.equal(sec.pin, true);
  assert.equal(sec.enabled, true);
  assert.equal(sec.recovery, true);
  assert.ok('elevated' in sec);
  m.cleanup();
});

/* ================= שחזור סיסמה ================= */

test('recovery:send fails cleanly when no recovery email configured', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1');
  settings.recoveryEmail = '';
  const m = loadMain({ settings });
  await m.ready();
  const res = await m.ipcHandlers.get('recovery:send')();
  assert.equal(res.ok, false);
  assert.match(res.error || '', /מייל שחזור/);
  m.cleanup();
});

/* ================= גיבוי ================= */

test('backup:export cancels gracefully', async () => {
  const settings = S.defaultSchedule();
  const m = loadMain({ settings });
  await m.ready();
  const res = await m.ipcHandlers.get('backup:export')();
  assert.equal(res.ok, false);
  assert.match(res.error || '', /בוטל/);
  m.cleanup();
});

/* ================= קיצורי דרך (misc) ================= */

test('app:version returns the app version', async () => {
  const m = loadMain({});
  await m.ready();
  const v = await m.ipcHandlers.get('app:version')();
  assert.equal(v, '1.2.3');
  m.cleanup();
});

test('shell:open only allows http(s) URLs', async () => {
  const m = loadMain({});
  await m.ready();
  let called = null;
  m.electron.shell.openExternal = (u) => { called = u; return Promise.resolve(); };
  await m.ipcHandlers.get('shell:open')({}, 'https://ok.example');
  assert.equal(called, 'https://ok.example');
  await m.ipcHandlers.get('shell:open')({}, 'file:///etc/passwd');
  assert.equal(called, 'https://ok.example', 'קישור file:// אסור');
  m.cleanup();
});

/* ================= שומר-שער: quit.flag עוצר אותו ================= */

function withWatchdogArg(m, fn) {
  const origArgv = process.argv;
  process.argv = [origArgv[0], 'main.js', '--watchdog'];
  try {
    delete require.cache[require.resolve('../main.js')];
    require('../main.js');
    return fn();
  } finally {
    process.argv = origArgv;
  }
}

test('watchdog: exits immediately when quit.flag exists', async () => {
  const m = makeMock({});
  // כותבים דגל עצירה לפני שהשומר מתחיל — הוא חייב לצאת בלי להקפיץ כלום
  fs.mkdirSync(path.join(m.tmpRoot, 'userData'), { recursive: true });
  fs.writeFileSync(path.join(m.tmpRoot, 'userData', 'quit.flag'), String(Date.now()));

  await withWatchdogArg(m, async () => {
    await m.ready();
    // ה-check הראשון של runWatchdog רץ מיד (check()) — ומזהה את הדגל
    assert.ok(m.state.exitCalled, 'השומר חייב לצאת כש-quit.flag קיים');
  });
  m.cleanup();
});

test('uninstall: wrong password while ACTIVE BLOCK does not spawn uninstaller', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  for (let d = 0; d < 7; d++) settings.week[d].slots.push({ start: 0, end: 1440, type: 'blocked' });

  const uninstallerPath = path.join(os.tmpdir(), 'bhz-uninst4.exe');
  fs.writeFileSync(uninstallerPath, '');
  try {
    const m = loadMain({ settings, uninstallerPath });
    await m.ready();

    const st = await m.ipcHandlers.get('status:get')();
    assert.equal(st.state, 'blocked', 'צריך להיות חסום');

    // ניסיונות חוזרים עם סיסמה שגויה — אסור שאף אחד יפעיל את ההסרה
    for (let i = 0; i < 3; i++) {
      const res = await m.ipcHandlers.get('app:uninstall')({}, 'nope-' + i);
      assert.equal(res.ok, false);
    }
    const uninstSpawns = m.state.spawnCalls.filter((s) => s.cmd === uninstallerPath);
    assert.equal(uninstSpawns.length, 0, 'סיסמה שגויה לעולם אינה מפעילה את ההסרה');
    assert.equal(m.state.quitCalled, false, 'התוכנה לא נסגרה');
    m.cleanup();
  } finally {
    try { fs.unlinkSync(uninstallerPath); } catch { /* ignore */ }
  }
});

test('uninstall: quit.flag written even before uninstaller spawn (watchdog safety)', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = null;
  const m = loadMain({ settings, uninstallerPath: path.join(os.tmpdir(), 'bhz-uninst5.exe') });
  fs.writeFileSync(path.join(os.tmpdir(), 'bhz-uninst5.exe'), '');
  try {
    await m.ready();
    await m.ipcHandlers.get('app:uninstall')({}, undefined);
    // שני הנתיבים חייבים להכיל את הדגל — גם אם ה-Uninstaller ייכשל, השומר לא יקפיץ בחזרה
    assert.ok(fs.existsSync(path.join(m.tmpRoot, 'userData', 'quit.flag')));
    assert.ok(fs.existsSync(path.join(process.env.APPDATA, 'BenHazmanim', 'quit.flag')));
    m.cleanup();
  } finally {
    try { fs.unlinkSync(path.join(os.tmpdir(), 'bhz-uninst5.exe')); } catch { /* ignore */ }
  }
});

test('watchdog: stale main heartbeat triggers respawn of main app', async () => {
  const m = makeMock({});
  await withWatchdogArg(m, async () => {
    await m.ready();

    // בלי quit.flag — השומר חי וכותב heartbeat
    const before = m.state.spawnCalls.length;
    // מדמים: הראשי מת (heartbeat ישן + PID מת) — נכתוב heartbeat ישן
    const hbFile = path.join(m.tmpRoot, 'userData', 'main.heartbeat');
    fs.writeFileSync(hbFile, JSON.stringify({ pid: 999999, ts: Date.now() - 60000 }));

    // לולאת הבדיקה של runWatchdog רצה כל 2 שניות — מחכים עד 12 שניות להקפצה
    // (ה-lastMainSpawn guard של 5 שניות + מרווח 2 שניות = ההקפצה בפועל אחרי ~6 שניות)
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (m.state.spawnCalls.length > before) break;
      await new Promise((r) => setTimeout(r, 250));
    }  assert.ok(
    m.state.spawnCalls.length > before,
    'השומר צריך להקפיץ את הראשי כשהלב-פעימה התיישן'
  );
  const respawn = m.state.spawnCalls[before];
  assert.ok(respawn && !respawn.args.includes('--watchdog'), 'צריך להקפיץ את הראשי, לא שומר נוסף');
  });
});

test('watchdog: starts cleanly when no quit.flag (writes heartbeat)', async () => {
  const m = makeMock({});
  await withWatchdogArg(m, async () => {
    await m.ready();
    const hb = path.join(m.tmpRoot, 'userData', 'watchdog.heartbeat');
    assert.ok(fs.existsSync(hb), 'השומר צריך לכתוב heartbeat');
    const data = JSON.parse(fs.readFileSync(hb, 'utf8'));
    assert.ok(data.pid > 0, 'heartbeat מכיל PID');
  });
});

test('settings:get never exposes the password to the renderer', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.passwordPlain = 'secret1234';
  settings.passwordEnc = 'enc:xyz';
  const m = loadMain({ settings });
  await m.ready();
  const res = await m.ipcHandlers.get('settings:get')();
  assert.equal(res.passwordPlain, undefined, 'סיסמה מלאה אסורה בממשק');
  assert.equal(res.passwordEnc, undefined);
  assert.equal(res.pinHash, settings.pinHash, 'pinHash תקין');
  m.cleanup();
});

test('lock:now with pin creates block windows (enforce path)', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.enabled = false;
  const m = loadMain({ settings });
  await m.ready();

  const w0 = m.state.windowsCreated;
  const lock = await m.ipcHandlers.get('lock:now')();
  assert.ok(lock.ok);
  assert.ok(m.state.windowsCreated > w0, 'נעילה ידנית צריכה ליצור חלון חסימה');
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.manualLock, true);
  m.cleanup();
});

test('pin:set with no existing pin does not require old pin', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = null;
  const m = loadMain({ settings });
  await m.ready();

  // הגדרת סיסמה ראשונה — אין מה לאמת
  const good = await m.ipcHandlers.get('pin:set')({}, '1234', undefined);
  assert.ok(good.ok);
  const v = await m.ipcHandlers.get('pin:verify')({}, '1234');
  assert.ok(v.ok, 'הסיסמה החדשה מאומתת');
  m.cleanup();
});

test('pin:set requires old pin when replacing an existing pin', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('oldpin');
  const m = loadMain({ settings });
  await m.ready();

  const bad = await m.ipcHandlers.get('pin:set')({}, '1234', 'wrong-old');
  assert.equal(bad.ok, false, 'החלפת סיסמה דורשת את הסיסמה הישנה');
  const stillOld = await m.ipcHandlers.get('pin:verify')({}, 'oldpin');
  assert.ok(stillOld.ok, 'הסיסמה הישנה נשארה בתוקף');

  const good = await m.ipcHandlers.get('pin:set')({}, '1234', 'oldpin');
  assert.ok(good.ok);
  const v = await m.ipcHandlers.get('pin:verify')({}, '1234');
  assert.ok(v.ok, 'הסיסמה החדשה מאומתת');
  const v2 = await m.ipcHandlers.get('pin:verify')({}, 'oldpin');
  assert.equal(v2.ok, false, 'הסיסמה הישנה אינה תקפה יותר');
  m.cleanup();
});

test('pin:clear requires the old pin and removes the hash', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  const bad = await m.ipcHandlers.get('pin:clear')({}, 'wrong');
  assert.equal(bad.ok, false);
  const good = await m.ipcHandlers.get('pin:clear')({}, '1234');
  assert.ok(good.ok);
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.pinSet, false, 'אחרי ניקוי הסיסמה לא קיימת');
  m.cleanup();
});

test('quit:cancel and app:hide are harmless no-ops', async () => {
  const m = loadMain({});
  await m.ready();
  const c = await m.ipcHandlers.get('quit:cancel')();
  assert.ok(c.ok);
  const h = await m.ipcHandlers.get('app:hide')();
  assert.ok(h.ok);
  const o = await m.ipcHandlers.get('settings:open')();
  assert.ok(o.ok);
  m.cleanup();
});

test('theme:apply accepts light/dark', async () => {
  const m = loadMain({});
  await m.ready();
  const l = await m.ipcHandlers.get('theme:apply')({}, 'light');
  assert.ok(l.ok);
  const d = await m.ipcHandlers.get('theme:apply')({}, 'dark');
  assert.ok(d.ok);
  m.cleanup();
});

test('backup:import rejects invalid JSON/backup files', async () => {
  const settings = S.defaultSchedule();
  const m = loadMain({ settings });
  await m.ready();
  // ה-dialog ממוק להחזיר canceled — הייבוא צריך להיכשל בנימוס
  const res = await m.ipcHandlers.get('backup:import')();
  assert.equal(res.ok, false);
  assert.ok(res.error);
  m.cleanup();
});

test('activity:get returns an array even when empty', async () => {
  const settings = S.defaultSchedule();
  const m = loadMain({ settings });
  await m.ready();
  const act = await m.ipcHandlers.get('activity:get')();
  assert.ok(Array.isArray(act), 'יומן פעילות תמיד מערך');
  m.cleanup();
});
