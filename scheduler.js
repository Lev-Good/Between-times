/**
 * scheduler.js — מנוע לוח הזמנים המשותף (Node + דפדפן)
 * מחשב את מצב הגישה (מותר/חסום) בכל רגע לפי לוח זמנים שבועי.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TimeScheduler = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // גרסת הסכימה. מוגדל כאשר נוספים שדות חדשים למבנה ההגדרות. המיגרציה
  // "שקטה": normalizeSchedule ממלא ערכי ברירת מחדל לכל שדה חסר, כך שקובץ
  // הגדרות ישן (v1.5.10, ללא schemaVersion) נטען ומקבל את השדות החדשים בלי
  // איבוד הגדרות קיימות. שדה נפרד מ-`version` (שהוא גרסת פורמט הלוח הפנימי).
  var SCHEMA_VERSION = 2;

  /* ---------- עזרי זמן ---------- */

  function parseHM(str) {
    if (typeof str === 'number' && isFinite(str)) {
      // כבר דקות; 1440 = 24:00 (סוף היום) נשמר ככזה
      return Math.min(Math.max(str, 0), 1440);
    }
    const parts = String(str || '').split(':').map(Number);
    const h = isNaN(parts[0]) ? 0 : parts[0];
    const m = isNaN(parts[1]) ? 0 : parts[1];
    if (h === 24 && m === 0) return 1440; // 24:00 = סוף היום
    return (h * 60 + m) % 1440;
  }

  function fmtHM(minutes) {
    const m = ((minutes % 1440) + 1440) % 1440;
    if (minutes >= 1440) return '24:00';
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  function fmtTime(date) {
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function dateKey(date) {
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + m + '-' + d;
  }

  const DAY_NAMES_HE = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
  const DAY_SHORT_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

  /* ---------- מבנה ברירת מחדל ---------- */

  function defaultSchedule() {
    const week = [];
    for (let d = 0; d < 7; d++) week.push({ day: d, slots: [] });
    return {
      version: 1,
      schemaVersion: SCHEMA_VERSION,
      enabled: true,
      mode: 'blocklist',          // blocklist = חסום רק את החלונות; allowlist = התר רק את החלונות
      warnMinutes: 5,             // דקות אזהרה לפני תחילת החסימה (0 = ללא אזהרה)
      pinHash: null,
      theme: 'system',          // ערכת נושא: system = לפי המערכת | light | dark
      blockMessage: '',         // הודעה אישית שמוצגת במסך החסימה
      overrides: [],            // חריגים חד-פעמיים: [{date:'YYYY-MM-DD', type:'allow'|'block'|'netblock'}]
      startWithWindows: true,  // אפליקציית הורים — עולה אוטומטית עם Windows
      runAsAdmin: false,        // הרצה עם הרשאות מנהל (UAC) — מונעת סגירה מחשבון רגיל
      manualUnlockUntil: null,
      showNetIcon: true,        // אייקון צף קטן כשהמחשב פתוח והאינטרנט חסום
      blockBg: 'blobs',         // רקע מסך החסימה: blobs | fluid | particles | aurora
      showTorahQuotes: true,    // משפטי עידוד מהמקורות במסך החסימה
      allowedAppsEnabled: true, // תוכנות תורניות מותרות בזמן חסימה — הפעלה/כיבוי
      allowedApps: [],          // רשימת התוכנות: [{name, exe}]

      /* ---------- תוספות סכימה v2 ---------- */
      // מצב "רק תוכנות מאושרות" (Process Governor). scope: 'always' = תמיד |
      // 'blocked' = רק בחלונות חסימה. כבוי כברירת מחדל (בטוח).
      studyMode: { enabled: false, scope: 'blocked' },
      // "אתר נעול" — רשימת אתרים מאושרים שההורה בוחר, כל אחד עם רשימת כתובות.
      websiteApps: [],          // [{ name, urls: [...] }]
      // סייר קבצים מוגבל + ספרייה לקריאה בלבד. כבוי כברירת מחדל.
      fileExplorer: { enabled: false, roots: ['documents', 'downloads'], readonlyLibrary: true, hiddenTypes: [], libraryPath: '' },
      // שותף אחריות (Accountability) — כבוי כברירת מחדל.
      accountabilityEmail: '',
      accountabilityEnabled: false,
      accountabilityRequireApproval: false, // חייב אישור שותף לפתיחה מוקדמת
      // "תקופת צינון" — עיכוב (בדקות) לפני שפתיחה מוקדמת נכנסת לתוקף. 0 = מושבת.
      coolOffMinutes: 0,
      // פרופילים: בחירה אוטומטית לפי משתמש Windows + פרופילים ידניים בעלי שם.
      profiles: [],             // [{ id, name, user, overrides:{...} }]
      defaultProfile: null,     // מזהה הפרופיל שישמש כברירת מחדל (או null)
      week
    };
  }

  // רשימת תוכנות הלימוד המותרות בזמן חסימה, עם מנגנון אימות מאובטח:
  // - תוכנה חתומה דיגיטלית: mode 'publisher' — אימות לפי חותם (מוציא לאור)
  //   + שם מוצר + שם קובץ. עמיד לעדכוני תוכנה, ומונע העתקה/שינוי שם של
  //   תוכנה אחרת (גם תוכנת מיקרוסופט אחרת — כי שם המוצר שונה).
  // - תוכנה לא חתומה: mode 'path' — אימות לפי נתיב מלא מדויק + טביעת SHA-256
  //   של הקובץ (אם נשמרה). רשומות כפולות, ריקות או לא תקינות נמחקות.
  function normalizeAllowedApps(list) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((a) => {
      if (!a || typeof a !== 'object') return;
      const exe = String(a.exe || '').trim();
      if (!exe) return;
      const key = exe.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const name = (String(a.name || '').trim() || exe.split(/[\\/]/).pop().replace(/\.exe$/i, '')).slice(0, 80);
      const publisher = String(a.publisher || '').trim().slice(0, 200);
      const product = String(a.product || '').trim().slice(0, 120);
      const hash = String(a.hash || '').trim().toLowerCase();
      const validHash = /^[0-9a-f]{64}$/.test(hash) ? hash : '';
      const mode = (a.mode === 'publisher' && publisher && product) ? 'publisher' : 'path';
      out.push({
        name,
        exe,
        mode,
        publisher: mode === 'publisher' ? publisher : '',
        product: mode === 'publisher' ? product : '',
        hash: validHash,
        companions: normalizeAllowedApps(a.companions)
      });
    });
    return out;
  }

  /* ---------- נורמליזציה של שדות סכימה v2 ---------- */

  // מצב "רק תוכנות מאושרות". enabled כבוי כברירת מחדל; scope בין 'always'
  // (תמיד) ל-'blocked' (רק בחלונות חסימה, ברירת המחדל).
  function normalizeStudyMode(v) {
    const o = (v && typeof v === 'object') ? v : {};
    return {
      enabled: o.enabled === true,
      scope: o.scope === 'always' ? 'always' : 'blocked'
    };
  }

  // נורמליזציה של כתובת אתר יחידה. מקבלת http/https (או שם דומיין ללא סכימה),
  // דורשת מארח מלא (עם נקודה), ומחזירה צורה קנונית — או null אם לא תקינה.
  // כתובת קנונית מנרמלת לעצמה (idempotent), חיוני לבדיקות roundtrip.
  function normalizeUrl(u) {
    const raw = String(u == null ? '' : u).trim();
    if (!raw) return null;
    let parsed;
    try { parsed = new URL(raw.indexOf('://') >= 0 ? raw : 'https://' + raw); } catch (e) { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = String(parsed.hostname || '').toLowerCase();
    if (!host || host.indexOf('.') < 0) return null; // חייב להיות דומיין מלא
    let out = parsed.protocol + '//' + host;
    const defaultPort = (parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80');
    if (parsed.port && !defaultPort) out += ':' + parsed.port;
    const pathPart = (parsed.pathname && parsed.pathname !== '/') ? parsed.pathname : '';
    out += pathPart + (parsed.search || '');
    return out;
  }

  function normalizeUrlList(list) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((u) => {
      const n = normalizeUrl(u);
      if (!n) return;
      const key = n.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(n);
    });
    return out;
  }

  // "אתר נעול": רשימת אתרים שההורה בוחר, כל אחד עם שם ורשימת כתובות מאושרות.
  // רשומה ללא אף כתובת תקינה נמחקת; כפילויות שם (case-insensitive) מוסרות.
  function normalizeWebsiteApps(list) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((a) => {
      if (!a || typeof a !== 'object') return;
      const urls = normalizeUrlList(a.urls);
      if (!urls.length) return;
      let name = String(a.name || '').trim().slice(0, 80);
      if (!name) { try { name = new URL(urls[0]).hostname; } catch (e) { name = urls[0]; } }
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ name, urls });
    });
    return out;
  }

  // האם המארח המבוקש תואם למארח מאושר (התאמה מדויקת או תת-דומיין)?
  function hostMatches(allowedHost, candidateHost, allowSubdomains) {
    const a = String(allowedHost || '').toLowerCase();
    const c = String(candidateHost || '').toLowerCase();
    if (!a || !c) return false;
    if (a === c) return true;
    if (allowSubdomains !== false && c.length > a.length && c.slice(-(a.length + 1)) === '.' + a) return true;
    return false;
  }

  function urlHost(u) {
    try { return new URL(String(u)).hostname.toLowerCase(); } catch (e) { return ''; }
  }

  // האם כתובת יעד מותרת לפי רשימת האתרים? (ברירת מחדל: התאמת תת-דומיינים).
  // Default-deny: כתובת שאינה http/https או שאינה תואמת לאף מארח — נדחית.
  function siteUrlAllowed(websiteApps, targetUrl, allowSubdomains) {
    let target;
    try { target = new URL(String(targetUrl)); } catch (e) { return false; }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    const host = target.hostname.toLowerCase();
    for (const app of (Array.isArray(websiteApps) ? websiteApps : [])) {
      for (const u of ((app && app.urls) || [])) {
        let allowed;
        try { allowed = new URL(String(u)); } catch (e) { continue; }
        const allowedPort = allowed.port || (allowed.protocol === 'https:' ? '443' : '80');
        const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
        if (allowed.protocol === target.protocol && allowedPort === targetPort &&
            hostMatches(allowed.hostname, host, allowSubdomains)) return true;
      }
    }
    return false;
  }

  // סיומת קובץ קנונית (אותיות קטנות, עם נקודה מובילה) — או '' אם לא תקינה.
  function normalizeExtension(e) {
    let s = String(e == null ? '' : e).trim().toLowerCase();
    if (!s) return '';
    if (s.charAt(0) !== '.') s = '.' + s;
    if (!/^\.[a-z0-9][a-z0-9.+_-]*$/.test(s)) return '';
    return s.slice(0, 20);
  }

  function normalizeExtList(list) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((e) => {
      const ext = normalizeExtension(e);
      if (ext && !seen.has(ext)) { seen.add(ext); out.push(ext); }
    });
    return out;
  }

  var EXPLORER_ROOTS = ['documents', 'downloads', 'desktop', 'pictures', 'music', 'videos', 'library'];

  // סייר קבצים מוגבל: אילו שורשים חשופים, האם הספרייה לקריאה בלבד, ואילו
  // סוגי קבצים מוסתרים. enabled כבוי כברירת מחדל.
  function normalizeFileExplorer(v) {
    const o = (v && typeof v === 'object') ? v : {};
    const roots = [];
    const seen = new Set();
    (Array.isArray(o.roots) ? o.roots : []).forEach((r) => {
      const key = String(r == null ? '' : r).trim().toLowerCase();
      if (EXPLORER_ROOTS.indexOf(key) >= 0 && !seen.has(key)) { seen.add(key); roots.push(key); }
    });
    return {
      enabled: o.enabled === true,
      roots: roots.length ? roots : ['documents', 'downloads'],
      readonlyLibrary: o.readonlyLibrary !== false, // ברירת מחדל: לקריאה בלבד
      hiddenTypes: normalizeExtList(o.hiddenTypes),
      // נתיב "הספרייה" (תיקיית לימוד לקריאה בלבד). ריק = לא הוגדר.
      libraryPath: (function () {
        const p = String(o.libraryPath == null ? '' : o.libraryPath).trim();
        return (/^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p)) ? p : '';
      })()
    };
  }

  // האם סוג הקובץ מוסתר לפי מדיניות הסייר? (רשימת סיומות מוסתרות).
  function isHiddenType(hiddenTypes, fileName) {
    const list = Array.isArray(hiddenTypes) ? hiddenTypes : [];
    if (!list.length) return false;
    const name = String(fileName || '');
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false; // ללא סיומת — אינו מוסתר לפי סוג
    const ext = name.slice(dot).toLowerCase();
    return list.indexOf(ext) >= 0;
  }

  // מבנה שבועי מנורמל — מופרד לפונקציה כדי שגם פרופילים יוכלו להשתמש בו.
  function normalizeWeek(week) {
    const out = [];
    for (let d = 0; d < 7; d++) {
      const src = (week || [])[d] || { slots: [] };
      const slots = (Array.isArray(src.slots) ? src.slots : [])
        .filter((x) => x && typeof x === 'object')
        .map((x) => ({
          start: parseScheduleHM(x.start, false),
          end: parseScheduleHM(x.end, true),
          type: x.type === 'allowed' ? 'allowed' : x.type === 'netblock' ? 'netblock' : 'blocked'
        }))
        .filter((x) => x.start !== null && x.end !== null && x.start !== x.end);
      out.push({ day: d, slots });
    }
    return out;
  }

  // שדות שפרופיל רשאי לדרוס מעל המדיניות הבסיסית. רק מפתחות שקיימים
  // בקלט נשמרים — כך פרופיל דורס אך ורק את מה שהוגדר בו במפורש.
  function normalizeProfileOverrides(o) {
    if (!o || typeof o !== 'object') return {};
    const out = {};
    if ('enabled' in o) out.enabled = o.enabled !== false;
    if ('mode' in o) out.mode = o.mode === 'allowlist' ? 'allowlist' : 'blocklist';
    if ('warnMinutes' in o) out.warnMinutes = Math.max(0, Math.min(60, Math.round(Number(o.warnMinutes) || 0)));
    if ('blockMessage' in o) out.blockMessage = String(o.blockMessage || '').trim().slice(0, 300);
    if ('blockBg' in o) out.blockBg = ['blobs', 'fluid', 'particles', 'aurora'].includes(o.blockBg) ? o.blockBg : 'blobs';
    if ('showTorahQuotes' in o) out.showTorahQuotes = o.showTorahQuotes !== false;
    if ('week' in o) out.week = normalizeWeek(o.week);
    if ('allowedApps' in o) out.allowedApps = normalizeAllowedApps(o.allowedApps);
    if ('allowedAppsEnabled' in o) out.allowedAppsEnabled = o.allowedAppsEnabled !== false;
    if ('studyMode' in o) out.studyMode = normalizeStudyMode(o.studyMode);
    if ('websiteApps' in o) out.websiteApps = normalizeWebsiteApps(o.websiteApps);
    if ('fileExplorer' in o) out.fileExplorer = normalizeFileExplorer(o.fileExplorer);
    return out;
  }

  // פרופילים: מערך של { id, name, user, overrides }. הבחירה האוטומטית נעשית
  // לפי שדה user (שם משתמש Windows, אותיות קטנות); פרופיל ללא user הוא ידני.
  // כפילויות מזהה מוסרות; פרופיל ללא שם וללא משתמש חסר משמעות ונמחק.
  function normalizeProfiles(list) {
    const out = [];
    const seenId = new Set();
    (Array.isArray(list) ? list : []).forEach((p) => {
      if (!p || typeof p !== 'object') return;
      const name = String(p.name || '').trim().slice(0, 80);
      const user = String(p.user || '').trim().toLowerCase().slice(0, 128);
      let id = String(p.id || '').trim().slice(0, 80);
      if (!id) id = user ? 'user:' + user : (name ? 'name:' + name.toLowerCase() : '');
      if (!id || seenId.has(id)) return;
      if (!name && !user) return;
      seenId.add(id);
      out.push({ id, name: name || user, user, overrides: normalizeProfileOverrides(p.overrides) });
    });
    return out;
  }

  // בחירת הפרופיל הפעיל לפי שם משתמש Windows: קודם התאמת user מדויקת, אחרת
  // פרופיל ברירת המחדל (defaultProfile), אחרת null (משתמשים במדיניות הבסיסית).
  function resolveProfile(schedule, username) {
    const profiles = (schedule && Array.isArray(schedule.profiles)) ? schedule.profiles : [];
    const u = String(username || '').trim().toLowerCase();
    if (u) {
      const byUser = profiles.find((p) => p.user && p.user === u);
      if (byUser) return byUser;
    }
    const def = schedule && schedule.defaultProfile;
    if (def) {
      const byDefault = profiles.find((p) => p.id === def);
      if (byDefault) return byDefault;
    }
    return null;
  }

  // שדות שפרופיל רשאי לדרוס (מדיניות בלבד — לא סיסמה/שחזור/שותף/צינון).
  var PROFILE_OVERRIDE_KEYS = ['enabled', 'mode', 'warnMinutes', 'blockMessage', 'blockBg',
    'showTorahQuotes', 'week', 'allowedApps', 'allowedAppsEnabled', 'studyMode', 'websiteApps', 'fileExplorer'];

  // המדיניות ה"אפקטיבית": הבסיס עם דריסות הפרופיל הפעיל (לפי משתמש Windows).
  // שדות רגישים (pinHash/שחזור/manualUnlockUntil/accountability/coolOff) לעולם
  // אינם נדרסים — הם נלקחים תמיד מהבסיס. פונקציה טהורה (לבדיקות + אכיפה).
  function effectiveSchedule(base, username) {
    const eff = normalizeSchedule(base);
    const profile = resolveProfile(eff, username);
    if (profile && profile.overrides) {
      for (const k of PROFILE_OVERRIDE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(profile.overrides, k)) eff[k] = profile.overrides[k];
      }
    }
    return eff;
  }

  function parseScheduleHM(value, allowEndOfDay) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 1440) return null;
      if (value === 1440 && !allowEndOfDay) return null;
      return value;
    }
    const text = String(value == null ? '' : value).trim();
    const match = /^(\d{2}):(\d{2})$/.exec(text);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (m > 59 || h > 23) {
      if (allowEndOfDay && h === 24 && m === 0) return 1440;
      return null;
    }
    return h * 60 + m;
  }

  function normalizeSchedule(s) {
    const base = defaultSchedule();
    if (!s || typeof s !== 'object') return base;
    // מיגרציה שקטה: פרופילים ו-defaultProfile מחושבים תחילה כדי ש-defaultProfile
    // יוכל להתאמת מול המזהים הקיימים; שדות חדשים חסרים מקבלים ברירות מחדל.
    const profiles = normalizeProfiles(s.profiles);
    let defaultProfile = String(s.defaultProfile || '').trim().slice(0, 80) || null;
    if (defaultProfile && !profiles.some((p) => p.id === defaultProfile)) defaultProfile = null;
    const out = {
      version: 1,
      schemaVersion: SCHEMA_VERSION,
      enabled: s.enabled !== false,
      mode: s.mode === 'allowlist' ? 'allowlist' : 'blocklist',
      warnMinutes: (s.warnMinutes === undefined || s.warnMinutes === null || s.warnMinutes === '')
        ? 5 // ברירת מחדל: 5 דקות
        : Math.max(0, Math.min(60, Math.round(Number(s.warnMinutes) || 0))), // 0 = ללא אזהרה
      pinHash: s.pinHash || null,
      pinSalt: s.pinSalt || null,
      pinKdf: s.pinKdf === 'pbkdf2-sha256' ? 'pbkdf2-sha256' : null,
      passwordPlain: s.passwordPlain || null,
      passwordEnc: s.passwordEnc || null,
      theme: ['system', 'light', 'dark'].includes(s.theme) ? s.theme : 'system',
      blockMessage: String(s.blockMessage || '').trim().slice(0, 300),
      overrides: normalizeOverrides(s.overrides),
      startWithWindows: s.startWithWindows !== false, // ברירת מחדל: פעיל (אפליקציית הורים)
      runAsAdmin: s.runAsAdmin === true,
      manualUnlockUntil: s.manualUnlockUntil !== null && s.manualUnlockUntil !== undefined && s.manualUnlockUntil !== '' && Number.isFinite(Number(s.manualUnlockUntil))
        ? Number(s.manualUnlockUntil) : null,
      recoveryEmail: String(s.recoveryEmail || '').trim(),
      recoveryPendingHash: /^[0-9a-f]{64}$/.test(String(s.recoveryPendingHash || '').trim().toLowerCase()) ? String(s.recoveryPendingHash).trim().toLowerCase() : null,
      // null/undefined/'' חייבים להישאר null (אין שחזור ממתין). בלי המשמר הזה
      // Number(null) === 0 היה הופך null ל-0 בנרמול חוזר — שבירת idempotency.
      recoveryPendingUntil: (s.recoveryPendingUntil !== null && s.recoveryPendingUntil !== undefined && s.recoveryPendingUntil !== '' && Number.isFinite(Number(s.recoveryPendingUntil)))
        ? Number(s.recoveryPendingUntil) : null,
      updateUrl: String(s.updateUrl || '').trim(),
      showNetIcon: s.showNetIcon !== false,
      blockBg: ['blobs', 'fluid', 'particles', 'aurora'].includes(s.blockBg) ? s.blockBg : 'blobs',
      showTorahQuotes: s.showTorahQuotes !== false,
      allowedAppsEnabled: s.allowedAppsEnabled !== false,
      allowedApps: normalizeAllowedApps(s.allowedApps),

      /* ---------- שדות סכימה v2 (מיגרציה שקטה, ברירות מחדל בטוחות) ---------- */
      studyMode: normalizeStudyMode(s.studyMode),
      websiteApps: normalizeWebsiteApps(s.websiteApps),
      fileExplorer: normalizeFileExplorer(s.fileExplorer),
      accountabilityEmail: String(s.accountabilityEmail || '').trim().slice(0, 200),
      accountabilityEnabled: s.accountabilityEnabled === true,
      accountabilityRequireApproval: s.accountabilityRequireApproval === true,
      coolOffMinutes: Math.max(0, Math.min(120, Math.round(Number(s.coolOffMinutes) || 0))),
      profiles: profiles,
      defaultProfile: defaultProfile,
      week: normalizeWeek(s.week)
    };
    return out;
  }

  /* ---------- חישוב מצב ---------- */

  // חריג חד-פעמי ליום מסוים = חלון מלא (00:00–24:00) שמוכנס ראשון — כך הוא גובר על הלוח השבועי
  function normalizeOverrides(list) {
    const map = new Map();
    (Array.isArray(list) ? list : []).forEach((o) => {
      if (!o || typeof o !== 'object') return;
      const date = String(o.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const [y, m, d] = date.split('-').map(Number);
      const parsed = new Date(y, m - 1, d);
      if (dateKey(parsed) !== date) return;
      map.set(date, {
        date,
        type: o.type === 'block' ? 'block' : o.type === 'netblock' ? 'netblock' : 'allow'
      });
    });
    return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  function daySlots(schedule, date) {
    const entry = schedule.week[date.getDay()] || { slots: [] };
    const slots = (entry.slots || []).slice();
    const key = dateKey(date);
    const ov = (schedule.overrides || []).find((o) => o.date === key);
    if (ov) {
      slots.unshift({
        start: 0, end: 1440,
        type: ov.type === 'allow' ? 'allowed' : ov.type === 'netblock' ? 'netblock' : 'blocked'
      });
    }
    return slots;
  }

  // חלון שמתחיל אחרי שהוא נגמר = חוצה חצות (למחרת)
  function slotCovers(slot, minutes) {
    if (slot.start < slot.end) return minutes >= slot.start && minutes < slot.end;
    return minutes >= slot.start || minutes < slot.end;
  }

  // החלון הפעיל כרגע (של היום או של אתמול שחוצה חצות) — או null אם אף חלון
  // אינו מכסה את הרגע הנוכחי (ואז המצב נקבע לפי ברירת המחדל של הלוח).
  function activeSlot(schedule, date) {
    const minutes = date.getHours() * 60 + date.getMinutes();
    for (const s of daySlots(schedule, date)) {
      if (slotCovers(s, minutes)) return s;
    }
    const prev = new Date(date);
    prev.setDate(prev.getDate() - 1);
    for (const s of daySlots(schedule, prev)) {
      if (s.start >= s.end && minutes < s.end) return s;
    }
    return null;
  }

  function stateAt(schedule, date) {
    const def = schedule.mode === 'allowlist' ? 'blocked' : 'allowed';
    const slot = activeSlot(schedule, date);
    return slot ? slot.type : def;
  }

  function startOfDay(date, offset) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
  }

  // שעה ספציפית ביום, לפי שדות לוח שנה (ולא לפי הוספת דקות לחצות) — כך
  // שעות החלון נכונות גם ביום שבו משתנה שעון הקיץ (DST), שבו היממה אינה
  // בת 24 שעות בדיוק והוספת דקות לחצות הייתה מזיזה את החלונות בשעה.
  function dayAt(day, minutes) {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60);
  }

  // המעבר הבא בין מותר לחסום (בודק לפחות מחזור שבועי מלא)
  // מדלג על גבולות שאינם משנים בפועל את המצב (למשל שני חלונות זהים סמוכים).
  // בנוסף נבדקים חריגים חד-פעמיים עתידיים, גם אם הם רחוקים ביותר משבוע.
  function nextTransition(schedule, now) {
    const current = stateAt(schedule, now);
    const ats = [];
    const days = new Map();
    const addDay = (day) => days.set(dateKey(day), startOfDay(day, 0));
    for (let i = 0; i < 8; i++) addDay(startOfDay(now, i));
    for (const ov of (schedule.overrides || [])) {
      const parts = String(ov.date).split('-').map(Number);
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) continue;
      const day = new Date(parts[0], parts[1] - 1, parts[2]);
      if (dateKey(day) !== ov.date) continue;
      if (day.getTime() >= startOfDay(now, 0).getTime()) {
        addDay(day);
        addDay(startOfDay(day, 1));
      }
    }
    for (const day of days.values()) {
      for (const s of daySlots(schedule, day)) {
        const start = dayAt(day, s.start);
        let end = dayAt(day, s.end);
        if (s.start >= s.end) end.setDate(end.getDate() + 1);
        ats.push(start);
        ats.push(end);
      }
    }
    ats.sort((a, b) => a - b);
    for (const at of ats) {
      if (at.getTime() > now.getTime()) {
        const probe = new Date(at.getTime() + 1000);
        const to = stateAt(schedule, probe);
        if (to !== current) return { at, to };
      }
    }
    return { at: null, to: null };
  }

  function getStatus(schedule, now) {
    const s = normalizeSchedule(schedule);
    const d = now || new Date();

    if (!s.enabled) {
      return { state: 'allowed', next: null, nextAt: null, secondsUntilNext: null, enabled: false };
    }

    // "פתוח עד המעבר הבא" (manualUnlockUntil) תקף רק כשהלוח עצמו חוסם כרגע.
    // אם החלונות נמחקו או שונו כך שהלוח כבר לא חוסם — ערך ישן שנשאר מהגדרות
    // קודמות אסור להשפיע: אחרת הממשק מציג "המעבר הבא" פנטום (למשל "23:50
    // בג׳ • בעוד 59 דקות") למרות שאין שום חלון מוגדר, והמחשב עלול להישאר
    // פתוח מעבר לחלון החדש שההורה הגדיר.
    const raw = stateAt(s, d);
    const lockedNow = raw === 'blocked' || raw === 'netblock';
    const override = s.manualUnlockUntil && d.getTime() < s.manualUnlockUntil && lockedNow;
    const state = override ? 'allowed' : raw;
    // חסימה לפי ברירת המחדל של "התר" (לוח ריק — חסום תמיד) ולא לפי חלון
    // מוגדר — כדי שמסך החסימה יוכל להסביר להורה מה בדיוק חוסם.
    const byDefault = raw === 'blocked' && s.mode === 'allowlist' && !activeSlot(s, d);
    const t = nextTransition(s, d);
    const nextAt = override ? new Date(s.manualUnlockUntil) : t.at;

    const secondsUntilNext = nextAt ? Math.max(0, Math.round((nextAt.getTime() - d.getTime()) / 1000)) : null;

    // חלון אזהרה לפני חסימה: כשהמחשב עדיין פתוח אבל עומד להיחסם בתוך
    // warnMinutes — מסמנים warning עם ספירה לאחור עד תחילת החסימה.
    // (ההתראה היא רק כשהמעבר הבא הוא לחסימה — מחשב או אינטרנט — ולא בזמן
    // נעילה ידנית/הסרת חסימה.)
    const warnSec = (s.warnMinutes || 0) * 60;
    const warning = !!(
      s.enabled &&
      state === 'allowed' &&
      (t.to === 'blocked' || t.to === 'netblock') &&
      t.at &&
      warnSec > 0 &&
      secondsUntilNext != null &&
      secondsUntilNext <= warnSec
    );

    return {
      state,
      next: t.to,
      nextAt,
      secondsUntilNext,
      enabled: true,
      warnMinutes: s.warnMinutes,
      warning,
      warningSeconds: warning ? secondsUntilNext : null,
      blockedByDefault: byDefault
    };
  }

  /* ---------- עיצוב זמן בעברית ---------- */

  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    if (sec === 0) return 'עכשיו';
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);

    const parts = [];
    if (days > 0) parts.push(days === 1 ? 'יום' : days === 2 ? 'יומיים' : days + ' ימים');
    if (hours > 0) parts.push(hours === 1 ? 'שעה' : hours === 2 ? 'שעתיים' : hours + ' שעות');
    if (mins > 0) parts.push(mins === 1 ? 'דקה' : mins === 2 ? '2 דקות' : mins + ' דקות');
    if (parts.length === 0) return 'פחות מדקה';
    return parts.join(' ו');
  }

  function formatDate(date) {
    return fmtTime(date) + ' ב' + DAY_SHORT_HE[date.getDay()];
  }

  /* ---------- SHA-256 (לטביעת PIN) ---------- */

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  function rrot(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256Hex(str) {
    const utf8 = unescape(encodeURIComponent(String(str || '')));
    const msg = [];
    for (let i = 0; i < utf8.length; i++) msg.push(utf8.charCodeAt(i));
    const bitLen = msg.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    msg.push((Math.floor(bitLen / 0x100000000) >>> 24) & 0xff, (Math.floor(bitLen / 0x100000000) >>> 16) & 0xff, (Math.floor(bitLen / 0x100000000) >>> 8) & 0xff, Math.floor(bitLen / 0x100000000) & 0xff);
    msg.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

    const h = H0.slice();
    for (let i = 0; i < msg.length; i += 64) {
      const w = new Array(64);
      for (let j = 0; j < 16; j++) {
        w[j] = ((msg[i + j * 4] << 24) | (msg[i + j * 4 + 1] << 16) | (msg[i + j * 4 + 2] << 8) | msg[i + j * 4 + 3]) >>> 0;
      }
      for (let j = 16; j < 64; j++) {
        const s0 = rrot(w[j - 15], 7) ^ rrot(w[j - 15], 18) ^ (w[j - 15] >>> 3);
        const s1 = rrot(w[j - 2], 17) ^ rrot(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
      }
      let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let j = 0; j < 64; j++) {
        const S1 = rrot(e, 6) ^ rrot(e, 11) ^ rrot(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[j] + w[j]) >>> 0;
        const S0 = rrot(a, 2) ^ rrot(a, 13) ^ rrot(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return h.map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  /* ---------- אימות סיסמה ---------- */

  function isValidPassword(pw) {
    return typeof pw === 'string' && /^\S{4,20}$/.test(pw);
  }

  return {
    parseHM,
    fmtHM,
    fmtTime,
    dateKey,
    DAY_NAMES_HE,
    DAY_SHORT_HE,
    SCHEMA_VERSION,
    defaultSchedule,
    normalizeSchedule,
    stateAt,
    nextTransition,
    getStatus,
    formatDuration,
    formatDate,
    sha256Hex,
    isValidPassword,
    // שדות סכימה v2 — עזרים טהורים (משותפים ל-Node ולדפדפן)
    normalizeUrl,
    hostMatches,
    siteUrlAllowed,
    normalizeExtension,
    resolveProfile,
    effectiveSchedule,
    isHiddenType
  };
});
