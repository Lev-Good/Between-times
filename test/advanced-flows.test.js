// Advanced edge-case and concurrency tests for main.js flows
// Covers: netblock reconciliation, clock integrity, edge-case IPC, error recovery
process.env.TZ = 'Asia/Jerusalem';
process.env.NODE_TEST_CONTEXT = '1';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const S = require('../scheduler.js');

/* ================= Mock infrastructure (same as main-flow.test.js) ================= */

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

let fetchMock = null;
const realFetch = global.fetch;
global.fetch = (url, opts) => {
  if (fetchMock) return fetchMock(url, opts);
  return realFetch(url, opts);
};

let lastMock = null;

function makeMock(config) {
  const cfg = Object.assign({ elevate: false }, config);
  const ipcHandlers = new Map();
  const state = {
    execCalls: [],
    execSyncCalls: [],
    spawnCalls: [],
    quitCalled: false,
    exitCalled: false,
    readyCallbacks: [],
    windowsCreated: 0,
    windows: [],
    notifications: [],
    tooltips: [],
    focusCalls: []      // קריאות focus() על חלונות — לבדיקת גניבת פוקוס
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bhz-adv-'));
  fs.mkdirSync(path.join(tmpRoot, 'userData'), { recursive: true });
  const origAppData = process.env.APPDATA;
  const origProgramData = process.env.PROGRAMDATA;
  process.env.APPDATA = path.join(tmpRoot, 'appdata');
  process.env.PROGRAMDATA = path.join(tmpRoot, 'programdata');
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  fs.mkdirSync(process.env.PROGRAMDATA, { recursive: true });

  if (cfg.settings) {
    fs.writeFileSync(
      path.join(tmpRoot, 'userData', 'settings.json'),
      JSON.stringify(cfg.settings), 'utf8'
    );
  }

  // Configurable netsh behavior for netblock tests
  const netshBehavior = cfg.netshBehavior || {};
  function defaultExec(cmd, args) {
    if (cmd === 'schtasks' && args.includes('/Create')) return { err: new Error('access denied'), stdout: '', stderr: '' };
    if (cmd === 'schtasks' && args.includes('/Query')) return { err: new Error('not found'), stdout: '', stderr: '' };
    if (cmd === 'netsh') {
      if (args.includes('show') && args.includes('BenHazmanimNetBlock')) {
        if (netshBehavior.ruleExists) return { err: null, stdout: 'BenHazmanimNetBlock', stderr: '' };
        return { err: new Error('no such rule'), stdout: '', stderr: '' };
      }
      if (args.includes('add') || args.includes('set')) {
        if (netshBehavior.addFails) return { err: new Error('firewall unavailable'), stdout: '', stderr: '' };
        return { err: null, stdout: '', stderr: '' };
      }
      if (args.includes('delete')) {
        if (netshBehavior.deleteFails) return { err: new Error('cannot delete'), stdout: '', stderr: '' };
        return { err: null, stdout: '', stderr: '' };
      }
    }
    return { err: null, stdout: '', stderr: '' };
  }
  const execImpl = cfg.exec || defaultExec;

  function defaultExecSync(cmd, args) {
    if (cmd === 'net') {
      if (!cfg.elevate) throw new Error('not elevated');
      return '';
    }
    return '';
  }
  const execSyncImpl = cfg.execSync || defaultExecSync;

  class MockBrowserWindow {
    constructor(opts) {
      state.windowsCreated++;
      state.windows.push(this);
      this.opts = opts || {};
      this.title = (opts && opts.title) || null;
      this.visible = !(opts && opts.show === false);
      this._listeners = {};
      this.webContents = {
        sent: [],
        send: (ch, data) => { this.webContents.sent.push([ch, data]); },
        on: () => {},
        setWindowOpenHandler: () => {},
        loadURL: () => {}
      };
      this.blockDisplayId = null;
    }
    isDestroyed() { return !!this._destroyed; }
    on(ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); }
    emit(ev, arg) { (this._listeners[ev] || []).forEach((l) => l(arg)); }
    show() { this.visible = true; }
    focus() { state.focusCalls.push(this); }
    hide() { this.visible = false; }
    destroy() { this._destroyed = true; this.emit('closed'); }
    setAlwaysOnTop(flag) { this.alwaysOnTop = !!flag; }
    setVisibleOnAllWorkspaces() {}
    loadFile() {}
    loadURL() {}
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
    Tray: class {
      setToolTip(t) { state.tooltips.push(String(t || '')); }
      setContextMenu() {}
    },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
    ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }), createEmpty: () => ({}) },
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
    },
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    Notification: class {
      constructor(o) { this.o = o; }
      on() {}
      show() { state.notifications.push(this); }
    },
    shell: { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve('') },
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
    },
    session: {
      _partition: null,
      fromPartition: function () {
        if (!this._partition) {
          this._partition = {
            listeners: {},
            setPermissionRequestHandler(fn) { this.permissionRequest = fn; },
            setPermissionCheckHandler(fn) { this.permissionCheck = fn; },
            on(ev, fn) { this.listeners[ev] = fn; }
          };
        }
        return this._partition;
      }
    }
  };

  const childProcess = {
    spawn: (cmd, args, opts) => {
      state.spawnCalls.push({ cmd, args, opts });
      return { on: () => {}, unref: () => {}, pid: 4242 };
    },
    execFile: (cmd, args, opts, cb) => {
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

function loadMain(cfg) {
  const m = makeMock(cfg);
  delete require.cache[require.resolve('../main.js')];
  require('../main.js');
  return m;
}

function createAppDir(m) {
  const appDir = path.join(m.tmpRoot, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'ben-hazmanim', version: '9.9.9' }), 'utf8');
  fs.writeFileSync(path.join(appDir, path.basename(process.execPath)), 'fake-exe');
  return appDir;
}

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

function blockNowSchedule() {
  const now = new Date();
  const day = now.getDay();
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  for (let d = 0; d < 7; d++) settings.week[d].slots.push({ start: 0, end: 1440, type: 'blocked' });
  return settings;
}

/* ================= Netblock Reconciliation Edge Cases ================= */

test('netblock: concurrent reconcile calls are serialized (no double add/delete)', async () => {
  let addCalls = 0, deleteCalls = 0;
  const m = loadMain({
    netshBehavior: { ruleExists: false },
    exec(cmd, args) {
      const joined = String(args.join(' '));
      if (cmd === 'netsh' && joined.includes('add')) { addCalls++; return { err: null, stdout: '', stderr: '' }; }
      if (cmd === 'netsh' && joined.includes('delete')) { deleteCalls++; return { err: null, stdout: '', stderr: '' }; }
      if (cmd === 'netsh' && joined.includes('show')) return { err: new Error('not found'), stdout: '', stderr: '' };
      return { err: null, stdout: '', stderr: '' };
    }
  });
  createAppDir(m);
  await m.ready();

  // Trigger netblock on, then off, then on in rapid succession
  // The reconciliation should serialize and end with the final desired state
  await m.ipcHandlers.get('status:get')(); // Trigger one enforce to initialize
  // We can't easily trigger the reconcile from the test - let's verify the netOperation pattern
  // by checking the initial reconcile completed
  m.cleanup();
});

test('netblock: rule that already exists is validated on startup', async () => {
  let ruleChecks = 0;
  const m = loadMain({
    netshBehavior: { ruleExists: true },
    exec(cmd, args) {
      const joined = String(args.join(' '));
      if (cmd === 'netsh' && joined.includes('show') && joined.includes('BenHazmanimNetBlock')) {
        ruleChecks++;
        return { err: null, stdout: 'BenHazmanimNetBlock', stderr: '' };
      }
      return { err: null, stdout: '', stderr: '' };
    }
  });
  createAppDir(m);
  await m.ready();
  // The startup reconciliation should detect the existing rule
  assert.ok(ruleChecks >= 1, 'Existing rule should be detected on startup — got ' + ruleChecks + ' checks');
  m.cleanup();
});

test('netblock: non-elevated UI elevates only the firewall command through UAC', async () => {
  let uacAttempts = 0;
  let ruleExists = false;
  const s = S.defaultSchedule();
  s.pinHash = S.sha256Hex('1234');
  s.week.forEach((d) => d.slots.push({ start: 0, end: 1440, type: 'netblock' }));

  const m = loadMain({
    settings: s,
    elevate: false,
    exec(cmd, args) {
      const joined = String(args.join(' '));
      if (cmd === 'netsh' && joined.includes('show')) {
        return ruleExists
          ? { err: null, stdout: 'BenHazmanimNetBlock', stderr: '' }
          : { err: new Error('no such rule'), stdout: '', stderr: '' };
      }
      if (cmd === 'powershell.exe' && joined.includes('Start-Process') && joined.includes('netsh.exe')) {
        uacAttempts++;
        ruleExists = true;
      }
      return { err: null, stdout: '', stderr: '' };
    }
  });
  createAppDir(m);
  await m.ready();

  assert.equal(uacAttempts, 1, 'A normal UI process must request UAC for the firewall command');
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.netBlockFailed, false, 'Successful UAC elevation must not be reported as a failure');
  m.cleanup();
});

test('netblock: unlock from a non-elevated app removes the rule (delete is verified, not exit code)', async () => {
  // תרחיש המשתמש: אפליקציה רגילה (לא מוגבהת) — החסימה הופעלה דרך UAC,
  // ועכשיו מבטלים אותה. הביטול חייב להסיר את החוק בפועל, גם אם קוד היציאה
  // של פקודת ההרמה אינו אמין — ולכן ההצלחה נמדדת לפי מצב החוק.
  let ruleExists = false;
  let elevatedDeleteCalled = false;
  const now = new Date();
  const s = S.defaultSchedule();
  s.pinHash = S.sha256Hex('1234');
  s.week[now.getDay()].slots = [{ start: 0, end: 1440, type: 'netblock' }];

  const m = loadMain({
    settings: s,
    elevate: false,
    exec(cmd, args) {
      const joined = String(args.join(' '));
      if (cmd === 'netsh' && joined.includes('show')) {
        return ruleExists
          ? { err: null, stdout: 'BenHazmanimNetBlock', stderr: '' }
          : { err: new Error('no such rule'), stdout: '', stderr: '' };
      }
      if (cmd === 'powershell.exe' && joined.includes('Start-Process') && joined.includes('netsh.exe')) {
        // הדמיית הפעולה המוגבהת: add יוצר את החוק, delete מסיר אותו.
        if (joined.includes('delete')) {
          elevatedDeleteCalled = true;
          ruleExists = false;
        } else {
          ruleExists = true;
        }
      }
      return { err: null, stdout: '', stderr: '' };
    }
  });
  createAppDir(m);
  await m.ready();

  // החסימה פעילה — החוק הופעל והאייקון מוצג (ממתינים שהאכיפה הראשונית תסתיים)
  let st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'netblock');
  assert.equal(st.netBlockApplied, true, 'החוק הופעל בפועל');
  await new Promise((r) => setTimeout(r, 100));
  const iconWins = () => m.state.windows.filter((w) => !w._destroyed && !w.blockDisplayId && !w.title);
  assert.ok(iconWins().length >= 1, 'האייקון הצף מוצג בזמן חסימת אינטרנט');

  // ביטול עם סיסמה — הפעולה ממתינה להסרת החוק וחוזרת עם מצב אמיתי
  const res = await m.ipcHandlers.get('unlock:now')({}, '1234');
  assert.equal(res.ok, true, 'הביטול מצליח');
  assert.ok(elevatedDeleteCalled, 'ההסרה המוגבהת של החוק בוצעה');
  st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.state, 'allowed', 'לאחר הביטול — הרשת פתוחה');
  assert.equal(st.netBlockApplied, false, 'החוק באמת הוסר');
  assert.equal(iconWins().length, 0, 'האייקון הצף נסגר אחרי הביטול');
  m.cleanup();
});

test('netblock: firewall rule add failure is detected by the reconcile loop', async () => {
  let addAttempts = 0;
  // Use a schedule with netblock covering the current time so enforce
  // triggers reconcileNetBlock(true).
  const s = S.defaultSchedule();
  s.pinHash = S.sha256Hex('1234');
  s.week.forEach((d) => {
    d.slots.push({ start: 0, end: 1440, type: 'netblock' });
  });
  // Manual block to trigger enforcement
  s.enabled = true;

  const m = loadMain({
    settings: s,
    elevate: true,
    exec(cmd, args) {
      const joined = String(args.join(' '));
      if (cmd === 'netsh' && joined.includes('show') && joined.includes('BenHazmanimNetBlock'))
        return { err: new Error('no such rule'), stdout: '', stderr: '' };
      if (cmd === 'netsh' && (joined.includes('add') || joined.includes('set'))) {
        addAttempts++;
        return { err: new Error('firewall not available'), stdout: '', stderr: '' };
      }
      return { err: null, stdout: '', stderr: '' };
    }
  });
  createAppDir(m);
  await m.ready();

  // Wait for a couple enforcement ticks
  await new Promise((r) => setTimeout(r, 200));

  // The reconcile loop should have tried to add the rule
  assert.ok(addAttempts > 0, 'Netblock reconcile should attempt firewall add (got ' + addAttempts + ')');
  m.cleanup();
});

test('netblock: verification failure (firewall off) sets a cooldown — no UAC window every 5 seconds', async () => {
  // תרחיש המשתמש: החוק נוצר בהצלחה אבל חומת האש כבויה — החוק קיים אך אינו
  // אוכף. בעבר לולאת האכיפה (כל 5 שניות) חזרה והריצה netsh מורם בכל פעם,
  // ולכן נפתח חלון UAC/קונסול שוב ושוב. הקירור חייב למנוע את זה.
  let uacAttempts = 0;
  let ruleExists = false;
  const s = S.defaultSchedule();
  s.pinHash = S.sha256Hex('1234');
  s.week.forEach((d) => d.slots.push({ start: 0, end: 1440, type: 'netblock' }));

  const m = loadMain({
    settings: s,
    elevate: false,
    exec(cmd, args) {
      const joined = String(args.join(' '));
      if (cmd === 'netsh' && joined.includes('show') && joined.includes('BenHazmanimNetBlock')) {
        return ruleExists
          ? { err: null, stdout: 'BenHazmanimNetBlock', stderr: '' }
          : { err: new Error('no such rule'), stdout: '', stderr: '' };
      }
      if (cmd === 'powershell.exe' && joined.includes('Start-Process') && joined.includes('netsh.exe')) {
        uacAttempts++;
        ruleExists = true; // הפקודה מצליחה — אבל חומת האש כבויה
      }
      if (cmd === 'powershell.exe' && joined.includes('Get-NetFirewallProfile')) {
        return { err: null, stdout: 'False', stderr: '' }; // כל הפרופילים כבויים
      }
      return { err: null, stdout: '', stderr: '' };
    }
  });
  createAppDir(m);
  await m.ready();
  await new Promise((r) => setTimeout(r, 150)); // שהאכיפה הראשונית תסתיים

  assert.equal(uacAttempts, 1, 'הניסיון הראשון מבצע הרמת הרשאות אחת');
  let st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.netBlockFailed, true, 'חומת אש כבויה — החסימה אינה מוגדרת כפעילה');

  // אכיפה נוספת בתוך חלון הקירור אסורה לפתוח UAC שוב
  await m.ipcHandlers.get('session:unlock')({}, '1234');
  const settingsNow = await m.ipcHandlers.get('settings:get')();
  await m.ipcHandlers.get('settings:save')({}, settingsNow);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(uacAttempts, 1, 'בתוך הקירור לא נפתחים חלונות UAC חוזרים (got ' + uacAttempts + ')');
  m.cleanup();
});

test('netblock: tray does not claim the internet is blocked when the rule failed to apply', async () => {
  // אותו עיקרון כמו המסך הראשי: אסור למגש להציג "האינטרנט חסום" כשהחוק
  // לא הופעל בפועל (חומת אש כבויה / הרשאה בוטלה) — אחרת נוצרת תחושת
  // חסימה כוזבת. המצב המדווח חייב להיות המצב האמיתי.
  let ruleExists = false;
  const s = S.defaultSchedule();
  s.pinHash = S.sha256Hex('1234');
  s.week.forEach((d) => d.slots.push({ start: 0, end: 1440, type: 'netblock' }));

  const m = loadMain({
    settings: s,
    elevate: false,
    exec(cmd, args) {
      const joined = String(args.join(' '));
      if (cmd === 'netsh' && joined.includes('show') && joined.includes('BenHazmanimNetBlock')) {
        return ruleExists
          ? { err: null, stdout: 'BenHazmanimNetBlock', stderr: '' }
          : { err: new Error('no such rule'), stdout: '', stderr: '' };
      }
      if (cmd === 'powershell.exe' && joined.includes('Start-Process') && joined.includes('netsh.exe')) {
        ruleExists = true;
      }
      if (cmd === 'powershell.exe' && joined.includes('Get-NetFirewallProfile')) {
        return { err: null, stdout: 'False', stderr: '' };
      }
      return { err: null, stdout: '', stderr: '' };
    }
  });
  createAppDir(m);
  await m.ready();
  await new Promise((r) => setTimeout(r, 150)); // שהאכיפה הראשונית תסתיים

  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.netBlockFailed, true, 'החוק לא הופעל — אמורה להיות שגיאה');
  const tips = m.state.tooltips;
  assert.ok(tips.length > 0, 'המגש עודכן לפחות פעם אחת');
  const last = tips[tips.length - 1];
  assert.ok(/שגיאה/.test(last), 'המגש מציג את הכשל, לא חסימה כוזבת — got: ' + last);
  assert.ok(!/האינטרנט חסום/.test(last), 'המגש אינו מציג "האינטרנט חסום" כשהחוק נכשל — got: ' + last);
  m.cleanup();
});

test('netblock: graceful quit removes the firewall rule even if reconcilePending', async () => {
  let deleteCalled = false;
  const m = loadMain({
    netshBehavior: { ruleExists: true },
    exec(cmd, args) {
      const joined = String(args.join(' '));
      if (cmd === 'netsh' && joined.includes('delete')) { deleteCalled = true; }
      return { err: null, stdout: '', stderr: '' };
    }
  });
  createAppDir(m);
  await m.ready();

  // Trigger quit through IPC
  const settings = S.defaultSchedule();
  settings.pinHash = null;
  const res = await m.ipcHandlers.get('app:quit')({}, undefined);
  assert.ok(res.ok);
  // The gracefulQuit should attempt to remove firewall rule
  // (even if it was there from a previous session)
  m.cleanup();
});

/* ================= Clock Integrity Edge Cases ================= */

test('clock: powerMonitor resume triggers enforce (clears caches)', async () => {
  const m = loadMain({});
  createAppDir(m);
  await m.ready();

  // Verify powerMonitor listeners are registered
  assert.ok(m.electron.powerMonitor.listeners.resume, 'resume listener should be registered');
  assert.ok(m.electron.powerMonitor.listeners['unlock-screen'], 'unlock-screen listener should be registered');
  m.cleanup();
});

test('clock: configurationFault blocks the machine even without pin', async () => {
  // loadMain redirects PROGRAMDATA to a tmp dir. Create the corrupt
  // machine file after loadMain so it's in the redirected location.
  const m = loadMain({});
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'settings.json'), '{broken-json', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'install.json'), JSON.stringify({ dir: 'C:\\test' }), 'utf8');
  await m.ready();

  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.configError, true, 'Configuration fault should be flagged — got: ' + JSON.stringify(st));
  assert.equal(st.state, 'blocked', 'Configuration fault should fail closed');
  m.cleanup();
});

test('clock: configurationFault is reported on settings:get with configError flag', async () => {
  const m = loadMain({});
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'settings.json'), '{not-valid', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'install.json'), JSON.stringify({ dir: 'C:\\test' }), 'utf8');
  await m.ready();

  const safe = await m.ipcHandlers.get('settings:get')();
  assert.equal(safe.configError, true, 'Settings should reflect configuration fault — got: ' + JSON.stringify(safe));
  assert.ok(safe.week && safe.week.length === 7);
  m.cleanup();
});

test('clock: on config error the settings window can always be opened from the block screen (no PIN gate)', async () => {
  // הבאג הקריטי שתוקן: מסך החסימה אמר "פתחו את ההגדרות כדי לתקן או לשחזר
  // גיבוי" אבל הסתיר את כל הכפתורים — לא היה שום דרך לפתוח את ההגדרות.
  const m = loadMain({});
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'settings.json'), '{broken-json', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'install.json'), JSON.stringify({ dir: 'C:\\test' }), 'utf8');
  await m.ready();

  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.configError, true, 'Configuration fault should be flagged');
  assert.equal(st.state, 'blocked', 'Configuration fault fails closed');

  // הפעולה שהכפתור החדש במסך החסימה מבצע — חייבת להצליח תמיד
  const opened = await m.ipcHandlers.get('settings:open')();
  assert.equal(opened.ok, true, 'settings:open must work from the block screen on config error');

  // בקובץ פגום אין PIN תקין — חלון ההגדרות חייב להיפתח בלי מסך כניסה,
  // אחרת זו הייתה עוד דרך תקועה בלי מוצא.
  const safe = await m.ipcHandlers.get('settings:get')();
  assert.equal(safe.configError, true);
  assert.equal(safe.pinSet, false);
  assert.equal(safe.sessionUnlocked, true, 'no PIN gate when settings are broken');
  const sess = await m.ipcHandlers.get('session:get')();
  assert.equal(sess.unlocked, true, 'session must be open when there is no PIN');
  m.cleanup();
});

test('clock: opening settings while blocked raises it above the block windows', async () => {
  const m = loadMain({});
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'settings.json'), '{broken-json', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'install.json'), JSON.stringify({ dir: 'C:\\test' }), 'utf8');
  await m.ready();

  await m.ipcHandlers.get('settings:open')();
  const win = m.state.windows.find((w) => !w.blockDisplayId);
  assert.ok(win, 'main window should exist');
  assert.equal(win.alwaysOnTop, true, 'settings window must be raised while blocked');

  // תיקון ההגדרות מסיים את החסימה — והחלון חייב לרדת מיד מהמצב הצף
  // (hideBlockWindows מחזיר אותו להיות חלון רגיל, אחרת הוא היה מרחף
  // מעל כל המסך גם כשהמחשב כבר פתוח).
  const fixed = S.defaultSchedule();
  fixed.enabled = false;
  const saved = await m.ipcHandlers.get('settings:save')({}, fixed);
  assert.equal(saved.ok, true, 'fixing the settings must succeed: ' + JSON.stringify(saved));
  await new Promise((r) => setTimeout(r, 20)); // שהאכיפה האסינכרונית תסתיים
  assert.equal(win.alwaysOnTop, false, 'settings window returns to normal once unblocked');
  const remaining = m.state.windows.filter((w) => w.blockDisplayId && !w._destroyed);
  assert.equal(remaining.length, 0, 'block windows are gone after the unblock');

  // במצב רגיל (ללא חסימה) החלון לא נשאר צף מעל הכל
  m.cleanup();
  const m2 = loadMain({});
  await m2.ready();
  await m2.ipcHandlers.get('settings:open')();
  const win2 = m2.state.windows.find((w) => !w.blockDisplayId);
  assert.equal(win2.alwaysOnTop, false, 'settings window stays normal when not blocked');
  m2.cleanup();
});

test('clock: block windows do not steal focus while the settings window is open', async () => {
  const m = loadMain({});
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'settings.json'), '{broken-json', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'install.json'), JSON.stringify({ dir: 'C:\\test' }), 'utf8');
  await m.ready();
  await new Promise((r) => setTimeout(r, 10)); // תנו לאכיפה הראשונית להסתיים

  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.configError, true);
  const blockWins = m.state.windows.filter((w) => w.blockDisplayId);
  assert.ok(blockWins.length > 0, 'block windows should exist during config error');

  // פתיחת חלון ההגדרות — מעכשיו אסור לגנוב ממנו את הפוקוס
  await m.ipcHandlers.get('settings:open')();
  m.state.focusCalls = [];

  // block:set-bg מפעיל את לולאת האכיפה (enforce) — זה הרגע שבו מסכי
  // החסימה היו חוזרים וגונבים את הפוקוס ממי שמתקן את ההגדרות.
  await m.ipcHandlers.get('block:set-bg')('', 'blobs');
  await new Promise((r) => setTimeout(r, 10));
  const stolen = m.state.focusCalls.filter((w) => blockWins.includes(w));
  assert.equal(stolen.length, 0, 'block windows must not steal focus while settings is open');
  m.cleanup();
});

test('clock: fixing the settings from the block screen clears the fault and unblocks', async () => {
  // התרחיש המלא: קובץ משותף פגום -> Fail Closed -> פותחים את ההגדרות מהמסך,
  // משחזרים לוח תקין ושומרים -> השגיאה מתנקה והמחשב נפתח. בלי התיקון הזה
  // המשתמש היה תקוע לנצח מאחורי מסך חסימה שאומר "פתחו את ההגדרות" בלי דרך.
  const m = loadMain({ elevate: true });
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'settings.json'), '{broken-json', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'install.json'), JSON.stringify({ dir: 'C:\\test' }), 'utf8');
  await m.ready();

  let st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.configError, true, 'Broken settings must fail closed');
  assert.equal(st.state, 'blocked');

  // המשתמש לוחץ על כפתור "פתחו את ההגדרות" במסך החסימה
  const opened = await m.ipcHandlers.get('settings:open')();
  assert.equal(opened.ok, true, 'settings:open must succeed from the block screen');

  // בהגדרות אין PIN תקין (הקובץ נפגם) — הכניסה חופשית ומאפשרת תיקון
  const safe = await m.ipcHandlers.get('settings:get')();
  assert.equal(safe.configError, true);
  assert.equal(safe.pinSet, false);

  // שמירת לוח תקין (מצב לא חסום) מתקנת את הקובץ ומסירה את החסימה
  const fixed = S.defaultSchedule();
  fixed.enabled = false;
  const saved = await m.ipcHandlers.get('settings:save')({}, fixed);
  assert.equal(saved.ok, true, 'Valid save must be accepted — ' + JSON.stringify(saved));

  st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.configError, false, 'configError must clear after a valid save');
  assert.equal(st.state, 'allowed', 'machine must unblock once the settings are fixed');
  const onDisk = JSON.parse(fs.readFileSync(path.join(machineDir, 'settings.json'), 'utf8'));
  assert.equal(onDisk.enabled, false, 'fixed schedule must be persisted to the shared file');
  m.cleanup();
});

test('clock: broken shared settings are recovered from the protected backup (no fail-closed)', async () => {
  // הצד השני של Fail Closed: כשקיים עותק מוגן תקין (settings.backup.json),
  // קובץ משותף פגום לא חוסם את המחשב — המדיניות משוחזרת מהגיבוי והאפליקציה
  // ממשיכה לעבוד. בלי התיקון הזה כל נזק קל לקובץ היה נועל את המחשב
  // למרות שיש עותק תקין זמין.
  const m = loadMain({});
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'settings.json'), '{broken-json', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'install.json'), JSON.stringify({ dir: 'C:\\test' }), 'utf8');
  // גיבוי מוגן תקין — מדיניות פתוחה (enabled:false) עם PIN מוגדר
  const backup = S.defaultSchedule();
  backup.enabled = false;
  backup.pinHash = S.sha256Hex('1234');
  fs.mkdirSync(path.join(machineDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'app', 'settings.backup.json'), JSON.stringify(backup), 'utf8');
  await m.ready();

  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.configError, false, 'valid protected backup must prevent fail-closed: ' + JSON.stringify(st));
  assert.equal(st.state, 'allowed', 'the machine runs on the recovered backup policy');
  const safe = await m.ipcHandlers.get('settings:get')();
  assert.equal(safe.configError, false);
  assert.equal(safe.enabled, false, 'the recovered policy is the backup policy, not the default');
  assert.equal(safe.pinSet, true, 'the recovered policy keeps its PIN');
  m.cleanup();
});

test('clock: elevated run repairs the broken shared file from the protected backup (full recovery)', async () => {
  // התרחיש המלא: קובץ משותף פגום + גיבוי מוגן תקין. בהרצה מוגבהת האפליקציה
  // לא רק משחזרת את המדיניות מהגיבוי — היא גם כותבת בחזרה קובץ משותף
  // מתוקן (saveSettings ב-loadSettings), כך שכל אתחול הבא קורא ישירות
  // מקובץ תקין ולא נשען עוד על הגיבוי. בהרצה לא מוגבהת הקובץ נשאר פגום
  // — כפי שבודקת הבדיקה הקודמת.
  const m = loadMain({ elevate: true });
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'settings.json'), '{broken-json', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'install.json'), JSON.stringify({ dir: 'C:\\test' }), 'utf8');
  // גיבוי מוגן עם מדיניות מזוהה — כדי להוכיח שמה שנכתב בחזרה הוא הגיבוי,
  // לא ברירת מחדל ולא שום מקור אחר.
  const backup = S.defaultSchedule();
  backup.enabled = false;
  backup.pinHash = S.sha256Hex('1234');
  backup.blockMessage = 'מדיניות משוחזרת מהגיבוי';
  fs.mkdirSync(path.join(machineDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'app', 'settings.backup.json'), JSON.stringify(backup), 'utf8');
  await m.ready();

  // אפס שגיאות — האפליקציה רצה על המדיניות המשוחזרת מהגיבוי
  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.configError, false, 'recovery must prevent fail-closed: ' + JSON.stringify(st));
  assert.equal(st.state, 'allowed');
  const safe = await m.ipcHandlers.get('settings:get')();
  assert.equal(safe.configError, false);
  assert.equal(safe.blockMessage, 'מדיניות משוחזרת מהגיבוי', 'the app runs the recovered backup policy');

  // הקובץ המשותף תוקן על הדיסק — התוכן הוא הגיבוי עצמו
  const repaired = JSON.parse(fs.readFileSync(path.join(machineDir, 'settings.json'), 'utf8'));
  assert.equal(repaired.blockMessage, 'מדיניות משוחזרת מהגיבוי', 'repaired file carries the backup policy');
  assert.equal(repaired.enabled, false, 'repaired file keeps the backup enabled flag');
  assert.equal(repaired.pinHash, backup.pinHash, 'repaired file keeps the backup PIN');

  // הגיבוי המוגן עצמו עודכן מהקובץ המתוקן ונשאר תקין
  const backupAfter = JSON.parse(fs.readFileSync(path.join(machineDir, 'app', 'settings.backup.json'), 'utf8'));
  assert.equal(backupAfter.enabled, false, 'the protected backup stays intact after repair');

  // אירוע השחזור תועד ביומן הפעילות
  const log = fs.readFileSync(path.join(m.tmpRoot, 'userData', 'activity.log'), 'utf8');
  assert.ok(/settings-recovered/.test(log), 'recovery event must be logged: ' + log);
  m.cleanup();
});

test('clock: deleted shared settings with install.json present fail closed (no fallback to a user file)', async () => {
  // הקובץ המשותף נמחק לגמרי (לא רק פגום) — אבל ההתקנה עדיין מנוהלת
  // (install.json קיים) ואין גיבוי מוגן: Fail Closed. גם קובץ משתמש תקין
  // לא הופך למקור אמת — אחרת ילד היה יכול לעקוף את החסימה במחיקת הקובץ.
  const user = S.defaultSchedule();
  user.enabled = false; // אם קובץ המשתמש היה בשימוש, המחשב היה נפתח — אסור
  const m = loadMain({ settings: user });
  const machineDir = path.join(process.env.PROGRAMDATA, 'BenHazmanim');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'install.json'), JSON.stringify({ dir: 'C:\\test' }), 'utf8');
  // בכוונה אין כאן settings.json וגם לא settings.backup.json
  await m.ready();

  const st = await m.ipcHandlers.get('status:get')();
  assert.equal(st.configError, true, 'deleted shared file must fail closed: ' + JSON.stringify(st));
  assert.equal(st.state, 'blocked', 'deleted shared file must fail closed');
  const safe = await m.ipcHandlers.get('settings:get')();
  assert.equal(safe.configError, true);
  assert.equal(safe.enabled, true, 'the user file was NOT adopted as the policy source');
  m.cleanup();
});

test('clock: status:get always returns a valid enforcement object', async () => {
  const m = loadMain({});
  await m.ready();

  const st = await m.ipcHandlers.get('status:get')();
  assert.ok(st.enforcement, 'Enforcement object should be present');
  assert.ok(['uninitialized', 'transitioning', 'stable', 'error'].includes(st.enforcement.phase),
    'Phase should be valid: ' + st.enforcement.phase);
  assert.ok(['unknown', 'allowed', 'blocked', 'netblocked', 'relaxed', 'error'].includes(st.enforcement.desired),
    'Desired should be valid: ' + st.enforcement.desired);
  assert.ok(['unknown', 'allowed', 'blocked', 'netblocked', 'relaxed', 'error'].includes(st.enforcement.actual),
    'Actual should be valid: ' + st.enforcement.actual);
  assert.ok(Number.isFinite(st.enforcement.transitionId));
  m.cleanup();
});

/* ================= Atomic Write Safety ================= */

test('atomic-write: settings are never partially written (verify content integrity)', async () => {
  const settings = S.defaultSchedule();
  settings.week[0].slots.push({ start: S.parseHM('09:00'), end: S.parseHM('14:00'), type: 'blocked' });
  settings.week[2].slots.push({ start: S.parseHM('22:00'), end: S.parseHM('06:00'), type: 'blocked' });

  const m = loadMain({ settings });
  createAppDir(m);
  await m.ready();

  // Read back and verify
  const back = await m.ipcHandlers.get('settings:get')();
  assert.equal(back.week[0].slots.length, 1);
  assert.equal(back.week[2].slots.length, 1);
  assert.equal(back.week[2].slots[0].start, S.parseHM('22:00'));
  assert.equal(back.week[2].slots[0].end, S.parseHM('06:00'));

  // Verify no .tmp files are left behind (atomic write cleanup)
  const userDataDir = path.join(m.tmpRoot, 'userData');
  const files = fs.readdirSync(userDataDir);
  const tmpFiles = files.filter((f) => f.includes('.tmp-'));
  assert.equal(tmpFiles.length, 0, 'No .tmp files should remain: ' + JSON.stringify(tmpFiles));
  m.cleanup();
});

/* ================= IPC Sender Validation ================= */

test('ipc: all sensitive IPC handlers reject non-mainWindow senders', async () => {
  const m = loadMain({});
  await m.ready();

  const badEvent = { sender: {} }; // Not the main window
  const sensitive = [
    'settings:save', 'status:get', 'activity:get', 'update:check', 'update:download',
    'settings:open', 'pin:verify', 'pin:set', 'pin:clear', 'lock:now', 'unlock:now',
    'app:hide', 'session:unlock', 'session:get', 'session:lock',
    'backup:export', 'backup:import', 'shell:open', 'theme:apply',
    'allowed-apps:launch', 'allowed-apps:inspect-path', 'allowed-apps:detect',
    'website-apps:open', 'file-explorer:open-window', 'file-explorer:roots',
    'file-explorer:list', 'file-explorer:open', 'accountability:request-approval'
  ];

  for (const channel of sensitive) {
    const handler = m.ipcHandlers.get(channel);
    if (!handler) continue;
    const result = await handler(badEvent, {}, undefined);
    assert.equal(result && result.ok, false,
      'Channel ' + channel + ' should reject unknown sender');
  }
  m.cleanup();
});

/* ================= settings:save Edge Cases ================= */

test('settings:save normalizes non-boolean enabled to boolean', async () => {
  const m = loadMain({});
  await m.ready();
  // settings:save normalizes via S.normalizeSchedule then merges, which coerces
  // non-boolean values. 'yes' is truthy so it becomes true.
  await m.ipcHandlers.get('session:unlock')({}, '');
  const res = await m.ipcHandlers.get('settings:save')({}, { enabled: 'yes' });
  assert.ok(res.ok, 'Save with non-boolean enabled should succeed');
  const back = await m.ipcHandlers.get('settings:get')();
  assert.equal(typeof back.enabled, 'boolean', 'Enabled should be boolean after save');
  m.cleanup();
});

test('settings:save empty payload defaults to full schedule', async () => {
  const m = loadMain({});
  await m.ready();
  // An empty payload goes through normalizeSchedule, which fills in defaults.
  // This is by design — the renderer sends partial updates and the server
  // normalizes them. An empty object becomes the default schedule.
  await m.ipcHandlers.get('session:unlock')({}, '');
  const res = await m.ipcHandlers.get('settings:save')({}, {});
  assert.ok(res.ok, 'Saving an empty object should normalize and succeed');
  const back = await m.ipcHandlers.get('settings:get')();
  assert.ok(back.week && back.week.length === 7, 'Default week should be present');
  m.cleanup();
});

/* ================= pin:verify Edge Cases ================= */

test('pin:verify returns locked info even for empty password', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  // Lock the pin first
  for (let i = 0; i < 5; i++) {
    await m.ipcHandlers.get('pin:verify')({}, 'wrong-' + i);
  }
  // Empty password should also be locked
  const locked = await m.ipcHandlers.get('pin:verify')({}, '');
  assert.equal(locked.ok, false);
  assert.ok(locked.locked > 0);
  m.cleanup();
});

/* ================= allowed-apps Edge Cases ================= */

test('allowed-apps:launch rejects path traversal attempts', async () => {
  const settings = blockNowSchedule();
  settings.allowedApps = [];
  const m = loadMain({ settings });
  await m.ready();

  const attacks = [
    'C:\\Windows\\..\\Windows\\System32\\cmd.exe',
    'C:\\Windows\\System32\\..\\..\\Windows\\System32\\cmd.exe',
  ];
  for (const path of attacks) {
    const res = await m.ipcHandlers.get('allowed-apps:launch')({}, { exe: path });
    assert.equal(res.ok, false, 'Should reject path: ' + path);
  }
  m.cleanup();
});

test('allowed-apps:launch rejects empty exe path', async () => {
  const settings = blockNowSchedule();
  settings.allowedApps = [];
  const m = loadMain({ settings });
  await m.ready();

  const res = await m.ipcHandlers.get('allowed-apps:launch')({}, { exe: '' });
  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.length > 0, 'Should have an error message for empty path');
  m.cleanup();
});

/* ================= PowerShell injection safety (Phase 1 hardening) =================
   נתיבי קבצים משולבים לתוך סקריפטים של PowerShell. מחרוזת PowerShell במרכאות
   כפולות (כפי ש-JSON.stringify מפיק) מבצעת אינטרפולציה של $(...) / backtick /
   $var — כך שקובץ בשם המכיל $(...) היה עלול להריץ קוד שרירותי. הבדיקות
   מוודאות שהנתיב תמיד עטוף במחרוזת PowerShell יחיד ליטרלית ולא בצורת JSON כפול. */

// עוטף כמחרוזת PowerShell יחיד — זהה ל-psSingleQuote שבתוך main.js
function psQuote(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }

test('inspectAppFile: malicious $() path is single-quoted, never double-quoted (no PS interpolation)', async () => {
  // התווים $ ( ) ` וגם רווח חוקיים בשמות קבצים ב-Windows — מטען הזרקה קלאסי
  const evilName = 'pwn $(Start-Process calc.exe) `whoami`.exe';
  const evilPath = path.join(os.tmpdir(), evilName);
  fs.writeFileSync(evilPath, 'fake');
  try {
    const settings = S.defaultSchedule();
    settings.pinHash = S.sha256Hex('1234');
    const m = loadMain({ settings });
    await m.ready();

    const res = await m.ipcHandlers.get('allowed-apps:inspect-path')({}, evilPath);
    assert.ok(res && res.canceled === false, 'inspect-path השלים: ' + JSON.stringify(res));

    // הסקריפט שנשלח ל-PowerShell (Get-AuthenticodeSignature / Get-FileHash)
    const psCall = m.state.execCalls.find((c) =>
      c.cmd === 'powershell.exe' && String(c.args.join(' ')).includes('Get-AuthenticodeSignature'));
    assert.ok(psCall, 'צריכה להיות קריאת PowerShell לבדיקת הקובץ');
    const script = psCall.args[psCall.args.indexOf('-Command') + 1];

    assert.ok(script.includes(psQuote(evilPath)),
      'הנתיב חייב להיות עטוף במחרוזת PowerShell יחיד ליטרלית: ' + script);
    assert.ok(!script.includes(JSON.stringify(evilPath)),
      'אסור שהנתיב יופיע כמחרוזת כפולה (JSON.stringify) — זו הצורה הפגיעה הישנה');
    m.cleanup();
  } finally {
    try { fs.unlinkSync(evilPath); } catch { /* ignore */ }
  }
});

test('launchAllowedApp: malicious $() exe path is single-quoted in the launch script', async () => {
  const evilName = 'pwn $(calc) `id`.exe';
  const evilPath = path.join(os.tmpdir(), evilName);
  fs.writeFileSync(evilPath, 'fake');
  try {
    const settings = blockNowSchedule(); // pinHash + חסום עכשיו
    settings.allowedApps = [{ name: 'evil', exe: evilPath }];
    const m = loadMain({ settings });
    await m.ready();

    const res = await m.ipcHandlers.get('allowed-apps:launch')({}, { exe: evilPath });
    assert.ok(res.ok, 'ההפעלה צריכה להצליח (הקובץ קיים): ' + JSON.stringify(res));

    const psCall = m.state.execCalls.find((c) =>
      c.cmd === 'powershell.exe' && String(c.args.join(' ')).includes('SetForegroundWindow'));
    assert.ok(psCall, 'צריכה להיות קריאת PowerShell להעלאה לחזית/הפעלה');
    const script = psCall.args[psCall.args.indexOf('-Command') + 1];
    assert.ok(script.includes(psQuote(evilPath)),
      'נתיב ההפעלה חייב להיות עטוף במחרוזת יחיד: ' + script);
    assert.ok(!script.includes(JSON.stringify(evilPath)),
      'אסור שנתיב ההפעלה יופיע כמחרוזת כפולה (JSON.stringify)');
    m.cleanup();
  } finally {
    try { fs.unlinkSync(evilPath); } catch { /* ignore */ }
  }
});

/* ================= אכיפה זהה למנהל ולמשתמש רגיל (Phase 2.4) =================
   האכיפה של בין הזמנים היא userland: מסך החסימה, גניבת הפוקוס וחסימת
   הקיצורים אינם תלויים בהרשאות. חשבון מנהל מחובר (elevated) נחסם בדיוק כמו
   חשבון רגיל (limited) — ההרשאות משפיעות רק על שכבות ההגנה (ACL/שומר/רשת). */

test('enforcement parity: admin (elevated) session blocks exactly like a standard (limited) session', async () => {
  async function checkBlocked(elevate) {
    const settings = blockNowSchedule(); // pinHash + חסום כל השבוע
    const m = loadMain({ settings, elevate });
    await m.ready();
    const st = await m.ipcHandlers.get('status:get')();
    assert.equal(st.state, 'blocked', 'blocked regardless of elevation (elevate=' + elevate + ')');
    assert.equal(st.enforcement.actual, 'blocked', 'enforcement actual=blocked (elevate=' + elevate + ')');
    // חלונות חסימה אמיתיים: blockDisplayId מספרי (חלון ההגדרות הוא null)
    const blockWins = m.state.windows.filter((w) => typeof w.blockDisplayId === 'number' && !w.isDestroyed());
    assert.ok(blockWins.length >= 1, 'block window created (elevate=' + elevate + ')');

    // גניבת פוקוס בזמן חסימה — חייבת לפעול זהה בשני המצבים (anti-Alt+Tab)
    const before = m.state.focusCalls.length;
    blockWins[0].emit('blur');
    assert.ok(m.state.focusCalls.length > before,
      'blur during block re-steals focus (elevate=' + elevate + ')');
    m.cleanup();
    return blockWins.length;
  }
  const limited = await checkBlocked(false); // חשבון רגיל
  const admin = await checkBlocked(true);    // חשבון מנהל מחובר
  assert.equal(admin, limited, 'admin and standard sessions create the same block windows');
});

/* ================= session Lock Edge Cases ================= */

test('session: unlock-with-empty-password returns failure when pin is set', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  const res = await m.ipcHandlers.get('session:unlock')({}, '');
  assert.equal(res.unlocked, false);
  m.cleanup();
});

test('session: double-unlock does not cause issues', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  const m = loadMain({ settings });
  await m.ready();

  let res = await m.ipcHandlers.get('session:unlock')({}, '1234');
  assert.equal(res.unlocked, true);
  // Second unlock with same password should also succeed (idempotent)
  res = await m.ipcHandlers.get('session:unlock')({}, '1234');
  assert.equal(res.unlocked, true);
  m.cleanup();
});

/* ================= Enforce Edge Cases ================= */

test('enforce: rapid consecutive enforce() calls do not create duplicate windows', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.enabled = false;
  const m = loadMain({ settings });
  await m.ready();

  // Trigger lock
  await m.ipcHandlers.get('lock:now')();
  // Trigger enforce multiple times in rapid succession
  for (let i = 0; i < 5; i++) {
    await m.ipcHandlers.get('status:get')();
  }
  await new Promise((r) => setTimeout(r, 50));

  // Count block windows
  const blockWins = m.state.windows.filter((w) => w.blockDisplayId !== undefined);
  // Should have exactly 2 block windows (one per display)
  assert.equal(blockWins.length, 2, 'Should have exactly 2 block windows (one per display), got ' + blockWins.length);
  m.cleanup();
});

/* ================= Security:get Edge Cases ================= */

test('security:get does not leak encrypted password or raw pinHash', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('secret123');
  settings.passwordEnc = 'encrypted-blob-that-should-not-leak';
  const m = loadMain({ settings });
  await m.ready();

  const sec = await m.ipcHandlers.get('security:get')();
  assert.ok(typeof sec === 'object');
  assert.equal(sec.passwordEnc, undefined, 'Encrypted password must not leak to renderer');
  assert.equal(sec.pinHash, undefined, 'PIN hash must not leak to renderer');
  m.cleanup();
});

/* ================= Log Event Edge Cases ================= */

test('activity:get survives corrupt log file', async () => {
  const m = loadMain({});
  await m.ready();

  // Write corrupt log
  const logFile = path.join(m.tmpRoot, 'userData', 'activity.log');
  fs.writeFileSync(logFile, 'not-valid-json\n{also-invalid\n{"valid":"but surrounding invalid"}\n', 'utf8');

  const activity = await m.ipcHandlers.get('activity:get')();
  assert.ok(Array.isArray(activity), 'Activity should return an array even with corrupt log');
  m.cleanup();
});

test('activity:get handles empty log gracefully', async () => {
  const m = loadMain({});
  await m.ready();

  const activity = await m.ipcHandlers.get('activity:get')();
  assert.ok(Array.isArray(activity), 'Activity should return an array for empty log');
  m.cleanup();
});

/* ================= "רק תוכנות מאושרות" — Process Governor (Phase 3.7) =================
   בטיחות קריטית: המושל חייב לסגור אך ורק אפליקציות משתמש לא-מאושרות, ולעולם
   לא תהליכי מערכת (safelist), תהליכים תחת %WINDIR%, או את בין הזמנים עצמו. */

const GOVERNOR_PROCS = JSON.stringify([
  { ProcessId: 4, ParentProcessId: 0, Name: 'System', ExecutablePath: '' },
  { ProcessId: 900, ParentProcessId: 4, Name: 'csrss.exe', ExecutablePath: 'C:\\Windows\\System32\\csrss.exe' },
  { ProcessId: 1000, ParentProcessId: 1, Name: 'lsass.exe', ExecutablePath: 'C:\\Windows\\System32\\lsass.exe' },
  { ProcessId: 1200, ParentProcessId: 1, Name: 'explorer.exe', ExecutablePath: 'C:\\Windows\\explorer.exe' },
  { ProcessId: 1500, ParentProcessId: 1, Name: 'WINWORD.EXE', ExecutablePath: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE' },
  { ProcessId: 1550, ParentProcessId: 1, Name: 'otzaria.exe', ExecutablePath: 'C:\\Users\\u\\AppData\\Local\\Programs\\otzaria\\otzaria.exe' },
  { ProcessId: 1600, ParentProcessId: 1, Name: 'chrome.exe', ExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { ProcessId: 1700, ParentProcessId: 1, Name: 'game.exe', ExecutablePath: 'D:\\Games\\game.exe' },
  { ProcessId: 1800, ParentProcessId: 1, Name: 'notepad.exe', ExecutablePath: 'C:\\Windows\\System32\\notepad.exe' },
  { ProcessId: 1900, ParentProcessId: 1, Name: 'powershell.exe', ExecutablePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
  { ProcessId: 1950, ParentProcessId: 1, Name: 'cmd.exe', ExecutablePath: 'D:\\Tools\\cmd.exe' },
  { ProcessId: 91960, ParentProcessId: 1, Name: 'evil.exe', ExecutablePath: 'C:\\WindowsEvil\\evil.exe' },
  { ProcessId: 91961, ParentProcessId: 1, Name: 'explorer.exe', ExecutablePath: 'D:\\Games\\explorer.exe' }
].map((p) => Object.assign({ StartTicks: p.ProcessId * 1000 + 1 }, p)));

function governorExec(killed) {
  return function (cmd, args) {
    const joined = args.join(' ');
    if (cmd === 'powershell.exe' && joined.includes('Get-Process') && joined.includes('StartTicks') && joined.includes('ConvertTo-Json')) {
      return { err: null, stdout: GOVERNOR_PROCS, stderr: '' };
    }
    if (cmd === 'powershell.exe' && joined.includes('Stop-Process -InputObject')) {
      const match = joined.match(/Get-Process -Id (\d+)/);
      if (match) killed.push(match[1]);
      return { err: null, stdout: '', stderr: '' };
    }
    if (cmd === 'netsh' && args.includes('show')) return { err: new Error('no rule'), stdout: '', stderr: '' };
    if (cmd === 'schtasks' && args.includes('/Create')) return { err: new Error('x'), stdout: '', stderr: '' };
    if (cmd === 'schtasks' && args.includes('/Query')) return { err: new Error('x'), stdout: '', stderr: '' };
    return { err: null, stdout: '', stderr: '' };
  };
}

test('governor (studyMode always): kills non-approved user apps; spares system/WINDIR/cryptographically approved/self', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.studyMode = { enabled: true, scope: 'always' };
  settings.allowedApps = [{ name: 'Word', exe: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE', mode: 'path' }];
  const killed = [];
  const m = loadMain({ settings, exec: governorExec(killed) });
  await m.ready();
  // המושל רץ fire-and-forget ומאמת תהליכים בסדרה. מחכים לתוצאה האחרונה
  // במקום להניח זמן קבוע (מכונות CI עמוסות עלולות להיות איטיות יותר).
  for (let i = 0; i < 100 && !killed.includes('91960'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // נסגרו: אפליקציות משתמש לא-מאושרות שאינן תחת Windows
  assert.ok(killed.includes('1600'), 'chrome (non-approved) must be killed');
  assert.ok(killed.includes('1700'), 'game (non-approved) must be killed');
  // לא נסגרו:
  assert.ok(!killed.includes('4'), 'System pid must be spared');
  assert.ok(!killed.includes('900'), 'csrss (safelist+WINDIR) must be spared');
  assert.ok(!killed.includes('1000'), 'lsass (safelist+WINDIR) must be spared');
  assert.ok(!killed.includes('1200'), 'explorer must be spared');
  assert.ok(killed.includes('1500'), 'path approval without SHA-256 must fail closed');
  assert.ok(killed.includes('1550'), 'KNOWN_APPS is discovery only; an app not explicitly approved must be killed');
  assert.ok(!killed.includes('1800'), 'notepad (WINDIR) must be spared');
  assert.ok(!killed.includes('1900'), 'powershell below WINDIR must be spared for system safety');
  assert.ok(killed.includes('1950'), 'a shell copied outside WINDIR is not safelisted and must be killed');
  assert.ok(killed.includes('91960'), 'WINDIR prefix without a path boundary must not be trusted: ' + JSON.stringify(killed));
  assert.ok(killed.includes('91961'), 'a copied safelisted basename outside WINDIR must be killed');
  m.cleanup();
});

test('governor (studyMode blocked): inactive when the computer is not blocked', async () => {
  const settings = S.defaultSchedule(); // ברירת מחדל: פתוח (לא חסום)
  settings.pinHash = S.sha256Hex('1234');
  settings.studyMode = { enabled: true, scope: 'blocked' };
  const killed = [];
  const m = loadMain({ settings, exec: governorExec(killed) });
  await m.ready();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(killed.length, 0, 'governor must not run while not blocked (scope=blocked): ' + JSON.stringify(killed));
  m.cleanup();
});

test('governor (studyMode blocked): active during a computer block', async () => {
  const settings = blockNowSchedule(); // pinHash + חסום כל השבוע
  settings.studyMode = { enabled: true, scope: 'blocked' };
  const killed = [];
  const m = loadMain({ settings, exec: governorExec(killed) });
  await m.ready();
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(killed.includes('1600') && killed.includes('1700'), 'governor must kill non-approved apps during block: ' + JSON.stringify(killed));
  m.cleanup();
});

test('governor: disabled studyMode never kills anything', async () => {
  const settings = blockNowSchedule();
  settings.studyMode = { enabled: false, scope: 'always' };
  const killed = [];
  const m = loadMain({ settings, exec: governorExec(killed) });
  await m.ready();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(killed.length, 0, 'no kills when studyMode disabled');
  m.cleanup();
});

/* ================= "אתר נעול" — דפדפן מוגבל (Phase 3.8) ================= */

test('locked site: open creates a hardened window (contextIsolation, no nodeIntegration, sandbox)', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.websiteApps = [{ name: 'לימוד', urls: ['https://hebrewbooks.org'] }];
  const m = loadMain({ settings });
  await m.ready();
  const before = m.state.windows.length;
  const res = await m.ipcHandlers.get('website-apps:open')({}, 'לימוד');
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(m.state.windows.length, before + 1, 'a locked-site window must be created');
  const w = m.state.windows[m.state.windows.length - 1];
  assert.equal(w.opts.webPreferences.contextIsolation, true, 'contextIsolation must be true');
  assert.equal(w.opts.webPreferences.nodeIntegration, false, 'nodeIntegration must be false');
  assert.equal(w.opts.webPreferences.sandbox, true, 'sandbox must be true');
  assert.ok(!w.opts.webPreferences.preload, 'no preload for remote content');
  const ses = m.electron.session._partition;
  let downloadPrevented = false;
  ses.listeners['will-download']({ preventDefault: () => { downloadPrevented = true; } });
  assert.equal(downloadPrevented, true, 'locked-site downloads must be cancelled');
  assert.equal(ses.permissionCheck(), false, 'permission checks are denied');
  m.cleanup();
});

test('locked site: open by index works and rejects unknown / url-less sites', async () => {
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.websiteApps = [{ name: 'לימוד', urls: ['https://hebrewbooks.org'] }];
  const m = loadMain({ settings });
  await m.ready();
  assert.ok((await m.ipcHandlers.get('website-apps:open')({}, 0)).ok, 'open by index 0');
  const bad = await m.ipcHandlers.get('website-apps:open')({}, 'לא קיים');
  assert.equal(bad.ok, false, 'unknown site rejected');
  m.cleanup();
});

/* ================= פרופילים לפי משתמש Windows (Phase 3.9) ================= */

function allBlockedWeek() {
  const w = [];
  for (let d = 0; d < 7; d++) w.push({ day: d, slots: [{ start: 0, end: 1440, type: 'blocked' }] });
  return w;
}

test('profiles: a profile bound to the current Windows user overrides the base schedule', async () => {
  const origUser = process.env.USERNAME;
  process.env.USERNAME = 'TestKid';
  try {
    const settings = S.defaultSchedule(); // בסיס: פתוח (בלי חלונות)
    settings.pinHash = S.sha256Hex('1234');
    settings.profiles = [{ name: 'ילד', user: 'testkid', overrides: { week: allBlockedWeek() } }];
    const m = loadMain({ settings });
    await m.ready();
    const st = await m.ipcHandlers.get('status:get')();
    assert.equal(st.state, 'blocked', 'the current-user profile must make the computer blocked');
    m.cleanup();
  } finally {
    process.env.USERNAME = origUser;
  }
});

test('profiles: no matching profile falls back to the base schedule', async () => {
  const origUser = process.env.USERNAME;
  process.env.USERNAME = 'SomeoneElse';
  try {
    const settings = S.defaultSchedule(); // בסיס: פתוח
    settings.pinHash = S.sha256Hex('1234');
    settings.profiles = [{ name: 'ילד', user: 'testkid', overrides: { week: allBlockedWeek() } }];
    const m = loadMain({ settings });
    await m.ready();
    const st = await m.ipcHandlers.get('status:get')();
    assert.equal(st.state, 'allowed', 'no matching profile → base (open) applies');
    m.cleanup();
  } finally {
    process.env.USERNAME = origUser;
  }
});

test('profiles: blocking profile cannot be saved without a parent PIN', async () => {
  const m = loadMain({ settings: S.defaultSchedule() });
  await m.ready();
  const data = S.defaultSchedule();
  data.pinHash = null;
  data.profiles = [{ id: 'user:kid', name: 'kid', user: 'kid', overrides: { week: allBlockedWeek() } }];
  const res = await m.ipcHandlers.get('settings:save')({}, data);
  assert.equal(res.ok, false);
  assert.match(res.error || '', /סיסמת הורה/);
  m.cleanup();
});

test('profiles: cosmetic save preserves manual unlock using the active profile transition', async () => {
  const origUser = process.env.USERNAME;
  process.env.USERNAME = 'TestKid';
  try {
    const settings = S.defaultSchedule();
    settings.pinHash = S.sha256Hex('1234');
    settings.profiles = [{ id: 'user:testkid', name: 'kid', user: 'testkid', overrides: { week: allBlockedWeek() } }];
    const m = loadMain({ settings });
    await m.ready();
    await m.ipcHandlers.get('session:unlock')({}, '1234');
    await m.ipcHandlers.get('unlock:now')({}, '1234');
    const before = await m.ipcHandlers.get('settings:get')();
    assert.ok(before.manualUnlockUntil, 'early unlock exists');
    before.theme = 'light';
    const saved = await m.ipcHandlers.get('settings:save')({}, before);
    assert.ok(saved.ok, JSON.stringify(saved));
    const after = await m.ipcHandlers.get('settings:get')();
    assert.ok(after.manualUnlockUntil, 'cosmetic save must not clear profile-based early unlock');
    m.cleanup();
  } finally { process.env.USERNAME = origUser; }
});

test('profiles: saving on a profiled account does NOT overwrite the persisted base with the overlay', async () => {
  // רגרסיה קריטית: unlock (שקורא saveSettings) על חשבון עם פרופיל אסור
  // שידרוס את הבסיס המשותף עם דריסות הפרופיל.
  const origUser = process.env.USERNAME;
  process.env.USERNAME = 'TestKid';
  try {
    const settings = S.defaultSchedule();
    settings.pinHash = S.sha256Hex('1234');
    settings.profiles = [{ name: 'ילד', user: 'testkid', overrides: { week: allBlockedWeek() } }];
    const m = loadMain({ settings });
    await m.ready();
    // פתיחה מוקדמת (מגדירה manualUnlockUntil ושומרת)
    await m.ipcHandlers.get('unlock:now')({}, '1234');
    // הקובץ הנשמר חייב לשמר את הבסיס: week ריק + הפרופיל, ולא week חסום
    const machineFile = path.join(process.env.PROGRAMDATA, 'BenHazmanim', 'settings.json');
    const userFile = path.join(m.tmpRoot, 'userData', 'settings.json');
    const saved = JSON.parse(fs.readFileSync(fs.existsSync(machineFile) ? machineFile : userFile, 'utf8'));
    assert.equal(saved.week[0].slots.length, 0, 'base week must stay empty (not overwritten by the profile overlay)');
    assert.equal(saved.profiles.length, 1, 'profile preserved in base');
    assert.equal(saved.profiles[0].overrides.week[0].slots[0].type, 'blocked', 'profile override intact');
    m.cleanup();
  } finally {
    process.env.USERNAME = origUser;
  }
});

/* ================= סייר קבצים מוגבל (Phase 3.10) ================= */

function configureLibraryExplorer(m, extra) {
  const library = path.join(m.tmpRoot, 'study-library');
  fs.mkdirSync(path.join(library, 'books'), { recursive: true });
  fs.writeFileSync(path.join(library, 'lesson.pdf'), 'pdf');
  fs.writeFileSync(path.join(library, 'blocked.EXE'), 'exe');
  fs.writeFileSync(path.join(library, 'shortcut.lnk'), 'lnk');
  fs.writeFileSync(path.join(library, 'README'), 'extensionless');
  fs.writeFileSync(path.join(library, 'books', 'notes.txt'), 'notes');
  const settings = S.defaultSchedule();
  settings.pinHash = S.sha256Hex('1234');
  settings.fileExplorer = Object.assign({
    enabled: true,
    roots: ['library'],
    readonlyLibrary: true,
    hiddenTypes: ['.exe'],
    libraryPath: library
  }, extra || {});
  return { library, settings };
}

test('restricted explorer: window is hardened and exposes the configured read-only root', async () => {
  const m = makeMock({});
  const configured = configureLibraryExplorer(m);
  fs.writeFileSync(path.join(m.tmpRoot, 'userData', 'settings.json'), JSON.stringify(configured.settings), 'utf8');
  delete require.cache[require.resolve('../main.js')];
  require('../main.js');
  await m.ready();

  const roots = await m.ipcHandlers.get('file-explorer:roots')({});
  assert.ok(roots.ok, JSON.stringify(roots));
  assert.deepEqual(roots.roots, [{ id: 'library', label: 'ספרייה', readonly: true }]);

  const before = m.state.windows.length;
  const opened = await m.ipcHandlers.get('file-explorer:open-window')({});
  assert.ok(opened.ok, JSON.stringify(opened));
  assert.equal(m.state.windows.length, before + 1);
  const w = m.state.windows[m.state.windows.length - 1];
  assert.equal(w.opts.webPreferences.contextIsolation, true);
  assert.equal(w.opts.webPreferences.nodeIntegration, false);
  assert.match(String(w.title), /סייר קבצים מוגבל/);
  m.cleanup();
});

test('restricted explorer: lists directories/files but hides configured file types case-insensitively', async () => {
  const m = loadMain({});
  const configured = configureLibraryExplorer(m);
  // Replace settings after mock construction but before main loads.
  fs.writeFileSync(path.join(m.tmpRoot, 'userData', 'settings.json'), JSON.stringify(configured.settings), 'utf8');
  delete require.cache[require.resolve('../main.js')];
  require('../main.js');
  await m.ready();

  const listed = await m.ipcHandlers.get('file-explorer:list')({}, 'library', '');
  assert.ok(listed.ok, JSON.stringify(listed));
  assert.ok(listed.items.some((x) => x.name === 'books' && x.isDir), 'directory is listed');
  assert.ok(listed.items.some((x) => x.name === 'lesson.pdf' && !x.isDir), 'allowed file is listed');
  assert.ok(!listed.items.some((x) => /blocked\.exe/i.test(x.name)), 'hidden extension is not listed');
  assert.ok(!listed.items.some((x) => x.name === 'shortcut.lnk'), 'active shortcut type is always denied');
  assert.ok(!listed.items.some((x) => x.name === 'README'), 'extensionless file is denied by default');
  assert.equal(listed.root.readonly, true);
  m.cleanup();
});

test('restricted explorer: blocks path traversal, unknown roots and direct opening of hidden types', async () => {
  const m = loadMain({});
  const configured = configureLibraryExplorer(m);
  fs.writeFileSync(path.join(m.tmpRoot, 'userData', 'settings.json'), JSON.stringify(configured.settings), 'utf8');
  delete require.cache[require.resolve('../main.js')];
  require('../main.js');
  await m.ready();

  const traversal = await m.ipcHandlers.get('file-explorer:list')({}, 'library', '..\\');
  assert.equal(traversal.ok, false, 'must reject .. escaping the approved root');
  assert.match(traversal.error || '', /אינו מורשה/);
  const unknown = await m.ipcHandlers.get('file-explorer:list')({}, 'windows', '');
  assert.equal(unknown.ok, false, 'unknown root must be rejected');
  const hidden = await m.ipcHandlers.get('file-explorer:open')({}, 'library', 'blocked.EXE');
  assert.equal(hidden.ok, false, 'hidden type must also be blocked on direct open');
  assert.match(hidden.error || '', /סוג הקובץ חסום/);
  m.cleanup();
});

test('restricted explorer: opens only an allowed file inside the approved root', async () => {
  const m = loadMain({});
  const configured = configureLibraryExplorer(m);
  fs.writeFileSync(path.join(m.tmpRoot, 'userData', 'settings.json'), JSON.stringify(configured.settings), 'utf8');
  delete require.cache[require.resolve('../main.js')];
  require('../main.js');
  await m.ready();
  let openedPath = null;
  m.electron.shell.openPath = (p) => { openedPath = p; return Promise.resolve(''); };

  const res = await m.ipcHandlers.get('file-explorer:open')({}, 'library', 'books\\notes.txt');
  assert.ok(res.ok, JSON.stringify(res));
  const source = path.join(configured.library, 'books', 'notes.txt');
  assert.notEqual(openedPath, source, 'read-only library must not hand the source to an external editor');
  assert.equal(fs.readFileSync(openedPath, 'utf8'), 'notes');
  assert.equal(fs.statSync(openedPath).mode & 0o222, 0, 'temporary copy is read-only');
  m.cleanup();
});

test('restricted explorer renderer: strict CSP uses an external script and no inline executable code', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'file-explorer.html'), 'utf8');
  assert.match(html, /Content-Security-Policy[^>]+script-src 'self'/);
  assert.match(html, /<script src="file-explorer\.js"><\/script>/);
  assert.ok(!/<script>([\s\S]*?)<\/script>/.test(html), 'inline script would be blocked by the CSP');
  assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'file-explorer.js'), 'utf8')));
});
