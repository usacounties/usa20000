const $ = id => document.getElementById(id);
const msg = (action, data={}) => new Promise(r => {
  try {
    chrome.runtime.sendMessage({action,...data}, resp => {
      // SW abhi jaga nahi ya band — lastError ko chup-chaap handle karo
      if (chrome.runtime.lastError) { r(null); return; }
      r(resp);
    });
  } catch (e) { r(null); }
});

function parseUrls(t){ if(!t||!t.trim())return[]; return t.replace(/\r/g,'').split('\n').map(l=>l.trim())
  .filter(l=>l.startsWith('http')&&(l.includes('yelp.com')||l.includes('yelp.co.uk')||l.includes('yelp.com.au'))); }
function parseAnyUrls(t){ if(!t)return[]; return [...new Set(t.replace(/\r/g,'').split('\n')
  .map(l=>l.trim().split('?')[0].split('#')[0]).filter(l=>l.startsWith('http')))]; }

document.addEventListener('DOMContentLoaded', async () => {
  const scrapeBtn=$('scrapeBtn'), urlInput=$('urlInput'), urlCount=$('urlCount'), logEl=$('log'),
    statusEl=$('status'), cacheCount=$('cacheCount'), fileInput=$('fileInput'), fileName=$('fileName'),
    addBulkBtn=$('addBulkBtn'), exportBtn=$('exportBtn'), clearDbBtn=$('clearDbBtn'),
    blockedBanner=$('blockedBanner'), blockMsg=$('blockMsg'), resumeBtn=$('resumeBtn'),
    foundBig=$('foundBig'), heroSub=$('heroSub'), live=$('live'),
    cBatch=$('cBatch'), cBlocked=$('cBlocked'), cCache=$('cCache'),
    pLbl=$('pLbl'), pPct=$('pPct'), pBar=$('pBar');
  let fileUrls=[];

  const openTab=$('openTab');
  if(new URLSearchParams(location.search).get('tab')==='1'){document.body.classList.add('tab-mode');openTab.style.display='none';}
  openTab.addEventListener('click',e=>{e.preventDefault();chrome.tabs.create({url:chrome.runtime.getURL('popup.html?tab=1')});});

  const appendLog=m=>{logEl.textContent+=m+'\n';logEl.scrollTop=logEl.scrollHeight;};
  const clearLog=()=>logEl.textContent='';
  const setStatus=m=>statusEl.textContent='● '+m;
  const setRunning=on=>{scrapeBtn.disabled=on;scrapeBtn.innerHTML=on?'<span class="spinner"></span>Running...':'🚀 Start';live.style.display=on?'flex':'none';};
  const refreshCount=async()=>{const r=await msg('getCount');if(r){cacheCount.textContent=`(${r.count.toLocaleString()})`;cCache.textContent=r.count>999?(r.count/1000).toFixed(1)+'k':r.count;}};

  function applyStatus(s){
    setStatus(s);
    const found=s.match(/Found:\s*(\d+)/i); if(found)foundBig.textContent=(+found[1]).toLocaleString();
    const blk=s.match(/Blocked:\s*(\d+)/i); if(blk)cBlocked.textContent=blk[1];
    const batch=s.match(/(?:Batch|Photos)\s*(\d+)\/(\d+)/i);
    if(batch){cBatch.textContent=batch[1]+'/'+batch[2];pLbl.textContent='Batch '+batch[1]+'/'+batch[2];
      const pct=Math.round(batch[1]/batch[2]*100);pPct.textContent=pct+'%';pBar.style.width=pct+'%';}
    const a=s.match(/Active:\s*(\d+)/i);
    if(a){foundBig.textContent=(+a[1]).toLocaleString();heroSub.textContent='active businesses found';}
    else{const inb=s.match(/\|\s*(\d+)\/(\d+)\s*\|/);if(inb)heroSub.textContent=`processing ${inb[1]}/${inb[2]}`;}
  }

  function showBlocked(found,active,phase,err){
    setRunning(false);
    const st = err && err.status;
    const why = st === 429 ? 'HTTP 429 — rate limit. Thodi der ruko, phir Resume.'
              : st === 403 ? 'HTTP 403 — Yelp ne roka. Yelp tab mein jaa kar page kholo (captcha ho to hal karo), phir Resume.'
              : st === 200 ? 'Yelp ne JSON ki jagah challenge page bheja. Yelp tab mein page kholo, phir Resume.'
              : st >= 500  ? `HTTP ${st} — Yelp ka server dabaav mein. Thodi der baad Resume.`
              : st === 0   ? 'Request Yelp tak pahunchi hi nahi. Net/VPN check karo, phir Resume.'
              : 'Yelp ne roka. Yelp theek karke Resume.';
    blockMsg.innerHTML = `<b>⏸️ RUK GAYA</b> — ${phase===1?`Search: ${found||0} mile`:`Photo: ${active||0} active safe`}<br>${why}<br><b>Resume wahi se chalega — kuch nahi chhootega.</b>`;
    blockedBanner.classList.remove('hide'); blockedBanner.style.display='block'; heroSub.textContent='⏸️ ruka hua — theek karke Resume';
  }
  const hideBlocked=()=>{blockedBanner.style.display='none';blockedBanner.classList.add('hide');};

  chrome.runtime.onMessage.addListener(req=>{
    if(req.action==='logUpdate') appendLog(req.message);
    if(req.action==='statusUpdate') applyStatus(req.message);
  if(req.action==='blocked'){setRunning(false);showBlocked(req.found,req.active,req.phase,req.err);}
    if(req.action==='scrapeDone'){setRunning(false);if(!req.blocked)hideBlocked();refreshCount();heroSub.textContent='✅ done';
      if(permMode&&permMode.style.display!=='none')refreshCollectionsStatus();}
  });

  const running=await msg('isRunning');
  if(running&&running.running){setRunning(true);setStatus('Running in background...');}
  const hasResume=await msg('hasResume');
  const big=$('resumeBig');
  if(big) big.onclick=()=>{ if(resumeBtn) resumeBtn.click(); hideBlocked(); heroSub.textContent='▶ resume…'; };
  if(hasResume&&hasResume.has)showBlocked(hasResume.found||0,hasResume.active||0,hasResume.phase||1,hasResume.err);
  await refreshCount();
  const runAllBottom=$('runAllBottom');
  if(runAllBottom) runAllBottom.addEventListener('click',async()=>{
    hideBlocked();setRunning(true);clearLog();setStatus('Starting all saved URLs...');foundBig.textContent='0';
    const r=await msg('runAll');
    if(!r||!r.ok){setRunning(false);setStatus((r&&r.error)||'Could not start');return;}
    appendLog(`▶️ Run All — ${r.count||0} URLs`);
  });


  urlInput.addEventListener('input',()=>{urlCount.textContent=`${parseUrls(urlInput.value).length} URLs`;});
  // URLs auto-save/restore band — har baar manually daalni hain

  scrapeBtn.addEventListener('click',async()=>{const urls=parseUrls(urlInput.value);
    if(!urls.length){alert('No valid URLs found');return;}
    hideBlocked();setRunning(true);clearLog();setStatus('Starting...');foundBig.textContent='0';
    await msg('startScrape',{urls});});

  resumeBtn.addEventListener('click',async()=>{hideBlocked();setRunning(true);appendLog('▶️ Resuming...');setStatus('Resuming...');await msg('resumeScrape');});

  // ─── MODE SWITCHING (Temporary / Permanent) ───────────────────────────────
  const tabTemp=$('tabTemp'), tabPerm=$('tabPerm'), tempMode=$('tempMode'), permMode=$('permMode');

  function showMode(which){
    if(which==='perm'){tabPerm.classList.add('active');tabTemp.classList.remove('active');
      permMode.style.display='block';tempMode.style.display='none';renderCollections(true);}
    else{tabTemp.classList.add('active');tabPerm.classList.remove('active');
      tempMode.style.display='block';permMode.style.display='none';}
  }
  tabTemp.addEventListener('click',()=>{showMode('temp');stopCollRefresh();});
  tabPerm.addEventListener('click',()=>{showMode('perm');startCollRefresh();});

  // Permanent tab khula ho to har 3s refresh — "running now" live dikhta rahe
  let collTimer=null;
  function startCollRefresh(){
    stopCollRefresh();
    collTimer=setInterval(()=>{ if(permMode.style.display!=='none') refreshCollectionsStatus(); },3000);
  }
  function stopCollRefresh(){ if(collTimer){clearInterval(collTimer);collTimer=null;} }

  // ─── COLLECTIONS (permanent, multi-named) ─────────────────────────────────
  const collectionsWrap=$('collectionsWrap'), addCollBtn=$('addCollBtn'),
        newCollForm=$('newCollForm'), collName=$('collName'),
        permInput=$('permInput'), permCount=$('permCount'),
        saveCollBtn=$('saveCollBtn'), cancelCollBtn=$('cancelCollBtn'),
        clearPermBtn=$('clearPermBtn');

  permInput.addEventListener('input',()=>{permCount.textContent=`${parseUrls(permInput.value).length} URLs`;});

  addCollBtn.addEventListener('click',()=>{
    newCollForm.style.display='block'; addCollBtn.style.display='none'; collName.focus();
  });
  cancelCollBtn.addEventListener('click',()=>{
    newCollForm.style.display='none'; addCollBtn.style.display='block';
    collName.value=''; permInput.value=''; permCount.textContent='0 URLs';
  });

  saveCollBtn.addEventListener('click',async()=>{
    const name=collName.value.trim();
    const urls=parseUrls(permInput.value);
    if(!name){alert('Collection ka naam do');return;}
    if(!urls.length){alert('Koi valid URL nahi mila');return;}
    const r=await msg('addCollection',{name,urls});
    appendLog(`💾 "${name}" saved — ${urls.length} URLs → ${r?r.groups:'?'} groups`);
    collName.value='';permInput.value='';permCount.textContent='0 URLs';
    newCollForm.style.display='none'; addCollBtn.style.display='block';
    await renderCollections(true);
  });

  clearPermBtn.addEventListener('click',async()=>{
    if(!confirm('Saare collections delete karein?'))return;
    await msg('clearPermanent');await renderCollections(true);appendLog('🗑 All collections cleared');
  });

  // kaunse collections abhi UI mein "khule" (expanded) hain — refresh par yaad rakho
  const openState={};

  // FULL render — sirf jab structure badle (add/delete/save/first-load)
  async function renderCollections(force){
    const p=await msg('getPermanent');
    const colls=(p&&p.collections)||[];
    clearPermBtn.style.display=colls.length?'block':'none';
    if(!colls.length){collectionsWrap.innerHTML='';return;}

    const running=p&&p.running;
    let html='';
    colls.forEach(c=>{
      const doneCount=c.done.filter(Boolean).length;
      const allDone=doneCount>=c.groups;
      let groupsHtml='';
      for(let i=0;i<c.groups;i++){
        groupsHtml+=groupBtnHtml(c,i,running);
      }
      const isOpen=openState[c.id];
      html+=`<div class="coll${isOpen?' open':''}" data-cid="${c.id}">
        <div class="collHead">
          <span><span class="collArrow">${isOpen?'▾':'▸'}</span><span class="collName">${escapeHtml(c.name)}</span></span>
          <span>
            <span class="collMeta">${doneCount}/${c.groups} · ${c.total} URLs</span>
            <span class="collDel" data-del="${c.id}" title="Delete">✕</span>
          </span>
        </div>
        <div class="collBody">
          <button class="nextBtn" data-cid="${c.id}">${allDone?'↻ Run All Again':'▶ Next Group'}</button>
          ${groupsHtml}
        </div>
      </div>`;
    });
    collectionsWrap.innerHTML=html;
    wireCollectionEvents();
  }

  // ek group button ka HTML (reuse full + partial dono mein)
  function groupBtnHtml(c,i,running){
    const d=c.done[i];
    const isRunning=running&&running.collectionId===c.id&&running.index===i;
    const ts=c.lastRun&&c.lastRun[i];
    let right;
    if(isRunning) right='⏳ running now';
    else if(ts) right=`✓ ${timeAgo(ts)}`;
    else right=`${c.sizes[i]} URLs`;
    return `<button class="groupBtn${d?' done':''}${isRunning?' running':''}" data-cid="${c.id}" data-idx="${i}">
      <span class="gnum">Group ${i+1}</span>
      <span class="gsize">${right}</span></button>`;
  }

  // PARTIAL refresh — sirf status text/classes update, DOM rebuild NAHI.
  // Isse click kabhi nahi tootega aur expand-state safe rahega.
  async function refreshCollectionsStatus(){
    if(permMode.style.display==='none')return;
    const p=await msg('getPermanent');
    const colls=(p&&p.collections)||[];
    const running=p&&p.running;
    colls.forEach(c=>{
      // meta update
      const collEl=collectionsWrap.querySelector(`.coll[data-cid="${c.id}"]`);
      if(!collEl)return;
      const doneCount=c.done.filter(Boolean).length;
      const meta=collEl.querySelector('.collMeta');
      if(meta)meta.textContent=`${doneCount}/${c.groups} · ${c.total} URLs`;
      // har group button ka status/class update (rebuild nahi)
      for(let i=0;i<c.groups;i++){
        const btn=collEl.querySelector(`.groupBtn[data-idx="${i}"]`);
        if(!btn)continue;
        const d=c.done[i];
        const isRunning=running&&running.collectionId===c.id&&running.index===i;
        const ts=c.lastRun&&c.lastRun[i];
        btn.classList.toggle('done',!!d);
        btn.classList.toggle('running',!!isRunning);
        const gsize=btn.querySelector('.gsize');
        if(gsize){
          if(isRunning)gsize.textContent='⏳ running now';
          else if(ts)gsize.textContent=`✓ ${timeAgo(ts)}`;
          else gsize.textContent=`${c.sizes[i]} URLs`;
        }
      }
      // next button label
      const nb=collEl.querySelector('.nextBtn');
      if(nb)nb.textContent=(doneCount>=c.groups)?'↻ Run All Again':'▶ Next Group';
    });
  }

  function wireCollectionEvents(){
    // expand/collapse
    collectionsWrap.querySelectorAll('.collHead').forEach(h=>{
      h.addEventListener('click',e=>{
        if(e.target.classList.contains('collDel'))return;
        const coll=h.parentElement;
        const cid=coll.dataset.cid;
        coll.classList.toggle('open');
        openState[cid]=coll.classList.contains('open');
        const arrow=h.querySelector('.collArrow');
        if(arrow)arrow.textContent=coll.classList.contains('open')?'▾':'▸';
      });
    });

    // delete collection
    collectionsWrap.querySelectorAll('.collDel').forEach(d=>{
      d.addEventListener('click',async e=>{
        e.stopPropagation();
        if(!confirm('Yeh collection delete karein?'))return;
        delete openState[d.dataset.del];
        await msg('deleteCollection',{id:d.dataset.del});
        await renderCollections(true);
      });
    });

    // NEXT button — pehla jo group done nahi hua, wahi chala do
    collectionsWrap.querySelectorAll('.nextBtn').forEach(nb=>{
      nb.addEventListener('click',async e=>{
        e.stopPropagation();
        const cid=nb.dataset.cid;
        const p=await msg('getPermanent');
        const c=(p.collections||[]).find(x=>x.id===cid);
        if(!c)return;
        let idx=c.done.findIndex(x=>!x);      // pehla undone group
        if(idx===-1)idx=0;                     // sab done → dobara pehle se
        runGroup(cid,idx);
      });
    });

    // individual group click (manual)
    collectionsWrap.querySelectorAll('.groupBtn').forEach(btn=>{
      btn.addEventListener('click',()=>runGroup(btn.dataset.cid,+btn.dataset.idx));
    });
  }

  // ek group chalao (Next aur manual dono isko call karte hain)
  async function runGroup(cid,idx){
    hideBlocked();setRunning(true);clearLog();setStatus('Group '+(idx+1)+'...');foundBig.textContent='0';
    appendLog(`▶️ Group ${idx+1} processing...`);
    await msg('runPermanentGroup',{collectionId:cid,index:idx});
    refreshCollectionsStatus();
  }

  // "5m ago", "2h ago", "3d ago" — pata rahe kab chalaya tha
  function timeAgo(ts){
    const s=Math.floor((Date.now()-ts)/1000);
    if(s<60)return 'just now';
    const m=Math.floor(s/60); if(m<60)return m+'m ago';
    const h=Math.floor(m/60); if(h<24)return h+'h ago';
    const d=Math.floor(h/24); return d+'d ago';
  }

  function escapeHtml(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

  fileInput.addEventListener('change',()=>{const f=fileInput.files&&fileInput.files[0];
    if(!f){fileUrls=[];fileName.textContent='';addBulkBtn.disabled=true;return;}
    const rd=new FileReader();rd.onload=()=>{fileUrls=parseAnyUrls(String(rd.result));
      fileName.textContent=`${f.name} — ${fileUrls.length} URLs`;addBulkBtn.disabled=!fileUrls.length;};
    rd.onerror=()=>{fileName.textContent='Could not read file';fileUrls=[];addBulkBtn.disabled=true;};rd.readAsText(f);});

  addBulkBtn.addEventListener('click',async()=>{if(!fileUrls.length){alert('Choose a .txt file first');return;}
    addBulkBtn.disabled=true;addBulkBtn.textContent='Adding...';
    const r=await msg('addUrls',{urls:fileUrls});cacheCount.textContent=`(${r.total.toLocaleString()})`;
    appendLog(`✅ Cached: ${r.added} | Total: ${r.total}`);setStatus(`Cache: ${r.total}`);
    fileUrls=[];fileInput.value='';fileName.textContent='';addBulkBtn.textContent='+ Add to Cache';addBulkBtn.disabled=true;refreshCount();});

  exportBtn.addEventListener('click',async()=>{const r=await msg('exportCache');
    if(!r||!r.urls.length){alert('Cache is empty');return;}
    const b=new Blob([r.urls.join('\n')],{type:'text/plain'});const a=document.createElement('a');
    a.href=URL.createObjectURL(b);a.download=`cache_export_${Date.now()}.txt`;a.click();appendLog(`📤 Exported: ${r.urls.length}`);});

  // Copy URLs — clipboard mein plain URLs
  const copyBtn=document.getElementById('copyBtn');
  if(copyBtn) copyBtn.addEventListener('click',async()=>{
    const r=await msg('getLastResult');
    if(!r||!r.text){alert('Abhi koi result nahi');return;}
    try{
      await navigator.clipboard.writeText(r.text);
      const o=copyBtn.textContent;copyBtn.textContent=`✅ Copied ${r.count}!`;
      setTimeout(()=>copyBtn.textContent=o,1500);
    }catch(e){alert('Copy fail');}
  });

  // Download URLs — sirf plain URLs .txt mein
  const downloadBtn=document.getElementById('downloadBtn');
  if(downloadBtn){
    // button label par count dikhao agar result mojood hai
    (async()=>{const r=await msg('getLastResult');
      if(r&&r.count)downloadBtn.textContent=`⬇ Download URLs (${r.count})`;})();
    downloadBtn.addEventListener('click',async()=>{
      const r=await msg('downloadResult');
      if(!r||!r.ok){alert('Abhi koi result nahi');return;}
      const o=downloadBtn.textContent;downloadBtn.textContent='✅ Downloaded!';
      setTimeout(()=>downloadBtn.textContent=o,1500);
    });
  }

  clearDbBtn.addEventListener('click',async()=>{if(!confirm('Clear all cached data?'))return;
    try{await msg('clearCache');clearLog();hideBlocked();setStatus('Cleared');cacheCount.textContent='(0)';
      cCache.textContent='0';foundBig.textContent='0';cBlocked.textContent='0';cBatch.textContent='–';
      pBar.style.width='0%';pPct.textContent='0%';setTimeout(refreshCount,300);}catch(e){setStatus('Failed');}});
});



// ─── R = extension reload (popup khula rahega) ─────────────────────────────
(function(){
  const rb = document.getElementById('reloadBtn');
  if (rb) rb.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'reloadExt' }, () => {});
    const s = document.getElementById('status');
    if (s) s.textContent = 'reloading...';
  });
  const wb = document.getElementById('wipeBtn');
  if (wb) wb.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'wipeData' }, () => {
      const s = document.getElementById('status');
      if (s) s.textContent = 'cookies + cache cleared';
    });
  });
  // tab-mode: ?tab=1 par bara layout
  if (new URLSearchParams(location.search).get('tab') === '1') {
    document.body.classList.add('tab-mode');
  }
})();

// ── PX proxy settings ──
(function(){
  const g = id => document.getElementById(id);
  if (!g('pxHost')) return;
  const px = m => new Promise(r => chrome.runtime.sendMessage(m, x => r(chrome.runtime.lastError ? null : x)));
  const F = { pxHost:'host', pxMin:'portMin', pxMax:'portMax', pxUser:'user', pxPass:'pass', pxDom:'domains' };

  async function load() {
    const r = await px({ px:'get' }); if (!r) return;
    for (const [el,k] of Object.entries(F)) if (g(el)) g(el).value = r.cfg[k] ?? '';
    g('pxOn').checked = !!r.cfg.enabled;
    g('pxPort').textContent = '· port ' + r.port;
    g('pxSw').textContent = r.switches ? '· ' + r.switches + ' switches' : '';
  }
  async function showIp() {
    g('pxIp').textContent = '…';
    const r = await px({ px:'ip' });
    g('pxIp').textContent = (r && r.ip) || 'nahi mila';
    if (r) g('pxPort').textContent = '· port ' + r.port;
  }
  function grab() {
    const c = {};
    for (const [el,k] of Object.entries(F)) c[k] = g(el).value.trim();
    c.portMin = parseInt(c.portMin,10)||0; c.portMax = parseInt(c.portMax,10)||0;
    c.enabled = g('pxOn').checked; c.scope = 'list'; c.idx = 0;
    return c;
  }
  g('pxSave').onclick = async () => { const r = await px({px:'save', cfg:grab()}); g('pxMsg').textContent = (r&&r.ok)?'Save ho gaya':((r&&r.msg)||'fail'); load(); showIp(); };
  g('pxNext').onclick = async () => { g('pxMsg').textContent='Naya IP…'; const r = await px({px:'next'}); g('pxIp').textContent=(r&&r.ip)||'—'; g('pxMsg').textContent='Port '+(r&&r.port); load(); };
  g('pxExp').onclick = async () => {
    const r = await px({px:'get'}); if(!r) return;
    const b = new Blob([JSON.stringify({_proxy:1, ...r.cfg}, null, 2)], {type:'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'proxy-settings.json'; a.click();
    g('pxMsg').textContent = 'File download ho gayi — doosri extension mein Import karo';
  };
  g('pxImp').onclick = () => g('pxFile').click();
  g('pxFile').onchange = async e => {
    const f = e.target.files && e.target.files[0]; if(!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d._proxy) { g('pxMsg').textContent='Ye proxy settings file nahi'; return; }
      delete d._proxy; d.idx = 0;
      await px({px:'save', cfg:d}); await load(); showIp();
      g('pxMsg').textContent = 'Import ho gaya';
    } catch(err){ g('pxMsg').textContent = 'File padhi nahi gayi'; }
    e.target.value = '';
  };
  load().then(showIp);
})();

  // ─── CONCURRENCY ──────────────────────────────────────────────────────────
  // Ek saath kitni requests. Zyada = tez, par 403 ka khatra bhi zyada.
  const concSel = document.getElementById('concSel');
  if (concSel) {
    chrome.runtime.sendMessage({ action: 'getConc' }, r => {
      if (r && r.conc) concSel.value = String(r.conc);
    });
    concSel.onchange = () => {
      concSel.disabled = true;
      chrome.runtime.sendMessage({ action: 'setConc', conc: concSel.value }, r => {
        concSel.disabled = false;
        if (r && r.ok) concSel.title = 'Ek saath ' + r.conc + ' requests (save ho gaya)';
      });
    };
  }
