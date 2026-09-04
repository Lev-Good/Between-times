'use strict';

var API = window.electronAPI;
var roots = [];
var current = { id: null, rel: '', readonly: false };

function fmtSize(n) {
  if (!n) return '';
  var units = ['B', 'KB', 'MB', 'GB'];
  var i = 0;
  var value = n;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return (i === 0 ? value : value.toFixed(1)) + ' ' + units[i];
}

function parentRel(rel) {
  if (!rel) return '';
  var parts = String(rel).split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.join('\\');
}

function renderRoots() {
  var box = document.getElementById('roots');
  box.textContent = '';
  roots.forEach(function (root) {
    var button = document.createElement('button');
    button.className = 'root-btn' + (root.id === current.id ? ' active' : '');
    button.textContent = root.label;
    button.onclick = function () { load(root.id, ''); };
    box.appendChild(button);
  });
}

function showError(msg) {
  var list = document.getElementById('list');
  list.textContent = '';
  var message = document.createElement('div');
  message.className = 'err';
  message.textContent = msg || 'שגיאה';
  list.appendChild(message);
}

async function load(rootId, rel) {
  if (!API) { showError('זמין רק בגרסת המחשב המלאה'); return; }
  var res = await API.fileExplorerList(rootId, rel || '');
  if (!res || !res.ok) { showError((res && res.error) || 'לא ניתן להציג את התיקייה'); return; }
  current = { id: res.root.id, rel: res.rel || '', readonly: !!res.root.readonly };
  renderRoots();
  document.getElementById('crumb').textContent = res.root.label + (current.rel ? '  \\  ' + current.rel : '');
  document.getElementById('roBadge').style.display = current.readonly ? '' : 'none';
  document.getElementById('upBtn').disabled = !current.rel;

  var list = document.getElementById('list');
  list.textContent = '';
  if (!res.items.length) {
    var empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'התיקייה ריקה';
    list.appendChild(empty);
    return;
  }
  res.items.forEach(function (item) {
    var row = document.createElement('div');
    row.className = 'row' + (item.isDir ? ' dir' : '');
    var icon = document.createElement('span');
    icon.className = 'ico';
    icon.textContent = item.isDir ? 'תיקייה' : 'קובץ';
    var name = document.createElement('span');
    name.className = 'nm';
    name.textContent = item.name;
    var meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = item.isDir ? '' : fmtSize(item.size);
    row.append(icon, name, meta);
    row.onclick = function () {
      var childRel = current.rel ? (current.rel + '\\' + item.name) : item.name;
      if (item.isDir) load(current.id, childRel);
      else API.fileExplorerOpen(current.id, childRel);
    };
    list.appendChild(row);
  });
}

document.getElementById('upBtn').onclick = function () {
  if (current.rel) load(current.id, parentRel(current.rel));
};

(async function init() {
  if (!API) { showError('זמין רק בגרסת המחשב המלאה'); return; }
  var res = await API.fileExplorerRoots();
  if (!res || !res.ok) { showError((res && res.error) || 'סייר הקבצים אינו זמין'); return; }
  roots = res.roots || [];
  if (!roots.length) { showError('לא הוגדרו שורשים מאושרים'); return; }
  load(roots[0].id, '');
})();
