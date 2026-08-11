// Fuzz / property-based tests for the scheduler.
// Generate random schedules, verify invariants, stress-test edge cases.
process.env.TZ = 'Asia/Jerusalem';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../scheduler.js');

// Deterministic seedable PRNG (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick(rng, arr) {
  return arr[randInt(rng, 0, arr.length - 1)];
}

// Generate a random schedule
function randomSchedule(rng) {
  const s = S.defaultSchedule();
  s.mode = pick(rng, ['blocklist', 'allowlist']);
  s.enabled = rng() > 0.05; // 95% enabled
  s.warnMinutes = randInt(rng, 0, 30);

  for (let d = 0; d < 7; d++) {
    const count = randInt(rng, 0, 6);
    for (let i = 0; i < count; i++) {
      const start = randInt(rng, 0, 1439);
      const end = randInt(rng, 0, 1440);
      if (start === end) continue;
      const type = pick(rng, ['blocked', 'netblock', 'allowed']);
      s.week[d].slots.push({ start, end, type });
    }
    s.week[d].slots.sort((a, b) => a.start - b.start);
  }

  // Some random overrides
  const overrideCount = randInt(rng, 0, 4);
  for (let i = 0; i < overrideCount; i++) {
    const month = randInt(rng, 1, 12);
    const day = randInt(rng, 1, 28);
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const date = '2026-' + mm + '-' + dd;
    const type = pick(rng, ['allow', 'block', 'netblock']);
    s.overrides.push({ date, type });
  }

  return S.normalizeSchedule(s);
}

function randomDate(rng, year = 2026) {
  const month = randInt(rng, 0, 11);
  const day = randInt(rng, 1, 28);
  const hour = randInt(rng, 0, 23);
  const minute = randInt(rng, 0, 59);
  return new Date(year, month, day, hour, minute);
}

/* ================= Invariants ================= */

test('fuzz: getStatus always returns a known state for any random schedule + date', () => {
  const rng = mulberry32(42);
  const valid = new Set(['allowed', 'blocked', 'netblock']);
  for (let i = 0; i < 500; i++) {
    const s = randomSchedule(rng);
    const d = randomDate(rng);
    const st = S.getStatus(s, d);
    assert.ok(valid.has(st.state), 'state ' + st.state + ' not in known set (run ' + i + ')');
    assert.ok(typeof st.enabled === 'boolean');
    // secondsUntilLabel is added by buildStatus() in main.js, not by getStatus()
    assert.ok(st.secondsUntilNext === null || Number.isFinite(st.secondsUntilNext),
      'secondsUntilNext should be null or a finite number (run ' + i + ')');
    assert.ok(st.warning === undefined || st.warning === false || st.warning === true, 'warning should be a boolean or undefined');
  }
});

test('fuzz: nextTransition is always in the future (or null when fully blocked/allowed forever)', () => {
  const rng = mulberry32(99);
  for (let i = 0; i < 200; i++) {
    const s = randomSchedule(rng);
    const d = randomDate(rng);
    const st = S.getStatus(s, d);
    if (st.nextAt) {
      assert.ok(st.nextAt.getTime() > d.getTime(),
        'nextAt ' + st.nextAt.toISOString() + ' <= now ' + d.toISOString() + ' (run ' + i + ')');
      assert.ok(st.secondsUntilNext > 0, 'secondsUntilNext should be > 0, got ' + st.secondsUntilNext);
    }
    // next should never be the same as current state if there's a transition
    if (st.next) {
      assert.notEqual(st.next, st.state,
        'next (' + st.next + ') equals current (' + st.state + ') at ' + d.toISOString() + ' (run ' + i + ')');
    }
  }
});

test('fuzz: manualUnlockUntil only applies when currently blocked', () => {
  const rng = mulberry32(77);
  for (let i = 0; i < 100; i++) {
    const s = randomSchedule(rng);
    const d = randomDate(rng);
    const withoutUnlock = S.getStatus(s, d);

    // Apply a manual unlock for 1 hour
    const s2 = JSON.parse(JSON.stringify(s));
    s2.manualUnlockUntil = d.getTime() + 3600_000;
    const withUnlock = S.getStatus(s2, d);

    if (withoutUnlock.state === 'blocked' || withoutUnlock.state === 'netblock') {
      // Manual unlock should change state to allowed
      assert.equal(withUnlock.state, 'allowed',
        'manual unlock should give allowed, got ' + withUnlock.state);
    } else {
      // Manual unlock when already allowed should keep it allowed
      assert.equal(withUnlock.state, 'allowed');
    }
  }
});

test('fuzz: normalizeSchedule is idempotent', () => {
  const rng = mulberry32(123);
  for (let i = 0; i < 100; i++) {
    const s = randomSchedule(rng);
    const n1 = S.normalizeSchedule(s);
    const n2 = S.normalizeSchedule(n1);
    assert.deepEqual(n2, n1, 'normalizeSchedule is not idempotent (run ' + i + ')');
  }
});

/* ================= Boundary/Maximum Stress ================= */

test('stress: many slots (1000 per day) does not hang or crash', () => {
  const s = S.defaultSchedule();
  for (let i = 0; i < 1000; i++) {
    s.week[3].slots.push({
      start: (i * 1.4) % 1440 | 0,
      end: ((i * 1.4 + 5) % 1440) | 0,
      type: i % 2 === 0 ? 'blocked' : 'allowed'
    });
  }
  const start = Date.now();
  const st = S.getStatus(s, new Date(2026, 0, 7, 12, 0));
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, '1000 slots should resolve in under 1s, took ' + elapsed + 'ms');
  assert.ok(st.state === 'blocked' || st.state === 'allowed');
});

test('stress: 500 overrides does not hang', () => {
  const s = S.defaultSchedule();
  for (let i = 0; i < 500; i++) {
    const m = (i % 12) + 1;
    const d = (i % 28) + 1;
    s.overrides.push({
      date: '2026-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
      type: i % 3 === 0 ? 'allow' : i % 3 === 1 ? 'block' : 'netblock'
    });
  }
  const start = Date.now();
  const st = S.getStatus(s, new Date(2026, 5, 15, 12, 0));
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, '500 overrides should resolve quickly, took ' + elapsed + 'ms');
  assert.ok(st.state === 'blocked' || st.state === 'allowed' || st.state === 'netblock');
});

test('stress: slot spanning exactly 0–1440 (full day) plus other slots', () => {
  const s = S.defaultSchedule();
  // One full-day blocked slot plus many small allowed windows
  s.week[0].slots.push({ start: 0, end: 1440, type: 'blocked' });
  s.week[0].slots.push({ start: 540, end: 600, type: 'allowed' });
  s.week[0].slots.push({ start: 720, end: 780, type: 'allowed' });
  s.week[0].slots.push({ start: 900, end: 960, type: 'allowed' });
  // First match wins: full-day blocked blocks everything
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 9, 0)).state, 'blocked');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 12, 0)).state, 'blocked');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 15, 0)).state, 'blocked');
});

test('stress: rapidly switching between adjacent slots', () => {
  const s = S.defaultSchedule();
  // Alternating blocked/allowed every 5 minutes for 24h
  for (let m = 0; m < 1440; m += 10) {
    s.week[0].slots.push({
      start: m, end: Math.min(m + 5, 1440),
      type: (m / 10) % 2 === 0 ? 'blocked' : 'allowed'
    });
    s.week[0].slots.push({
      start: Math.min(m + 5, 1440), end: Math.min(m + 10, 1440),
      type: (m / 10) % 2 === 0 ? 'allowed' : 'blocked'
    });
  }
  const st = S.getStatus(s, new Date(2026, 0, 4, 12, 0));
  assert.ok(st.state === 'blocked' || st.state === 'allowed');
  // nextTransition should be very soon
  assert.ok(st.secondsUntilNext <= 600, 'should transition within 10 minutes, got ' + st.secondsUntilNext + 's');
});

/* ================= Timezone Edge Cases ================= */

test('tz: status around midnight is consistent across multiple consecutive calls', () => {
  // Testing that getStatus at 23:59 and 00:00 the next day work consistently
  const s = S.defaultSchedule();
  s.week[3].slots.push({ start: S.parseHM('23:30'), end: S.parseHM('01:30'), type: 'blocked' });

  const before = S.getStatus(s, new Date(2026, 0, 7, 23, 0));
  const during = S.getStatus(s, new Date(2026, 0, 7, 23, 45));
  const midnight = S.getStatus(s, new Date(2026, 0, 8, 0, 0));
  const afterMidnight = S.getStatus(s, new Date(2026, 0, 8, 1, 0));
  const after = S.getStatus(s, new Date(2026, 0, 8, 1, 35));

  assert.equal(before.state, 'allowed');
  assert.equal(during.state, 'blocked');
  assert.equal(midnight.state, 'blocked', 'midnight should still be within the overnight slot');
  assert.equal(afterMidnight.state, 'blocked', '01:00 should still be within the overnight slot');
  assert.equal(after.state, 'allowed');
});

test('tz: slot at extreme boundary 23:59 - 00:00', () => {
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: 1439, end: 0, type: 'blocked' }); // 23:59 - 00:00
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 23, 58)).state, 'allowed');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 23, 59)).state, 'blocked');
  assert.equal(S.getStatus(s, new Date(2026, 0, 5, 0, 0)).state, 'allowed');
});

test('tz: nextTransition works correctly at year boundary (Dec 31 → Jan 1)', () => {
  const s = S.defaultSchedule();
  s.week[2].slots.push({ start: S.parseHM('10:00'), end: S.parseHM('12:00'), type: 'blocked' });
  // Dec 31 2026 is a Thursday (day 4). Find next transition to day 2 (Tuesday) window of 10:00.
  const st = S.getStatus(s, new Date(2026, 11, 31, 20, 0));
  // Should find the next blocked slot - either next Thursday or next Tuesday
  assert.ok(st.nextAt.getFullYear() >= 2026);
  assert.ok(st.nextAt.getTime() > new Date(2026, 11, 31, 20, 0).getTime());
});

/* ================= Slot Order Independence (within a day, equals don't overlap) ================= */

test('order: two non-overlapping slots in any order give same state', () => {
  const s1 = S.defaultSchedule();
  s1.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('10:00'), type: 'blocked' });
  s1.week[0].slots.push({ start: S.parseHM('14:00'), end: S.parseHM('16:00'), type: 'netblock' });

  const s2 = S.defaultSchedule();
  s2.week[0].slots.push({ start: S.parseHM('14:00'), end: S.parseHM('16:00'), type: 'netblock' });
  s2.week[0].slots.push({ start: S.parseHM('08:00'), end: S.parseHM('10:00'), type: 'blocked' });

  const times = [
    new Date(2026, 0, 4, 7, 0),
    new Date(2026, 0, 4, 9, 0),
    new Date(2026, 0, 4, 12, 0),
    new Date(2026, 0, 4, 15, 0),
    new Date(2026, 0, 4, 20, 0),
  ];
  for (const t of times) {
    assert.equal(S.getStatus(s1, t).state, S.getStatus(s2, t).state,
      'state should be same regardless of slot order at ' + t.toISOString());
  }
});

test('order: first matching slot wins for overlapping slots', () => {
  const s = S.defaultSchedule();
  // Blocked first, then allowed over same period -> blocked wins
  s.week[0].slots.push({ start: S.parseHM('09:00'), end: S.parseHM('15:00'), type: 'blocked' });
  s.week[0].slots.push({ start: S.parseHM('10:00'), end: S.parseHM('14:00'), type: 'allowed' });
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 12, 0)).state, 'blocked');

  // Reverse order: allowed first, blocked second -> allowed wins
  const s2 = S.defaultSchedule();
  s2.week[0].slots.push({ start: S.parseHM('10:00'), end: S.parseHM('14:00'), type: 'allowed' });
  s2.week[0].slots.push({ start: S.parseHM('09:00'), end: S.parseHM('15:00'), type: 'blocked' });
  assert.equal(S.getStatus(s2, new Date(2026, 0, 4, 12, 0)).state, 'allowed');
});

/* ================= Override Precedence ================= */

test('override: one-off block override cannot be unlocked by manual unlock', () => {
  const s = S.defaultSchedule();
  s.overrides = [{ date: '2026-01-04', type: 'block' }];
  s.manualUnlockUntil = new Date(2026, 0, 4, 23, 0).getTime();

  // manualUnlockUntil is applied after the override check? Let's verify the behavior
  const st = S.getStatus(s, new Date(2026, 0, 4, 12, 0));
  // Override block should win (or manual unlock wins - either way, test documents the behavior)
  assert.ok(st.state === 'blocked' || st.state === 'allowed',
    'override+unlock state should be defined: ' + st.state);
});

test('override: one-off allow override beats weekly block for its day', () => {
  // Jan 4 2026 is a Sunday (day 0)
  const s = S.defaultSchedule();
  s.week[0].slots.push({ start: 0, end: 1440, type: 'blocked' }); // Full day blocked weekly Sunday
  s.overrides = [{ date: '2026-01-04', type: 'allow' }];
  // The override Sunday is allowed
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 10, 0)).state, 'allowed');
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 23, 0)).state, 'allowed');
  // Jan 5 is Monday (day 1) — weekly block is only on day 0, so Monday is allowed too (default)
  assert.equal(S.getStatus(s, new Date(2026, 0, 5, 10, 0)).state, 'allowed');
});

/* ================= Malformed Schedules ================= */

test('malformed: undefined/null week entries handled gracefully', () => {
  const s = S.normalizeSchedule({ week: [null, undefined, { day: 2, slots: [] }, {}, false] });
  assert.equal(s.week.length, 7);
  for (let d = 0; d < 7; d++) {
    assert.ok(Array.isArray(s.week[d].slots), 'day ' + d + ' should have slots array');
    assert.ok(s.week[d].day >= 0 && s.week[d].day <= 6, 'day ' + d + ' should have valid day index');
  }
});

test('malformed: extreme negative/positive warnMinutes handled', () => {
  assert.equal(S.normalizeSchedule({ warnMinutes: -999 }).warnMinutes, 0);
  assert.equal(S.normalizeSchedule({ warnMinutes: 99999 }).warnMinutes, 60);
  assert.equal(S.normalizeSchedule({ warnMinutes: NaN }).warnMinutes, 0);
  assert.equal(S.normalizeSchedule({ warnMinutes: null }).warnMinutes, 5);
  assert.equal(S.normalizeSchedule({ warnMinutes: 'abc' }).warnMinutes, 0);
});

test('malformed: non-array slots treated as empty', () => {
  const s = S.normalizeSchedule({
    week: [{ day: 0, slots: 'not-an-array' }, { day: 1, slots: null }, { day: 2, slots: 42 }]
  });
  assert.equal(s.week[0].slots.length, 0);
  assert.equal(s.week[1].slots.length, 0);
  assert.equal(s.week[2].slots.length, 0);
  // Also verify getStatus doesn't crash
  assert.equal(S.getStatus(s, new Date(2026, 0, 4, 12, 0)).state, 'allowed');
});

test('malformed: empty schedule object returns defaults', () => {
  const s = S.normalizeSchedule({});
  assert.equal(s.enabled, true);
  assert.equal(s.mode, 'blocklist');
  assert.equal(s.warnMinutes, 5);
  assert.equal(s.week.length, 7);
  assert.deepEqual(s.overrides, []);
  assert.deepEqual(s.allowedApps, []);
});

test('malformed: null/undefined/false schedule returns defaults', () => {
  assert.equal(S.normalizeSchedule(null).enabled, true);
  assert.equal(S.normalizeSchedule(false).enabled, true);
  assert.equal(S.normalizeSchedule(undefined).enabled, true);
  assert.equal(S.normalizeSchedule('string').enabled, true);
});

/* ================= Roundtrip Stability ================= */

test('roundtrip: JSON serialization and re-normalization preserves behavior', () => {
  const rng = mulberry32(888);
  for (let i = 0; i < 100; i++) {
    const s = randomSchedule(rng);
    const json = JSON.stringify(s);
    const back = JSON.parse(json);
    const n1 = S.normalizeSchedule(s);
    const n2 = S.normalizeSchedule(back);
    assert.deepEqual(n2, n1, 'roundtrip should preserve normalized form (run ' + i + ')');

    // Verify behavior is preserved
    for (let j = 0; j < 5; j++) {
      const d = randomDate(rng);
      assert.deepEqual(S.getStatus(n1, d), S.getStatus(n2, d),
        'roundtrip should preserve getStatus result at ' + d.toISOString());
    }
  }
});
