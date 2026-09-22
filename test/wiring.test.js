// בדיקת חיווט סטטית — "רשת ביטחון" לכל החיבורים השקטים שקשה לתפוס בבדיקות
// הרצה: מזהי DOM שהקוד מתייחס אליהם מול ה-HTML, ערוצי IPC בשני הכיוונים, ומזהי
// התראה/אירוע, וכן קבצים שנדרשים ע"י main.js מול רשימת הקבצים שבאריזה.
//
// הסיבה לקיומה: חיבור שבור (id ששונה ב-HTML, handler שנמחק, קובץ שלא הוסף
// ל-"files" ב-package.json) אינו מפיל שום בדיקה קיימת — הוא פשוט לא עובד
// בשקט. הבדיקה הזו נכשלת מיד.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ==================== איסוף מזהים מ-HTML ==================== */

// מזהים שמופיעים ב-HTML: id="..." וגם id='...'
function idsInHtml(src) {
  const out = new Set();
  for (const m of src.matchAll(/\bid=["']([A-Za-z0-9_-]+)["']/g)) out.add(m[1]);
  return out;
}

// מזהים שנוצרים בזמן ריצה ב-JS: el.id = '...' או id: '...' ב-createElement
function idsCreatedInJs(src) {
  const out = new Set();
  for (const m of src.matchAll(/\.id\s*=\s*["']([A-Za-z0-9_-]+)["']/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bid=["']([A-Za-z0-9_-]+)["']/g)) out.add(m[1]);
  return out;
}

// כל המזהים שהקוד מתייחס אליהם: $('x'), getElementById('x'), querySelector('#x')
function idsReferencedInJs(src) {
  const out = new Set();
  for (const m of src.matchAll(/\$\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g)) out.add(m[1]);
  for (const m of src.matchAll(/getElementById\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g)) out.add(m[1]);
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)/g)) out.add(m[1]);
  return out;
}

/* ==================== 1) מזהי DOM מול הקוד ==================== */

// כל דף והקוד שרץ עליו. inline = סקריפט בתוך קובץ ה-HTML עצמו.
const PAGES = [
  { html: 'renderer/index.html', scripts: ['renderer/app.js', 'renderer/tour.js', 'renderer/guide-content.js'] },
  { html: 'renderer/file-explorer.html', scripts: ['renderer/file-explorer.js'] },
  { html: 'renderer/block.html', scripts: ['renderer/block.html'] },
  { html: 'renderer/site-browser.html', scripts: ['renderer/site-browser.html'] },
  { html: 'renderer/quit.html', scripts: ['renderer/quit.html'] },
  { html: 'renderer/netblock-icon.html', scripts: ['renderer/netblock-icon.html'] }
];

test('wiring: כל id שהקוד מתייחס אליו קיים בדף שלו', () => {
  const problems = [];
  for (const page of PAGES) {
    const html = read(page.html);
    const available = idsInHtml(html);
    const dynamic = new Set();
    for (const s of page.scripts) for (const id of idsCreatedInJs(read(s))) dynamic.add(id);
    for (const s of page.scripts) {
      for (const id of idsReferencedInJs(read(s))) {
        if (!available.has(id) && !dynamic.has(id)) {
          problems.push(page.html + ' ← ' + s + ' מתייחס ל-#' + id + ' שאינו קיים בדף');
        }
      }
    }
  }
  assert.deepEqual(problems, [], 'חיבורי DOM שבורים:\n' + problems.join('\n'));
});

/* ==================== 2) ערוצי IPC ==================== */

// ערוץ שמוגדר בתהליך הראשי עם ipcMain.handle / ipcMain.on
function handledChannels(src) {
  const out = new Set();
  for (const m of src.matchAll(/ipcMain\.(?:handle|on|handleOnce)\(\s*["']([^"']+)["']/g)) out.add(m[1]);
  return out;
}

// ערוץ שה-renderer שולח: invoke / sendSync / send
function invokedChannels(src) {
  const out = new Set();
  for (const m of src.matchAll(/ipcRenderer\.(?:invoke|sendSync|send)\(\s*["']([^"']+)["']/g)) out.add(m[1]);
  return out;
}

// אירוע שמהתהליך הראשי נשלח לחלון, ואירוע שה-renderer מאזין לו
function sentEvents(src) {
  const out = new Set();
  for (const m of src.matchAll(/webContents\.send\(\s*["']([^"']+)["']/g)) out.add(m[1]);
  for (const m of src.matchAll(/\.send\(\s*["']([a-zA-Z0-9:_-]+)["']/g)) out.add(m[1]);
  return out;
}
function listenedEvents(src) {
  const out = new Set();
  for (const m of src.matchAll(/ipcRenderer\.on\(\s*["']([^"']+)["']/g)) out.add(m[1]);
  return out;
}

// ה-preload-ים שמותקנים בכל חלון (לפי webPreferences.preload ב-main.js)
const PRELOADS = ['preload.js', 'renderer/site-browser-preload.js'];

test('wiring: כל ערוץ שה-preload קורא לו מוגדר בתהליך הראשי', () => {
  const handled = handledChannels(read('main.js'));
  const problems = [];
  for (const p of PRELOADS) {
    for (const ch of invokedChannels(read(p))) {
      if (!handled.has(ch)) problems.push(p + ' קורא לערוץ ללא handler: ' + ch);
    }
  }
  assert.deepEqual(problems, [], 'ערוצי IPC שבורים:\n' + problems.join('\n'));
});

test('wiring: כל handler חשוף ל-renderer (אין handler \"יתום\")', () => {
  const handled = handledChannels(read('main.js'));
  const exposed = new Set();
  for (const p of PRELOADS) for (const ch of invokedChannels(read(p))) exposed.add(ch);
  // ערוצים שנשלחים מהתהליך הראשי כ-hook פנימי אינם צריכים חשיפה
  const internal = new Set();
  const problems = [];
  for (const ch of handled) {
    if (!exposed.has(ch) && !internal.has(ch)) problems.push('handler שאין לו דרך להגיע אליו: ' + ch);
  }
  assert.deepEqual(problems, [], 'handlers מיותרים:\n' + problems.join('\n'));
});

test('wiring: כל אירוע שנשלח לחלון מואזן ב-preload', () => {
  const sent = sentEvents(read('main.js'));
  const listened = new Set();
  for (const p of PRELOADS) for (const e of listenedEvents(read(p))) listened.add(e);
  // ערוצי invoke אינם אירועים — מסננים כדי שלא ייחשבו כשליחה ללא מאזין
  const problems = [];
  for (const e of sent) {
    if (e.includes(':') && !listened.has(e)) continue; // ערוץ בקשה/תשובה, לא אירוע
    if (!listened.has(e)) problems.push('אירוע שנשלח בלי מאזין ב-preload: ' + e);
  }
  assert.deepEqual(problems, [], 'אירועי IPC ללא מאזין:\n' + problems.join('\n'));
});

test('wiring: כל preload שמוגדר בחלון קיים כקובץ', () => {
  const main = read('main.js');
  const declared = new Set();
  for (const m of main.matchAll(/preload:\s*path\.join\(__dirname,\s*([^)]+)\)/g)) {
    // בונה את הנתיב מהביטויים שבמחרוזת: 'renderer', 'site-browser-preload.js' וכו'
    const parts = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    if (parts.length) declared.add(parts.join('/'));
  }
  const problems = [];
  for (const rel of declared) {
    if (!fs.existsSync(path.join(ROOT, rel))) problems.push('preload חסר: ' + rel);
  }
  assert.deepEqual(problems, [], 'preload-ים חסרים:\n' + problems.join('\n'));
});

/* ==================== 3) קבצים מול האריזה ==================== */

test('wiring: כל קובץ ש-main.js דורש כלול ב-build.files', () => {
  const pkg = JSON.parse(read('package.json'));
  const files = (pkg.build && pkg.build.files) || [];
  const problems = [];

  // כל require יחסי מתוך main.js (הנתיב של הסקריפט הראשי חייב להיות באריזה)
  for (const m of read('main.js').matchAll(/require\(\s*["']\.\/([^"']+)["']\s*\)/g)) {
    const rel = m[1];
    if (!fs.existsSync(path.join(ROOT, rel))) { problems.push('require לקובץ שאינו קיים: ' + rel); continue; }
    const covered = files.some((f) => f === rel || (f.endsWith('/**/*') && rel.startsWith(f.slice(0, -5))));
    if (!covered) problems.push('קובץ נדרש שאינו ב-build.files (לא ייכנס לגרסה המותקנת): ' + rel);
  }

  // כל רשומה שאינה דפוס גלוב חייבת להתקיים בפועל
  for (const f of files) {
    if (f.includes('*')) continue;
    if (!fs.existsSync(path.join(ROOT, f))) problems.push('רשומה ב-build.files שאינה קיימת: ' + f);
  }

  assert.deepEqual(problems, [], 'בעיות אריזה:\n' + problems.join('\n'));
});

/* ==================== 4) מזהי מדריך וסיור ==================== */

test('wiring: כל כותרת ב-guide-content.js מוגדרת כפרק שלם', () => {
  const win = {};
  const src = read('renderer/guide-content.js');
  // eslint-disable-next-line no-new-func
  const guide = new Function('window', src + ';return window.BenHazmanimGuide;')(win);
  assert.ok(guide && Array.isArray(guide.SECTIONS), 'guide-content.js לא מייצא SECTIONS');
  assert.ok(Array.isArray(guide.TOUR_STEPS), 'guide-content.js לא מייצא TOUR_STEPS');
  const ids = new Set();
  for (const s of guide.SECTIONS) {
    assert.ok(s.id, 'פרק מדריך בלי id');
    assert.ok(s.title && String(s.title).trim(), 'פרק מדריך בלי כותרת: ' + s.id);
    assert.ok(s.content && String(s.content).trim(), 'פרק מדריך בלי תוכן: ' + s.id);
    assert.ok(!ids.has(s.id), 'id כפול בפרקי המדריך: ' + s.id);
    ids.add(s.id);
  }
  // לכל פרק בסיור יש יעד ו-מזהה ייחודי
  const stepIds = new Set();
  for (const st of guide.TOUR_STEPS) {
    assert.ok(st.target, 'שלב סיור בלי target');
    assert.ok(st.title && st.text, 'שלב סיור בלי כותרת/טקסט');
    assert.ok(!stepIds.has(st.id), 'id כפול בשלבי הסיור: ' + st.id);
    stepIds.add(st.id);
  }
});
