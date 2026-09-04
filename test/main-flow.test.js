// בדיקות עומק ללוגיקת ההפעלה וההסרה של main.js
// מריצות את main.js האמיתי עם Electron ממוק — כך נבדקת הלוגיקה עצמה
// (Registry, משימה מתוזמנת, כלב-שמירה, quit.flag, PIN, עדכונים).
process.env.TZ = 'Asia/Jerusalem';
process.env.NODE_TEST_CONTEXT = '1';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

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
    notifications: [],
    focusCalls: []      // קריאות focus() על חלונות — לבדיקת גניבת פוקוס
  };
  let mockNetRuleExists = false;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bhz-flow-'));
  fs.mkdirSync(path.join(tmpRoot, 'userData'), { recursive: true });
  // מניעת כתיבה לנתיבים האמיתיים של המשתמש במהלך הבדיקה:
  // APPDATA (הגדרות משתמש) וגם PROGRAMDATA (הקובץ המשותף "לכל המשתמשים"
  // — בלי בידוד שלו, בדיקות מוגבהות היו כותבות לקובץ האמיתי של המחשב!)
  const origAppData = process.env.APPDATA;
  const origProgramData = process.env.PROGRAMDATA;
  process.env.APPDATA = path.join(tmpRoot, 'appdata');
  process.env.PROGRAMDATA = path.join(tmpRoot, 'programdata');
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  fs.mkdirSync(process.env.PROGRAMDATA, { recursive: true });

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
    // הדמיית חוק חומת האש: אחרי add/set הוא קיים, ואחרי delete הוא נעלם.
    // כך בדיקות האכיפה יכולות לאמת את מצב החוק בפועל ולא רק את קוד היציאה.
    if (cmd === 'netsh') {
      if (args.includes('show')) {
        return mockNetRuleExists
          ? { err: null, stdout: 'BenHazmanimNetBlock', stderr: '' }
          : { err: new Error('no such rule'), stdout: '', stderr: '' };
      }
      if (args.includes('add') || args.includes('set')) { mockNetRuleExists = true; return { err: null, stdout: '', stderr: '' }; }
      if (args.includes('delete')) { mockNetRuleExists = false; return { err: null, stdout: '', stderr: '' }; }
    }
    if (cmd === 'powershell.exe' && args.join(' ').includes('Get-AuthenticodeSignature') &&
        args.join(' ').includes('PSCustomObject')) {
      return { err: null, stdout: JSON.stringify({ status: 'Valid', subject: 'CN=Lev Tov Digital' }), stderr: '' };
    }
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
      this.visible = !(opts && opts.show === false);
      this._listeners = {};
      this.webContents = {
        sent: [],
        send: (ch, data) => { this.webContents.sent.push([ch, data]); }
      };
      this.blockDisplayId = null;
    }
    isDestroyed() { return !!this._destroyed; }
    on(ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); }
    emit(ev, arg) { (this._listeners[ev] || []).forEach((l) => l(arg)); }
    show() { this.visible = true; }
    focus() { state.focusCalls.push(this); }
    hide() { this.visible = false; this.emit('hide'); }
    destroy() { this._destroyed = true; this.emit('closed'); }
    setAlwaysOnTop(flag) { this.alwaysOnTop = !!flag; }
    setVisibleOnAllWorkspaces() {}
    loadFile() {}
    restore() {}
    isMinimized() { return false; }
    isVisible() { return !!this.visible; }
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
      ],
      getPrimaryDisplay: () => ({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 }
      })
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
    },
    powerMonitor: {
      listeners: {},
      on: function (ev, cb) { (this.listeners[ev] = this.listeners[ev] || []).push(cb); },
      emit: function (ev) { (this.listeners[ev] || []).forEach((cb) => cb()); }
    }
  };

  const childProcess = {
    spawn: (cmd, args, opts) => {
      state.spawnCalls.push({ cmd, args, opts });
      return { on: () => {}, unref: () => {}, pid: 4242 };
    },
    execFile: (cmd, args, opts, cb) => {
      // חלק מקריאות ה-execFile כוללות אופציות (למשל windowsHide ל-PowerShell)
      if (typeof opts === 'function') { cb = opts; }
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
    tmpRoot, origAppData, origProgramData, ipcHandlers, state,
    electron, childProcess,
    cleanup() {
      Module._load = origLoad;
      delete require.cache[require.resolve('../main.js')];
      process.env.APPDATA = this.origAppData;
      process.env.PROGRAMDATA = this.origProgramData;
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

/* ================= עותק מוגן (הגנה מפני מחיקת קבצי התוכנה) ================= */

// תיקיית התקנה מדומה (app.getAppPath) עם package.json וקובץ הרצה — מקור ההעתקה
function createAppDir(m) {
  const appDir = path.join(m.tmpRoot, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'ben-hazmanim', version: '9.9.9' }), 'utf8');
  fs.writeFileSync(path.join(appDir, path.basename(process.execPath)), 'fake-exe');
  fs.writeFileSync(path.join(appDir, 'assets.txt'), 'data');
  return appDir;
}
const protectedDir = (m) => path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'app');

test('protected copy: elevated run creates hardened copy and task points at it', async () => {
  const m = loadMain({ elevate: true });
  createAppDir(m);
  // מתקין ההסרה קיים בתיקיית ההתקנה (כמו אחרי התקנה אמיתית)
  const uninstName = 'Uninstall בין הזמנים.exe';
  fs.writeFileSync(path.join(m.tmpRoot, 'app', uninstName), 'uninstaller-bytes');
  await m.ready();

  // העותק המוגן נוצר בתיקייה המשותפת
  const pd = protectedDir(m);
  assert.ok(fs.existsSync(path.join(pd, 'package.json')), 'העותק המוגן צריך לכלול package.json');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(pd, 'package.json'), 'utf8')).version,
    '9.9.9',
    'העותק המוגן צריך להיות מאותה גרסה'
  );
  assert.ok(fs.existsSync(path.join(pd, path.basename(process.execPath))), 'העותק המוגן צריך לכלול את קובץ ההרצה');
  assert.ok(fs.existsSync(path.join(pd, 'assets.txt')), 'העותק המוגן כולל את שאר קבצי התוכנה');
  assert.ok(fs.existsSync(path.join(pd, 'integrity.json')), 'העותק המוגן צריך לכלול Manifest של שלמות קבצי הליבה');

  // מתקין ההסרה כלול במניפסט השלמות — כך שמחיקתו לבדה תיחשב פגיעה
  // ותפעיל שחזור מלא של תיקיית ההתקנה (ובלעדיו ההסרה החוקית נשברת)
  const manifest = JSON.parse(fs.readFileSync(path.join(pd, 'integrity.json'), 'utf8'));
  assert.ok(manifest.files.some((f) => String(f.path).endsWith(uninstName)),
    'מתקין ההסרה חייב להיכלל במניפסט השלמות: ' + JSON.stringify(manifest.files.map((f) => f.path)));

  // הקשחת הרשאות: takeown + icacls על העותק המוגן
  const takeown = m.state.execCalls.find((c) => c.cmd === 'takeown' && c.args.includes(pd));
  assert.ok(takeown, 'צריך להריץ takeown על העותק המוגן');
  assert.ok(takeown.args.includes(pd), 'takeown על תיקיית העותק המוגן');
  const icacls = m.state.execCalls.find((c) => c.cmd === 'icacls' && c.args.includes(pd));
  assert.ok(icacls, 'צריך להריץ icacls על העותק המוגן');
  assert.ok(icacls.args.includes(pd), 'icacls על תיקיית העותק המוגן');

  // רגרסיה: icacls עם /grant:r וסימוני ירושה (OI)(CI) דרך /T מרוקן את
  // ה-DACL של כל קובץ (נשאר PAI ללא ACEs) — הקבצים הופכים בלתי קריאים
  // לכולם, כולל SYSTEM, ולכן השומר המערכתי לא מסוגל אפילו להריץ את עצמו.
  // ההקשחה חייבת להגדיר את ההרשאות על התיקייה בלבד (בלי /T) ואז לאפס
  // את הילדים לירושה (icacls dir\* /reset /T).
  const grants = m.state.execCalls.find((c) => c.cmd === 'icacls' && c.args.includes(pd)
    && c.args.includes('/grant:r') && c.args.some((a) => a.includes('(OI)(CI)RX')));
  assert.ok(grants, 'הקשחת הרשאות על תיקיית העותק המוגן');
  assert.ok(!grants.args.includes('/T'),
    'אסור להפעיל את הרשאות ה-(OI)(CI) עם /T — זה מרוקן את ה-DACL של הקבצים');
  const reset = m.state.execCalls.find((c) => c.cmd === 'icacls' && c.args.includes('/reset')
    && c.args.some((a) => a.includes(pd) && a.endsWith('\\*')));
  assert.ok(reset, 'אחרי הגדרת הרשאות התיקייה הילדים מאופסים לירושה (icacls dir\\* /reset /T)');

  // איסור מחיקה לכולם (כולל מנהלים) — המטרה של שינוי זה: גם מנהל מערכת
  // לא יכול פשוט למחוק את העותק המוגן. Deny גובר על Allow, ולכן הרשאת
  // ה-Full של מנהלים אינה עוקפת את האיסור.
  const deny = m.state.execCalls.find((c) => c.cmd === 'icacls' && c.args.includes(pd)
    && c.args.includes('/deny') && c.args.some((a) => a.includes('DE,DC')));
  assert.ok(deny, 'צריך להריץ icacls עם איסור מחיקה (deny DE,DC) על העותק המוגן');
  assert.ok(deny.args.some((a) => a.includes('*S-1-1-0')), 'האיסור הוא לכולם, כולל מנהלים');

  // רענון העותק (העתקה מחדש) מרים זמנית את האיסור — אחרת הוא היה נחסם
  const lift = m.state.execCalls.find((c) => c.cmd === 'icacls' && c.args.includes(pd)
    && c.args.includes('/remove:d') && c.args.includes('*S-1-1-0'));
  assert.ok(lift, 'רענון העותק המוגן מרים זמנית את איסור המחיקה');

  // קובץ גיבוי ההגדרות נכתב מחדש בכל שמירה — יוצא מתחולת האיסור
  const exclude = m.state.execCalls.find((c) => c.cmd === 'icacls'
    && c.args.some((a) => a.includes('settings.backup.json')));
  assert.ok(exclude, 'גיבוי ההגדרות מוחרג מאיסור המחיקה (נכתב באטומיות בכל שמירה)');

  // רגרסיה: אסור להעביר סימוני ירושה (OI)(CI) ל-/grant:r כשהמטרה היא קובץ
  // בודד — התבנית הזו מרוקנת את ה-DACL של הקובץ (נשאר PAI ללא ACEs) ואף
  // אחד — כולל SYSTEM ומנהלים — לא יכול לקרוא או להחליף אותו (נבדק אמפירית
  // על ווינדוס 11). לקובץ נותנים הרשאות ישירות, בלי סימוני ירושה.
  assert.ok(!exclude.args.some((a) => a.includes('(OI)') || a.includes('(CI)')),
    'החרגת קובץ בודד אסורה עם סימוני ירושה (OI)(CI) — זה משחית את ה-DACL: ' + JSON.stringify(exclude.args));

  // המשימה המתוזמנת מצביעה על העותק המוגן
  const taskCreate = m.state.execCalls.filter((c) => c.cmd === 'schtasks' && c.args.includes('/Create'));
  assert.ok(taskCreate.length >= 1, 'צריך ליצור משימה מתוזמנת');
  for (const t of taskCreate) {
    const trIdx = t.args.indexOf('/TR');
    assert.ok(trIdx >= 0 && t.args[trIdx + 1].includes(pd), 'המשימה צריכה להריץ את העותק המוגן');
  }

  // מצב ההגנה מדווח על עותק מוגן פעיל
  const sec = await m.ipcHandlers.get('security:get')();
  assert.equal(sec.protectedCopy, true);
  m.cleanup();
});

test('protected copy: verifyAclHealth safety net runs after hardening and leaves readable files untouched', async () => {
  const m = loadMain({ elevate: true });
  createAppDir(m);
  // קבצים כמו קבצי .pak ש-Chromium טוען — הנפגעים הפוטנציאליים של הקשחה
  // בזמן שהאפליקציה רצה מהתיקייה (פעולה על קובץ נעול נקטעה באמצע והותירה
  // DACL ריק). רשת הביטחון (verifyAclHealth) רצה אחרי כל הקשחה ובודקת
  // שכל קובץ נשאר קריא; עץ בריא אמור לעבור בלי שום תיקון ואירוע.
  fs.writeFileSync(path.join(m.tmpRoot, 'app', 'chrome_100_percent.pak'), 'pak-data');
  fs.writeFileSync(path.join(m.tmpRoot, 'app', 'resources.pak'), 'pak-data');
  await m.ready();
  const pd = protectedDir(m);
  for (const name of ['package.json', 'chrome_100_percent.pak', 'resources.pak', 'assets.txt']) {
    const f = path.join(pd, name);
    assert.ok(fs.existsSync(f), 'העותק המוגן כולל ' + name);
    assert.doesNotThrow(() => fs.accessSync(f, fs.constants.R_OK), name + ' חייב להישאר קריא אחרי ההקשחה');
  }
  // עץ בריא לא אמור להפעיל את תיקון ה-ACL ולא לרשום אירועי חבלה
  const tamperLog = path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'tamper.log');
  const log = fs.existsSync(tamperLog) ? fs.readFileSync(tamperLog, 'utf8') : '';
  assert.ok(!log.includes('acl-unreadable') && !log.includes('acl-repaired'),
    'עץ קבצים בריא לא צריך להפעיל את תיקון ה-ACL');
  m.cleanup();
});

test('protected copy: no re-copy when version matches; task still points at copy', async () => {
  const m = loadMain({ elevate: true });
  createAppDir(m);
  // עותק מוגן קיים כבר עם אותה גרסה
  const pd = protectedDir(m);
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({ name: 'ben-hazmanim', version: '9.9.9' }), 'utf8');
  fs.writeFileSync(path.join(pd, path.basename(process.execPath)), 'old-copy');
  await m.ready();

  const takeown = m.state.execCalls.filter((c) => c.cmd === 'takeown');
  const icacls = m.state.execCalls.filter((c) => c.cmd === 'icacls');
  assert.ok(takeown.length >= 1, 'גם גרסה תואמת צריכה לוודא שהעותק מוגן');
  assert.ok(icacls.length >= 1, 'גם גרסה תואמת צריכה לוודא שהעותק מוגן');

  // איסור המחיקה מוחזר בכל הרצה, גם כשהעותק כבר עדכני (ללא העתקה מחדש)
  const deny = m.state.execCalls.find((c) => c.cmd === 'icacls'
    && c.args.includes('/deny') && c.args.some((a) => a.includes('DE,DC')));
  assert.ok(deny, 'גם גרסה תואמת צריכה להבטיח את איסור המחיקה');

  const taskCreate = m.state.execCalls.filter((c) => c.cmd === 'schtasks' && c.args.includes('/Create'));
  assert.ok(taskCreate.length >= 1, 'צריך ליצור משימה מתוזמנת');
  for (const t of taskCreate) {
    const trIdx = t.args.indexOf('/TR');
    assert.ok(trIdx >= 0 && t.args[trIdx + 1].includes(pd), 'המשימה מצביעה על העותק המוגן');
  }
  m.cleanup();
});

test('protected copy: non-elevated run does NOT create or touch the copy', async () => {
  const m = loadMain({});
  createAppDir(m);
  await m.ready();

  const pd = protectedDir(m);
  assert.equal(fs.existsSync(pd), false, 'ללא הרשאות מנהל אין עותק מוגן');
  const takeown = m.state.execCalls.filter((c) => c.cmd === 'takeown');
  const icacls = m.state.execCalls.filter((c) => c.cmd === 'icacls');
  assert.equal(takeown.length, 0, 'ללא הרשאות מנהל אין הקשחת הרשאות');
  assert.equal(icacls.length, 0, 'ללא הרשאות מנהל אין הקשחת הרשאות');

  // המשימה מצביעה על ההתקנה המקורית
  const taskCreate = m.state.execCalls.filter((c) => c.cmd === 'schtasks' && c.args.includes('/Create'));
  assert.ok(taskCreate.length >= 1, 'צריך ליצור משימה מתוזמנת');
  for (const t of taskCreate) {
    const trIdx = t.args.indexOf('/TR');
    assert.ok(trIdx >= 0 && t.args[trIdx + 1].includes(path.join(m.tmpRoot, 'app')), 'המשימה מצביעה על ההתקנה המקורית');
  }

  const sec = await m.ipcHandlers.get('security:get')();
  assert.equal(sec.protectedCopy, false);
  m.cleanup();
});

test('install dir: elevated run hardens the install dir with deny-delete', async () => {
  // תרחיש המשתמש שפתח את הנושא: מחיקת כל תיקיית הקבצים עם הרשאות מנהל
  // "עבדה בלי בעיה". אחרי שינוי זה תיקיית ההתקנה עצמה מקבלת איסור מחיקה
  // לכולם (כולל מנהלים) — מחיקה פשוטה נכשלת עם Access denied.
  const m = loadMain({ elevate: true });
  createAppDir(m);
  await m.ready();
  const appDir = path.join(m.tmpRoot, 'app');

  const takeown = m.state.execCalls.filter((c) => c.cmd === 'takeown' && c.args.includes(appDir));
  assert.ok(takeown.length >= 1, 'takeown על תיקיית ההתקנה');
  const deny = m.state.execCalls.find((c) => c.cmd === 'icacls' && c.args.includes(appDir)
    && c.args.includes('/deny') && c.args.some((a) => a.includes('DE,DC')));
  assert.ok(deny, 'איסור מחיקה (deny DE,DC) על תיקיית ההתקנה');

  // ללא הרשאות מנהל לא נוגעים בהרשאות של תיקיית ההתקנה
  m.cleanup();
  const m2 = loadMain({});
  createAppDir(m2);
  await m2.ready();
  const icacls2 = m2.state.execCalls.filter((c) => c.cmd === 'icacls' && c.args.includes(path.join(m2.tmpRoot, 'app')));
  assert.equal(icacls2.length, 0, 'ללא הרשאות מנהל אין הקשחת תיקיית ההתקנה');
  m2.cleanup();
});

test('uninstall: רשומת "התקן והסר תוכניות" מוסרת מהרישום בהרצה מוגבהת', async () => {
  // ההסרה חייבת להיות אפשרית רק מתוך התוכנה עצמה. הרשומה ש-electron-builder
  // יוצר (UUID v5 של ה-appId) נמחקת בכל הפעלה מוגבהת — התוכנה לא מופיעה
  // ברשימת התוכנות של Windows, ולכן אין דרך להסיר אותה משם.
  const m = loadMain({ elevate: true });
  createAppDir(m);
  await m.ready();

  // UUID v5('com.levtov.benhazmanim', ns של electron-builder) — ערך קבוע
  const key = 'a9bfe962-9f3c-5263-9e95-4def2bc5cb87';
  const dels = m.state.execCalls.filter((c) => c.cmd === 'reg'
    && c.args.includes('delete') && c.args.some((a) => a.includes(key)));
  assert.equal(dels.length, 3, 'שלושת המיקומים נמחקים — ' + JSON.stringify(dels.map((d) => d.args)));
  assert.ok(dels.some((d) => d.args.some((a) => a.startsWith('HKLM\\') && !a.includes('WOW6432Node'))),
    'המפתח ב-HKLM');
  assert.ok(dels.some((d) => d.args.some((a) => a.includes('WOW6432Node'))), 'המפתח ב-WOW6432Node');
  assert.ok(dels.some((d) => d.args.some((a) => a.startsWith('HKCU\\'))), 'המפתח ב-HKCU');

  // ללא הרשאות מנהל לא נוגעים ברישום
  m.cleanup();
  const m2 = loadMain({});
  createAppDir(m2);
  await m2.ready();
  const dels2 = m2.state.execCalls.filter((c) => c.cmd === 'reg' && c.args.includes('delete'));
  assert.equal(dels2.length, 0, 'ללא הרשאות מנהל אין מחיקת רשומת הסרה');
  m2.cleanup();
});

test('uninstall: הסרה כותבת אסימון חד-פעמי ומעבירה אותו ל-Uninstaller', async () => {
  // ה-Uninstaller מסרב לפעול ללא האסימון — כך שגם הפעלה ישירה של
  // Uninstall.exe (מחוץ לתוכנה) אינה יכולה להסיר את התוכנה.
  const uninstallerPath = path.join(os.tmpdir(), 'bhz-uninst-token.exe');
  fs.writeFileSync(uninstallerPath, '');
  try {
    const m = loadMain({ uninstallerPath });
    await m.ready();
    const res = await m.ipcHandlers.get('app:uninstall')({}, undefined);
    assert.ok(res.ok, 'הסרה מתוך התוכנה מותרת: ' + JSON.stringify(res));

    const tokenFile = path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'uninstall.token');
    assert.ok(fs.existsSync(tokenFile), 'קובץ האסימון נכתב בנתיב המשותף');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    assert.ok(token.length >= 32, 'אסימון אקראי באורך תקין');

    const spawn = m.state.spawnCalls.find((s) => s.cmd === uninstallerPath);
    assert.ok(spawn, 'ה-Uninstaller הופעל');
    assert.ok(spawn.args.includes('/S'), 'הפעלה שקטה');
    const tokenArg = spawn.args.find((a) => a.startsWith('/TOKEN='));
    assert.ok(tokenArg, 'האסימון מועבר בשורת הפקודה: ' + JSON.stringify(spawn.args));
    assert.equal(tokenArg.slice('/TOKEN='.length), token, 'האסימון בשורת הפקודה תואם לקובץ');
    m.cleanup();
  } finally {
    try { fs.unlinkSync(uninstallerPath); } catch { /* ignore */ }
  }
});

test('uninstall: ההסרה מסתיימת במלואה גם כשדגל העצירה נכתב בתחילת התהליך (מירוץ מוניטור)', async () => {
  // ה-handler כותב quit.flag כבר בתחילת ההסרה (עבור השומר המערכתי). בלי
  // התיקון, מוניטור דגל העצירה של האפליקציה הראשית (כל 3 שניות) היה רואה
  // את הדגל וסוגר את התהליך באמצע — לפני כתיבת האסימון, הסרת רישומי
  // ההפעלה והפעלת ה-Uninstaller. התיקון מסמן isQuitting לפני כתיבת הדגל,
  // כך שהמוניטור מדלג עליו וההסרה רצה עד הסוף.
  const uninstallerPath = path.join(os.tmpdir(), 'bhz-uninst-race.exe');
  fs.writeFileSync(uninstallerPath, '');
  try {
    const m = loadMain({ uninstallerPath });
    await m.ready();

    const res = await m.ipcHandlers.get('app:uninstall')({}, undefined);
    assert.ok(res.ok, 'ההסרה הושלמה: ' + JSON.stringify(res));

    // דגל העצירה אכן נכתב בתחילת התהליך (הוא קיים אחריו) —
    // ובכל זאת ההסרה המשיכה עד הסוף ולא נקטעה באמצע.
    const quitFlag = path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'quit.flag');
    assert.ok(fs.existsSync(quitFlag), 'דגל העצירה נכתב עבור השומר המערכתי');

    // שלבי ההסרה שאחרי כתיבת הדגל — כולם בוצעו:
    const tokenFile = path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'uninstall.token');
    assert.ok(fs.existsSync(tokenFile), 'קובץ האסימון נכתב — התהליך לא נקטע לפניו');
    const spawn = m.state.spawnCalls.find((s) => s.cmd === uninstallerPath);
    assert.ok(spawn, 'ה-Uninstaller הופעל');
    const regDels = m.state.execCalls.filter((c) => c.cmd === 'reg' && c.args.includes('delete'));
    assert.ok(regDels.length > 0, 'רישומי ההפעלה הוסרו מהרישום');
    const taskDels = m.state.execCalls.filter((c) => c.cmd === 'schtasks' && c.args.includes('/Delete'));
    assert.ok(taskDels.length >= 2, 'שתי המשימות המתוזמנות נמחקו');
    // האפליקציה נסגרה על ידי gracefulQuit של סוף התהליך
    assert.equal(m.state.quitCalled, true, 'האפליקציה נסגרה בסוף ההסרה');
    m.cleanup();
  } finally {
    try { fs.unlinkSync(uninstallerPath); } catch { /* ignore */ }
  }
});

test('uninstall: אסימון הסרה ישן מנוקה באתחול הבא', async () => {
  const m = loadMain({});
  // אסימון ישן שנותר (למשל מהסרה שבוטלה) — חייב להימחק באתחול,
  // אחרת כל אחד יוכל להריץ את Uninstall.exe עם קובץ ישן
  fs.mkdirSync(path.join(process.env.PROGRAMDATA, 'BenHazmanim'), { recursive: true });
  fs.writeFileSync(path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'uninstall.token'), 'stale-token');
  await m.ready();
  assert.equal(fs.existsSync(path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'uninstall.token')), false,
    'אסימון ישן מנוקה באתחול');
  m.cleanup();
});

test('startup: elevated run creates SYSTEM guard task and records install location', async () => {
  const m = loadMain({
    elevate: true,
    exec(cmd, args) {
      if (cmd === 'schtasks' && args.includes('/Create')) return { err: null, stdout: '', stderr: '' };
      if (cmd === 'schtasks' && args.includes('/Query')) return { err: new Error('not found'), stdout: '', stderr: '' };
      return { err: null, stdout: '', stderr: '' };
    }
  });
  createAppDir(m);
  await m.ready();

  // מיקום ההתקנה המקורי נרשם לקובץ משותף (לשימוש השומר המערכתי לשחזור)
  const installJson = path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'install.json');
  assert.ok(fs.existsSync(installJson), 'מיקום ההתקנה נרשם');
  const info = JSON.parse(fs.readFileSync(installJson, 'utf8'));
  assert.equal(info.dir, path.join(m.tmpRoot, 'app'), 'מיקום ההתקנה נכון');

  // משימת השומר המערכתי: SYSTEM, באתחול המחשב, מתוך העותק המוגן
  const guardCreate = m.state.execCalls.find(
    (c) => c.cmd === 'schtasks' && c.args.includes('BenHazmanimGuard') && c.args.includes('/Create')
  );
  assert.ok(guardCreate, 'משימת שומר-שער מערכתי נוצרה');
  assert.ok(guardCreate.args.includes('SYSTEM'), 'רצה כ-SYSTEM');
  assert.ok(guardCreate.args.includes('ONSTART'), 'באתחול המחשב');
  const tr = guardCreate.args[guardCreate.args.indexOf('/TR') + 1];
  assert.ok(tr.includes('--watchdog-system'), 'עם דגל --watchdog-system');
  assert.ok(tr.includes(protectedDir(m)), 'מצביעה על העותק המוגן');

  // הקפצה מיידית של השומר המערכתי
  const guardRun = m.state.execCalls.find(
    (c) => c.cmd === 'schtasks' && c.args.includes('/Run') && c.args.includes('BenHazmanimGuard')
  );
  assert.ok(guardRun, 'השומר המערכתי הוקפץ מיד');
  m.cleanup();
});

test('startup: non-elevated run does NOT create the SYSTEM guard task', async () => {
  const m = loadMain({});
  createAppDir(m);
  await m.ready();

  const guardCreate = m.state.execCalls.find(
    (c) => c.cmd === 'schtasks' && c.args.includes('BenHazmanimGuard') && c.args.includes('/Create')
  );
  assert.equal(guardCreate, undefined, 'ללא הרשאות מנהל אין משימת שומר מערכתי');
  const installJson = path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'install.json');
  assert.equal(fs.existsSync(installJson), false, 'ללא הרשאות מנהל אין רישום מיקום התקנה');
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

test('enforcement state machine reports stable desired and actual states', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.enabled = false;
  const m = loadMain({ settings });
  await m.ready();

  await m.ipcHandlers.get('lock:now')();
  await new Promise((resolve) => setTimeout(resolve, 20));
  let st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.enforcement.desired, 'blocked');
  assert.equal(st.enforcement.actual, 'blocked');
  assert.equal(st.enforcement.phase, 'stable');

  await m.ipcHandlers.get('unlock:now')({}, '1234');
  await new Promise((resolve) => setTimeout(resolve, 20));
  st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.enforcement.desired, 'allowed');
  assert.equal(st.enforcement.actual, 'allowed');
  assert.equal(st.enforcement.phase, 'stable');
  assert.ok(st.enforcement.transitionId >= 2);
  m.cleanup();
});

/* ================= הגדרות ================= */

test('settings:save rejects malformed IPC payloads', async () => {
  const m = loadMain({});
  await m.ready();
  const res = await m.ipcHandlers.get('settings:save')({}, null);
  assert.equal(res.ok, false);
  assert.match(res.error || '', /מבנה/);
  m.cleanup();
});

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

test('startup: settings window stays hidden until explicitly opened', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  const w = mainWin(m);
  assert.ok(w, 'חלון ההגדרות נטען כדי לשרת את הממשק');
  assert.equal(w.visible, false, 'באתחול חלון ההגדרות צריך להישאר מוסתר');
  const session = await m.ipcHandlers.get('settings:get')();
  assert.equal(session.sessionUnlocked, false, 'הסשן נשאר מוגן בלי להציג מסך כניסה');

  const opened = await m.ipcHandlers.get('settings:open')();
  assert.equal(opened.ok, true);
  assert.equal(w.visible, true, 'פתיחה מפורשת מהמגש מציגה את ההגדרות');
  m.cleanup();
});

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
  assert.equal(back.pinHash, undefined, 'pinHash אינו חשוף לממשק');
  assert.equal(back.pinSet, true, 'הסיסמה נשארת מוגדרת');
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

// מתקין דמה חוקי לבדיקות: גם הוא חייב לעבור אימות SHA-256 כמו מתקין אמיתי.
function fakeInstallerBytes(fill = 7) {
  const bytes = Buffer.alloc(2 * 1024 * 1024, fill);
  bytes[0] = 0x4d; bytes[1] = 0x5a;
  return bytes;
}
function fakeInstallerHash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

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
  const installer = fakeInstallerBytes();
  const installerHash = fakeInstallerHash(installer);
  fetchMock = async (url) => {
    const api = githubApiRelease(url);
    if (api) return api;
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '9.9.9', url: 'https://github.com/Lev-Good/Between-times/releases/latest', sha256: installerHash }) };
    }
    if (url.includes('releases/download/v9.9.9/Setup.9.9.9.exe')) {
      // 2MB תקין — חייב להתחיל בחותמת PE (MZ) כמו EXE אמיתי
      const bytes = installer; // 'MZ' + SHA-256 תואם ל-metadata
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

    // דגל "הפעל מחדש" נכתב — כדי שהמתקין יפתח את הגרסה החדשה אחרי ההתקנה
    // (התקנה שקטה /S לא מריצה את התוכנה מעצמה)
    assert.ok(fs.existsSync(path.join(m.tmpRoot, 'userData', 'relaunch.flag')), 'relaunch.flag ב-userData');
    assert.ok(fs.existsSync(path.join(process.env.APPDATA, 'BenHazmanim', 'relaunch.flag')), 'relaunch.flag בנתיב ה-NSIS');
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

test('update:download writes relaunch flag so the installer reopens the app', async () => {
  // אותו מהלך כמו בדיקת ההורדה — אבל בודק במפורש שהדגל נכתב בשני הנתיבים
  // ש-NSIS בודק ב-customInstall (BenHazmanim + userData)
  const installer = fakeInstallerBytes();
  const installerHash = fakeInstallerHash(installer);
  fetchMock = async (url) => {
    const api = githubApiRelease(url);
    if (api) return api;
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '9.9.9', sha256: installerHash }) };
    }
    if (url.includes('releases/download/v9.9.9/Setup.9.9.9.exe')) {
      const bytes = installer;
      // 'MZ' + SHA-256 תואם ל-metadata
      return { ok: true, headers: { get: () => String(bytes.length) }, body: fakeStream([bytes]) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const m = loadMain({});
    await m.ready();
    const res = await m.ipcHandlers.get('update:download')();
    assert.ok(res.ok);
    // המתקין מופעל בשקט — והדגל יורה ל-NSIS להריץ את האפליקציה בסוף
    const spawn = m.state.spawnCalls.find((s) => s.cmd && /BenHazmanim-Setup-9\.9\.9\.exe$/.test(s.cmd));
    assert.ok(spawn, 'המתקין הופעל');
    assert.ok(spawn.args.includes('/S'));
    assert.ok(fs.existsSync(path.join(m.tmpRoot, 'userData', 'relaunch.flag')));
    assert.ok(fs.existsSync(path.join(process.env.APPDATA, 'BenHazmanim', 'relaunch.flag')));
    // נתיב משותף לכל המשתמשים — רשת ביטחון להבדלי סביבה בין האפליקציה למתקין
    assert.ok(fs.existsSync(path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'relaunch.flag')),
      'relaunch.flag בנתיב המשותף (PROGRAMDATA)');
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

test('startup: stale relaunch flags are cleared on launch', async () => {
  // אם המתקין לא ניקה דגל ישן (או ההתקנה בוטלה) — אסור שהוא יגרום
  // להפעלה אוטומטית בהתקנה עתידית; האפליקציה מנקה אותו באתחול.
  fs.mkdirSync(path.join(process.env.APPDATA, 'BenHazmanim'), { recursive: true });
  fs.writeFileSync(path.join(process.env.APPDATA, 'BenHazmanim', 'relaunch.flag'), String(Date.now()));
  const m = loadMain({});
  // דגל ישן גם בנתיב ה-userData — שני הנתיבים חייבים להתנקות באתחול
  fs.writeFileSync(path.join(m.tmpRoot, 'userData', 'relaunch.flag'), String(Date.now()));
  await m.ready();
  assert.equal(fs.existsSync(path.join(process.env.APPDATA, 'BenHazmanim', 'relaunch.flag')), false, 'דגל הפעלה מחדש מנוקה באתחול');
  assert.equal(fs.existsSync(path.join(m.tmpRoot, 'userData', 'relaunch.flag')), false, 'דגל ב-userData מנוקה באתחול');
  assert.equal(fs.existsSync(path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'relaunch.flag')), false, 'דגל בנתיב המשותף מנוקה באתחול');
  m.cleanup();
});

test('startup: quit.flag תקוע תחת איסור מחיקה ב-machineDir מוסר בכוח — האפליקציה לא נסגרת על דגל ישן', async () => {
  // רגרסיה לבאג קריטי: דגל עצירה שנכתב ל-PROGRAMDATA המוקשח (איסור מחיקה
  // לכולם, כולל מנהלים) לא ניתן היה למחיקה ע"י האפליקציה — ולכן האתחול
  // הבא ראה את הדגל הישן וסגר את עצמו תוך 3 שניות (gracefulQuit). כל יציאה
  // מסודרת השאירה דגל כזה, וכל משתמש היה נתקע ב"התוכנה לא נדלקת בכלל".
  // המדמה את חסימת המחיקה: אטריבוט read-only (ב-Windows מחיקת קובץ כזה
  // נחסמת ב-EPERM — כמו איסור המחיקה). ה-icacls במוק "מרים" את החסימה
  // (מבטל read-only), ואז ה-unlink השני חייב להצליח.
  const m = loadMain({
    elevate: true,
    execSync(cmd, args) {
      if (cmd === 'net') return ''; // מוגבה
      if (cmd === 'icacls' && args[0]) {
        // המדמה את הרמת הירושה/האיסור: הקובץ הופך לכתוב ומחיקתו מותרת
        try { fs.chmodSync(args[0], 0o666); } catch { /* ignore */ }
        return '';
      }
      if (cmd === 'reg' && args.includes('query')) {
        return 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.levtov.benhazmanim\r\n    UninstallString    REG_SZ    "C:\\uninst.exe"\r\n';
      }
      throw new Error('unknown execSync: ' + cmd);
    }
  });
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  const stuck = path.join(machineDir, 'quit.flag');
  fs.writeFileSync(stuck, String(Date.now()));
  try { fs.chmodSync(stuck, 0o444); } catch { /* ignore */ } // דגל "תקוע" — מחיקה חסומה

  await m.ready();

  assert.equal(fs.existsSync(stuck), false, 'הדגל התקוע הוסר בכוח באתחול (forceUnlinkFlag)');
  assert.equal(m.state.quitCalled, false, 'האפליקציה לא נסגרה על דגל עצירה ישן');
  m.cleanup();
});

test('uninstall: quit.flag בנתיב המשותף מוחרג מאיסור המחיקה בעת הכתיבה (מוגבה)', async () => {
  // מניעה ראשונית של הבאג: הדגל המשותף נכתב לתוך PROGRAMDATA מוקשח
  // (איסור מחיקה לכולם). בלי החרגה של הקובץ עצמו מיד עם הכתיבה, האתחול
  // הבא לא יכול למחוק אותו — והאפליקציה נסגרת על דגל ישן. ההחרגה חייבת
  // להשתמש בדפוס הבטוח (בלי סימוני ירושה), כמו settings.backup.json.
  const uninstallerPath = path.join(os.tmpdir(), 'bhz-uninst-excl.exe');
  fs.writeFileSync(uninstallerPath, '');
  try {
    const m = loadMain({ elevate: true, uninstallerPath });
    await m.ready();
    await m.ipcHandlers.get('app:uninstall')({}, undefined);
    const exclude = m.state.execCalls.find((c) => c.cmd === 'icacls'
      && c.args.some((a) => a.includes('quit.flag'))
      && c.args.includes('/inheritance:r'));
    assert.ok(exclude, 'הדגל המשותף מוחרג מאיסור המחיקה בעת הכתיבה');
    assert.ok(!exclude.args.some((a) => a.includes('(OI)') || a.includes('(CI)')),
      'ההחרגה בלי סימוני ירושה (התבנית שמשחיתה קבצים): ' + JSON.stringify(exclude.args));
    m.cleanup();
  } finally {
    try { fs.unlinkSync(uninstallerPath); } catch { /* ignore */ }
  }
});

test('update:download refuses corrupt/tiny downloads (no install, no quit)', async () => {
  const installer = fakeInstallerBytes();
  const installerHash = fakeInstallerHash(installer);
  fetchMock = async (url) => {
    const api = githubApiRelease(url);
    if (api) return api;
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '9.9.9', sha256: installerHash }) };
    }
    if (url.includes('releases/download/v9.9.9/Setup.9.9.9.exe')) {
      // קובץ גדול מספיק אבל ללא חותמת MZ — לא תקין; ה-hash שלו תקין
      const bytes = Buffer.alloc(2 * 1024 * 1024, 1);
      return { ok: true, headers: { get: () => '2097152' }, body: fakeStream([bytes]) };
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

test('update:download rejects metadata without SHA-256', async () => {
  const installer = fakeInstallerBytes();
  fetchMock = async (url) => {
    const api = githubApiRelease(url);
    if (api) return api;
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '9.9.9' }) };
    }
    if (url.includes('releases/download/v9.9.9/Setup.9.9.9.exe')) {
      return { ok: true, headers: { get: () => String(installer.length) }, body: fakeStream([installer]) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const m = loadMain({});
    await m.ready();
    const res = await m.ipcHandlers.get('update:download')();
    assert.equal(res.ok, false);
    assert.match(res.error || '', /SHA-256/);
    assert.equal(m.state.quitCalled, false);
    assert.equal(m.state.spawnCalls.filter((s) => s.args && s.args.includes('/S')).length, 0);
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

test('update:download rejects a tampered installer (SHA-256 mismatch)', async () => {
  // ליבת ההבטחה של גרסה 1.5.8: הקובץ שהורד נבדק מול ה-hash שפורסם
  // ב-version.json. גם EXE תקין לחלוטין (MZ, גודל סביר) שטביעתו שונה
  // מהפורסם — חייב להידחות, להימחק מהדיסק, בלי הפעלת מתקין ובלי סגירת
  // התוכנה. בלעדיו, מתקין שהוחלף בדרך (Man-in-the-Middle / שחרור פגום)
  // היה מורץ בשקט.
  const real = fakeInstallerBytes(7);
  const tampered = fakeInstallerBytes(9); // EXE תקין אחר — טביעה שונה
  const realHash = fakeInstallerHash(real);
  assert.notEqual(realHash, fakeInstallerHash(tampered), 'דמה: שני הקבצים שונים');
  fetchMock = async (url) => {
    const api = githubApiRelease(url);
    if (api) return api;
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '9.9.9', sha256: realHash }) };
    }
    if (url.includes('releases/download/v9.9.9/Setup.9.9.9.exe')) {
      // ההורדה חוזרת עם קובץ שונה ממה שה-metadata מבטיח
      return { ok: true, headers: { get: () => String(tampered.length) }, body: fakeStream([tampered]) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const m = loadMain({});
    await m.ready();
    const res = await m.ipcHandlers.get('update:download')();
    assert.equal(res.ok, false, 'מתקין שטביעתו אינה תואמת חייב להידחות: ' + JSON.stringify(res));
    assert.match(res.error || '', /טביעת העדכון אינה תואמת/);
    assert.equal(m.state.quitCalled, false, 'אסור לסגור את התוכנה על קובץ מזויף');
    assert.equal(m.state.spawnCalls.filter((s) => s.args && s.args.includes('/S')).length, 0,
      'אסור להריץ מתקין שטביעתו אינה תואמת');
    // הקובץ החלקי נמחק — לא משאירים EXE לא מאומת על הדיסק
    const dest = path.join(m.tmpRoot, 'app', 'BenHazmanim-Setup-9.9.9.exe');
    assert.equal(fs.existsSync(dest), false, 'הקובץ שהורד נמחק מהדיסק');
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

test('update:download accepts an unsigned installer when SHA-256 matches and repo is official', async () => {
  const installer = fakeInstallerBytes();
  const installerHash = fakeInstallerHash(installer);
  fetchMock = async (url) => {
    const api = githubApiRelease(url);
    if (api) return api;
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '9.9.9', sha256: installerHash }) };
    }
    if (url.includes('releases/download/v9.9.9/Setup.9.9.9.exe')) {
      return { ok: true, headers: { get: () => String(installer.length) }, body: fakeStream([installer]) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    const m = loadMain({
      exec(cmd, args) {
        const joined = args.join(' ');
        if (cmd === 'powershell.exe' && joined.includes('Get-AuthenticodeSignature') && joined.includes('PSCustomObject')) {
          return { err: null, stdout: JSON.stringify({ status: 'NotSigned', subject: '' }), stderr: '' };
        }
        if (cmd === 'schtasks' && args.includes('/Create')) return { err: new Error('access denied'), stdout: '', stderr: '' };
        if (cmd === 'schtasks' && args.includes('/Query')) return { err: new Error('not found'), stdout: '', stderr: '' };
        if (cmd === 'netsh' && args.includes('show')) return { err: new Error('no such rule'), stdout: '', stderr: '' };
        return { err: null, stdout: '', stderr: '' };
      }
    });
    await m.ready();
    const res = await m.ipcHandlers.get('update:download')();
    assert.equal(res.ok, true);
    assert.equal(res.installing, true);
    assert.equal(m.state.quitCalled, true, 'valid update initiates app quit for install');
    assert.equal(m.state.spawnCalls.filter((s) => s.args && s.args.includes('/S')).length, 1,
      'valid unsigned installer is executed with /S');
    m.cleanup();
  } finally {
    fetchMock = null;
  }
});

test('update:download rejects download URLs outside the official repo', async () => {
  const installer = fakeInstallerBytes();
  const installerHash = fakeInstallerHash(installer);
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
      return { ok: true, json: async () => ({ version: '9.9.9', sha256: installerHash }) };
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
  const installer = fakeInstallerBytes();
  const installerHash = fakeInstallerHash(installer);
  fetchMock = async (url) => {
    const api = githubApiRelease(url);
    if (api) return api;
    if (url.includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ version: '9.9.9', sha256: installerHash }) };
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

/* ================= שותף אחריות (Accountability, Phase 2.5) ================= */

test('accountability: recovery code is also sent to the partner when enabled', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.recoveryEmail = 'me@example.com';
  settings.accountabilityEnabled = true;
  settings.accountabilityEmail = 'partner@example.com';
  const m = loadMain({ settings });
  await m.ready();
  let body = null;
  fetchMock = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true }) }; };
  const res = await m.ipcHandlers.get('recovery:send')();
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(body.email, 'me@example.com');
  assert.equal(body.partner, 'partner@example.com', 'partner CC must be included in the recovery request');
  m.cleanup();
});

test('accountability: recovery has NO partner CC when accountability is disabled', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.recoveryEmail = 'me@example.com';
  settings.accountabilityEnabled = false;
  settings.accountabilityEmail = 'partner@example.com'; // מוגדר אך כבוי
  const m = loadMain({ settings });
  await m.ready();
  let body = null;
  fetchMock = async (url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true }) }; };
  await m.ipcHandlers.get('recovery:send')();
  assert.equal(body.partner, '', 'no partner CC when accountability is off');
  m.cleanup();
});

test('accountability: request-approval fails when require-approval is off', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.accountabilityEnabled = true;
  settings.accountabilityEmail = 'partner@example.com';
  settings.accountabilityRequireApproval = false;
  const m = loadMain({ settings });
  await m.ready();
  const res = await m.ipcHandlers.get('accountability:request-approval')({});
  assert.equal(res.ok, false);
  m.cleanup();
});

test('accountability: unlock requires a one-time partner approval code when require-approval is on', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.accountabilityEnabled = true;
  settings.accountabilityEmail = 'partner@example.com';
  settings.accountabilityRequireApproval = true;
  for (let d = 0; d < 7; d++) settings.week[d].slots.push({ start: 0, end: 1440, type: 'blocked' });
  const m = loadMain({ settings });
  await m.ready();

  // סיסמה נכונה אך בלי קוד אישור → נדחה עם needApproval
  const noCode = await m.ipcHandlers.get('unlock:now')({}, '1234');
  assert.equal(noCode.ok, false);
  assert.equal(noCode.needApproval, true, JSON.stringify(noCode));

  // בקשת קוד אישור — נשלח לשותף בלבד (purpose:'unlock'); לוכדים את הקוד מגוף ה-POST
  let capturedCode = null, approvalBody = null;
  fetchMock = async (url, opts) => {
    const b = JSON.parse(opts.body);
    if (b.purpose === 'unlock') { capturedCode = b.token; approvalBody = b; }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const reqRes = await m.ipcHandlers.get('accountability:request-approval')({});
  assert.ok(reqRes.ok, JSON.stringify(reqRes));
  assert.equal(approvalBody.partner, 'partner@example.com', 'approval code goes only to the partner');
  assert.match(String(capturedCode), /^\d{6}$/, 'unlock approval code is 6 digits');

  // קוד שגוי → עדיין נדחה
  const wrongCode = capturedCode === '000000' ? '111111' : '000000';
  const wrong = await m.ipcHandlers.get('unlock:now')({}, '1234', wrongCode);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.needApproval, true);

  // קוד נכון → פתיחה מצליחה
  const ok = await m.ipcHandlers.get('unlock:now')({}, '1234', capturedCode);
  assert.ok(ok.ok, JSON.stringify(ok));

  // הקוד חד-פעמי: נעילה חוזרת ואותו קוד — שוב דורש אישור
  await m.ipcHandlers.get('lock:now')();
  const reuse = await m.ipcHandlers.get('unlock:now')({}, '1234', capturedCode);
  assert.equal(reuse.ok, false, 'a used approval code cannot be reused');
  assert.equal(reuse.needApproval, true);
  m.cleanup();
});

test('accountability: changing the PIN notifies the partner', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.accountabilityEnabled = true;
  settings.accountabilityEmail = 'partner@example.com';
  const m = loadMain({ settings });
  await m.ready();
  const notices = [];
  fetchMock = async (url, opts) => {
    const b = JSON.parse(opts.body);
    if (b.notice) notices.push(b);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const res = await m.ipcHandlers.get('pin:set')({}, '5678', '1234');
  assert.ok(res.ok, JSON.stringify(res));
  await new Promise((r) => setTimeout(r, 20)); // ההתראה נשלחת ברקע (fire-and-forget)
  assert.ok(notices.some((n) => n.notice === 'pin-changed' && n.partner === 'partner@example.com'),
    'partner must be notified on pin change: ' + JSON.stringify(notices));
  m.cleanup();
});

/* ================= תקופת צינון (Cool-off, Phase 2.6) ================= */

function blockedSettingsWithCoolOff(mins) {
  const s = S.defaultSchedule();
  s.pinHash = S.sha256Hex('1234');
  s.coolOffMinutes = mins;
  for (let d = 0; d < 7; d++) s.week[d].slots.push({ start: 0, end: 1440, type: 'blocked' });
  return s;
}

test('cool-off: unlock does not take effect immediately — stays blocked with a countdown', async () => {
  const m = loadMain({ settings: blockedSettingsWithCoolOff(5) });
  await m.ready();
  let st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'blocked');

  const res = await m.ipcHandlers.get('unlock:now')({}, '1234');
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.coolOffPending, true, 'unlock should enter a cool-off, not open immediately');
  assert.equal(res.coolOff, 300, 'cool-off is 5 minutes');

  st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'blocked', 'still blocked during cool-off');
  assert.equal(st.coolOff, true, 'status reports cool-off active');
  assert.ok(st.coolOffSeconds > 0 && st.coolOffSeconds <= 300, 'cool-off countdown present: ' + st.coolOffSeconds);
  m.cleanup();
});

test('cool-off: re-requesting during cool-off returns the remaining time (no reset)', async () => {
  const m = loadMain({ settings: blockedSettingsWithCoolOff(5) });
  await m.ready();
  const first = await m.ipcHandlers.get('unlock:now')({}, '1234');
  assert.ok(first.ok && first.coolOffPending);
  await new Promise((r) => setTimeout(r, 40));
  const second = await m.ipcHandlers.get('unlock:now')({}, '1234');
  assert.ok(second.ok && second.coolOffPending);
  assert.ok(second.coolOff <= first.coolOff, 'remaining time must not increase on re-request');
  m.cleanup();
});

test('cool-off: manual lock cancels a pending cool-off', async () => {
  const m = loadMain({ settings: blockedSettingsWithCoolOff(5) });
  await m.ready();
  await m.ipcHandlers.get('unlock:now')({}, '1234');
  let st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.coolOff, true);
  await m.ipcHandlers.get('lock:now')();
  st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.coolOff, false, 'manual lock must clear the pending cool-off');
  assert.equal(st.manualLock, true);
  m.cleanup();
});

test('cool-off: with 0 minutes the unlock opens immediately (no cool-off)', async () => {
  const m = loadMain({ settings: blockedSettingsWithCoolOff(0) });
  await m.ready();
  const res = await m.ipcHandlers.get('unlock:now')({}, '1234');
  assert.ok(res.ok, JSON.stringify(res));
  assert.ok(!res.coolOffPending, 'no cool-off when coolOffMinutes=0');
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'allowed', 'opened immediately (manualUnlockUntil set)');
  assert.equal(st.coolOff, false);
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

test('backup IPC rejects export/import while the parent session is locked', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();
  const exported = await m.ipcHandlers.get('backup:export')();
  const imported = await m.ipcHandlers.get('backup:import')();
  assert.equal(exported.ok, false);
  assert.match(exported.error || '', /סיסמה/);
  assert.equal(imported.ok, false);
  assert.match(imported.error || '', /סיסמה/);
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

test('main: powerMonitor resume writes an immediate heartbeat (no spurious restart after sleep)', async () => {
  // אחרי שינה/הערת מערכת ה-heartbeat של הראשי חייב להיכתב מיד — אחרת
  // השומר רואה אותו מיושן (נכתב לפני השינה), הורג ומקפיץ את הראשי מחדש
  // בכל פעם שהמחשב חוזר משינה — ריסטרט מיותר של התוכנה.
  const m = loadMain({});
  createAppDir(m);
  await m.ready();

  const hb = path.join(m.tmpRoot, 'userData', 'main.heartbeat');
  assert.ok(fs.existsSync(hb), 'הראשי כותב heartbeat');
  assert.ok(m.electron.powerMonitor.listeners.resume, 'הראשי רשום לאירוע resume');
  fs.unlinkSync(hb); // מדמי שינה ארוכה — heartbeat ישן נמחק
  m.electron.powerMonitor.emit('resume');
  assert.ok(fs.existsSync(hb), 'resume כותב heartbeat מיד (כתיבה סינכרונית)');
  m.cleanup();
});

test('watchdog: powerMonitor resume writes an immediate heartbeat', async () => {
  const m = makeMock({});
  await withWatchdogArg(m, async () => {
    await m.ready();
    const hb = path.join(m.tmpRoot, 'userData', 'watchdog.heartbeat');
    assert.ok(fs.existsSync(hb), 'השומר כותב heartbeat');
    assert.ok(m.electron.powerMonitor.listeners.resume, 'השומר רשום לאירוע resume');
    fs.unlinkSync(hb);
    m.electron.powerMonitor.emit('resume');
    assert.ok(fs.existsSync(hb), 'resume כותב heartbeat מיד');
  });
});

/* ================= שומר-שער מערכתי (--watchdog-system) ================= */

function withSystemWatchdogArg(m, fn) {
  const origArgv = process.argv;
  process.argv = [origArgv[0], 'main.js', '--watchdog-system'];
  try {
    delete require.cache[require.resolve('../main.js')];
    require('../main.js');
    return fn();
  } finally {
    process.argv = origArgv;
  }
}

// סביבת שומר מערכתי: תיקיית התקנה + עותק מוגן + הגדרות משותפות + מיקום התקנה
function guardEnv(m) {
  const appDir = createAppDir(m);
  const pd = protectedDir(m);
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({ name: 'ben-hazmanim', version: '9.9.9' }), 'utf8');
  fs.writeFileSync(path.join(pd, path.basename(process.execPath)), 'protected-exe');
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  // הגדרות משותפות חייבות להתקיים — אחרת השומר יוצא (סימן הסרה)
  fs.writeFileSync(path.join(machineDir, 'settings.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'install.json'), JSON.stringify({ exe: 'x', dir: appDir }), 'utf8');
  fs.writeFileSync(path.join(pd, 'settings.backup.json'), '{}', 'utf8');
  // תבנית ה-XML משמרת את המשתמש האינטראקטיבי של המשימה הראשית;
  // שומר שרץ כ-SYSTEM לא יוצר אותה מחדש עם principal שגוי.
  fs.writeFileSync(path.join(machineDir, 'main-task.xml'), '<Task><Principals/><Actions/></Task>', 'utf8');
  return { appDir, pd, machineDir };
}

const guardTamperLog = () => path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'tamper.log');

// כתיבת מניפסט שלמות ידני לתיקייה — כמו זה שהתוכנה כותבת (integrity.json).
// האופציה includeUninstaller מדמה מניפסט "ישן" (מגרסה שקדמה לשינוי) שבו
// מתקין ההסרה טרם נכלל — התרחיש שבו רק restoreUninstaller הממוקד מזהה
// את המחיקה.
function writeGuardManifest(dir, opts) {
  const crypto = require('crypto');
  const o = opts || {};
  const files = [path.join(dir, 'package.json'), path.join(dir, path.basename(process.execPath))];
  if (o.includeUninstaller !== false) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/^Uninstall .*\.exe$/i.test(name)) files.push(path.join(dir, name));
      }
    } catch { /* ignore */ }
  }
  const entries = [];
  for (const file of files) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const st = fs.statSync(file);
    entries.push({
      path: path.relative(dir, file),
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    });
  }
  fs.writeFileSync(path.join(dir, 'integrity.json'), JSON.stringify({ version: '9.9.9', files: entries }));
}

test('system watchdog: restores deleted install dir from protected copy', async () => {
  const m = makeMock({ elevate: true });
  const { appDir } = guardEnv(m);
  // מחיקת תיקיית ההתקנה המקורית — בדיוק מה שמשתמש עם הרשאות מנהל יכול לעשות
  fs.rmSync(appDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(appDir, 'package.json')), false);

  await withSystemWatchdogArg(m, async () => {
    await m.ready(); // ה-check() הראשון רץ מיד — משחזר
    assert.ok(fs.existsSync(path.join(appDir, 'package.json')), 'תיקיית ההתקנה שוחזרה מהעותק המוגן');
    assert.ok(fs.existsSync(path.join(appDir, path.basename(process.execPath))), 'קובץ ההרצה שוחזר');
    const tamper = fs.readFileSync(guardTamperLog(), 'utf8');
    assert.match(tamper, /install-dir-restored/, 'אירוע החבלה נרשם ליומן');
    // השומר מרים זמנית את איסור המחיקה לפני השחזור, ומחזיר אותו אחריו
    const lift = m.state.execCalls.find((c) => c.cmd === 'icacls' && c.args.includes('/remove:d')
      && c.args.some((a) => a.includes(appDir)));
    assert.ok(lift, 'השומר מרים את איסור המחיקה לפני שחזור תיקיית ההתקנה');
    const reharden = m.state.execCalls.find((c) => c.cmd === 'icacls' && c.args.includes(appDir)
      && c.args.includes('/deny') && c.args.some((a) => a.includes('DE,DC')));
    assert.ok(reharden, 'לאחר השחזור איסור המחיקה מוחזר לתיקיית ההתקנה');
  });
});

test('system watchdog: restores deleted uninstaller from the protected copy', async () => {
  // מחיקת מתקין ההסרה בלבד (בלי לגעת בשאר הקבצים) הופכת את ההסרה החוקית
  // לבלתי אפשרית. השומר המערכתי חייב לשחזר אותו מהעותק המוגן — כך שגם אחרי
  // ניסיון חבלה כזה ההסרה מהתוכנה ממשיכה לעבוד. המניפסט כאן הוא "ישן"
  // (ללא ה-Uninstaller) — התרחיש שבו רק השחזור הממוקד מזהה את המחיקה.
  const m = makeMock({ elevate: true });
  const { appDir, pd } = guardEnv(m);
  const uninstName = 'Uninstall בין הזמנים.exe';
  // מיישרים את קובץ ההרצה בעותק המוגן לזה של תיקיית ההתקנה — כך שהמניפסט
  // יאומת מול תיקיית ההתקנה, והיחיד שחסר יהיה רק מתקין ההסרה (והנתיב
  // הממוקד restoreUninstaller הוא שישחזר אותו, לא שחזור מלא).
  fs.writeFileSync(path.join(pd, path.basename(process.execPath)),
    fs.readFileSync(path.join(appDir, path.basename(process.execPath))));
  // המתקין קיים בעותק המוגן (כמו אחרי התקנה) — ונמחק מתיקיית ההתקנה
  fs.writeFileSync(path.join(pd, uninstName), 'uninstaller-bytes');
  // מניפסט "ישן" (ללא ה-Uninstaller) — תרחיש השדרוג שבו רק השחזור הממוקד מזהה
  writeGuardManifest(pd, { includeUninstaller: false });
  assert.equal(fs.existsSync(path.join(appDir, uninstName)), false, 'המתקין נמחק מתיקיית ההתקנה');

  await withSystemWatchdogArg(m, async () => {
    await m.ready(); // ה-check() הראשון רץ מיד — משחזר
    assert.ok(fs.existsSync(path.join(appDir, uninstName)), 'מתקין ההסרה שוחזר מהעותק המוגן');
    assert.equal(fs.readFileSync(path.join(appDir, uninstName), 'utf8'), 'uninstaller-bytes',
      'התוכן שוחזר נכון');
    const tamper = fs.readFileSync(guardTamperLog(), 'utf8');
    assert.match(tamper, /uninstaller-restored/, 'אירוע השחזור נרשם ליומן החבלה');
  });
  m.cleanup();
});

test('main: מתקין הסרה חסר משוחזר באתחול (שחזור ממוקד)', async () => {
  // גם האפליקציה עצמה (בהרצה מוגבהת) מוודאת באתחול שמתקין ההסרה קיים —
  // כך שההסרה החוקית זמינה מיד, לא רק בתוך 10 שניות של השומר.
  const m = loadMain({ elevate: true });
  const appDir = createAppDir(m);
  const pd = protectedDir(m);
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({ name: 'ben-hazmanim', version: '9.9.9' }), 'utf8');
  fs.writeFileSync(path.join(pd, path.basename(process.execPath)), 'protected-exe');
  const uninstName = 'Uninstall בין הזמנים.exe';
  fs.writeFileSync(path.join(pd, uninstName), 'uninstaller-bytes');
  // מניפסט תקין (עם ה-Uninstaller) — כך שהעותק המוגן לא ירענן וימחק אותו
  writeGuardManifest(pd);
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'install.json'), JSON.stringify({ exe: 'x', dir: appDir }), 'utf8');
  fs.writeFileSync(path.join(machineDir, 'settings.json'), '{}', 'utf8');

  assert.equal(fs.existsSync(path.join(appDir, uninstName)), false, 'המתקין חסר באתחול');
  await m.ready();
  assert.ok(fs.existsSync(path.join(appDir, uninstName)), 'מתקין ההסרה שוחזר באתחול');
  assert.equal(fs.readFileSync(path.join(appDir, uninstName), 'utf8'), 'uninstaller-bytes');
  const tamper = fs.readFileSync(guardTamperLog(), 'utf8');
  assert.match(tamper, /uninstaller-restored/, 'אירוע השחזור נרשם ליומן החבלה');
  m.cleanup();
});

test('system watchdog: restores deleted protected copy from install dir', async () => {
  const m = makeMock({ elevate: true });
  const { pd } = guardEnv(m);
  fs.rmSync(pd, { recursive: true, force: true });

  await withSystemWatchdogArg(m, async () => {
    await m.ready();
    assert.ok(fs.existsSync(path.join(pd, 'package.json')), 'העותק המוגן שוחזר מתיקיית ההתקנה');
    assert.ok(fs.existsSync(path.join(pd, path.basename(process.execPath))), 'קובץ ההרצה שוחזר');
    const tamper = fs.readFileSync(guardTamperLog(), 'utf8');
    assert.match(tamper, /protected-copy-restored/, 'אירוע החבלה נרשם ליומן');
  });
});

test('system watchdog: recreates deleted scheduled tasks pointing at protected copy', async () => {
  const m = makeMock({ elevate: true });
  guardEnv(m);
  await withSystemWatchdogArg(m, async () => {
    await m.ready();
    // ברירת המחדל של המוק: /Query נכשל (משימה לא קיימת) → יצירה מחדש
    const creates = m.state.execCalls.filter((c) => c.cmd === 'schtasks' && c.args.includes('/Create'));
    const main = creates.find((c) => c.args.includes('BenHazmanim') && !c.args.includes('BenHazmanimGuard'));
    assert.ok(main, 'המשימה הראשית נוצרה מחדש');
    assert.ok(main.args.includes('/XML'), 'המשימה הראשית משוחזרת מתבנית XML');
    const guard = creates.find((c) => c.args.includes('BenHazmanimGuard'));
    assert.ok(guard, 'משימת השומר המערכתי נוצרה מחדש');
    assert.ok(guard.args.includes('SYSTEM'), 'שומר מערכתי כ-SYSTEM');
    assert.ok(guard.args.includes('ONSTART'), 'באתחול המחשב');
  });
});

test('system watchdog: exits on machine quit flag (uninstall)', async () => {
  const m = makeMock({ elevate: true });
  const { machineDir } = guardEnv(m);
  fs.writeFileSync(path.join(machineDir, 'quit.flag'), String(Date.now()));
  await withSystemWatchdogArg(m, async () => {
    await m.ready();
    assert.ok(m.state.exitCalled, 'השומר יוצא כשיש דגל עצירה (הסרה)');
  });
});

test('system watchdog: does not exit merely because settings were deleted', async () => {
  const m = makeMock({ elevate: true });
  const { machineDir } = guardEnv(m);
  fs.rmSync(path.join(machineDir, 'settings.json'));
  await withSystemWatchdogArg(m, async () => {
    await m.ready();
    assert.equal(m.state.exitCalled, false, 'מחיקת settings.json לבדה לא עוצרת את השומר');
    assert.ok(fs.existsSync(path.join(machineDir, 'settings.json')), 'השומר משחזר את ההגדרות מהעותק המוגן');
  });
});

test('security:get reports last tamper event (written by system watchdog)', async () => {
  const m = loadMain({});
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(
    path.join(machineDir, 'tamper.log'),
    JSON.stringify({ ts: Date.now(), kind: 'install-dir-restored' }) + '\n',
    'utf8'
  );
  await m.ready();
  const sec = await m.ipcHandlers.get('security:get')();
  assert.equal(sec.lastTamper.kind, 'install-dir-restored', 'מסך ההגנה מדווח על ניסיון החבלה');
  m.cleanup();
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
  assert.equal(res.pinHash, undefined, 'pinHash אינו נחשף לממשק');
  assert.equal(res.pinSet, true, 'מצב הסיסמה נחשף ללא ההאש עצמו');
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

/* ================= חסימת אינטרנט בלבד (netblock) ================= */

test('netblock: enforce applies the firewall rule and shows the floating icon (no block windows)', async () => {
  // לוח: היום כולו — חסימת אינטרנט בלבד (מחשב פתוח)
  const now = new Date();
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.week[now.getDay()].slots = [{ start: 0, end: 1440, type: 'netblock' }];
  const m = loadMain({ settings, elevate: true });
  await m.ready();

  // חוק חומת האש — netsh add עם dir=out / action=block
  const netshCalls = m.state.execCalls.filter((c) => c.cmd === 'netsh');
  const add = netshCalls.find((c) => c.args.includes('add'));
  assert.ok(add, 'צריכה להיות קריאת netsh add לחוק חסימת אינטרנט');
  assert.ok(add.args.includes('dir=out'), 'החוק צריך לחסום יציאה');
  assert.ok(add.args.includes('action=block'), 'החוק צריך לחסום');

  // אין חלונות חסימה (המחשב פתוח) — אבל יש חלון אייקון צף קטן
  const blockWins = m.state.windows.filter((w) => w.blockDisplayId);
  assert.equal(blockWins.length, 0, 'בחסימת אינטרנט אין חלונות חסימה');
  const iconWins = m.state.windows.filter((w) => !w.blockDisplayId && !w.title);
  assert.equal(iconWins.length, 1, 'נוצר חלון אייקון צף אחד');

  // המצב המוצג: אינטרנט חסום
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'netblock');
  assert.equal(st.stateLabel, 'האינטרנט חסום');
  assert.equal(st.manualLock, false);
  m.cleanup();
});

test('netblock: full lock takes precedence and removes the internet rule', async () => {
  const now = new Date();
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.week[now.getDay()].slots = [{ start: 0, end: 1440, type: 'netblock' }];
  const m = loadMain({ settings, elevate: true });
  await m.ready();

  // בתחילה חסימת האינטרנט פעילה — חוק חומת האש נוסף
  const add = m.state.execCalls.find((c) => c.cmd === 'netsh' && c.args.includes('add'));
  assert.ok(add, 'חסימת האינטרנט פעילה בתחילה');

  // נעילה ידנית — מסך החסימה המלא גובר ומסיר את חוק הרשת
  await m.ipcHandlers.get('lock:now')();
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.manualLock, true);
  const blockWins = m.state.windows.filter((w) => w.blockDisplayId);
  assert.ok(blockWins.length >= 1, 'נעילה ידנית מציגה חלונות חסימה');
  const del = m.state.execCalls.find((c) => c.cmd === 'netsh' && c.args.includes('delete'));
  assert.ok(del, 'הנעילה המלאה מסירה את חוק חסימת האינטרנט');
  m.cleanup();
});

test('netblock: unlock with password releases the internet until the next transition', async () => {
  const now = new Date();
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.week[now.getDay()].slots = [{ start: 0, end: 1440, type: 'netblock' }];
  const m = loadMain({ settings, elevate: true });
  await m.ready();

  // הפעלת החסימה קודם
  let st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'netblock');

  // פתיחה עם סיסמה — "פתוח עד המעבר הבא" (הארגומנט הראשון הוא ה-event של IPC)
  const res = await m.ipcHandlers.get('unlock:now')({}, '1234');
  assert.equal(res.ok, true);
  st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'allowed', 'לאחר פתיחה — הרשת פתוחה');
  // חוק הרשת הוסר
  const del = m.state.execCalls.find((c) => c.cmd === 'netsh' && c.args.includes('delete'));
  assert.ok(del, 'פתיחת האינטרנט מסירה את חוק חומת האש');
  m.cleanup();
});

/* ================= סריקת תוכנות תורניות מותקנות ================= */

test('allowed-apps:detect — מוצא תוכנות מוכרות מהסריקה (App Paths, רישום התקנה, קיצורי דרך) עם דה-דופליקציה', async () => {
  // בידוד מנתיבי ההתקנה האמיתיים של המחשב — כדי שהבדיקה תהיה דטרמיניסטית
  const pf = process.env.ProgramFiles, pfx = process.env['ProgramFiles(x86)'], la = process.env.LOCALAPPDATA, sd = process.env.SystemDrive;
  process.env.ProgramFiles = 'C:\\__bhz_test_progfiles';
  process.env['ProgramFiles(x86)'] = 'C:\\__bhz_test_progfiles_x86';
  process.env.LOCALAPPDATA = 'C:\\__bhz_test_localappdata';
  process.env.SystemDrive = 'Z:';
  const m = loadMain({
    exec: (cmd, args) => {
      const joined = String(args.join(' '));
      if (cmd === 'powershell.exe' && joined.includes('ConvertTo-Json')) {
        const dir = path.join(m.tmpRoot, 'detect');
        fs.mkdirSync(dir, { recursive: true });
        const word = path.join(dir, 'WINWORD.EXE');
        const otz = path.join(dir, 'otzaria.exe');
        const zay = path.join(dir, 'Zayit.exe');
        const excel = path.join(dir, 'EXCEL.EXE'); // תוכנת Office אחרת — לא וורד
        fs.writeFileSync(word, 'MZ');
        fs.writeFileSync(otz, 'MZ');
        fs.writeFileSync(zay, 'MZ');
        fs.writeFileSync(excel, 'MZ');
        return {
          err: null,
          stdout: JSON.stringify({
            appPaths: [word, excel],
            uninstall: [
              { name: 'אוצריא', location: dir, icon: '' },
              { name: 'Otzaria', location: dir, icon: '' },
              { name: 'Zayit', location: '', icon: '"' + zay + '",0' },
              // שם תואם אבל מיקום הוא קובץ של תוכנת Office אחרת — לא וורד
              { name: 'Microsoft Office', location: excel, icon: '' },
              { name: 'תוכנה אחרת', location: 'C:\Program Files\Other', icon: '' }
            ],
            shortcuts: [zay, excel, 'C:\Program Files\launcher.exe']
          }),
          stderr: ''
        };
      }
      return { err: null, stdout: '', stderr: '' };
    }
  });
  await m.ready();
  const res = await m.ipcHandlers.get('allowed-apps:detect')();
  assert.equal(res.ok, true);
  assert.equal(res.apps.length, 3, 'שלוש תוכנות מוכרות נמצאו (word, otzaria, zayit)');
  const apps = res.apps.map((a) => a.id + '|' + a.path.toLowerCase());
  assert.ok(apps.some((s) => s.startsWith('word|')), 'וורד נמצאה דרך App Paths');
  assert.equal(apps.filter((s) => s.startsWith('otzaria|')).length, 1, 'אוצריא מופיעה פעם אחת בלבד (דה-דופליקציה)');
  assert.ok(apps.some((s) => s.startsWith('zayit|')), 'זית נמצאה דרך האייקון/קיצור הדרך');
  process.env.ProgramFiles = pf; process.env['ProgramFiles(x86)'] = pfx; process.env.LOCALAPPDATA = la; process.env.SystemDrive = sd;
  m.cleanup();
});

test('allowed-apps:detect recognizes Otzaria and Otzar executable names from registry paths', async () => {
  const sd = process.env.SystemDrive;
  process.env.SystemDrive = 'Z:';
  const m = loadMain({
    exec: (cmd, args) => {
      if (cmd === 'powershell.exe' && String(args.join(' ')).includes('ConvertTo-Json')) {
        const dir = path.join(m.tmpRoot, 'known-apps');
        fs.mkdirSync(dir, { recursive: true });
        const otzaria = path.join(dir, 'otzaria.exe');
        const otzar = path.join(dir, 'otzar.exe');
        fs.writeFileSync(otzaria, 'MZ');
        fs.writeFileSync(otzar, 'MZ');
        return {
          err: null,
          stdout: JSON.stringify({ appPaths: [otzaria, otzar], uninstall: [], shortcuts: [] }),
          stderr: ''
        };
      }
      return { err: null, stdout: '', stderr: '' };
    }
  });
  await m.ready();
  const res = await m.ipcHandlers.get('allowed-apps:detect')();
  assert.equal(res.ok, true);
  assert.ok(res.apps.some((a) => a.id === 'otzaria' && /otzaria\.exe$/i.test(a.path)));
  assert.ok(res.apps.some((a) => a.id === 'otzar' && /otzar\.exe$/i.test(a.path)));
  m.cleanup();
  process.env.SystemDrive = sd;
});

test('allowed-apps:detect — ללא תוכנות מותקנות מחזיר רשימה ריקה', async () => {
  const pf = process.env.ProgramFiles, pfx = process.env['ProgramFiles(x86)'], la = process.env.LOCALAPPDATA, sd = process.env.SystemDrive;
  process.env.ProgramFiles = 'C:\\__bhz_test_progfiles';
  process.env['ProgramFiles(x86)'] = 'C:\\__bhz_test_progfiles_x86';
  process.env.LOCALAPPDATA = 'C:\\__bhz_test_localappdata';
  process.env.SystemDrive = 'Z:';
  const m = loadMain({
    exec: (cmd, args) => {
      if (cmd === 'powershell.exe' && String(args.join(' ')).includes('ConvertTo-Json')) {
        return { err: null, stdout: JSON.stringify({ appPaths: [], uninstall: [], shortcuts: [] }), stderr: '' };
      }
      return { err: null, stdout: '', stderr: '' };
    }
  });
  await m.ready();
  const res = await m.ipcHandlers.get('allowed-apps:detect')();
  assert.equal(res.ok, true);
  assert.deepEqual(res.apps, []);
  process.env.ProgramFiles = pf; process.env['ProgramFiles(x86)'] = pfx; process.env.LOCALAPPDATA = la; process.env.SystemDrive = sd;
  m.cleanup();
});

test('allowed-apps:inspect-path — מחזיר רשומת אימות מלאה לתוכנה חתומה', async () => {
  const hash = 'a'.repeat(64);
  const m = loadMain({
    exec: (cmd, args) => {
      const joined = String(args.join(' '));
      if (cmd === 'powershell.exe' && joined.includes('Get-AuthenticodeSignature')) {
        return {
          err: null,
          stdout: 'Microsoft Office|Valid|CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US|' + hash.toUpperCase() + '\r\n',
          stderr: ''
        };
      }
      return { err: null, stdout: '', stderr: '' };
    }
  });
  const p = path.join(m.tmpRoot, 'detect2', 'WINWORD.EXE');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'MZ');
  await m.ready();
  const res = await m.ipcHandlers.get('allowed-apps:inspect-path')(null, p);
  assert.equal(res.canceled, false);
  assert.equal(res.mode, 'publisher');
  assert.equal(res.publisher, 'Microsoft Corporation');
  assert.equal(res.product, 'Microsoft Office');
  assert.equal(res.hash, hash);
  assert.equal(res.name, 'WINWORD');
  m.cleanup();
});

test('allowed-apps:inspect-path — קובץ לא קיים מחזיר שגיאה', async () => {
  const m = loadMain({});
  await m.ready();
  const res = await m.ipcHandlers.get('allowed-apps:inspect-path')(null, 'C:\no\such\file.exe');
  assert.equal(res.ok, false);
  m.cleanup();
});

/* ================= עדכניות ההגדרות: מקור אמת משותף + שאריות "פתוח עד המעבר הבא" =================
   קובץ משותף קיים הוא מקור האמת ב-Windows; קובץ משתמש אינו יכול להחליף
   אותו לפי mtime, כדי למנוע עקיפת מדיניות באמצעות settings.json מקומי. */

test('loadSettings: קובץ משותף גובר על קובץ משתמש חדש יותר', async () => {
  // קובץ המשתמש (לוח ריק) נכתב על ידי loadMain
  const m = loadMain({ settings: S.defaultSchedule() });
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  // הקובץ המשותף מכיל את מדיניות החסימה, גם אם קובץ המשתמש חדש יותר.
  const canonical = S.defaultSchedule();
  canonical.week[2].slots.push({ start: S.parseHM('23:50'), end: S.parseHM('24:00'), type: 'blocked' });
  fs.writeFileSync(path.join(machineDir, 'settings.json'), JSON.stringify(canonical), 'utf8');
  fs.utimesSync(path.join(machineDir, 'settings.json'), new Date('2020-01-01'), new Date('2020-01-01'));

  await m.ready();
  const back = await m.ipcHandlers.get('settings:get')();
  assert.equal(back.week[2].slots.length, 1, 'הקובץ המשותף הוא מקור האמת');
  m.cleanup();
});

test('loadSettings: קובץ משותף עדכני יותר גובר על קובץ משתמש ישן', async () => {
  const cfgSettings = S.defaultSchedule();
  cfgSettings.week[2].slots.push({ start: S.parseHM('23:50'), end: S.parseHM('24:00'), type: 'blocked' });
  const m = loadMain({ settings: cfgSettings });
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  // הקובץ המשותף נכתב אחרון — הוא העדכני והמנצח
  const fresh = S.defaultSchedule();
  fs.writeFileSync(path.join(machineDir, 'settings.json'), JSON.stringify(fresh), 'utf8');
  fs.utimesSync(path.join(machineDir, 'settings.json'), new Date('2099-01-01'), new Date('2099-01-01'));
  fs.utimesSync(path.join(m.tmpRoot, 'userData', 'settings.json'), new Date('2020-01-01'), new Date('2020-01-01'));

  await m.ready();
  const back = await m.ipcHandlers.get('settings:get')();
  assert.equal(back.week[2].slots.length, 0, 'הקובץ המשותף העדכני (ריק) נבחר');
  m.cleanup();
});

test('accountability: known PIN cannot weaken partner controls without a purpose-bound partner code', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.accountabilityEnabled = true;
  settings.accountabilityEmail = 'partner@example.com';
  settings.accountabilityRequireApproval = true;
  settings.coolOffMinutes = 10;
  const m = loadMain({ settings });
  await m.ready();
  await m.ipcHandlers.get('session:unlock')({}, '1234');
  const proposed = await m.ipcHandlers.get('settings:get')();
  proposed.accountabilityEnabled = false;
  proposed.accountabilityRequireApproval = false;
  proposed.coolOffMinutes = 0;
  const denied = await m.ipcHandlers.get('settings:save')({}, proposed);
  assert.equal(denied.ok, false);
  assert.equal(denied.needPartnerApproval, true);

  let code = null;
  fetchMock = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.purpose === 'settings-change') code = body.token;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  assert.ok((await m.ipcHandlers.get('accountability:request-approval')({}, 'settings-change')).ok);
  assert.match(String(code), /^\d{6}$/);
  const accepted = await m.ipcHandlers.get('settings:save')({}, proposed, code);
  assert.ok(accepted.ok, JSON.stringify(accepted));
  m.cleanup();
});

test('accountability: approval token is invalidated after five wrong attempts', async () => {
  const settings = blockedSettingsWithCoolOff(0);
  settings.accountabilityEnabled = true;
  settings.accountabilityEmail = 'partner@example.com';
  settings.accountabilityRequireApproval = true;
  const m = loadMain({ settings });
  await m.ready();
  let code = null;
  fetchMock = async (_url, opts) => {
    const body = JSON.parse(opts.body); if (body.purpose === 'unlock') code = body.token;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await m.ipcHandlers.get('accountability:request-approval')({}, 'unlock');
  for (let i = 0; i < 5; i++) {
    const bad = await m.ipcHandlers.get('unlock:now')({}, '1234', '000000');
    assert.equal(bad.ok, false);
  }
  const expired = await m.ipcHandlers.get('unlock:now')({}, '1234', code);
  assert.equal(expired.ok, false, 'correct code is unusable after attempt exhaustion');
  assert.equal(expired.needApproval, true);
  m.cleanup();
});

test('loadSettings: elevated managed load silently persists a v1.5.10 config as schema v2', async () => {
  const m = loadMain({ elevate: true });
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  const legacy = {
    version: 1,
    enabled: true,
    mode: 'blocklist',
    blockMessage: 'legacy-preserved',
    allowedApps: [{ name: 'Word', exe: 'C:\\Office\\WINWORD.EXE' }],
    week: [{ day: 0, slots: [{ start: '08:00', end: '09:00', type: 'blocked' }] }]
  };
  const file = path.join(machineDir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(legacy), 'utf8');
  await m.ready();

  const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(migrated.schemaVersion, S.SCHEMA_VERSION);
  assert.equal(migrated.blockMessage, 'legacy-preserved');
  assert.equal(migrated.allowedApps[0].exe, 'C:\\Office\\WINWORD.EXE');
  assert.equal(migrated.week[0].slots[0].start, 480);
  assert.deepEqual(migrated.studyMode, { enabled: false, scope: 'blocked' });
  assert.equal(migrated.accountabilityEnabled, false);
  assert.equal(migrated.fileExplorer.enabled, false);
  m.cleanup();
});

test('loadSettings: שארית "פתוח עד המעבר הבא" מנוקה כשהלוח כבר לא חוסם', async () => {
  const settings = S.defaultSchedule();
  settings.manualUnlockUntil = new Date(2099, 0, 1).getTime(); // שארית מלוח שנמחק
  const m = loadMain({ settings });
  await m.ready();
  const back = await m.ipcHandlers.get('settings:get')();
  assert.equal(back.manualUnlockUntil, null, 'שארית הפתיחה מנוקה — אין לוח שחסום');
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.nextAt, null, 'אין "המעבר הבא" פנטום');
  m.cleanup();
});

// לוח חסום סביב הרגע הנוכחי (עם טיפול בחצות) — לבדיקות תלויות זמן
function blockNowSchedule() {
  const s = S.defaultSchedule();
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  s.week[now.getDay()].slots.push({
    start: (mins + 1380) % 1440, // שעה לפני עכשיו
    end: (mins + 60) % 1440,     // שעה אחרי עכשיו
    type: 'blocked'
  });
  return s;
}

test('settings:save: פתיחה "עד המעבר הבא" לא מתבטלת בשמירה קוסמטית ומתעדכנת לפי לוח חדש', async () => {
  const settings = blockNowSchedule(); // חסום כרגע
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  // פתיחה "עד המעבר הבא" מתוך מסך החסימה (unlock:now) + כניסה להגדרות
  const ul = await m.ipcHandlers.get('unlock:now')({}, '1234');
  assert.ok(ul.ok);
  await m.ipcHandlers.get('session:unlock')({}, '1234');

  const st1 = await m.ipcHandlers.get('status:get')();
  assert.equal(st1.state, 'allowed', 'פתוח עד המעבר הבא');
  assert.ok(st1.secondsUntilNext > 0);
  const unlockUntil = st1.nextAt.getTime();

  // שינוי קוסמטי (ערכת נושא) — בלי שינוי לוח: הפתיחה לא מתבטלת
  const data = await m.ipcHandlers.get('settings:get')();
  data.theme = 'dark';
  const res = await m.ipcHandlers.get('settings:save')({}, data);
  assert.ok(res.ok);
  const st2 = await m.ipcHandlers.get('status:get')();
  assert.equal(st2.nextAt.getTime(), unlockUntil, 'שמירה בלי שינוי לוח שומרת על הפתיחה');

  // מחיקת כל החלונות — הפתיחה מתבטלת: אין יותר לוח שחסום,
  // ומונעים "המעבר הבא" פנטום
  const data2 = await m.ipcHandlers.get('settings:get')();
  data2.week.forEach((d) => { d.slots = []; });
  const res2 = await m.ipcHandlers.get('settings:save')({}, data2);
  assert.ok(res2.ok);
  const back = await m.ipcHandlers.get('settings:get')();
  assert.equal(back.manualUnlockUntil, null, 'מחיקת החלונות מסירה את הפתיחה');
  const st3 = await m.ipcHandlers.get('status:get')();
  assert.equal(st3.state, 'allowed');
  assert.equal(st3.nextAt, null, 'אין "המעבר הבא" פנטום אחרי מחיקת החלונות');
  m.cleanup();
});

/* ================= פתיחה \"עד המעבר הבא\" כשאין מעבר (התר ריק) ================= */

// באג אמיתי מהשטח: מצב \"התר\" עם לוח ריק = חסום תמיד. פתיחה עם סיסמה נתנה
// \"נפתח\" אבל מסך החסימה נשאר — כי הקוד שמר ערך manualUnlockUntil ישן שכבר
// עבר במקום לתת חלון פתיחה רענן, והאכיפה המשיכה לראות את החסימה.
test('unlock:now: \"התר\" ריק עם שארית פתיחה שעברה — פתיחה רעננה נפתחת בפועל', async () => {
  const settings = S.defaultSchedule();
  settings.mode = 'allowlist'; // חסום תמיד
  settings.pinHash = S.sha256Hex('1234');
  settings.manualUnlockUntil = new Date(2000, 0, 1).getTime(); // שארית ישנה שכבר עברה
  const m = loadMain({ settings });
  await m.ready();

  const before = await m.ipcHandlers.get('status:get')();
  assert.equal(before.state, 'blocked', 'לוח \"התר\" ריק חוסם תמיד');
  assert.equal(before.blockedByDefault, true, 'החסימה לפי ברירת המחדל — מוסברת למסך החסימה');

  const ul = await m.ipcHandlers.get('unlock:now')({}, '1234');
  assert.ok(ul.ok, 'הפתיחה מצליחה');

  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'allowed', 'המחשב פתוח בפועל — לא רק \"הכתוב נפתח\"');
  assert.ok(st.nextAt && st.nextAt.getTime() > Date.now(), 'חלון פתיחה רענן בעתיד');

  const back = await m.ipcHandlers.get('settings:get')();
  assert.ok(back.manualUnlockUntil > Date.now(), 'הערך השמור רענן — לא השארית שעברה');
  m.cleanup();
});

test('unlock:now: \"התר\" ריק בלי שארית — פתיחה נותנת חלון קבוע מעכשיו', async () => {
  const settings = S.defaultSchedule();
  settings.mode = 'allowlist';
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  const ul = await m.ipcHandlers.get('unlock:now')({}, '1234');
  assert.ok(ul.ok);
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'allowed');
  assert.ok(st.nextAt && st.nextAt.getTime() > Date.now() + 30 * 60 * 1000, 'חלון של שעה לפחות');
  m.cleanup();
});

// שארית פתיחה שעברה באתחול היא זבל — אינה פותחת כלום ורק מבלבלת. מנקים.
test('loadSettings: שארית פתיחה שעברה מנוקה באתחול גם כשהלוח חוסם', async () => {
  const settings = blockNowSchedule(); // חסום כרגע לפי חלון
  settings.pinHash = S.sha256Hex('1234');
  settings.manualUnlockUntil = new Date(2000, 0, 1).getTime(); // עבר מזמן
  const m = loadMain({ settings });
  await m.ready();

  const back = await m.ipcHandlers.get('settings:get')();
  assert.equal(back.manualUnlockUntil, null, 'ערך שעבר מנוקה באתחול');
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'blocked', 'הלוח עדיין חוסם');
  m.cleanup();
});

test('settings:save: שארית פתיחה שעברה מנוקה גם בשמירה רגילה', async () => {
  const settings = blockNowSchedule(); // חסום כרגע
  settings.pinHash = S.sha256Hex('1234');
  settings.manualUnlockUntil = new Date(2000, 0, 1).getTime();
  const m = loadMain({ settings });
  await m.ready();

  await m.ipcHandlers.get('session:unlock')({}, '1234');
  const data = await m.ipcHandlers.get('settings:get')();
  data.theme = 'dark';
  const res = await m.ipcHandlers.get('settings:save')({}, data);
  assert.ok(res.ok);
  const back = await m.ipcHandlers.get('settings:get')();
  assert.equal(back.manualUnlockUntil, null, 'שמירה מנקה ערך שעבר');
  m.cleanup();
});

test('startup: future manual unlock is not restored after restart', async () => {
  const settings = blockNowSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.manualUnlockUntil = Date.now() + 60 * 60 * 1000;
  const m = loadMain({ settings });
  await m.ready();
  const back = await m.ipcHandlers.get('settings:get')();
  assert.equal(back.manualUnlockUntil, null, 'Override של Session לא שורד הפעלה מחדש');
  assert.equal((await m.ipcHandlers.get('status:get')()).state, 'blocked');
  m.cleanup();
});

test('allowed-apps:launch rejects a renderer-supplied executable not in the server allowlist', async () => {
  const settings = blockNowSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.allowedApps = [];
  const m = loadMain({ settings });
  await m.ready();
  const res = await m.ipcHandlers.get('allowed-apps:launch')({}, { exe: 'C:\\\\Windows\\\\System32\\\\cmd.exe' });
  assert.equal(res.ok, false);
  assert.match(res.error || '', /רשימת ההרשאות/);
  assert.equal(m.state.spawnCalls.some((call) => String(call.cmd).toLowerCase().includes('cmd.exe')), false, 'אסור להפעיל תהליך שלא אושר בשרת');
  m.cleanup();
});

test('sensitive IPC rejects requests from an unknown renderer sender', async () => {
  const m = loadMain({});
  await m.ready();
  const event = { sender: {} };
  assert.equal((await m.ipcHandlers.get('settings:save')(event, {})).ok, false);
  assert.equal((await m.ipcHandlers.get('status:get')(event)).ok, false);
  assert.equal((await m.ipcHandlers.get('activity:get')(event)).ok, false);
  assert.equal((await m.ipcHandlers.get('update:check')(event)).ok, false);
  assert.equal((await m.ipcHandlers.get('settings:open')(event)).ok, false);
  m.cleanup();
});

test('corrupt shared settings fail closed instead of falling back to a user file', async () => {
  const m = loadMain({ settings: S.defaultSchedule() });
  const dir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{not-json', 'utf8');
  await m.ready();
  const safe = await m.ipcHandlers.get('settings:get')();
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(safe.configError, true);
  assert.equal(st.configError, true);
  assert.equal(st.state, 'blocked');
  m.cleanup();
});

test('protected copy integrity tampering is repaired by the system watchdog', async () => {
  const m = loadMain({ elevate: true });
  const appDir = createAppDir(m);
  await m.ready();
  const pd = protectedDir(m);
  fs.writeFileSync(path.join(pd, 'package.json'), JSON.stringify({ name: 'tampered', version: '9.9.9' }), 'utf8');
  await withSystemWatchdogArg(m, async () => {
    await m.ready();
    const restored = JSON.parse(fs.readFileSync(path.join(pd, 'package.json'), 'utf8'));
    assert.equal(restored.name, 'ben-hazmanim');
    assert.ok(fs.existsSync(path.join(pd, 'integrity.json')), 'ה-Manifest נשאר תקין לאחר השחזור');
  });
  m.cleanup();
});
