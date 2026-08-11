// אזור זמן קבוע (ישראל) — כדי שבדיקות ה-DST למטה יהיו דטרמיניסטיות בכל מכונה
process.env.TZ = 'Asia/Jerusalem';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../scheduler.js');

test('parseHM and fmtHM roundtrip', () => {
  assert.equal(S.fmtHM(S.parseHM('07:30')), '07:30');
  assert.equal(S.fmtHM(S.parseHM('23:59')), '23:59');
  assert.equal(S.fmtHM(S.parseHM('00:00')), '00:00');
});

test('default schedule is blocklist and enabled', () => {
  const s = S.defaultSchedule();
  assert.equal(s.enabled, true);
  assert.equal(s.mode, 'blocklist');
  assert.equal(s.week.length, 7);
});

test('fresh install: default is open always unless blocked windows defined (not the opposite)', () => {
  // ללא שום חלון — המחשב פתוח בכל שעות היממה (blocklist),
  // ולא חסום (אלא אם הגדירו חלונות חסימה).
  const s = S.defaultSchedule();
  for (let d = 0; d < 7; d++) {
    for (const h of [0, 6, 12, 18, 23]) {
      assert.equal(
        S.getStatus(s, new Date(2026, 0, 4 + d, h, 30)).state,
        'allowed',
        'יום ' + d + ' ב-' + h + ':00 צריך להיות פתוח כברירת מחדל'
      );
    }
  }
  assert.equal(s.blockMessage, '', 'הודעה אישית צריכה להיות ריקה בהתקנה ראשונית');
  assert.equal(S.normalizeSchedule({}).blockMessage, '');
});

test('fresh install: adding a blocked window turns only that window blocked', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('09:00'), end: S.parseHM('14:00'), type: 'blocked' });
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 10, 0)).state, 'blocked');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 20, 0)).state, 'allowed');
});

test('blocked slot blocks, free time allows (blocklist mode)', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'blocked' });
  const inSlot = new Date(2026, 0, 4, 10, 0);   // Sunday 10:00
  const outSlot = new Date(2026, 0, 4, 20, 0);  // Sunday 20:00
  assert.equal(S.getStatus(s, inSlot).state, 'blocked');
  assert.equal(S.getStatus(s, outSlot).state, 'allowed');
});

test('allowlist mode allows only listed slots', () => {
  const s = S.defaultSchedule();
  s.mode = 'allowlist';
  s.week[0].slots.push({ start: S.parseHM('14:00'), end: S.parseHM('18:00'), type: 'allowed' });
  const inSlot = new Date(2026, 0, 4, 15, 0);
  const outSlot = new Date(2026, 0, 4, 10, 0);
  assert.equal(S.getStatus(s, inSlot).state, 'allowed');
  assert.equal(S.getStatus(s, outSlot).state, 'blocked');
});

test('overnight slot wraps to next day', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('22:00'), end: S.parseHM('06:00'), type: 'blocked' });
  const late = new Date(2026, 0, 4, 23, 30);   // Sunday 23:30 -> blocked
  const early = new Date(2026, 0, 5, 5, 30);   // Monday 05:30 -> still blocked (wrapped)
  const noon = new Date(2026, 0, 5, 12, 0);    // Monday 12:00 -> allowed
  assert.equal(S.getStatus(s, late).state, 'blocked');
  assert.equal(S.getStatus(s, early).state, 'blocked');
  assert.equal(S.getStatus(s, noon).state, 'allowed');
});

test('disabled schedule is always allowed', () => {
  const s = S.defaultSchedule();
  s.enabled = false;
  s.week[0].slots.push({ start: S.parseHM('00:00'), end: S.parseHM('23:59'), type: 'blocked' });
  const now = new Date(2026, 0, 4, 12, 0);
  const st = S.getStatus(s, now);
  assert.equal(st.state, 'allowed');
  assert.equal(st.enabled, false);
});

test('nextTransition reports correct time and direction', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'blocked' });
  const at = new Date(2026, 0, 4, 7, 0); // 1 hour before block starts
  const st = S.getStatus(s, at);
  assert.equal(st.state, 'allowed');
  assert.equal(st.next, 'blocked');
  assert.equal(st.nextAt.getHours(), 8);
  assert.equal(st.secondsUntilNext, 3600);
});

test('manual unlock overrides until next transition', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'blocked' });
  const unlockUntil = new Date(2026, 0, 4, 12, 0).getTime();
  s.manualUnlockUntil = unlockUntil;
  const at = new Date(2026, 0, 4, 10, 0);
  const st = S.getStatus(s, at);
  assert.equal(st.state, 'allowed');
  assert.equal(st.nextAt.getTime(), unlockUntil);
});

test('formatDuration in Hebrew', () => {
  assert.equal(S.formatDuration(0), 'עכשיו');
  assert.equal(S.formatDuration(60), 'דקה');
  assert.equal(S.formatDuration(3600), 'שעה');
  assert.equal(S.formatDuration(3660), 'שעה ודקה');
  assert.equal(S.formatDuration(7200), 'שעתיים');
});

test('sha256 known vectors', () => {
  assert.equal(S.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(S.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(S.sha256Hex('שלום'), S.sha256Hex('שלום'));
});

test('isValidPassword rules', () => {
  assert.equal(S.isValidPassword('1234'), true);
  assert.equal(S.isValidPassword('abcd'), true);
  assert.equal(S.isValidPassword('123'), false);   // קצר מדי
  assert.equal(S.isValidPassword('a'.repeat(21)), false); // ארוך מדי
  assert.equal(S.isValidPassword('has space'), false); // רווח אסור
  assert.equal(S.isValidPassword(''), false);
  assert.equal(S.isValidPassword(null), false);
});

test('normalizeSchedule fills missing days', () => {
  const s = S.normalizeSchedule({ mode: 'blocklist' });
  assert.equal(s.week.length, 7);
  assert.equal(s.enabled, true);
});

test('runAsAdmin flag defaults off and survives normalize', () => {
  assert.equal(S.defaultSchedule().runAsAdmin, false);
  assert.equal(S.normalizeSchedule({}).runAsAdmin, false);
  assert.equal(S.normalizeSchedule({ runAsAdmin: true }).runAsAdmin, true);
  assert.equal(S.normalizeSchedule({ runAsAdmin: 'yes' }).runAsAdmin, false);
});

test('nextTransition skips boundaries that do not change state', () => {
  const s = S.defaultSchedule();
  s.mode = 'allowlist';
  // שני חלונות מותרים סמוכים — הגבול ביניהם (12:00) אינו מעבר אמיתי
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('12:00'), type: 'allowed' });
  s.week[0].slots.push({ start: S.parseHM('12:00'), end: S.parseHM('18:00'), type: 'allowed' });
  const now = new Date(2026, 0, 4, 9, 0);
  const st = S.getStatus(s, now);
  assert.equal(st.state, 'allowed');
  // המעבר הבא צריך להיות לסיום 18:00 (חזרה למצב חסום), לא ל-12:00
  assert.equal(st.next, 'blocked');
  assert.equal(st.nextAt.getHours(), 18);
});

test('full-day blocked slot covers whole day', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: 0, end: 1440, type: 'blocked' });
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 0, 1)).state, 'blocked');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 12, 0)).state, 'blocked');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 23, 59)).state, 'blocked');
  // למחרת כבר לא חסום
  assert.equal(S.getStatus(s, new Date(2026, 0, 5, 10, 0)).state, 'allowed');
});

test('adjacent blocked+allowed slots produce both transitions', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('12:00'), type: 'blocked' });
  s.week[0].slots.push({ start: S.parseHM('12:00'), end: S.parseHM('18:00'), type: 'allowed' });
  const now = new Date(2026, 0, 4, 9, 0);
  const st = S.getStatus(s, now);
  assert.equal(st.state, 'blocked');
  assert.equal(st.next, 'allowed');
  assert.equal(st.nextAt.getHours(), 12);
});

test('exact boundary times: slot end is inclusive of the start minute only', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('09:00'), end: S.parseHM('10:00'), type: 'blocked' });
  // 09:00 בדיוק — חסום (התחלה כלולה)
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 9, 0)).state, 'blocked');
  // 10:00 בדיוק — מותר (הסוף לא כלול)
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 10, 0)).state, 'allowed');
  // 09:59 — חסום
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 9, 59)).state, 'blocked');
});

test('parseHM handles 24:00, midnight, invalid and out-of-range input', () => {
  assert.equal(S.parseHM('24:00'), 1440);
  assert.equal(S.parseHM('00:00'), 0);
  assert.equal(S.parseHM('25:00'), 60);   // 25:00 -> 01:00 (mod 1440)
  assert.equal(S.parseHM('10'), 600);     // '10' מתפרש כ-10:00
  assert.equal(S.parseHM(''), 0);
  assert.equal(S.parseHM('abc'), 0);
  assert.equal(S.parseHM(null), 0);
  assert.equal(S.parseHM(1440), 1440);    // מספרים נשמרים
  assert.equal(S.parseHM(-30), 0);        // שלילי -> 0
  assert.equal(S.parseHM(1500), 1440);    // מעל 24:00 -> capped
});

test('fmtHM shows 24:00 for end-of-day and normal times otherwise', () => {
  assert.equal(S.fmtHM(1440), '24:00');
  assert.equal(S.fmtHM(0), '00:00');
  assert.equal(S.fmtHM(1439), '23:59');
  assert.equal(S.fmtHM(720), '12:00');
});

test('overnight slot exact midnight boundaries', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('23:00'), end: S.parseHM('01:00'), type: 'blocked' });
  // יום ראשון 22:59 — מותר (לפני התחלה)
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 22, 59)).state, 'allowed');
  // 23:00 — חסום
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 23, 0)).state, 'blocked');
  // חצות (יום שני 00:00) — עדיין חסום (חלון מאתמול)
  assert.equal(S.getStatus(s, new Date(2026, 0, 5, 0, 0)).state, 'blocked');
  // 00:59 — חסום
  assert.equal(S.getStatus(s, new Date(2026, 0, 5, 0, 59)).state, 'blocked');
  // 01:00 בדיוק — מותר (סוף החלון לא כלול)
  assert.equal(S.getStatus(s, new Date(2026, 0, 5, 1, 0)).state, 'allowed');
});

test('nextTransition at exact boundary returns the following one', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'blocked' });
  // בדיוק בשעת התחלה (08:00) — מצב חסום, המעבר הבא הוא הסיום ב-16:00
  const st = S.getStatus(s, new Date(2026, 0, 4, 8, 0));
  assert.equal(st.state, 'blocked');
  assert.equal(st.next, 'allowed');
  assert.equal(st.nextAt.getHours(), 16);
});

test('manual unlock expires exactly at the boundary', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'blocked' });
  const until = new Date(2026, 0, 4, 10, 0).getTime();
  s.manualUnlockUntil = until;
  // לפני התום — מותר
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 9, 59)).state, 'allowed');
  // בדיוק בתום — כבר חסום (התום לא כלול)
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 10, 0)).state, 'blocked');
});

test('allowlist with no slots is blocked all week', () => {
  const s = S.defaultSchedule();
  s.mode = 'allowlist';
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 0, 0)).state, 'blocked');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 12, 0)).state, 'blocked');
  assert.equal(S.getStatus(s, new Date(2026, 0, 6, 23, 59)).state, 'blocked');
});

test('slot spanning Saturday-night boundary (week wrap)', () => {
  const s = S.defaultSchedule();
  // יום שבת (6) 22:00 - 02:00 -> חוצה ליום ראשון (0)
  s.week[6].slots.push({ start: S.parseHM('22:00'), end: S.parseHM('02:00'), type: 'blocked' });
  // שבת 23:00 חסום
  assert.equal(S.getStatus(s, new Date(2026, 0, 3, 23, 0)).state, 'blocked');
  // יום ראשון 01:00 — חסום (המשך החלון)
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 1, 0)).state, 'blocked');
  // יום ראשון 02:00 — מותר
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 2, 0)).state, 'allowed');
});

test('zero-length slot is filtered by normalize (no infinite block)', () => {
  const s = S.normalizeSchedule({
    week: [{ day: 0, slots: [{ start: 600, end: 600, type: 'blocked' }] }]
  });
  assert.equal(s.week[0].slots.length, 0);
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 12, 0)).state, 'allowed');
});

test('one-off allow override beats weekly block for its day', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'blocked' });
  const day = new Date(2026, 0, 4); // יום ראשון
  s.overrides = [{ date: S.dateKey(day), type: 'allow' }];
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 10, 0)).state, 'allowed');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 20, 0)).state, 'allowed');
  // למחרת — חוזר ללוח הרגיל
  assert.equal(S.getStatus(s, new Date(2026, 0, 5, 10, 0)).state, 'allowed');
});

test('one-off block override blocks the whole day', () => {
  const s = S.defaultSchedule();
  const day = new Date(2026, 0, 4);
  s.overrides = [{ date: S.dateKey(day), type: 'block' }];
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 9, 0)).state, 'blocked');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 23, 0)).state, 'blocked');
  assert.equal(S.getStatus(s, new Date(2026, 0, 5, 9, 0)).state, 'allowed');
});

test('normalizeSchedule normalizes overrides (dedupe by date, invalid dropped)', () => {
  const s = S.normalizeSchedule({ overrides: [
    { date: '2026-01-04', type: 'allow' },
    { date: '2026-01-04', type: 'block' }, // האחרון מנצח
    { date: 'bad-date', type: 'allow' },
    null
  ] });
  assert.equal(s.overrides.length, 1);
  assert.equal(s.overrides[0].type, 'block');
  assert.equal(s.overrides[0].date, '2026-01-04');
});

test('nextTransition accounts for override days', () => {
  // יום חסימה חד-פעמי — המעבר הבא הוא חצות (תום החריג)
  const s = S.defaultSchedule();
  const day = new Date(2026, 0, 4);
  s.overrides = [{ date: S.dateKey(day), type: 'block' }];
  const st = S.getStatus(s, new Date(2026, 0, 4, 12, 0));
  assert.equal(st.state, 'blocked');
  assert.equal(st.next, 'allowed');
  assert.equal(st.nextAt.getDate(), 5);
  assert.equal(st.nextAt.getHours(), 0);

  // יום חופש חד-פעמי ביום שני חסום — המעבר הבא הוא תחילת החסימה ב-08:00
  const s2 = S.defaultSchedule();
  s2.week[1].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'blocked' });
  s2.overrides = [{ date: '2026-01-04', type: 'allow' }]; // יום ראשון
  const st2 = S.getStatus(s2, new Date(2026, 0, 4, 12, 0));
  assert.equal(st2.state, 'allowed');
  assert.equal(st2.next, 'blocked');
  assert.equal(st2.nextAt.getDate(), 5);
  assert.equal(st2.nextAt.getHours(), 8);
});

test('nextTransition finds a weekly window more than three days away', () => {
  const s = S.defaultSchedule();
  // עכשיו יום ראשון; החלון הבא ביום חמישי — מעבר שאופק של 3 ימים מפספס.
  s.week[4].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('10:00'), type: 'blocked' });
  const st = S.getStatus(s, new Date(2026, 0, 4, 12, 0));
  assert.equal(st.next, 'blocked');
  assert.equal(st.nextAt.getDay(), 4);
  assert.equal(st.nextAt.getHours(), 8);
});

test('nextTransition finds a distant one-off override', () => {
  const s = S.defaultSchedule();
  s.mode = 'allowlist';
  s.overrides = [{ date: '2026-01-20', type: 'allow' }];
  const st = S.getStatus(s, new Date(2026, 0, 4, 12, 0));
  assert.equal(st.next, 'allowed');
  assert.equal(st.nextAt.getDate(), 20);
  assert.equal(st.nextAt.getHours(), 0);
});

test('normalizeSchedule drops impossible calendar dates in overrides', () => {
  const s = S.normalizeSchedule({ overrides: [{ date: '2026-02-30', type: 'block' }] });
  assert.equal(s.overrides.length, 0);
});

test('warning: fires within warnMinutes before an upcoming block', () => {
  const s = S.defaultSchedule();
  s.warnMinutes = 5;
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'blocked' });
  // 07:00 — שעתיים לפני החסימה: אין אזהרה
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 7, 0)).warning, false);
  // 07:57 — 3 דקות לפני: אזהרה פעילה
  const near = S.getStatus(s, new Date(2026, 0, 4, 7, 57));
  assert.equal(near.warning, true);
  assert.equal(near.state, 'allowed');
  assert.equal(near.next, 'blocked');
  assert.ok(near.warningSeconds > 0 && near.warningSeconds <= 180);
  // 08:00 — כבר חסום: לא "אזהרה" אלא חסימה בפועל
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 8, 0)).warning, false);
});

test('warning: zero warnMinutes disables the warning', () => {
  const s = S.defaultSchedule();
  s.warnMinutes = 0;
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'blocked' });
  const st = S.getStatus(s, new Date(2026, 0, 4, 7, 57));
  assert.equal(st.warning, false);
  assert.equal(st.warningSeconds, null);
});

test('warning: no warning when next transition is to allowed', () => {
  const s = S.defaultSchedule();
  s.warnMinutes = 5;
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('10:00'), type: 'blocked' });
  // בתוך החסימה, המעבר הבא הוא לפתיחה — אין אזהרה על חסימה
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 9, 30)).warning, false);
});

test('warning: allowlist mode warns before the default block returns', () => {
  const s = S.defaultSchedule();
  s.mode = 'allowlist';
  s.warnMinutes = 5;
  s.week[0].slots.push({ start: S.parseHM('09:00'), end: S.parseHM('10:00'), type: 'allowed' });
  // 09:58 — 2 דקות לפני שהחלון המותא מסתיים וחזרה לחסום: אזהרה
  const st = S.getStatus(s, new Date(2026, 0, 4, 9, 58));
  assert.equal(st.state, 'allowed');
  assert.equal(st.next, 'blocked');
  assert.equal(st.warning, true);
  assert.ok(st.warningSeconds <= 120);
});

test('warning: default warnMinutes is 5 and normalized', () => {
  assert.equal(S.defaultSchedule().warnMinutes, 5);
  assert.equal(S.normalizeSchedule({ warnMinutes: 7 }).warnMinutes, 7);
  assert.equal(S.normalizeSchedule({ warnMinutes: 0 }).warnMinutes, 0);
  assert.equal(S.normalizeSchedule({ warnMinutes: 200 }).warnMinutes, 60); // capped
  assert.equal(S.normalizeSchedule({ warnMinutes: -3 }).warnMinutes, 0);
  assert.equal(S.normalizeSchedule({}).warnMinutes, 5);
});

test('nextTransition is DST-safe: spring-forward day (23h day)', () => {
  // שישי 27.3.2026 — יום תחילת שעון הקיץ בישראל (היממה בת 23 שעות):
  // בניית שעות החלון חייבת להתבצע לפי שדות לוח שנה, לא לפי הוספת דקות לחצות.
  const s = S.defaultSchedule();
  s.week[5].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'blocked' });
  const day = new Date(2026, 2, 27);
  const dayLen = (new Date(2026, 2, 28) - day) / 3600e3;
  if (dayLen >= 24) return; // באזורי זמן ללא DST הבדיקה אינה רלוונטית
  const st = S.getStatus(s, new Date(2026, 2, 26, 20, 0)); // חמישי 20:00
  assert.equal(st.state, 'allowed');
  assert.equal(st.nextAt.getDay(), 5);
  assert.equal(st.nextAt.getHours(), 8, 'חלון 08:00 חייב להתחיל ב-08:00 גם ביום DST');
});

test('nextTransition is DST-safe: fall-back day (25h day)', () => {
  // ראשון 25.10.2026 — יום סיום שעון הקיץ בישראל (היממה בת 25 שעות)
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'blocked' });
  const day = new Date(2026, 9, 25);
  const dayLen = (new Date(2026, 9, 26) - day) / 3600e3;
  if (dayLen <= 24) return; // באזורי זמן ללא DST הבדיקה אינה רלוונטית
  const st = S.getStatus(s, new Date(2026, 9, 24, 20, 0)); // שבת 20:00
  assert.equal(st.state, 'allowed');
  assert.equal(st.nextAt.getDay(), 0);
  assert.equal(st.nextAt.getHours(), 8, 'חלון 08:00 חייב להתחיל ב-08:00 גם ביום DST');
});

/* ================= חסימת אינטרנט בלבד (netblock) ================= */

test('netblock slot survives normalize and yields the netblock state', () => {
  const s = S.normalizeSchedule({ week: [
    { day: 0, slots: [{ start: '08:00', end: '16:00', type: 'netblock' }] }
  ] });
  assert.equal(s.week[0].slots[0].type, 'netblock');
  // בתוך החלון — מצב netblock (מחשב פתוח, אינטרנט חסום)
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 10, 0)).state, 'netblock');
  // מחוץ לחלון — ברירת המחדל (blocklist = מותר)
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 20, 0)).state, 'allowed');
});

test('netblock ends at the boundary and produces the right transition', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'netblock' });
  const st = S.getStatus(s, new Date(2026, 0, 4, 10, 0));
  assert.equal(st.state, 'netblock');
  assert.equal(st.next, 'allowed');
  assert.equal(st.nextAt.getHours(), 16);
  // בדיוק בשעת הסיום — כבר מותר
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 16, 0)).state, 'allowed');
});

test('warning fires before an upcoming netblock window', () => {
  const s = S.defaultSchedule();
  s.warnMinutes = 5;
  s.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('16:00'), type: 'netblock' });
  const near = S.getStatus(s, new Date(2026, 0, 4, 7, 57));
  assert.equal(near.state, 'allowed');
  assert.equal(near.next, 'netblock');
  assert.equal(near.warning, true);
  assert.ok(near.warningSeconds > 0 && near.warningSeconds <= 180);
});

test('one-off netblock override blocks only the internet for the day', () => {
  const s = S.defaultSchedule();
  const day = new Date(2026, 0, 4);
  s.overrides = [{ date: S.dateKey(day), type: 'netblock' }];
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 9, 0)).state, 'netblock');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 23, 0)).state, 'netblock');
  assert.equal(S.getStatus(s, new Date(2026, 0, 5, 9, 0)).state, 'allowed');
});

test('netblock and blocked slots mix on the same day', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push(
    { start: S.parseHM('08:00'), end: S.parseHM('12:00'), type: 'blocked' },
    { start: S.parseHM('14:00'), end: S.parseHM('18:00'), type: 'netblock' }
  );
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 10, 0)).state, 'blocked');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 15, 0)).state, 'netblock');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 20, 0)).state, 'allowed');
});

test('showNetIcon defaults to true and survives normalize', () => {
  assert.equal(S.defaultSchedule().showNetIcon, true);
  assert.equal(S.normalizeSchedule({}).showNetIcon, true);
  assert.equal(S.normalizeSchedule({ showNetIcon: false }).showNetIcon, false);
});

test('showTorahQuotes defaults to true and survives normalize', () => {
  assert.equal(S.defaultSchedule().showTorahQuotes, true);
  assert.equal(S.normalizeSchedule({}).showTorahQuotes, true);
  assert.equal(S.normalizeSchedule({ showTorahQuotes: false }).showTorahQuotes, false);
});

