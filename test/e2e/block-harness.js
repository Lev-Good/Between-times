// שומר E2E למסך החסימה — מופעל מתוך test/block-screen.e2e.test.js עם ELECTRON_E2E=1.
// מריץ את מסך החסימה האמיתי (renderer/block.html + CSS + preload.js + IPC) בתוך
// חלון Electron אמיתי, שולח אליו סטטוסים כמו התהליך הראשי, ומדווח תוצאות כ-JSON
// לשורה האחרונה של stdout (E2E_RESULT {...}). קוד יציאה: 0 = הכול תקין, 1 = כשל.
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

if (process.env.ELECTRON_E2E !== '1') {
  console.error('block-harness: יש להפעיל עם ELECTRON_E2E=1');
  process.exit(2);
}

// פחות תקלות GPU בסביבות שונות — לבדיקת עשן אין צורך בהאצה.
app.disableHardwareAcceleration();

// ---- ה-IPC שמחליף את התהליך הראשי האמיתי (בדיוק הערוצים שמסך החסימה קורא להם) ----
const calls = { settingsOpen: 0, unlock: [], setBg: [], launch: [] };
let currentStatus = null;

function registerIpc() {
  ipcMain.handle('status:get', () => currentStatus);
  ipcMain.handle('settings:open', () => { calls.settingsOpen++; return { ok: true }; });
  ipcMain.handle('unlock:now', (_e, pin) => { calls.unlock.push(String(pin)); return { ok: false, error: 'E2E: לא נפתח בפועל' }; });
  ipcMain.handle('block:set-bg', (_e, bg) => { calls.setBg.push(String(bg)); return { ok: true }; });
  ipcMain.handle('allowed-apps:launch', (_e, app) => { calls.launch.push(app); return { ok: false, error: 'E2E: אין תוכנה אמיתית' }; });
  ipcMain.handle('recovery:send', () => ({ ok: false, error: 'E2E: אין מייל' }));
  ipcMain.handle('recovery:complete', () => ({ ok: false, error: 'E2E' }));
}

// סטטוס כמו buildStatus בתהליך הראשי (כולל שדות שמסך החסימה קורא)
function status(extra) {
  return Object.assign({
    state: 'blocked',
    pinSet: true,
    configError: false,
    manualLock: false,
    blockedByDefault: false,
    now: Date.now(),
    theme: 'dark',
    blockBg: 'blobs',
    showTorahQuotes: true,
    blockMessage: '',
    nextAt: null,
    secondsUntilNext: null,
    allowedApps: []
  }, extra || {});
}

// צילום מצב ה-DOM האמיתי — רץ בדף עצמו וממתין שהסטטוס יוצג (120ms)
const PAGE_SNAPSHOT = `
  (async () => {
    await new Promise((r) => setTimeout(r, 120));
    const el = (id) => document.getElementById(id);
    return {
      configFaultBox: el('configFaultBox').style.display,
      pinBox: el('pinBox').style.display,
      pinToggle: el('pinToggle').style.display,
      noPinBox: el('noPinBox').style.display,
      settingsFooterBtn: el('settingsFooterBtn').style.display,
      lockMsg: el('lockMsg').textContent,
      blockReasonHidden: el('blockReason').classList.contains('hidden')
    };
  })()
`;

function createWindow() {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 960,
      height: 640,
      show: true, // סמוק אמיתי ונראה — נסגר בסוף הבדיקה
      frame: false,
      backgroundColor: '#0b1020',
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'block.html'));
    win.webContents.on('did-finish-load', () => resolve(win));
    win.webContents.on('did-fail-load', (_e, code, desc) => reject(new Error('טעינת block.html נכשלה: ' + code + ' ' + desc)));
  });
}

function snapshot(win) {
  return win.webContents.executeJavaScript(PAGE_SNAPSHOT, true);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  registerIpc();
  const win = await createWindow();
  const report = { checks: [] };
  const add = (name, ok, detail) => report.checks.push({ name, ok: !!ok, detail: detail || '' });

  // ---------- 1) קובץ הגדרות פגום: רק כפתור ההגדרות, בלי דלג ובלי שדה סיסמה ----------
  currentStatus = status({ configError: true, pinSet: false, blockedByDefault: true });
  win.webContents.send('status', currentStatus);
  let s = await snapshot(win);
  add('config error: תיבת התיקון מוצגת', s.configFaultBox === '');
  add('config error: שדה הסיסמה מוסתר', s.pinBox === 'none');
  add('config error: כפתור פתיחה בסיסמה מוסתר', s.pinToggle === 'none');
  add('config error: תיבת "אין סיסמה" מוסתרת (דלג + הגדרת סיסמה אינם נגישים)', s.noPinBox === 'none');
  add('config error: כפתור ההגדרות הקטן מוסתר', s.settingsFooterBtn === 'none');
  add('config error: ההודעה מסבירה את התקלה', /פגום/.test(s.lockMsg), s.lockMsg);
  add('config error: הסבר ברירת המחדל מוסתר', s.blockReasonHidden === true);

  await win.webContents.executeJavaScript("document.getElementById('configFaultSettingsBtn').click(); true", true);
  await sleep(150);
  add('config error: כפתור התיקון פותח את ההגדרות (IPC אמיתי)', calls.settingsOpen === 1, 'calls=' + calls.settingsOpen);

  // ---------- 2) חסימה רגילה עם סיסמה ----------
  currentStatus = status({ pinSet: true });
  win.webContents.send('status', currentStatus);
  s = await snapshot(win);
  add('blocked+pin: תיבת התקלה נעלמת', s.configFaultBox === 'none');
  add('blocked+pin: כפתור ההגדרות הקטן זמין תמיד', s.settingsFooterBtn === '');
  add('blocked+pin: כפתור פתיחה בסיסמה מוצג, השדה מוסתר', s.pinToggle === '' && s.pinBox === 'none');

  await win.webContents.executeJavaScript("document.getElementById('settingsFooterBtn').click(); true", true);
  await sleep(150);
  add('blocked+pin: כפתור ההגדרות הקטן פותח את ההגדרות', calls.settingsOpen === 2, 'calls=' + calls.settingsOpen);

  await win.webContents.executeJavaScript("document.getElementById('pinToggle').click(); true", true);
  await sleep(150);
  const s2 = await snapshot(win);
  add('blocked+pin: לחיצה על כפתור הפתיחה מרחיבה את שדה הסיסמה', s2.pinBox === '', 'pinBox=' + s2.pinBox);

  // ---------- 3) ללא סיסמה: הגדרה + דלג, והדלג שולח unlockNow('') ----------
  currentStatus = status({ pinSet: false });
  win.webContents.send('status', currentStatus);
  s = await snapshot(win);
  add('no-pin: טופס ההגדרה וכפתור הדלג מוצגים', s.noPinBox === '');
  add('no-pin: תיבת התקלה מוסתרת', s.configFaultBox === 'none');

  await win.webContents.executeJavaScript("document.getElementById('skipPinBtn').click(); true", true);
  await sleep(150);
  add('no-pin: כפתור הדלג שולח unlockNow עם סיסמה ריקה', calls.unlock.length === 1 && calls.unlock[0] === '', JSON.stringify(calls.unlock));

  // ---------- 4) תיקון התקלה מהמסך מחזיר את הפקדים הרגילים ----------
  currentStatus = status({ configError: false, pinSet: false });
  win.webContents.send('status', currentStatus);
  s = await snapshot(win);
  add('fix: תיבת התקלה נעלמת אחרי התיקון', s.configFaultBox === 'none');
  add('fix: טופס "אין סיסמה" חוזר', s.noPinBox === '');

  report.ok = report.checks.every((c) => c.ok);
  console.log('E2E_RESULT ' + JSON.stringify(report));
  // דחייה קטנה כדי ש-stdout יתרוקן לפני יציאה מיידית
  setTimeout(() => app.exit(report.ok ? 0 : 1), 150);
}

app.whenReady().then(run).catch((err) => {
  console.log('E2E_RESULT ' + JSON.stringify({
    ok: false,
    checks: [{ name: 'harness', ok: false, detail: String(err && err.stack || err) }]
  }));
  setTimeout(() => app.exit(1), 150);
});
