'use strict';
/**
 * בונה preview.html עצמאי (CSS + JS מוטבעים) לתצוגה בדפדפן.
 * כך אפשר להציג ולתפעל את הממשק בלי לשרת קבצים נלווים.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
let css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const scheduler = fs.readFileSync(path.join(root, 'scheduler.js'), 'utf8');
const guide = fs.readFileSync(path.join(root, 'renderer', 'guide-content.js'), 'utf8');
const tour = fs.readFileSync(path.join(root, 'renderer', 'tour.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');

// הטמעת הפונטים כבסיס-64 — כך ש-preview.html נשאר קובץ עצמאי בלי תלות בשרת קבצים
css = css.replace(/url\(['"]?\.\.\/assets\/fonts\/([a-z-]+\.woff2)['"]?\)/g, (m, name) => {
  try {
    const buf = fs.readFileSync(path.join(root, 'assets', 'fonts', name));
    return "url('data:font/woff2;base64," + buf.toString('base64') + "')";
  } catch {
    return m;
  }
});

// גם המדריך והסיור מוטבעים — אחרת preview.html מפנה לקבצים שאינם נגישים
// (404 בקונסולה) ולא ניתן לבדוק בו את חלון העזרה והמלווה האישי.
let out = html
  .replace('<link rel="stylesheet" href="styles.css" />', '<style>\n' + css + '\n</style>')
  .replace('<script src="../scheduler.js"></script>', '<script>\n' + scheduler + '\n</script>')
  .replace('<script src="guide-content.js"></script>', '<script>\n' + guide + '\n</script>')
  .replace('<script src="tour.js"></script>', '<script>\n' + tour + '\n</script>')
  .replace('<script src="app.js"></script>', '<script>\n' + app + '\n</script>');

fs.writeFileSync(path.join(root, 'preview.html'), out);
console.log('✓ preview.html נבנה (' + out.length + ' תווים)');
