// בדיקות UI למסך החסימה (renderer/block.html) — ללא דפדפן אמיתי וללא תלות חדשה.
// מריצים את הסקריפט האינליין האמיתי של block.html בתוך DOM מינימלי שמוגדר כאן,
// כך שהלוגיקה של המסך (render) נבדקת בדיוק כפי שהיא — כולל התיקון שבו במצב
// קובץ הגדרות פגום הופיעה ההודעה "פתחו את ההגדרות" בלי שום כפתור לפתיחה.
process.env.TZ = 'Asia/Jerusalem';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ================= ניטור מרווחי זמן — כדי שהבדיקות יסתיימו =================
   מסך החסימה קובע מרווחים (שעון חי, שאילת סטטוס, החלפת משפטי עידוד).
   בלי ניקוי הם היו משאירים את התהליך חי אחרי הבדיקות. */

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

test.afterEach(() => {
  activeIntervals.forEach((id) => realClearInterval(id));
  activeIntervals.length = 0;
});

test.after(() => {
  activeIntervals.forEach((id) => realClearInterval(id));
  activeIntervals.length = 0;
  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;
});

/* ================= אלמנט DOM מינימלי ================= */

function makeElement(id) {
  const el = {
    id: String(id),
    style: {},
    dataset: {},
    className: '',
    type: '',
    value: '',
    innerHTML: '',
    textContent: '',
    offsetWidth: 0,
    clientWidth: 800,
    clientHeight: 600,
    onclick: null,
    children: [],
    _classes: new Set(),
    _listeners: {},
    classList: {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      toggle: (c, force) => {
        const want = force === undefined ? !el._classes.has(c) : !!force;
        if (want) el._classes.add(c); else el._classes.delete(c);
        return want;
      },
      contains: (c) => el._classes.has(c)
    },
    addEventListener(ev, cb) {
      (el._listeners[ev] = el._listeners[ev] || []).push(cb);
    },
    removeEventListener() {},
    contains() { return false; },
    querySelector(sel) {
      return el._querySel || (el._querySel = makeElement(el.id + ' > ' + sel));
    },
    querySelectorAll() { return []; },
    appendChild(child) { el.children.push(child); return child; },
    focus() {},
    getContext() { return null; },
    // לחיצה מפעילה גם onclick וגם מאזיני 'click' — כמו בדפדפן
    click() {
      if (typeof el.onclick === 'function') el.onclick();
      (el._listeners.click || []).forEach((cb) => cb({ target: el }));
    }
  };
  return el;
}

/* ================= טעינת מסך החסימה האמיתי ================= */

function loadBlockScreen() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'block.html'), 'utf8');
  // הסקריפט האינליין הוא בלוק ה-<script> האחרון (הקודמים הם src חיצוניים)
  const script = html.split('<script>').pop().split('</script>')[0];

  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  // 4 אפשרויות הרקע — לקוד של בורר הרקעים (querySelectorAll('.bg-option'))
  const bgOptions = ['blobs', 'fluid', 'particles', 'aurora'].map((bg) => {
    const o = makeElement('bg-option:' + bg);
    o.dataset.bg = bg;
    return o;
  });

  // תהליך ראשי מדומה — נקודות הכניסה שמסך החסימה משתמש בהן
  const api = {
    openSettingsCalls: 0,
    unlockCalls: [],
    setBlockBgCalls: [],
    launchAllowedAppCalls: [],
    sendRecoveryCalls: 0,
    completeRecoveryCalls: [],
    onStatus(cb) { this.statusCb = cb; },
    async getStatus() {
      return this.current || {
        state: 'blocked', pinSet: true, manualLock: false, now: Date.now(),
        theme: 'dark', blockBg: 'blobs', showTorahQuotes: true, nextAt: null, secondsUntilNext: null
      };
    },
    async openSettings() { this.openSettingsCalls++; return { ok: true }; },
    async unlockNow(pin) { this.unlockCalls.push(pin); return { ok: false, error: 'מצב בדיקה' }; },
    async setBlockBg(bg) { this.setBlockBgCalls.push(bg); return { ok: true }; },
    async launchAllowedApp(app) { this.launchAllowedAppCalls.push(app); return { ok: true }; },
    async sendRecovery() { this.sendRecoveryCalls++; return { ok: false, error: 'לא הוגדר מייל שחזור' }; },
    async completeRecovery(code, pin) { this.completeRecoveryCalls.push([code, pin]); return { ok: false }; }
  };
  api.current = null;

  const document = {
    documentElement: { dataset: {} },
    body: { dataset: {}, classList: makeElement('body').classList },
    getElementById: el,
    querySelectorAll(sel) {
      if (sel === '.bg-option') return bgOptions;
      return [];
    },
    createElement(tag) { return makeElement('created:' + tag); },
    addEventListener() {}
  };

  const window = {
    TimeScheduler: require('../scheduler.js'),
    TORAH_QUOTES: require('../renderer/torah-quotes.js'),
    electronAPI: api,
    devicePixelRatio: 1,
    innerWidth: 1920,
    innerHeight: 1080,
    prompt: () => null,
    initWebGLFluidSimulation: () => {},
    stopWebGLFluidSimulation: () => {}
  };

  const sandbox = {
    window, document,
    setInterval: global.setInterval,   // הגרסאות המנוטרות — מנוקות אחרי כל בדיקה
    clearInterval: global.clearInterval,
    setTimeout, clearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    console
  };

  // חשיפת הפונקציות לבדיקות: render מקבל סטטוס ומצייר את המסך בדיוק כמו
  // שהתהליך הראשי שולח אותו. כל השאר נשאר סגור בתוך הסקריפט המקורי.
  vm.runInNewContext(script + '\n;globalThis.__screenTest = { render: (s) => render(s) };', sandbox);

  return {
    el, api, bgOptions, document, window,
    render: sandbox.__screenTest.render
  };
}

// סטטוס בסיסי שנשלח ממסך החסימה הרגיל (כמו buildStatus בתהליך הראשי)
function blockedStatus(extra) {
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
    secondsUntilNext: null
  }, extra || {});
}

/* ================= בדיקות: מצב קובץ הגדרות פגום ================= */

test('block: במצב קובץ פגום מוצג רק כפתור ההגדרות — בלי דלג, בלי שדה סיסמה ובלי כפתור תחתון', () => {
  const { el, render } = loadBlockScreen();
  render(blockedStatus({ configError: true, pinSet: false }));

  // הדרך היחידה החוצה: כפתור "פתחו את ההגדרות — תיקון ושחזור" בתוך
  // תיבה גלויה, עם חיווי click מחובר (הוא מוצג דרך תיבת האב).
  assert.equal(el('configFaultBox').style.display, '', 'תיבת תקלת ההגדרות מוצגת');
  assert.equal(typeof el('configFaultSettingsBtn').onclick, 'function', 'כפתור התיקון מחובר לפעולה');

  // כל מה שיכול להיראות כמו פתיחה — מוסתר
  assert.equal(el('pinBox').style.display, 'none', 'שדה הסיסמה מוסתר');
  assert.equal(el('pinToggle').style.display, 'none', 'כפתור "פתיחה בסיסמת ההורה" מוסתר');
  assert.equal(el('noPinBox').style.display, 'none', 'תיבת "אין סיסמה" מוסתרת — כך שכפתור הדלג וטופס הגדרת הסיסמה אינם נגישים');
  assert.equal(el('settingsFooterBtn').style.display, 'none', 'כפתור ההגדרות הקטן מוסתר (הגדול כבר מוצג)');

  assert.ok(el('lockMsg').textContent.includes('פגום'), 'ההודעה מסבירה שמדובר בקובץ פגום: ' + el('lockMsg').textContent);
});

test('block: כפתור התיקון במצב קובץ פגום פותח את חלון ההגדרות', () => {
  const { el, api, render } = loadBlockScreen();
  render(blockedStatus({ configError: true, pinSet: false }));

  el('configFaultSettingsBtn').click();
  assert.equal(api.openSettingsCalls, 1, 'לחיצה על כפתור התיקון פותחת את ההגדרות');
});

test('block: במצב חסימה רגיל (עם סיסמה) כפתור ההגדרות הקטן זמין תמיד ופותח את ההגדרות', () => {
  const { el, api, render } = loadBlockScreen();
  render(blockedStatus({ pinSet: true }));

  assert.equal(el('configFaultBox').style.display, 'none', 'ללא תקלת הגדרות — אין תיבת תקלה');
  assert.equal(el('settingsFooterBtn').style.display, '', 'כפתור ההגדרות הקטן מוצג תמיד בחסימה עם סיסמה');
  assert.equal(el('noPinBox').style.display, 'none');
  assert.equal(el('pinToggle').style.display, '', 'כפתור פתיחה בסיסמה מוצג');
  assert.equal(el('pinBox').style.display, 'none', 'השדה עצמו מוסתר עד הלחיצה');

  el('settingsFooterBtn').click();
  assert.equal(api.openSettingsCalls, 1, 'כפתור ההגדרות הקטן פותח את חלון ההגדרות');

  // לחיצה על "פתיחה בסיסמת ההורה" מרחיבה את שדה הסיסמה
  el('pinToggle').click();
  assert.equal(el('pinToggle').style.display, 'none');
  assert.equal(el('pinBox').style.display, '', 'שדה הסיסמה נפתח בלחיצה');
});

test('block: במצב ללא סיסמה מוצגים הגדרת הסיסמה וכפתור הדלג — וכפתור הדלג מבצע unlockNow("")', () => {
  const { el, api, render } = loadBlockScreen();
  render(blockedStatus({ pinSet: false }));

  assert.equal(el('noPinBox').style.display, '', 'תיבת "אין סיסמה" מוצגת');
  assert.equal(el('configFaultBox').style.display, 'none');
  assert.equal(el('settingsFooterBtn').style.display, 'none');
  assert.equal(el('pinBox').style.display, 'none');

  el('skipPinBtn').click();
  assert.equal(api.unlockCalls.length, 1, 'כפתור הדלג שולח unlockNow עם סיסמה ריקה');
  assert.equal(api.unlockCalls[0], '');
});

test('block: תיקון קובץ ההגדרות מהמסך מחזיר את הפקדים הרגילים (התרחיש שתוקן)', () => {
  // הבאג הקריטי: מסך החסימה אמר "פתחו את ההגדרות" בלי שום כפתור.
  // התרחיש המלא: תקלה -> כפתור תיקון -> השמירה מתקנת -> המסך חוזר לקדמותו.
  const { el, render } = loadBlockScreen();
  render(blockedStatus({ configError: true, pinSet: false }));
  assert.equal(el('configFaultBox').style.display, '', 'התקלה מוצגת בהתחלה');

  render(blockedStatus({ configError: false, pinSet: false }));
  assert.equal(el('configFaultBox').style.display, 'none', 'לאחר התיקון תיבת התקלה נעלמת');
  assert.equal(el('noPinBox').style.display, '', 'תיבת "אין סיסמה" חוזרת');

  render(blockedStatus({ configError: false, pinSet: true }));
  assert.equal(el('settingsFooterBtn').style.display, '', 'בחסימה עם סיסמה כפתור ההגדרות הקטן חוזר');
  assert.equal(el('pinToggle').style.display, '', 'וכפתור פתיחה בסיסמה חוזר');
});

test('block: הסבר "חסום לפי ברירת המחדל" מוצג בחסימה רגילה אך מוסתר במצב קובץ פגום', () => {
  const { el, render } = loadBlockScreen();

  render(blockedStatus({ configError: false, pinSet: true, blockedByDefault: true }));
  assert.equal(el('blockReason').classList.contains('hidden'), false,
    'בלי תקלה — ההסבר על ברירת המחדל מוצג');

  render(blockedStatus({ configError: true, pinSet: false, blockedByDefault: true }));
  assert.equal(el('blockReason').classList.contains('hidden'), true,
    'בקובץ פגום — ההסבר מוסתר, ההודעה על התקלה כבר מוצגת למעלה');
});

test('block: תוכנות תורניות מוצגות במסך החסימה גם בזמן נעילה ידנית (manualLock)', () => {
  const { el, render } = loadBlockScreen();
  render(blockedStatus({
    manualLock: true,
    allowedAppsEnabled: true,
    allowedApps: [{ name: 'אוצריא', exe: 'C:\\Apps\\Otzaria.exe' }]
  }));

  assert.equal(el('studyAppsWrap').style.display, '', 'תיבת תוכנות לימוד מוצגת גם בנעילה ידנית');
  assert.equal(el('studyAppsList').children.length, 1, 'אוצריא מוצגת ברשימה');
  assert.equal(el('studyAppsList').children[0].querySelector('span').textContent, 'אוצריא');
});

test('block: ברירת מחדל של דף החסימה היא מסך נקי עם כפתור שעונים ותוכנות תורניות מהירות', () => {
  const { el, api, render } = loadBlockScreen();
  render(blockedStatus({
    pinSet: true,
    allowedAppsEnabled: true,
    allowedApps: [{ name: 'אוצריא', exe: 'C:\\Apps\\Otzaria.exe' }]
  }));

  // כברירת מחדל, חלונית החסימה סגורה (מוסתרת) והמסך הנקי מוצג
  assert.equal(el('blockScreen').classList.contains('modal-hidden'), true, 'חלונית החסימה מוסתרת כברירת מחדל');
  assert.equal(el('cleanView').classList.contains('clean-view-dimmed'), false, 'מסך הרקע הנקי גלוי ופעיל');

  // כפתור תוכנה תורנית מהירה מוצג במסך הנקי
  assert.equal(el('quickStudyWrap').style.display, '', 'תיבת תוכנות מהירות במסך הנקי גלויה');
  assert.equal(el('quickStudyList').children.length, 1, 'אוצריא מוצגת ברשימה המהירה');
  assert.equal(el('quickStudyList').children[0].querySelector('span').textContent, 'אוצריא');

  // לחיצה על תוכנה מהירה במסך הנקי מפעילה אותה
  el('quickStudyList').children[0].click();
  assert.equal(api.launchAllowedAppCalls.length, 1, 'התוכנה הופעלה בלחיצה מהירה');

  // לחיצה על כפתור השעונים פותחת את החלונית
  el('openClocksBtn').click();
  assert.equal(el('blockScreen').classList.contains('modal-hidden'), false, 'חלונית השעונים נפתחה');

  // לחיצה על כפתור סגירה מחזירה למסך הנקי
  el('closeModalBtn').click();
  assert.equal(el('blockScreen').classList.contains('modal-hidden'), true, 'החלונית נסגרה וחזרה לרקע הנקי');
});
