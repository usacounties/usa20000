// Business Finder - Background Service Worker
try { importScripts('config.js'); } catch (e) { /* config.js optional */ }


// ─── KEYBOARD SHORTCUT: USA1000Cities11 page ────────────────────────────────
try {
  chrome.commands.onCommand.addListener(cmd => {
    if (cmd === 'open_tab') {
      chrome.tabs.create({ url: chrome.runtime.getURL('List_of_United_States_cities_by_population.html') });
    }
  });
} catch(e) {}

// ─── PROXY (Proxiware) + RUN SETTINGS ───────────────────────────────────────────
// Settings proxy.html page se aati hain (chrome.storage.local: bf_proxy, bf_cfg).
// Sirf Yelp domains proxy se jaate hain (PAC script) — baaki browsing DIRECT rehti hai,
// taake tumhari GB sirf scraping par kharch ho.
// PAC har request par random port chunta hai. Proxiware ke sticky port range mein har port
// = alag IP, isliye har request alag IP se nikalti hai (connection reuse ke bawajood).

// ═══════════════════════════════════════════════════════════════════════════
// PX — PROXY + AUTO IP SWITCH
// Port scan se sabit hua: har sticky port ek ALAG exit IP deta hai.
// Is liye "naya IP" = agla port. Chrome connection reuse karta hai, to port
// badalne se pehle proxy DIRECT kar ke wapas lagate hain — warna purana
// connection chalta rehta hai aur IP wahi rehta hai.
// ═══════════════════════════════════════════════════════════════════════════
const PX_KEY = 'px_cfg_v2';   // naya key = purani adhoori domains list reset

const PX_DEF = {
  // DEFAULT OFF. Pehle true tha — pehle error par hi proxy khud ON ho jata tha,
  // VPN ke upar chadh jata tha aur sab network errors mein badal deta tha.
  // Ab proxy sirf tab chalega jab tum khud Settings se ON karo.
  enabled: false,
  host:    'proxy.proxiware.com',
  portMin: 10001,
  portMax: 10499,
  user:    'user-QrPtzBEp72Np-network-eco',
  pass:    'q16PnTizHtKL',
  scope:   'list',                                  // 'all' | 'list'
  domains: 'yelp.com\nyelp.co.uk\nyelp.com.au\nyelp.ca\nyelp.ie\nyelp.co.nz\nyelp.com.sg\nyelp.de\nyelp.fr\nyelp.it\nyelp.es\nyelp.nl\nyelp.ch\nyelp.at\nyelp.be\nyelp.se\nyelp.no\nyelp.dk\nyelp.pl\nyelp.pt\nyelp.co.jp',
  idx:     0
};

const PX = {
  cfg: { ...PX_DEF },
  switches: 0,
  lastIp: '',
  busy: null,

  async load() {
    try {
      const r = await chrome.storage.local.get(PX_KEY);
      this.cfg = Object.assign({}, PX_DEF, r[PX_KEY] || {});
    } catch (e) { this.cfg = { ...PX_DEF }; }
    return this.cfg;
  },

  async save(patch) {
    this.cfg = Object.assign({}, this.cfg, patch || {});
    try { await chrome.storage.local.set({ [PX_KEY]: this.cfg }); } catch (e) {}
    return this.cfg;
  },

  port() {
    const mn = +this.cfg.portMin || 0, mx = +this.cfg.portMax || 0;
    // pehla port random — har run 10001 se shuru na ho (wo node mara hua ho sakta hai)
    if (mn > 0 && mx >= mn && !this._seeded) { this._seeded = true; this.cfg.idx = Math.floor(Math.random() * (mx - mn + 1)); }
    if (mn > 0 && mx >= mn) return mn + ((+this.cfg.idx || 0) % (mx - mn + 1));
    return +this.cfg.portMin || 0;
  },

  pac() {
    const h = String(this.cfg.host || '').trim(), p = this.port();
    if (!h || !p) return null;
    const local = `if (isPlainHostName(host) || isInNet(dnsResolve(host), "127.0.0.0", "255.0.0.0") ||
      isInNet(dnsResolve(host), "192.168.0.0", "255.255.0.0")) return "DIRECT";`;
    if (this.cfg.scope === 'list') {
      const ds = String(this.cfg.domains || '').split('\n').map(s => s.trim()).filter(Boolean);
      // SAARE Yelp domains hamesha list mein — warna jo domain Settings se
      // chuna gaya ho aur yahan na ho, uski requests proxy se jati hi nahi
      // aur "network" error aata hai. (Ye bug tha: .ie chuna, PAC mein nahi tha.)
      try {
        for (const h of Object.values(DOMAIN_HOST)) {
          const base = String(h).replace(/^www\./, '');
          if (base && !ds.includes(base)) ds.push(base);
        }
      } catch (e) {}
      // IP-check wale hosts HAMESHA proxy se — warna check ghar ka IP dikhata hai
      ds.push('api.ipify.org', 'ipv4.icanhazip.com');
      if (!ds.length) return null;
      const chk = ds.map(d => `shExpMatch(host, "${d}") || shExpMatch(host, "*.${d}")`).join(' || ');
      return `function FindProxyForURL(url, host) { ${local} if (${chk}) return "PROXY ${h}:${p}"; return "DIRECT"; }`;
    }
    return `function FindProxyForURL(url, host) { ${local} return "PROXY ${h}:${p}"; }`;
  },

  async apply() {
    if (!this.cfg.enabled) {
      try { await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }); } catch (e) {}
      return { ok: true, off: true };
    }
    const pac = this.pac();
    if (!pac) return { ok: false, msg: 'proxy host/port set nahi' };
    try {
      await chrome.proxy.settings.set({ value: { mode: 'pac_script', pacScript: { data: pac, mandatory: true } }, scope: 'regular' });
      return { ok: true, port: this.port() };
    } catch (e) { return { ok: false, msg: String(e && e.message) }; }
  },

  async off() {
    try { await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }); } catch (e) {}
  },

  reqSince: 0,          // aakhri switch ke baad kitni requests

  // har N requests par KHUD naya IP — error ka intezar nahi.
  // Yahi rotating residential proxy ka asal maqsad hai: koi IP itni
  // requests kare hi na ke Yelp usko flag kare.
  async tick(every) {
    if (!this.cfg.enabled) return;
    this.reqSince++;
    const N = Math.max(1, parseInt(every, 10) || 0);
    if (N && this.reqSince >= N) { this.reqSince = 0; await this.next('har ' + N + ' requests'); }
  },

  switching: false,     // IP badal raha hai — sab requests ruk jayein
  lastSwitchAt: 0,      // aakhri switch kab hua
  MIN_GAP_MS: 6000,     // do switch ke beech kam se kam itna waqt
  badStreak: 0,         // lagataar kitne switch ke baad bhi fail
  deadUntil: 0,         // proxy mara hua samjho is waqt tak
  coolAll: 0,           // switch ke baad sab workers itni der ruken

  // koi bhi request bhejne se pehle: switch chal raha ho to intezar
  async gate() {
    let guard = 0;
    while (this.switching && guard++ < 300) await new Promise(r => setTimeout(r, 100));
    // switch ke foran baad sab thoda ruk jayein — warna adhoori requests
    // fail hoti hain aur unse aur switch maange jate hain (chakkar).
    const left = this.coolAll - Date.now();
    if (left > 0) await new Promise(r => setTimeout(r, Math.min(left, 15000)));
  },

  // agla port = naya IP. Ek waqt mein ek hi switch chale.
  async next(why) {
    if (this.busy) return this.busy;

    // ─── RATE LIMIT ───────────────────────────────────────────────────────
    // 25 workers ek saath fail hon to 25 switch maangenge. Ek hi chalega,
    // baaki sirf cooldown ka intezar karenge — ports is tarah nahi jalenge.
    const since = Date.now() - this.lastSwitchAt;
    if (since < this.MIN_GAP_MS) {
      await new Promise(r => setTimeout(r, this.MIN_GAP_MS - since));
      return { ok: true, skipped: true };
    }
    this.busy = (async () => {
      this.switching = true;                    // sab workers ruk jayein
      await new Promise(r => setTimeout(r, 300));   // hawa mein wali requests khatam hon
      await this.off();                          // connection pool todo
      await new Promise(r => setTimeout(r, 300));

      await this.save({ idx: (+this.cfg.idx || 0) + 1 });
      const r = await this.apply();
      await new Promise(res => setTimeout(res, 250));
      this.switches++; this.reqSince = 0;
      this.lastSwitchAt = Date.now();
      this.coolAll = Date.now() + 800;          // kam cooldown — port pehle se zinda
      this.switching = false;                   // ab workers chal sakte hain
      try {
        if (ok) log(`🔀 Naya IP — port ${this.port()} ✓zinda (${tested} test) [${this.switches}]`);
        else    log(`⚠️ ${tested} ports test kiye, koi zinda nahi mila — GB balance ya network dekho`);
      } catch (e) {}
      return r;
    })();
    try { return await this.busy; } finally { this.busy = null; this.switching = false; }
  },

  // ─── HEALTH CHECK ──────────────────────────────────────────────────────
  // Lagataar fail ho rahe hain. Sawal: nodes mar rahe hain, ya POORA proxy
  // baith gaya (Proxiware ne throttle kiya / GB khatam)? Ek seedha test:
  // agar exit IP bhi nahi milta to poora proxy down hai — aur tab aur ports
  // jalane ka koi faida nahi.
  async healthCheck() {
    if (Date.now() < this.deadUntil) return false;
    const r = await this.ip();
    if (r.ip) { this.badStreak = 0; return true; }
    this.deadUntil = Date.now() + 90000;
    try {
      log(`⛔ PROXY BAITH GAYA — ${this.switches} switches ke baad exit IP bhi nahi mil raha.`);
      log(`   ${r.err || ''}`);
      log(`   90 second ruk raha hoon. Proxiware ne shayad tez switching par throttle laga diya,`);
      log(`   ya GB khatam ho gaye. Dashboard dekh lena.`);
    } catch (e) {}
    await new Promise(res => setTimeout(res, 90000));
    const r2 = await this.ip();
    if (r2.ip) { this.badStreak = 0; this.deadUntil = 0; try { log(`✅ Proxy wapas chal raha hai — ${r2.ip}`); } catch (e) {} return true; }
    return false;
  },

  async ip() {
    const errs = [];
    for (const u of ['https://api.ipify.org?format=json', 'https://ipv4.icanhazip.com']) {
      try {
        const r = await fetch(u, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20000) });
        if (!r.ok) { errs.push(u.split('/')[2] + ': HTTP ' + r.status); continue; }
        const t = (await r.text()).trim();
        let ip = t; try { ip = JSON.parse(t).ip; } catch (e) {}
        if (ip) { this.lastIp = ip; return { ip, err: '' }; }
        errs.push(u.split('/')[2] + ': khali jawab');
      } catch (e) {
        errs.push(u.split('/')[2] + ': ' + ((e && e.name === 'TimeoutError') ? 'timeout (20s)' : String((e && e.message) || e).slice(0, 50)));
      }
    }
    return { ip: '', err: errs.join(' | ') };
  }
};

// proxy auth
try {
  chrome.webRequest.onAuthRequired.addListener(
    (d, cb) => {
      if (!d.isProxy) { cb({}); return; }
      cb({ authCredentials: { username: String(PX.cfg.user || ''), password: String(PX.cfg.pass || '') } });
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking']
  );
} catch (e) {}

PX.load().then(() => PX.apply());

const PROXY_KEY = 'bf_proxy';
const CFG_KEY   = 'bf_cfg';
const CFG_DEFAULT = { _v: 17, runLimit: 0, skipPhotos: true, retries: 2, humanMode: false, delayMin: 0, delayMax: 0, humanConc: 25, adaptive: false, rotateEvery: 0, smartRead: true, lite: true, useCache: true, maxKB: 0, auditEvery: 1000, photoConc: 3, directMode: true, sendCookie: false, proxyRescue: false, cookieRescue: true, blockLimit: 1, simpleMode: true, simpleConc: 15, simpleGapMs: 350, cookieFirst: true, simpleConcMax: 25, simpleGapMin: 350, simpleRampAfter: 999999 , cookieFixPerUrl: 2 , cookieEveryN: 0 , pauseOnAnyError: true , ipTriesPerUrl: 15 , rotateEveryN: 45 , simpleConcMin: 4 };
let PROXY = { enabled: false }; // legacy object only; extension no longer controls Chrome proxy
let CFG   = Object.assign({}, CFG_DEFAULT);

// ─── DEFAULTS FROM config.js (stored settings sirf tab override karti hain jab bhari hon) ───
function withDefaults(p) {
  const d = (typeof BF_DEFAULTS !== 'undefined' && BF_DEFAULTS.proxy) || {};
  const o = Object.assign({}, d);
  let src = p || {};
  if (src._pv !== 6) src = { enabled: src.enabled, sid: src.sid };   // old saved values (ports/user from earlier setups) are ignored
  for (const k in src) {
    const v = src[k];
    if (v !== '' && v !== 0 && v !== null && v !== undefined) o[k] = v;
  }
  if (typeof src.enabled === 'boolean') o.enabled = src.enabled;
  if (o.pass === 'PUT_YOUR_PASSWORD_HERE') o.pass = '';
  return o;
}

// ─── EVENT LOG (logs.html mein dikhta hai) ───────────────────────────────────
// Har important cheez: kya hua, kyun hua, kya karna hai. Last 300 entries.
const EVT_KEY = 'bf_events';
let evtChain = Promise.resolve();
let lastEvtSig = '', lastEvtAt = 0;
function evt(level, code, msg, detail) {
  const sig = code + '|' + msg;
  const now = Date.now();
  if (sig === lastEvtSig && now - lastEvtAt < 3000) return;   // same error ki bheed nahi
  lastEvtSig = sig; lastEvtAt = now;
  const e = { t: now, level, code, msg, detail: detail || {} };
  evtChain = evtChain.then(async () => {
    const r = await chrome.storage.local.get(EVT_KEY);
    const a = r[EVT_KEY] || [];
    a.push(e);
    if (a.length > 300) a.splice(0, a.length - 300);
    await chrome.storage.local.set({ [EVT_KEY]: a });
  }).catch(() => {});
}

// error ko seedhe lafzon mein samjhao
function explainErr(e) {
  e = e || {};
  const b = String(e.body || '');
  const st = e.status;
  const dd = /captcha-delivery|datadome/i.test(b);
  const hard = /you have been blocked/i.test(b);
  const proxyOn = false; // VPN/system route; extension does not own a proxy
  if (e.msg === 'no-yelp-tab')
    return { code: 'NO_TAB', why: 'No Yelp tab is open, so the extension has nowhere to send requests from.', fix: 'Press Resume (it opens a Yelp tab) or click "Open Yelp tab" in settings.' };
  if (e.msg === 'no-result' || e.msg === 'tab-error')
    return { code: 'TAB_FAIL', why: 'The extension could not run the request inside the Yelp tab. The tab may be closed, still loading, or showing a block page.', fix: 'Make sure one Yelp tab is open and shows a normal page, then press Resume.' };
  if (hard)
    return { code: 'HARD_BLOCK', why: 'Yelp/DataDome showed "You have been blocked". This IP or session has been flagged. It is a harder block than a normal captcha.', fix: 'Switch to a new IP (New IP button), reload the Yelp tab, solve any captcha, wait 10 to 15 minutes if it repeats, and use slower delays.' };
  if (dd || (st === 403))
    return { code: 'CAPTCHA', why: 'DataDome challenged the request (HTTP 403). It wants a captcha or a real browser check before it gives data.', fix: 'Go to the Yelp tab, solve the captcha yourself until a normal Yelp page loads, then press Resume.' };
  if (st === 429)
    return { code: 'RATE_LIMIT', why: 'Too many requests too fast (HTTP 429). Yelp asked us to slow down.', fix: 'Raise the delay between requests (for example 5 to 12 seconds) and wait a few minutes.' };
  if (st === 407)
    return { code: 'PROXY_AUTH', why: 'The proxy rejected the connection (HTTP 407). With Proxiware IP Auth this means your current IP is not whitelisted.', fix: 'Open Proxiware > Proxies > IP Auth and click + My IP (your IP may have changed). Then reload the extension.' };
  if (st === 0)
    return { code: 'NETWORK', why: proxyOn ? 'The request never reached Yelp. Usually your IP is not whitelisted in Proxiware, a port you did not generate, or the proxy being out of data.' : 'The request failed before reaching Yelp (network problem).', fix: proxyOn ? 'Click Test IPs in settings. If it fails there too, check that your IP is whitelisted in Proxiware, that the port is inside the range you generated, and your GB balance.' : 'Check your internet connection.' };
  if (st === 200 && (e.kind === 'notjson' || e.kind === 'nodata'))
    return { code: 'BAD_DATA', why: 'Yelp answered, but with a page instead of search data. This is usually a captcha or block page.', fix: 'Open the Yelp tab and check what it shows. Solve the captcha if there is one, then Resume.' };
  if (st >= 500)
    return { code: 'YELP_5XX', why: 'Yelp had a server error (HTTP ' + st + ').', fix: 'Wait a minute and press Resume.' };
  return { code: 'UNKNOWN', why: 'Unexpected answer (HTTP ' + st + ').', fix: 'Copy the log entry and send it to whoever is helping you debug.' };
}

function noteFail(er) {
  const x = explainErr(er);
  let u = '';
  try { u = er && er.url ? new URL(er.url).pathname : ''; } catch (e) { u = String((er && er.url) || '').slice(0, 80); }
  evt('error', x.code, (er && er.status != null ? 'HTTP ' + er.status : 'Error') + (u ? ' on ' + u : ''),
      { why: x.why, fix: x.fix, status: er && er.status, snippet: String((er && er.body) || (er && er.msg) || '').slice(0, 200) });
}

function buildPac(p, human) {
  const host_ = String(p.host || '').replace(/[^a-zA-Z0-9.\-]/g, '');
  const single = parseInt(p.port, 10) || 1337;
  const sess = /\{sid\}/.test(String(p.user || ''));
  const min = sess ? 0 : parseInt(p.stickyMin, 10), max = sess ? 0 : parseInt(p.stickyMax, 10);
  let pick;
  if (min > 0 && max >= min) {
    if (human) {
      // HUMAN MODE: poori session ek hi port = ek hi IP. "New IP" button sessionIdx badhata hai.
      const idx = (parseInt(p.sessionIdx, 10) || 0) % (max - min + 1);
      pick = `var p=${min + idx};`;
    } else {
      pick = `var p=${min}+Math.floor(Math.random()*${max - min + 1});`;
    }
  } else {
    pick = `var p=${single};`;
  }
  // human mode mein captcha/DataDome hosts bhi usi proxy se — warna cookie IP se match nahi karegi
  const re = human ? '(^|\\.)(yelp\\.[a-z.]+|captcha-delivery\\.com|datadome\\.co)$' : '(^|\\.)yelp\\.[a-z.]+$';
  const hostUse = (sess && ((parseInt(p.sessionIdx, 10) || 0) % 2)) ? host_ + '.' : host_;
  return `/*sid ${p.sid || ''}*/function FindProxyForURL(url,host){` +
    `if(/${re}/.test(host)||host==='api.ipify.org'){${pick}return 'PROXY ${hostUse}:'+p;}` +
    `return 'DIRECT';}`;
}

async function applyProxy() {
  try {
    if (PROXY && PROXY.enabled && PROXY.host) {
      // mandatory:true = proxy fail ho to request FAIL hogi, tumhara asli IP Yelp ko nahi jayega
      await chrome.proxy.settings.set({
        value: { mode: 'pac_script', pacScript: { data: buildPac(PROXY, CFG.humanMode), mandatory: true } },
        scope: 'regular'
      });
      console.log('[proxy] ON', PROXY.host);
      evt('info', 'PROXY_ON', 'Proxy ON (Proxiware, user auth): ' + PROXY.host + (CFG.humanMode ? ' (human mode, one steady IP)' : ' (rotating)'));
    } else {
      await chrome.proxy.settings.clear({ scope: 'regular' });
      console.log('[proxy] OFF');
    }
  } catch (e) { console.log('[proxy]', e); }
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS VAULT
// Cache cleaner (CCleaner / Click&Clean) chrome.storage.LOCAL uda deta hai,
// is liye proxy settings gayab ho jati thin. Ab wo chrome.storage.SYNC mein
// bhi mirror hoti hain — wo Chrome profile se judi hai, cleaners usey nahi
// chherte. Local khali mile to sync se khud wapas aa jati hain.
// Sirf settings backup hoti hain — cache, collections, run progress nahi.
// ═══════════════════════════════════════════════════════════════════════════
const VAULT_KEYS = [PROXY_KEY, CFG_KEY, 'bf_wl', 'bf_domain'];

function isEmptyVal(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return true;
  return false;
}

async function vaultBackup(keys) {
  try {
    const want = keys && keys.length ? keys : VAULT_KEYS;
    const loc = await chrome.storage.local.get(want);
    const out = {};
    for (const k of want) if (!isEmptyVal(loc[k])) out['sync_' + k] = loc[k];
    if (Object.keys(out).length) {
      out.sync_savedAt = Date.now();
      await chrome.storage.sync.set(out);
    }
  } catch (e) { console.log('[vault] backup', e && e.message); }
}

async function vaultRestore() {
  try {
    const syncKeys = VAULT_KEYS.map(k => 'sync_' + k).concat('sync_savedAt');
    const [loc, syn] = await Promise.all([
      chrome.storage.local.get(VAULT_KEYS),
      chrome.storage.sync.get(syncKeys)
    ]);
    const put = {};
    for (const k of VAULT_KEYS) {
      if (isEmptyVal(loc[k]) && !isEmptyVal(syn['sync_' + k])) put[k] = syn['sync_' + k];
    }
    if (Object.keys(put).length) {
      await chrome.storage.local.set(put);
      console.log('[vault] restored after cache clear:', Object.keys(put).join(', '));
      return Object.keys(put);
    }
  } catch (e) { console.log('[vault] restore', e && e.message); }
  return [];
}

// Settings badlein to foran sync mein mirror
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  const touched = VAULT_KEYS.filter(k => ch[k]);
  if (touched.length) vaultBackup(touched);
});

const cfgReady = vaultRestore().then(() => chrome.storage.local.get([PROXY_KEY, CFG_KEY])).then(r => {
  PROXY = withDefaults(r[PROXY_KEY]);
  let stored = r[CFG_KEY] || {};
  if ((stored._v || 0) < 18) {   // purani (slow) saved settings hata do — naye defaults lagenge
    ['humanConc', 'photoConc', 'auditEvery', 'rotateEvery', 'maxAutoRot', 'simpleConcMax'].forEach(k => delete stored[k]);   // simpleConc/rotateEveryN ab Settings se — mitao mat
    stored._v = 18;
    chrome.storage.local.set({ [CFG_KEY]: stored }).catch(() => {});
  }
  CFG = Object.assign({}, CFG_DEFAULT, stored);
  // SCHEDULED ROTATION BAND. IP sirf block/error par badlegi, waqt ke hisaab se nahi.
  // Purani saved setting (jaise 200) yahan se rad ho jati hai.
  CFG.rotateEvery = 0;
  // TEST ka natija: ghar ke IP se yelp.co.uk 15/15 chala, 71 ads, koi DataDome nahi.
  // Proxy band — na GB lagti hai, na proxy ke failures.
  // Block aane lage to Settings mein proxy wapas on kar dena.
  PROXY.enabled = false;
  // PROBE ka natija: yelp.co.uk /search/snippet par DataDome hai hi nahi.
  // Na tab chahiye, na cookie — seedhi fetch chalti hai. Is liye humanMode band.
  CFG.humanMode = false;
  CFG.photoConc = 3;
  PROXY.enabled = false;
  CFG.proxyRescue = false; CFG.cookieRescue = true; CFG.cookieFirst = false;
  // simpleConc ab zabardasti 25 NAHI hota — jo Settings se chuna ho wahi chalta hai
  CFG.simpleConc = Math.max(1, Math.min(50, parseInt(CFG.simpleConc, 10) || 15)); CFG.simpleConcMax = CFG.simpleConc;
}).catch(() => {});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch[PROXY_KEY]) { PROXY = { enabled: false }; }
  if (ch[CFG_KEY]) { CFG = Object.assign({}, CFG_DEFAULT, ch[CFG_KEY].newValue || {}); CFG.rotateEvery = 0; CFG.humanMode = false; CFG.photoConc = 3; CFG.proxyRescue = false; CFG.cookieRescue = true; CFG.cookieFirst = false; CFG.simpleConc = Math.max(1, Math.min(50, parseInt(CFG.simpleConc, 10) || 15)); CFG.simpleConcMax = CFG.simpleConc; PROXY.enabled = false; }
});

// Proxy auth removed: extension no longer owns Chrome proxy settings.

// ─── MANUAL COOKIES + CACHE WIPE ONLY ─────────────────────────────────────
async function wipeYelpData(force, keepCache){
  await cfgReady;
  if (CFG.humanMode && !force) return;   // human mode: DataDome cookie rakhni hai
  evt('info', 'WIPE', keepCache ? 'Yelp cookies cleared (cache kept to save data)' : 'Yelp cookies and cache cleared');
  try {
    await chrome.browsingData.remove(
      { origins: ['https://www.yelp.com', 'https://www.yelp.com.au', 'https://www.yelp.co.uk', 'https://www.yelp.ca', 'https://www.yelp.com.sg', 'https://www.yelp.de', 'https://www.yelp.fr', 'https://www.yelp.es', 'https://www.yelp.it', 'https://www.yelp.nl', 'https://www.yelp.ch', 'https://www.yelp.at', 'https://www.yelp.be', 'https://www.yelp.se', 'https://www.yelp.no', 'https://www.yelp.dk', 'https://www.yelp.fi', 'https://www.yelp.pl', 'https://www.yelp.pt', 'https://www.yelp.ie', 'https://www.yelp.co.nz', 'https://www.yelp.co.jp'] },
      { cache: !keepCache, cookies: true, localStorage: true, indexedDB: false, serviceWorkers: !keepCache, cacheStorage: !keepCache }
    );
  } catch(e) {
    try { await chrome.browsingData.remove({ since: 0 }, { cookies: true }); } catch(e2) {}
  }
}
// No automatic Yelp cookie/cache wipe. Existing browser session is preserved across runs.

// ─── PRELOAD CACHE (ek baar) ─────────────────────────────────────────────────
let cachePromise = null;
function ensureCache() { return cachePromise || (cachePromise = preloadCache()); }

// One-time repair for the previous USA1000 build: it auto-imported the bundled
// cache1..cache5 files, unlike v25. Remove only those known bundled keys so
// manually-added cache entries that are not in the bundled files stay intact.
const BUNDLED_CACHE_REPAIR_KEY = 'bf_usa11_removed_bundled_cache_v1';
async function removeBundledCacheOnce(){
  try {
    const flag = await chrome.storage.local.get(BUNDLED_CACHE_REPAIR_KEY);
    if (flag[BUNDLED_CACHE_REPAIR_KEY]) return;
    const keys = new Set();
    for (const file of ['cache1.json','cache2.json','cache3.json','cache4.json','cache5.json']) {
      try {
        const r = await fetch(chrome.runtime.getURL(file));
        const urls = await r.json();
        for (const u of (urls || [])) keys.add(bizKey(u));
      } catch (e) {}
    }
    if (keys.size) await deleteBusinessesBulk([...keys], 50000);
    const total = await getCount();
    await setCachedCount(total);
    await chrome.storage.local.set({ [BUNDLED_CACHE_REPAIR_KEY]: true });
    console.log('[cache] one-time bundled-cache repair:', keys.size, 'known keys removed/checked | remaining:', total);
  } catch (e) { console.log('[cache repair]', e); }
}

async function preloadCache(){
  // v25 behavior: bundled cache files are NOT auto-imported.
  // Manual cache add remains available and uses the same fast bulk path as v25.
  try {
    await removeBundledCacheOnce();
    await chrome.storage.local.set({ cache_preloaded_v2: true });
  } catch (e) {}
}

// USA1000Cities11 built-ins: c1..c4 only. c5 is permanently removed.
const BUNDLED_COLL = ['c1.json','c2.json','c3.json','c4.json'];
async function preloadCollections(force) {
  try {
    const st = await loadPermanent();
    // Permanently remove legacy c5 if an older installed build left it in storage.
    st.collections = (st.collections || []).filter(c => c && c.id !== 'c5');
    const byId = {};
    st.collections.forEach(c => { byId[c.id] = c; });
    let changed = 0;
    for (const f of BUNDLED_COLL) {
      const r = await fetch(chrome.runtime.getURL(f));
      const fresh = await r.json();
      const existing = byId[fresh.id];
      if (!existing) {
        st.collections.push(fresh); changed++;
      } else {
        const oldDone = existing.done || [];
        const oldLast = existing.lastRun || {};
        const firstUrl = existing.groups && existing.groups[0] && existing.groups[0][0] || '';
        const needsRefresh = (existing.groups || []).length !== (fresh.groups || []).length || !String(firstUrl).includes('yelp.co.uk');
        if (needsRefresh) {
          existing.name = fresh.name;
          existing.groups = fresh.groups;
          existing.done = fresh.groups.map((_, i) => !!oldDone[i]);
          existing.lastRun = oldLast;
          if (existing.cursor) delete existing.cursor;
          changed++;
        }
      }
    }
    st.collections.sort((a,b) => (a.id || '').localeCompare(b.id || ''));
    await savePermanentState(st);
    await chrome.storage.local.set({ bf_coll_preload_v1: true });
    return changed;
  } catch (e) { console.log('[preload]', e); return 0; }
}

console.log('Business Finder background loaded');

// ─── DOMAIN SWITCH ───────────────────────────────────────────────────────────
// Popup ke button se chuno: = (jaisa URL mein hai) / com / au / uk / sg
// Har request bhejte waqt URL ka domain badal diya jata hai — groups waise hi rehte hain.
const DOMAIN_HOST = {
  com: 'www.yelp.com',
  au: 'www.yelp.com.au',
  uk: 'www.yelp.co.uk',
  ca: 'www.yelp.ca',
  sg: 'www.yelp.com.sg',
  de: 'www.yelp.de',
  fr: 'www.yelp.fr',
  es: 'www.yelp.es',
  it: 'www.yelp.it',
  nl: 'www.yelp.nl',
  ch: 'www.yelp.ch',
  at: 'www.yelp.at',
  be: 'www.yelp.be',
  se: 'www.yelp.se',
  no: 'www.yelp.no',
  dk: 'www.yelp.dk',
  fi: 'www.yelp.fi',
  pl: 'www.yelp.pl',
  pt: 'www.yelp.pt',
  ie: 'www.yelp.ie',
  nz: 'www.yelp.co.nz',
  jp: 'www.yelp.co.jp'
};
// DOMAIN ab Settings se badla ja sakta hai.
// Pehle teen jagah 'uk' par lock tha — ek listener settings se badla hua
// domain WAPAS 'uk' kar deta tha, is liye chunav kaam hi nahi karta tha.
// Ab .co.uk par 403 aaye to .ie, .nz, .de — koi bhi aazma sakte ho.
let DOMAIN = 'uk';
const domainReady = chrome.storage.local.get('bf_domain')
  .then(r => { DOMAIN = (r && r.bf_domain && DOMAIN_HOST[r.bf_domain]) ? r.bf_domain : 'uk'; })
  .catch(() => { DOMAIN = 'uk'; });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.bf_domain) {
    const v = ch.bf_domain.newValue;
    if (DOMAIN_HOST[v]) DOMAIN = v;          // jo chuna hai wahi chalega
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT DOMAIN — natija hamesha yelp.co.uk par
//
// Requests chahe kisi bhi domain par jayein (.ie, .de, jo bhi Settings mein
// chuna ho), RESULT mein URLs hamesha .co.uk ki shakal mein jati hain.
// Scraping ka domain alag, output ka domain alag — dono ka maqsad alag hai.
// ═══════════════════════════════════════════════════════════════════════════
const OUTPUT_HOST = 'www.yelp.co.uk';


function toOutputDomain(u) {
  try {
    const s = String(u || '').trim();
    if (!s) return u;
    // Yelp kabhi poora URL deta hai aur kabhi sirf raasta:
    //     /biz/rng-electrical-glendale-6?ylpcid=5af07acc...
    // Pehle `new URL(s)` aise raaste par exception phenkti thi aur URL waisa
    // ka waisa (bina domain ke) result mein chala jata tha. Ab base domain se
    // resolve karte hain. Query (ylpcid wagera) waise hi rehti hai.
    const x = new URL(s, 'https://' + OUTPUT_HOST);
    if (!/(^|\.)yelp\./.test(x.hostname)) return u;
    x.hostname = OUTPUT_HOST;
    return x.toString();
  } catch (e) { return u; }
}

function toDomain(u) {
  const host = DOMAIN_HOST[DOMAIN];
  if (!host) return u;
  try {
    const x = new URL(u);

    if (!/(^|\.)yelp\./.test(x.hostname)) return u;
    x.hostname = host;
    return x.toString();
  } catch (e) { return u; }
}

// ─── CACHE KEY: domain hata ke sirf /biz/naam ────────────────────────────────
// yelp.com.au/biz/abc aur yelp.co.uk/biz/abc = ek hi business = ek hi cache entry

// PHOTO PHASE ONLY: adhoore Yelp business paths ko photo request ke liye poora
// karo. Search, cookies, domain conversion aur baaki sab fetching waise hi.
//
// Yelp ka redirect_url kabhi poora URL deta hai aur kabhi sirf raasta
// (/biz/rng-electrical-glendale-6?ylpcid=...). Raasta hone par
// /biz_photos/... bhi adhoora ban jata tha aur fetch chalti hi nahi thi —
// isi liye sab manual review mein jate the.
function photoPageUrl(businessUrl) {
  try {
    const host = DOMAIN_HOST[DOMAIN] || 'www.yelp.ie';
    const u = new URL(String(businessUrl || ''), 'https://' + host);
    if (!/(^|\.)yelp\./i.test(u.hostname)) return String(businessUrl || '').replace('/biz/', '/biz_photos/');
    u.search = '';
    u.hash = '';
    u.pathname = u.pathname.replace('/biz/', '/biz_photos/');
    return u.toString();
  } catch (e) {
    return String(businessUrl || '').replace('/biz/', '/biz_photos/');
  }
}

function bizKey(u) {
  const m = /\/biz\/[^?#]*/.exec(String(u || ''));
  if (!m) return String(u || '');
  let p = m[0];
  for (let i = 0; i < 3; i++) {
    try { const d = decodeURIComponent(p); if (d === p) break; p = d; } catch (e) { break; }
  }
  return p.toLowerCase().replace(/\/+$/, '');
}

// ─── IndexedDB ────────────────────────────────────────────────────────────────
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open('YelpScraperDB', 2);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('scrapedBusinesses')) {
        const s = d.createObjectStore('scrapedBusinesses', { keyPath: 'url' });
        s.createIndex('timestamp', 'timestamp', { unique: false });
      } else if (e.oldVersion < 2) {
        // migration: https://www.yelp.co.uk/biz/x  ->  /biz/x  (duplicates khud mil jaate hain)
        const store = e.target.transaction.objectStore('scrapedBusinesses');
        const g = store.getAll();
        g.onsuccess = () => {
          const rows = g.result || [];
          store.clear().onsuccess = () => {
            for (const r of rows) store.put({ url: bizKey(r.url), timestamp: r.timestamp || Date.now() });
          };
        };
      }
    };
  });
}

async function isScraped(url) {
  const d = await openDB();
  return new Promise((res, rej) => {
    const req = d.transaction(['scrapedBusinesses'], 'readonly').objectStore('scrapedBusinesses').get(bizKey(url));
    req.onsuccess = () => res(!!req.result);
    req.onerror = () => rej(req.error);
  });
}

// ⚡ BULK: ek hi transaction mein hazaron URLs (per-URL transaction se 50-100x tez)
// Jo URLs cache mein ja chuki hain unka hisaab — dobara likhne ki zaroorat nahi
const cachedSoFar = new Set();
let lastFoundSet = new Set();   // abhi chal rahi run ki found URLs (finally mein cache ke liye)

// CHECKPOINT CACHING: ab tak mili URLs foran cache mein daal do, run ke aakhir
// ka intezar nahi. Run beech mein ruk jaye tab bhi ye URLs agli baar skip hongi.
async function cacheFoundSoFar(found) {
  try {
    if (!CFG.useCache) return 0;
    const fresh = [];
    for (const u of found) if (!cachedSoFar.has(u)) { cachedSoFar.add(u); fresh.push(u); }
    if (!fresh.length) return 0;
    await saveBusinessesBulk(fresh);
    await setCachedCount(await getCount());
    return fresh.length;
  } catch (e) { return 0; }
}

async function saveBusinessesBulk(urls, chunk = 20000) {
  const d = await openDB();
  const ts = Date.now();
  for (let i = 0; i < urls.length; i += chunk) {
    const slice = urls.slice(i, i + chunk);
    await new Promise((res, rej) => {
      const tx = d.transaction(['scrapedBusinesses'], 'readwrite');
      const store = tx.objectStore('scrapedBusinesses');
      for (const url of slice) store.put({ url: bizKey(url), timestamp: ts });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
}

async function deleteBusinessesBulk(urls, chunk = 20000) {
  const d = await openDB();
  for (let i = 0; i < urls.length; i += chunk) {
    const slice = urls.slice(i, i + chunk);
    await new Promise((res, rej) => {
      const tx = d.transaction(['scrapedBusinesses'], 'readwrite');
      const store = tx.objectStore('scrapedBusinesses');
      for (const url of slice) store.delete(bizKey(url));
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
}

async function saveBusiness(url) {
  const d = await openDB();
  return new Promise((res, rej) => {
    const req = d.transaction(['scrapedBusinesses'], 'readwrite').objectStore('scrapedBusinesses').put({ url: bizKey(url), timestamp: Date.now() });
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}

// count storage mein bhi rakho taake popup ko FORAN mile (IndexedDB scan ka intezar nahi)
async function setCachedCount(n) {
  try { await chrome.storage.local.set({ bf_cache_count: n }); } catch (e) {}
}
async function getCachedCount() {
  try { const r = await chrome.storage.local.get('bf_cache_count'); return r.bf_cache_count ?? null; }
  catch (e) { return null; }
}

async function getCount() {
  const d = await openDB();
  return new Promise((res, rej) => {
    const req = d.transaction(['scrapedBusinesses'], 'readonly').objectStore('scrapedBusinesses').count();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function getAllUrls() {
  const d = await openDB();
  return new Promise((res, rej) => {
    const req = d.transaction(['scrapedBusinesses'], 'readonly').objectStore('scrapedBusinesses').getAll();
    req.onsuccess = () => res(req.result.map(r => r.url.startsWith('/biz/') ? 'https://www.yelp.com' + r.url : r.url));
    req.onerror = () => rej(req.error);
  });
}

async function clearAll() {
  const d = await openDB();
  return new Promise((res, rej) => {
    const req = d.transaction(['scrapedBusinesses'], 'readwrite').objectStore('scrapedBusinesses').clear();
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toPopup(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }
function log(message) { toPopup({ action: 'logUpdate', message }); }
function status(message) { toPopup({ action: 'statusUpdate', message }); }

function sleep(ms, jitter = 0.3) {
  const v = ms * jitter;
  return new Promise(r => setTimeout(r, ms - v + Math.random() * v * 2));
}

// min..max (inclusive) ke beech random integer — random chunk sizes ke liye
function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// Photo-page fetch: let the browser generate transport, UA and Fetch Metadata
// headers itself. An extension service-worker fetch is NOT a document navigation.
// Keep the existing page Accept / language / referring business URL.
function buildHeaders(referer = 'https://www.yelp.com/') {
  return {
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         referer,
    'Cache-Control':   'max-age=0',
  };
}

// snippet API ke liye headers — XHR/JSON request jaisi dikhti hai
function buildSnippetHeaders(referer = 'https://www.yelp.com/') {
  return {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         referer,
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Dest':  'empty',
    'Sec-Fetch-Mode':  'cors',
    'Sec-Fetch-Site':  'same-origin',
  };
}

// ─── ADAPTIVE ANTI-429/403 THROTTLE ──────────────────────────────────────────
// Idea: jab sab theek ho to koi delay nahi (poori speed). Jaise hi 429/403 aaye,
// ek GLOBAL penalty badh jati hai jise har worker apni next request se pehle wait
// karta hai. Har success par penalty thoda decay hota hai. Yani load tabhi girta
// hai jab Yelp push-back kare, aur khud-ba-khud wapas speed pakad leta hai.
const Throttle = {
  penalty: 0,            // current global wait (ms) har request se pehle
  BASE_PACE: 0,          // proactive base delay
  MAX_PENALTY: 6000,     // QUICK-CLEAR mode: max sirf 6s (lambi backoff nahi)
  STEP: 1200,            // 429 par sirf chhota fixed wait — "solve karo, ruko mat"
  MULT: 1.15,            // bahut halka escalate
  DECAY: 1200,           // fast decay — turant wapas 0 par
  coolUntil: 0,          // hard cooldown (sirf server ka retry-after respect)
  total429: 0,           // kitne 429/403 total aaye (stats)

  // request se pehle: sirf chhota gap — QUICK-CLEAR, lambi wait nahi
  async gate() {
    const now = Date.now();
    if (now < this.coolUntil) await sleep(this.coolUntil - now);
    if (this.BASE_PACE > 0) {
      await sleep(this.BASE_PACE, 0.5);
    }
    if (this.penalty > 0) {
      const jitter = this.penalty * 0.3;
      await sleep(this.penalty - jitter + Math.random() * jitter * 2);
    }
  },
  // 429/403 hone par: SIRF utna wait jitna "clear" hone ke liye chahiye —
  // fir usi jagah se USI SPEED se continue (dheema hoke rehna nahi).
  penalize(retryAfterSec) {
    this.total429++;
    if (retryAfterSec && retryAfterSec > 0) {
      this.coolUntil = Math.max(this.coolUntil, Date.now() + retryAfterSec * 1000);
    }
    this.penalty = this.penalty === 0
      ? this.STEP
      : Math.min(this.MAX_PENALTY, Math.round(this.penalty * this.MULT));
    this.BASE_PACE = Math.min(300, this.BASE_PACE + 30);
  },
  // success par TURANT relax — jaldi se jaldi pehli speed par wapas
  relax() {
    if (this.penalty > 0) this.penalty = Math.max(0, this.penalty - this.DECAY);
    if (this.BASE_PACE > 0 && Math.random() < 0.15) {
      this.BASE_PACE = Math.max(0, this.BASE_PACE - 30);
    }
  },
  reset() { this.penalty = 0; this.coolUntil = 0; this.BASE_PACE = 0; this.total429 = 0; }
};

function parseRetryAfter(res) {
  try {
    const h = res.headers && res.headers.get && res.headers.get('retry-after');
    if (!h) return 0;
    const n = parseInt(h, 10);
    if (!isNaN(n)) return n;              // seconds diya hua
    const d = Date.parse(h);              // ya HTTP-date
    if (!isNaN(d)) return Math.max(0, Math.round((d - Date.now()) / 1000));
  } catch (e) {}
  return 0;
}

// ⛔ STOP-ON-ERROR: koi retry nahi, koi backoff nahi, koi slowdown nahi.
//    Jo bhi error aaye (429 / 403 / 503 / 500 / network) — turant ruk jao.
//    Tum Yelp par manually solve karo, phir Resume — POORI speed se wahीं se.
let lastErr = null;   // { status, url } — banner mein dikhane ke liye

// ─── HUMAN MODE: requests tumhare khud ke Yelp tab ke andar se jaati hain ────
// Tab mein asli page chala hai (DataDome ka JS bhi), captcha tum khud solve karte ho,
// aur fetch usi page ke cookies ke saath hota hai.
async function findYelpTab(host) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://' + host + '/*'] });
    return tabs[0] || null;
  } catch (e) { return null; }
}

async function ensureYelpTab(sampleUrl) {
  try {
    await domainReady;
    const u = toDomain(sampleUrl || 'https://www.yelp.com/');
    const host = new URL(u).hostname;
    yelpHost = host;
    if (await findYelpTab(host)) return;
    await chrome.tabs.create({ url: 'https://' + host + '/', active: true });
    log('🌐 Yelp tab khola — 6 sec ruk raha hoon (captcha aaye to solve karo)');
    await new Promise(r => setTimeout(r, 6000));
  } catch (e) {}
}

async function openSolveTab() {
  await setLite(false);
  try {
    const u = ((lastErr && lastErr.url) ? lastErr.url : 'https://www.yelp.com/').replace('/search/snippet?', '/search?');
    const host = new URL(u).hostname;
    const t = await findYelpTab(host);
    if (t) {
      await chrome.tabs.update(t.id, { url: u, active: true });
      try { await chrome.windows.update(t.windowId, { focused: true }); } catch (e) {}
    } else {
      await chrome.tabs.create({ url: u, active: true });
    }
    log('👉 Yelp tab samne aa gaya. Captcha ho to KHUD solve karo, page normal khule, phir popup mein ▶ Resume dabao.');
  } catch (e) {}
}

// ─── AUTO ROTATION (human mode) ──────────────────────────────────────────────
// DataDome cookie IP se bandhi hoti hai, isliye HAR request par IP badalna kaam nahi karta.
// Kaam karne wala tareeka: har N requests ke baad YA block aane par:
//   naya port (= naya IP) -> purani cookies saaf -> Yelp tab fresh load -> aage chalo.
let yelpHost = 'www.yelp.com';
let rotating = null, rotEpoch = 0, reqSinceRotate = 0, inflight = 0;
let humanLimit = 6, humanOk = 0;     // abhi kitni requests ek saath (auto badhti/ghatti hai)
function initHumanLimit() {
  const mx = Math.max(1, parseInt(CFG.humanConc, 10) || 4);
  humanLimit = CFG.adaptive ? Math.min(mx, 6) : mx; humanOk = 0;
}
function humanDelayMs() {
  const a = Number.isFinite(+CFG.delayMin) ? +CFG.delayMin : 1.5;
  const b = Number.isFinite(+CFG.delayMax) ? +CFG.delayMax : 4;
  return randInt(Math.round(Math.min(a, b) * 1000), Math.round(Math.max(a, b) * 1000));
}
const dataStats = { reqBytes: 0, loadBytes: 0, rotations: 0, reqCount: 0, earlyCount: 0, ratioBytes: 0, ratioChars: 0, calib: 0, sinceAudit: 0, fullCount: 0, fullBytes: 0, capCount: 0, calSamples: 0, adKB: [], auditN: 0, auditAds: 0, auditMissed: 0 };
let seenKeys = new Set();       // bizKey (/biz/naam) — domain/params se bina farq ke duplicate rokta hai
const cacheStats = { skipped: 0 };
let cacheKeys = null;           // cache ki saari keys memory mein (Set) — har link par IndexedDB nahi, bilkul instant
async function loadCacheKeys() {
  await ensureCache();
  const d = await openDB();
  return new Promise(res => {
    const rq = d.transaction(['scrapedBusinesses'], 'readonly').objectStore('scrapedBusinesses').getAllKeys();
    rq.onsuccess = () => res(new Set(rq.result));
    rq.onerror = () => res(new Set());
  });
}
let foundAll = new Set();       // is run mein mile SAARE sponsored links (naye + cache wale)
let liveAll = null;
let liveFound = null;           // chalti run ka allBusinessUrls Set (Copy/Download ke liye)
let rateWin = [];               // pichle ~90s ki speed (ETA ke liye)
// compression ratio pehle kabhi naap chuke hon to wahi istemal karo (har baar dobara calibrate nahi)
chrome.storage.local.get('bf_ratio').then(r => {
  const x = r && r.bf_ratio;
  if (x) { dataStats.ratioBytes = x.b || 0; dataStats.ratioChars = x.c || 0; dataStats.fullCount = x.n || 0; dataStats.fullBytes = x.fb || 0; dataStats.calSamples = x.cs || 0; dataStats.adKB = x.ad || []; }
}).catch(() => {});
let stopRequested = false;
let runT0 = 0, lastStatsAt = 0;

let lastAuthAt = 0;
// Chrome caches the proxy login and keeps sending the OLD username after a switch.
// Clearing the auth cache (entries created since the last login) forces it to ask again.
async function clearProxyAuth() {
  try { await chrome.browsingData.remove({ since: Math.max(0, (lastAuthAt || Date.now()) - 3000) }, { passwords: true }); } catch (e) {}
}
function sessMode() { return /\{sid\}/.test(String((PROXY && PROXY.user) || '')); }
function newSid() { return String(10000000 + Math.floor(Math.random() * 89999999)); }
function curUser() {
  const u = String(PROXY.user || '');
  if (!/\{sid\}/.test(u)) return u;
  if (!PROXY.sid) { PROXY.sid = newSid(); chrome.storage.local.set({ bf_proxy: Object.assign({}, PROXY, { _pv: 6 }) }).catch(() => {}); }
  return u.replace(/\{sid\}/g, PROXY.sid);
}
function rangeOk() {
  if (PROXY && PROXY.enabled && sessMode()) return true;
  const mn = parseInt(PROXY.stickyMin, 10), mx = parseInt(PROXY.stickyMax, 10);
  return !!(PROXY.enabled && mn > 0 && mx >= mn);
}
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

async function waitTabComplete(tabId, ms) {
  // SPEED: pehle 400ms fixed sota tha aur phir har 250ms check karta tha.
  // Ab 120ms baad shuru aur har 80ms check — wahi kaam, bina faaltu intezar ke.
  await sleepMs(120);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const t = await chrome.tabs.get(tabId); if (t.status === 'complete') return; } catch (e) { return; }
    await sleepMs(80);
  }
}

// proxy se guzri bytes ka andaza (sirf Yelp/DataDome hosts)
async function measureTabBytes(tabId) {
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => {
        let n = 0;
        const re = /(^|\.)(yelp\.[a-z.]+|captcha-delivery\.com|datadome\.co)$/;
        const nav = performance.getEntriesByType('navigation')[0];
        if (nav) n += nav.transferSize || 0;
        performance.getEntriesByType('resource').forEach(e => {
          try { if (re.test(new URL(e.name).hostname)) n += e.transferSize || 0; } catch (_) {}
        });
        return n;
      }
    });
    return (out && out[0] && out[0].result) || 0;
  } catch (e) { return 0; }
}

let reloadRecovering = null;

async function reloadYelpTabFor403(url) {
  if (stopRequested) return false;
  if (reloadRecovering) {
    await reloadRecovering;
    return !stopRequested;
  }
  // humanMode band hai to tab hai hi nahi — reload ka koi matlab nahi, seedha naya IP.
  if (!CFG.humanMode) return !stopRequested;
  reloadRecovering = (async () => {
    try {
      const host = (() => { try { return new URL(url || ('https://' + yelpHost + '/')).hostname; } catch (e) { return yelpHost; } })();
      const t = await findYelpTab(host);
      if (!t) {
        await ensureYelpTab(url);
        return true;
      }
      log('↻ HTTP 403 — Yelp page reload ho rahi hai, run nahi rukega…');
      try { await chrome.tabs.reload(t.id, { bypassCache: true }); }
      catch (e) { await chrome.tabs.update(t.id, { url: url || ('https://' + host + '/') }); }
      await waitTabComplete(t.id, 20000);
      await sleepMs(1200);
      return true;
    } catch (e) {
      log('⚠️ 403 reload failed — retrying same request…');
      return true;
    } finally { reloadRecovering = null; }
  })();
  return await reloadRecovering;
}

async function loadTabFresh() {
  const url = 'https://' + yelpHost + '/';
  let t = await findYelpTab(yelpHost);
  if (t) { await chrome.tabs.update(t.id, { url }); }
  else { t = await chrome.tabs.create({ url, active: false }); }
  await waitTabComplete(t.id, 20000);
  // DataDome cookie dikhte hi aage badho (max 2.5s); cookie padhi na ja sake to pehle jaisa poora intezar
  // SPEED: pehle 250ms SOTA THA phir check karta tha — cookie aksar pehle hi aa chuki hoti hai.
  // Ab CHECK pehle, so baad mein. Poll 250→70ms. Cookie milne par 150→40ms.
  const tw = Date.now();
  while (Date.now() - tw < 2500) {
    try {
      const o = await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: () => /datadome=/.test(document.cookie) });
      if (o && o[0] && o[0].result) { await sleepMs(40); break; }
    } catch (e) {}
    await sleepMs(70);
  }
  // SPEED: byte measurement sirf counter ke liye hai — rotation ise wait na kare
  measureTabBytes(t.id).then(b => { dataStats.loadBytes += b; }).catch(() => {});
}

let tabFreshP = null;
function tabFresh() {   // many workers share one tab reload
  if (!tabFreshP) tabFreshP = loadTabFresh().finally(() => { tabFreshP = null; });
  return tabFreshP;
}

function rotateIp(reason) {
  if (rotating) return rotating;
  rotating = (async () => {
    try {
      const served = reqSinceRotate;
      const t0 = Date.now();
      // SPEED: cap 1500→600ms aur poll 40→20ms. Requests aksar 100-200ms mein
      // khatam ho jati hain — 1500ms tak baithne ki zaroorat nahi.
      while (inflight > 0 && Date.now() - t0 < 600) await sleepMs(20);   // chalti requests pehle khatam hon
      const mn = parseInt(PROXY.stickyMin, 10), mx = parseInt(PROXY.stickyMax, 10);
      PROXY.sessionIdx = (parseInt(PROXY.sessionIdx, 10) || 0) + 1;
      if (sessMode()) { PROXY.sid = newSid(); await clearProxyAuth(); }
      await chrome.storage.local.set({ bf_proxy: Object.assign({}, PROXY, { _pv: 6 }) });                  // onChanged -> applyProxy
      await sleepMs(120);   // SPEED: 300→120ms — onChanged/applyProxy itne mein fire ho jata hai
      // humanMode band hai to cookie/tab ki koi bhoomika nahi — ye dono skip.
      // Rotation ab sirf proxy port badalna hai: ~150ms, 3-7 sec nahi.
      if (CFG.humanMode) await wipeYelpData(true, true);                     // cookies saaf, cache rakho
      if (CFG.humanMode) await setLite(true);                                 // switch ke dauran images/CSS block = kam data
      if (CFG.humanMode) { try { await loadTabFresh(); } finally { await setLite(!!CFG.lite); } }
      rotEpoch++; reqSinceRotate = 0; dataStats.rotations++;
      const port = sessMode() ? ('sid ' + PROXY.sid) : (mn + (PROXY.sessionIdx % (mx - mn + 1)));
      evt('info', 'NEW_IP', 'New IP (' + reason + ') after ' + served + ' requests on the old IP: ' + port);
      log('⚡ New IP [' + reason + '] after ' + served + ' req — ' + port + ' — ' + (Date.now() - t0) + ' ms — full speed resumed');
      // IP ka naam baad mein (background mein) — rotation intezar nahi karti
      fetch('https://api.ipify.org?format=json', { cache: 'no-store', credentials: 'omit' })
        .then(r => r.json()).then(j => { dataStats.reqBytes += 600; log('   → ' + j.ip); if (j.ip && j.ip === lastExitIp) evt('warn', 'SAME_IP', 'The IP did not change after switching (' + j.ip + ')', { why: 'Chrome may still be sending the old username (cached proxy login).', fix: 'Close Chrome completely, reopen it and run again. If it keeps happening, send me this log.' }); lastExitIp = j.ip; }).catch(() => {});
    } catch (e) {
      evt('error', 'ROTATE_FAIL', 'Could not switch IP: ' + ((e && e.message) || e),
          { why: 'Changing the proxy port or reloading the Yelp tab failed.', fix: 'Check that the Yelp tab is open and the proxy works (Test IPs in settings).' });
    } finally { rotating = null; }
  })();
  return rotating;
}

// ─── AUTO RECOVER: block / captcha aaye to ruko mat — naya IP, tab reload, wahi request dobara ───
// Sirf tab ruk jata hai jab lagatar maxAutoRot (default 60) naye IP bhi fail ho jayen,
// ya sticky port range / proxy login theek na ho.
let consecFail = 0, coolDowns = 0, lastExitIp = '';
function noteGood() { consecFail = 0; }
async function autoRecover(reason, ep) {
  if (stopRequested || !CFG.humanMode || !CFG.autoNewIp || !rangeOk()) return false;
  if (lastErr && lastErr.status === 407) {                             // not whitelisted: if our IP changed, fix it and carry on
    const w = await syncWhitelist(false);
    return !!(w && w.ok && w.changed);
  }
  if (rotating) { await rotating; return !stopRequested; }             // koi aur worker pehle se IP badal raha hai
  if (rotEpoch !== ep) return true;                                    // IP pehle hi badal chuka — bas dobara try karo
  consecFail++;
  const lim = parseInt(CFG.maxAutoRot, 10) || 200;
  if (consecFail > lim && coolDowns < 8) {
    // Do NOT pause the run: cool down, then keep trying with fresh IPs.
    coolDowns++;
    evt('warn', 'COOLDOWN', consecFail + ' new IPs in a row were challenged - cooling down 10 s, then continuing (' + coolDowns + '/8)');
    log('⏳ Many IPs challenged in a row - waiting 10 s, then trying new IPs again (' + coolDowns + '/8)');
    await sleepMs(10000);
    consecFail = Math.floor(lim / 2);
  }
  if (consecFail > lim) {
    evt('warn', 'AUTO_GIVEUP', consecFail + ' new IPs in a row were all blocked', { why: 'Every IP we switched to was challenged too (or the proxy itself is failing).', fix: 'Open the Yelp tab, solve the captcha, press Resume. If it keeps happening: wait 10-15 min, widen the sticky port range, or check your proxy balance.' });
    return false;
  }
  humanOk = 0;
  await rotateIp(reason);
  // SPEED: pehle yahan 8 sec tak ka escalating sleep tha. Naya IP mil chuka hai —
  // dheema hone ki koi wajah nahi. Throttle bhi reset taake POORI speed wapas aaye.
  Throttle.reset();
  humanLimit = Math.max(1, parseInt(CFG.humanConc, 10) || 4);
  return !stopRequested;
}

async function humanGate() {
  for (;;) {
    if (rotating) { await rotating; continue; }
    if (CFG.rotateEvery > 0 && rangeOk() && reqSinceRotate >= CFG.rotateEvery) { await rotateIp('scheduled'); continue; }
    if (inflight >= humanLimit && !stopRequested) { await sleepMs(25); continue; }   // abhi ki limit poori
    break;
  }
  reqSinceRotate++; inflight++;   // caller inflight-- karega
}

// ─── LITE MODE: Yelp tab mein images/CSS/fonts/media block (sirf run ke dauran) ───
async function setLite(on) {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(on ? { enableRulesetIds: ['lite'] } : { disableRulesetIds: ['lite'] });
  } catch (e) {}
}

// BANDWIDTH ONLY: search phase mein Yelp tab ka heavy JS / iframes / beacons /
// websockets block. XHR + main document allowed, is liye snippet JSON bilkul
// pehle jaisa aata hai. Photo phase se PEHLE OFF.
async function setSearchUltraLite(on) {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(on ? { enableRulesetIds: ['search_ultra'] } : { disableRulesetIds: ['search_ultra'] });
  } catch (e) {}
}

// AUTO bandwidth cap: after a few full calibration samples, stop reading a response
// once the useful sponsored-result area has safely passed. A periodic full audit
// keeps the cap conservative if Yelp's response layout grows later.
function effectiveMaxKB() {
  const manual = Math.max(0, parseInt(CFG.maxKB, 10) || 0);
  if (manual > 0) return manual;
  if (!CFG.smartRead || dataStats.calSamples < 5 || !dataStats.adKB.length) return 0;
  const vals = dataStats.adKB.map(Number).filter(n => Number.isFinite(n) && n >= 0);
  if (!vals.length) return 0;
  const lastAdKB = Math.max.apply(null, vals);
  return Math.max(32, Math.min(384, Math.ceil(lastAdKB * 1.35 + 8)));
}

function emitStats(offset, done, total, grand, found, blockedN, active) {
  const now = Date.now();
  if (now - lastStatsAt < 700 && offset + done < grand) return;
  lastStatsAt = now;
  const el = Math.max(1, (now - runT0) / 1000);
  rateWin.push({ t: now, d: done });
  while (rateWin.length > 2 && now - rateWin[0].t > 90000) rateWin.shift();
  const w0 = rateWin[0];
  const rate = (now - w0.t >= 3000) ? Math.max(0, (done - w0.d) / ((now - w0.t) / 1000)) : done / el;
  const doneAll = offset + done;
  const eta = rate > 0 ? Math.max(0, (grand - doneAll) / rate) : 0;
  const s = {
    action: 'stats', done: doneAll, total: grand, found, blocked: blockedN, active,
    rate, eta, dataMB: (dataStats.reqBytes + dataStats.loadBytes) / 1048576,
    avgKB: dataStats.reqCount ? (dataStats.reqBytes / dataStats.reqCount) / 1024 : 0,
    earlyPct: dataStats.reqCount ? Math.round(100 * dataStats.earlyCount / dataStats.reqCount) : 0,
    fullKB: dataStats.fullCount ? (dataStats.fullBytes / dataStats.fullCount) / 1024 : 0,
    cached: cacheStats.skipped, capPct: dataStats.reqCount ? Math.round(100 * dataStats.capCount / dataStats.reqCount) : 0,
    adEndKB: dataStats.adKB.length ? Math.max.apply(null, dataStats.adKB) : 0, maxKB: effectiveMaxKB(),
    auditN: dataStats.auditN, auditAds: dataStats.auditAds, auditMissed: dataStats.auditMissed,
    cfg: { conc: CFG.humanConc, limit: humanLimit, adaptive: !!CFG.adaptive, dmin: CFG.delayMin, dmax: CFG.delayMax, rot: CFG.rotateEvery, lite: !!CFG.lite, cache: !!CFG.useCache },
    rotations: dataStats.rotations, at: now,
    hyb: Hybrid.stats()
  };
  toPopup(s);
  chrome.storage.local.set({ bf_stats: s }).catch(() => {});
}

function fmtMB(b) { return (b / 1048576).toFixed(2) + ' MB'; }
function dataLine() {
  return '≈ ' + fmtMB(dataStats.reqBytes + dataStats.loadBytes) + ' through proxy (requests ' + fmtMB(dataStats.reqBytes) +
         ', page loads ' + fmtMB(dataStats.loadBytes) + ', IP switches ' + dataStats.rotations + ')';
}
async function saveDataTotal() {
  try {
    const r = await chrome.storage.local.get('bf_data_total');
    await chrome.storage.local.set({ bf_data_total: (r.bf_data_total || 0) + dataStats.reqBytes + dataStats.loadBytes });
  } catch (e) {}
  dataStats.reqBytes = 0; dataStats.loadBytes = 0; dataStats.rotations = 0;
}

// Yeh function Yelp TAB ke andar chalta hai (self-contained hona zaroori hai).
// smart=true: response stream se padhta hai aur jaise hi searchPageProps.mainContentComponentsListProps
// (saare results, ads samet) poora ho jata hai, baaki download ROK deta hai — bandwidth bachti hai.
// Kata hua JSON band karke valid bana deta hai, isliye parse/extraction bilkul pehle jaisi.
async function pageReadFn(u, hh, smart, maxChars, forceFull) {
  try {
    const ctrl = new AbortController();
    const r = await fetch(u, { headers: hh, credentials: 'include', signal: ctrl.signal });
    const sizeOf = () => {
      try { const es = performance.getEntriesByName(u); const e = es[es.length - 1]; return e ? (e.transferSize || e.encodedBodySize || 0) : 0; }
      catch (_) { return 0; }
    };
    const adInfo = (t) => {
      const re = /"isAd"\s*:\s*true/g; let m, last = -1, n = 0, beyond = 0;
      while ((m = re.exec(t))) { last = m.index; n++; if (maxChars > 0 && m.index > maxChars + 3000) beyond++; }
      return { adAt: last, adN: n, adBeyond: beyond };
    };
    if (!smart || forceFull || !r.ok || !r.body) {
      const text = await r.text();
      return Object.assign({ status: r.status, ok: r.ok, text, chars: text.length, size: sizeOf(), early: false }, r.ok ? adInfo(text) : {});
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let text = '', pos = 0, inStr = false, esc = false, collect = false, strBuf = '', doneAt = -1, cutAt = -1;
    const stack = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { text += dec.decode(); break; }
      text += dec.decode(value, { stream: true });
      for (; pos < text.length; pos++) {
        const c = text.charCodeAt(pos);
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (c === 92) { esc = true; continue; }
          if (c === 34) {
            inStr = false;
            if (collect) { const t = stack[stack.length - 1]; t.key = strBuf; t.expectKey = false; collect = false; }
            continue;
          }
          if (collect && strBuf.length < 80) strBuf += text[pos];
          continue;
        }
        if (c === 34) {
          inStr = true; strBuf = '';
          const t = stack[stack.length - 1];
          collect = !!(t && t.t === 'o' && t.expectKey);
          continue;
        }
        if (c === 123) { stack.push({ t: 'o', key: '', expectKey: true, pk: '' }); continue; }
        if (c === 91)  { const t = stack[stack.length - 1]; stack.push({ t: 'a', key: '', expectKey: false, pk: t ? t.key : '' }); continue; }
        if (c === 44)  { const t = stack[stack.length - 1]; if (t && t.t === 'o') t.expectKey = true; continue; }
        if (c === 125 || c === 93) {
          const closed = stack.pop();
          if (closed && closed.t === 'a' && stack.length === 2 &&
              stack[0].key === 'searchPageProps' && stack[1].key === 'mainContentComponentsListProps') {
            doneAt = pos + 1;           // saare results poore — baaki download ki zaroorat nahi
            break;
          }
          // BYTE CAP: budget (maxChars) paar ho chuka ho to agle poore result item par ruk jao
          if (maxChars > 0 && pos + 1 >= maxChars && closed && closed.t === 'o') {
            const par = stack[stack.length - 1];
            if (par && par.t === 'a' && par.pk === 'searchResults') { cutAt = pos + 1; break; }
          }
        }
      }
      if (doneAt > -1 || cutAt > -1) break;
    }
    if (doneAt > -1 || cutAt > -1) {
      const at = doneAt > -1 ? doneAt : cutAt;
      let out = text.slice(0, at);
      for (let k = stack.length - 1; k >= 0; k--) out += stack[k].t === 'o' ? '}' : ']';
      const chars = text.length;
      try { ctrl.abort(); } catch (_) {}
      return { status: r.status, ok: true, text: out, chars, size: 0, early: true, capped: cutAt > -1 };
    }
    return Object.assign({ status: r.status, ok: true, text, chars: text.length, size: sizeOf(), early: false }, adInfo(text));
  } catch (e) { return { status: 0, ok: false, text: '', chars: 0, size: 0, early: false, err: String(e) }; }
}

async function pageFetch(url, headers, smart) {
  // 1) pehli 5 requests POORI padho: asli compression ratio + "ads response mein kahan tak aate hain" naapne ke liye.
  //    Ye save ho jata hai, dobara calibrate nahi hota.
  const cal = !!smart && dataStats.calSamples < 5;
  if (cal) smart = false;
  const ratio0 = dataStats.ratioChars > 0 ? dataStats.ratioBytes / dataStats.ratioChars : 0;
  // 2) KB cap: manual maxKB > 0 ho to wahi; maxKB=0 ho to calibration se AUTO cap.
  const capKB = smart ? effectiveMaxKB() : 0;
  const maxChars = (smart && capKB > 0 && ratio0 > 0) ? Math.floor((capKB * 1024) / ratio0) : 0;
  // 3) Periodic full audit protects result completeness while keeping most responses small.
  const auditEvery = Math.max(0, parseInt(CFG.auditEvery, 10) || 0);
  const audit = !!smart && maxChars > 0 && auditEvery > 0 && dataStats.calSamples >= 5 && dataStats.sinceAudit >= auditEvery;
  if (audit) dataStats.sinceAudit = 0; else if (smart && maxChars > 0) dataStats.sinceAudit++;
  const host = new URL(url).hostname;
  const tab = await findYelpTab(host);
  if (!tab) { lastErr = { status: 0, url, msg: 'no-yelp-tab' }; return null; }
  // sirf safe headers — baaki (User-Agent, Referer, Sec-*) browser khud sahi lagata hai
  const h = {};
  if (headers && headers['Accept']) h['Accept'] = headers['Accept'];
  if (headers && headers['X-Requested-With']) h['X-Requested-With'] = headers['X-Requested-With'];
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', args: [url, h, !!smart, maxChars, audit], func: pageReadFn
    });
    const r = out && out[0] && out[0].result;
    if (!r) { lastErr = { status: 0, url, msg: 'no-result' }; return null; }
    const ratio = dataStats.ratioChars > 0 ? dataStats.ratioBytes / dataStats.ratioChars : 0.25;
    dataStats.reqCount++;
    if (r.early) {
      dataStats.earlyCount++; if (r.capped) dataStats.capCount++;
      dataStats.reqBytes += Math.round((r.chars || 0) * ratio);
    } else if (r.size > 0) {
      dataStats.reqBytes += r.size;
      if (r.chars > 2000) { dataStats.ratioBytes += r.size; dataStats.ratioChars += r.chars; dataStats.fullCount++; dataStats.fullBytes += r.size; }
    } else dataStats.reqBytes += Math.round((r.chars || 0) * ratio);
    if (r.ok && !r.early && r.adAt !== undefined) {
      const rr = dataStats.ratioChars > 0 ? dataStats.ratioBytes / dataStats.ratioChars : ratio;
      if (cal) {
        dataStats.calSamples++;
        if (r.adAt >= 0) { dataStats.adKB.push(+((r.adAt * rr) / 1024).toFixed(2)); if (dataStats.adKB.length > 30) dataStats.adKB.shift(); }
        chrome.storage.local.set({ bf_ratio: { b: dataStats.ratioBytes, c: dataStats.ratioChars, n: dataStats.fullCount, fb: dataStats.fullBytes, cs: dataStats.calSamples, ad: dataStats.adKB } }).catch(() => {});
      } else if (audit) {
        dataStats.auditN++; dataStats.auditAds += r.adN || 0; dataStats.auditMissed += r.adBeyond || 0;
        if (r.adAt >= 0) { dataStats.adKB.push(+((r.adAt * rr) / 1024).toFixed(2)); if (dataStats.adKB.length > 30) dataStats.adKB.shift(); }
      }
    }
    return { ok: r.ok, status: r.status, headers: { get: () => null }, _body: r.text, _early: !!r.early, _chars: r.chars || 0,
             async json() { return JSON.parse(r.text); }, async text() { return r.text; } };
  } catch (e) {
    lastErr = { status: 0, url, msg: (e && e.message) || 'tab-error' };
    return null;
  }
}

function reportStop(phase) {
  const x = explainErr(lastErr);
  evt('warn', 'RUN_STOPPED', 'Run stopped (phase ' + phase + '): ' + x.code,
      { why: x.why, fix: x.fix, status: lastErr && lastErr.status });
  log('❓ Why it stopped: ' + x.why);
  log('✅ What to do: ' + x.fix);
  const dl = dataLine();
  log('📊 Data so far: ' + dl);
  evt('info', 'DATA', 'Data used before stopping: ' + dl);
  saveDataTotal();
}

function okPrefix(res) {
  let n = 0;
  while (res && n < res.length && res[n] === 'OK') n++;
  return n;
}

async function fetchWithRetry(url, options = {}) {
  await cfgReady;
  if (CFG.humanMode) {
    // Block/captcha aaye to: naya IP + fresh Yelp tab + wahi request dobara — ruk kar nahi baithta.
    // autoRecover() sirf tab false deta hai jab lagatar bahut saare IP fail hon (tab Resume/captcha).
    // ═══════════════════════════════════════════════════════════════════
    // INSTANT-IP MODE
    // Koi bhi error (403 / 404 / 429 / 503 / 500 / network) = FORAN naya IP,
    // phir usi request ko usi POORI speed se dobara. Purane same-IP retries
    // aur unke sleeps hata diye gaye hain.
    // ═══════════════════════════════════════════════════════════════════
    let noTabFix = 0, ipTries = 0;
    // PHOTO: ek business ko zyada se zyada 3 naye IP. Uske baad chhodo —
    // caller usey manual review mein daal dega aur agle business par chala jayega.
    // (Search phase par ye cap NAHI lagta — wo chalta rehta hai.)
    const IP_CAP = options.photoSafe ? 3 : 0;
    for (let attempt = 0; ; attempt++) {
      await humanGate();
      const ep = rotEpoch;
      let r = null;
      try { r = await pageFetch(url, options.headers || {}, !!options.smart); } finally { inflight--; }
      if (r && (r.ok || r.status === 206)) {
        humanOk++; consecFail = 0;
        const mx = parseInt(CFG.humanConc, 10) || 4;
        if (CFG.adaptive && humanOk >= 20 && humanLimit < mx) { humanLimit = Math.min(mx, humanLimit + 2); humanOk = 0; }
        return r;
      }
      if (r) lastErr = { status: r.status, url, body: String(r._body || '').slice(0, 1500) };
      noteFail(lastErr);
      if (stopRequested) return null;

      // Ye error NAHI hai: IP abhi badal hi raha tha, ya Yelp tab nahi mila.
      // In dono soorton mein naya IP lene ka koi faida nahi — bas dobara try karo.
      if (lastErr && lastErr.status === 0) {
        if (rotating) { await rotating; continue; }          // switch chal raha hai — uska intezar
        if (rotEpoch !== ep) continue;                        // IP badal chuka — seedha dobara
        if (lastErr.msg === 'no-yelp-tab' && noTabFix < 2) {  // tab band ho gaya tha — khol ke dobara
          noTabFix++;
          try { await tabFresh(); } catch (e) {}
          continue;
        }
      }

      // PHOTO: 3 IP ho chuke to aur na ghisso — chhod kar aage badho.
      if (IP_CAP && ipTries >= IP_CAP) {
        log(`⏭️ ${IP_CAP} IP try kiye, nahi khula — chhod diya: ${String(url).replace('/biz_photos/', '/biz/')}`);
        return null;
      }

      // Baaki HAR error par: FORAN naya IP, phir wahi request POORI speed se.
      ipTries++;
      if (!(await autoRecover('http ' + ((lastErr && lastErr.status) || 0), ep))) return null;
    }
  }
  const fopts = Object.assign({}, options); delete fopts.smart; delete fopts.photoSafe;
  // Proxy ON ho to block/error par dobara try karta hai — PAC har try par naya random
  // port (= naya IP) chunta hai. Proxy OFF ho to pehle jaisa: 1 try, fail = BLOCKED.
  const attempts = options.photoSafe ? 6 : 1 + (CFG.retries | 0);   // direct mode mein bhi retry (network hichki ke liye)
  for (let a = 0; a < attempts; a++) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 30000);
    let retryable = true;
    try {
      // .co.uk par cookie ka koi role nahi (probe: bina cookie 12 ads, cookie ke saath 13).
      // Aur agar kabhi DataDome active hua, to GHALAT IP par bani cookie bhejna
      // bina cookie ke jane se bura hai. Is liye saaf jaate hain.
      const res = await fetch(url, { ...fopts, credentials: (CFG.sendCookie || Hybrid.useCookie) ? 'include' : 'omit', cache: 'no-store', signal: controller.signal });
      clearTimeout(tid);
      if (res.status === 206 || res.ok) {
        // BUG FIX: direct-fetch path bytes count nahi karta tha — "0.0 MB" dikhta tha
        try {
          const cl = res.clone();
          cl.arrayBuffer().then(b => { dataStats.reqCount++; dataStats.reqBytes += (b && b.byteLength) || 0; }).catch(() => {});
        } catch (e2) {}
        return res;
      }
      let bodyTxt = '';
      try { bodyTxt = (await res.clone().text()).slice(0, 400); } catch (e2) {}
      lastErr = { status: res.status, url, body: bodyTxt };
      // photoSafe par 403 retryable list mein tha hi NAHI — photo par 403 aate
      // hi foran haar maan li jati thi. Ab dono raaston par ek jaisa.
      retryable = [403, 429, 503, 502, 504].includes(res.status);
    } catch (e) {
      clearTimeout(tid);
      lastErr = { status: 0, url, msg: (e && e.message) || 'network' };
      retryable = true;                       // network hichki — dobara try
    }
    if (!retryable) break;

    // ─── IP ROTATION — PHOTO PHASE MEIN BHI ────────────────────────────────
    // PAC mein port FIXED hota hai, is liye PX.next() ke bagair IP badalta hi
    // nahi. Pehle yahan sirf sleep tha: wahi blocked IP teen baar try hota,
    // phir business manual review mein chala jata. Search phase mein rotation
    // thi, photo phase mein nahi.
    if (a < attempts - 1) {
      if (PX.cfg.enabled) {
        const st = (lastErr && lastErr.status) || 0;
        try {
          await PX.next('photo ' + (st || 'network'));   // NAYA IP
          log(`🔀 Photo ${st || 'network'} — naya IP, dobara: ${String(url).replace('/biz_photos/', '/biz/')}`);
        } catch (e) {}
        await sleep(300, 0.3);
      } else {
        await sleep(lastErr && lastErr.status === 429 ? 5000 : 1200, 0.25);
      }
    }
  }
  noteFail(lastErr);
  return null;
}

// ─── Concurrent runner with 7-consecutive-block hard stop ────────────────────
async function runConcurrentGuarded(tasks, concurrency, onProgress, onConsecBlock, onCheckpoint) {
  const results = [];
  let idx = 0, done = 0;
  let consecutiveBlocks = 0;
  let hardStop = false;

  // ── ADAPTIVE CONCURRENCY ──────────────────────────────────────────────────
  // allowedActive = is waqt kitne workers ek saath chal sakte hain.
  // 429/block par yeh ghat jata hai (load kam), success streak par wapas badhta hai.
  const MAX_ACTIVE = Math.min(concurrency, tasks.length);
  const MIN_ACTIVE = Math.max(2, Math.floor(MAX_ACTIVE / 6)); // kabhi 0 tak nahi girega
  let allowedActive = MAX_ACTIVE;
  let activeNow = 0;
  let okStreak = 0;

  // FAST mode: keep concurrency fixed at the configured ceiling.
  // No random throttling/wandering; request/error handling is otherwise unchanged.
  let wanderActive = false;

  async function worker() {
    while (idx < tasks.length) {
      if (stopRequested) hardStop = true;
      if (hardStop) break;

      // agar is waqt allowed se zyada workers chal rahe hain to thoda ruk jao
      if (activeNow >= allowedActive) { await sleep(250 + Math.random() * 300); continue; }

      const i = idx++;
      if (i >= tasks.length) break;
      activeNow++;
      let result;
      try { result = await tasks[i](); }
      finally { activeNow--; }
      results[i] = result;
      done++;
      if (onCheckpoint && done % 200 === 0) { try { onCheckpoint(okPrefix(results)); } catch (e) {} }

      if (result === 'BLOCKED') {
        consecutiveBlocks++;
        okStreak = 0;
        if (onConsecBlock) onConsecBlock(consecutiveBlocks);
        // DIRECT MODE: Hybrid ghar par hi recover karta hai (backoff → cookie → proxy),
        // is liye pehle block par rukna GALAT hai. Pehle ye shart thi:
        //   !(PROXY && PROXY.enabled)  →  proxy band = foran stop
        // Aur yahi wajah thi ke run 1-2 links ke baad ruk jati thi.
        const stopAt = (CFG.directMode !== false) ? (CFG.blockLimit || 25)
                     : (CFG.humanMode || !(PROXY && PROXY.enabled)) ? 1 : 7;
        if (consecutiveBlocks >= stopAt) {
          hardStop = true;
          break;
        }
      } else {
        consecutiveBlocks = 0;
        okStreak++;
        // TURANT recovery — sirf 2 success ke baad hi wapas upar (dheema nahi)
        if (okStreak >= 2 && allowedActive < MAX_ACTIVE) {
          allowedActive++;
          okStreak = 0;
        }
      }

      if (onProgress) onProgress(done, tasks.length, allowedActive);
    }
  }

  await Promise.all(Array.from({ length: MAX_ACTIVE }, worker));
  return { results, hardStopped: hardStop };
}

function isYelpBlocked(html) {
  if (!html) return true;
  return html.includes('This page is not available') ||
         html.includes('you may need permission') ||
         html.includes('Request permission') ||
         html.includes('unusual activity') ||
         html.includes('Access to this page has been denied') ||
         html.includes('geo.captcha-delivery.com') ||
         html.includes('captcha-delivery') ||
         html.includes('datadome') ||
         html.includes('g-recaptcha');
}

function extractSponsored(html) {
  const urls = new Set();
  const re1 = /href="\/adredir\?[^"]*redirect_url=([^&"]+)/g;
  let m;
  while ((m = re1.exec(html)) !== null) {
    try { const u = decodeURIComponent(m[1]); if (u.includes('/biz/')) urls.add(u.split('?')[0].split('#')[0]); } catch (e) {}
  }
  const re2 = /\\\/adredir\?[^"\\]*redirect_url=([^&"\\]+)/g;
  while ((m = re2.exec(html)) !== null) {
    try { const u = decodeURIComponent(m[1]); if (u.includes('/biz/')) urls.add(u.split('?')[0].split('#')[0]); } catch (e) {}
  }
  const re3 = /\/adredir\?[^"\\]*(?:(?:^|&amp;|&)(?:url|destination)=)([^&"\\]+)/g;
  while ((m = re3.exec(html)) !== null) {
    try { const u = decodeURIComponent(m[1]); if (u.includes('/biz/')) urls.add(u.split('?')[0].split('#')[0]); } catch (e) {}
  }
  return [...urls];
}

// JSON snippet response se SIRF sponsored (isAd:true) businesses ka /biz/ URL nikalo.
// businessUrl mein /adredir?...redirect_url=<encoded biz url> hota hai — usse asli URL decode karte hain.
// Organic results (isAd:false) apne aap skip ho jate hain.
function extractSponsoredFromJsonUsa11(json) {
  const urls = new Set();
  const components = (json.searchPageProps && json.searchPageProps.mainContentComponentsListProps) || [];

  const pull = (biz) => {
    if (!biz || !biz.isAd || !biz.businessUrl) return;
    // adredir link se redirect_url nikalo
    const m = /[?&]redirect_url=([^&]+)/.exec(biz.businessUrl);
    if (!m) return;
    try {
      const decoded = decodeURIComponent(m[1]).split('?')[0].split('#')[0];
      // sirf asli business page (mtb_composer wale skip)
      if (decoded.includes('/biz/')) urls.add(decoded);
    } catch (e) {}
  };

  for (const section of components) {
    const props = section && section.props;
    if (!props) continue;
    // themedAds (carousel) aur unthemed_ads (vertical sponsored) dono ke andar searchResults hota hai
    const results = props.searchResults;
    if (Array.isArray(results)) results.forEach(pull);
  }
  return [...urls];
}

function extractSponsoredFromJson(json) {
  // usa1000cities11 exact sponsored-component parser first; v25.3 recursive parser remains as fallback.
  const usa11 = extractSponsoredFromJsonUsa11(json);
  // Yelp response layouts change. Do not depend on only one component path:
  // recursively inspect every object and collect any isAd:true businessUrl/adredir.
  const urls = new Set();
  const seen = new Set();

  const addBizUrl = (businessUrl) => {
    if (typeof businessUrl !== 'string') return;
    const m = /[?&]redirect_url=([^&]+)/.exec(businessUrl);
    if (!m) return;
    try {
      const decoded = decodeURIComponent(m[1]).split('?')[0].split('#')[0];
      if (decoded.includes('/biz/')) urls.add(decoded);
    } catch (e) {}
  };

  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (!Array.isArray(v) && v.isAd === true && typeof v.businessUrl === 'string') addBizUrl(v.businessUrl);
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  for (const u of usa11) urls.add(u);
  walk(json);
  return [...urls];
}


// ═══════════════════════════════════════════════════════════════════════════
// 📉 PHOTO STREAM — ZERO MISS
//
//   Pehle har photo page POORI download hoti thi (~1 MB per business).
//   Ab stream padhte hain aur jawab milte hi kaat dete hain.
//
//   Qaida: cut SIRF tab jab jawab PAKKA mil chuka ho.
//     (a) 2 din wali date mil gayi  → business QUALIFY → turant kaat do
//                                     (aage kuch bhi ho, jawab badal nahi sakta)
//     (b) abhi koi date nahi mili   → KABHI cut nahi, poori page padho
//     (c) dates mili par purani     → poori page padho (pakka karne ko)
//
//   Jo business chahiye wo KABHI miss nahi hoga — sirf bandwidth bachti hai.
// ═══════════════════════════════════════════════════════════════════════════
let photoBytesSaved = 0, photoCuts = 0, photoFull = 0;

function hasRecentDate(text) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const twoDaysAgo = new Date(); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2); twoDaysAgo.setHours(0, 0, 0, 0);
  const re = /uploadDate\\?"\s*:\s*\\?"([0-9]{4}-[0-9]{2}-[0-9]{2}[^"\\]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const d = new Date(m[1]);
    if (isNaN(d)) continue;
    d.setHours(0, 0, 0, 0);
    if (d >= twoDaysAgo && d <= today) return true;
  }
  return false;
}

/** @returns { html, recent, cut, bytes } */
async function readPhotoStream(res) {
  if (!res.body) {
    const html = await res.text();
    photoFull++;
    return { html, recent: checkRecentPhotos(html), cut: false, bytes: html.length };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', bytes = 0, cut = false, checkedTo = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      buf += dec.decode(value, { stream: true });
      if (bytes - checkedTo >= 48 * 1024) {       // har ~48 KB par dekho
        checkedTo = bytes;
        if (hasRecentDate(buf)) {                 // ✅ jawab pakka
          cut = true;
          try { await reader.cancel(); } catch (e) {}
          break;
        }
      }
    }
  } catch (e) {
    try { await reader.cancel(); } catch (e2) {}
  }
  if (cut) { photoCuts++; photoBytesSaved += Math.max(0, 1100 * 1024 - bytes); }
  else photoFull++;
  return { html: buf, recent: cut ? true : checkRecentPhotos(buf), cut, bytes };
}

function checkRecentPhotos(html) {
  const today      = new Date(); today.setHours(0, 0, 0, 0);
  const twoDaysAgo = new Date(); twoDaysAgo.setDate(twoDaysAgo.getDate() - 2); twoDaysAgo.setHours(0, 0, 0, 0);
  // normal "uploadDate":"..." AUR escaped \"uploadDate\":\"...\" dono pakdo
  const re = /uploadDate\\?"\s*:\s*\\?"([0-9]{4}-[0-9]{2}-[0-9]{2}[^"\\]*)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const photoDate = new Date(m[1]);
      if (isNaN(photoDate)) continue;
      photoDate.setHours(0, 0, 0, 0);
      if (photoDate >= twoDaysAgo && photoDate <= today) return true;
    } catch (e) {}
  }
  return false;
}

// ─── PERMANENT MODE (groups of 1000, manual per-group buttons) ───────────────
// URLs ko 1000-1000 ke groups mein baant ke storage mein rakho. Har group ek
// button banega popup mein. User button dabaye → us group ki scraping chale
// (search → photo → cache) → group done mark, lekin dobara bhi chala sakte ho.
const PERM_KEY = 'bf_permanent';
// Structure (v2 — multi collection):
// { collections: [ { id, name, groups: [[...1000],...], done: [false,...] }, ... ] }
// Har collection ka apna naam (jaise "USA", "Canada") aur apne groups hote hain.
const PERM_GROUP_SIZE = 800; // USA1000Cities11 city/group buttons

function chunkUrls(urls) {
  const groups = [];
  for (let i = 0; i < urls.length; i += PERM_GROUP_SIZE) {
    groups.push(urls.slice(i, i + PERM_GROUP_SIZE));
  }
  return groups;
}

async function loadPermanent() {
  const r = await chrome.storage.local.get(PERM_KEY);
  const raw = r[PERM_KEY];
  if (!raw) return { collections: [] };
  // purane single-list format se auto-migrate
  if (raw.groups && !raw.collections) {
    const migrated = {
      collections: [{
        id: 'c_' + Date.now(),
        name: 'My URLs',
        groups: raw.groups,
        done: raw.done || new Array(raw.groups.length).fill(false)
      }]
    };
    await chrome.storage.local.set({ [PERM_KEY]: migrated });
    return migrated;
  }
  return { collections: raw.collections || [] };
}

async function savePermanentState(state) {
  await chrome.storage.local.set({ [PERM_KEY]: state });
}

// naya collection banao (naam + urls) — purane collections bane rehte hain
async function addCollection(name, urls) {
  const state = await loadPermanent();
  const clean = [...new Set((urls || []).map(x => String(x || '').trim()).filter(Boolean))];
  const groups = chunkUrls(clean);
  state.collections.push({
    id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: (name || 'Untitled').trim(),
    groups,
    done: new Array(groups.length).fill(false),
    lastRun: {}
  });
  await savePermanentState(state);
  return { collections: state.collections.length, groups: groups.length, total: clean.length };
}

async function deleteCollection(id) {
  const state = await loadPermanent();
  state.collections = state.collections.filter(c => c.id !== id);
  await savePermanentState(state);
}

async function renameCollection(id, name) {
  const state = await loadPermanent();
  const c = state.collections.find(x => x.id === id);
  if (c) { c.name = (name || 'Untitled').trim(); await savePermanentState(state); }
}

// kisi collection ke kisi group ko done mark karo
async function markGroupDone(collectionId, index, cursorNext) {
  const state = await loadPermanent();
  const c = state.collections.find(x => x.id === collectionId);
  if (c && c.done && index < c.done.length) {
    if (typeof cursorNext === 'number') {
      // har click par agle RUN_LIMIT URLs — group tab 'done' jab saare URLs ho jayein
      if (!c.cursor) c.cursor = {};
      c.cursor[index] = cursorNext;
      c.done[index] = cursorNext >= (c.groups[index] || []).length;
    } else {
      c.done[index] = true;
    }
    // last run ka time yaad rakho — taake pata rahe kaunsa group kab chalaya tha
    if (!c.lastRun) c.lastRun = {};
    c.lastRun[index] = Date.now();
    await savePermanentState(state);
  }
}

// group chalna SHURU hote hi mark karo (taake "running" dikhe)
async function markGroupStarted(collectionId, index) {
  const state = await loadPermanent();
  const c = state.collections.find(x => x.id === collectionId);
  if (c) {
    if (!c.lastRun) c.lastRun = {};
    c.lastRun[index] = Date.now();
    await savePermanentState(state);
  }
}

// ─── Run State (PERSISTED to chrome.storage.local) ───────────────────────────
// MV3 ka service worker lambe kaam par / idle hone par MAR jata hai aur memory udd
// jati hai. Is liye:
//  • searchUrls ek baar STATIC_KEY mein save hoti hain (badalti nahi)
//  • har batch ke baad progress PROG_KEY mein save hoti hai (checkpoint)
//  • agar SW maray to chrome.alarms use ko jaga kar wahi se AUTO-RESUME karta hai
//  • block hone par status 'blocked' hota hai (manual Resume chahiye, auto nahi)
const STATIC_KEY = 'bf_run_static';     // { searchUrls }
const PROG_KEY   = 'bf_run_progress';   // { status, phase, ... }
const KEEPALIVE  = 'bf_keepalive';

let isScraping = false;
let activeRef = null;   // abhi kaunsa permanent group chal raha hai { collectionId, index }

async function saveStatic(searchUrls) {
  await chrome.storage.local.set({ [STATIC_KEY]: { searchUrls } });
}
async function loadStatic() {
  const r = await chrome.storage.local.get(STATIC_KEY);
  return r[STATIC_KEY] || null;
}

// p.allBusinessUrls Set ya array dono chalega
async function savePartial(set) {
  try {
    await chrome.storage.local.set({ lastResult: [...set].join('\n'), lastResultCount: set.size, lastResultAt: Date.now(), lastResultPartial: true, lastResultAll: [...foundAll].join('\n'), lastResultAllCount: foundAll.size });
  } catch (e) {}
}

async function saveProgress(p) {
  const safe = {
    status:               p.status,                 // 'running' | 'blocked'
    phase:                p.phase,
    startSearchBatch:     p.startSearchBatch || 0,
    startPhotoBatch:      p.startPhotoBatch  || 0,
    allBusinessUrls:      [...(p.allBusinessUrls || [])],
    foundAll:             [...foundAll],
    newUrls:              p.newUrls || null,
    businessesWithPhotos: p.businessesWithPhotos || [],
    err:                   p.err || null,
    manualReviewUrls:      p.manualReviewUrls || [],
    blocked:              p.blocked || 0,
    photoBlocked:         p.photoBlocked || 0,
    found:                p.found || 0,
    active:               p.active || 0
  };
  await chrome.storage.local.set({ [PROG_KEY]: safe });
}
async function loadProgress() {
  const r = await chrome.storage.local.get(PROG_KEY);
  const s = r[PROG_KEY];
  if (!s) return null;
  return { ...s, allBusinessUrls: new Set(s.allBusinessUrls || []) };
}
async function getRunStatus() {
  const r = await chrome.storage.local.get(PROG_KEY);
  return r[PROG_KEY] ? r[PROG_KEY].status : null;
}
async function clearRun() {
  await chrome.storage.local.remove([STATIC_KEY, PROG_KEY]);
  stopKeepalive();
}

function startKeepalive() { try { chrome.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 }); } catch (e) {} }
function stopKeepalive()  { try { chrome.alarms.clear(KEEPALIVE); } catch (e) {} }

// ─── Core scraping logic (checkpoint ke saath) ───────────────────────────────
async function runScraping(init) {
  lastFoundSet = init.allBusinessUrls || new Set();   // finally-cache ke liye reference
  let {
    searchUrls, allBusinessUrls, newUrls, businessesWithPhotos, manualReviewUrls = [],
    startSearchBatch, startPhotoBatch, blocked, photoBlocked, phase
  } = init;
  foundAll = new Set(init.foundAll || []);
  liveAll = foundAll;

  const PHOTO_BATCH  = 50;

  // ── PHASE 1 ────────────────────────────────────────────────────────────────
  // Chunk sizes ab RANDOM hain (fixed 500 nahi) — har chunk kabhi 150, kabhi 380...
  // taake request pattern predictable na rahe. startSearchBatch ab URL OFFSET hai
  // (kitne URLs ho chuke), na ki batch number — is se random-size resume bhi safe.
  // taake request pattern predictable na rahe. Chunk-wise batching HATA di gayi —
  // ab poori list EK BAAR mein 300 concurrency se chalti hai, koi beech mein
  // rest/chunk-break nahi. startSearchBatch offset hai (resume ke liye).
  if (phase <= 1) {
    const offset = startSearchBatch; // resume: yahan se aage
    runT0 = Date.now(); lastStatsAt = 0; rateWin = []; liveFound = allBusinessUrls;
    seenKeys = new Set([...allBusinessUrls].map(bizKey));
    consecFail = 0;
    cacheKeys = CFG.useCache ? await loadCacheKeys() : null;
    if (cacheKeys) log(`Cache loaded in memory: ${cacheKeys.size} businesses (matching links are skipped, no extra data used)`);
    const grandTotal = searchUrls.length;
    const batch = searchUrls.slice(offset);

    if (batch.length > 0) {
      // FAST mode: fixed concurrency from settings; no random concurrency drops.
      if (CFG.humanMode) log(`Started: ${batch.length} links left, up to ${CFG.humanConc || 4} at a time${CFG.adaptive ? ' (auto speed-up)' : ''}, ${CFG.delayMin}-${CFG.delayMax} s between requests`);
      else log(`URLs: ${offset}/${grandTotal} done | Baaki: ${batch.length} — fixed concurrency 25 (VPN/direct)`);

      // SIMPLE MODE: portability test ka hubahu tareeqa
      if (CFG.simpleMode) {
        let lastCheckpoint = offset;
        const sr = await runSimplePhase1(searchUrls, offset, allBusinessUrls, seenKeys, cacheKeys,
          (d, t, ok, fail) => {
            const abs = offset + d;
            status(`${abs}/${grandTotal} | ok ${ok} · fail ${fail} | Found: ${allBusinessUrls.size} | ⚡25x ${simpleSpeed.gap}ms`);
            emitStats(offset, d, t, grandTotal, allBusinessUrls.size, fail, 25);
            // Persist a safe contiguous checkpoint every 10 completed URLs.
            if (abs - lastCheckpoint >= 10) {
              lastCheckpoint = abs;
              saveProgress({ status: 'running', phase: 1, startSearchBatch: abs, startPhotoBatch: 0,
                allBusinessUrls, newUrls: null, businessesWithPhotos: [], blocked: 0, photoBlocked: 0,
                found: allBusinessUrls.size, active: 25 }).catch(() => {});
            }
          });
        if (sr.halted || sr.stopped) {
          await cacheFoundSoFar(allBusinessUrls);
          await saveProgress({
            status: 'blocked', phase: 1, err: lastErr || null, startSearchBatch: sr.resumeOffset, startPhotoBatch: 0,
            allBusinessUrls, newUrls: null, businessesWithPhotos: [],
            blocked: 1, photoBlocked: 0, found: allBusinessUrls.size, active: 0
          });
          stopKeepalive();
          await savePartial(allBusinessUrls);
          if (sr.stopped && !sr.halted) {
            status(`Paused — Resume will continue at ${sr.resumeOffset}/${grandTotal}`);
            toPopup({ action: 'blocked', err: lastErr || null, found: allBusinessUrls.size, active: 0, phase: 1, err: null, info: { code: 'USER_STOP', why: 'Stopped by you.', fix: 'Press Resume to continue from the saved checkpoint.' } });
            stopRequested = false;
          } else {
            const hs = sr.haltedStatus || (lastErr && lastErr.status) || 0;
            status(`Paused on ${hs ? 'HTTP ' + hs : 'network/error'} — Resume will continue at ${sr.resumeOffset}/${grandTotal}`);
            toPopup({ action: 'blocked', err: lastErr || null, found: allBusinessUrls.size, active: 0, phase: 1, err: lastErr, info: explainErr(lastErr) });
          }
          return;
        }
        await saveProgress({
          status: 'running', phase: 1, startSearchBatch: grandTotal, startPhotoBatch: 0,
          allBusinessUrls, newUrls: null, businessesWithPhotos: [],
          blocked: 0, photoBlocked: 0, found: allBusinessUrls.size, active: 0
        });
      } else {
      const { results: p1res, hardStopped } = await runConcurrentGuarded(
        batch.map(searchUrl => async () => {
          // har request se pehle bada RANDOM millisecond delay (burst rokta hai)
          await sleep(CFG.humanMode ? humanDelayMs() : randInt(250, 700), 0);   // ghar ke IP par narmi
          // /search? ko /search/snippet? mein convert karo — yeh JSON deta hai (~10x chhota)
          await domainReady;
          const su = toDomain(searchUrl);
          const snippetUrl = su.replace(/\/search\?/, '/search/snippet?');
          let json = null;
          for (let tries = 0; ; tries++) {
            const ep = rotEpoch;
            const response = await fetchWithRetry(snippetUrl, { headers: buildSnippetHeaders(su), smart: !!CFG.smartRead });
            if (!response) { blocked++; return 'BLOCKED'; }
            const txt = await response.text();
            let j = null;
            try { j = JSON.parse(txt); } catch (e) { lastErr = { status: 200, url: snippetUrl, body: txt.slice(0, 400), kind: 'notjson' }; }
            if (j && j.searchPageProps) { json = j; noteGood(); break; }
            if (j) {
              lastErr = { status: 200, url: snippetUrl, body: txt.slice(0, 400), kind: 'nodata' };
              // valid JSON jis mein captcha ka zikr nahi = shayad link hi kharab hai — block samajh kar IP mat jalao
              if (tries >= 1 && !/captcha|datadome|geo\./i.test(txt)) { evt('warn', 'BAD_LINK', 'No search data for a link, skipped', { why: 'Yelp answered normally but the page has no results.', fix: 'Check that link in the browser.' }); noteGood(); return 'OK'; }
            }
            noteFail(lastErr);
            // HYBRID: pehle ghar par dheema ho kar try, phir hi proxy
            if (CFG.directMode !== false) {
              await Hybrid.onBlock(snippetUrl, 'http ' + ((lastErr && lastErr.status) || 0));
              await Hybrid.maybeGoHome(snippetUrl);
              blocked++;
              return 'BLOCKED';
            }
            if (!(await autoRecover('blocked', ep))) { blocked++; return 'BLOCKED'; }
          }
          // duplicate nahi: /biz/naam key (domain/params ignore) + cache mein pehle se maujood bhi skip
          AutoReload.ok();      // kaamyabi — counter reset
          for (const _raw of extractSponsoredFromJson(json)) {
            const u = toOutputDomain(_raw);        // natija hamesha .co.uk
            const k = bizKey(u);
            if (seenKeys.has(k)) continue;
            seenKeys.add(k);
            foundAll.add(u);
            if (cacheKeys && cacheKeys.has(k)) { cacheStats.skipped++; continue; }
            allBusinessUrls.add(u);
          }
          return 'OK';
        }),
        CFG.humanMode ? (CFG.humanConc || 4) : (CFG.humanConc || 250),
        (done, total, active) => { status(`URLs: ${offset + done}/${grandTotal} | ${done}/${total} | Conc: ${active} | Found: ${allBusinessUrls.size} | 429s: ${Throttle.total429}`); emitStats(offset, done, total, grandTotal, allBusinessUrls.size, blocked, active); },
        (consec) => status(`⛔ ${consec}/7 consecutive blocks...`),
        (prefix) => {
          savePartial(allBusinessUrls);
          saveProgress({ status: 'running', phase: 1, startSearchBatch: offset + prefix, startPhotoBatch: 0, allBusinessUrls, newUrls: null, businessesWithPhotos: [], blocked, photoBlocked: 0, found: allBusinessUrls.size, active: 0 }).catch(() => {});
        }
      );

      if (hardStopped) {
        log(`⛔ ${CFG.blockLimit || 25} lagataar blocks — run ruk gayi. Jo mila wo mehfooz hai, Resume se wahin se chalegi.`);
        log(`   Hybrid ne ye sab try kiya: ghar par backoff, taazi cookie${CFG.proxyRescue !== false ? ', proxy' : ''}.`);
        // RUK GAYI — jo mila wo cache mein daal kar hi ruko
        const k = await cacheFoundSoFar(allBusinessUrls);
        if (k) log(`💾 Rukne se pehle ${k} URLs cache mein (total: ${cachedSoFar.size})`);
        await saveProgress({
          status: 'blocked', phase: 1, err: lastErr || null, startSearchBatch: offset + okPrefix(p1res), startPhotoBatch: 0,
          allBusinessUrls, newUrls: null, businessesWithPhotos: [],
          blocked, photoBlocked: 0, found: allBusinessUrls.size, active: 0
        });
        stopKeepalive();
        await savePartial(allBusinessUrls);
        if (stopRequested) {
          stopRequested = false;
          evt('info', 'USER_STOP', 'Stopped by you');
          log('⏸ Stopped by you. Press Resume to continue from here.');
          toPopup({ action: 'blocked', err: lastErr || null, found: allBusinessUrls.size, active: 0, phase: 1, err: null, info: { code: 'USER_STOP', why: 'You stopped the run.', fix: 'Press Resume to continue from where it stopped.' } });
          await saveDataTotal();
          return;
        }
        log(`⛔ 7 consecutive blocks — offset ${offset} par ruka`);
        log(`✅ Abhi tak ${allBusinessUrls.size} businesses safe hain`);
        reportStop(1); if (CFG.humanMode) { await openSolveTab(); } else { log(`🔧 IP/VPN fix karo phir Resume dabao`); }
        log(`⛔ RUKA — ${lastErr ? (lastErr.status ? 'HTTP ' + lastErr.status : 'network: ' + lastErr.msg) : 'error'}`);
        log('   Yelp par jaa kar manually solve karo, phir ▶ Resume — POORI speed se wahीं se.');
        toPopup({ action: 'blocked', err: lastErr || null, found: allBusinessUrls.size, active: 0, phase: 1, err: lastErr, info: explainErr(lastErr) });
        return;
      }

      // ✅ CHECKPOINT — poora ho gaya
      await saveProgress({
        status: 'running', phase: 1, startSearchBatch: grandTotal, startPhotoBatch: 0,
        allBusinessUrls, newUrls: null, businessesWithPhotos: [],
        blocked, photoBlocked: 0, found: allBusinessUrls.size, active: 0
      });
      }   // simple-mode else block band
    }

    const urlsArray = [...allBusinessUrls];
    log(`Found: ${urlsArray.length} businesses${blocked ? ` | ⚠️ ${blocked} blocked` : ''}`);

    if (!urlsArray.length) {
      if (blocked > 0) log('⚠️ Yelp blocked. Wait then retry.');
      else if (cacheStats.skipped) {
        log(`✅ Run poori hui — ${cacheStats.skipped} businesses mile lekin SAB PEHLE SE CACHE MEIN THE.`);
        log(`   Is liye "0 new" dikha aur run foran khatam lagi. Ye masla nahi hai.`);
        log(`   Naye results chahiye to: naye links chalao, ya Settings mein cache clear karo.`);
      } else log('No sponsored ads found.');
      if (!blocked) await chrome.storage.local.set({ lastResult: '', lastResultCount: 0, lastResultAt: Date.now(), lastResultPartial: false, lastResultAll: [...foundAll].join('\n'), lastResultAllCount: foundAll.size });
      await clearRun();
      return;
    }

    // FAST MODE: sirf sponsored URLs nikalo, photo check (phase 2/3) skip
    if (CFG.skipPhotos) {
      await setSearchUltraLite(false);
      log(`New: ${urlsArray.length} | Already in cache (skipped): ${cacheStats.skipped}`);
      // original ki tarah: jo output ho gaya wo cache mein — agli run mein dobara nahi aayega
      if (CFG.useCache && urlsArray.length) {
        try { const k = await cacheFoundSoFar(urlsArray); log(`💾 Cache: +${k} naye | total ${await getCount()}`); } catch (e) { log('⚠️ Cache write failed: ' + e.message); }
      }
      await chrome.storage.local.set({
        lastResult: urlsArray.join('\n'),
        lastResultCount: urlsArray.length,
        lastResultAt: Date.now(),
        lastResultPartial: false,
        lastResultAll: [...foundAll].join('\n'),
        lastResultAllCount: foundAll.size
      });
      await clearRun();
      log(`✅ ${urlsArray.length} sponsored URLs ready — Download button dabao (photo check skip)`);
      const dl = dataLine();
      evt('info', 'RUN_DONE', 'Finished: ' + urlsArray.length + ' sponsored URLs found', { why: (blocked ? blocked + ' request(s) were blocked and skipped. ' : 'No blocked requests. ') + 'Cache skipped ' + cacheStats.skipped + '. Data ' + dl });
      log('📊 Data: ' + dl);
      await saveDataTotal();
      return;
    }

    // Search khatam: photo phase ka network environment bilkul pehle jaisa
    await setSearchUltraLite(false);

    // Phase 2: filter cache
    status('Filtering cache...');
    newUrls = [];
    for (let i = 0; i < urlsArray.length; i += 100) {
      const chunk   = urlsArray.slice(i, i + 100);
      const checked = await Promise.all(chunk.map(u => isScraped(u)));
      chunk.forEach((u, j) => { if (!checked[j]) newUrls.push(u); });
    }
    log(`New: ${newUrls.length} | Cached: ${urlsArray.length - newUrls.length}`);
    if (!newUrls.length) {
      log('All already cached.');
      // BUG FIX: pehle yahan result set nahi hota tha, is liye Results 0/0 dikhta tha
      await chrome.storage.local.set({
        lastResult: '', lastResultCount: 0, lastResultAt: Date.now(), lastResultPartial: false,
        lastResultAll: [...foundAll].join('\n'), lastResultAllCount: foundAll.size
      });
      await clearRun(); return;
    }

    startPhotoBatch = 0;
    businessesWithPhotos = [];
    manualReviewUrls = [];
    photoBlocked = 0;

    // ✅ CHECKPOINT — ab phase 3 se resume hoga
    await saveProgress({
      status: 'running', phase: 3, startSearchBatch: 0, startPhotoBatch: 0,
      allBusinessUrls, newUrls, businessesWithPhotos: [], manualReviewUrls: [],
      blocked, photoBlocked: 0, found: allBusinessUrls.size, active: 0
    });
  }

  // ── PHASE 3 ────────────────────────────────────────────────────────────────
  const photoTotalBatches = Math.ceil(newUrls.length / PHOTO_BATCH);

  for (let b = startPhotoBatch; b < photoTotalBatches; b++) {
    const batch = newUrls.slice(b * PHOTO_BATCH, (b + 1) * PHOTO_BATCH);

    const { hardStopped } = await runConcurrentGuarded(
      batch.map(url => async () => {
        // photo phase mein bhi bada random ms delay
        await sleep(CFG.humanMode ? humanDelayMs() : randInt(80, 400), 0);
        await domainReady;
        const bu = toDomain(url);
        const photosUrl = photoPageUrl(bu);
        let photoIpTry = 0;
        for (;;) {
          const ep = rotEpoch;
          const response = await fetchWithRetry(photosUrl, { headers: buildHeaders(bu), photoSafe: true });
          // PHOTO PHASE ONLY: a temporary network/proxy failure must never stop the
          // whole run or pin Resume to this same URL/batch. Leave it uncached so a
          // future run can check it again, and continue with the next business now.
          if (!response) {
            photoBlocked++;
            if (!manualReviewUrls.includes(url)) manualReviewUrls.push(toOutputDomain(url));
            log(`⚠️ Photo check unresolved → added to RESULT for manual review: ${url}`);
            return 'SKIP';
          }
          if (response.ok || response.status === 206) {
            const _ps = await readPhotoStream(response);
            const html = _ps.html;
            if (!_ps.cut && html.length < 40000 && isYelpBlocked(html)) {   // captcha/block page chhota hota hai; asli page bada
              lastErr = { status: 200, url: photosUrl, body: html.slice(0, 400), kind: 'nodata' };
              noteFail(lastErr);
              // DataDome aksar 403 nahi, HTTP 200 + captcha page deta hai. response.ok
              // true hota hai is liye fetchWithRetry rotate nahi karta. Yahan khud
              // naya IP le kar dobara try karo — baaki errors ki tarah.
              if (photoIpTry < 3 && (await autoRecover('photo challenge (200)', ep))) {
                photoIpTry++;
                log(`⚡ Photo challenge → naya IP (try ${photoIpTry}/3): ${url}`);
                continue;
              }
              // IP badal kar bhi na khula → manual review (pehle jaisa safety net)
              photoBlocked++;
              if (!manualReviewUrls.includes(url)) manualReviewUrls.push(toOutputDomain(url));
              log(`⚠️ Photo check unresolved/challenge → added to RESULT for manual review: ${url}`);
              return 'SKIP';
            }
            noteGood();
            if (_ps.recent) businessesWithPhotos.push(toOutputDomain(url));   // stream se mila jawab
            await saveBusiness(url); // sirf ASAL check hone par cache
          }
          return 'OK';
        }
      }),
      CFG.humanMode ? Math.min(CFG.humanConc || 4, CFG.photoConc || 3) : (CFG.photoConc || 3),
      (done, total) => status(`Photos ${b + 1}/${photoTotalBatches} | ${done}/${total} | Active: ${businessesWithPhotos.length}${photoBlocked ? ` | ⚠️${photoBlocked}` : ''}`),
      (consec) => status(`⛔ Photos: ${consec}/7 consecutive blocks...`)
    );

    if (hardStopped) {
      await saveProgress({
        status: 'blocked', phase: 3, startSearchBatch: 0, startPhotoBatch: b,
        allBusinessUrls, newUrls, businessesWithPhotos, manualReviewUrls,
        blocked, photoBlocked, found: allBusinessUrls.size, active: businessesWithPhotos.length
      });
      stopKeepalive();
      log(`⛔ 7 consecutive blocks — Photo Batch ${b + 1} mein ruka`);
      log(`✅ ${businessesWithPhotos.length} active businesses safe hain`);
      reportStop(3); if (CFG.humanMode) { await openSolveTab(); } else { log(`🔧 IP/VPN fix karo phir Resume dabao`); }
      log(`⛔ RUKA — ${lastErr ? (lastErr.status ? 'HTTP ' + lastErr.status : 'network: ' + lastErr.msg) : 'error'}`);
      toPopup({ action: 'blocked', found: allBusinessUrls.size, active: businessesWithPhotos.length, phase: 3, err: lastErr, info: explainErr(lastErr) });
      return;
    }

    // ✅ CHECKPOINT
    await saveProgress({
      status: 'running', phase: 3, startSearchBatch: 0, startPhotoBatch: b + 1,
      allBusinessUrls, newUrls, businessesWithPhotos, manualReviewUrls,
      blocked, photoBlocked, found: allBusinessUrls.size, active: businessesWithPhotos.length
    });

    log(`Photo Batch ${b + 1}/${photoTotalBatches} done | Active: ${businessesWithPhotos.length}`);
  }

  log(`Checked: ${newUrls.length} | Active: ${businessesWithPhotos.length}${photoBlocked ? ` | Blocked: ${photoBlocked}` : ''}`);
  if (photoCuts) log(`📉 ${photoCuts} photo pages jaldi kaati · ${photoFull} poori padhi · ~${(photoBytesSaved/1048576).toFixed(0)} MB bachi`);
  log(`Cache: ${await getCount()}`);

  await clearRun(); // clean finish

  const finalResultUrls = [...new Set([...(businessesWithPhotos || []), ...(manualReviewUrls || [])])];
  if (finalResultUrls.length > 0) {
    // Verified recent-photo URLs + photo-check failures/challenges. Failed ones are
    // intentionally NOT cached, but are included in Download URLs for manual review.
    const plainText = finalResultUrls.join('\n');
    await chrome.storage.local.set({
      lastResult: plainText,
      lastResultCount: finalResultUrls.length,
      lastResultAt: Date.now(),
      lastResultPartial: false,
      lastResultAll: [...foundAll].join('\n'),
      lastResultAllCount: foundAll.size,
      lastManualReview: (manualReviewUrls || []).join('\n'),
      lastManualReviewCount: (manualReviewUrls || []).length
    });
    log(`✅ ${finalResultUrls.length} result URLs ready (${businessesWithPhotos.length} recent + ${(manualReviewUrls || []).length} manual review) — Download button dabao`);
  } else {
    log('No result URLs found this run.');
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// PHOTO-ONLY RUN
// Seedha /biz/ URLs lo aur sirf photo check chalao (pichle 2 din ki photo).
// Logic bilkul wahi hai jo normal photo phase mein hai: wahi fetchWithRetry
// (instant IP rotation), wahi isYelpBlocked, wahi checkRecentPhotos, wahi
// manual-review fallback. Jo bhi business ASAL mein check ho jaye wo cache
// mein chala jata hai — chahe uski photo recent ho ya na ho.
// ═══════════════════════════════════════════════════════════════════════════
let photoOnlyRunning = false;

async function runPhotoOnly(rawUrls) {
  if (isScraping || photoOnlyRunning) { log('Pehle se kuch chal raha hai...'); return; }
  photoOnlyRunning = true;
  stopRequested = false;
  await cfgReady;

  // sirf /biz/ links, duplicate hata kar
  const urls = [...new Set((rawUrls || [])
    .map(s => String(s).trim())
    .filter(s => s && /\/biz\//.test(s))
    .map(s => s.split('?')[0].split('#')[0]))];

  if (!urls.length) {
    log('⚠️ Koi /biz/ link nahi mila. Business page ke links chahiye, search links nahi.');
    toPopup({ action: 'photoOnlyDone', checked: 0, active: 0, manual: 0, skipped: 0 });
    photoOnlyRunning = false;
    return;
  }

  // cache mein jo pehle se hain unhein chhod do
  let targets = urls, skipped = 0;
  if (CFG.useCache) {
    const keep = [];
    for (let i = 0; i < urls.length; i += 100) {
      const chunk = urls.slice(i, i + 100);
      const seen = await Promise.all(chunk.map(u => isScraped(u)));
      chunk.forEach((u, j) => { if (seen[j]) skipped++; else keep.push(u); });
    }
    targets = keep;
  }

  log(`📷 Photo-only: ${urls.length} links${skipped ? ` | ${skipped} pehle se cache mein` : ''} | check karne hain: ${targets.length}`);
  if (!targets.length) {
    log('Sab pehle se cache mein hain.');
    toPopup({ action: 'photoOnlyDone', checked: 0, active: 0, manual: 0, skipped });
    photoOnlyRunning = false;
    return;
  }

  initHumanLimit();
  await setLite(!!CFG.lite);
  if (CFG.humanMode) await ensureYelpTab(toDomain(targets[0]));

  const withPhotos = [];
  const manual = [];
  let photoBlocked = 0, done = 0;
  const PB = 50;
  const batches = Math.ceil(targets.length / PB);
  const startedAt = Date.now();
  toPopup({ action: 'photoOnlyProgress', done: 0, total: targets.length, recent: 0, manual: 0, blockedN: 0, rotations: dataStats.rotations, batch: 1, batches, startedAt });

  try {
    for (let b = 0; b < batches; b++) {
      if (stopRequested) break;
      const batch = targets.slice(b * PB, (b + 1) * PB);

      const { hardStopped } = await runConcurrentGuarded(
        batch.map(url => async () => {
          await sleep(CFG.humanMode ? humanDelayMs() : randInt(80, 400), 0);
          await domainReady;
          const bu = toDomain(url);
          const photosUrl = photoPageUrl(bu);
          let photoIpTry = 0;
          for (;;) {
            const ep = rotEpoch;
            const response = await fetchWithRetry(photosUrl, { headers: buildHeaders(bu), photoSafe: true });
            if (!response) {
              photoBlocked++;
              if (!manual.includes(url)) manual.push(url);
              log(`⚠️ Photo check unresolved → manual review: ${url}`);
              return 'SKIP';
            }
            if (response.ok || response.status === 206) {
              const _ps = await readPhotoStream(response);
              const html = _ps.html;
              if (!_ps.cut && html.length < 40000 && isYelpBlocked(html)) {
                lastErr = { status: 200, url: photosUrl, body: html.slice(0, 400), kind: 'nodata' };
                noteFail(lastErr);
                if (photoIpTry < 3 && (await autoRecover('photo challenge (200)', ep))) {
                  photoIpTry++;
                  log(`⚡ Photo challenge → naya IP (try ${photoIpTry}/3): ${url}`);
                  continue;
                }
                photoBlocked++;
                if (!manual.includes(url)) manual.push(url);
                log(`⚠️ Photo check unresolved/challenge → manual review: ${url}`);
                return 'SKIP';
              }
              noteGood();
              if (_ps.recent) withPhotos.push(toOutputDomain(url));   // stream se mila jawab
              await saveBusiness(url);   // ASAL check hua → CACHE mein
            }
            return 'OK';
          }
        }),
        CFG.humanMode ? Math.min(CFG.humanConc || 4, CFG.photoConc || 3) : (CFG.photoConc || 3),
        (d) => {
          const doneNow = b * PB + d;
          status(`📷 Photo check ${doneNow}/${targets.length} | Recent: ${withPhotos.length}${photoBlocked ? ` | ⚠️${photoBlocked}` : ''}`);
          toPopup({
            action: 'photoOnlyProgress',
            done: doneNow, total: targets.length,
            recent: withPhotos.length, manual: manual.length,
            blockedN: photoBlocked, rotations: dataStats.rotations,
            batch: b + 1, batches, startedAt: startedAt
          });
        },
        (consec) => toPopup({
          action: 'photoOnlyProgress',
          done: b * PB, total: targets.length,
          recent: withPhotos.length, manual: manual.length,
          blockedN: photoBlocked, rotations: dataStats.rotations,
          batch: b + 1, batches, startedAt: startedAt,
          warn: consec + '/7 consecutive blocks — rotating IPs...'
        })
      );

      done = Math.min((b + 1) * PB, targets.length);
      toPopup({ action: 'photoOnlyProgress', done, total: targets.length, recent: withPhotos.length, manual: manual.length, blockedN: photoBlocked, rotations: dataStats.rotations, batch: b + 1, batches, startedAt });
      if (hardStopped) { log('⛔ Lagatar blocks — photo-only ruk gaya. Baaki links dobara daal sakte ho.'); break; }
      log(`📷 Batch ${b + 1}/${batches} | Recent photos: ${withPhotos.length} | Cache: ${await getCount()}`);
    }
  } catch (e) {
    log(`⚠️ Photo-only error: ${e.message}`);
  }

  const resultList = withPhotos.concat(manual);
  await chrome.storage.local.set({
    bf_photo_only_result: resultList.join('\n'),
    bf_photo_only_count: withPhotos.length,
    bf_photo_only_manual: manual.length,
    bf_photo_only_at: Date.now()
  });

  log(`✅ Photo-only done — checked: ${done} | recent photos: ${withPhotos.length}${manual.length ? ` | manual review: ${manual.length}` : ''} | cache: ${await getCount()}`);
  status(`Photo check done — ${withPhotos.length} recent`);
  toPopup({ action: 'photoOnlyDone', checked: done, active: withPhotos.length, manual: manual.length, skipped });

  await setLite(false);
  photoOnlyRunning = false;
}

// ─── Start (fresh) ───────────────────────────────────────────────────────────
// permRef: agar permanent group hai to { collectionId, index } — complete hone par done mark

// ═══════════════════════════════════════════════════════════════════════════
// DATADOME PROBE
// Har combination par ek ASLI request bhejta hai aur dekhta hai ke sponsored
// ads bina tab / bina cookie bhi milte hain ya nahi. Scraping ko chhoota nahi.
// ═══════════════════════════════════════════════════════════════════════════
let probeRunning = false;

// service worker se SEEDHI fetch — koi tab nahi
async function probeDirect(url, withCookie) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
        'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin'
      },
      credentials: withCookie ? 'include' : 'omit',
      cache: 'no-store',
      signal: ctrl.signal
    });
    clearTimeout(tid);
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, ms: Date.now() - t0 };
  } catch (e) {
    clearTimeout(tid);
    return { status: 0, ok: false, text: '', why: (e && e.name === 'AbortError') ? 'timeout (20s)' : ('network: ' + String((e && e.message) || e).slice(0, 70)) };
  }
}

// Yelp tab ke andar se fetch
async function probeInTab(url, withCookie) {
  try {
    const tab = await ensureYelpTab(url);
    if (!tab) return { status: 0, ok: false, text: '', why: 'no-tab' };
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      args: [url, withCookie],
      func: async (u, wc) => {
        try {
          const r = await fetch(u, {
            headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
            credentials: wc ? 'include' : 'omit', cache: 'no-store'
          });
          const t = await r.text();
          return { status: r.status, ok: r.ok, text: t.slice(0, 400000) };
        } catch (e) { return { status: 0, ok: false, text: '', why: String(e && e.message) }; }
      }
    });
    return (out && out[0] && out[0].result) || { status: 0, ok: false, text: '', why: 'script-fail' };
  } catch (e) {
    return { status: 0, ok: false, text: '', why: 'tab-error' };
  }
}

// response mein sponsored ads gino
function probeCountAds(text) {
  if (!text) return { ads: 0, parsed: false };
  try {
    const j = JSON.parse(text);
    const n = extractSponsoredFromJson(j).length;
    return { ads: n, parsed: true };
  } catch (e) {
    // HTML page (poora /search?) — adredir links gino
    const m = text.match(/\/adredir\?[^"'\s]*redirect_url=/g);
    return { ads: m ? new Set(m).size : 0, parsed: false };
  }
}

function probeUrl(base, host, endpoint) {
  try {
    const x = new URL(base);
    x.hostname = host;
    if (endpoint === 'snippet') x.pathname = x.pathname.replace(/\/search\/?$/, '/search/snippet');
    else x.pathname = x.pathname.replace(/\/search\/snippet\/?$/, '/search');
    return x.toString();
  } catch (e) { return base; }
}

async function runProbe(baseUrl, bypass) {
  if (probeRunning || isScraping) return { ok: false, msg: 'Pehle se kuch chal raha hai' };
  probeRunning = true;
  await cfgReady;

  // bypass: proxy band kar ke apne net se test karo — taake pata chale ke
  // Yelp KHUD kya kehta hai, proxy ke masle se alag.
  let restoreProxy = false;
  if (bypass) {
    try { await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }); restoreProxy = true; } catch (e) {}
    await sleepMs(300);
  }

  const hosts = ['www.yelp.com', 'www.yelp.com.au', 'www.yelp.ca', 'www.yelp.co.uk'];
  const tests = [];
  for (const h of hosts) {
    for (const ep of ['snippet', 'search']) {
      tests.push({ host: h, ep, cookie: false, tab: false });   // sabse behtareen soorat
      if (ep === 'snippet') {
        tests.push({ host: h, ep, cookie: true,  tab: false }); // cookie chahiye par tab nahi
      }
    }
  }
  // maujooda tareeqa — muqable ke liye
  tests.push({ host: 'www.yelp.com.au', ep: 'snippet', cookie: true, tab: true });

  const proxyOn = !!(PROXY && PROXY.enabled);
  let done = 0;

  for (const t of tests) {
    if (!probeRunning) break;
    const u = probeUrl(baseUrl, t.host, t.ep);
    const r = t.tab ? await probeInTab(u, t.cookie) : await probeDirect(u, t.cookie);
    const blocked = r.ok && isYelpBlocked(r.text);
    const a = r.ok && !blocked ? probeCountAds(r.text) : { ads: 0 };

    done++;
    toPopup({
      action: 'probeRow', done, total: tests.length,
      row: {
        domain: t.host.replace('www.yelp', 'yelp'),
        endpoint: t.ep === 'snippet' ? '/search/snippet' : '/search',
        cookie: t.cookie, tab: t.tab, proxy: proxyOn,
        status: r.status,
        ok: !!(r.ok && !blocked),
        why: blocked ? 'DataDome challenge page' : (r.why || (r.status ? 'http ' + r.status : 'fail')),
        kb: (r.text || '').length / 1024,
        ads: a.ads
      }
    });
    await sleepMs(700 + Math.random() * 500);   // ehtiyat: ek saath na maaro
  }

  probeRunning = false;
  if (restoreProxy && CFG.directMode === false) { try { await applyProxy(); } catch (e) {} }
  toPopup({ action: 'probeDone' });
  return { ok: true };
}


// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN COMPARE
// Wahi search URLs do domains par chala kar dekho ke ads kitne milte hain.
// Maqsad: pata karna ke yelp.co.uk (jahan DataDome nahi) US shehron ke liye
// utne hi sponsored ads deta hai ya nahi.
// ═══════════════════════════════════════════════════════════════════════════
let cmpRunning = false;

async function runDomainCompare(urls, hosts) {
  if (cmpRunning || isScraping) return { ok: false, msg: 'Pehle se kuch chal raha hai' };
  cmpRunning = true;
  await cfgReady;

  const list = (urls || []).filter(Boolean).slice(0, 40);   // 40 kaafi hai
  const out = {};
  for (const h of hosts) out[h] = { ok: 0, fail: 0, ads: 0, kb: 0, pages: 0 };

  let done = 0;
  const total = list.length * hosts.length;

  for (const u of list) {
    for (const h of hosts) {
      if (!cmpRunning) break;
      let target;
      try { const x = new URL(u); x.hostname = h; x.pathname = x.pathname.replace(/\/search\/?$/, '/search/snippet'); target = x.toString(); }
      catch (e) { continue; }

      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 25000);
      let st = 0, txt = '';
      try {
        const res = await fetch(target, {
          headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'omit', cache: 'no-store', signal: ctrl.signal
        });
        clearTimeout(tid);
        st = res.status;
        if (res.ok) txt = await res.text();
      } catch (e) { clearTimeout(tid); }

      const s = out[h];
      if (st === 200 && txt && !isYelpBlocked(txt)) {
        let ads = 0;
        try { ads = extractSponsoredFromJson(JSON.parse(txt)).length; } catch (e) {}
        s.ok++; s.ads += ads; s.kb += txt.length / 1024; s.pages++;
      } else s.fail++;

      done++;
      toPopup({ action: 'cmpProgress', done, total, stats: out });
      await sleepMs(500 + Math.random() * 400);
    }
  }

  cmpRunning = false;
  toPopup({ action: 'cmpDone', stats: out, n: list.length });
  return { ok: true };
}


// ═══════════════════════════════════════════════════════════════════════════
// COOKIE PORTABILITY TEST
// Sawal: kya DataDome cookie jo PROXY IP par bani hai, wo GHAR ke IP se
// chalti hai? Agar haan — to proxy sirf cookie banane ke liye chahiye aur
// saari bhari requests apne net se ja sakti hain. GB ka masla khatam.
// ═══════════════════════════════════════════════════════════════════════════
let portRunning = false;

async function ddSetProxy(on) {
  try {
    if (on) await applyProxy();
    else await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' });
  } catch (e) {}
  await sleepMs(350);
}

async function ddCurrentIp() {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12000) });
    return (await r.json()).ip;
  } catch (e) { return '?'; }
}

async function ddGetCookie(host) {
  try {
    const all = await chrome.cookies.getAll({ domain: host.replace(/^www\./, '') });
    const c = all.find(x => x.name === 'datadome');
    return c ? c.value : '';
  } catch (e) { return ''; }
}

async function ddClearCookies(host) {
  try {
    await chrome.browsingData.remove({ origins: ['https://' + host] }, { cookies: true, cacheStorage: true });
  } catch (e) {}
}

// tab kholo, DataDome cookie banne do, tab BAND kar do
async function ddMintCookie(sampleUrl, host) {
  let tabId = null;
  try {
    const t = await chrome.tabs.create({ url: 'https://' + host + '/', active: false });
    tabId = t.id;
    await waitTabComplete(tabId, 25000);
    // cookie aane ka intezar
    for (let i = 0; i < 30; i++) {
      const c = await ddGetCookie(host);
      if (c) break;
      await sleepMs(250);
    }
    await sleepMs(400);
    const cookie = await ddGetCookie(host);
    return cookie;
  } catch (e) { return ''; }
  finally {
    if (tabId) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
  }
}

async function ddFetch(url) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include', cache: 'no-store', signal: ctrl.signal
    });
    clearTimeout(tid);
    const txt = res.ok ? await res.text() : '';
    let ads = 0, uniq = [];
    if (txt) { try { uniq = extractSponsoredFromJson(JSON.parse(txt)); ads = uniq.length; } catch (e) {} }
    return { status: res.status, ok: res.ok && !!txt && !isYelpBlocked(txt), ads, uniq, kb: txt.length / 1024 };
  } catch (e) {
    clearTimeout(tid);
    return { status: 0, ok: false, ads: 0, kb: 0, why: (e && e.name === 'AbortError') ? 'timeout' : 'network' };
  }
}

function ddSnippet(u, host) {
  try { const x = new URL(u); x.hostname = host; x.pathname = x.pathname.replace(/\/search\/?$/, '/search/snippet'); return x.toString(); }
  catch (e) { return u; }
}

async function runPortability(baseUrl, host, nReqs) {
  if (portRunning || isScraping) return { ok: false, msg: 'Pehle se kuch chal raha hai' };
  portRunning = true;
  await cfgReady;
  const N = Math.max(3, Math.min(40, parseInt(nReqs, 10) || 15));
  const say = (k, v) => toPopup({ action: 'portStep', step: k, data: v });

  try {
    // ── 0. saaf shuruaat
    await ddClearCookies(host);
    say('clear', { msg: 'Cookies saaf' });

    // ── 1. PROXY par jao, IP note karo, cookie banao
    await ddSetProxy(true);
    const proxyIp = await ddCurrentIp();
    say('proxyip', { ip: proxyIp });

    const cookie = await ddMintCookie(baseUrl, host);
    say('mint', { got: !!cookie, len: cookie.length, ip: proxyIp });
    if (!cookie) {
      say('fail', { msg: 'DataDome cookie nahi mili — proxy ya tab ka masla' });
      portRunning = false; toPopup({ action: 'portDone' }); return { ok: true };
    }

    // ── 2. PROXY par requests (baseline)
    let a = { ok: 0, fail: 0, ads: 0, kb: 0 };
    for (let i = 0; i < N; i++) {
      const r = await ddFetch(ddSnippet(baseUrl, host));
      if (r.ok) { a.ok++; a.ads += r.ads; a.kb += r.kb; } else a.fail++;
      say('proxyreq', { i: i + 1, n: N, s: a });
      await sleepMs(350);
    }

    // ── 3. GHAR ke IP par switch — WAHI cookie
    await ddSetProxy(false);
    const homeIp = await ddCurrentIp();
    say('homeip', { ip: homeIp, same: homeIp === proxyIp });

    let b = { ok: 0, fail: 0, ads: 0, kb: 0, firstFail: 0, uniq: 0 };
    const uset = new Set();
    for (let i = 0; i < N; i++) {
      const r = await ddFetch(ddSnippet(baseUrl, host));
      if (r.ok) { b.ok++; b.ads += r.ads; b.kb += r.kb; (r.uniq || []).forEach(u => uset.add(u)); b.uniq = uset.size; }
      else { b.fail++; if (!b.firstFail) b.firstFail = i + 1; }
      say('homereq', { i: i + 1, n: N, s: b });
      await sleepMs(350);
    }

    toPopup({ action: 'portResult', proxyIp, homeIp, proxy: a, home: b, n: N, host });
  } catch (e) {
    say('fail', { msg: String(e && e.message) });
  } finally {
    // direct mode mein proxy ON mat chhodo — warna agli run saari fail hogi
    if (CFG.directMode !== false) { PROXY.enabled = false; await ddSetProxy(false); }
    else await ddSetProxy(true);
    portRunning = false;
    toPopup({ action: 'portDone' });
  }
  return { ok: true };
}


// ═══════════════════════════════════════════════════════════════════════════
// DATADOME API COOKIE TEST  (datadome-bp repo ka tareeqa)
// api-js.datadome.co se seedha cookie mangna, phir dekhna ke Yelp us cookie
// ko qubool karta hai ya nahi. Agar chal gaya: na tab, na proxy-for-cookie.
// ═══════════════════════════════════════════════════════════════════════════
let ddApiRunning = false;

// Yelp ke page se DataDome ki client key (ddjskey) nikalo — ye public hoti hai
async function ddFindKey(host) {
  const tries = ['https://' + host + '/', 'https://' + host + '/search?find_desc=plumbers&find_loc=London'];
  for (const u of tries) {
    try {
      const r = await fetch(u, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000) });
      const t = await r.text();
      // mukhtalif shaklein jinme key milti hai
      const pats = [
        /ddjskey['"]?\s*[:=]\s*['"]([A-Z0-9]{20,})['"]/i,
        /['"]key['"]\s*:\s*['"]([A-Z0-9]{32})['"]/,
        /datadome[^<]{0,400}?['"]([A-Z0-9]{32})['"]/i,
        /ddjskey=([A-Z0-9]{20,})/i
      ];
      for (const p of pats) {
        const m = p.exec(t);
        if (m && m[1]) return { key: m[1], from: u, status: r.status };
      }
      // DataDome script tag mila par key nahi
      if (/datadome/i.test(t)) return { key: '', from: u, status: r.status, saw: true };
    } catch (e) {}
  }
  return { key: '', from: '', status: 0 };
}

async function ddApiMint(targetOrigin, ddv, uaStr, key) {
  const randIP = [0,0,0,0].map(() => Math.floor(Math.random() * 256)).join('.');
  const p = {
    ddv: ddv || '4.6.0',
    jsData: JSON.stringify({ jset: Math.floor(1000000000 + Math.random() * 9000000000) })
  };
  if (key) { p.ddk = key; p.key = key; }           // API ab client key maangta hai
  p.Referer = targetOrigin + '/';
  p.request = '/';
  p.responsePage = 'origin';
  const body = new URLSearchParams(p);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('https://api-js.datadome.co/js/', {
      method: 'POST',
      headers: {
        'x-forwarded-for': randIP,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': targetOrigin,
        'Referer': targetOrigin + '/'
      },
      body: body.toString(),
      credentials: 'omit',
      signal: ctrl.signal
    });
    clearTimeout(tid);
    const text = await res.text();
    // repo ka tareeqa: substring(24, len-2)
    let raw = '', value = '';
    try {
      raw = text.substring(24, text.length - 2);
      value = raw.split(';')[0].split('=')[1] || '';
    } catch (e) {}
    // behtar tareeqa: JSON parse karke cookie field dhoondo
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) {}
    if (parsed && parsed.cookie) {
      raw = parsed.cookie;
      const m = /datadome=([^;]+)/.exec(raw);
      if (m) value = m[1];
    }
    return { status: res.status, ok: res.ok, raw, value, body: text.slice(0, 500) };
  } catch (e) {
    clearTimeout(tid);
    return { status: 0, ok: false, raw: '', value: '', why: String((e && e.message) || e).slice(0, 80) };
  }
}

async function runDdApiTest(host, sampleUrl) {
  if (ddApiRunning || isScraping) return { ok: false, msg: 'Pehle se kuch chal raha hai' };
  ddApiRunning = true;
  const say = (k, d) => toPopup({ action: 'ddApiStep', step: k, data: d || {} });

  try {
    const origin = 'https://' + host;

    // 1. purani cookie hatao
    try { await chrome.browsingData.remove({ origins: [origin] }, { cookies: true }); } catch (e) {}
    say('clear', {});

    // 1b. Yelp ke page se DataDome client key nikalo
    const fk = await ddFindKey(host);
    say('key', { key: fk.key ? fk.key.slice(0, 8) + '…' : '', full: fk.key, saw: !!fk.saw, status: fk.status });

    // 2. API se cookie mangne ki koshish — do versions
    let mint = null;
    for (const ddv of ['4.6.0', '4.35.0']) {
      const m = await ddApiMint(origin, ddv, '', fk.key);
      say('mint', { ddv, status: m.status, got: !!m.value, len: (m.value || '').length, body: m.body, why: m.why });
      if (m.value && m.value.length > 20) { mint = m; break; }
      await sleepMs(500);
    }

    if (!mint) {
      say('verdict', { kind: 'nocookie' });
      ddApiRunning = false; toPopup({ action: 'ddApiDone' }); return { ok: true };
    }

    // 3. cookie browser mein set karo
    let set = false;
    try {
      await chrome.cookies.set({
        url: origin + '/',
        name: 'datadome',
        value: mint.value,
        domain: '.' + host.replace(/^www\./, ''),
        path: '/',
        secure: true,
        sameSite: 'lax',
        expirationDate: Math.floor(Date.now() / 1000) + 3600
      });
      set = true;
    } catch (e) { say('setfail', { why: String(e && e.message) }); }
    say('set', { ok: set });

    // 4. us cookie se asli Yelp request
    let url = sampleUrl;
    try { const x = new URL(sampleUrl); x.hostname = host; x.pathname = x.pathname.replace(/\/search\/?$/, '/search/snippet'); url = x.toString(); } catch (e) {}

    let ok = 0, fail = 0, ads = 0, lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const r = await ddFetch(url);
      lastStatus = r.status;
      if (r.ok) { ok++; ads += r.ads; } else fail++;
      say('req', { i: i + 1, ok, fail, status: r.status, ads });
      await sleepMs(600);
    }

    say('verdict', { kind: ok >= 4 ? 'works' : (ok > 0 ? 'partial' : 'rejected'), ok, fail, ads, lastStatus });
  } catch (e) {
    say('verdict', { kind: 'error', why: String(e && e.message) });
  } finally {
    ddApiRunning = false;
    toPopup({ action: 'ddApiDone' });
  }
  return { ok: true };
}


// ═══════════════════════════════════════════════════════════════════════════
// HYBRID: GHAR PEHLE, PROXY SIRF BACHAO KE LIYE
//
// Ghar ka IP = asal kaam, GB muft.
// 403/429/503 aaye to pehle GHAR par hi dheema ho kar try karo (GB zero).
// Jab ghar sach mein band ho jaye, tabhi proxy on — aur usi waqt tak.
// Har RECHECK_MS baad ghar ko 1 request se test karo; khul jaye to wapas ghar.
// ═══════════════════════════════════════════════════════════════════════════
const Hybrid = {
  onProxy:        false,
  useCookie:      false,   // cookie rescue ke baad on ho jata hai
  cookieTries:    0,       // kitni baar cookie banayi
  COOKIE_MAX:     200,    // 40k links ke liye kaafi      // 40k links ke liye kaafi — cookie bas-ti rehti hai
  cookieAt:       0,       // aakhri cookie kab bani
  COOKIE_MIN_GAP: 15000,  // do cookie ke beech 15s   // do cookie ke beech kam se kam 20s
  homeBlocks:     0,       // ghar par lagataar blocks
  HOME_TRIES:     6,       // itne blocks tak ghar par hi dheema ho kar try karo
  backoff:        0,       // ghar ka maujooda intezar (ms)
  BACKOFF_START:  4000,
  BACKOFF_MAX:    90000,
  RECHECK_MS:     120000,  // proxy par hote hue har 2 min ghar test karo
  lastHomeCheck:  0,
  proxySince:     0,
  proxyMs:        0,       // kul kitni der proxy par rahe
  switches:       0,
  checking:       false,

  async toProxy(why) {
    if (this.onProxy) return;
    this.onProxy = true;
    this.proxySince = Date.now();
    this.switches++;
    PROXY.enabled = true;
    try { await applyProxy(); } catch (e) {}
    await sleepMs(200);
    log(`🔁 Ghar ka IP band (${why}) — proxy ON. Ab se GB lagegi.`);
    toPopup({ action: 'hybrid', onProxy: true, switches: this.switches });
  },

  async toHome(why) {
    if (!this.onProxy) return;
    this.onProxy = false;
    this.proxyMs += Date.now() - this.proxySince;
    PROXY.enabled = false;
    try { await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }); } catch (e) {}
    await sleepMs(200);
    this.homeBlocks = 0;
    this.backoff = 0;
    log(`🏠 Ghar ka IP wapas chal gaya (${why}) — proxy OFF, GB bachni shuru.`);
    toPopup({ action: 'hybrid', onProxy: false, switches: this.switches });
  },

  // ghar ka IP khul gaya? 1 request, proxy ke bagair
  async homeAlive(sampleUrl) {
    if (this.checking) return false;
    this.checking = true;
    const wasProxy = PROXY.enabled;
    try {
      PROXY.enabled = false;
      try { await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }); } catch (e) {}
      await sleepMs(250);
      const r = await fetch(sampleUrl, {
        headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000)
      });
      const txt = r.ok ? await r.text() : '';
      const good = r.ok && !!txt && !isYelpBlocked(txt);
      if (!good && wasProxy) { PROXY.enabled = true; try { await applyProxy(); } catch (e) {} await sleepMs(200); }
      return good;
    } catch (e) {
      if (wasProxy) { PROXY.enabled = true; try { await applyProxy(); } catch (e2) {} await sleepMs(200); }
      return false;
    } finally { this.checking = false; }
  },

  // GHAR ke IP par tab khol kar taazi DataDome cookie lo, phir tab band.
  // Page load ghar ke net se hota hai — PROXY GB ZERO.
  async mintHomeCookie(host) {
    const now = Date.now();
    if (now - this.cookieAt < this.COOKIE_MIN_GAP) return false;
    if (this.cookieTries >= this.COOKIE_MAX) return false;
    this.cookieTries++;
    this.cookieAt = now;

    const wasProxy = PROXY.enabled;
    let tabId = null;
    let pxWas = false;          // BUG FIX: pehle ye try ke ANDAR tha aur finally
                                // mein use ho raha tha — scope error, proxy kabhi
                                // wapas restore nahi hota tha.
    try {
      // cookie GHAR ke IP par bane — proxy band
      if (wasProxy) {
        PROXY.enabled = false;
        try { await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }); } catch (e) {}
        await sleepMs(250);
      }
      // Cookie ka tab HAMESHA direct/VPN se khule — proxy se nahi. Proxy kharab
      // ho to cookie bhi nahi banti aur run bekaar mein ruk jati hai.
      try { pxWas = !!(PX && PX.cfg && PX.cfg.enabled); if (pxWas) await PX.off(); } catch (e) {}
      log(`🍪 Taazi DataDome cookie le raha hoon — tab khul raha hai (${this.cookieTries}/${this.COOKIE_MAX}, direct/VPN se)`);
      try { await chrome.browsingData.remove({ origins: ['https://' + host] }, { cookies: true }); } catch (e) {}

      const t = await chrome.tabs.create({ url: 'https://' + host + '/', active: false });
      tabId = t.id;
      await waitTabComplete(tabId, 25000);
      let cookie = '';
      for (let i = 0; i < 40; i++) {
        try {
          const all = await chrome.cookies.getAll({ domain: host.replace(/^www\./, '') });
          const c = all.find(x => x.name === 'datadome');
          if (c && c.value) { cookie = c.value; break; }
        } catch (e) {}
        await sleepMs(250);
      }
      if (cookie) {
        this.useCookie = true;
        log(`🍪 Cookie mil gayi (${cookie.length} chars) — tab band, ab requests cookie ke saath`);
        toPopup({ action: 'hybrid', cookie: true });
        return true;
      }
      // ─── DIAGNOSE ─────────────────────────────────────────────────────
      // Cookie nahi mili — ab andaza lagane ke bajaye tab se poocho ke hua kya.
      let diag = '';
      try {
        const tb = await chrome.tabs.get(tabId);
        diag += `tab: ${tb.status} | url: ${String(tb.url || '').slice(0, 70)}`;
      } catch (e) { diag += 'tab padha nahi gaya'; }
      try {
        const all = await chrome.cookies.getAll({ domain: host.replace(/^www\./, '') });
        diag += ` | cookies (${all.length}): ${all.map(c => c.name).slice(0, 8).join(', ') || 'koi nahi'}`;
      } catch (e) { diag += ' | cookies padhi nahi gayin'; }
      try {
        const o = await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN',
          func: () => ({ t: document.title.slice(0, 60), len: document.body ? document.body.innerText.length : 0,
                         dd: /captcha-delivery|datadome|unusual activity|blocked/i.test(document.body ? document.body.innerText : '') })
        });
        const d = o && o[0] && o[0].result;
        if (d) diag += ` | title: "${d.t}" | text: ${d.len} chars${d.dd ? ' | ⚠️ CHALLENGE PAGE' : ''}`;
      } catch (e) {}
      log(`🍪 Cookie nahi mili — ${diag}`);
      return false;
    } catch (e) {
      log(`🍪 Cookie lene mein error: ${(e && e.message) || e}`);
      return false;
    } finally {
      if (tabId) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
      try { if (pxWas) await PX.apply(); } catch (e) {}   // proxy wapas jaisa tha
      if (wasProxy) { PROXY.enabled = true; try { await applyProxy(); } catch (e) {} await sleepMs(200); }
    }
  },

  // block aaya — kya karna hai
  async onBlock(sampleUrl, status) {
    if (!this.onProxy) {
      this.homeBlocks++;
      this.backoff = this.backoff ? Math.min(this.BACKOFF_MAX, Math.round(this.backoff * 1.8)) : this.BACKOFF_START;
      if (this.homeBlocks < this.HOME_TRIES) {
        // QADAM 1: GHAR PAR HI RUKO — GB zero
        log(`⏸️ ${status} — ghar par ${Math.round(this.backoff / 1000)}s ruk kar dobara (${this.homeBlocks}/${this.HOME_TRIES}, GB zero)`);
        await sleepMs(this.backoff);
        return;
      }
      // QADAM 2: taazi DataDome cookie — tab ghar ke net par khulta hai, PROXY GB ZERO
      if (CFG.cookieRescue !== false) {
        let host = 'www.yelp.co.uk';
        try { host = new URL(sampleUrl).hostname; } catch (e) {}
        if (await this.mintHomeCookie(host)) {
          this.homeBlocks = 0;
          this.backoff = 0;
          await sleepMs(1500);
          return;                       // cookie mil gayi — ghar par hi rehte hain
        }
      }
      // QADAM 3: ghar sach mein band — ab proxy (yahan GB lagegi)
      if (CFG.proxyRescue !== false) await this.toProxy(status);
      else { log(`⏸️ ${status} — proxy rescue band hai, ghar par hi ${Math.round(this.BACKOFF_MAX / 1000)}s ruk rahe hain`); await sleepMs(this.BACKOFF_MAX); }
      return;
    }
    // proxy par hain aur phir bhi block — naya proxy IP
    await rotateIp('proxy ' + status);
  },

  // proxy par hain to waqtan waqtan ghar check karo
  async maybeGoHome(sampleUrl) {
    if (!this.onProxy) return;
    const now = Date.now();
    if (now - this.lastHomeCheck < this.RECHECK_MS) return;
    this.lastHomeCheck = now;
    if (await this.homeAlive(sampleUrl)) await this.toHome('recheck');
  },

  stats() {
    const ms = this.proxyMs + (this.onProxy ? Date.now() - this.proxySince : 0);
    return { onProxy: this.onProxy, switches: this.switches, proxyMin: ms / 60000, homeBlocks: this.homeBlocks, cookie: this.useCookie, cookieTries: this.cookieTries };
  },

  reset() {
    this.onProxy = false; this.homeBlocks = 0; this.backoff = 0;
    this.lastHomeCheck = 0; this.proxySince = 0; this.proxyMs = 0; this.switches = 0;
    this.useCookie = false; this.cookieTries = 0; this.cookieAt = 0;
  }
};


// ═══════════════════════════════════════════════════════════════════════════
// SIMPLE MODE — portability test ka hubahu tareeqa
// Wahi jisse 15/15 chala aur 71 ads mile. Koi Throttle nahi, koi Hybrid nahi,
// koi retry nahi, koi hardStop nahi. Bas: ek request, ruko, agli request.
// Fail ho to gino aur aage badho — run kabhi nahi rukti.
// ═══════════════════════════════════════════════════════════════════════════
const simpleSpeed = { conc: 1, gap: 350 };

async function simpleFetch(url) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include', cache: 'no-store', signal: ctrl.signal
    });
    clearTimeout(tid);
    const txt = res.ok ? await res.text() : '';
    const blocked = !!txt && isYelpBlocked(txt);
    let ads = [], parseOk = false;
    if (txt && !blocked) {
      try {
        const j = JSON.parse(txt);
        ads = extractSponsoredFromJson(j);
        parseOk = true;
      } catch (e) {
        // A successful HTTP response that is not valid snippet JSON must NOT be marked done.
        // Keep a raw adredir fallback only for diagnostics/coverage, but parseOk stays false.
        ads = extractSponsored(txt);
      }
    }
    try { dataStats.reqCount++; dataStats.reqBytes += new Blob([txt]).size; } catch (e) {}
    return { status: res.status, ok: res.ok && !!txt && !blocked && parseOk, parseOk, blocked, ads, kb: txt.length / 1024 };
  } catch (e) {
    clearTimeout(tid);
    return { status: 0, ok: false, parseOk: false, blocked: false, ads: [], kb: 0, why: (e && e.name === 'AbortError') ? 'timeout' : 'network' };
  }
}

// Phase 1 ka saada runner. conc = 1 to bilkul portability test jaisa.
async function runSimplePhase1(searchUrls, offset, allBusinessUrls, seenKeys, cacheKeys, onProgress) {
  // VPN/direct mode: keep the same one-request-per-URL pressure profile as v2.5.1.
  // Completeness comes from broader parsing + retrying only failed/invalid responses.
  // ─── 503 SE BACHAV ────────────────────────────────────────────────────
  // 503 ka matlab: Yelp ko ek saath bohot zyada requests ja rahi hain.
  // Retry se wo handle hota hai, aana band nahi hota. Asal ilaaj concurrency
  // hai. Is liye ab wo FIXED nahi — 503 aate hi girti hai, aur sab theek chale
  // to dheere dheere wapas chadhti hai. Yelp ki asli hadd khud mil jati hai.
  // FIXED concurrency — adaptive band. Kam aur sthir rakho.
  const CONC_MAX = Math.max(1, parseInt(CFG.simpleConc, 10) || 15);
  const CONC_MIN = CONC_MAX;
  let CONC = CONC_MAX;
  let conc503 = 0, okStreak503 = 0, coolUntil = 0;

  // concurrency fixed hai — ab sirf 503 par thoda saans, concurrency nahi girti
  const on503 = () => { coolUntil = Date.now() + 10000; };
  const onOk503 = () => {};

  const GAP = Math.max(0, parseInt(CFG.simpleGapMs, 10) || 350);
  const MAX_RETRIES = 3;          // only for failures; successful URLs are NOT re-fetched
  const list = searchUrls.slice(offset);
  let next = 0, okN = 0, failN = 0;
  let halted = false;
  const completed = new Set();
  let contiguous = 0;
  const codes = {};
  simpleSpeed.conc = CONC; simpleSpeed.gap = GAP;
  const liveSpeed = () => { simpleSpeed.conc = CONC; };

  log(`⚡ ${list.length} links | concurrency ${CONC} (fixed) | har ${CFG.rotateEveryN || 45} requests par naya IP`);

  // ─── COOKIE KI UMAR ───────────────────────────────────────────────────
  // sinceCookie = aakhri cookie ke baad kitne URLs chale. 403 par ye number
  // log hota hai — ek run ke baad pata chal jayega ke cookie kitni der chalti hai.
  // cookieEveryN (Settings) > 0 ho to utne URLs ke baad PEHLE HI nayi cookie.
  let sinceCookie = 0;
  const cookieLives = [];
  const EVERY_N = Math.max(0, parseInt(CFG.cookieEveryN, 10) || 0);

  const noteCookie = (why) => {
    cookieLives.push(sinceCookie);
    log(`📏 Cookie ${sinceCookie} URLs chali (${why})`);
    sinceCookie = 0;
  };

  const markDone = (localIndex) => {
    completed.add(localIndex);
    while (completed.has(contiguous)) contiguous++;
    if (onProgress) onProgress(contiguous, list.length, okN, failN);
  };

  const addAds = (ads) => {
    for (const u of (ads || [])) {
      const k = bizKey(u);
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      foundAll.add(u);
      if (cacheKeys && cacheKeys.has(k)) { cacheStats.skipped++; continue; }
      allBusinessUrls.add(u);
    }
  };

  async function fetchWithRetry(snippetUrl) {
    let last = null;
    let cookieFix = 0, ipTries = 0, serverWait = 0, netWait = 0, lastDitch = 0;
    const MAX_COOKIE_FIX = Math.max(1, parseInt(CFG.cookieFixPerUrl, 10) || 2);
    const MAX_IP_TRIES   = Math.max(1, parseInt(CFG.ipTriesPerUrl, 10) || 4);
    for (let attempt = 1; attempt <= MAX_RETRIES && !stopRequested && !halted; attempt++) {
      const r = await simpleFetch(snippetUrl);
      last = r;
      if (r.ok) return r;

      const st = r.status || 0;
      codes[st] = (codes[st] || 0) + 1;

      if (st === 403 || r.blocked) {
        // ─── COOKIE RESCUE ───────────────────────────────────────────────
        // Pehle yahan run foran ruk jati thi. Ab: tab khol kar TAAZI DataDome
        // cookie lo (yelp.co.uk, background tab, phir band), aur WAHI URL dobara.
        // Cookie Chrome ki jar mein rehti hai, simpleFetch pehle se
        // credentials:'include' bhejta hai — to agli requests khud-ba-khud
        // us cookie ke saath jayengi.
        if (CFG.cookieRescue !== false && cookieFix < MAX_COOKIE_FIX) {
          cookieFix++;
          let hh = 'www.yelp.co.uk';
          try { hh = new URL(snippetUrl).hostname; } catch (e) {}
          log(`🍪 HTTP ${st || 403} — taazi cookie le kar wahi URL dobara (${cookieFix}/${MAX_COOKIE_FIX})`);
          const got = await Hybrid.mintHomeCookie(hh);
          if (got) {
            noteCookie('403 par');
            await sleepMs(1200);
            attempt--;              // ye koshish ginti mein nahi — cookie ab nayi hai
            continue;
          }
          log(`🍪 Cookie nahi mili — lekin naya IP le kar dobara koshish kar raha hoon`);
          // cookie na mile to bhi haar mat maano: proxy ON ho to naya IP,
          // warna thodi der ruk kar wahi URL dobara.
          if (PX.cfg.enabled && ipTries < MAX_IP_TRIES) {
            ipTries++;
            await PX.next('403 + cookie fail');
            await sleepMs(800);
            attempt--;
            continue;
          }
          if (cookieFix < MAX_COOKIE_FIX) { await sleepMs(6000); attempt--; continue; }
        }
        halted = true;
        lastErr = { status: st || 403, url: snippetUrl, body: '', kind: 'blocked' };
        log(`⛔ HTTP ${st || 403}/block — current URL pending hai; session normal karke Resume.`);
        return null;
      }

      // ─── KOI BHI ERROR → FORAN PAUSE ────────────────────────────────
      // Pehle yahan 3 retries chalti thin (429 par 45 second zaya). Ab run
      // foran ruk jati hai, poori wajah ke saath. Tum Yelp theek karke Resume
      // dabao — bilkul isi URL se chalegi, kuch chhootega nahi.
      // ─── AUTO IP SWITCH ──────────────────────────────────────────────
      // Har port ek alag exit IP deta hai. Error aaya to agla port lo aur
      // WAHI URL dobara. Rukna sirf tab jab ipTries naye IP bhi fail ho jayein.
      // 5xx = YELP ka server dabaav mein. Tumhara IP theek hai — naya IP lena
      // bekaar hai (waqt + GB zaya). Bas ruko aur wahi IP se dobara.
      // ─── 5xx ──────────────────────────────────────────────────────────
      // PROXY ON: 503 Yelp ka NAHI, PROXY ka hai. Residential exit node
      // (kisi ka asli device) offline ho gaya. Intezar bekaar hai — wo node
      // wapas nahi aayega. FORAN agla port = naya exit node.
      // PROXY OFF: tab wo sach mein Yelp ka server hai — tab ruko.
      if (st === 503 || st === 502 || st === 504) {
        if (PX.cfg.enabled) {
          PX.badStreak++;
          if (PX.badStreak >= 6 && await PX.healthCheck()) { /* theek ho gaya */ }
          if (ipTries < MAX_IP_TRIES) {
            ipTries++;
            log(`🔀 HTTP ${st} — mara hua exit node, foran naya IP (${ipTries}/${MAX_IP_TRIES})`);
            AutoReload.dead();
            await PX.next('dead node ' + st);
            await sleepMs(300);
            attempt--;
            continue;
          }
        } else if (serverWait < 5) {
          serverWait++;
          on503();
          const w = 8000 * serverWait;
          log(`↻ HTTP ${st} — Yelp ka server busy. ${w/1000}s ruk kar dobara (${serverWait}/5)`);
          await sleepMs(w);
          attempt--;
          continue;
        }
      }

      // network/0 = request nikli hi nahi. Proxy OFF ho to ye VPN/net ka masla
      // hai — naya IP se kuch nahi hoga. Thodi der ruk kar dobara.
      // network/0 = request nikli hi nahi.
      // PEHLE: thodi der ruk kar wahi IP se dobara (3 baar).
      // PHIR: proxy ON ho to naya IP (shayad wo port mar gaya hai).
      await PX.gate();                     // switch ke dauran ka network error gina na jaye
      if (st === 0) {
        // Proxy ON: network fail = exit node mar gaya → naya IP, intezar nahi
        if (PX.cfg.enabled && ipTries < MAX_IP_TRIES) {
          PX.badStreak++;
          if (PX.badStreak >= 6) await PX.healthCheck();
          ipTries++;
          log(`🔀 network — mara hua exit node, foran naya IP (${ipTries}/${MAX_IP_TRIES})`);
          AutoReload.dead();
          await PX.next('dead node net');
          await sleepMs(300);
          attempt--;
          continue;
        }
        if (!PX.cfg.enabled && netWait < 3) {
          netWait++;
          log(`↻ network — ${5 * netWait}s ruk kar wahi URL dobara (${netWait}/3)`);
          await sleepMs(5000 * netWait);
          attempt--;
          continue;
        }
      }

      // IP switch: 403, 429, ya network (jab wait bhi na chala)
      const ipWorthy = (st === 403 || st === 429 || st === 0 || st === 503 || st === 502 || st === 504);
      if (PX.cfg.enabled && ipWorthy && ipTries < MAX_IP_TRIES) {
        ipTries++;
        const lbl = 'HTTP ' + st;
        log(`🔀 ${lbl} — naya IP le kar wahi URL dobara (${ipTries}/${MAX_IP_TRIES})`);
        await PX.next(lbl);
        if (st === 403 && CFG.cookieRescue !== false) {
          let hh = 'www.yelp.co.uk';
          try { hh = new URL(snippetUrl).hostname; } catch (e) {}
          await Hybrid.mintHomeCookie(hh);   // naya IP + taazi cookie
        }
        await sleepMs(600);
        attempt--;                            // ye koshish ginti mein nahi
        continue;
      }

      // AAKHRI CHARA SE PEHLE: ek lamba intezar aur ek aakhri koshish.
      // Run rokna sach mein aakhri cheez honi chahiye.
      if (lastDitch < 2) {
        lastDitch++;
        const w = 30000 * lastDitch;
        log(`⏳ Sab koshishein khatam — ${w/1000}s ruk kar aakhri koshish (${lastDitch}/2)`);
        await sleepMs(w);
        if (PX.cfg.enabled) await PX.next('aakhri koshish');
        ipTries = 0; netWait = 0; serverWait = 0; cookieFix = 0;
        attempt--;
        continue;
      }

      if (CFG.pauseOnAnyError !== false) {
        halted = true;
        const why = st === 429 ? 'rate limit (bohot tezi) — thodi der ruk kar Resume'
                  : st === 200 ? 'Yelp ne JSON ki jagah kuch aur bheja (aksar challenge page)'
                  : st >= 500  ? 'Yelp ka server dabaav mein'
                  : st === 0   ? 'request Yelp tak pahunchi hi nahi (net/VPN)'
                  : 'Yelp ne roka';
        lastErr = { status: st, url: snippetUrl, body: '', kind: 'paused', msg: (last && last.why) || why };
        log(`⏸️ RUK GAYA — HTTP ${st || 'network'} : ${why}`);
        if (PX.cfg.enabled) log(`   ${ipTries} naye IP bhi fail — ab tumhari zaroorat hai.`);
        log(`   Yelp tab mein jaa kar theek karo, phir Resume — isi URL se chalegi.`);
        return null;
      }

      if (st === 200 && !r.parseOk) {
        log(`↻ Invalid snippet JSON — same URL retry ${attempt}/${MAX_RETRIES}`);
      } else if (st === 429) {
        log(`⏸️ HTTP 429 — same URL retry ${attempt}/${MAX_RETRIES} after cooldown`);
      } else {
        log(`↻ ${st ? 'HTTP ' + st : (r.why || 'network')} — same URL retry ${attempt}/${MAX_RETRIES}`);
      }

      if (attempt < MAX_RETRIES) {
        const wait = st === 429 ? 15000 : (1500 * attempt);
        await sleepMs(wait);
      }
    }

    if (!stopRequested && !halted) {
      failN++;
      halted = true; // never silently skip an exhausted transient failure
      const st = (last && last.status) || 0;
      lastErr = { status: st, url: snippetUrl, body: '', kind: (st === 200 ? 'notjson' : 'transient'), msg: last && last.why };
      log(`⛔ ${st ? 'HTTP ' + st : 'network'} retries exhausted — URL pending rakha; Resume se isi checkpoint se chalega.`);
    }
    return null;
  }

  async function worker(slot) {
    while (!halted && !stopRequested) {
      // live concurrency: zyada slots sote rehte hain
      if (slot >= CONC) { await sleepMs(400); continue; }
      const now = Date.now();
      if (now < coolUntil) { await sleepMs(coolUntil - now); continue; }
      const localIndex = next++;
      if (localIndex >= list.length) return;
      const snippetUrl = toDomain(list[localIndex]).replace(/\/search\?/, '/search/snippet?');
      await PX.tick(CFG.rotateEveryN);   // proactive: har N requests par naya IP

      // PROACTIVE: har EVERY_N URLs ke baad 403 ka intezar kiye bagair nayi cookie
      if (EVERY_N > 0 && sinceCookie >= EVERY_N) {
        let hh = 'www.yelp.co.uk';
        try { hh = new URL(snippetUrl).hostname; } catch (e) {}
        log(`🍪 ${sinceCookie} URLs ho gaye — 403 se pehle hi nayi cookie le raha hoon`);
        if (await Hybrid.mintHomeCookie(hh)) { noteCookie('proactive'); await sleepMs(800); }
        else sinceCookie = 0;   // mint nahi hui, dobara foran koshish na karo
      }

      simpleSpeed.conc = CONC;
      await PX.gate();                   // IP badal raha ho to ruko
      const r = await fetchWithRetry(snippetUrl);
      sinceCookie++;

      if (r) {
        okN++;
        PX.badStreak = 0;
        onOk503();
        addAds(r.ads);
        markDone(localIndex);
      }

      if (!halted && !stopRequested) await sleepMs(GAP);
    }
  }

  await Promise.all(Array.from({ length: CONC_MAX }, (_, s) => worker(s)));
  // ─── COOKIE KA KHULASA — agli baar ka sahi number ───
  if (cookieLives.length) {
    const avg = Math.round(cookieLives.reduce((a, b) => a + b, 0) / cookieLives.length);
    const min = Math.min.apply(null, cookieLives);
    log(`📏 Cookie ${cookieLives.length} baar badli — aam tor par ${avg} URLs chali, sabse kam ${min}`);
    log(`   👉 Settings mein "cookieEveryN" = ${Math.max(20, Math.floor(min * 0.8))} rakho to 403 aane se pehle hi badal jayegi`);
  } else if (EVERY_N === 0) {
    log(`📏 Ek baar bhi cookie nahi badalni padi — proactive refresh ki zaroorat nahi`);
  }
  const resumeOffset = offset + contiguous;
  return { done: contiguous, okN, failN, blocked403: halted && !!(lastErr && lastErr.status === 403), halted, haltedStatus: lastErr && lastErr.status, stopped: stopRequested, resumeOffset, codes };
}

async function startScraping(searchUrls, permRef = null) {
  if (isScraping) { log('Already running...'); return; }
  isScraping = true;
  cachedSoFar.clear();
  searchUrls = [...new Set(searchUrls)];   // same URL do baar nahi (data bachao)
  await ensureCache();
  stopRequested = false;
  reqSinceRotate = 0; dataStats.reqBytes = 0; dataStats.loadBytes = 0; dataStats.rotations = 0; dataStats.reqCount = 0; dataStats.earlyCount = 0; dataStats.capCount = 0; dataStats.auditN = 0; dataStats.auditAds = 0; dataStats.auditMissed = 0;
  cacheStats.skipped = 0;
  Throttle.reset(); // naya run = fresh speed, purana penalty clear
  Hybrid.reset();   // naya run = ghar se shuru, seerhi reset
  Throttle.BASE_PACE = 150; // halka sa proactive pace shuru se (initial burst 429 rokta hai)
  await chrome.storage.local.remove([STATIC_KEY, PROG_KEY]);
  await saveStatic(searchUrls);
  activeRef = permRef || null;
  if (permRef) await chrome.storage.local.set({ bf_active_perm: permRef });
  else await chrome.storage.local.remove('bf_active_perm');
  startKeepalive();
  await cfgReady;
  // USA1000 requirement: every normal/group run must continue into v25's exact
  // strict 2-day photo phase. Only the option is forced ON; photo logic is unchanged.
  CFG.skipPhotos = false;
  CFG.simpleConc = Math.max(1, Math.min(50, parseInt(CFG.simpleConc, 10) || 15)); CFG.simpleConcMax = CFG.simpleConc; CFG.proxyRescue = false; CFG.cookieRescue = true; CFG.cookieFirst = false; PROXY.enabled = false;
  // DIRECT MODE: proxy zabardasti band. Probe/portability test uske baad proxy
  // ON chhod dete the — aur mara hua proxy har request kha jata tha.
  if (CFG.directMode !== false) {
    PROXY.enabled = false;
    // Do not touch chrome.proxy.settings: system VPN decides the network path.
    await sleepMs(250);
    try {
      const ipr = await fetch('https://api.ipify.org?format=json', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12000) });
      const ipj = await ipr.json();
      // ─── PREFLIGHT ──────────────────────────────────────────────────────────
  // Proxy ON hai to run shuru karne se PEHLE tasdeeq karo ke wo chal raha hai.
  // Warna 800 links par network errors ka tufan aata hai (pichli baar yahi hua).
  if (PX.cfg.enabled) {
    const pf = await PX.ip();
    if (!pf.ip) {
      log(`⛔ PROXY CHAL NAHI RAHA — run shuru nahi kar raha.`);
      log(`   ${pf.err || 'exit IP nahi mila'}`);
      log(`   Settings (Extension options) mein Check IP se tasdeeq karo,`);
      log(`   ya proxy OFF karke VPN par chala lo.`);
      isScraping = false;
      toPopup({ action: 'blocked', found: 0, active: 0, phase: 1, err: { status: 0, kind: 'paused', msg: 'proxy chal nahi raha' } });
      return;
    }
    log(`✅ Proxy verify ho gaya — exit IP: ${pf.ip} (port ${PX.port()})`);
    log(`   Har ${CFG.rotateEveryN || 50} requests par IP khud badlega.`);
  }
  log(`${PX.cfg.enabled ? '🔀 Proxy ON' : '🌐 VPN/direct'} — exit IP: ${ipj.ip} (system/VPN jo route de raha hai)`);
    } catch (e) {
      log(`⚠️ Internet check fail: ${(e && e.message) || e} — VPN/system connection check karo`);
    }
  }
  // Start directly through the existing system/VPN IP; no initial browser tab or cookie bootstrap.
  evt('info', 'RUN_START', 'Run started: ' + searchUrls.length + ' URLs', { why: 'Proxy ' + (PROXY.enabled ? 'ON' : 'OFF') + ', human mode ' + (CFG.humanMode ? 'ON' : 'OFF') + ', fast mode ' + (CFG.skipPhotos ? 'ON' : 'OFF') });
  initHumanLimit();
  await setLite(!!CFG.lite);
  await setSearchUltraLite(true);
  if (CFG.humanMode) await ensureYelpTab(searchUrls[0]);
  log(permRef ? `Group ${permRef.index + 1}: ${searchUrls.length} URLs` : `URLs: ${searchUrls.length}`);

  try {
    await runScraping({
      searchUrls, allBusinessUrls: new Set(), newUrls: null, businessesWithPhotos: [], manualReviewUrls: [],
      startSearchBatch: 0, startPhotoBatch: 0, blocked: 0, photoBlocked: 0, phase: 1
    });
  } catch (e) {
    log(`⚠️ Error: ${e.message} — auto-resume try karega`);
  } finally {
    isScraping = false;
    activeRef = null;
    // kisi bhi wajah se khatam ho — jo mila wo cache mein
    try { const k = await cacheFoundSoFar(lastFoundSet); if (k) log(`💾 ${k} URLs cache mein`); } catch (e) {}
    await setSearchUltraLite(false);
    await setLite(false);
    const st = await getRunStatus();
    // permanent group agar bina block ke complete hua to 'done' mark karo
    if (st !== 'blocked') {
      const r = await chrome.storage.local.get('bf_active_perm');
      const ref = r.bf_active_perm;
      if (ref && ref.collectionId != null) {
        await markGroupDone(ref.collectionId, ref.index, ref.cursorNext);
        await chrome.storage.local.remove('bf_active_perm');
        log(`✅ Group ${ref.index + 1} done — agla dabao (ya dobara chalao)`);
      }
    }
    if (st !== 'running') status(`Done — Cache: ${await getCount()}`);
    toPopup({ action: 'scrapeDone', blocked: st === 'blocked' });
  }
}

// ─── Resume (manual, blocked ke baad) ya AUTO (SW death ke baad) ──────────────

// ═══════════════════════════════════════════════════════════════════════════
// 🔄 AUTO-RELOAD — "port mara hua" ki barish par khud reset
//
// Masla: jab proxy ka connection pool kharab ho jata hai to har request
// "mara hua exit node" deti hai aur ye rukta hi nahi. Haath se theek karne ka
// tareeqa: chrome://extensions → reload → shortcut se dobara kholo. Us ke baad
// sab theek chal padta hai.
//
// chrome.runtime.reload() bilkul wahi karta hai. Aur maybeAutoResume() pehle
// se mojood hai, is liye reload ke baad run KHUD wahin se chalu ho jati hai —
// na extensions page kholna, na shortcut dabana.
//
// Reload sirf tab: lagataar DEAD_LIMIT network errors AUR koi kaamyabi nahi.
// Ek kaamyab request counter reset kar deti hai.
// ═══════════════════════════════════════════════════════════════════════════
const AutoReload = {
  deadStreak: 0,
  DEAD_LIMIT: 5,           // 5 lagataar network fail → foran reset
  COOLDOWN_MS: 20000,      // do reload ke beech kam se kam 20 second

  ok() { this.deadStreak = 0; },

  async dead() {
    this.deadStreak++;
    if (this.deadStreak < this.DEAD_LIMIT) return;

    let last = 0;
    try { last = (await chrome.storage.local.get('bf_lastReload')).bf_lastReload || 0; } catch (e) {}
    if (Date.now() - last < this.COOLDOWN_MS) { this.deadStreak = 0; return; }

    try {
      log(`🔄 ${this.deadStreak} lagataar "mara hua exit node" — extension khud reload ho raha hai.`);
      log(`   Reload ke baad page KHUD wapas khulega aur run wahin se chalegi.`);
      // Reload se extension ke saare pages band ho jate hain. Is liye pehle
      // yaad kar lo ke kaunsa page khula tha — startup par wahi dobara khol denge.
      let openUrl = '';
      try {
        const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('*') });
        if (tabs && tabs.length) openUrl = tabs[0].url;
      } catch (e) {}
      await chrome.storage.local.set({ bf_lastReload: Date.now(), bf_reopen: openUrl });
      await new Promise(r => setTimeout(r, 400));   // log likhne do
    } catch (e) {}
    try { chrome.runtime.reload(); } catch (e) {}
  }
};

async function continueFromStorage(isManual) {
  if (isScraping) return;
  const stat = await loadStatic();
  const prog = await loadProgress();
  if (!stat || !prog) { if (isManual) log('Kuch resume karne ko nahi hai'); return; }

  isScraping = true;
  startKeepalive();
  await cfgReady;
  // USA1000 requirement: every normal/group run must continue into v25's exact
  // strict 2-day photo phase. Only the option is forced ON; photo logic is unchanged.
  CFG.skipPhotos = false;
  CFG.simpleConc = Math.max(1, Math.min(50, parseInt(CFG.simpleConc, 10) || 15)); CFG.simpleConcMax = CFG.simpleConc; CFG.proxyRescue = false; CFG.cookieRescue = true; CFG.cookieFirst = false; PROXY.enabled = false;
  await ensureCache();
  stopRequested = false;
  // Resume directly through the existing system/VPN IP; no initial cookie bootstrap.
  initHumanLimit();
  await setLite(!!CFG.lite);
  await setSearchUltraLite(prog.phase <= 1);
  if (CFG.humanMode) await ensureYelpTab(stat.searchUrls && stat.searchUrls[0]);
  log(`▶️ ${isManual ? 'Resuming' : 'Auto-resume'} — Phase ${prog.phase}, batch ${prog.phase === 1 ? prog.startSearchBatch : prog.startPhotoBatch}`);

  try {
    await runScraping({
      searchUrls:           stat.searchUrls,
      allBusinessUrls:      prog.allBusinessUrls,
      foundAll:             prog.foundAll,
      newUrls:              prog.newUrls,
      businessesWithPhotos: prog.businessesWithPhotos,
      manualReviewUrls:      prog.manualReviewUrls || [],
      startSearchBatch:     prog.startSearchBatch,
      startPhotoBatch:      prog.startPhotoBatch,
      blocked:              prog.blocked,
      photoBlocked:         prog.photoBlocked,
      phase:                prog.phase
    });
  } catch (e) {
    log(`⚠️ Error: ${e.message} — auto-resume try karega`);
  } finally {
    isScraping = false;
    activeRef = null;
    // kisi bhi wajah se khatam ho — jo mila wo cache mein
    try { const k = await cacheFoundSoFar(lastFoundSet); if (k) log(`💾 ${k} URLs cache mein`); } catch (e) {}
    await setSearchUltraLite(false);
    await setLite(false);
    const st = await getRunStatus();
    if (st !== 'running') status(`Done — Cache: ${await getCount()}`);
    toPopup({ action: 'scrapeDone', blocked: st === 'blocked' });
  }
}

// Manual Resume button: blocked status ko running bana ke chala do
async function resumeScraping() {
  const prog = await loadProgress();
  if (!prog) { log('Kuch resume karne ko nahi hai'); return; }
  // 429 ke baad IP/VPN fix karke resume kar rahe ho — purana penalty/slowdown
  // clear kar do taake speed wapas pehli jaisi ho jaye.
  Throttle.reset();
  Throttle.BASE_PACE = 150; // wahi halka starting pace jo fresh run mein hota hai
  log('⚡ Speed reset — pehli jaisi raftaar se resume');
  if (prog.status === 'blocked') {
    await saveProgress({ ...prog, status: 'running' });
  }
  continueFromStorage(true);
}

// SW jaga to: agar status 'running' hai aur scrape nahi chal raha → khud resume
async function maybeAutoResume() {
  if (isScraping) return;
  const st = await getRunStatus();
  if (st === 'running') continueFromStorage(false);
}

// ─── Keepalive + auto-recovery: alarm har 30s SW ko jagata hai ───────────────
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === KEEPALIVE) maybeAutoResume();
});
chrome.runtime.onStartup.addListener(() => {
  vaultRestore(); ensureCache(); maybeAutoResume(); });
// SW script load hote hi (yaani jab bhi worker zinda ho) check karo
// Preserve Yelp cookies/session so a VPN-backed browser session can be reused after manual challenge solving.
ensureCache();   // foran, bina intezar ke
maybeAutoResume();

// ─── RELOAD KE BAAD PAGE WAPAS ───────────────────────────────────────────
// chrome.runtime.reload() extension ke saare pages band kar deta hai. Jo page
// khula tha wo yahan dobara khul jata hai — tumhe shortcut dabane ki zaroorat
// nahi. (Pehle reload to ho jata tha par page wapas nahi aata tha.)
(async () => {
  try {
    const r = await chrome.storage.local.get('bf_reopen');
    const u = r && r.bf_reopen;
    if (!u) return;
    await chrome.storage.local.remove('bf_reopen');
    const open = await chrome.tabs.query({ url: chrome.runtime.getURL('*') });
    if (open && open.length) { try { await chrome.tabs.update(open[0].id, { active: true }); } catch (e) {} return; }
    await chrome.tabs.create({ url: u, active: true });
  } catch (e) {}
})();


// ─── ONE PERMANENT URL LIST (groups/collections ki jagah) ────────────────────
const LIST_KEY = 'bf_urllist';
const LIST_SEED_KEY = 'bf_list_seed_v2';
let listPromise = null;
function ensureList() { return listPromise || (listPromise = buildList()); }
async function buildList() {
  const r = await chrome.storage.local.get(LIST_KEY);
  return Array.isArray(r[LIST_KEY]) ? r[LIST_KEY] : [];
}

// Return the unique union of the regular URL list and every collection/group.
// The previous Run All only used bf_urllist, which omitted Collection 4/5 and
// any links stored exclusively in custom collections.
async function getAllSavedUrls() {
  const list = await ensureList();
  const permanent = await loadPermanent();
  const seen = new Set();
  const all = [];
  const add = value => {
    const url = String(value || '').trim().split('#')[0];
    if (url && !seen.has(url)) { seen.add(url); all.push(url); }
  };
  list.forEach(add);
  (permanent.collections || []).forEach(c =>
    (c.groups || []).forEach(group => (group || []).forEach(add))
  );
  return all;
}
function cleanUrls(arr) {
  let skipped = 0; const out = [];
  for (let l of arr || []) {
    l = String(l || '').trim();
    if (!l) continue;
    if (/^https?:\/\/[^\s]*yelp[^\s]*\/search\?/i.test(l)) out.push(l.split('#')[0]); else skipped++;
  }
  return { urls: out, skipped };
}
const listReady = ensureList();
preloadCollections();


// ─── AUTO IP WHITELIST (Proxiware API) ───────────────────────────────────────
// Finds your current public IPv4 (direct, not through the proxy) and puts it on the
// Proxiware allowlist of your proxy user. Runs before every run, on browser start,
// every 5 minutes, and when the proxy answers 407.
const WL_KEY = 'bf_wl';
let wlBusy = null;
async function getMyIp() {
  const urls = ['https://checkip.amazonaws.com', 'https://ipv4.icanhazip.com', 'https://v4.ident.me'];
  for (const u of urls) {
    try {
      const r = await fetch(u, { cache: 'no-store', credentials: 'omit' });
      const t = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t;
    } catch (e) {}
  }
  throw new Error('Could not find your public IPv4 address (no internet?)');
}
async function pwApi(key, method, path, body) {
  const r = await fetch('https://api.proxiware.com/v1' + path, {
    method, cache: 'no-store',
    headers: { 'API-KEY': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  let j = t; try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + String(t).slice(0, 200));
  return j;
}
function syncWhitelist(force) {
  if (wlBusy) return wlBusy;
  wlBusy = (async () => {
    let st = {};
    try {
      st = (await chrome.storage.local.get(WL_KEY))[WL_KEY] || {};
      if (!st.apiKey) return { ok: false, skipped: true, msg: 'No Proxiware API key saved in Settings yet.' };
      const ip = await getMyIp();
      if (!force && st.lastIp === ip && st.lastOkAt && Date.now() - st.lastOkAt < 6 * 3600 * 1000) return { ok: true, ip, unchanged: true };
      const net = 'residential-eco';
      let subId = st.subId, userId = st.userId;
      if (!subId || !userId) {
        const subs = await pwApi(st.apiKey, 'GET', '/metered/networks/' + net + '/subscriptions');
        const list = Array.isArray(subs) ? subs : [];
        const sub = list.find(s => s.active) || list[0];
        if (!sub) throw new Error('No Eco Residential plan found on this API key');
        subId = sub.id;
        const us = await pwApi(st.apiKey, 'GET', '/metered/networks/' + net + '/subscriptions/' + subId + '/users?full=1');
        const arr = Array.isArray(us) ? us : ((us && us.data) || []);
        const want = String(st.proxyUser || '').trim();
        const u = arr.find(x => x.name === want) || (arr.length === 1 ? arr[0] : null);
        if (!u) throw new Error('Proxy user "' + want + '" not found. Users on this plan: ' + (arr.map(x => x.name).join(', ') || 'none'));
        userId = u.id;
      }
      const base = '/metered/networks/' + net + '/subscriptions/' + subId + '/users/' + userId;
      await pwApi(st.apiKey, 'PUT', base + '/binds', { binds: [ip] });
      if (st.location) {
        try { await pwApi(st.apiKey, 'PUT', base + '/ports', { ports: [{ location: st.location, range_index: 0 }] }); }
        catch (e) { evt('warn', 'WL_LOCATION', 'IP whitelisted, but setting the location failed: ' + e.message); }
      }
      const changed = st.lastIp !== ip;
      await chrome.storage.local.set({ [WL_KEY]: Object.assign({}, st, { subId, userId, lastIp: ip, lastOkAt: Date.now(), lastErr: '' }) });
      evt('info', 'WHITELIST', 'Your IP ' + ip + ' is whitelisted in Proxiware' + (changed ? ' (it was different before)' : ''));
      await sleepMs(2500);   // give Proxiware a moment to apply it
      return { ok: true, ip, changed };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      try { await chrome.storage.local.set({ [WL_KEY]: Object.assign({}, st, { subId: '', userId: '', lastErr: msg }) }); } catch (e2) {}
      evt('error', 'WL_FAIL', 'Auto IP whitelist failed: ' + msg,
          { why: 'The extension could not add your IP to Proxiware.', fix: 'Check the API key and the proxy user name in Settings (Auto IP whitelist), then click Sync my IP now.' });
      return { ok: false, msg };
    } finally { wlBusy = null; }
  })();
  return wlBusy;
}
try { chrome.alarms.create('bf_wl', { periodInMinutes: 5 }); } catch (e) {}
// Legacy proxy-whitelist alarm disabled; VPN/system networking is user-managed.

// ─── Message Handler ──────────────────────────────────────────────────────────
// ─── PX settings handlers ───────────────────────────────────────────────
// proxy settings page kholne ka raasta (kisi bhi UI se)
chrome.runtime.onMessage.addListener((req, s, send) => {
  if (req && req.px === 'open') { chrome.tabs.create({ url: chrome.runtime.getURL('pxsettings.html') }); send({ ok: true }); return true; }
});

chrome.runtime.onMessage.addListener((req, s, send) => {
  if (!req || !req.px) return;
  (async () => {
    await PX.load();
    if (req.px === 'get')       send({ cfg: PX.cfg, port: PX.port(), switches: PX.switches, domain: DOMAIN, domains: DOMAIN_HOST });
    else if (req.px === 'domain') {
      const v = String(req.domain || '');
      if (DOMAIN_HOST[v]) { DOMAIN = v; chrome.storage.local.set({ bf_domain: v }); send({ ok: true, domain: v, host: DOMAIN_HOST[v] }); }
      else send({ ok: false, msg: 'ye domain list mein nahi' });
    }
    else if (req.px === 'cfgget') send({ rotateEveryN: CFG.rotateEveryN ?? 50 });
    else if (req.px === 'save') {
      const c = Object.assign({}, req.cfg);
      if (c._rotateEveryN) { CFG.rotateEveryN = c._rotateEveryN; try { const s = await chrome.storage.local.get(CFG_KEY); await chrome.storage.local.set({ [CFG_KEY]: Object.assign({}, s[CFG_KEY] || {}, { rotateEveryN: c._rotateEveryN }) }); } catch (e) {} }
      delete c._rotateEveryN;
      await PX.save(c); send(await PX.apply());
    }
    else if (req.px === 'ip')   { const r = await PX.ip(); send({ ip: r.ip, err: r.err, port: PX.port(), on: !!PX.cfg.enabled, host: PX.cfg.host }); }
    else if (req.px === 'next') { const r = await PX.next('manual'); const i = await PX.ip(); send({ ...r, ip: i.ip, err: i.err, port: PX.port() }); }
    else send({});
  })();
  return true;
});

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'startScrape') {
    (async () => {
      await cfgReady;
      let u = req.urls || [];
      if (CFG.runLimit > 0 && u.length > CFG.runLimit) {
        log(`Run limit: pehle ${CFG.runLimit} URLs (total ${u.length})`);
        u = u.slice(0, CFG.runLimit);
      }
      startScraping(u);
    })();
    sendResponse({ ok: true });
  }
  if (req.action === 'getList') {
    (async () => { const l = await ensureList(); sendResponse({ count: l.length }); })();
    return true;
  }
  if (req.action === 'getAllCount') {
    (async () => { const l = await getAllSavedUrls(); sendResponse({ count: l.length }); })();
    return true;
  }
  if (req.action === 'addList') {
    (async () => {
      const cur = await ensureList();
      const { urls, skipped } = cleanUrls(req.urls);
      const base = req.mode === 'replace' ? [] : cur;
      const seen = new Set(base);
      const merged = base.slice(); let added = 0, dup = 0;
      urls.forEach(u => { if (seen.has(u)) dup++; else { seen.add(u); merged.push(u); added++; } });
      await chrome.storage.local.set({ [LIST_KEY]: merged });
      sendResponse({ ok: true, added, dup, skipped, total: merged.length });
    })();
    return true;
  }
  if (req.action === 'clearList') {
    chrome.storage.local.set({ [LIST_KEY]: [] }).then(() => sendResponse({ ok: true, total: 0 }));
    return true;
  }
  if (req.action === 'runAll') {
    (async () => {
      await cfgReady;
      if (isScraping) { sendResponse({ ok: false, error: 'already running' }); return; }
      let u = await getAllSavedUrls();
      if (!u.length) { sendResponse({ ok: false, error: 'no links saved' }); return; }
      // Run all means all unique links; do not silently truncate to runLimit.
      sendResponse({ ok: true, count: u.length });
      startScraping(u);
    })();
    return true;
  }
  if (req.action === 'startPhotoOnly') {
    runPhotoOnly(req.urls || []);
    sendResponse({ ok: true }); return true;
  }
  if (req.action === 'getPhotoOnlyResult') {
    chrome.storage.local.get(['bf_photo_only_result','bf_photo_only_count','bf_photo_only_manual','bf_photo_only_at'], d => sendResponse({
      text: d.bf_photo_only_result || '',
      count: d.bf_photo_only_count || 0,
      manual: d.bf_photo_only_manual || 0,
      at: d.bf_photo_only_at || 0
    })); return true;
  }
  if (req.action === 'vaultBackup') {
    (async () => { await vaultBackup(); sendResponse({ ok: true }); })(); return true;
  }
  if (req.action === 'vaultExport') {
    (async () => {
      const loc = await chrome.storage.local.get(VAULT_KEYS);
      const out = { _bfSettings: 1, savedAt: Date.now() };
      for (const k of VAULT_KEYS) if (!isEmptyVal(loc[k])) out[k] = loc[k];
      sendResponse({ ok: true, data: out });
    })(); return true;
  }
  if (req.action === 'vaultImport') {
    (async () => {
      try {
        const d = req.data || {};
        if (!d._bfSettings) { sendResponse({ ok: false, msg: 'Ye settings file nahi lag rahi.' }); return; }
        const put = {};
        for (const k of VAULT_KEYS) if (!isEmptyVal(d[k])) put[k] = d[k];
        if (!Object.keys(put).length) { sendResponse({ ok: false, msg: 'File mein koi setting nahi mili.' }); return; }
        await chrome.storage.local.set(put);
        await vaultBackup();
        sendResponse({ ok: true, keys: Object.keys(put) });
      } catch (e) { sendResponse({ ok: false, msg: String(e && e.message) }); }
    })(); return true;
  }
  if (req.action === 'vaultStatus') {
    (async () => {
      try {
        const syn = await chrome.storage.sync.get(VAULT_KEYS.map(k => 'sync_' + k).concat('sync_savedAt'));
        const have = VAULT_KEYS.filter(k => !isEmptyVal(syn['sync_' + k]));
        sendResponse({ ok: true, savedAt: syn.sync_savedAt || 0, keys: have });
      } catch (e) { sendResponse({ ok: false, msg: String(e && e.message) }); }
    })(); return true;
  }
  if (req.action === 'syncWhitelist') {
    syncWhitelist(true).then(r => sendResponse(r));
    return true;
  }
  if (req.action === 'stopScrape') {
    stopRequested = true; sendResponse({ ok: true });
    return true;
  }
  if (req.action === 'resumeScrape') {
    // saaf slate — poori speed se wahीं se
    lastErr = null;
    Throttle.reset();
    resumeScraping();
    sendResponse({ ok: true });
  }

  // DIAGNOSTIC: ek Yelp snippet request 2 tarah se bhejo, jawab dikhao
  if (req.action === 'testYelp') {
    (async () => {
      await cfgReady;
      const u = req.url || 'https://www.yelp.com/search/snippet?find_desc=plumbers&find_loc=Houston%2C+TX';
      const one = async (label, headers) => {
        try {
          const r = await fetch(u, { headers, credentials: 'omit', cache: 'no-store' });
          const t = await r.text();
          return {
            label, status: r.status, type: r.headers.get('content-type') || '',
            server: r.headers.get('server') || '',
            datadomeHeader: !!(r.headers.get('x-datadome') || r.headers.get('x-dd-b') || r.headers.get('x-datadome-cid')),
            captchaInBody: /captcha-delivery|datadome/i.test(t),
            hasSearchData: /searchPageProps/.test(t),
            length: t.length, start: t.slice(0, 200).replace(/\s+/g, ' ')
          };
        } catch (e) { return { label, error: String((e && e.message) || e) }; }
      };
      const a = await one('A) extension headers (current)', buildSnippetHeaders(u));
      const b = await one('B) plain browser headers', { 'Accept': 'application/json, text/plain, */*' });
      let c = null;
      if (CFG.humanMode) {
        try {
          const r = await pageFetch(u, { 'Accept': 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }, !!CFG.smartRead);
          if (!r) c = { label: 'C) via your Yelp tab', error: (lastErr && lastErr.msg === 'no-yelp-tab') ? 'No Yelp tab open. Click "Open Yelp tab" first.' : 'failed' };
          else {
            const t = await r.text();
            c = { label: 'C) via your Yelp tab (human mode)' + (CFG.smartRead ? (r._early ? ' — stopped early after ' + r._chars + ' chars' : ' — read all ' + r._chars + ' chars') : ''), status: r.status, type: '', server: '', datadomeHeader: false,
                  captchaInBody: /captcha-delivery|datadome/i.test(t), hasSearchData: /searchPageProps/.test(t),
                  length: t.length, start: t.slice(0, 200).replace(/\s+/g, ' ') };
          }
        } catch (e) { c = { label: 'C) via your Yelp tab', error: String((e && e.message) || e) }; }
      }
      sendResponse({ results: c ? [a, b, c] : [a, b], proxyOn: !!(PROXY && PROXY.enabled) });
    })();
    return true;
  }

  if (req.action === 'setConc') {
    (async () => {
      const v = Math.max(1, Math.min(50, parseInt(req.conc, 10) || 15));
      CFG.simpleConc = v; CFG.simpleConcMax = v;
      try {
        const s = await chrome.storage.local.get(CFG_KEY);
        await chrome.storage.local.set({ [CFG_KEY]: Object.assign({}, s[CFG_KEY] || {}, { simpleConc: v, simpleConcMax: v }) });
      } catch (e) {}
      sendResponse({ ok: true, conc: v });
    })();
    return true;
  }
  if (req.action === 'getConc') { sendResponse({ conc: CFG.simpleConc || 15 }); return true; }
  if (req.action === 'hasResume') {
    (async () => {
      const r = await chrome.storage.local.get(PROG_KEY);
      const s = r[PROG_KEY];
      const blocked = !!(s && s.status === 'blocked');
      sendResponse({ has: blocked, found: blocked ? s.found : 0, active: blocked ? s.active : 0, phase: blocked ? s.phase : 1 , err: (blocked && s.err) || null });
    })();
    return true;
  }

  if (req.action === 'isRunning') {
    (async () => {
      const st = await getRunStatus();
      sendResponse({ running: isScraping || st === 'running' });
    })();
    return true;
  }

  if (req.action === 'getCount') {
    (async () => {
      const cached = await getCachedCount();
      if (cached !== null) {
        sendResponse({ count: cached });                 // FORAN
        getCount().then(setCachedCount).catch(() => {});  // peeche se taaza karo
        return;
      }
      const n = await getCount();
      await setCachedCount(n);
      sendResponse({ count: n });
    })(); return true;
  }
  // permanent search URLs
  if (req.action === 'saveSearchUrls') {
    chrome.storage.local.set({ savedSearchUrls: req.text || '' }, () => sendResponse({ ok: true })); return true;
  }
  if (req.action === 'getSearchUrls') {
    chrome.storage.local.get('savedSearchUrls', d => sendResponse({ text: d.savedSearchUrls || '' })); return true;
  }
  // last result info (count/date) — button label ke liye
  if (req.action === 'getLastResult') {
    const A = !!req.all;
    const live = A ? liveAll : liveFound;
    if (isScraping && live && live.size) {       // run chal rahi hai — abhi tak ka live result
      sendResponse({ text: [...live].join('\n'), count: live.size, at: Date.now(), partial: true, countNew: liveFound ? liveFound.size : 0, countAll: liveAll ? liveAll.size : 0 }); return true;
    }
    chrome.storage.local.get(['lastResult','lastResultCount','lastResultAt','lastResultPartial','lastResultAll','lastResultAllCount'], d => sendResponse({
      text: (A ? d.lastResultAll : d.lastResult) || '',
      count: (A ? d.lastResultAllCount : d.lastResultCount) || 0,
      at: d.lastResultAt || 0,
      partial: !!d.lastResultPartial,
      countNew: d.lastResultCount || 0,
      countAll: d.lastResultAllCount || 0
    })); return true;
  }
  // result URLs ko .txt file mein download karo (sirf URLs, kuch nahi)
  if (req.action === 'downloadResult') {
    (async () => {
      const A = !!req.all;
      const d = await chrome.storage.local.get(['lastResult','lastResultCount','lastResultAll','lastResultAllCount']);
      let text = (A ? d.lastResultAll : d.lastResult) || '';
      let cnt = (A ? d.lastResultAllCount : d.lastResultCount) || 0;
      const live = A ? liveAll : liveFound;
      if (isScraping && live && live.size) { text = [...live].join('\n'); cnt = live.size; }
      if (!text) { sendResponse({ ok: false, error: 'no result' }); return; }
      d.lastResultCount = cnt;
      const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
      chrome.downloads.download({ url: dataUrl, filename: `${A ? 'all_urls' : 'new_urls'}_${Date.now()}.txt` });
      sendResponse({ ok: true, count: d.lastResultCount || 0 });
    })(); return true;
  }
  // ─── PERMANENT MODE handlers (multi-collection) ────────────────────────────
  // naya collection banao — naam + URLs (purane collections safe rehte hain)
  if (req.action === 'addCollection') {
    (async () => {
      const r = await addCollection(req.name, req.urls || []);
      sendResponse({ ok: true, ...r });
    })(); return true;
  }
  // saare collections + unke groups ka status
  if (req.action === 'getPermanent') {
    (async () => {
      const state = await loadPermanent();
      sendResponse({
        collections: state.collections.map(c => ({
          id: c.id,
          name: c.name,
          groups: c.groups.length,
          sizes: c.groups.map(g => g.length),
          done: c.done,
          lastRun: c.lastRun || {},
          total: c.groups.reduce((s, g) => s + g.length, 0)
        })),
        // abhi kaunsa group chal raha hai (agar koi chal raha ho)
        running: activeRef,
        isScraping
      });
    })(); return true;
  }
  // ek specific collection ka ek group chalao
  if (req.action === 'runPermanentGroup') {
    (async () => {
      const state = await loadPermanent();
      const c = state.collections.find(x => x.id === req.collectionId);
      if (!c || req.index == null || req.index >= c.groups.length) {
        sendResponse({ ok: false, error: 'invalid group' }); return;
      }
      await cfgReady;
      const all = c.groups[req.index];
      const lim = CFG.runLimit > 0 ? CFG.runLimit : all.length;
      let cur = ((c.cursor || {})[req.index]) || 0;
      if (cur >= all.length) cur = 0;                 // poora ho chuka tha — shuru se
      const urls = all.slice(cur, cur + lim);
      sendResponse({ ok: true, count: urls.length });
      await markGroupStarted(c.id, req.index);
      log(`Group ${req.index + 1}: URLs ${cur + 1}-${cur + urls.length} of ${all.length}`);
      startScraping(urls, { collectionId: c.id, index: req.index, cursorNext: cur + urls.length });
    })(); return true;
  }
  // ek collection delete
  if (req.action === 'deleteCollection') {
    (async () => { await deleteCollection(req.id); sendResponse({ ok: true }); })(); return true;
  }
  // collection rename
  if (req.action === 'renameCollection') {
    (async () => { await renameCollection(req.id, req.name); sendResponse({ ok: true }); })(); return true;
  }
  // sab permanent data clear
  if (req.action === 'restoreBundled') {
    (async () => { sendResponse({ ok: true, added: 0 }); })(); return true;
  }
  if (req.action === 'clearPermanent') {
    chrome.storage.local.remove(PERM_KEY, () => sendResponse({ ok: true })); return true;
  }

  if (req.action === 'addUrls') {
    (async () => {
      // FAST CACHE IMPORT: normalize/dedupe in memory, then one bulk IndexedDB path.
      // Avoids thousands of separate transactions (the old slow path).
      const urls = [...new Set((req.urls || []).map(bizKey).filter(Boolean))];
      const before = await getCount();
      if (urls.length) await saveBusinessesBulk(urls, 50000);
      const total = await getCount();
      await setCachedCount(total);
      sendResponse({ added: Math.max(0, total - before), total, received: urls.length });
    })().catch(e => sendResponse({ added: 0, error: String(e && e.message || e) })); return true;
  }
  if (req.action === 'setDomain') {
    DOMAIN = 'uk';
    chrome.storage.local.set({ bf_domain: 'uk' }).then(() => sendResponse({ ok: true, domain: 'uk' }));
    return true;
  }
  if (req.action === 'ddApiStart') {
    runDdApiTest(req.host || 'www.yelp.co.uk', req.url).then(r => sendResponse(r));
    return true;
  }
  if (req.action === 'portStart') {
    runPortability(req.url, req.host || 'www.yelp.co.uk', req.n).then(r => sendResponse(r));
    return true;
  }
  if (req.action === 'cmpStart') {
    runDomainCompare(req.urls || [], req.hosts || ['www.yelp.com.au', 'www.yelp.co.uk']).then(r => sendResponse(r));
    return true;
  }
  if (req.action === 'probeStart') {
    runProbe(req.url, !!req.bypass).then(r => sendResponse(r)); return true;
  }
  if (req.action === 'getDomain') {
    domainReady.then(() => sendResponse({ domain: DOMAIN })); return true;
  }
  if (req.action === 'exportCache') {
    (async () => { sendResponse({ urls: await getAllUrls() }); })(); return true;
  }
  if (req.action === 'clearCache') {
    (async () => {
      await setCachedCount(0); await clearAll(); await chrome.storage.local.remove([STATIC_KEY, PROG_KEY]); stopKeepalive(); sendResponse({ total: await getCount() }); })();
    return true;
  }
  if(req.action==='getProgress'){
    (async()=>{
      const p=await loadProgress();const st=await loadStatic();
      if(!p||!st){sendResponse({idle:true});return;}
      const total=st.searchUrls?st.searchUrls.length:0;
      sendResponse({done:Math.min((p.startSearchBatch||0)*40,total),total,found:p.allBusinessUrls?p.allBusinessUrls.length:0,status:p.status});
    })();return true;
  }
  if (req.action === 'reloadExt') {
    sendResponse({ ok: true });
    setTimeout(() => chrome.runtime.reload(), 200);
    return true;
  }
  if (req.action === 'wipeData') {
    (async () => { await wipeYelpData(true); sendResponse({ ok: true }); })();
    return true;
  }
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  // DATA SAFE: install/update must never clear collections, saved URLs, or business cache.
  // Existing user data stays untouched; defaults are initialized elsewhere only when missing.
  try { chrome.storage.local.set({ bf_data_safe_v1: true }); } catch (e) {}
});
