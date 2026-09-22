// שומר E2E לדפדפן המוגבל — מופעל מ-test/locked-browser.e2e.test.js.
//
// למה זה קיים: בדיקות היחידה מדמות את אירועי Electron (`will-navigate`,
// `setWindowOpenHandler`) ומאמתות שהפרדיקט מחזיר נכון. הן אינן מוכיחות שדפדפן
// אמיתי באמת נעצר. כאן רצה Chromium אמיתי (Electron) עם ההגנות האמיתיות
// מ-locked-browser.js, מול שרת HTTP מקומי (אין תלות באינטרנט).
//
// אותו תרחיש בדיוק מורץ פעמיים — בשני המצבים של רשימת האתרים, כיון ששניהם
// חולקים את אותן הגנות:
//   • רשימת חסימה ("כל האתרים פתוחים חוץ מהרשימה") — הדפדפן המוגבל, חלון עם
//     שורת כתובת ותוכן ב-WebContentsView נפרד (כמו openRestrictedBrowser).
//   • רשימת היתר ("רק האתרים שברשימה פתוחים") — חלון "אתר נעול" שהחלון עצמו
//     טוען את התוכן (כמו openWebsiteApp).
//
// הערת ביצועים/אמינות: בסביבה בלי קומפוזיטור (הרצה אוטומטית) `did-finish-load`
// מתעכב עד ה-timeout בעוד העמוד עצמו כבר נטען ומגיב — לכן ממתינים למוכנות ה-DOM
// בפועל. וכשהגנה עוצרת ניווט, Chromium דוחה את ה-Promise של loadURL רק לאחר
// ניסיון רשת (DNS) שאורך שניות — בעוד שהחסימה עצמה נרשמת מיידית באירוע, ולכן
// לא ממתינים לדחייה הזו.
'use strict';

const { app, BrowserWindow, WebContentsView, session } = require('electron');
const http = require('http');

const S = require('../../scheduler.js');
const { applyLockedNavigationGuards, hardenLockedSession } = require('../../locked-browser.js');

if (process.env.ELECTRON_E2E !== '1') {
  console.error('locked-browser-harness: יש להפעיל עם ELECTRON_E2E=1');
  process.exit(2);
}

app.disableHardwareAcceleration();

// ברירת המחדל של Electron היא לצאת כשאין חלונות. בין שני התרחישים נסגר החלון
// של הראשון בלי שיהיה עדיין חלון אחר — בלי המאזין הזה התהליך מתחיל לצאת
// והחלון השני נהרס לפני שהוא מספיק לטעון (ERR_FAILED לא מוסבר).
app.on('window-all-closed', () => { /* נשארים חיים עד סוף הבדיקה */ });

const BLOCKED_HOST = 'blocked.test';   // האתר שההורה חוסם / שאינו ברשימת ההיתר
const PARTITION_BLOCKLIST = 'persist:e2e-locked-browser';
const PARTITION_ALLOWLIST = 'persist:e2e-approved-site';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- שרת מקומי: אתר "מותר" + הפניה לאתר האסור ---------- */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><head><title>OK-PAGE-1</title></head><body>' +
          '<a id="direct" href="http://' + BLOCKED_HOST + '/direct">אסור</a>' +
          '<a id="allowedLink" href="/ok2">מותר</a>' +
          '</body></html>');
        return;
      }
      if (req.url === '/ok2') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><head><title>OK-PAGE-2</title></head><body>ok2</body></html>');
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://' + BLOCKED_HOST + '/via-redirect' });
        res.end();
        return;
      }
      if (req.url === '/meta') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><head><title>META-PAGE</title>' +
          '<meta http-equiv="refresh" content="0;url=http://' + BLOCKED_HOST + '/via-meta">' +
          '</head><body>meta</body></html>');
        return;
      }
      if (req.url === '/frame') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><head><title>FRAME-PAGE</title></head><body>' +
          '<iframe id="f" src="http://' + BLOCKED_HOST + '/via-frame"></iframe></body></html>');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const baseUrl = (server) => 'http://127.0.0.1:' + server.address().port;

/* ---------- ההגנות עצמן, כמו בתהליך הראשי ---------- */
// מצב רשימת חסימה: "כל האתרים פתוחים חוץ מהרשימה"
const blocklistAllows = (websiteApps) => (url) => !S.siteUrlBlocked(websiteApps, url, true);
// מצב רשימת היתר: "רק האתרים שברשימה פתוחים" (האתר המאושר שההורה בחר)
const allowlistAllows = (appEntry) => (url) => S.siteUrlAllowed([appEntry], url, true);

/* ---------- שני סוגי החלונות שהתוכנה פותחת ---------- */

// דפדפן מוגבל (מצב רשימת חסימה): חלון + WebContentsView לתוכן המרוחק, בלי preload
function createRestrictedBrowser(allows, partition) {
  const blocked = [];
  const win = new BrowserWindow({
    width: 900, height: 640,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const view = new WebContentsView({
    webPreferences: {
      partition, contextIsolation: true, nodeIntegration: false, sandbox: true,
      webviewTag: false, backgroundThrottling: false
      // אין preload — בדיוק כמו בתהליך הראשי: תוכן רשמי לא נחשף ל-API של התוכנה
    }
  });
  win.contentView.addChildView(view);
  try { view.setBounds({ x: 0, y: 0, width: 900, height: 640 }); } catch { /* ignore */ }
  const wc = view.webContents;
  applyLockedNavigationGuards(wc, { allows, onBlocked: (u) => blocked.push(String(u || '')) });
  return {
    wc, blocked,
    dispose() {
      try { win.contentView.removeChildView(view); } catch { /* ignore */ }
      try { view.webContents.close(); } catch { /* ignore */ }
      try { win.destroy(); } catch { /* ignore */ }
    }
  };
}

// אתר מאושר (מצב רשימת היתר): החלון עצמו טוען את התוכן — בלי preload
function createApprovedSiteWindow(allows, partition) {
  const blocked = [];
  const win = new BrowserWindow({
    width: 900, height: 640,
    show: false,
    webPreferences: {
      partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false
    }
  });
  const wc = win.webContents;
  applyLockedNavigationGuards(wc, { allows, onBlocked: (u) => blocked.push(String(u || '')) });
  return { wc, blocked, dispose: () => { try { win.destroy(); } catch { /* ignore */ } } };
}

/* ---------- עזרי המתנה ---------- */

// ממתין עד שתנאי מתקיים (עד timeout) — במקום השהיה קבועה ושבירה בעומס
async function waitFor(fn, timeoutMs) {
  const start = Date.now();
  const until = start + (timeoutMs || 3000);
  let result = false;
  while (Date.now() < until) {
    try { if (fn()) { result = true; break; } } catch { /* ignore */ }
    await sleep(60);
  }
  if (!result) { try { result = !!fn(); } catch { result = false; } }
  if (process.env.E2E_TIMING) console.error('[wait] ' + (Date.now() - start) + 'ms ok=' + result);
  return result;
}

// ממתין שהעמוד יהיה שמיש — לפי ה-DOM ולא לפי did-finish-load (ראו ההערה למעלה)
async function waitDomReady(wc, selector, timeoutMs) {
  const until = Date.now() + (timeoutMs || 6000);
  while (Date.now() < until) {
    try {
      const ok = await wc.executeJavaScript(
        'document.readyState !== "loading" && !!document.querySelector(' + JSON.stringify(selector) + ')', true);
      if (ok) return true;
    } catch { /* ignore */ }
    await sleep(60);
  }
  return false;
}

// טעינה בלי להמתין לתוצאה: ניווט שנחסם נרשם מיד באירוע, אבל ה-Promise של
// loadURL נדחה רק אחרי ניסיון רשת שאורך שניות — אין סיבה לחכות לזה.
function fireLoad(wc, url) {
  try { Promise.resolve(wc.loadURL(url)).catch(() => { /* נחסם או נכשל — נבדק בהמשך */ }); }
  catch { /* ignore */ }
}

/* ---------- התרחיש: זהה לשני המצבים (האתר המקומי מותר, blocked.test אסור) ---------- */
async function runScenario(prefix, browser, base, add) {
  const { wc, blocked } = browser;
  const reset = () => { blocked.length = 0; };
  const t0 = Date.now();
  const mark = (s) => { if (process.env.E2E_TIMING) console.error('[timing] ' + prefix + ' ' + s + ': ' + (Date.now() - t0) + 'ms'); };
  const blockedSeen = () => blocked.some((u) => u.indexOf(BLOCKED_HOST) >= 0);
  const urlHasBlocked = () => String(wc.getURL()).indexOf(BLOCKED_HOST) >= 0;

  /* 1) העמוד המותר נטען, ואין חשיפת API לתוכן המרוחק */
  fireLoad(wc, base + '/ok');
  const ready = await waitDomReady(wc, '#allowedLink');
  const titleOk = await waitFor(() => wc.getTitle() === 'OK-PAGE-1', 3000);
  mark('after first load');
  add(prefix + ': העמוד המותר נטען ב-Chromium אמיתי',
    ready && titleOk && String(wc.getURL()).indexOf('/ok') >= 0,
    'ready=' + ready + ' url=' + wc.getURL() + ' title=' + wc.getTitle());

  const exposure = await wc.executeJavaScript(
    '({ browser: typeof window.siteBrowser, api: typeof window.electronAPI, req: typeof require })', true);
  add(prefix + ': תוכן רחוק ללא preload (אין siteBrowser/electronAPI/require)',
    exposure.browser === 'undefined' && exposure.api === 'undefined' && exposure.req === 'undefined',
    JSON.stringify(exposure));

  /* 2) אין חסימת-יתר: ניווט בתוך האתר המותר עובד */
  reset();
  await wc.executeJavaScript("document.getElementById('allowedLink').click(); true", true);
  const wentToOk2 = await waitFor(() => String(wc.getURL()).indexOf('/ok2') >= 0, 4000);
  mark('after link click');
  add(prefix + ': קישור בתוך האתר המותר מנווט כרגיל', wentToOk2,
    'url=' + wc.getURL() + ' blocked=' + JSON.stringify(blocked));
  add(prefix + ': בניווט מותר לא נרשמה חסימה', blocked.length === 0, JSON.stringify(blocked));

  /* 3) ניווט ישיר לאתר האסור — נחסם בפועל */
  fireLoad(wc, base + '/ok');
  await waitDomReady(wc, '#direct');
  reset();
  await wc.executeJavaScript("document.getElementById('direct').click(); true", true);
  const sawDirect = await waitFor(blockedSeen, 3000);
  add(prefix + ': לחיצה על קישור לאתר האסור לא מנווטת', !urlHasBlocked(), 'url=' + wc.getURL());
  add(prefix + ': החסימה נרשמה עם הכתובת שנחסמה', sawDirect, JSON.stringify(blocked));

  /* 4) הפניה מהשרת לאתר האסור — נחסמת */
  reset();
  fireLoad(wc, base + '/redirect');
  const sawRedirect = await waitFor(blockedSeen, 3000);
  add(prefix + ': הפניה (302) לאתר האסור נחסמת', sawRedirect && !urlHasBlocked(), 'url=' + wc.getURL());
  add(prefix + ': ההפניה החסומה נרשמה', sawRedirect, JSON.stringify(blocked));

  /* 5) meta-refresh לאתר האסור — נחסם */
  reset();
  fireLoad(wc, base + '/meta');
  const sawMeta = await waitFor(blockedSeen, 3000);
  add(prefix + ': meta-refresh לאתר האסור נחסם', sawMeta && !urlHasBlocked(), 'url=' + wc.getURL());
  add(prefix + ': ה-meta החסום נרשם', sawMeta, JSON.stringify(blocked));

  /* 6) מסגת iframe לאתר האסור — נחסמת (will-frame-navigate) */
  reset();
  fireLoad(wc, base + '/frame');
  const sawFrame = await waitFor(blockedSeen, 3000);
  mark('after redirect/meta/frame');
  add(prefix + ': מסגת iframe לאתר האסור נחסמה', sawFrame, JSON.stringify(blocked));

  /* 7) window.open לאתר האסור — נדחה, בלי חלון חדש */
  fireLoad(wc, base + '/ok');
  await waitDomReady(wc, '#direct');
  reset();
  const windowsBefore = BrowserWindow.getAllWindows().length;
  await wc.executeJavaScript("window.open('http://" + BLOCKED_HOST + "/popup'); true", true);
  const sawPopup = await waitFor(blockedSeen, 2500);
  add(prefix + ': window.open לאתר האסור נדחה בלי חלון חדש',
    sawPopup && BrowserWindow.getAllWindows().length === windowsBefore,
    'windows=' + BrowserWindow.getAllWindows().length);
  add(prefix + ': החלון האסור נרשם', sawPopup, JSON.stringify(blocked));
  add(prefix + ': התוכן נשאר במקומו אחרי window.open חסום',
    String(wc.getURL()).indexOf('/ok') >= 0, 'url=' + wc.getURL());

  /* 8) window.open לאתר המותר — נטען באותו חלון, בלי חלון חדש */
  reset();
  await wc.executeJavaScript("window.open('" + base + "/ok2'); true", true);
  const openedOk2 = await waitFor(() => String(wc.getURL()).indexOf('/ok2') >= 0, 4000);
  mark('after window.open allowed');
  add(prefix + ': window.open לאתר המותר נטען באותו חלון', openedOk2, 'url=' + wc.getURL());
  add(prefix + ': לא נפתח חלון חדש לאתר המותר',
    BrowserWindow.getAllWindows().length === windowsBefore,
    'windows=' + BrowserWindow.getAllWindows().length);

  /* 9) סגירה נקייה */
  try {
    browser.dispose();
    add(prefix + ': סגירת החלון עוברת בלי שגיאה', true);
  } catch (e) {
    add(prefix + ': סגירת החלון עוברת בלי שגיאה', false, String(e && e.message));
  }
}

// נשמר ברמת המודול כדי שגם כשל לא צפוי ידווח על הבדיקות שכבר עברו — אחרת
// אי-אפשר לדעת איפה בדיוק ההרצה נפלה.
const report = { checks: [] };
const add = (name, ok, detail) => report.checks.push({ name, ok: !!ok, detail: detail || '' });

async function run() {
  const server = await startServer();
  const base = baseUrl(server);

  /* נעילת ה-Session (הרשאות והורדות) — לא זורקת, ומסמנת את ה-Session */
  for (const [prefix, partition] of [['רשימת חסימה', PARTITION_BLOCKLIST], ['רשימת היתר', PARTITION_ALLOWLIST]]) {
    const ses = session.fromPartition(partition);
    let err = null;
    try { hardenLockedSession(ses); } catch (e) { err = e; }
    add(prefix + ': hardenLockedSession אינה זורקת', err === null, err && String(err.message));
    add(prefix + ': ה-Session מסומן כנעול-הורדות', ses.__benHazmanimDownloadLock === true);
  }

  /* ---------- תרחיש א: מצב רשימת חסימה (הדפדפן המוגבל) ---------- */
  const blocklistApps = [{ name: 'אתר חסום', urls: ['http://' + BLOCKED_HOST] }];
  const restricted = createRestrictedBrowser(blocklistAllows(blocklistApps), PARTITION_BLOCKLIST);
  add('רשימת חסימה: התוכן רץ ב-Session המבודד', restricted.wc.session === session.fromPartition(PARTITION_BLOCKLIST));
  await runScenario('רשימת חסימה', restricted, base, add);

  /* ---------- תרחיש ב: מצב רשימת היתר (אתר מאושר) ---------- */
  // האתר המאושר שההורה הגדיר — הדומיין המותקן עליו רץ השרת המקומי
  const approvedApp = { name: 'אתר מאושר', urls: [base] };
  const approved = createApprovedSiteWindow(allowlistAllows(approvedApp), PARTITION_ALLOWLIST);
  add('רשימת היתר: התוכן רץ ב-Session המבודד', approved.wc.session === session.fromPartition(PARTITION_ALLOWLIST));
  // מוודאים שהאתר המאושר באמת מאושר לפי הפרדיקט (אחרת התרחיש היה נכשל מעצמו)
  add('רשימת היתר: הפרדיקט מתיר את האתר המאושר וחוסם את האחר',
    allowlistAllows(approvedApp)(base + '/ok') === true &&
    allowlistAllows(approvedApp)('http://' + BLOCKED_HOST + '/') === false);
  await runScenario('רשימת היתר', approved, base, add);

  server.close();

  report.ok = report.checks.every((c) => c.ok);
  console.log('E2E_RESULT ' + JSON.stringify(report));
  setTimeout(() => app.exit(report.ok ? 0 : 1), 150);
}

app.whenReady().then(run).catch((err) => {
  // מדווחים גם את הבדיקות שכבר נאספו — כדי לראות איפה ההרצה נפלה
  report.checks.push({ name: 'harness', ok: false, detail: String((err && err.stack) || err) });
  report.ok = false;
  console.log('E2E_RESULT ' + JSON.stringify(report));
  setTimeout(() => app.exit(1), 150);
});
