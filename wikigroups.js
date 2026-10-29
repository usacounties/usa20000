// Groups chhupe hain: citations [1][2]... aur table rows mein
(function(){
  function msg(a,d){return new Promise(r=>{try{chrome.runtime.sendMessage(Object.assign({action:a},d||{}),res=>{if(chrome.runtime.lastError)return r(null);r(res);});}catch(e){r(null);}});}

  // sare hidden group elements: sup.ref a[data-c], tr.grow[data-c], .wrefs li[data-c]
  function allGroupEls(){
    return [...document.querySelectorAll('tr.grp[data-c]')];
  }

  async function sync(){
    const p = await msg('getPermanent');
    if(!p || !p.collections) return;

    const doneMap = {};
    p.collections.forEach(c=>{
      (c.done||[]).forEach((d,i)=>{ if(d) doneMap[c.id+'|'+i] = true; });
    });
    const runKey = (p.running && p.isScraping) ? (p.running.collectionId+'|'+p.running.index) : null;

    allGroupEls().forEach(el=>{
      const key = el.dataset.c + '|' + el.dataset.i;
      el.classList.remove('gd','gr');
      if(key === runKey) el.classList.add('gr');
      else if(doneMap[key]) el.classList.add('gd');
    });
  }

  // click → group chalu / copy
  document.addEventListener('click', async e=>{
    const el = e.target.closest('tr.grp[data-c]');
    if(!el) return;
    e.preventDefault();
    e.stopPropagation();

    const cid = el.dataset.c, idx = parseInt(el.dataset.i);

    if(el.classList.contains('gr')) return;

    // done ho ya na ho — hamesha dobara chal sakta hai
    await msg('runPermanentGroup',{collectionId:cid,index:idx});
    el.classList.add('gr');
    setTimeout(sync,900);
  }, true);

  sync();
  setInterval(sync,2500);
})();
