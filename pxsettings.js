const $ = id => document.getElementById(id);
const px = m => new Promise(r => chrome.runtime.sendMessage(m, x => r(chrome.runtime.lastError ? null : x)));
const F = { host:'host', min:'portMin', max:'portMax', user:'user', pass:'pass', scope:'scope', dom:'domains' };
const msg = (t, c) => { $('msg').textContent = t || ''; $('msg').className = c || ''; };

async function load() {
  const r = await px({ px:'get' }); if (!r) { msg('Background se jawab nahi', 'bad'); return; }
  if ($('rot')) { const c = await px({ px:'cfgget' }); if (c) $('rot').value = c.rotateEveryN ?? 50; }
  for (const [el,k] of Object.entries(F)) if ($(el)) $(el).value = r.cfg[k] ?? '';
  $('on').checked = !!r.cfg.enabled;

  // Yelp domain ki list background se aati hai (DOMAIN_HOST)
  const sel = $('yelpDom');
  if (sel && r.domains) {
    if (!sel.options.length) {
      for (const [code, host] of Object.entries(r.domains)) {
        const o = document.createElement('option');
        o.value = code; o.textContent = host + '   (' + code + ')';
        sel.appendChild(o);
      }
    }
    if (r.domain) sel.value = r.domain;
  }
  $('port').textContent = '· port ' + r.port;
  $('sw').textContent = r.switches ? '· ' + r.switches + ' switches' : '';
}
async function showIp() {
  $('ip').textContent = '…';
  msg('Check kar raha hoon… (20s tak lag sakte hain)');
  const r = await px({ px:'ip' });
  if (!r) { $('ip').textContent = '—'; msg('Background se jawab hi nahi aaya. Extension reload karo.', 'bad'); return; }
  $('port').textContent = '· port ' + r.port;
  if (r.ip) {
    $('ip').textContent = r.ip;
    msg(r.on ? 'Proxy ON — ye exit IP hai' : 'Proxy OFF — ye tumhara apna IP hai. Upar "Proxy ON" tick karke Save karo.', r.on ? 'ok' : 'bad');
  } else {
    $('ip').textContent = 'nahi mila';
    msg('Nahi chala — ' + (r.err || 'wajah nahi mili') + (r.on ? '  (proxy ON hai, yani ' + r.host + ' tak pahunch nahi hui)' : '  (proxy OFF hai — tumhara net hi nahi chal raha?)'), 'bad');
  }
}
function grab() {
  const c = {};
  for (const [el,k] of Object.entries(F)) c[k] = $(el).value.trim();
  c.portMin = parseInt(c.portMin,10)||0; c.portMax = parseInt(c.portMax,10)||0;
  c.enabled = $('on').checked; c.idx = 0;
  c._rotateEveryN = parseInt(($('rot')||{}).value, 10) || 50;
  return c;
}
$('save').onclick  = async () => {
  if ($('yelpDom') && $('yelpDom').value) {
    const d = await px({ px: 'domain', domain: $('yelpDom').value });
    if (d && d.ok) msg('Domain ab ' + d.host, 'ok');
  } const r = await px({px:'save', cfg:grab()}); await load(); if (r&&r.ok) { msg('Save ho gaya','ok'); showIp(); } else msg((r&&r.msg)||'Save hua par proxy set nahi','bad'); };
$('check').onclick = showIp;
$('next').onclick  = async () => {
  msg('Naya IP le raha hoon… (20s tak)');
  const r = await px({px:'next'}); await load();
  if (r && r.ip) { $('ip').textContent = r.ip; msg('Naya IP mil gaya — port ' + r.port, 'ok'); }
  else { $('ip').textContent = 'nahi mila'; msg('Switch fail — ' + ((r && (r.err || r.msg)) || 'wajah nahi mili'), 'bad'); }
};
$('exp').onclick   = async () => {
  const r = await px({px:'get'}); if(!r) return;
  const b = new Blob([JSON.stringify({_proxy:1, ...r.cfg}, null, 2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'proxy-settings.json'; a.click();
  msg('File download ho gayi — doosri extension mein Import karo','ok');
};
$('imp').onclick = () => $('file').click();
$('file').onchange = async e => {
  const f = e.target.files && e.target.files[0]; if(!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d._proxy) { msg('Ye proxy settings file nahi','bad'); return; }
    delete d._proxy; d.idx = 0;
    await px({px:'save', cfg:d}); await load(); showIp();
    msg('Import ho gaya','ok');
  } catch(err){ msg('File padhi nahi gayi','bad'); }
  e.target.value = '';
};
load().then(showIp);
