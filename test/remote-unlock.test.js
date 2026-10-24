'use strict';
const test = require('node:test');
const assert = require('node:assert');
const RU = require('../remote-unlock.js');
const S = require('../scheduler.js');

const key = RU.newKey();
const mk = (type, a = '', b = '') => {
  const c = { id: 'a'.repeat(32), type, a, b, at: 1 };
  c.sig = RU.cmdSig(key, 'nonce1', c);
  return c;
};
const at = (h, m = 0, dayOff = 0) => { const d = new Date(2026, 9, 24 + dayOff, h, m, 0, 0); return d.getTime(); };

test('חתימה: נכונה, nonce אחר, מפתח אחר ופרמטר שונה נדחים', () => {
  const c = mk('for', '30');
  assert.ok(RU.verifyCommand(key, 'nonce1', c));
  assert.ok(!RU.verifyCommand(key, 'nonce2', c));
  assert.ok(!RU.verifyCommand(RU.newKey(), 'nonce1', c));
  assert.ok(!RU.verifyCommand(key, 'nonce1', { ...c, a: '999' }));
  assert.ok(!RU.verifyCommand(key, 'nonce1', mk('for', '0')));
  assert.ok(!RU.verifyCommand(key, 'nonce1', mk('bogus')));
});

test('פתיחה לזמן קצוב ועד שעה (כולל חציית חצות)', () => {
  const now = at(23, 0);
  assert.deepStrictEqual(RU.resolveCommand(mk('for', '30'), now), { kind: 'open', from: now, until: now + 1800000 });
  assert.strictEqual(RU.resolveCommand(mk('until', '2330'), now).until, at(23, 30));
  assert.strictEqual(RU.resolveCommand(mk('until', '0100'), now).until, at(1, 0, 1));
});

test('בין שעות: עתידי, בתוך החלון, וחלון שחוצה חצות', () => {
  let r = RU.resolveCommand(mk('window', '2000', '2100'), at(12));
  assert.deepStrictEqual([r.from, r.until], [at(20), at(21)]);
  r = RU.resolveCommand(mk('window', '2000', '2100'), at(20, 30));
  assert.deepStrictEqual([r.from, r.until], [at(20, 30), at(21)]);
  r = RU.resolveCommand(mk('window', '2200', '0600'), at(2));
  assert.deepStrictEqual([r.from, r.until], [at(2), at(6)]);
  r = RU.resolveCommand(mk('window', '2000', '2100'), at(22));
  assert.deepStrictEqual([r.from, r.until], [at(20, 0, 1), at(21, 0, 1)]);
});

test('ללא הגבלה ונעילה', () => {
  assert.strictEqual(RU.resolveCommand(mk('unlimited'), 5).until, null);
  assert.strictEqual(RU.resolveCommand(mk('lock'), 5).kind, 'lock');
});

test('לוח חוסם נפתח בחלון הטלפון בלבד', () => {
  const week = []; for (let d = 0; d < 7; d++) week.push({ day: d, slots: [{ start: '00:00', end: '24:00' }] });
  const base = S.normalizeSchedule({ enabled: true, mode: 'blocklist', week, remote: { enabled: true, open: { from: at(12), until: at(13) } } });
  assert.strictEqual(S.getStatus(base, new Date(at(11, 59))).state, 'blocked');
  assert.strictEqual(S.getStatus(base, new Date(at(12, 30))).state, 'allowed');
  assert.strictEqual(S.getStatus(base, new Date(at(13, 0))).state, 'blocked');
  const unl = S.normalizeSchedule({ ...base, remote: { enabled: true, open: { from: at(12), until: null } } });
  const st = S.getStatus(unl, new Date(at(15)));
  assert.strictEqual(st.state, 'allowed');
  assert.strictEqual(st.nextAt, null);
  const off = S.normalizeSchedule({ ...base, remote: { enabled: false, open: { from: at(12), until: null } } });
  assert.strictEqual(S.getStatus(off, new Date(at(15))).state, 'blocked');
});
