const $ = id => document.getElementById(id);
const KEY = 'site_reminders_v1';

const COLORS = { none:'#fff', grey:'#adb5bd', green:'#40c057', orange:'#fd7e14', red:'#fa5252' };
let items = [], filter = 'all';

try { items = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { items = []; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {} }

function hostOf(u) {
  try { return new URL(u.startsWith('http') ? u : 'https://' + u).hostname.replace(/^www\./,''); }
  catch (e) { return ''; }
}
function initials(t) { return (t || '?').trim().charAt(0).toUpperCase(); }
function hue(s) { let h = 0; for (const c of (s||'x')) h = (h*31 + c.charCodeAt(0)) % 360; return h; }
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function render() {
  const list = $('list'), empty = $('empty');
  const shown = filter === 'all' ? items : items.filter(i => i.prio === filter);
  list.innerHTML = '';
  empty.style.display = shown.length ? 'none' : 'block';

  shown.forEach(it => {
    const i = items.indexOf(it);
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      `<div class="fav" style="background:hsl(${hue(it.title)},62%,48%)">${esc(initials(it.title))}</div>
       <div class="nm" title="${esc(it.url)}">${esc(it.title)}</div>
       ${it.prio && it.prio !== 'none' ? `<div class="pd" style="background:${COLORS[it.prio]}"></div>` : ''}
       ${it.remind ? '<span class="ic al" title="Reminder set">&#9200;</span>' : ''}
       <span class="ic ed" data-e="${i}" title="Edit">&#9998;</span>
       <span class="ic dl" data-d="${i}" title="Delete">&#10005;</span>`;
    row.querySelector('.nm').addEventListener('click', () => {
      if (it.url) chrome.tabs.create({ url: it.url.startsWith('http') ? it.url : 'https://' + it.url });
    });
    row.querySelector('[data-e]').addEventListener('click', () => edit(i));
    row.querySelector('[data-d]').addEventListener('click', () => { items.splice(i,1); save(); render(); });
    list.appendChild(row);
  });
}

function edit(i) {
  const it = items[i]; if (!it) return;
  $('fUrl').value = it.url || '';
  $('fTitle').value = it.title || '';
  $('prio').value = it.prio || 'none';
  $('remind').value = it.remind || '';
  paintPrio();
  $('card').classList.remove('hide');
  $('secHd').classList.remove('closed');
  items.splice(i,1); save(); render();
  $('fTitle').focus();
}

function paintPrio() {
  const v = $('prio').value;
  const el = $('prio');
  if (v === 'none') { el.style.background = '#adb5bd'; el.style.color = '#fff'; el.style.borderColor = '#adb5bd'; }
  else { el.style.background = COLORS[v]; el.style.color = '#fff'; el.style.borderColor = COLORS[v]; }
}

// ── form actions ──
$('bAdd').addEventListener('click', () => {
  const url = $('fUrl').value.trim(), title = $('fTitle').value.trim();
  if (!url) { $('fUrl').focus(); return; }
  if (!title) { $('fTitle').focus(); return; }
  items.unshift({ url, title, prio: $('prio').value, remind: $('remind').value, at: Date.now() });
  save(); render();
  $('fUrl').value = ''; $('fTitle').value = '';
  $('prio').value = 'none'; $('remind').value = ''; paintPrio();
});

$('bCur').addEventListener('click', () => {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const t = tabs && tabs[0];
      if (t) { $('fUrl').value = t.url || ''; $('fTitle').value = t.title || ''; }
    });
  } catch (e) {}
});

$('bClr').addEventListener('click', () => {
  $('fUrl').value = ''; $('fTitle').value = '';
  $('prio').value = 'none'; $('remind').value = ''; paintPrio();
});

$('prio').addEventListener('change', paintPrio);

$('secHd').addEventListener('click', () => {
  $('secHd').classList.toggle('closed');
  $('card').classList.toggle('hide');
});

document.querySelectorAll('.dot').forEach(d => {
  d.addEventListener('click', () => {
    document.querySelectorAll('.dot').forEach(x => x.classList.remove('on'));
    d.classList.add('on');
    filter = d.dataset.p;
    render();
  });
});

$('clearAll').addEventListener('click', () => {
  if (!items.length) return;
  if (confirm('Clear all site reminders?')) { items = []; save(); render(); }
});

[$('fUrl'), $('fTitle')].forEach(el =>
  el.addEventListener('keydown', e => { if (e.key === 'Enter') $('bAdd').click(); }));

// pehli baar sample (bilkul asli lage)
if (!items.length) {
  items = [
    { url:'https://github.com',   title:'Sergey Levkovich',              prio:'orange', remind:'',   at:Date.now() },
    { url:'https://photopea.com', title:'Photopea | Online Photo Editor', prio:'green',  remind:'1d', at:Date.now() },
    { url:'https://mail.google.com', title:'Inbox (6)',                  prio:'red',    remind:'',   at:Date.now() }
  ];
  save();
}

paintPrio();
render();
