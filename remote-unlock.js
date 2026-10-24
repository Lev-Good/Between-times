'use strict';
// פתיחה מרחוק מטלפון כשר — קוד טהור (חתימות, אימות פקודות, חישוב חלון פתיחה).
// הרשת והאכיפה נמצאות ב-main.js; כאן הכול בדיק וניתן לבדיקה.
const crypto = require('crypto');

const MAX_CMD_AGE_MS = 10 * 60 * 1000;

function hmacHex(key, msg) {
  return crypto.createHmac('sha256', String(key)).update(String(msg), 'utf8').digest('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function newDeviceId() { return crypto.randomBytes(16).toString('hex'); }
function newKey() { return crypto.randomBytes(32).toString('hex'); }
function newNonce() { return crypto.randomBytes(16).toString('hex'); }

function isPhoneCode(c) { return /^\d{4,8}$/.test(String(c || '')); }
function codeMac(key, code) { return hmacHex(key, 'phone-code|' + code); }

function signSetup(key, d, ts, mac) { return hmacHex(key, ['setup', d, ts, mac].join('|')); }
function signPoll(key, d, nonce, ts, ack) { return hmacHex(key, ['poll', d, nonce, ts, (ack || []).join(',')].join('|')); }
function cmdSig(key, nonce, c) { return hmacHex(key, ['cmd', nonce, c.id, c.type, c.a, c.b, c.at].join('|')); }

// פקודה תקפה = חתימה נכונה לאותו nonce, סוג מוכר ופרמטרים בטווח.
function verifyCommand(key, nonce, c) {
  if (!c || typeof c !== 'object') return false;
  if (!/^[0-9a-f]{32}$/.test(String(c.id || ''))) return false;
  if (!safeEqual(cmdSig(key, nonce, c), c.sig)) return false;
  return parseParams(c) !== null;
}

function hhmmToMin(v) {
  if (!/^\d{4}$/.test(String(v))) return null;
  const h = Number(String(v).slice(0, 2)), m = Number(String(v).slice(2));
  return h < 24 && m < 60 ? h * 60 + m : null;
}

function parseParams(c) {
  switch (c.type) {
    case 'for': { const n = Number(c.a); return Number.isInteger(n) && n >= 1 && n <= 1440 ? { minutes: n } : null; }
    case 'until': { const m = hhmmToMin(c.a); return m === null ? null : { end: m }; }
    case 'window': {
      const s = hhmmToMin(c.a), e = hhmmToMin(c.b);
      return s === null || e === null || s === e ? null : { start: s, end: e };
    }
    case 'unlimited': case 'lock': return {};
    default: return null;
  }
}

function atMinute(base, dayOffset, minutes) {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.getTime();
}

// מתרגם פקודה לחלון פתיחה לפי השעון המהימן של המחשב:
//   { kind:'open', from, until }  (until=null → ללא הגבלה)  |  { kind:'lock' }  |  null
function resolveCommand(c, nowMs) {
  const p = parseParams(c);
  if (!p) return null;
  switch (c.type) {
    case 'lock': return { kind: 'lock' };
    case 'unlimited': return { kind: 'open', from: nowMs, until: null };
    case 'for': return { kind: 'open', from: nowMs, until: nowMs + p.minutes * 60000 };
    case 'until': {
      let end = atMinute(nowMs, 0, p.end);
      if (end <= nowMs) end = atMinute(nowMs, 1, p.end);
      return { kind: 'open', from: nowMs, until: end };
    }
    case 'window': {
      const len = ((p.end - p.start + 1440) % 1440) * 60000;
      // המופע הראשון שעדיין לא הסתיים (אתמול / היום / מחר)
      for (let off = -1; off <= 1; off++) {
        const start = atMinute(nowMs, off, p.start);
        if (start + len > nowMs) return { kind: 'open', from: Math.max(start, nowMs), until: start + len };
      }
      return null;
    }
  }
  return null;
}

function normalizeOpen(o) {
  if (!o || typeof o !== 'object') return null;
  const from = Number(o.from);
  if (!Number.isFinite(from) || from <= 0) return null;
  const until = o.until === null || o.until === undefined ? null : Number(o.until);
  if (until !== null && (!Number.isFinite(until) || until <= from)) return null;
  return { from, until };
}

module.exports = {
  MAX_CMD_AGE_MS, hmacHex, safeEqual, newDeviceId, newKey, newNonce, isPhoneCode, codeMac,
  signSetup, signPoll, cmdSig, verifyCommand, resolveCommand, normalizeOpen, parseParams
};
