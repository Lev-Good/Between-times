'use strict';

const T = window.TimeScheduler;
const API = window.electronAPI;

/* ---------- אייקונים (SVG בלבד, ללא אימוג'ים) ---------- */
const ICONS = {
  warning: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  close: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  plus: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  alert: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>',
  download: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  swap: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V4m0 0L3 8m4-4 4 4"/><path d="M17 8v12m0 0 4-4m-4 4-4-4"/></svg>',
  allDays: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'
};

/* סוגי חלונות בלוח: מותר / חסום (נעילת מחשב מלאה) / אינטרנט (חסימת רשת בלבד) */
const TYPE_ORDER = ['blocked', 'netblock', 'allowed'];
const TYPE_LABELS = { blocked: 'חסום', netblock: 'אינטרנט', allowed: 'מותר' };

/* ---------- מצב ---------- */
let schedule = T.defaultSchedule();
let status = null;
let pinVerifiedAt = 0;      // מתי הוזנה סיסמה לאחרונה
let sessionUnlocked = false; // כניסה להגדרות עם סיסמה
let loginPending = false;
const PIN_SESSION_MS = 5 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const hasPin = () => API ? !!schedule.pinSet : !!schedule.pinHash;

/* ---------- טוסט ---------- */
let toastTimer = null;
function toast(msg, type = '') {
  const el = $('toast');
  const icon = type === 'success' ? ICONS.check : type === 'error' ? ICONS.alert : '';
  el.innerHTML = '<span class="toast-msg"></span>';
  if (icon) el.innerHTML = icon + el.innerHTML;
  el.querySelector('.toast-msg').textContent = msg;
  el.className = 'toast ' + type;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('fade-out'); // דעיכה חלקה ואז הסתרה
    setTimeout(() => { el.classList.add('hidden'); el.classList.remove('fade-out'); }, 320);
  }, 3200);
}

/* ---------- סשן כניסה להגדרות ---------- */
function applyLoginState() {
  const needsLogin = !!(hasPin() && !sessionUnlocked);
  $('loginModal').classList.toggle('hidden', !needsLogin);
  if (needsLogin) {
    $('app').classList.add('blurred');
    $('loginInput').value = ''; // אף פעם לא להשאיר סיסמה מהפעם הקודמת
    setTimeout(() => $('loginInput').focus(), 80);
  } else {
    $('app').classList.remove('blurred');
  }
}

async function tryLogin(pin) {
  if (!API) { sessionUnlocked = true; applyLoginState(); return; }
  const res = await API.unlockSession(pin);
  if (res && res.ok) {
    sessionUnlocked = true;
    pinVerifiedAt = Date.now();
    $('loginInput').value = ''; // הסיסמה נמחקת מיד אחרי הכניסה
    $('loginError').classList.add('hidden');
    applyLoginState();
    toast('ברוכים הבאים להגדרות', 'success');
  } else {
    $('loginError').classList.remove('hidden');
    $('loginInput').value = '';
    $('loginInput').focus();
  }
}

// נעילת הכניסה להגדרות — מופעלת כשהחלון מוסתר (מזעור/סגירה) או כשהתהליך
// הראשי מודיע שנעל את הסשן. כך כל פתיחה מחדש — משורת המשימות, מהמגש או
// מהתראה — דורשת סיסמת הורה, גם אם הדף לא נטען מחדש.
function lockLocalSession() {
  if (!hasPin()) return;
  sessionUnlocked = false;
  pinVerifiedAt = 0;
  applyLoginState();
}

/* ---------- PIN ---------- */
function pinRequired() {
  return !!(hasPin() && sessionUnlocked && Date.now() - pinVerifiedAt > PIN_SESSION_MS);
}

function promptPin() {
  return new Promise((resolve) => {
    const modal = $('pinModal');
    const input = $('pinModalInput');
    modal.classList.remove('hidden');
    input.value = '';
    setTimeout(() => input.focus(), 50);

    const done = (ok) => {
      const val = ok ? input.value : null;
      input.value = ''; // הסיסמה לא נשארת בשדה אחרי האישור
      modal.classList.add('hidden');
      resolve(val);
    };
    $('pinModalOk').onclick = () => done(true);
    $('pinModalCancel').onclick = () => done(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(null); };
  });
}

async function verifyPinSession() {
  // סשן נעול = מודאל הכניסה כבר על המסך — אסור להמשיך בפעולה
  // (הגנה לעומק; הלחיצות חסומות בכל מקרה ע"י ה-blur)
  if (hasPin() && !sessionUnlocked) return false;
  if (!pinRequired()) return true;
  const pin = await promptPin();
  if (pin == null) return false;
  let ok = false;
  if (API) {
    const res = await API.verifyPin(pin);
    ok = !!(res && res.ok);
  } else {
    ok = T.sha256Hex(pin) === schedule.pinHash;
  }
  if (!ok) { toast('סיסמה שגויה', 'error'); return false; }
  pinVerifiedAt = Date.now();
  return true;
}

/* ---------- חלונית אישור כללית ---------- */
function confirmDialog({ title, message, okLabel, danger }) {
  return new Promise((resolve) => {
    const modal = $('confirmModal');
    const okBtn = $('confirmOk');
    const cancelBtn = $('confirmCancel');
    $('confirmTitle').textContent = title || 'אישור';
    $('confirmMsg').textContent = message || '';
    okBtn.textContent = okLabel || 'אישור';
    okBtn.classList.toggle('btn-danger', !!danger);
    okBtn.classList.toggle('btn-primary', !danger);
    modal.classList.remove('hidden');
    const done = (val) => {
      modal.classList.add('hidden');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      resolve(val);
    };
    okBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
    cancelBtn.focus();
  });
}

/* ---------- שמירה ---------- */
async function persist() {
  // הגנה מפני נעילה פתאומית בזמן הגדרה: אם הלוח החדש חוסם את המחשב (או את
  // האינטרנט) בשעה הנוכחית — השמירה תפעיל את החסימה מיד, בעוד המשתמש באמצע
  // ההגדרה, וזה נראה כמו "קריסה" (מסך חסימה כהה שקופץ שוב ושוב). לכן מבקשים
  // אישור מפורש לפני השמירה; ביטול מחזיר את הלוח למצב שנשמר בפועל.
  // החלטת האישור משתמשת באותו timestamp שהגיע מה-Main (השעון המהימן),
  // ולא בשעון מערכת שעלול להיות שונה לאחר שינוי ידני.
  const confirmationNow = status && status.now ? new Date(status.now) : new Date();
  const stNow = T.getStatus(schedule, confirmationNow);
  const locksNow = !!(hasPin() && schedule.enabled &&
    (stNow.state === 'blocked' || stNow.state === 'netblock'));
  if (locksNow) {
    const net = stNow.state === 'netblock';
    const ok = await confirmDialog({
      title: net ? 'האינטרנט ייחסם מיד' : 'המחשב יינעל מיד',
      message: net
        ? 'הלוח החדש חוסם את האינטרנט בשעה הנוכחית — ברגע השמירה האינטרנט ייחסם מיד. לשמור בכל זאת?'
        : 'הלוח החדש חוסם את המחשב בשעה הנוכחית — ברגע השמירה המחשב יינעל מיד עם מסך חסימה במסך מלא. לשמור בכל זאת?',
      okLabel: 'שמור ונעל',
      danger: !net
    });
    if (!ok) {
      // ביטול — לחזור למצב שנשמר בפועל (הממשק כבר מציג את הלוח החדש)
      if (API) {
        try {
          const data = await API.getSettings();
          schedule = T.normalizeSchedule(data);
          schedule.pinSet = !!(data && data.pinSet);
        } catch { /* ignore */ }
      } else {
        try {
          const raw = localStorage.getItem('ben-hazmanim-settings');
          if (raw) schedule = T.normalizeSchedule(JSON.parse(raw));
        } catch { /* ignore */ }
      }
      renderWeek();
      applySettingsToUI();
      refreshStatus();
      return false;
    }
  }
  try {
    if (API) {
      const res = await API.saveSettings(schedule);
      if (!res || !res.ok) throw new Error((res && res.error) || 'שמירה נכשלה');
      if (res.warning) toast(res.warning);
    } else {
      localStorage.setItem('ben-hazmanim-settings', JSON.stringify(schedule));
    }
    flashSaved();
    return true;
  } catch (e) {
    toast('שגיאה בשמירה: ' + e.message, 'error');
    // כל כשלון שמירה — לבדוק אם השרת נעל את הסשן ולחזור למצב נעול בממשק
    // (רשת ביטחון למקרה שהממשק פספס את אירוע הנעילה).
    if (API) {
      API.getSession().then((s) => { if (s && !s.unlocked) lockLocalSession(); }).catch(() => {});
    }
    return false;
  }
}

function flashSaved() {
  const el = $('saveIndicator');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------- חלונות חופפים (בדיקה תצוגה בלבד) ----------
   החלטה בלוח היא "הראשון שמתאים זוכה" — חלונות חופפים עלולים לבלבל,
   אז מסמנים אותם באדום עם הסבר. */
function slotSegments(slot) {
  if (slot.end > slot.start) return [[slot.start, slot.end]];
  return [[slot.start, 1440], [0, slot.end]]; // חוצה חצות = שני קטעים
}
function segmentsOverlap(a, b) { return a[0] < b[1] && b[0] < a[1]; }
function overlappingIndexes(day) {
  const idx = new Set();
  for (let i = 0; i < day.slots.length; i++) {
    for (let j = i + 1; j < day.slots.length; j++) {
      for (const a of slotSegments(day.slots[i])) {
        for (const b of slotSegments(day.slots[j])) {
          if (segmentsOverlap(a, b)) { idx.add(i); idx.add(j); }
        }
      }
    }
  }
  return idx;
}

/* ---------- שעון 24 שעות (SVG) ---------- */
function polar(cx, cy, r, minutes) {
  const deg = (minutes / 1440) * 360;
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx, cy, r, fromMin, toMin) {
  const a = polar(cx, cy, r, fromMin);
  const b = polar(cx, cy, r, toMin);
  const large = (toMin - fromMin) > 720 ? 1 : 0;
  return 'M ' + a.x.toFixed(2) + ' ' + a.y.toFixed(2) +
    ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + b.x.toFixed(2) + ' ' + b.y.toFixed(2);
}

function svgEl(name, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function renderClock(day, now, todayIdx) {
  const svg = svgEl('svg', {
    viewBox: '0 0 100 100',
    class: 'day-clock',
    role: 'img',
    'aria-label': T.DAY_NAMES_HE[day.day] + ' — שעות היממה'
  });
  const cx = 50, cy = 50;

  // טבעת רקע
  svg.appendChild(svgEl('circle', { cx, cy, r: 46, class: 'clock-ring' }));

  // סימוני שעות — גדול כל 6 שעות, קטן כל שעה
  for (let m = 0; m < 1440; m += 60) {
    const big = m % 360 === 0;
    const a = polar(cx, cy, big ? 42 : 45, m);
    const b = polar(cx, cy, 46, m);
    svg.appendChild(svgEl('line', {
      x1: a.x.toFixed(2), y1: a.y.toFixed(2), x2: b.x.toFixed(2), y2: b.y.toFixed(2),
      class: big ? 'clock-tick big' : 'clock-tick'
    }));
  }

  // קשתות החלונות (חסום = אדום, מותר = ירוק)
  day.slots.forEach((slot) => {
    const segs = slot.end <= slot.start
      ? [[slot.start, 1440], [0, slot.end]]
      : [[slot.start, slot.end]];
    segs.forEach(([f, t]) => {
      svg.appendChild(svgEl('path', { d: arcPath(cx, cy, 37, f, t), class: 'clock-seg ' + slot.type }));
    });
  });

  // מחוג "עכשיו" ליום הנוכחי — קצר מהשעות המודפסות כדי לא לכסות אותן
  if (day.day === todayIdx) {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const tip = polar(cx, cy, 24, minutes);
    svg.appendChild(svgEl('line', {
      x1: cx, y1: cy, x2: tip.x.toFixed(2), y2: tip.y.toFixed(2), class: 'clock-now'
    }));
    svg.appendChild(svgEl('circle', { cx, cy, r: 2.2, class: 'clock-now-dot' }));
  }

  // שעות מודפסות — השעות האמיתיות של השעון (כל 3 שעות),
  // כך שהקשתות של החלונות תואמות בדיוק לשעות שמסמנים ומגדירים.
  // העיקריות (0/6/12/18) מודגשות, והבינוניות (3/9/15/21) קטנות יותר.
  [0, 3, 6, 9, 12, 15, 18, 21].forEach((h) => {
    const p = polar(cx, cy, 26.5, h * 60);
    const t = svgEl('text', {
      x: p.x.toFixed(2), y: p.y.toFixed(2),
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      class: 'clock-label' + (h % 6 === 0 ? ' major' : '')
    });
    t.textContent = String(h);
    svg.appendChild(t);
  });

  return svg;
}

/* ---------- רינדור לוח שבועי ---------- */
function renderWeek() {
  const grid = $('weekGrid');
  grid.innerHTML = '';
  const now = new Date();
  const todayIdx = now.getDay();

  schedule.week.forEach((day) => {
    const card = document.createElement('div');
    card.className = 'day-card' + (day.day === todayIdx ? ' today' : '');
    const overlapIdx = overlappingIndexes(day);

    const head = document.createElement('div');
    head.className = 'day-head';
    const name = document.createElement('div');
    name.className = 'day-name';
    name.textContent = T.DAY_NAMES_HE[day.day];
    if (day.day === todayIdx) {
      const badge = document.createElement('span');
      badge.className = 'today-badge';
      badge.textContent = 'היום';
      name.appendChild(badge);
    }
    head.appendChild(name);
    card.appendChild(head);

    if (overlapIdx.size > 0) {
      const warn = document.createElement('div');
      warn.className = 'overlap-note';
      warn.innerHTML = ICONS.warning + '<span>חלונות חופפים — רק הראשון בסדר יחול</span>';
      card.appendChild(warn);
    }

    card.appendChild(renderClock(day, now, todayIdx));

    const list = document.createElement('div');
    list.className = 'slot-list';
    day.slots.forEach((slot, i) => list.appendChild(renderSlotRow(day, i, overlapIdx.has(i))));
    card.appendChild(list);

    // כשאין חלונות ליום — להציג בבירור מה חל באותו יום לפי ברירת המחדל,
    // כדי שלא יהיה בלבול בין "פתוח תמיד" ל"חסום תמיד".
    // הניסוח "כברירת מחדל" מדויק גם כשיש חריג חד-פעמי לאותו תאריך
    // או חלון שחוצה חצות מהיום הקודם — אז בפועל היום יכול להיות חסום.
    if (day.slots.length === 0) {
      const note = document.createElement('div');
      const open = schedule.mode !== 'allowlist';
      note.className = 'day-empty-note ' + (open ? 'open' : 'blocked');
      note.textContent = open
        ? 'פתוח כברירת מחדל — הוסיפו חלון כדי לחסום'
        : 'חסום כברירת מחדל — הוסיפו חלון כדי להתיר';
      card.appendChild(note);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'add-slot';
    addBtn.innerHTML = ICONS.plus + '<span>הוסף חלון זמן</span>';
    addBtn.onclick = async () => {
      if (!(await verifyPinSession())) return;
      // ברירת המחדל של חלון חדש תלויה בשיטה: במצב "פתוח תמיד" — חלון חסום;
      // במצב "חסום תמיד" — חלון מותר. כך החלון החדש תמיד "משנה" משהו בלוח.
      const newSlotType = schedule.mode === 'allowlist' ? 'allowed' : 'blocked';
      day.slots.push({ start: T.parseHM('09:00'), end: T.parseHM('14:00'), type: newSlotType });
      renderWeek();
      persist();
      refreshStatus(); // עדכון מיידי של הספירה לאחור לפי הלוח החדש
    };
    card.appendChild(addBtn);

    grid.appendChild(card);
  });
  updateModeWarning(); // כמות החלונות המותרים השתנתה — עדכון האזהרה
}

function renderSlotRow(day, idx, isOverlap) {
  const slot = day.slots[idx];
  const row = document.createElement('div');
  row.className = 'slot-row ' + slot.type + (isOverlap ? ' overlap' : '');

  const start = document.createElement('input');
  start.type = 'time';
  start.className = 'time-input';
  start.value = T.fmtHM(slot.start);
  start.onchange = async () => {
    if (!(await verifyPinSession())) { renderWeek(); return; }
    slot.start = T.parseHM(start.value);
    renderWeek();
    persist();
    refreshStatus(); // עדכון מיידי של הספירה לאחור לפי הלוח החדש
  };

  const dash = document.createElement('span');
  dash.textContent = '–';
  dash.style.color = 'var(--muted)';

  const end = document.createElement('input');
  end.type = 'time';
  end.className = 'time-input';
  // input[type=time] אינו מקבל את הערך התקני 24:00 בדפדפנים. מציגים
  // 23:59 בשדה (הערך האחרון האפשרי בבורר) ומספקים כפתור מפורש לסוף היום,
  // כדי שלא נאבד חלונות שמסתיימים ב-1440 דקות או נציג שדה ריק.
  end.value = slot.end >= 1440 ? '23:59' : T.fmtHM(slot.end);
  end.title = slot.end >= 1440 ? 'סוף היום — 24:00' : 'שעת סיום';
  end.setAttribute('aria-label', slot.end >= 1440 ? 'שעת סיום — סוף היום, 24:00' : 'שעת סיום');
  end.onchange = async () => {
    if (!(await verifyPinSession())) { renderWeek(); return; }
    const parsed = T.parseHM(end.value);
    if (parsed == null) { renderWeek(); return; }
    slot.end = parsed;
    renderWeek();
    persist();
    refreshStatus(); // עדכון מיידי של הספירה לאחור לפי הלוח החדש
  };

  const endDayBtn = document.createElement('button');
  endDayBtn.type = 'button';
  endDayBtn.className = 'end-day-btn' + (slot.end >= 1440 ? ' active' : '');
  endDayBtn.textContent = slot.end >= 1440 ? '24:00' : 'סוף היום';
  endDayBtn.title = slot.end >= 1440 ? 'החלפה לסיום ב-23:59' : 'הגדרת סיום החלון ל-24:00 (סוף היום)';
  endDayBtn.setAttribute('aria-pressed', slot.end >= 1440 ? 'true' : 'false');
  endDayBtn.onclick = async () => {
    if (!(await verifyPinSession())) { renderWeek(); return; }
    slot.end = slot.end >= 1440 ? 1439 : 1440;
    renderWeek();
    persist();
    refreshStatus(); // עדכון מיידי של הספירה לאחור לפי הלוח החדש
  };

  const typeBtn = document.createElement('button');
  typeBtn.className = 'type-badge ' + slot.type;
  typeBtn.title = 'לחיצה מחליפה: חסום (נעילת מחשב מלאה) → אינטרנט (חסימת רשת בלבד) → מותר';
  typeBtn.innerHTML = '<span>' + (TYPE_LABELS[slot.type] || slot.type) + '</span>' + ICONS.swap;
  typeBtn.onclick = async () => {
    if (!(await verifyPinSession())) { renderWeek(); return; }
    slot.type = TYPE_ORDER[(TYPE_ORDER.indexOf(slot.type) + 1) % TYPE_ORDER.length];
    renderWeek();
    persist();
    refreshStatus(); // עדכון מיידי של הספירה לאחור לפי הלוח החדש
  };

  const del = document.createElement('button');
  del.className = 'del-btn';
  del.innerHTML = ICONS.close;
  del.title = 'מחק חלון';
  del.onclick = async () => {
    if (!(await verifyPinSession())) { renderWeek(); return; }
    day.slots.splice(idx, 1);
    renderWeek();
    persist();
    refreshStatus(); // עדכון מיידי של הספירה לאחור לפי הלוח החדש
  };

  // החלת החלון הזה על כל ימות השבוע — במקום להקליד אותו ידנית בכל יום בנפרד
  const allDaysBtn = document.createElement('button');
  allDaysBtn.className = 'all-days-btn';
  allDaysBtn.innerHTML = ICONS.allDays + '<span>כל הימים</span>';
  allDaysBtn.title = 'החלת החלון הזה על כל ימות השבוע';
  allDaysBtn.onclick = async () => {
    if (!(await verifyPinSession())) { renderWeek(); return; }
    let added = 0;
    schedule.week.forEach((d) => {
      const dup = d.slots.some((x) => x.start === slot.start && x.end === slot.end && x.type === slot.type);
      if (!dup) {
        d.slots.push({ start: slot.start, end: slot.end, type: slot.type });
        added++;
      }
    });
    renderWeek();
    persist();
    refreshStatus(); // עדכון מיידי של הספירה לאחור לפי הלוח החדש
    if (added > 0) toast('החלון הוחל על כל ימות השבוע', 'success');
    else toast('החלון כבר קיים בכל הימים');
  };

  row.append(start, dash, end, endDayBtn, typeBtn, allDaysBtn, del);
  return row;
}

/* ---------- ערכת נושא (מערכת / בהיר / כהה) ---------- */
const mqLight = window.matchMedia('(prefers-color-scheme: light)');

function resolvedTheme() {
  const t = schedule.theme || 'system';
  if (t === 'light') return 'light';
  if (t === 'dark') return 'dark';
  return mqLight.matches ? 'light' : 'dark';
}

function applyTheme() {
  const resolved = resolvedTheme();
  document.documentElement.dataset.theme = resolved;
  if (API) API.applyTheme(resolved);
  setThemeUI();
}

function setThemeUI() {
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    const on = btn.dataset.themeChoice === (schedule.theme || 'system');
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

// מעקב אחר שינוי ערכת המערכת — מתעדכן אוטומטית במצב "מערכת"
mqLight.addEventListener('change', () => {
  if ((schedule.theme || 'system') === 'system') applyTheme();
});

/* ---------- שעון חי + ספירה לאחור + טבעת התקדמות ---------- */
const RING_C = 2 * Math.PI * 44; // היקף טבעת ההתקדמות
let segmentStart = Date.now();
let lastNextAtTs = null;

function updateLiveClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const timeEl = $('liveClockTime');
  const dayEl = $('liveClockDay');
  if (timeEl) timeEl.textContent = hh + ':' + mm;
  if (dayEl) {
    dayEl.textContent = T.DAY_NAMES_HE[now.getDay()] + ' • ' +
      now.getDate() + '.' + String(now.getMonth() + 1).padStart(2, '0');
  }
}

// תחילת המקטע הנוכחי — מאפשר לטבעת למלא בצורה חלקה עד למעבר הבא
function trackSegment(st) {
  const nextAtTs = st.nextAt ? new Date(st.nextAt).getTime() : null;
  if (nextAtTs !== lastNextAtTs) {
    if (lastNextAtTs !== null && nextAtTs !== null && lastNextAtTs <= Date.now()) {
      segmentStart = lastNextAtTs; // המקטע הנוכחי התחיל במעבר הקודם
    } else {
      segmentStart = Date.now();
    }
    lastNextAtTs = nextAtTs;
  }
}

function renderRing(st) {
  const prog = $('ringProgress');
  if (!prog) return;
  trackSegment(st);
  let p = 0;
  if (st.nextAt) {
    const nextAtTs = new Date(st.nextAt).getTime();
    const total = nextAtTs - segmentStart;
    if (total > 0) p = Math.min(1, Math.max(0, (Date.now() - segmentStart) / total));
  }
  prog.style.strokeDasharray = (RING_C * p).toFixed(2) + ' ' + RING_C;
}

function fmtCountdown(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return (d > 0 ? d + ' ימים ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
}

function updateCountdown(st) {
  const el = $('countdownBig');
  if (!el) return;
  const blocked = st.state === 'blocked' || !!st.manualLock;
  const netblocked = st.state === 'netblock' && !st.manualLock;
  const label = el.closest('.countdown-row').querySelector('.countdown-label');
  if (st.secondsUntilNext != null && st.nextAt) {
    el.textContent = fmtCountdown(st.secondsUntilNext);
    label.textContent = blocked ? 'עד לפתיחה' : netblocked ? 'עד לפתיחת האינטרנט' : 'עד למעבר הבא';
    el.parentElement.classList.remove('hidden');
  } else {
    el.textContent = st.enabled === false ? 'האכיפה מושבתת' : '—';
    label.textContent = 'סטטוס';
  }
}

/* ---------- עדכון מצב ---------- */
function applyStatus(st) {
  status = st;
  const card = $('statusCard');
  const blocked = st.state === 'blocked' || !!st.manualLock;
  const netblocked = st.state === 'netblock' && !st.manualLock;
  card.classList.toggle('blocked', blocked);
  card.classList.toggle('netblock', netblocked);
  card.classList.toggle('allowed', !blocked && !netblocked);
  renderRing(st);
  updateCountdown(st);

  // באנר אזהרה לפני חסימה — ספירה לאחור חיה עד תחילת החסימה.
  // ללא סיסמה החסימה אינה פעילה כלל — לא מציגים אזהרה על חסימה שלא תתרחש.
  const warnEl = $('warnBanner');
  const warnOn = !!st.warning && st.pinSet && !blocked && st.warningSeconds != null;
  warnEl.classList.toggle('hidden', !warnOn);
  if (warnOn) {
    const net = st.next === 'netblock';
    $('warnText').textContent = net
      ? 'האינטרנט עומד להיחסם — המחשב יישאר פתוח לשימוש. החסימה מתחילה בעוד ' + T.formatDuration(st.warningSeconds)
      : 'שמרו את הקבצים וסיימו את העבודה — החסימה מתחילה בעוד ' + T.formatDuration(st.warningSeconds);
    $('warnCount').textContent = fmtCountdown(st.warningSeconds);
  }

  $('statusState').textContent = blocked ? 'חסום' : netblocked ? 'האינטרנט חסום' : 'מותר';
  // ללא סיסמה — החסימה אינה פעילה (הגנה מפני נעילה בלי מוצא)
  const noPin = !st.pinSet;
  $('statusTitle').textContent = blocked
    ? (st.manualLock ? 'המחשב חסום (נעילה ידנית)' : (noPin ? 'החסימה אינה פעילה — אין סיסמה' : 'המחשב חסום בשעה זו'))
    : netblocked
      ? (noPin ? 'חסימת האינטרנט אינה פעילה — אין סיסמה' : 'המחשב פתוח — האינטרנט חסום')
      : st.enabled === false
        ? 'האכיפה מושבתת'
        : 'המחשב פתוח לשימוש';

  const atLabel = st.nextAtLabel || (st.nextAt ? T.formatDate(new Date(st.nextAt)) : '');
  const inLabel = st.secondsUntilLabel || (st.secondsUntilNext != null ? T.formatDuration(st.secondsUntilNext) : '');
  if (blocked) {
    $('statusDetail').textContent = st.manualLock
      ? 'נעילה ידנית — פתחו עם סיסמה'
      : noPin
        ? 'המחשב לא ננעל בפועל — הגדירו סיסמה כדי שהחסימה תופעל'
        : 'הגישה תיפתח ' + atLabel + ' • בעוד ' + inLabel;
  } else if (netblocked) {
    $('statusDetail').textContent = noPin
      ? 'האינטרנט לא נחסם בפועל — הגדירו סיסמה כדי שחסימת האינטרנט תופעל'
      : 'האינטרנט ייפתח ' + atLabel + ' • בעוד ' + inLabel;
  } else if (st.nextAt) {
    const dir = st.next === 'blocked'
      ? 'המעבר הבא לחסימה'
      : st.next === 'netblock'
        ? 'המעבר הבא לחסימת אינטרנט'
        : 'המעבר הבא';
    $('statusDetail').textContent = dir + ': ' + atLabel + ' • בעוד ' + inLabel;
  } else {
    $('statusDetail').textContent = 'אין שינוי צפוי לפי הלוח הנוכחי';
  }

  // כפתור הפתיחה מוצג כשהמחשב חסום או שהאינטרנט חסום בלבד — כשהוא פתוח
  // לגמרי הוא חסר משמעות
  $('unlockBtn').classList.toggle('hidden', !(blocked || netblocked));
  const unlockLbl = $('unlockBtnLabel');
  if (unlockLbl) unlockLbl.textContent = netblocked ? 'פתח את האינטרנט (סיסמה)' : 'פתח את המחשב (סיסמה)';
}

async function refreshStatus() {
  try {
    const st = API ? await API.getStatus() : T.getStatus(schedule, new Date());
    applyStatus(st);
  } catch (e) { /* ignore */ }
}

/* ---------- שליטה ---------- */
// באנר ראשוני: בלי סיסמה אין חסימה פעילה — מנחה להגדיר סיסמה כדי שהגנה תופעל
function updateSetupBanner() {
  const el = $('setupBanner');
  if (el) el.classList.toggle('hidden', hasPin());
}

function applySettingsToUI() {
  $('masterToggle').checked = schedule.enabled;
  $('warnInput').value = schedule.warnMinutes;
  $('pinStatus').textContent = hasPin() ? 'מוגדרת' : 'לא מוגדרת';
  $('recoveryEmail').value = schedule.recoveryEmail || '';
  $('blockMessage').value = schedule.blockMessage || '';
  $('netIconToggle').checked = schedule.showNetIcon !== false;
  $('torahQuotesToggle').checked = schedule.showTorahQuotes !== false;
  $('allowedAppsToggle').checked = schedule.allowedAppsEnabled !== false;
  updateMasterLabel();
  setModeUI();
  applyTheme();
  renderOverrides();
  renderAllowedApps();
  updateSetupBanner();
}

function updateMasterLabel() {
  const label = $('masterLabel');
  label.textContent = schedule.enabled ? 'האכיפה פעילה' : 'האכיפה מושבתת';
  label.classList.toggle('off', !schedule.enabled);
}

function setModeUI() {
  $('modeBlocklist').classList.toggle('active', schedule.mode === 'blocklist');
  $('modeAllowlist').classList.toggle('active', schedule.mode === 'allowlist');
  updateModeWarning();
}

/* ---------- אזהרת מצב "התר" (חסום תמיד) ----------
   במצב "המחשב חסום תמיד" המחשב חסום בכל רגע שלא מסומן כ"מותר" — ואם אין
   אף חלון מותר, הוא חסום 24/7. זה מצב מסוכן להיתקל בו בטעות (נראה כמו
   באג: "אין זמנים מוגדרים אבל המחשב חסום"), לכן הוא מוצג באנר בולט. */
function updateModeWarning() {
  const warn = $('modeWarning');
  const text = $('modeWarningText');
  if (schedule.mode !== 'allowlist') { warn.classList.add('hidden'); return; }
  const allowedSlots = (schedule.week || []).reduce(
    (n, d) => n + (d.slots || []).filter((s) => s.type === 'allowed').length, 0);
  const allowedOverrides = (schedule.overrides || []).filter((o) => o.type === 'allow').length;
  if (allowedSlots + allowedOverrides === 0) {
    warn.className = 'mode-warning severe';
    text.innerHTML = '<strong>שימו לב — המחשב חסום כל הזמן!</strong> מצב "המחשב חסום תמיד" פעיל ואף חלון "מותר" לא מוגדר בלוח. אם זו לא הכוונה — חזרו למצב "המחשב פתוח תמיד" או הוסיפו חלונות "מותר".';
  } else {
    warn.className = 'mode-warning';
    text.innerHTML = '<strong>מצב "המחשב חסום תמיד" פעיל.</strong> המחשב פתוח רק בחלונות "מותר" שבלוח — בכל שאר הזמנים הוא חסום.';
  }
}

function showUpdateBanner(note) {
  $('updateText').textContent = 'עדכון זמין: גרסה ' + note.version;
  const notesEl = $('updateNotes');
  const notes = note.notes ? String(note.notes).trim() : '';
  notesEl.textContent = notes;
  notesEl.title = notes; // הטקסט המלא מוצג בריחוף אם הוא נחתך
  notesEl.style.display = notes ? '' : 'none'; // ללא הערות — ללא רווח ריק
  const btn = $('updateLink');
  const canDirect = !!(API && API.downloadUpdate);
  if (canDirect || (note.url && /^https?:\/\//.test(note.url))) {
    btn.style.display = '';
    btn.disabled = false;
    btn.classList.remove('downloading');
    btn.innerHTML = ICONS.download + '<span>הורד והתקן עכשיו</span>';
    btn.onclick = async () => {
      // הורדה ישירה בתוך התוכנה: מורידים את המתקין ומתקינים אותו אוטומטית
      // (התהליך הראשי שולח התקדמות ומפעיל את המתקין בשקט).
      if (canDirect) {
        btn.disabled = true;
        btn.classList.add('downloading');
        btn.innerHTML = ICONS.download + '<span>מוריד…</span>';
        const res = await API.downloadUpdate();
        if (!res || !res.ok) {
          btn.disabled = false;
          btn.classList.remove('downloading');
          btn.innerHTML = ICONS.download + '<span>הורד והתקן עכשיו</span>';
          toast((res && res.error) || 'ההורדה נכשלה', 'error');
        }
        // הצלחה: המתקין רץ — התוכנה תיסגר ותיפתח מחדש עם הגרסה החדשה
      } else if (API) {
        API.openExternal(note.url);
      }
    };
  } else {
    btn.style.display = 'none';
  }
  $('updateBanner').classList.remove('hidden');
}

// התקדמות ההורדה/ההתקנה (מ-update:download) — עדכון הכפתור באחוזים
function onUpdateProgress(p) {
  if (!p) return;
  const btn = $('updateLink');
  if (!btn || !btn.classList.contains('downloading')) return;
  if (p.phase === 'download') {
    btn.innerHTML = ICONS.download + '<span>מוריד… ' + (p.percent != null ? p.percent + '%' : '') + '</span>';
  } else if (p.phase === 'install') {
    btn.innerHTML = ICONS.download + '<span>מתקין…</span>';
  }
}

/* ---------- סטטיסטיקות (דשבורד) ---------- */
function dateKeyStr(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + dd;
}

const EVENT_LABELS = {
  'app-start': 'הפעלת התוכנה',
  'app-quit': 'סגירת התוכנה',
  'block-start': 'תחילת חסימה',
  'block-end': 'סיום חסימה',
  'netblock-start': 'תחילת חסימת אינטרנט',
  'netblock-end': 'סיום חסימת אינטרנט',
  'netblock-fail': 'כשלון חסימת אינטרנט',
  'warning-start': 'אזהרה לפני חסימה',
  'lock-manual': 'נעילה ידנית',
  'unlock-success': 'פתיחה עם סיסמה',
  'unlock-fail': 'ניסיון פתיחה נכשל',
  'settings': 'שינוי הגדרות'
};

function addBlockSpan(dayMap, from, to) {
  let cur = from;
  while (cur < to) {
    const d = new Date(cur);
    const dayEnd = new Date(d);
    dayEnd.setHours(23, 59, 59, 999);
    const segEnd = Math.min(to, dayEnd.getTime() + 1);
    const key = dateKeyStr(d);
    dayMap[key] = (dayMap[key] || 0) + (segEnd - cur) / 60000;
    cur = segEnd;
  }
}

function fmtHours(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return m <= 0 ? '0 דק׳' : m + ' דק׳';
  if (m === 0) return h + ' שעות';
  return h + ' שע׳ ' + m + ' דק׳';
}

async function renderStats() {
  const chart = $('barChart');
  if (!chart) return;
  const hasApi = !!API;
  const events = hasApi ? (await API.getActivity(2000)) : [];
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

  const dayBlocks = {};
  let blockStart = null;
  let todayUnlockOk = 0, todayUnlockFail = 0, todayManual = 0;
  for (const e of events) {
    if (e.type === 'block-start') blockStart = e.ts;
    else if (e.type === 'block-end') {
      if (blockStart != null) { addBlockSpan(dayBlocks, blockStart, e.ts); blockStart = null; }
    } else if (e.type === 'unlock-success' && e.ts >= todayStart.getTime()) todayUnlockOk++;
    else if (e.type === 'unlock-fail' && e.ts >= todayStart.getTime()) todayUnlockFail++;
    else if (e.type === 'lock-manual' && e.ts >= todayStart.getTime()) todayManual++;
  }
  if (blockStart != null) addBlockSpan(dayBlocks, blockStart, now); // עדיין חסום כרגע

  const todayKey = dateKeyStr(new Date());
  const blockedToday = Math.round(dayBlocks[todayKey] || 0);
  let blockedWeek = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(todayStart);
    d.setDate(d.getDate() - (6 - i));
    blockedWeek += Math.round(dayBlocks[dateKeyStr(d)] || 0);
  }

  $('statBlockedToday').textContent = hasApi ? fmtHours(blockedToday) : '—';
  $('statBlockedWeek').textContent = hasApi ? fmtHours(blockedWeek) : '—';
  $('statManualToday').textContent = hasApi ? String(todayManual) : '—';
  $('statUnlockOk').textContent = hasApi ? String(todayUnlockOk) : '—';
  $('statUnlockFail').textContent = hasApi ? String(todayUnlockFail) : '—';

  // גרף עמודות — 7 הימים האחרונים
  chart.innerHTML = '';
  const todayIdx = new Date().getDay();
  for (let i = 0; i < 7; i++) {
    const d = new Date(todayStart);
    d.setDate(d.getDate() - (6 - i));
    const min = dayBlocks[dateKeyStr(d)] || 0;
    const pct = Math.min(100, (min / 1440) * 100);
    const col = document.createElement('div');
    col.className = 'bar-col';
    col.title = T.DAY_NAMES_HE[d.getDay()] + ' — ' + fmtHours(min);
    const bar = document.createElement('div');
    bar.className = 'bar-fill' + (d.getDay() === todayIdx ? ' today' : '');
    bar.style.height = (pct > 0 ? Math.max(pct, 3) : 2) + '%';
    col.appendChild(bar);
    const lbl = document.createElement('div');
    lbl.className = 'bar-label';
    lbl.textContent = T.DAY_SHORT_HE[d.getDay()];
    col.appendChild(lbl);
    chart.appendChild(col);
  }

  // יומן פעילות אחרונה
  const list = $('eventList');
  list.innerHTML = '';
  const recent = events.slice(-30).reverse();
  if (!hasApi || recent.length === 0) {
    $('statsEmpty').classList.remove('hidden');
    list.classList.add('hidden');
  } else {
    $('statsEmpty').classList.add('hidden');
    list.classList.remove('hidden');
    recent.forEach((e) => {
      const row = document.createElement('div');
      row.className = 'event-row ' + e.type;
      const d = new Date(e.ts);
      const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      const t = document.createElement('span');
      t.className = 'event-time';
      t.textContent = time;
      const n = document.createElement('span');
      n.className = 'event-name';
      n.textContent = EVENT_LABELS[e.type] || e.type;
      row.append(t, n);
      list.appendChild(row);
    });
  }
}

/* ---------- חריגים חד-פעמיים ---------- */
function setOverride(date, type) {
  if (!schedule.overrides) schedule.overrides = [];
  const idx = schedule.overrides.findIndex((o) => o.date === date);
  if (idx >= 0) schedule.overrides[idx] = { date, type };
  else schedule.overrides.push({ date, type });
}

function tomorrowKey() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  return dateKeyStr(t);
}

function renderOverrides() {
  const list = $('overrideList');
  if (!list) return;
  list.innerHTML = '';
  const ovs = (schedule.overrides || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  if (ovs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'override-empty';
    empty.textContent = 'אין חריגים — הלוח השבועי חל בכל הימים';
    list.appendChild(empty);
    return;
  }
  ovs.forEach((ov) => {
    const [y, m, d] = ov.date.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const row = document.createElement('div');
    row.className = 'override-row';
    const info = document.createElement('div');
    info.className = 'override-info';
    const dateEl = document.createElement('strong');
    dateEl.textContent = d + '/' + m + '/' + y + ' (' + T.DAY_NAMES_HE[dt.getDay()] + ')';
    const badge = document.createElement('span');
    badge.className = 'type-badge ' + (ov.type === 'block' ? 'blocked' : ov.type === 'netblock' ? 'netblock' : 'allowed');
    badge.textContent = ov.type === 'block' ? 'חסום' : ov.type === 'netblock' ? 'האינטרנט חסום' : 'מותר';
    info.append(dateEl, badge);
    const del = document.createElement('button');
    del.className = 'del-btn';
    del.innerHTML = ICONS.close;
    del.title = 'הסר חריג';
    del.onclick = async () => {
      if (!(await verifyPinSession())) { renderOverrides(); return; }
      schedule.overrides = schedule.overrides.filter((o) => o.date !== ov.date);
      renderOverrides();
      persist();
    };
    row.append(info, del);
    list.appendChild(row);
  });
}

/* ---------- תוכנות תורניות מותרות בזמן חסימה ----------
   כל תוכנה מאומתת: חתומה דיגיטלית = אימות לפי חותם+שם מוצר (עמיד לעדכונים),
   לא חתומה = אימות לפי נתיב מלא + טביעת קובץ. תוכנות נלוות (תוספים שפועלים
   כתוכנה נפרדת לצד התוכנה הראשית) מאומתות באותה חומרה. */

// סמן אבטחה לכל תוכנה — לפי מצב האימות שלה
function appBadge(app) {
  const abs = /^[a-zA-Z]:[\\/]/.test(app.exe || '') || /^\\\\/.test(app.exe || '');
  if (app.mode === 'publisher' && app.publisher) {
    return { cls: 'secure', text: 'חתומה ואומתה — ' + app.publisher };
  }
  if (app.hash) return { cls: 'warn', text: 'לא חתומה — אומתה טביעת הקובץ' };
  if (abs) return { cls: 'warn', text: 'לא חתומה — נתיב מלא בלבד' };
  return { cls: 'danger', text: 'חסר נתיב מלא — בחרו מחדש' };
}

function appRow(app, onDelete) {
  const row = document.createElement('div');
  row.className = 'override-row allowed-app-row';
  const info = document.createElement('div');
  info.className = 'override-info';
  const name = document.createElement('strong');
  name.textContent = app.name;
  const exe = document.createElement('span');
  exe.className = 'app-exe';
  exe.textContent = app.exe;
  const badge = appBadge(app);
  const b = document.createElement('span');
  b.className = 'app-badge ' + badge.cls;
  b.textContent = badge.text;
  info.append(name, exe, b);
  const del = document.createElement('button');
  del.className = 'del-btn';
  del.innerHTML = ICONS.close;
  del.title = 'הסר תוכנה מהרשימה';
  del.onclick = onDelete;
  row.append(info, del);
  return row;
}

function renderAllowedApps() {
  const list = $('allowedAppsList');
  if (!list) return;
  list.innerHTML = '';
  const apps = schedule.allowedApps || [];
  if (apps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'override-empty';
    empty.textContent = 'לא הוגדרו תוכנות — בזמן החסימה כל התוכנות חסומות';
    list.appendChild(empty);
    return;
  }
  apps.forEach((app, i) => {
    list.appendChild(appRow(app, async () => {
      if (!(await verifyPinSession())) { renderAllowedApps(); return; }
      schedule.allowedApps.splice(i, 1);
      renderAllowedApps();
      persist();
      refreshStatus();
    }));

    // תוכנות נלוות (למשל תוספים שפועלים כתוכנה נפרדת)
    const comps = app.companions || [];
    comps.forEach((c, ci) => {
      const crow = appRow(c, async () => {
        if (!(await verifyPinSession())) { renderAllowedApps(); return; }
        app.companions.splice(ci, 1);
        renderAllowedApps();
        persist();
        refreshStatus();
      });
      crow.classList.add('companion');
      list.appendChild(crow);
    });

    const addComp = document.createElement('button');
    addComp.className = 'btn btn-ghost btn-sm add-companion';
    addComp.innerHTML = ICONS.plus + '<span>הוספת תוכנה נלווית</span>';
    addComp.title = 'הוספת תוכנה שפועלת יחד עם "' + app.name + '" (למשל תוסף נפרד)';
    addComp.onclick = async () => {
      if (!(await verifyPinSession())) { renderAllowedApps(); return; }
      if (!API) { toast('בחירה מהמחשב זמינה רק בגרסת המחשב המלאה'); return; }
      const res = await API.pickAllowedApp();
      if (!res || res.canceled) return;
      if (!res.path) { toast((res && res.error) || 'הבחירה נכשלה', 'error'); return; }
      if (!app.companions) app.companions = [];
      const dup = app.companions.some((c) => String(c.exe).toLowerCase() === String(res.path).toLowerCase());
      if (dup) { toast('התוכנה כבר נמצאת כנלווית'); return; }
      app.companions.push({
        name: res.name, exe: res.path, mode: res.mode,
        publisher: res.publisher || '', product: res.product || '', hash: res.hash || ''
      });
      renderAllowedApps();
      persist();
      refreshStatus();
      toast('התוכנה הנלווית נוספה — ' + (res.mode === 'publisher' ? 'חתימה אומתה' : 'טביעת הקובץ נשמרה'), 'success');
    };
    list.appendChild(addComp);
  });
}

// הוספת תוכנה ראשית לאחר בחירה מהמחשב (עם פרטי האימות מהתהליך הראשי)
function addAllowedApp(res) {
  if (!schedule.allowedApps) schedule.allowedApps = [];
  const dup = schedule.allowedApps.some((a) => String(a.exe).toLowerCase() === String(res.path).toLowerCase()) ||
    schedule.allowedApps.some((a) => (a.companions || []).some((c) => String(c.exe).toLowerCase() === String(res.path).toLowerCase()));
  if (dup) { toast('התוכנה כבר נמצאת ברשימה'); return; }
  schedule.allowedApps.push({
    name: res.name, exe: res.path, mode: res.mode,
    publisher: res.publisher || '', product: res.product || '', hash: res.hash || '',
    companions: []
  });
  renderAllowedApps();
  persist();
  refreshStatus();
  toast('התוכנה נוספה — ' + (res.mode === 'publisher' ? 'החתימה אומתה' : 'טביעת הקובץ נשמרה'), 'success');
}

/* ---------- סריקה אוטומטית של תוכנות תורניות מותקנות ----------
   הסריקה מוצאת תוכנות מוכרות (וורד, אוצריא, זית, אוצר החכמה, בר אילן)
   לפי רישום המערכת, קיצורי הדרך ונתיבי התקנה אופייניים — וההורה מוסיף
   אותן לרשימה בלחיצה אחת. ההוספה עוברת את אותו אימות מלא (חותם/טביעת
   קובץ) כמו הבחירה הידנית. */
let detectRan = false;

function isAppInAllowedList(p) {
  const path = String(p || '').toLowerCase();
  return (schedule.allowedApps || []).some((a) =>
    String(a.exe).toLowerCase() === path ||
    (a.companions || []).some((c) => String(c.exe).toLowerCase() === path));
}

async function scanKnownApps() {
  const list = $('detectedAppsList');
  const btn = $('detectAppsBtn');
  if (!list || !btn || !API) return;
  const prev = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'סורק…';
  try {
    const res = await API.detectAllowedApps();
    renderDetectedApps(res && res.ok ? (res.apps || []) : []);
  } catch {
    renderDetectedApps([]);
  } finally {
    btn.disabled = false;
    btn.innerHTML = prev;
  }
}

function renderDetectedApps(apps) {
  const list = $('detectedAppsList');
  if (!list) return;
  list.classList.remove('hidden');
  list.innerHTML = '';
  if (!apps.length) {
    const empty = document.createElement('div');
    empty.className = 'override-empty';
    empty.textContent = 'לא נמצאו תוכנות תורניות מותקנות — ניתן להוסיף ידנית באמצעות "בחירת תוכנה מהמחשב…"';
    list.appendChild(empty);
    return;
  }
  apps.forEach((app) => {
    const row = document.createElement('div');
    row.className = 'override-row allowed-app-row';
    const info = document.createElement('div');
    info.className = 'override-info';
    const name = document.createElement('strong');
    name.textContent = app.name;
    const exe = document.createElement('span');
    exe.className = 'app-exe';
    exe.textContent = app.path;
    info.append(name, exe);
    const added = isAppInAllowedList(app.path);
    if (added) {
      const ok = document.createElement('span');
      ok.className = 'app-badge secure';
      ok.textContent = 'כבר ברשימה';
      info.append(ok);
    }
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-sm';
    btn.disabled = added;
    if (added) {
      btn.textContent = '✓';
    } else {
      btn.textContent = 'הוסף';
      btn.onclick = async () => {
        if (!(await verifyPinSession())) { scanKnownApps(); return; }
        const res = await API.inspectAllowedAppPath(app.path);
        if (!res || !res.path) { toast((res && res.error) || 'הוספת התוכנה נכשלה', 'error'); return; }
        addAllowedApp(res);
        scanKnownApps(); // רענון — התוכנה מסומנת "כבר ברשימה"
      };
    }
    row.append(info, btn);
    list.appendChild(row);
  });
}

/* ---------- מצב ההגנה ---------- */
async function renderSecurity() {
  const list = $('securityList');
  if (!list) return;
  if (!API) {
    list.innerHTML = '<div class="check-item pending">זמין רק בגרסת המחשב המלאה</div>';
    return;
  }
  const sec = await API.getSecurity();
  const tamperHint = sec.lastTamper
    ? '⚠ התגלה ניסיון מחיקה/שיבוש של קבצי התוכנה — הקבצים שוחזרו (' + new Date(sec.lastTamper.ts).toLocaleString('he-IL') + ')'
    : 'עותק מוגן במחשב — מחיקת התוכנה לא תשבית את האכיפה';
  const items = [
    { ok: sec.pin, label: 'סיסמה מוגדרת', hint: 'מגנה על ההגדרות ועל מסך החסימה' },
    { ok: sec.enabled, label: 'האכיפה פעילה', hint: 'המתג הראשי דלוק' },
    { ok: sec.elevated, label: 'הרצה עם הרשאות מנהל', hint: 'מאפשרת חסימת כל המשתמשים' },
    { ok: sec.netElevated, label: 'חסימת אינטרנט בלבד זמינה', hint: 'חוק חומת אש ייעודי — דורש הרצה כמנהל' },
    { ok: sec.shared, label: 'הגדרות משותפות לכל המשתמשים', hint: 'כל חשבון במחשב נחסם לפי אותו לוח' },
    { ok: sec.protectedCopy, label: 'הגנה על קבצי התוכנה', hint: tamperHint },
    { ok: sec.recovery, label: 'מייל לשחזור סיסמה', hint: 'לשחזור אם שוכחים את הסיסמה' }
  ];
  list.innerHTML = '';
  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'check-item ' + (it.ok ? 'ok' : 'warn');
    const dot = document.createElement('span');
    dot.className = 'check-dot';
    const texts = document.createElement('div');
    texts.className = 'check-text';
    const strong = document.createElement('strong');
    strong.textContent = it.label;
    const hint = document.createElement('span');
    hint.textContent = it.hint;
    texts.append(strong, hint);
    row.append(dot, texts);
    list.appendChild(row);
  });
}  /* ---------- באנר הגדרת סיסמה ראשונית ---------- */
  const setupPinBtn = $('setupPinBtn');
  if (setupPinBtn) {
    setupPinBtn.onclick = () => {
      const settingsTab = document.querySelector('.tab-btn[data-tab="settings"]');
      if (settingsTab) settingsTab.click();
      setTimeout(() => { const pi = $('pinInput'); if (pi) pi.focus(); }, 180);
    };
  }

  /* ---------- לשוניות ---------- */
  function initTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');
  const activate = (name) => {
    buttons.forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panels.forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    if (name === 'stats') renderStats();
    if (name === 'settings') {
      renderSecurity(); renderOverrides();
      // סריקה אוטומטית חד-פעמית של תוכנות תורניות מותקנות (קריאה בלבד)
      if (!detectRan && API) { detectRan = true; scanKnownApps(); }
    }
  };
  buttons.forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));
  activate('schedule');
}

/* ---------- אתחול ---------- */
function init() {
  initTabs();
  const load = async () => {
    if (API) {
      const data = await API.getSettings();
      schedule = T.normalizeSchedule(data);
      schedule.pinSet = !!(data && data.pinSet);
      sessionUnlocked = !!(data && data.sessionUnlocked);
    } else {
      try {
        const raw = localStorage.getItem('ben-hazmanim-settings');
        if (raw) schedule = T.normalizeSchedule(JSON.parse(raw));
        sessionUnlocked = true; // בדפדפן אין נעילה
      } catch { /* ignore */ }
    }
    applySettingsToUI();
    renderWeek();
    refreshStatus();
    applyLoginState();
    updateLiveClock();
    renderSecurity();
    renderStats();
    setInterval(() => { refreshStatus(); updateLiveClock(); }, 1000);
    if (API) {
      API.onStatus(applyStatus);
      API.onUpdate(showUpdateBanner);
      if (API.onUpdateProgress) API.onUpdateProgress(onUpdateProgress);
      if (API.onSessionLock) API.onSessionLock(lockLocalSession);
      if (API.onNetblockError) API.onNetblockError((msg) => toast(msg, 'error'));
    }
  };

  load();

  // נעילה אוטומטית בהסתרה: מזעור/סגירה של החלון נועלים את הכניסה להגדרות,
  // ובפתיחה מחדש מסנכרנים את מצב הסשן מהתהליך הראשי (רשת ביטחון) — כך
  // אי אפשר לעקוף את הסיסמה דרך שורת המשימות.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      lockLocalSession();
      if (API) API.lockSession();
    } else if (API) {
      try {
        const s = await API.getSession();
        if (s && !s.unlocked) {
          lockLocalSession();
          setTimeout(() => { const i = $('loginInput'); if (i) i.focus(); }, 60);
        }
      } catch { /* ignore */ }
    }
  });

  /* ---------- כניסה ---------- */
  const doLogin = () => {
    if (loginPending) return;
    const pin = $('loginInput').value;
    if (!pin) return;
    loginPending = true;
    tryLogin(pin).finally(() => { loginPending = false; });
  };
  $('loginOk').onclick = doLogin;
  $('loginInput').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  $('loginForgot').onclick = async () => {
    if (!API) { toast('שחזור זמין רק בגרסת המחשב המלאה'); return; }
    const res = await API.sendRecovery();
    if (res && res.ok) {
      toast('הסיסמה נשלחה למייל המוגדר', 'success');
    } else {
      toast((res && res.error) || 'שליחה נכשלה', 'error');
    }
  };

  /* ---------- אירועים ---------- */

  $('masterToggle').onchange = async () => {
    const desired = $('masterToggle').checked;
    if (!(await verifyPinSession())) { $('masterToggle').checked = schedule.enabled; return; }
    schedule.enabled = desired;
    updateMasterLabel();
    await persist();
    refreshStatus();
  };

  $('modeBlocklist').onclick = async () => {
    if (!(await verifyPinSession())) { setModeUI(); return; }
    schedule.mode = 'blocklist';
    setModeUI();
    renderWeek(); // עדכון מיידי של כרטיסי הימים (טקסט "פתוח/חסום כברירת מחדל")
    persist();
    refreshStatus();
  };
  $('modeAllowlist').onclick = async () => {
    if (!(await verifyPinSession())) { setModeUI(); return; }
    schedule.mode = 'allowlist';
    setModeUI();
    renderWeek(); // עדכון מיידי של כרטיסי הימים (טקסט "פתוח/חסום כברירת מחדל")
    persist();
    refreshStatus();
  };

  $('warnInput').onchange = async () => {
    const val = Math.max(0, Math.min(60, Math.round(Number($('warnInput').value) || 0)));
    if (!(await verifyPinSession())) { $('warnInput').value = schedule.warnMinutes; return; }
    schedule.warnMinutes = val;
    $('warnInput').value = val;
    persist();
  };

  /* ---------- מחק הכל: ניקוי כל חלונות הזמן של כל הימים ----------
     מי שרוצה להתחיל להגדיר מחדש בלי למחוק כל חלון בנפרד. כדי למנוע
     מחיקה בטעות — לחיצה ראשונה מזינה את הכפתור ("בטוח?"), ולחיצה
     שנייה בתוך 4 שניות מבצעת את המחיקה. */
  let clearAllArmed = false;
  let clearAllTimer = null;
  const disarmClearAll = () => {
    clearAllArmed = false;
    if (clearAllTimer) { clearTimeout(clearAllTimer); clearAllTimer = null; }
    const b = $('clearAllBtn');
    if (b) { b.textContent = 'מחק הכל'; b.classList.remove('armed'); }
  };
  $('clearAllBtn').onclick = async () => {
    if (!(await verifyPinSession())) return;
    const btn = $('clearAllBtn');
    const hasSlots = schedule.week.some((d) => d.slots.length > 0);
    if (!hasSlots) { toast('אין חלונות זמן למחוק'); return; }
    if (!clearAllArmed) {
      clearAllArmed = true;
      btn.textContent = 'בטוח? לחצו שוב לאישור';
      btn.classList.add('armed');
      clearAllTimer = setTimeout(disarmClearAll, 4000);
      return;
    }
    disarmClearAll();
    schedule.week.forEach((d) => { d.slots = []; });
    renderWeek();
    persist();
    refreshStatus(); // עדכון מיידי של הספירה לאחור לפי הלוח החדש
    toast('כל חלונות הזמן נמחקו — אפשר להתחיל להגדיר מחדש', 'success');
  };

  /* ---------- ערכת נושא ---------- */
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.onclick = async () => {
      // שינוי ערכת נושא הוא שינוי ויזואלי בלבד — אינו דורש אימות חוזר
      schedule.theme = btn.dataset.themeChoice;
      applyTheme();
      await persist();
    };
  });

  /* ---------- אייקון צף כשאינטרנט חסום ---------- */
  $('netIconToggle').onchange = async () => {
    if (!(await verifyPinSession())) {
      $('netIconToggle').checked = schedule.showNetIcon !== false;
      return;
    }
    schedule.showNetIcon = $('netIconToggle').checked;
    await persist();
    refreshStatus(); // התהליך הראשי יפתח/יסגור את האייקון לפי ההגדרה החדשה
  };

  /* ---------- משפטי עידוד מהמקורות במסך החסימה ---------- */
  $('torahQuotesToggle').onchange = async () => {
    if (!(await verifyPinSession())) {
      $('torahQuotesToggle').checked = schedule.showTorahQuotes !== false;
      return;
    }
    schedule.showTorahQuotes = $('torahQuotesToggle').checked;
    await persist();
    refreshStatus(); // מסך החסימה יקבל את ההגדרה החדשה
  };

  /* ---------- תוכנות תורניות מותרות בזמן חסימה ---------- */
  $('allowedAppsToggle').onchange = async () => {
    if (!(await verifyPinSession())) {
      $('allowedAppsToggle').checked = schedule.allowedAppsEnabled !== false;
      return;
    }
    schedule.allowedAppsEnabled = $('allowedAppsToggle').checked;
    await persist();
    refreshStatus(); // מסך החסימה יקבל את ההגדרה החדשה
  };

  $('allowedAppPickBtn').onclick = async () => {
    if (!(await verifyPinSession())) { renderAllowedApps(); return; }
    if (!API) { toast('בחירה מהמחשב זמינה רק בגרסת המחשב המלאה'); return; }
    const res = await API.pickAllowedApp();
    if (!res || res.canceled) return;
    if (!res.path) { toast((res && res.error) || 'הבחירה נכשלה', 'error'); return; }
    addAllowedApp(res);
  };

  // סריקה אוטומטית של תוכנות תורניות מותקנות (קריאה בלבד — ללא סיסמה),
  // ההוספה עצמה תבקש את הסיסמה.
  const scanBtn = $('detectAppsBtn');
  if (scanBtn) {
    scanBtn.onclick = () => { if (API) scanKnownApps(); };
  }

  /* ---------- סיסמה ---------- */
  $('pinSaveBtn').onclick = async () => {
    const pin = $('pinInput').value;
    const confirm = $('pinInput2').value;
    if (!T.isValidPassword(pin)) {
      toast('הסיסמה צריכה להיות 4-20 תווים ללא רווחים', 'error');
      return;
    }
    if (pin !== confirm) {
      toast('הסיסמאות אינן תואמות — הזינו שוב', 'error');
      $('pinInput2').value = '';
      return;
    }
    let oldPin = null;
    if (hasPin()) {
      oldPin = await promptPin();
      if (oldPin == null) return;
    }
    let ok = false;
    if (API) {
      const res = await API.setPin(pin, oldPin);
      ok = !!(res && res.ok);
      if (!ok) toast((res && res.error) || 'שגיאה בשמירת סיסמה', 'error');
    } else {
      schedule.pinHash = T.sha256Hex(pin);
      ok = true;
    }
    if (!ok) return;
    if (!API) schedule.pinHash = T.sha256Hex(pin);
    schedule.pinSet = true;
    pinVerifiedAt = Date.now();
    $('pinInput').value = '';
    $('pinInput2').value = '';
    $('pinStatus').textContent = 'מוגדרת';
    await persist();
    toast('הסיסמה נשמרה', 'success');
  };

  $('pinClearBtn').onclick = async () => {
    if (!hasPin()) return;
    const oldPin = await promptPin();
    if (oldPin == null) return;
    let ok = false;
    if (API) {
      const res = await API.clearPin(oldPin);
      ok = !!(res && res.ok);
      if (!ok) toast((res && res.error) || 'סיסמה שגויה', 'error');
    } else {
      schedule.pinHash = null;
      ok = true;
    }
    if (!ok) return;
    if (!API) schedule.pinHash = null;
    schedule.pinSet = false;
    pinVerifiedAt = Date.now();
    $('pinStatus').textContent = 'לא מוגדרת';
    $('pinInput').value = '';
    $('pinInput2').value = '';
    await persist();
    toast('הסיסמה בוטלה', 'success');
  };

  /* ---------- שחזור ועדכונים ---------- */
  const saveSecurity = async (silent) => {
    // אימות סיסמה לפני שינוי המצב — כדי לא להשאיר ערכים לא שמורים בממשק
    if (!(await verifyPinSession())) { applySettingsToUI(); return; }
    schedule.recoveryEmail = $('recoveryEmail').value.trim();
    await persist();
    if (!silent) toast('הגדרות האבטחה נשמרו', 'success');
  };
  ['recoveryEmail'].forEach((id) => {
    $(id).addEventListener('change', () => saveSecurity(false));
  });

  $('testRecoveryBtn').onclick = async () => {
    if (!API) { toast('שליחה זמינה רק בגרסת המחשב המלאה'); return; }
    if (!(await verifyPinSession())) return;
    await saveSecurity(true);
    toast('שולח את הסיסמה למייל…');
    const res = await API.sendRecovery();
    if (res && res.ok) {
      toast('הסיסמה נשלחה למייל המוגדר', 'success');
    } else {
      toast((res && res.error) || 'שליחה נכשלה', 'error');
    }
  };

  $('checkUpdateBtn').onclick = async () => {
    if (!API) { toast('בדיקת עדכונים זמינה רק בגרסת המחשב המלאה'); return; }
    if (!(await verifyPinSession())) return;
    await saveSecurity(true);
    const res = await API.checkUpdate();
    if (res && res.ok && res.update) {
      showUpdateBanner(res.update);
    } else if (res && res.ok) {
      toast('הגרסה שלך עדכנית', 'success');
    } else {
      toast((res && res.error) || 'לא ניתן לבדוק עדכונים', 'error');
    }
  };

  $('updateClose').onclick = () => $('updateBanner').classList.add('hidden');

  /* ---------- הודעה אישית במסך החסימה ---------- */
  $('blockMessage').addEventListener('change', async () => {
    if (!(await verifyPinSession())) { $('blockMessage').value = schedule.blockMessage || ''; return; }
    schedule.blockMessage = $('blockMessage').value.trim();
    await persist();
    toast('הודעת מסך החסימה נשמרה', 'success');
  });

  /* ---------- חריגים חד-פעמיים ---------- */
  const addOverrideUi = async (date, type) => {
    if (!(await verifyPinSession())) { renderOverrides(); return; }
    setOverride(date, type);
    renderOverrides();
    await persist();
    toast('החריג נשמר — ' + (type === 'block' ? 'חסום' : 'מותר') + ' כל היום', 'success');
  };
  $('addOverrideBtn').onclick = async () => {
    const date = $('overrideDate').value;
    if (!date) { toast('בחרו תאריך תחילה', 'error'); return; }
    await addOverrideUi(date, $('overrideType').value);
  };
  $('allowTomorrowBtn').onclick = () => addOverrideUi(tomorrowKey(), 'allow');
  $('blockTomorrowBtn').onclick = () => addOverrideUi(tomorrowKey(), 'block');

  /* ---------- גיבוי ושחזור ---------- */
  $('backupExportBtn').onclick = async () => {
    if (!API) { toast('גיבוי זמין רק בגרסת המחשב המלאה'); return; }
    if (!(await verifyPinSession())) return;
    const res = await API.exportBackup();
    if (res && res.ok) toast('הגיבוי נשמר בהצלחה', 'success');
    else toast((res && res.error) || 'הגיבוי נכשל', 'error');
  };
  $('backupImportBtn').onclick = async () => {
    if (!API) { toast('שחזור זמין רק בגרסת המחשב המלאה'); return; }
    if (!(await verifyPinSession())) return;
    const res = await API.importBackup();
    if (res && res.ok) {
      toast('ההגדרות שוחזרו', 'success');
      if (API) {
        const data = await API.getSettings();
        schedule = T.normalizeSchedule(data);
      }
      applySettingsToUI();
      renderWeek();
      renderSecurity();
      refreshStatus();
      applyLoginState();
    } else {
      toast((res && res.error) || 'השחזור נכשל', 'error');
    }
  };

  /* ---------- הסרת התוכנה ---------- */
  $('uninstallBtn').onclick = () => {
    if (!API) { toast('הסרה זמינה רק בגרסת המחשב המלאה'); return; }
    $('uninstallModal').classList.remove('hidden');
    $('uninstallInput').value = '';
    setTimeout(() => $('uninstallInput').focus(), 50);
  };
  const doUninstall = async () => {
    const pin = $('uninstallInput').value;
    if (hasPin() && !pin) { toast('הזינו את סיסמת ההורה', 'error'); return; }
    $('uninstallOk').disabled = true;
    try {
      const res = await API.uninstallApp(pin);
      if (res && res.ok) {
        $('uninstallModal').classList.add('hidden');
        toast('התוכנה מוסרת מהמחשב…');
        // התוכנה נסגרת מיד — ה-Uninstaller משלים את ההסרה לבד
      } else {
        $('uninstallInput').value = '';
        toast((res && res.error) || 'ההסרה נכשלה', 'error');
      }
    } catch (e) {
      toast('שגיאה בהסרה: ' + (e && e.message ? e.message : ''), 'error');
    } finally {
      $('uninstallOk').disabled = false;
    }
  };
  $('uninstallOk').onclick = doUninstall;
  $('uninstallCancel').onclick = () => $('uninstallModal').classList.add('hidden');
  $('uninstallInput').onkeydown = (e) => {
    if (e.key === 'Enter') doUninstall();
    if (e.key === 'Escape') $('uninstallModal').classList.add('hidden');
  };

  /* ---------- נעילה / פתיחה ---------- */
  $('lockNowBtn').onclick = () => {
    if (API) {
      API.lockNow();
      toast('המחשב נחסם — מסך החסימה פעיל', 'success');
    } else {
      toast('נעילה זמינה רק בגרסת המחשב המלאה');
    }
  };

  $('unlockBtn').onclick = async () => {
    if (!API) {
      toast('פתיחה זמינה רק בגרסת המחשב המלאה');
      return;
    }
    const pin = await promptPin();
    if (pin == null) return;
    const res = await API.unlockNow(pin);
    if (res.ok) {
      toast('המחשב נפתח עד המעבר הבא', 'success');
      refreshStatus();
    } else {
      toast(res.error || 'סיסמה שגויה', 'error');
    }
  };

  /* ---------- קרדיט ---------- */
  $('siteLink').onclick = (e) => {
    e.preventDefault();
    if (API) API.openExternal('https://digital.levtov.uk/');
  };
  $('mailLink').onclick = (e) => {
    e.preventDefault();
    if (API) API.openExternal('mailto:mytovmail@gmail.com');
  };

  if (API) {
    API.getVersion().then((v) => {
      $('version').textContent = v;
      $('version2').textContent = v;
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
