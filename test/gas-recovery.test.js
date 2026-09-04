// בדיקת רגרסיה לתקינות ביטוי כתובת המייל בשרת השחזור (Google Apps Script).
// באג קודם השתמש ב-[^\\s@] ו-\\. בתוך regex literal — מה שהתאים ל-backslash
// ליטרלי ודחה כל כתובת מייל תקינה, ובכך שבר את שחזור הסיסמה לחלוטין.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const gasFile = path.join(__dirname, '..', 'gas', 'PasswordRecovery.gs');
const source = fs.readFileSync(gasFile, 'utf8');

// הביטוי התקין (\s ל-whitespace, \. לנקודה ליטרלית) — חייב להתקיים בקוד המקור
const CORRECT = '/^[a-z0-9][^\\s@]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i';
// הביטוי השבור (\\s ו-\\. — backslash ליטרלי) — אסור שיישאר בקוד המקור
const BROKEN = '/^[a-z0-9][^\\\\s@]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i';

test('GAS recovery: source uses the corrected email regex and drops the broken one', () => {
  assert.ok(source.includes(CORRECT), 'שרת השחזור חייב להשתמש בביטוי המתוקן (\\s ו-\\.)');
  assert.ok(!source.includes(BROKEN), 'אסור שהביטוי השבור (\\\\s ו-\\\\.) יישאר בקוד');
});

test('GAS recovery: email regex accepts valid and rejects invalid addresses', () => {
  const re = /^[a-z0-9][^\s@]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
  for (const e of ['test@example.com', 'user.name+tag@sub.example.co.il', 'a@b.co', 'mytovmail@gmail.com']) {
    assert.ok(re.test(e), 'צריך לקבל כתובת תקינה: ' + e);
  }
  for (const e of ['no-at', 'a@b', 'a b@c.com', 'a@@b.com', '@x.com', 'x@.com', '']) {
    assert.ok(!re.test(e), 'צריך לדחות כתובת לא תקינה: ' + e);
  }
});
