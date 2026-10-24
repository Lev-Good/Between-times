/**
 * ============================================================
 *  בין הזמנים — פתיחה מרחוק מטלפון כשר (שרת ביניים)
 *  נפרס יחד עם PasswordRecovery.gs באותו פרויקט Apps Script.
 * ============================================================
 *
 * זרימה:
 *  1. התוכנה (במחשב) נרשמת כאן עם מזהה מכשיר + מפתח סודי + קוד טלפון
 *     (action 'setup'). הקוד נשמר כ-HMAC בלבד.
 *  2. קו ימות המשיח (שלוחת API) פונה ל-doGet עם ?a=ivr&d=<מזהה מכשיר>.
 *     התפריט הקולי מבקש קוד, מאמת אותו, ושומר פקודה בתור.
 *  3. התוכנה פונה ל-doPost (remote:'poll') כל כחצי דקה, חתומה ב-HMAC עם
 *     המפתח הסודי, ומקבלת פקודות חתומות שקשורות ל-nonce של אותה בקשה
 *     (אי אפשר להשמיע מחדש תשובה ישנה).
 *
 * נעילת ניסיונות: 5 קודים שגויים → נעילה של 15 דקות, ובכל נעילה נוספת הזמן
 * מוכפל (עד 24 שעות).
 *
 * חשוב: מי שמפעיל את הסקריפט רואה את המפתחות. מומלץ לפרוס עותק משלכם
 * ולהגדיר את כתובתו בהגדרות התוכנה (פתיחה מרחוק → כתובת שרת הביניים).
 * ============================================================
 */

var RU_CMD_TTL_MS = 10 * 60 * 1000;
var RU_MAX_FAILS = 5;
var RU_BASE_LOCK_MS = 15 * 60 * 1000;
var RU_MAX_LOCK_MS = 24 * 3600 * 1000;

function ruHex(bytes) {
  return bytes.map(function (b) {
    return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0');
  }).join('');
}

function ruHmac(key, msg) {
  return ruHex(Utilities.computeHmacSha256Signature(String(msg), String(key), Utilities.Charset.UTF_8));
}

function ruEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ruIsDeviceId(d) { return /^[0-9a-f]{32}$/.test(String(d || '')); }
function ruIsKey(k) { return /^[0-9a-f]{64}$/.test(String(k || '')); }
function ruIsCode(c) { return /^\d{4,8}$/.test(String(c || '')); }
function ruIsHHMM(v) {
  if (!/^\d{4}$/.test(String(v || ''))) return false;
  var h = Number(String(v).slice(0, 2)), m = Number(String(v).slice(2));
  return h < 24 && m < 60;
}

function ruLoad(d) {
  var raw = PropertiesService.getScriptProperties().getProperty('ru-' + d);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function ruSave(d, rec) {
  PropertiesService.getScriptProperties().setProperty('ru-' + d, JSON.stringify(rec));
}

function ruWithLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- POST מהתוכנה: setup / poll ---------- */

function remotePost(body) {
  var d = String(body.d || '');
  if (!ruIsDeviceId(d)) return jsonResponse({ ok: false, error: 'invalid fields' });
  return ruWithLock(function () {
    var rec = ruLoad(d);
    var ts = Number(body.ts);
    if (!isFinite(ts) || ts <= 0) return jsonResponse({ ok: false, error: 'invalid fields' });

    if (body.remote === 'setup') {
      var codeMac = String(body.codeMac || '');
      if (!rec) {
        // רישום ראשון: המפתח מגיע פעם אחת (HTTPS) ומכאן ואילך כל בקשה חתומה.
        if (!ruIsKey(body.k) || !/^[0-9a-f]{64}$/.test(codeMac)) return jsonResponse({ ok: false, error: 'invalid fields' });
        rec = { k: body.k, codeMac: codeMac, fails: 0, lockUntil: 0, locks: 0, lastTs: ts, cmds: [] };
        ruSave(d, rec);
        return jsonResponse({ ok: true, created: true });
      }
      // עדכון קוד: חייב להיות חתום במפתח הקיים ובחותמת זמן עולה.
      var want = ruHmac(rec.k, ['setup', d, ts, codeMac].join('|'));
      if (!ruEqual(want, body.sig) || ts <= rec.lastTs || !/^[0-9a-f]{64}$/.test(codeMac)) {
        return jsonResponse({ ok: false, error: 'unauthorized' });
      }
      rec.codeMac = codeMac; rec.fails = 0; rec.lockUntil = 0; rec.locks = 0; rec.lastTs = ts;
      ruSave(d, rec);
      return jsonResponse({ ok: true });
    }

    if (body.remote === 'poll') {
      if (!rec) return jsonResponse({ ok: false, error: 'unknown device' });
      var nonce = String(body.n || '');
      var ack = Array.isArray(body.ack) ? body.ack.map(String).slice(0, 20) : [];
      var wantSig = ruHmac(rec.k, ['poll', d, nonce, ts, ack.join(',')].join('|'));
      if (!/^[0-9a-f]{16,64}$/.test(nonce) || !ruEqual(wantSig, body.sig) || ts <= rec.lastTs) {
        return jsonResponse({ ok: false, error: 'unauthorized' });
      }
      rec.lastTs = ts;
      var now = Date.now();
      rec.cmds = (rec.cmds || []).filter(function (c) {
        return ack.indexOf(c.id) < 0 && now - c.at < RU_CMD_TTL_MS;
      });
      ruSave(d, rec);
      var out = rec.cmds.map(function (c) {
        return {
          id: c.id, type: c.type, a: c.a, b: c.b, at: c.at,
          sig: ruHmac(rec.k, ['cmd', nonce, c.id, c.type, c.a, c.b, c.at].join('|'))
        };
      });
      return jsonResponse({ ok: true, cmds: out });
    }
    return jsonResponse({ ok: false, error: 'invalid fields' });
  });
}

/* ---------- תפריט קולי (ימות המשיח, שלוחת API) ---------- */

function ivrRead(prompt, name, max, min) {
  // read=t-<הקראה>=<שם>,no,<מקס>,<מינ>,<המתנה>,No  (ללא הקראת הערך שהוקש)
  return 'read=t-' + prompt + '=' + [name, 'no', max, min, 7, 'No'].join(',');
}
function ivrSay(text) {
  return 'id_list_message=t-' + text + '&go_to_folder=hangup';
}
function ivrText(s) {
  console.log('ivr response: ' + s);
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT);
}

function ivrHandler(e) {
  var p = (e && e.parameter) || {};
  // אבחון: רק שמות הפרמטרים (לעולם לא הערכים — הקוד לא נרשם)
  console.log('ivr params: ' + Object.keys(p).join(','));
  if (String(p.hangup || '') === 'yes') return ivrText('noop');
  var d = String(p.d || '');
  if (!ruIsDeviceId(d)) return ivrText(ivrSay('קו לא מוגדר'));

  return ruWithLock(function () {
    var rec = ruLoad(d);
    if (!rec) return ivrText(ivrSay('המחשב לא רשום לפתיחה מרחוק'));
    var now = Date.now();
    if (rec.lockUntil && now < rec.lockUntil) return ivrText(ivrSay('הגישה ננעלה זמנית עקב ניסיונות שגויים'));

    if (!p.code) return ivrText(ivrRead('הקישו את קוד הגישה', 'code', 8, 4));
    if (!ruIsCode(p.code) || !ruEqual(ruHmac(rec.k, 'phone-code|' + p.code), rec.codeMac)) {
      rec.fails = (rec.fails || 0) + 1;
      var msg = 'הקוד שגוי';
      if (rec.fails >= RU_MAX_FAILS) {
        rec.locks = (rec.locks || 0) + 1;
        rec.lockUntil = now + Math.min(RU_MAX_LOCK_MS, RU_BASE_LOCK_MS * Math.pow(2, rec.locks - 1));
        rec.fails = 0;
        msg = 'הקוד שגוי, הגישה ננעלה';
      }
      ruSave(d, rec);
      return ivrText(ivrSay(msg));
    }
    if (rec.fails) { rec.fails = 0; ruSave(d, rec); }

    if (!p.op) {
      return ivrText(ivrRead('לפתיחה לזמן קצוב הקישו 1, לפתיחה עד שעה הקישו 2, לפתיחה בין שעות הקישו 3, לפתיחה ללא הגבלה הקישו 4, לנעילה הקישו 7', 'op', 1, 1));
    }
    var type = null, a = '', b = '';
    if (p.op === '1') {
      if (!p.p1) return ivrText(ivrRead('הקישו את מספר הדקות', 'p1', 4, 1));
      var mins = Number(p.p1);
      if (!(mins >= 1 && mins <= 1440)) return ivrText(ivrSay('מספר דקות לא תקין'));
      type = 'for'; a = String(mins);
    } else if (p.op === '2') {
      if (!p.p1) return ivrText(ivrRead('הקישו את שעת הסיום בארבע ספרות, לדוגמה עשרים ושתיים אפס אפס', 'p1', 4, 4));
      if (!ruIsHHMM(p.p1)) return ivrText(ivrSay('שעה לא תקינה'));
      type = 'until'; a = p.p1;
    } else if (p.op === '3') {
      if (!p.p1) return ivrText(ivrRead('הקישו את שעת ההתחלה בארבע ספרות', 'p1', 4, 4));
      if (!ruIsHHMM(p.p1)) return ivrText(ivrSay('שעה לא תקינה'));
      if (!p.p2) return ivrText(ivrRead('הקישו את שעת הסיום בארבע ספרות', 'p2', 4, 4));
      if (!ruIsHHMM(p.p2) || p.p2 === p.p1) return ivrText(ivrSay('שעה לא תקינה'));
      type = 'window'; a = p.p1; b = p.p2;
    } else if (p.op === '4') {
      type = 'unlimited';
    } else if (p.op === '7') {
      type = 'lock';
    } else {
      return ivrText(ivrSay('בחירה לא תקינה'));
    }

    rec.cmds = (rec.cmds || []).filter(function (c) { return now - c.at < RU_CMD_TTL_MS; }).slice(-5);
    rec.cmds.push({ id: Utilities.getUuid().replace(/-/g, ''), type: type, a: a, b: b, at: now });
    ruSave(d, rec);
    return ivrText(ivrSay('הפקודה התקבלה, המחשב יתעדכן בתוך כחצי דקה'));
  });
}
