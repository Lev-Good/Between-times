// בדיקות סכימה v2: schemaVersion + מיגרציה שקטה + השדות החדשים
// (studyMode, websiteApps, fileExplorer, accountability, profiles) + עזרי URL.
process.env.TZ = 'Asia/Jerusalem';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../scheduler.js');

/* ================= schemaVersion + מיגרציה שקטה ================= */

test('schema: defaultSchedule carries schemaVersion=2 and all v2 fields', () => {
  const d = S.defaultSchedule();
  assert.equal(d.schemaVersion, 2);
  assert.deepEqual(d.studyMode, { enabled: false, scope: 'blocked' });
  assert.deepEqual(d.websiteApps, []);
  assert.deepEqual(d.fileExplorer, { enabled: false, roots: ['documents', 'downloads'], readonlyLibrary: true, hiddenTypes: [], libraryPath: '' });
  assert.equal(d.accountabilityEmail, '');
  assert.equal(d.accountabilityEnabled, false);
  assert.deepEqual(d.profiles, []);
  assert.equal(d.defaultProfile, null);
});

test('schema: normalize sets schemaVersion=2 even for a legacy config that lacks it', () => {
  const legacy = { version: 1, enabled: true, mode: 'blocklist', week: [] }; // v1.5.10 style
  const n = S.normalizeSchedule(legacy);
  assert.equal(n.schemaVersion, 2);
});

test('migration: a v1.5.10 config is silently upgraded WITHOUT losing existing settings', () => {
  // קובץ ישן: לוח שבועי, סיסמה, תוכנות מותרות, מצב allowlist — כולם חייבים לשרוד
  const legacy = {
    version: 1,
    enabled: true,
    mode: 'allowlist',
    warnMinutes: 10,
    pinHash: 'a'.repeat(64),
    pinSalt: 'c2FsdA==',
    pinKdf: 'pbkdf2-sha256',
    blockMessage: 'הודעה',
    allowedAppsEnabled: true,
    allowedApps: [{ name: 'וורד', exe: 'C:\\Office\\WINWORD.EXE', mode: 'path' }],
    week: [{ day: 0, slots: [{ start: '08:00', end: '20:00', type: 'blocked' }] }]
  };
  const n = S.normalizeSchedule(legacy);
  // הגדרות קיימות נשמרו
  assert.equal(n.mode, 'allowlist');
  assert.equal(n.warnMinutes, 10);
  assert.equal(n.pinHash, 'a'.repeat(64));
  assert.equal(n.pinKdf, 'pbkdf2-sha256');
  assert.equal(n.blockMessage, 'הודעה');
  assert.equal(n.allowedApps.length, 1);
  assert.equal(n.allowedApps[0].exe, 'C:\\Office\\WINWORD.EXE');
  assert.equal(n.week[0].slots[0].start, 480);
  assert.equal(n.week[0].slots[0].end, 1200);
  // שדות v2 נוספו עם ברירות מחדל בטוחות (כבויים)
  assert.equal(n.schemaVersion, 2);
  assert.equal(n.studyMode.enabled, false);
  assert.equal(n.fileExplorer.enabled, false);
  assert.equal(n.accountabilityEnabled, false);
  assert.deepEqual(n.websiteApps, []);
  assert.deepEqual(n.profiles, []);
});

/* ================= studyMode ================= */

test('studyMode: normalize enforces enabled boolean and scope enum', () => {
  assert.deepEqual(S.normalizeSchedule({ studyMode: { enabled: true, scope: 'always' } }).studyMode,
    { enabled: true, scope: 'always' });
  assert.deepEqual(S.normalizeSchedule({ studyMode: { enabled: 1, scope: 'weird' } }).studyMode,
    { enabled: false, scope: 'blocked' }); // enabled רק בוליאני אמיתי; scope לא ידוע -> blocked
  assert.deepEqual(S.normalizeSchedule({ studyMode: 'nonsense' }).studyMode,
    { enabled: false, scope: 'blocked' });
});

/* ================= websiteApps + URL helpers ================= */

test('normalizeUrl: adds https, lowercases host, strips default port and trailing slash', () => {
  assert.equal(S.normalizeUrl('Example.com'), 'https://example.com');
  assert.equal(S.normalizeUrl('http://Example.com/'), 'http://example.com');
  assert.equal(S.normalizeUrl('https://sub.example.com:443/path'), 'https://sub.example.com/path');
  assert.equal(S.normalizeUrl('https://example.com:8443'), 'https://example.com:8443');
  assert.equal(S.normalizeUrl('  https://example.com/a/b  '), 'https://example.com/a/b');
});

test('normalizeUrl: rejects non-http(s), non-domain and malicious schemes', () => {
  assert.equal(S.normalizeUrl('ftp://example.com'), null);
  assert.equal(S.normalizeUrl('javascript:alert(1)'), null);
  assert.equal(S.normalizeUrl('data:text/html,x'), null);
  assert.equal(S.normalizeUrl('localhost'), null); // חייב דומיין מלא (עם נקודה)
  assert.equal(S.normalizeUrl(''), null);
  assert.equal(S.normalizeUrl(null), null);
});

test('websiteApps: normalize keeps valid, drops url-less, dedupes by name, canonicalizes urls', () => {
  const n = S.normalizeSchedule({
    websiteApps: [
      { name: 'ויקיפדיה', urls: ['he.wikipedia.org', 'https://he.wikipedia.org/'] }, // כפילות url -> אחת
      { name: 'ריק', urls: ['not a url', 'javascript:x'] }, // אין url תקין -> נמחק
      { name: 'ויקיפדיה', urls: ['https://en.wikipedia.org'] } // כפילות שם -> נמחק
    ]
  });
  assert.equal(n.websiteApps.length, 1);
  assert.equal(n.websiteApps[0].name, 'ויקיפדיה');
  assert.deepEqual(n.websiteApps[0].urls, ['https://he.wikipedia.org']);
});

test('websiteApps: entry without a name gets its host as the name', () => {
  const n = S.normalizeSchedule({ websiteApps: [{ urls: ['https://kikar.co.il/news'] }] });
  assert.equal(n.websiteApps[0].name, 'kikar.co.il');
});

test('hostMatches + siteUrlAllowed: host-based allowlist with subdomain control', () => {
  assert.equal(S.hostMatches('example.com', 'example.com', true), true);
  assert.equal(S.hostMatches('example.com', 'sub.example.com', true), true);
  assert.equal(S.hostMatches('example.com', 'sub.example.com', false), false);
  assert.equal(S.hostMatches('example.com', 'notexample.com', true), false);
  assert.equal(S.hostMatches('example.com', 'evil-example.com', true), false);

  const apps = [{ name: 'wiki', urls: ['https://wikipedia.org'] }];
  assert.equal(S.siteUrlAllowed(apps, 'https://en.wikipedia.org/wiki/X'), true); // תת-דומיין
  assert.equal(S.siteUrlAllowed(apps, 'https://wikipedia.org'), true);
  assert.equal(S.siteUrlAllowed(apps, 'https://evil.com'), false);
  assert.equal(S.siteUrlAllowed(apps, 'ftp://wikipedia.org'), false); // סכימה לא מותרת
  assert.equal(S.siteUrlAllowed(apps, 'http://wikipedia.org'), false, 'https approval does not allow http downgrade');
  assert.equal(S.siteUrlAllowed(apps, 'https://wikipedia.org:8443'), false, 'approval does not allow another port');
  assert.equal(S.siteUrlAllowed(apps, 'https://en.wikipedia.org', false), false); // ללא תת-דומיינים
});

/* ================= fileExplorer ================= */

test('fileExplorer: normalize filters roots to known keys and defaults when empty', () => {
  const n = S.normalizeSchedule({ fileExplorer: { enabled: true, roots: ['documents', 'C:\\secret', 'downloads', 'documents'] } });
  assert.equal(n.fileExplorer.enabled, true);
  assert.deepEqual(n.fileExplorer.roots, ['documents', 'downloads']); // נתיב לא ידוע נדחה, כפילות מוסרת
  const empty = S.normalizeSchedule({ fileExplorer: { enabled: true, roots: ['bogus'] } });
  assert.deepEqual(empty.fileExplorer.roots, ['documents', 'downloads']); // אחרי סינון ריק -> ברירת מחדל
});

test('fileExplorer: readonlyLibrary defaults true and can be turned off; hiddenTypes normalized', () => {
  assert.equal(S.normalizeSchedule({ fileExplorer: {} }).fileExplorer.readonlyLibrary, true);
  assert.equal(S.normalizeSchedule({ fileExplorer: { readonlyLibrary: false } }).fileExplorer.readonlyLibrary, false);
  const n = S.normalizeSchedule({ fileExplorer: { hiddenTypes: ['EXE', '.bat', 'exe', 'bad ext', '.mp4'] } });
  assert.deepEqual(n.fileExplorer.hiddenTypes, ['.exe', '.bat', '.mp4']); // lowercase, leading dot, dedupe, invalid dropped
});

test('fileExplorer: libraryPath accepts only absolute paths', () => {
  assert.equal(S.normalizeSchedule({ fileExplorer: { libraryPath: 'C:\\Study' } }).fileExplorer.libraryPath, 'C:\\Study');
  assert.equal(S.normalizeSchedule({ fileExplorer: { libraryPath: '\\\\server\\share' } }).fileExplorer.libraryPath, '\\\\server\\share');
  assert.equal(S.normalizeSchedule({ fileExplorer: { libraryPath: 'relative\\path' } }).fileExplorer.libraryPath, '', 'relative path rejected');
  assert.equal(S.normalizeSchedule({ fileExplorer: {} }).fileExplorer.libraryPath, '');
});

test('isHiddenType: hides files by extension (case-insensitive), spares others and extension-less names', () => {
  const hidden = ['.exe', '.mp4'];
  assert.equal(S.isHiddenType(hidden, 'game.EXE'), true);
  assert.equal(S.isHiddenType(hidden, 'movie.mp4'), true);
  assert.equal(S.isHiddenType(hidden, 'notes.txt'), false);
  assert.equal(S.isHiddenType(hidden, 'README'), false); // ללא סיומת
  assert.equal(S.isHiddenType([], 'anything.exe'), false); // רשימה ריקה — לא מסתירה כלום
});

/* ================= accountability ================= */

test('accountability: email trimmed, enabled defaults false and toggles', () => {
  const n = S.normalizeSchedule({ accountabilityEmail: '  partner@example.com  ', accountabilityEnabled: true });
  assert.equal(n.accountabilityEmail, 'partner@example.com');
  assert.equal(n.accountabilityEnabled, true);
  assert.equal(S.normalizeSchedule({}).accountabilityEnabled, false);
  assert.equal(S.normalizeSchedule({ accountabilityEnabled: 'yes' }).accountabilityEnabled, false); // רק בוליאני אמיתי
});

test('accountability: requireApproval defaults false and is a strict boolean', () => {
  assert.equal(S.defaultSchedule().accountabilityRequireApproval, false);
  assert.equal(S.normalizeSchedule({ accountabilityRequireApproval: true }).accountabilityRequireApproval, true);
  assert.equal(S.normalizeSchedule({ accountabilityRequireApproval: 1 }).accountabilityRequireApproval, false);
});

test('coolOffMinutes: defaults 0 and clamps to 0..120 (rounded)', () => {
  assert.equal(S.defaultSchedule().coolOffMinutes, 0);
  assert.equal(S.normalizeSchedule({ coolOffMinutes: 10 }).coolOffMinutes, 10);
  assert.equal(S.normalizeSchedule({ coolOffMinutes: -5 }).coolOffMinutes, 0);
  assert.equal(S.normalizeSchedule({ coolOffMinutes: 999 }).coolOffMinutes, 120);
  assert.equal(S.normalizeSchedule({ coolOffMinutes: 7.6 }).coolOffMinutes, 8);
  assert.equal(S.normalizeSchedule({ coolOffMinutes: 'x' }).coolOffMinutes, 0);
});

/* ================= profiles + resolveProfile ================= */

test('profiles: normalize derives id, dedupes, drops meaningless, keeps only present overrides', () => {
  const n = S.normalizeSchedule({
    profiles: [
      { name: 'אבא', user: 'ABBA', overrides: { mode: 'allowlist', warnMinutes: 3, unknownField: 7 } },
      { user: 'abba' }, // כפילות id (user:abba) -> נמחק
      { foo: 'bar' }, // ללא שם וללא משתמש -> נמחק
      { name: 'ידני' } // פרופיל ידני בעל שם
    ]
  });
  assert.equal(n.profiles.length, 2);
  const abba = n.profiles[0];
  assert.equal(abba.id, 'user:abba');
  assert.equal(abba.name, 'אבא');
  assert.equal(abba.user, 'abba'); // אותיות קטנות
  assert.deepEqual(abba.overrides, { mode: 'allowlist', warnMinutes: 3 }); // רק מפתחות מוכרים שהופיעו
  assert.equal(n.profiles[1].id, 'name:ידני');
  assert.equal(n.profiles[1].user, '');
});

test('profiles: overrides normalize nested policy fields (week/allowedApps/studyMode)', () => {
  const n = S.normalizeSchedule({
    profiles: [{
      name: 'p', user: 'u',
      overrides: {
        week: [{ day: 0, slots: [{ start: '09:00', end: '17:00', type: 'blocked' }] }],
        allowedApps: [{ name: 'w', exe: 'C:\\w.exe' }],
        studyMode: { enabled: true, scope: 'always' }
      }
    }]
  });
  const o = n.profiles[0].overrides;
  assert.equal(o.week[0].slots[0].start, 540);
  assert.equal(o.allowedApps[0].exe, 'C:\\w.exe');
  assert.deepEqual(o.studyMode, { enabled: true, scope: 'always' });
});

test('defaultProfile: kept only when it references an existing profile id', () => {
  const good = S.normalizeSchedule({ defaultProfile: 'user:u', profiles: [{ name: 'p', user: 'u' }] });
  assert.equal(good.defaultProfile, 'user:u');
  const bad = S.normalizeSchedule({ defaultProfile: 'missing', profiles: [{ name: 'p', user: 'u' }] });
  assert.equal(bad.defaultProfile, null);
});

test('resolveProfile: matches by Windows user, else defaultProfile, else null', () => {
  const s = S.normalizeSchedule({
    defaultProfile: 'name:general',
    profiles: [
      { name: 'general', user: '' },
      { name: 'dad', user: 'dad' }
    ]
  });
  assert.equal(S.resolveProfile(s, 'DAD').id, 'user:dad'); // case-insensitive
  assert.equal(S.resolveProfile(s, 'nobody').id, 'name:general'); // נופל ל-default
  const noDefault = S.normalizeSchedule({ profiles: [{ name: 'dad', user: 'dad' }] });
  assert.equal(S.resolveProfile(noDefault, 'nobody'), null); // אין התאמה ואין default
});

test('effectiveSchedule: overlays the matching profile; sensitive fields always from base', () => {
  const base = S.normalizeSchedule({
    pinHash: 'a'.repeat(64), pinKdf: 'pbkdf2-sha256', pinSalt: 'c2FsdA==',
    coolOffMinutes: 5, accountabilityEmail: 'p@e.com', accountabilityEnabled: true,
    mode: 'blocklist',
    profiles: [{ name: 'dad', user: 'dad', overrides: { mode: 'allowlist', warnMinutes: 3 } }],
    defaultProfile: 'user:dad'
  });
  const eff = S.effectiveSchedule(base, 'DAD');
  assert.equal(eff.mode, 'allowlist', 'overridable field taken from profile');
  assert.equal(eff.warnMinutes, 3);
  assert.equal(eff.pinHash, 'a'.repeat(64), 'pinHash preserved from base (never overridable)');
  assert.equal(eff.coolOffMinutes, 5, 'coolOffMinutes preserved from base');
  assert.equal(eff.accountabilityEnabled, true, 'accountability preserved from base');
  // התאמה לפי משתמש קודמת ל-default (אותו פרופיל כאן), וללא התאמה+ללא default → בסיס
  const base2 = S.normalizeSchedule({ mode: 'blocklist', profiles: [{ name: 'dad', user: 'dad', overrides: { mode: 'allowlist' } }] });
  assert.equal(S.effectiveSchedule(base2, 'nobody').mode, 'blocklist', 'no match + no default → base unchanged');
  assert.equal(S.effectiveSchedule(base2, 'dad').mode, 'allowlist', 'match → override');
});

/* ================= idempotency של השדות החדשים ================= */

test('schema v2: normalize is idempotent for a fully-populated v2 config', () => {
  const rich = S.normalizeSchedule({
    studyMode: { enabled: true, scope: 'always' },
    websiteApps: [{ name: 'a', urls: ['https://a.com', 'https://b.co.il/x'] }],
    fileExplorer: { enabled: true, roots: ['library', 'documents'], readonlyLibrary: false, hiddenTypes: ['.exe'] },
    accountabilityEmail: 'p@e.com', accountabilityEnabled: true,
    profiles: [{ name: 'x', user: 'x', overrides: { mode: 'allowlist', week: [{ day: 1, slots: [{ start: '01:00', end: '02:00', type: 'netblock' }] }] } }],
    defaultProfile: 'user:x'
  });
  const again = S.normalizeSchedule(JSON.parse(JSON.stringify(rich)));
  assert.deepEqual(again, rich);
});
