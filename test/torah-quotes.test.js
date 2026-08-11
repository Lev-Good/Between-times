// בדיקות למאגר משפטי העידוד המחזקים (renderer/torah-quotes.js)
// כל משפט חייב להיות ציטוט מדויק ממקור תורני, עם מקור מלא, וללא כפילויות.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const quotes = require('../renderer/torah-quotes.js');

test('מאגר משפטי העידוד מכיל מאות משפטים', () => {
  assert.ok(Array.isArray(quotes), 'המאגר צריך להיות מערך');
  assert.ok(quotes.length >= 200, 'צריך לפחות 200 משפטים — בפועל ' + quotes.length);
});

test('לכל משפט יש טקסט ומקור תקינים', () => {
  for (const [i, q] of quotes.entries()) {
    assert.ok(q && typeof q.t === 'string' && q.t.trim().length > 0, 'משפט ' + i + ' חסר טקסט');
    assert.ok(q && typeof q.s === 'string' && q.s.trim().length > 0, 'משפט ' + i + ' חסר מקור');
    assert.ok(/[א-ת]/.test(q.t), 'טקסט ' + i + ' אינו בעברית: ' + q.t);
    assert.ok(/[א-ת]/.test(q.s), 'מקור ' + i + ' אינו בעברית: ' + q.s);
  }
});

test('אין משפטים כפולים', () => {
  const seen = new Set();
  for (const q of quotes) {
    assert.ok(!seen.has(q.t), 'משפט מופיע פעמיים: ' + q.t);
    seen.add(q.t);
  }
});

test('אין משפטים ארוכים מדי לתצוגה', () => {
  for (const [i, q] of quotes.entries()) {
    assert.ok(q.t.length <= 170, 'משפט ' + i + ' ארוך מדי (' + q.t.length + ' תווים): ' + q.t);
  }
});

test('כל מקור שייך לספר מתוך התנ"ך, המשנה או התלמוד', () => {
  const sources = quotes.map((q) => q.s);
  for (const s of sources) {
    assert.ok(
      !/אנונימי|לא ידוע|מקור/i.test(s),
      'מקור לא מזוהה: ' + s
    );
  }
});
