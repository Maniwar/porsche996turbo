/* ============================================================
   2003 PORSCHE 911 TURBO — CAR
   The Porsche Concierge · assets/concierge.js
   Self-contained. No dependencies. Loaded with defer.
   All classes and ids are prefixed 'cx-'.
   Public API: window.PorscheConcierge = { open(prefill), close(), status() }
   Diagnostics: status() snapshots the engagement state incl. lastSkip (why the
   most recent proactive beat did NOT fire); window.PORSCHE_CX_DEBUG = true logs
   each skip live. Documented in BEHAVIOR.md ("Diagnosing a quiet widget").
   ============================================================ */
(function () {
  'use strict';

  if (window.PorscheConcierge) { return; }
  if (!document || !document.createElement) { return; }

  /* ----------------------------------------------------------
     0. Configuration & defensive reads
  ---------------------------------------------------------- */
  function cfg() {
    var c = window.PORSCHE_CONCIERGE_CONFIG;
    return (c && typeof c === 'object') ? c : {};
  }
  function endpoint() {
    var e = cfg().endpoint;
    return (typeof e === 'string') ? e.replace(/^\s+|\s+$/g, '') : '';
  }
  function isDemo() { return !endpoint(); }
  function supaUrl() {
    var u = cfg().supabaseUrl;
    return (typeof u === 'string') ? u.replace(/^\s+|\s+$/g, '').replace(/\/+$/, '') : '';
  }
  function supaKey() {
    var k = cfg().supabaseAnonKey;
    return (typeof k === 'string') ? k.replace(/^\s+|\s+$/g, '') : '';
  }
  function hasSupabase() { return !!(supaUrl() && supaKey()); }
  /* auth UI is creds-gated, and the shop can switch it off remotely */
  function authEnabled() { return hasSupabase() && remoteAuth !== false; }
  function kb() {
    var k = window.PORSCHE_KB;
    return (k && typeof k === 'object') ? k : {};
  }
  function kbImages() {
    var i = kb().images;
    var base = (i && typeof i === 'object') ? i : {};
    if (!remoteImages || typeof remoteImages !== 'object') { return base; }
    /* admin-added images extend (and can override) the built-in map */
    var merged = {}, k;
    for (k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) { merged[k] = base[k]; } }
    for (k in remoteImages) {
      if (Object.prototype.hasOwnProperty.call(remoteImages, k)) {
        var v = remoteImages[k];
        if (v && typeof v === 'object' && typeof v.src === 'string') { merged[k] = v; }
      }
    }
    return merged;
  }
  function kbVideos() {
    var i = kb().videos;
    var base = (i && typeof i === 'object') ? i : {};
    if (!remoteVideos || typeof remoteVideos !== 'object') { return base; }
    /* admin-added videos extend (and can override) the built-in map */
    var merged = {}, k;
    for (k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) { merged[k] = base[k]; } }
    for (k in remoteVideos) {
      if (Object.prototype.hasOwnProperty.call(remoteVideos, k)) {
        var v = remoteVideos[k];
        if (v && typeof v === 'object' && typeof v.src === 'string') { merged[k] = v; }
      }
    }
    return merged;
  }
  /* A video source is either a direct file (mp4/webm/data:video), played in a
     native <video>, or a link to a known host (YouTube/Vimeo), played in a
     sandboxed <iframe> — a raw YouTube/Vimeo page URL is NOT a video file and
     will not play in <video>. Returns { url, portrait } for a recognised host
     (url = the privacy-friendly embed URL), else null → render as a file. */
  function videoEmbed(src) {
    if (typeof src !== 'string') { return null; }
    var s = src.trim(), m;
    /* YouTube Shorts — portrait */
    if ((m = /youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/.exec(s))) {
      return { url: 'https://www.youtube-nocookie.com/embed/' + m[1], portrait: true };
    }
    /* YouTube watch / youtu.be / embed / live — landscape */
    if ((m = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/.exec(s))) {
      return { url: 'https://www.youtube-nocookie.com/embed/' + m[1], portrait: false };
    }
    /* Vimeo */
    if ((m = /vimeo\.com\/(?:video\/)?(\d{5,})/.exec(s))) {
      return { url: 'https://player.vimeo.com/video/' + m[1], portrait: false };
    }
    return null;
  }
  /* remote starters (from ?config=1) REPLACE the KB map when present */
  function suggestedMap() {
    if (remoteStarters) { return remoteStarters; }
    var s = kb().suggested;
    return (s && typeof s === 'object') ? s : null;
  }
  function pickSection(map, sectionId) {
    if (!map || typeof map !== 'object') { return []; }
    var l = (sectionId && map[sectionId]) ? map[sectionId] : map['default'];
    return (Object.prototype.toString.call(l) === '[object Array]') ? l : [];
  }
  /* Effective starters for a section: the admin's overrides (from ?config) come
     first, then the baked KB defaults TOP UP any remaining slots (up to 3). This
     way a section the admin left blank — or only partly filled (e.g. one of three)
     — still offers a few starters instead of one or none. */
  function kbSuggested(sectionId) {
    var out = [], i, v;
    var over = remoteStarters ? pickSection(remoteStarters, sectionId) : [];
    for (i = 0; i < over.length && out.length < 3; i++) {
      v = over[i];
      if (typeof v === 'string' && v && out.indexOf(v) === -1) { out.push(v); }
    }
    var baked = pickSection(kb().suggested, sectionId);
    for (i = 0; i < baked.length && out.length < 3; i++) {
      v = baked[i];
      if (typeof v === 'string' && v && out.indexOf(v) === -1) { out.push(v); }
    }
    return out;
  }
  function kbDemoEntries() {
    var d = kb().demo;
    return (Object.prototype.toString.call(d) === '[object Array]') ? d : [];
  }
  function kbGreeting() {
    if (remoteGreeting) { return remoteGreeting; }
    var g = kb().greeting;
    if (typeof g === 'string' && g.length) { return g; }
    return 'Good evening. I keep the ledger for 2003 Porsche 911 Turbo — ask me about the car, ' +
      'how it is made, or the number that will be yours.';
  }
  var entryMode = 'typed';      /* how the current exchange was initiated */
  var lastSkip = '';            /* why the last proactive beat did NOT fire — surfaced
                                   by PorscheConcierge.status() so "the bot is
                                   quiet" is diagnosable instead of a mystery */
  var skipLog = [];             /* the last few skip notes, oldest first — checking the
                                   console is itself page activity (it resets the idle
                                   clock), so one snapshot must tell the WHOLE story,
                                   not just the gate hit while you were looking */
  function noteSkip(why) {
    lastSkip = why + ' (' + new Date().toLocaleTimeString() + ')';
    if (skipLog[skipLog.length - 1] !== lastSkip) {
      skipLog.push(lastSkip);
      if (skipLog.length > 8) { skipLog.shift(); }
    }
    try { if (window.PORSCHE_CX_DEBUG) { console.debug('[concierge] skip:', lastSkip); } } catch (eNS) { /* ignore */ }
  }
  /* Human duration for diagnostics — picks the unit that reads naturally,
     since admin windows can be set in hours, minutes, or seconds. */
  function fmtDur(ms) {
    if (!(ms > 0)) { return '0s'; }
    if (ms < 90000) { return Math.max(1, Math.round(ms / 1000)) + 's'; }
    if (ms < 5400000) { return Math.round(ms / 60000) + 'min'; }
    return Math.round(ms / 3600000) + 'h';
  }
  var lastSentAt = 0;           /* silence gap between the visitor's messages */

  function freshState() {
    var s = window.__porscheState;
    s = (s && typeof s === 'object') ? s : {};
    return {
      section: (typeof s.section === 'string' && s.section) ? s.section : currentSection(),
      claimed: (s.claimed != null) ? s.claimed : null,
      remaining: (s.remaining != null) ? s.remaining : null,
      slot: (s.slot != null) ? s.slot : null,
      holdClock: (s.holdClock != null) ? s.holdClock : null,
      loomClock: (s.loomClock != null) ? s.loomClock : null,
      device: (s.device != null) ? s.device : null,
      depth: (s.depth != null) ? s.depth : null,
      minutes: (s.minutes != null) ? s.minutes : null,
      checkout: (s.checkout != null) ? s.checkout : null,
      entry: entryMode,
      sinceLast: lastSentAt ? Math.round((Date.now() - lastSentAt) / 1000) : null
    };
  }

  var REDUCED = false;
  try {
    var mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq) {
      REDUCED = !!mq.matches;
      var onMq = function (e) { REDUCED = !!e.matches; syncReduced(); };
      if (mq.addEventListener) { mq.addEventListener('change', onMq); }
      else if (mq.addListener) { mq.addListener(onMq); }
    }
  } catch (e0) { /* ignore */ }

  var SECTIONS = ['hero', 'section-3', 'every-angle-every-light', 'intSection', 'sec-20-407-invested-all-documented', 'a-color-that-shifts-with-the-light', 'what-makes-it-special', 'the-details', 'clean-record', 'the-mezger-sound', 'interior-trim-condition', 'serious-buyers-get-serious-answers'];
  var INLINE_SECTIONS = ['section-3', 'every-angle-every-light', 'intSection', 'sec-20-407-invested-all-documented', 'a-color-that-shifts-with-the-light', 'what-makes-it-special', 'the-details', 'clean-record', 'the-mezger-sound', 'interior-trim-condition'];
  var HISTORY_KEY = 'cx-history';
  var OWNER_KEY = 'cx-owner';   /* whose identity the stored conversation belongs to */
  var SKEY_KEY = 'cx-skey';
  var CONVO_VER = '2';          /* bump to force-clear stale local conversations once */
  /* One-time cleanup of any conversation stored before identity-tagging existed,
     so leftover signed-in chat can't linger in a signed-out view. */
  try {
    if (window.sessionStorage.getItem('cx-ver') !== CONVO_VER) {
      window.sessionStorage.removeItem(HISTORY_KEY);
      window.sessionStorage.removeItem(OWNER_KEY);
      window.sessionStorage.removeItem(SKEY_KEY);
      window.sessionStorage.setItem('cx-ver', CONVO_VER);
    }
  } catch (eVer) { /* ignore */ }
  var HISTORY_CAP = 40;
  var SEND_TURNS = 12;
  var ERROR_LINE = 'The line is quiet. Write mberenji@gmail.com and a person will reply.';
  var BUSY_LINE = 'The desk is busy — one moment.';
  var STAMP_SRC = '';
  var SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  var TRACK_QUESTION = 'Where is my car?';

  /* ----------------------------------------------------------
     0b. Session key — one random id per browser session
  ---------------------------------------------------------- */
  var _sessionKey = '';
  function sessionKey() {
    if (_sessionKey) { return _sessionKey; }
    var k = null;
    try { k = window.sessionStorage.getItem(SKEY_KEY); } catch (eK) { k = null; }
    if (k) { _sessionKey = k; return k; }
    k = 'sk-';
    try {
      var buf = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(buf);
      var b;
      for (b = 0; b < buf.length; b++) { k += (buf[b] + 256).toString(16).slice(1); }
    } catch (eR) {
      k += Date.now().toString(36) +
        Math.random().toString(36).slice(2, 10) +
        Math.random().toString(36).slice(2, 10);
    }
    try { window.sessionStorage.setItem(SKEY_KEY, k); } catch (eS) { /* ignore */ }
    _sessionKey = k;
    return k;
  }

  /* ----------------------------------------------------------
     0c. Remote config (?config=1) — 3s budget, failures swallowed
  ---------------------------------------------------------- */
  var remoteCfgOk = false;      /* fetch succeeded and parsed */
  var remoteEnabled = null;     /* true/false once fetched */
  var remoteGreeting = '';
  var remoteStarters = null;    /* replaces PORSCHE_KB.suggested when present */
  var personalStarters = [];    /* signed-in: context-aware starters from ?starters=1 */
  var remoteAuth = null;
  var remoteForms = {};        /* slug -> {title, fields[], submit_tool} */
  var remoteOutreach = null;   /* admin-set engagement timings (from ?config=1) */
  var remoteImages = null;     /* admin-added {{img:token}} sources (from ?config=1) */
  var remoteVideos = null;     /* admin-added {{video:token}} sources (from ?config=1) */
  var remotePrivacyUrl = null; /* privacy-notice URL for the footer link (from ?config=1) */
  var remoteAssert = null;     /* admin assertiveness 1..5 (from ?config=1) */

  /* Assertiveness 1 (restrained) .. 5 (closer); default 3. Scales how often and
     how soon the concierge reaches out. */
  function assertLevel() {
    var v = (typeof remoteAssert === 'number') ? remoteAssert : 3;
    v = Math.round(v);
    return v < 1 ? 1 : (v > 5 ? 5 : v);
  }
  /* delay multiplier: higher assertiveness → shorter waits before a follow-up */
  function assertDelayMult() { return [1.5, 1.25, 1, 0.8, 0.65][assertLevel() - 1]; }

  function sanitizeForms(raw) {
    var out = {}, i, f, def, fields, j, fd;
    if (Object.prototype.toString.call(raw) !== '[object Array]') { return out; }
    for (i = 0; i < raw.length && i < 12; i++) {
      f = raw[i];
      if (!f || typeof f !== 'object') { continue; }
      if (typeof f.slug !== 'string' || !/^[a-z0-9-]{2,40}$/.test(f.slug)) { continue; }
      if (Object.prototype.toString.call(f.fields) !== '[object Array]') { continue; }
      fields = [];
      for (j = 0; j < f.fields.length && j < 12; j++) {
        fd = f.fields[j];
        if (!fd || typeof fd.name !== 'string' || !/^[a-z0-9_]{1,32}$/.test(fd.name)) { continue; }
        fields.push({
          name: fd.name,
          label: typeof fd.label === 'string' ? fd.label.slice(0, 60) : fd.name,
          type: (fd.type === 'state' || fd.type === 'zip' || fd.type === 'hidden') ? fd.type : 'text',
          /* Hidden fields carry a preset value (e.g. kind=offer) the shopper never
             sees; keep both so the renderer can seed it and omit the DOM. Without
             this passthrough a hidden field collapses to an empty text box. */
          value: (fd.type === 'hidden' && fd.value != null) ? String(fd.value).slice(0, 120) : undefined,
          required: fd.required === true,
          maxlength: (typeof fd.maxlength === 'number' && fd.maxlength > 0) ? fd.maxlength : 120,
          autocomplete: typeof fd.autocomplete === 'string' ? fd.autocomplete.slice(0, 40) : ''
        });
      }
      if (!fields.length) { continue; }
      def = {
        title: typeof f.title === 'string' ? f.title.slice(0, 80) : f.slug,
        fields: fields,
        submit_tool: typeof f.submit_tool === 'string' ? f.submit_tool : ''
      };
      out[f.slug] = def;
    }
    return out;
  }

  function sanitizeStarters(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    var out = {}, any = false, key, list, i, clean;
    for (key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) { continue; }
      list = raw[key];
      if (Object.prototype.toString.call(list) !== '[object Array]') { continue; }
      clean = [];
      for (i = 0; i < list.length; i++) {
        if (typeof list[i] === 'string' && list[i]) { clean.push(list[i]); }
      }
      out[key] = clean;
      any = true;
    }
    return any ? out : null;
  }

  function fetchRemoteConfig(cb) {
    if (!endpoint()) { cb(); return; }
    var settled = false;
    function finish() {
      if (settled) { return; }
      settled = true;
      cb();
    }
    var ac = null;
    try { ac = new AbortController(); } catch (eA) { ac = null; }
    var timer = setTimeout(function () {
      if (ac) { try { ac.abort(); } catch (eT) { /* ignore */ } }
      finish();
    }, 3000);
    var url = endpoint() + (endpoint().indexOf('?') === -1 ? '?config=1' : '&config=1');
    try {
      fetch(url, { method: 'GET', signal: ac ? ac.signal : undefined }).then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      }).then(function (j) {
        if (j && typeof j === 'object') {
          remoteCfgOk = true;
          remoteEnabled = (j.enabled !== false);
          if (typeof j.greeting === 'string' && j.greeting) { remoteGreeting = j.greeting; }
          var st = sanitizeStarters(j.starters);
          if (st) { remoteStarters = st; }
          if (j.auth != null) { remoteAuth = j.auth; }
          if (j.outreach && typeof j.outreach === 'object') { remoteOutreach = j.outreach; }
          if (j.images && typeof j.images === 'object') { remoteImages = j.images; }
          if (j.videos && typeof j.videos === 'object') { remoteVideos = j.videos; }
          if (typeof j.privacy_url === 'string' && j.privacy_url) { remotePrivacyUrl = j.privacy_url; }
          if (typeof j.assertiveness === 'number') { remoteAssert = j.assertiveness; }
          remoteForms = sanitizeForms(j.forms);
        }
        clearTimeout(timer);
        finish();
      })['catch'](function () {
        clearTimeout(timer);
        finish();
      });
    } catch (eF) {
      clearTimeout(timer);
      finish();
    }
  }

  /* ----------------------------------------------------------
     1. Styles — glass shell
  ---------------------------------------------------------- */
  function injectStyle() {
    var css = [
      ':root{--cx-glass:rgba(7,5,5,.92);--cx-hair:rgba(211,184,142,.35);--cx-hair-soft:rgba(211,184,142,.18);',
      '--cx-ink:var(--text,#f0eceb);--cx-gold:var(--gold,#c9a875);--cx-page-accent-soft:var(--page-accent-soft,#d3b88e);}',

      /* ---------- launcher ---------- */
      '.cx-launch{position:fixed;left:50%;bottom:calc(1rem + env(safe-area-inset-bottom,0px));',
      'transform:translateX(-50%);z-index:80;display:inline-flex;align-items:center;gap:.55rem;',
      'min-height:44px;padding:.7rem 1.3rem;background:var(--cx-glass);',
      '-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);',
      'border:1px solid var(--cx-hair);border-radius:999px;cursor:pointer;',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.66rem;letter-spacing:.2em;',
      'text-transform:uppercase;color:var(--cx-ink);opacity:0;pointer-events:none;',
      'transition:opacity .45s ease,transform .45s ease;will-change:transform,opacity;}',
      '.cx-launch .cx-star{color:var(--cx-page-accent-soft);font-size:.85rem;line-height:1;transform:translateY(-1px);}',
      '.cx-launch.cx-on{opacity:1;pointer-events:auto;}',
      '.cx-launch.cx-tuck{opacity:0;transform:translateX(-50%) translateY(140%);pointer-events:none;}',
      '.cx-launch.cx-unread::after{content:"";position:absolute;top:-3px;right:-3px;width:11px;height:11px;',
      'border-radius:50%;background:var(--cx-page-accent-soft,#d3b88e);border:2px solid var(--cx-bg-1,#070505);',
      'box-shadow:0 0 0 0 rgba(211,184,142,.6);animation:cxUnread 2s ease-out infinite;}',
      '@keyframes cxUnread{0%{box-shadow:0 0 0 0 rgba(211,184,142,.55);}70%{box-shadow:0 0 0 9px rgba(211,184,142,0);}100%{box-shadow:0 0 0 0 rgba(211,184,142,0);}}',
      '.cx-launch:hover{border-color:rgba(211,184,142,.6);}',
      '.cx-launch:focus-visible{outline:1px solid var(--cx-page-accent-soft);outline-offset:3px;}',
      /* docked circular form over the reserve section */
      '.cx-launch.cx-dock{left:auto;right:calc(1rem + env(safe-area-inset-right,0px));transform:none;',
      'width:48px;height:48px;min-height:48px;padding:0;justify-content:center;border-radius:50%;}',
      '.cx-launch.cx-dock .cx-label{display:none;}',
      '.cx-launch.cx-dock.cx-tuck{transform:translateY(140%);}',

      /* ---------- context chip ---------- */
      '.cx-chip{position:fixed;left:50%;bottom:calc(1rem + env(safe-area-inset-bottom,0px) + 62px);',
      'transform:translateX(-50%);z-index:80;max-width:min(86vw,26rem);',
      'padding:.65rem 1rem;min-height:44px;display:inline-flex;align-items:center;',
      'background:var(--cx-glass);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);',
      'border:1px solid var(--cx-hair);border-radius:2px;cursor:pointer;',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.62rem;letter-spacing:.16em;',
      'text-transform:uppercase;color:var(--cx-ink);text-align:left;line-height:1.5;',
      'opacity:0;transition:opacity .6s ease;}',
      '.cx-chip.cx-on{opacity:1;}',
      '.cx-chip:hover{border-color:rgba(211,184,142,.6);}',

      /* ---------- scrim ---------- */
      '.cx-scrim{position:fixed;inset:0;z-index:81;background:rgba(7,5,5,.35);',
      'opacity:0;pointer-events:none;transition:opacity .35s ease;}',
      '.cx-scrim.cx-on{opacity:1;pointer-events:auto;}',

      /* ---------- panel ---------- */
      '.cx-panel{position:fixed;z-index:82;display:flex;flex-direction:column;',
      'background:var(--cx-glass);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);',
      'color:var(--cx-ink);visibility:hidden;}',
      '.cx-panel:focus{outline:none;}',

      '@media (max-width:899px){',
      '.cx-panel{left:0;right:0;bottom:0;height:68svh;max-height:100svh;border-radius:14px 14px 0 0;',
      'border-top:1px solid var(--cx-hair);transform:translateY(105%);',
      'transition:transform .5s cubic-bezier(.22,.8,.28,1),height .35s ease,visibility 0s linear .5s;}',
      '.cx-panel.cx-open{transform:translateY(0);visibility:visible;transition:transform .5s cubic-bezier(.22,.8,.28,1),height .35s ease;}',
      '.cx-panel.cx-tall{height:92svh;}',
      '.cx-panel.cx-dragging{transition:none;}',
      '.cx-handle{flex:0 0 auto;padding:.55rem 0 .2rem;display:flex;justify-content:center;cursor:grab;touch-action:none;position:relative;}',
      '.cx-handle::before{content:"";width:38px;height:3px;border-radius:2px;background:rgba(211,184,142,.45);}',
      /* One-time mobile tutorial: a floating pill ABOVE the sheet's edge
         teaching swipe-up-to-expand — outside the panel so it can never
         collide with the header. Removed forever once they expand. */
      '.cx-swipehint{position:absolute;bottom:calc(100% + .55rem);left:50%;transform:translateX(-50%);',
      'display:flex;align-items:center;gap:.45rem;pointer-events:none;white-space:nowrap;',
      'padding:.42rem .9rem;border-radius:999px;background:rgba(7,5,5,.93);',
      'border:1px solid rgba(211,184,142,.4);box-shadow:0 4px 16px rgba(0,0,0,.35);',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;',
      'color:var(--cx-page-accent-soft,#d3b88e);opacity:0;animation:cxHintIn .5s ease .6s forwards;z-index:3;}',
      '.cx-swipehint .cx-swipearr{display:inline-block;font-size:.85rem;line-height:1;',
      'animation:cxHintRise 1.5s ease-in-out .9s 3;}',
      '@keyframes cxHintIn{to{opacity:.95;}}',
      '@keyframes cxHintRise{0%,100%{transform:translateY(2px);opacity:.5;}45%{transform:translateY(-5px);opacity:1;}}',
      /* The demonstration itself: while the hint shows, the SHEET lifts a
         finger's-width and settles back, twice — previewing exactly what the
         gesture does. Synced to the chevron's rise; removed with the hint. */
      '.cx-panel.cx-hintnudge{animation:cxSheetNudge 1.5s ease-in-out .9s 2;}',
      '@keyframes cxSheetNudge{0%,100%{transform:translateY(0);}45%{transform:translateY(-14px);}}',
      '@media (prefers-reduced-motion:reduce){.cx-swipehint{animation:none;opacity:.95;}.cx-swipehint .cx-swipearr{animation:none;}.cx-panel.cx-hintnudge{animation:none;}}',
      '.cx-head{padding:0 1.4rem .6rem !important;gap:.6rem !important;min-height:auto !important;}',
      '.cx-close{margin:-.3rem -.7rem 0 0 !important;}',
      '.cx-authmail{display:none !important;}',
      '.cx-compose{padding:.5rem 1.4rem .6rem !important;}',
      '.cx-foot{display:none !important;}',
      '}',

      '@media (min-width:900px){',
      '.cx-panel{top:0;right:0;bottom:0;width:420px;border-left:1px solid var(--cx-hair);',
      'transform:translateX(105%);transition:transform .5s cubic-bezier(.22,.8,.28,1),visibility 0s linear .5s;}',
      '.cx-panel.cx-open{transform:translateX(0);visibility:visible;transition:transform .5s cubic-bezier(.22,.8,.28,1);}',
      '.cx-handle{display:none;}',
      '}',

      /* ---------- header ---------- */
      '.cx-head{flex:0 0 auto;display:flex;align-items:flex-start;justify-content:space-between;',
      'gap:1rem;padding:1.1rem 1.4rem .95rem;border-bottom:1px solid var(--cx-hair-soft);}',
      '.cx-title{font-family:Inter, -apple-system, BlinkMacSystemFont, sans-serif;font-weight:400;font-size:1.28rem;line-height:1.2;',
      'color:var(--cx-ink);margin:0;}',
      '.cx-sub{display:flex;align-items:center;gap:.5rem;margin-top:.4rem;',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.6rem;letter-spacing:.22em;',
      'text-transform:uppercase;color:rgba(241,236,226,.55);white-space:nowrap;overflow:hidden;}',
      '.cx-sub span{overflow:hidden;text-overflow:ellipsis;}',
      '.cx-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;}',
      '.cx-dot.cx-demo{background:#C8973F;box-shadow:0 0 6px rgba(200,151,63,.5);}',
      '.cx-dot.cx-live{background:#6FA57A;box-shadow:0 0 6px rgba(111,165,122,.5);}',
      '.cx-close{flex:0 0 auto;width:44px;height:44px;margin:-.55rem -.7rem 0 0;',
      'display:flex;align-items:center;justify-content:center;background:none;border:none;',
      'color:rgba(241,236,226,.65);font-size:1.25rem;line-height:1;cursor:pointer;font-family:Inter, -apple-system, BlinkMacSystemFont, sans-serif;}',
      '.cx-close:hover{color:var(--cx-ink);}',
      '.cx-close:focus-visible{outline:1px solid var(--cx-page-accent-soft);outline-offset:2px;}',
      /* ---------- conversation options menu (in the composer, opens upward) ---------- */
      '.cx-menuwrap{position:relative;flex:0 0 auto;}',
      '.cx-menu-btn{width:40px;height:44px;display:flex;align-items:center;',
      'justify-content:center;background:none;border:none;color:rgba(241,236,226,.4);',
      'font-size:1.2rem;line-height:1;cursor:pointer;font-family:Inter, -apple-system, BlinkMacSystemFont, sans-serif;',
      'transition:color .25s ease;}',
      '.cx-menu-btn:hover{color:var(--cx-page-accent-soft);}',
      '.cx-menu-btn:focus-visible{outline:1px solid var(--cx-page-accent-soft);outline-offset:2px;border-radius:6px;}',
      '.cx-menu{position:absolute;bottom:100%;right:0;margin-bottom:.5rem;z-index:8;min-width:236px;',
      'background:#1c1a17;border:1px solid var(--cx-hair);border-radius:10px;padding:.35rem;',
      'box-shadow:0 -12px 34px rgba(0,0,0,.5);}',
      '.cx-menu[hidden]{display:none;}',
      '.cx-menu-item{display:block;width:100%;text-align:left;background:none;border:none;',
      'color:rgba(241,236,226,.82);font-family:Inter, -apple-system, BlinkMacSystemFont, sans-serif;font-size:.82rem;',
      'line-height:1.3;padding:.6rem .7rem;border-radius:7px;cursor:pointer;}',
      '.cx-menu-item:hover{background:rgba(241,236,226,.06);color:var(--cx-ink);}',
      '.cx-menu-item:focus-visible{outline:1px solid var(--cx-page-accent-soft);outline-offset:-1px;}',

      /* ---------- message list ---------- */
      '.cx-msgs{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:.4rem 1.4rem 1rem;',
      '-webkit-overflow-scrolling:touch;overscroll-behavior:contain;position:relative;}',
      '.cx-turn{padding:1.05rem 0;border-bottom:1px solid var(--cx-hair-soft);}',
      '.cx-turn:last-child{border-bottom:none;}',
      '.cx-turn-user{text-align:right;font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.75rem;',
      'letter-spacing:.18em;text-transform:uppercase;color:rgba(241,236,226,.78);line-height:1.7;',
      'word-break:break-word;}',
      '.cx-turn-assistant{font-family:Inter, -apple-system, BlinkMacSystemFont, sans-serif;font-weight:400;',
      'font-size:.95rem;line-height:1.65;color:var(--cx-ink);word-break:break-word;}',
      '.cx-turn-assistant p{margin:0 0 .85em;}',
      '.cx-turn-assistant p:last-child{margin-bottom:0;}',
      '.cx-turn-assistant strong{font-weight:600;}',
      '.cx-turn-assistant em{font-style:italic;}',
      '.cx-turn-assistant code{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.8em;',
      'padding:.08em .35em;border:1px solid var(--cx-hair-soft);background:rgba(241,236,226,.05);}',
      '.cx-turn-assistant ul,.cx-turn-assistant ol{margin:0 0 .85em;padding-left:1.15rem;}',
      '.cx-turn-assistant li{margin:.25em 0;}',
      '.cx-turn-assistant a{color:var(--cx-page-accent-soft);text-decoration:none;',
      'border-bottom:1px solid var(--cx-hair);}',
      '.cx-turn-assistant a:hover{border-bottom-color:var(--cx-page-accent-soft);}',
      '.cx-pre{white-space:pre-wrap;}',

      /* tables */
      '.cx-tablewrap{overflow-x:auto;margin:0 0 .85em;border:1px solid var(--cx-hair-soft);}',
      '.cx-turn-assistant table{border-collapse:collapse;width:100%;',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.72rem;line-height:1.5;}',
      '.cx-turn-assistant th{font-weight:500;text-transform:uppercase;letter-spacing:.12em;',
      'font-size:.62rem;color:var(--cx-page-accent-soft);text-align:left;}',
      '.cx-turn-assistant th,.cx-turn-assistant td{padding:.5rem .75rem;',
      'border-bottom:1px solid var(--cx-hair-soft);white-space:nowrap;}',
      '.cx-turn-assistant tr:last-child td{border-bottom:none;}',

      /* figures */
      '.cx-fig{margin:.2em 0 .95em;}',
      '.cx-fig img{display:block;max-width:100%;height:auto;border:1px solid var(--cx-hair-soft);}',
      '.cx-fig video{display:block;max-width:100%;height:auto;border:1px solid var(--cx-hair-soft);background:#000;}',
      /* responsive iframe embed (YouTube/Vimeo): 16:9 by default, 9:16 for Shorts */
      '.cx-embed{position:relative;width:100%;padding-top:56.25%;border:1px solid var(--cx-hair-soft);background:#000;}',
      '.cx-embed.cx-embed-portrait{width:270px;max-width:100%;padding-top:0;height:480px;margin:0 auto;}',
      '.cx-embed iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:0;}',
      '.cx-embed.cx-embed-portrait iframe{position:static;}',
      '.cx-actionrow{margin:.3em 0 .9em;}',
      '.cx-action{min-height:44px;display:inline-flex;align-items:center;gap:.5rem;cursor:pointer;',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;',
      'color:var(--cx-bg-1,#070505);background:var(--cx-page-accent-soft);border:1px solid var(--cx-page-accent-soft);',
      'padding:.65rem 1.25rem;transition:background .25s,color .25s;}',
      '.cx-action:hover{background:transparent;color:var(--cx-page-accent-soft);}',
      '.cx-fade-in{animation:cxFade .6s ease both;}',
      '@keyframes cxFade{from{opacity:0;}to{opacity:1;}}',

      /* caret (weaving shuttle) + woven-word entrance + dots */
      '.cx-caret{display:inline-block;width:13px;height:2px;background:var(--cx-page-accent-soft);',
      'vertical-align:baseline;margin-left:3px;border-radius:1px;transform-origin:left center;',
      'animation:cxShuttle .9s ease-in-out infinite;}',
      '@keyframes cxShuttle{0%,100%{transform:scaleX(1);opacity:.9;}50%{transform:scaleX(.35);opacity:.45;}}',
      '.cx-w{opacity:0;filter:blur(2.5px);color:var(--cx-page-accent-soft);',
      'transition:opacity .3s ease,filter .42s ease,color .8s ease;}',
      '.cx-w.cx-w-in{opacity:1;filter:blur(0);color:inherit;}',
      '.cx-dots{display:inline-flex;gap:6px;align-items:center;padding:.3em 0;}',
      '.cx-dots i{width:3px;height:3px;border-radius:50%;background:var(--cx-page-accent-soft);',
      'animation:cxWeave 1.1s ease-in-out infinite;}',
      '.cx-dots i:nth-child(2){animation-delay:.18s;}',
      '.cx-dots i:nth-child(3){animation-delay:.36s;}',
      '@keyframes cxWeave{0%,100%{transform:translateY(0);opacity:.4;}50%{transform:translateY(-4px);opacity:1;}}',
      '.cx-status{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.68rem;letter-spacing:.1em;',
      'text-transform:uppercase;color:rgba(211,184,142,.75);margin-left:10px;vertical-align:middle;}',

      /* time divider — marks a real pause so re-engagement reads as a return */
      '.cx-timedivider{display:flex;align-items:center;gap:12px;margin:1.1rem 2px .5rem;',
      'opacity:.75;}',
      '.cx-timedivider::before,.cx-timedivider::after{content:"";flex:1;height:1px;',
      'background:linear-gradient(90deg,transparent,rgba(211,184,142,.28),transparent);}',
      '.cx-timedivider span{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.56rem;',
      'letter-spacing:.18em;text-transform:uppercase;color:rgba(211,184,142,.7);white-space:nowrap;}',

      /* the concierge asking a question — set apart from informational prose */
      '.cx-ask{position:relative;padding-left:.9rem;margin-top:.55rem;',
      'color:var(--cx-text,#f0eceb);font-style:italic;}',
      '.cx-ask::before{content:"";position:absolute;left:0;top:.18em;bottom:.18em;width:2px;',
      'border-radius:2px;background:linear-gradient(var(--cx-gold,#c9a875),rgba(211,184,142,.2));}',

      /* quick replies */
      '.cx-replies{display:flex;flex-wrap:wrap;gap:8px;margin:.65rem 0 .2rem;}',
      '.cx-reply{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.8rem;letter-spacing:.08em;',
      'text-transform:uppercase;color:var(--cx-page-accent-soft);background:rgba(211,184,142,.07);',
      'border:1px solid rgba(211,184,142,.45);border-radius:999px;padding:.65em 1.1em;',
      'cursor:pointer;transition:background .25s,color .25s,border-color .25s,opacity .25s;}',
      '.cx-reply:hover:not(:disabled){background:rgba(211,184,142,.16);color:var(--cx-text,#f0eceb);',
      'border-color:var(--cx-page-accent-soft);}',
      '.cx-reply:disabled{opacity:.35;cursor:default;}',
      '.cx-replies-used .cx-reply{opacity:.35;}',

      /* in-chat forms */
      '.cx-form{border:1px solid rgba(211,184,142,.4);background:rgba(211,184,142,.05);',
      'padding:1rem 1rem .9rem;margin:.65rem 0 .3rem;display:flex;flex-direction:column;gap:.6rem;}',
      '.cx-form-title{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.72rem;letter-spacing:.14em;',
      'text-transform:uppercase;color:var(--cx-page-accent-soft);margin-bottom:.15rem;}',
      '.cx-form-field{display:flex;flex-direction:column;gap:4px;}',
      '.cx-form-label{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.72rem;letter-spacing:.08em;',
      'text-transform:uppercase;color:rgba(241,236,226,.55);}',
      '.cx-form-input{background:rgba(7,5,5,.6);border:1px solid rgba(211,184,142,.3);',
      'border-radius:2px;color:#f0eceb;font-size:.9rem;padding:.55em .7em;outline:none;}',
      '.cx-form-input:focus{border-color:var(--cx-page-accent-soft);}',
      '.cx-form-err{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.68rem;letter-spacing:.08em;',
      'text-transform:uppercase;color:#d3766a;line-height:1.7;}',
      '.cx-form-done{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.72rem;letter-spacing:.1em;',
      'text-transform:uppercase;color:var(--cx-page-accent-soft);line-height:1.8;}',

      /* outreach — the concierge speaks first, chat closed or not */
      '.cx-outreach{position:fixed;left:50%;transform:translateX(-50%) translateY(12px);',
      'bottom:calc(4.6rem + env(safe-area-inset-bottom,0px));z-index:81;',
      'max-width:min(340px,calc(100vw - 32px));display:flex;gap:10px;align-items:flex-start;',
      'background:rgba(7,5,5,.96);border:1px solid rgba(211,184,142,.55);',
      'padding:.85rem 2rem .85rem .85rem;cursor:pointer;opacity:0;',
      'box-shadow:0 24px 48px -20px rgba(0,0,0,.8);backdrop-filter:blur(6px);',
      'transition:opacity .6s ease,transform .6s ease;}',
      '.cx-outreach.cx-on{opacity:1;transform:translateX(-50%) translateY(0);}',
      '.cx-outreach .cx-or-text{font-size:.82rem;line-height:1.55;color:rgba(241,236,226,.92);}',
      '.cx-outreach .cx-or-x{position:absolute;top:2px;right:4px;background:none;border:none;',
      'color:rgba(241,236,226,.5);font-size:14px;cursor:pointer;padding:7px;line-height:1;}',
      '.cx-outreach .cx-or-x:hover{color:#f0eceb;}',
      '.cx-outreach img{width:30px;height:30px;border-radius:50%;flex:0 0 auto;',
      'border:1px solid rgba(211,184,142,.5);object-fit:cover;}',

      /* error + system lines */
      '.cx-sysline{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.64rem;letter-spacing:.14em;',
      'text-transform:uppercase;line-height:1.8;color:rgba(241,236,226,.6);}',

      /* suggestion chips inside panel */
      '.cx-suggest{display:flex;flex-direction:column;align-items:flex-start;gap:.5rem;',
      'padding:.9rem 0 .3rem;}',
      '.cx-sbtn{min-height:44px;display:inline-flex;align-items:center;text-align:left;',
      'padding:.55rem .9rem;background:transparent;border:1px solid var(--cx-hair);',
      'border-radius:2px;color:var(--cx-ink);cursor:pointer;',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.62rem;letter-spacing:.16em;',
      'text-transform:uppercase;line-height:1.5;transition:border-color .25s ease;}',
      '.cx-sbtn:hover{border-color:rgba(211,184,142,.65);}',
      '.cx-sbtn:focus-visible{outline:1px solid var(--cx-page-accent-soft);outline-offset:2px;}',

      /* new-messages pill */
      '.cx-newpill{position:absolute;left:50%;transform:translateX(-50%);',
      'bottom:calc(100% + .6rem);z-index:2;padding:.45rem .9rem;min-height:34px;',
      'background:var(--cx-glass);border:1px solid var(--cx-hair);border-radius:999px;',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.6rem;letter-spacing:.18em;',
      'text-transform:uppercase;color:var(--cx-page-accent-soft);cursor:pointer;',
      'opacity:0;pointer-events:none;transition:opacity .3s ease;}',
      '.cx-newpill.cx-on{opacity:1;pointer-events:auto;}',

      /* ---------- composer ---------- */
      '.cx-compose{flex:0 0 auto;position:relative;padding:.85rem 1.4rem .4rem;',
      'border-top:1px solid var(--cx-hair);}',
      '.cx-inputrow{display:flex;align-items:flex-end;gap:.7rem;}',
      '.cx-input{flex:1 1 auto;resize:none;background:transparent;border:none;',
      'border-bottom:1px solid var(--cx-hair-soft);color:var(--cx-ink);',
      'font-family:Inter, -apple-system, BlinkMacSystemFont, sans-serif;font-weight:300;font-size:16px;line-height:1.5;',
      'padding:.4rem 0;min-height:44px;max-height:calc(3 * 1.5em + .8rem);overflow-y:auto;}',
      '.cx-input:focus{outline:none;border-bottom-color:var(--cx-hair);}',
      '.cx-input::placeholder{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.68rem;',
      'letter-spacing:.16em;text-transform:uppercase;color:rgba(241,236,226,.4);}',
      '.cx-input:disabled{opacity:.45;}',
      '.cx-send{flex:0 0 auto;width:44px;height:44px;display:flex;align-items:center;',
      'justify-content:center;background:transparent;border:1px solid var(--cx-hair);',
      'border-radius:50%;color:var(--cx-page-accent-soft);font-size:1rem;cursor:pointer;',
      'transition:border-color .25s ease,color .25s ease;}',
      '.cx-send:hover:not(:disabled){border-color:var(--cx-page-accent-soft);color:var(--cx-ink);}',
      '.cx-send:disabled{opacity:.35;cursor:default;}',
      '.cx-send:focus-visible{outline:1px solid var(--cx-page-accent-soft);outline-offset:2px;}',

      /* ---------- visible wrap-up chip (the visitor's own "we're done" signal) ----------
         Rides in the message flow after the bot's latest reply, like a
         suggestion chip — scrolls with the conversation, costs no chrome. */
      '.cx-wrapend{display:flex;justify-content:flex-end;margin:.4rem 0 .15rem;}',
      '.cx-wrapbtn{background:transparent;border:1px solid var(--cx-hair);border-radius:999px;',
      'color:var(--cx-page-accent-soft);font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.58rem;',
      'letter-spacing:.13em;text-transform:uppercase;padding:.3rem .75rem;cursor:pointer;',
      'white-space:nowrap;transition:border-color .25s ease,color .25s ease,background .25s ease;}',
      '.cx-wrapbtn:hover{border-color:var(--cx-page-accent-soft);color:var(--cx-ink);background:rgba(211,184,142,.08);}',
      '.cx-wrapbtn:focus-visible{outline:1px solid var(--cx-page-accent-soft);outline-offset:2px;}',

      '.cx-foot{flex:0 0 auto;padding:.35rem 1.4rem calc(.8rem + env(safe-area-inset-bottom,0px));',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.58rem;letter-spacing:.14em;',
      'text-transform:uppercase;color:var(--cx-ink);opacity:.45;line-height:1.7;}',
      '.cx-foot-privacy{color:inherit;text-decoration:underline;}',
      '.cx-foot-privacy:hover{opacity:1;}',

      /* ---------- brand stamp (avatar) ---------- */
      '.cx-stamp{flex:0 0 auto;width:28px;height:28px;border-radius:50%;object-fit:cover;',
      'border:1px solid var(--cx-hair);margin-top:.15rem;}',
      '.cx-stamp-mini{width:18px;height:18px;border-radius:50%;object-fit:cover;',
      'border:1px solid var(--cx-hair-soft);flex:0 0 auto;}',
      '.cx-think{display:inline-flex;align-items:center;gap:.5rem;}',
      '.cx-headleft{flex:1 1 auto;min-width:0;}',

      /* ---------- top-hairline shimmer (once per open) ---------- */
      '.cx-shimline{position:absolute;top:0;left:0;right:0;height:1px;overflow:hidden;',
      'pointer-events:none;z-index:3;}',
      '.cx-shimline i{position:absolute;top:0;left:0;width:34%;height:100%;',
      'background:linear-gradient(90deg,transparent,rgba(211,184,142,.85),transparent);',
      'transform:translateX(-110%);animation:cxShim 2s ease .1s both;}',
      '@keyframes cxShim{from{transform:translateX(-110%);}to{transform:translateX(420%);}}',

      /* ---------- account (magic link) ---------- */
      '.cx-authbox{flex:0 0 auto;display:flex;align-items:center;gap:.55rem;',
      'margin-left:auto;margin-top:-.2rem;min-width:0;}',
      '.cx-authmail{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.66rem;letter-spacing:.08em;',
      'text-transform:uppercase;color:rgba(241,236,226,.55);max-width:8.5rem;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap;}',
      '.cx-authlink{background:none;border:none;padding:.6rem .2rem;min-height:44px;cursor:pointer;',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.58rem;letter-spacing:.18em;',
      'text-transform:uppercase;color:var(--cx-page-accent-soft);white-space:nowrap;}',
      '.cx-authlink:hover{color:var(--cx-ink);}',
      '.cx-authlink:focus-visible{outline:1px solid var(--cx-page-accent-soft);outline-offset:2px;}',
      '.cx-authrow{padding:.55rem 0 .75rem .95rem;margin:.55rem 0 .7rem;border-left:2px solid var(--cx-page-accent-soft);}',
      '.cx-authcap{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.68rem;letter-spacing:.1em;',
      'text-transform:uppercase;color:rgba(241,236,226,.6);line-height:1.7;}',
      '.cx-authline{display:flex;align-items:flex-end;gap:.7rem;margin-top:.55rem;}',
      '.cx-authinput{flex:1 1 auto;min-width:0;background:transparent;border:none;',
      'border-bottom:1px solid var(--cx-hair-soft);color:var(--cx-ink);',
      'font-family:Inter, -apple-system, BlinkMacSystemFont, sans-serif;font-weight:300;font-size:16px;line-height:1.4;',
      'padding:.35rem 0;min-height:40px;}',
      '.cx-authinput:focus{outline:none;border-bottom-color:var(--cx-hair);}',
      '.cx-authinput::placeholder{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.66rem;',
      'letter-spacing:.14em;text-transform:uppercase;color:rgba(241,236,226,.35);}',
      '.cx-authsend{flex:0 0 auto;min-height:40px;padding:.45rem .9rem;background:transparent;',
      'border:1px solid var(--cx-hair);border-radius:2px;color:var(--cx-page-accent-soft);cursor:pointer;',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.6rem;letter-spacing:.18em;',
      'text-transform:uppercase;transition:border-color .25s ease;}',
      '.cx-authsend:hover:not(:disabled){border-color:var(--cx-page-accent-soft);}',
      '.cx-authsend:disabled{opacity:.45;cursor:default;}',
      '.cx-authsend:focus-visible{outline:1px solid var(--cx-page-accent-soft);outline-offset:2px;}',
      '.cx-signedline{margin-top:.7rem;font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.68rem;',
      'letter-spacing:.18em;text-transform:uppercase;color:rgba(241,236,226,.5);}',

      /* ---------- feedback (↑ / ↓) ---------- */
      '.cx-fb{display:flex;justify-content:flex-end;align-items:center;gap:.15rem;margin-top:.35rem;}',
      '.cx-fbbtn{background:none;border:none;min-width:44px;min-height:44px;padding:.8rem .85rem;',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.85rem;line-height:1;cursor:pointer;',
      'color:var(--cx-ink);opacity:.4;transition:opacity .25s ease,color .25s ease;}',
      '.cx-fbbtn:hover:not(:disabled){opacity:1;color:var(--cx-page-accent-soft);}',
      '.cx-fbbtn:disabled{cursor:default;}',
      '.cx-fbbtn:focus-visible{outline:1px solid var(--cx-page-accent-soft);outline-offset:2px;}',
      '.cx-fbnote{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.68rem;letter-spacing:.12em;',
      'text-transform:uppercase;color:rgba(241,236,226,.5);padding:.4rem 0;}',

      /* ---------- inline starters woven into the page ---------- */
      '.cx-inline{display:flex;align-items:center;gap:.85rem;width:100%;max-width:80rem;',
      'margin:clamp(2rem,5vh,3.25rem) auto 0;padding:1.1rem 0;background:none;border:0;',
      'border-top:1px solid rgba(211,184,142,.28);border-radius:0;cursor:pointer;text-align:left;',
      'font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
      'grid-column:1/-1;position:relative;z-index:2;color:var(--text,#f0eceb);}',
      '.cx-inline-ink{color:var(--ink,#26332B);}',
      '.cx-inline-pad{padding-left:clamp(1.25rem,4vw,4rem);padding-right:clamp(1.25rem,4vw,4rem);}',
      '.cx-inline .cx-inline-star{flex:0 0 auto;color:var(--gold,#c9a875);font-size:.85rem;line-height:1;}',
      '.cx-inline .cx-inline-q{flex:1 1 auto;font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:.68rem;',
      'letter-spacing:.18em;text-transform:uppercase;line-height:1.6;opacity:.65;',
      'transition:opacity .3s ease;}',
      '.cx-inline .cx-inline-arrow{flex:0 0 auto;color:var(--page-accent-soft,#d3b88e);font-size:.9rem;',
      'line-height:1;transform:translateX(0);transition:transform .3s ease;}',
      '.cx-inline:hover .cx-inline-q,.cx-inline:focus-visible .cx-inline-q{opacity:1;}',
      '.cx-inline:hover .cx-inline-arrow{transform:translateX(4px);}',
      '.cx-inline:focus-visible{outline:1px solid var(--page-accent-soft,#d3b88e);outline-offset:4px;}',

      /* ---------- reduced motion ---------- */
      '.cx-reduced,.cx-reduced *{transition:none !important;animation:none !important;}',
      '.cx-reduced .cx-caret{opacity:1;}',
      '.cx-reduced .cx-dots i{opacity:.8;transform:none;}',

      '@media (prefers-reduced-motion:reduce){',
      '.cx-launch,.cx-chip,.cx-scrim,.cx-panel,.cx-newpill,.cx-sbtn,.cx-send,',
      '.cx-inline .cx-inline-q,.cx-inline .cx-inline-arrow,.cx-fbbtn,.cx-authsend{transition:none !important;}',
      '.cx-caret,.cx-dots i,.cx-fade-in,.cx-shimline i{animation:none !important;}',
      '}'
    ].join('');
    var tag = document.createElement('style');
    tag.id = 'cx-style';
    tag.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(tag);
  }

  /* ----------------------------------------------------------
     2. Tiny DOM helpers (no innerHTML anywhere near input)
  ---------------------------------------------------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.appendChild(document.createTextNode(String(text))); }
    return n;
  }

  /* brand-stamp emblem — hides itself if the asset is missing */
  function stampImg(cls) {
    var img = document.createElement('img');
    img.className = cls;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.onerror = function () { img.style.display = 'none'; };
    img.src = STAMP_SRC;
    return img;
  }

  /* status dot: green only when the concierge line is verified live */
  function syncStatusDot() {
    if (!statusDot) { return; }
    if (endpoint() && remoteCfgOk && remoteEnabled === true) {
      statusDot.className = 'cx-dot cx-live';
      statusDot.title = 'Live';
    } else {
      statusDot.className = 'cx-dot cx-demo';
      statusDot.title = isDemo()
        ? 'Demo — answers from the product register'
        : 'Standing by — the line to 2003 Porsche 911 Turbo is unverified';
    }
  }

  /* ----------------------------------------------------------
     3. Markdown renderer — SECURITY CRITICAL
        Builds a DocumentFragment via createElement/textContent only.
  ---------------------------------------------------------- */
  var INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]*\]\([^)\s]+\))/g;
  var LINK_RE = /^\[([^\]]*)\]\(([^)\s]+)\)$/;

  function safeUrl(url) {
    if (/^https:\/\//i.test(url) || /^mailto:/i.test(url)) { return true; }
    if (/^\/\//.test(url)) { return false; }                 /* protocol-relative → reject */
    if (/^[a-z][a-z0-9+.\-]*:/i.test(url)) { return false; } /* any other scheme (javascript:, data:, http:) → reject */
    return true;                                             /* scheme-less relative path / #anchor → allow */
  }

  function renderInline(text, target) {
    /* strip any control token that leaked mid-line ({{action:…}}, {{tool:…}},
       a stray {{reply:…}}) — these are the model's plumbing, never prose, and
       the on-their-own-line ones are handled above; this catches inline leaks */
    text = text.replace(/\{\{[a-z_]+(?::[^}]*)?\}\}/gi, '');
    /* per-call regex instance: the shared global's lastIndex gets clobbered
       by recursive calls (nested bold/italic), which loops forever */
    var re = new RegExp(INLINE_RE.source, 'g');
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        target.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      var tok = m[0], node;
      if (m[1]) { /* `code` */
        node = el('code', null, tok.slice(1, -1));
        target.appendChild(node);
      } else if (m[2]) { /* **bold** */
        node = document.createElement('strong');
        renderInline(tok.slice(2, -2), node);
        target.appendChild(node);
      } else if (m[3]) { /* *italic* */
        node = document.createElement('em');
        renderInline(tok.slice(1, -1), node);
        target.appendChild(node);
      } else if (m[4]) { /* [text](url) */
        var lm = LINK_RE.exec(tok);
        if (lm && safeUrl(lm[2])) {
          node = document.createElement('a');
          node.setAttribute('href', lm[2]);
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
          node.appendChild(document.createTextNode(lm[1] || lm[2]));
          target.appendChild(node);
        } else {
          target.appendChild(document.createTextNode(tok));
        }
      }
      last = re.lastIndex;
    }
    if (last < text.length) {
      target.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function isTableSep(line) {
    return /^\s*\|?[\s:\-|]+\|?\s*$/.test(line) && line.indexOf('-') !== -1;
  }
  function splitTableRow(line) {
    var t = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
    var cells = t.split('|'), out = [], i;
    for (i = 0; i < cells.length; i++) { out.push(cells[i].replace(/^\s+|\s+$/g, '')); }
    return out;
  }

  var US_STATE_CODES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

  /* An in-chat form. Collects structured input and submits it to the edge
     function's ?form=1 endpoint — the same verified, audited write path the
     concierge's own tools use. Definitions come from the Studio via config. */
  function buildChatForm(slug, serial, def) {
    /* Two shapes share this card. An INQUIRY form (make-an-offer,
       book-a-viewing -> submit_inquiry) is anonymous and serial-free: the
       model emits it as {{form:slug}} with no serial, anyone may submit, and
       the post authenticates with the publishable anon key. A REGISTER-EDIT
       form (address-change, etc.) carries a serial, is gated on a signed-in
       user token, and titles itself "N\u00ba <serial>". */
    var isInquiry = (serial == null) || def.submit_tool === 'submit_inquiry';
    var card = el('div', 'cx-form cx-fade-in');
    card.appendChild(el('div', 'cx-form-title',
      isInquiry ? def.title : (def.title + ' — N\u00ba ' + serial.toLocaleString('en-US'))));

    var controls = {};
    def.fields.forEach(function (f) {
      if (f.type === 'hidden') {
        /* A hidden field carries a preset value the shopper never sees or fills
           (e.g. kind=offer, which tags the inquiry). Seed its value so submit
           picks it up, and render no DOM — showing it as a blank box is a bug. */
        controls[f.name] = { value: (f.value != null ? String(f.value) : '') };
        return;
      }
      var wrap = el('label', 'cx-form-field');
      wrap.appendChild(el('span', 'cx-form-label', f.label));
      var input;
      if (f.type === 'state') {
        input = document.createElement('select');
        var o0 = document.createElement('option');
        o0.value = '';
        o0.appendChild(document.createTextNode('State\u2026'));
        input.appendChild(o0);
        US_STATE_CODES.forEach(function (c) {
          var o = document.createElement('option');
          o.value = c;
          o.appendChild(document.createTextNode(c));
          input.appendChild(o);
        });
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.maxLength = f.maxlength;
        if (f.type === 'zip') { input.setAttribute('inputmode', 'numeric'); }
        if (f.autocomplete) { input.autocomplete = f.autocomplete; }
      }
      input.className = 'cx-form-input';
      wrap.appendChild(input);
      controls[f.name] = input;
      card.appendChild(wrap);
    });

    var err = el('div', 'cx-form-err');
    err.style.display = 'none';
    var submit = el('button', 'cx-action', isInquiry ? '\u2733 Send to the owner' : '\u2733 Enter it in the register');
    submit.type = 'button';
    card.appendChild(submit);
    card.appendChild(err);

    function say(msg) { err.textContent = msg; err.style.display = msg ? '' : 'none'; }

    submit.addEventListener('click', function () {
      var values = {}, bad = null;
      def.fields.forEach(function (f) {
        var v = (controls[f.name].value || '').replace(/^\s+|\s+$/g, '');
        if (f.required && !v) { bad = bad || (f.label + ' is needed.'); }
        if (f.type === 'zip' && v && !/^\d{5}(-\d{4})?$/.test(v)) { bad = bad || 'ZIP: five digits, the usual kind.'; }
        values[f.name] = v;
      });
      if (bad) { say(bad); return; }
      say('');
      submit.disabled = true;
      ensureSupabase();
      if (isInquiry) {
        /* Anonymous inquiry post: no sign-in, no serial. Authenticate with the
           publishable anon key (same as the widget's other anonymous calls) so
           anyone can hand the owner an offer / viewing / question. The server's
           handleFormPost routes it through submit_inquiry with serial:null. */
        fetch(endpoint() + '?form=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': supaKey(), 'Authorization': 'Bearer ' + supaKey() },
          body: JSON.stringify({ form: slug, serial: null, values: values, session_key: sessionKey(), section: currentSection(), turns: history.length })
        }).then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
          .then(function (r) {
            if (r.ok && r.j && r.j.ok) {
              var msg = typeof r.j.message === 'string' ? r.j.message : 'Sent to the owner.';
              while (card.firstChild) { card.removeChild(card.firstChild); }
              card.appendChild(el('div', 'cx-form-done', '\u2733 ' + msg));
              /* Durable: rewrite the transcript so a re-render shows the form as
                 SENT rather than resurrecting a blank card. Inquiry forms carry
                 no serial, so the token to erase is the serial-less one. */
              var tok = '{{form:' + slug + '}}';
              for (var hi = 0; hi < history.length; hi++) {
                if (history[hi].role === 'assistant' && history[hi].content.indexOf(tok) !== -1) {
                  history[hi].content = history[hi].content
                    .split(tok).join('\u2733 ' + def.title + ' \u2014 sent to the owner.');
                }
              }
              history.push({ role: 'assistant', content: '(An inquiry form was submitted: ' + msg + ')' });
              saveHistory();
            } else {
              submit.disabled = false;
              say((r.j && r.j.error) ? String(r.j.error) : 'The owner\u2019s desk is briefly unavailable \u2014 try again.');
            }
          })['catch'](function () {
            submit.disabled = false;
            say('The owner\u2019s desk is briefly unavailable \u2014 try again.');
          });
        return;
      }
      getAccessToken().then(function (token) {
        if (!token) {
          submit.disabled = false;
          say('The register takes signed entries \u2014 sign in first.');
          return null;
        }
        return fetch(endpoint() + '?form=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          /* section + turns mirror the commission-click marker's context so an
             inquiry form (anonymous, serial-free) carries the same session
             provenance the server stamps as chat_meta. Harmless for register-edit
             forms — the server only reads them for the inquiry path. */
          body: JSON.stringify({ form: slug, serial: serial, values: values, session_key: sessionKey(), section: currentSection(), turns: history.length })
        }).then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
          .then(function (r) {
            if (r.ok && r.j && r.j.ok) {
              var msg = typeof r.j.message === 'string' ? r.j.message : 'Recorded.';
              while (card.firstChild) { card.removeChild(card.firstChild); }
              card.appendChild(el('div', 'cx-form-done', '\u2733 ' + msg));
              /* Durable: rewrite the transcript so any re-render (reopen,
                 reload, cross-tab restore) shows the form as RECORDED \u2014 the
                 original {{form:...}} token would otherwise resurrect a
                 fresh blank form every time the history is drawn. */
              var tok = '{{form:' + slug + ':' + serial + '}}';
              for (var hi = 0; hi < history.length; hi++) {
                if (history[hi].role === 'assistant' && history[hi].content.indexOf(tok) !== -1) {
                  history[hi].content = history[hi].content
                    .split(tok).join('\u2733 ' + def.title + ' \u2014 recorded in the register for N\u00ba ' + serial + '.');
                }
              }
              history.push({ role: 'assistant', content: '(The register recorded a form submission for N\u00ba ' + serial + ': ' + msg + ')' });
              saveHistory();
            } else {
              submit.disabled = false;
              say((r.j && r.j.error) ? String(r.j.error) : 'The register is briefly unavailable \u2014 try again.');
            }
          });
      })['catch'](function () {
        submit.disabled = false;
        say('The register is briefly unavailable \u2014 try again.');
      });
    });

    return card;
  }

  /* When the concierge's message ENDS on a question, that final line is an
     invitation — set it apart from informational prose. */
  function markAsk(frag) {
    try {
      var nodes = frag.childNodes;
      var lastP = null;
      for (var i = nodes.length - 1; i >= 0; i--) {
        var n = nodes[i];
        if (!n || !n.classList) { continue; }
        /* pills and action rows may trail the question itself */
        if (n.classList.contains('cx-replies') || n.classList.contains('cx-actionrow')) { continue; }
        if (n.tagName === 'P') { lastP = n; }
        break;
      }
      if (lastP && /\?\s*$/.test(lastP.textContent || '')) {
        lastP.classList.add('cx-ask');
      }
    } catch (eM) { /* prose is fine too */ }
    return frag;
  }

  /* The model sometimes writes its tool calls as literal text instead of
     invoking them — function-call XML (<function_calls><invoke …>…) or a
     {{action:tool}} token. None of it is ever meant for the shopper's eyes;
     scrub it before rendering, whatever path it arrived by. */
  function isLegitToken(m) {
    var low = m.toLowerCase();
    /* the real vocabulary the block renderer turns into UI — keep these */
    return low.indexOf('{{img:') === 0 || low.indexOf('{{video:') === 0 ||
      low.indexOf('{{reply:') === 0 ||
      low.indexOf('{{form:') === 0 || low === '{{action:commission}}' ||
      low === '{{action:signin}}';
  }
  function stripPlumbing(t) {
    if (typeof t !== 'string' || t.indexOf('<function_calls') < 0 &&
        t.indexOf('<invoke') < 0 && t.indexOf('{{') < 0) { return t; }
    t = t.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');
    /* an unclosed block still streaming in: drop from the marker to the end */
    t = t.replace(/<function_calls>[\s\S]*$/i, '');
    t = t.replace(/<\/?(function_calls|invoke|parameter)(\s[^>]*)?>/gi, '');
    /* strip ONLY plumbing tokens ({{action:recall_context}}, {{tool:…}}) —
       never the legit img/reply/form/commission/signin tokens the renderer
       needs to build images, pills, buttons, and forms */
    t = t.replace(/\{\{[a-z_]+(?::[^}]*)?\}\}/gi, function (m) {
      return isLegitToken(m) ? m : '';
    });
    return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  }

  function mdRender(text) {
    var frag = document.createDocumentFragment();
    if (typeof text !== 'string' || !text.length) { return frag; }
    text = stripPlumbing(text);
    if (!text.length) { return frag; }
    var lines = text.replace(/\r\n?/g, '\n').split('\n');
    var i = 0, n = lines.length;
    var para = [];
    var images = kbImages();
    var videos = kbVideos();

    function flushPara() {
      if (!para.length) { return; }
      var p = document.createElement('p');
      renderInline(para.join('\n'), p);
      frag.appendChild(p);
      para = [];
    }

    /* Stall guard: no branch below should ever loop without consuming a line,
       but if one regression slips through, a bounded iteration count turns an
       infinite loop (a frozen page) into a truncated render. */
    var guardIter = 0, guardMax = n * 4 + 64;
    while (i < n) {
      if (++guardIter > guardMax) { break; }
      var line = lines[i];
      var trimmed = line.replace(/^\s+|\s+$/g, '');

      /* blank line — paragraph break */
      if (!trimmed) { flushPara(); i++; continue; }

      /* {{img:token}} line */
      var imgm = /^\{\{img:([A-Za-z0-9_-]+)\}\}$/.exec(trimmed);
      if (imgm) {
        flushPara();
        var meta = images[imgm[1]];
        if (meta && typeof meta === 'object' && typeof meta.src === 'string') {
          var fig = document.createElement('figure');
          fig.className = 'cx-fig cx-fade-in';
          var img = document.createElement('img');
          img.setAttribute('loading', 'lazy');
          img.setAttribute('src', meta.src);
          img.setAttribute('alt', (typeof meta.alt === 'string') ? meta.alt : '');
          fig.appendChild(img);
          frag.appendChild(fig);
        }
        i++; continue;
      }

      /* {{video:token}} line */
      var vidm = /^\{\{video:([A-Za-z0-9_-]+)\}\}$/.exec(trimmed);
      if (vidm) {
        flushPara();
        var vmeta = videos[vidm[1]];
        if (vmeta && typeof vmeta === 'object' && typeof vmeta.src === 'string') {
          var vfig = document.createElement('figure');
          vfig.className = 'cx-fig cx-fade-in';
          var vlabel = (typeof vmeta.label === 'string') ? vmeta.label
            : ((typeof vmeta.alt === 'string') ? vmeta.alt : '');
          var emb = videoEmbed(vmeta.src);
          if (emb) {
            /* YouTube/Vimeo — responsive iframe (portrait for Shorts) */
            var box = document.createElement('div');
            box.className = 'cx-embed' + (emb.portrait ? ' cx-embed-portrait' : '');
            var ifr = document.createElement('iframe');
            ifr.setAttribute('src', emb.url);
            ifr.setAttribute('title', vlabel || 'video');
            ifr.setAttribute('loading', 'lazy');
            ifr.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
            ifr.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
            ifr.setAttribute('allowfullscreen', '');
            box.appendChild(ifr);
            vfig.appendChild(box);
          } else {
            /* direct file — native <video> */
            var vid = document.createElement('video');
            vid.setAttribute('controls', '');
            vid.setAttribute('preload', 'metadata');
            vid.setAttribute('playsinline', '');
            if (typeof vmeta.poster === 'string' && vmeta.poster) { vid.setAttribute('poster', vmeta.poster); }
            if (vlabel) { vid.setAttribute('aria-label', vlabel); }
            var vsrc = document.createElement('source');
            vsrc.setAttribute('src', vmeta.src);
            vsrc.setAttribute('type', 'video/mp4');
            vid.appendChild(vsrc);
            if (vlabel) { vid.appendChild(document.createTextNode(vlabel)); }
            vfig.appendChild(vid);
          }
          frag.appendChild(vfig);
        }
        i++; continue;
      }

      /* {{action:token}} line — whitelisted action buttons */
      var actm = /^\{\{action:(commission|signin)\}\}$/.exec(trimmed);
      if (actm) {
        flushPara();
        var actName = actm[1];
        var canDo = actName === 'commission'
          ? (window.PorscheCheckout && typeof window.PorscheCheckout.open === 'function')
          : (authEnabled() && !authEmail); /* already signed in → an old sign-in token renders as nothing */
        if (canDo) {
          var act = el('div', 'cx-actionrow cx-fade-in');
          var ab = el('button', 'cx-action',
            actName === 'commission' ? '✳ Begin the commission' : '✳ Sign in — the key arrives by mail');
          ab.type = 'button';
          if (actName === 'signin') {
            /* Only the NEWEST sign-in button stays prominent. The bot may have
               offered the key in several messages; a transcript stacking live
               gold CTAs reads as nagging. Rendering runs oldest→newest, so
               demoting all previous sign-in buttons here leaves exactly one. */
            ab.className += ' cx-action-signin';
            try {
              var oldSb = (msgsEl || document).querySelectorAll('.cx-action-signin');
              for (var osb = 0; osb < oldSb.length; osb++) {
                oldSb[osb].disabled = true;
                oldSb[osb].style.opacity = '0.45';
              }
            } catch (eOsb) { /* cosmetic only */ }
          }
          ab.addEventListener('click', actName === 'commission'
            ? function () {
              /* Attribution: the register sheet is opening from the concierge's
                 own commission button — the strongest "the chat drove this"
                 signal there is. Stamp it so checkout can send chat_via:
                 'concierge' with the order (vs 'ambient' = a chat merely
                 existed this session). Read by chatVia() in checkout.js. */
              try {
                window.sessionStorage.setItem('cx-commission-via', JSON.stringify({
                  ts: Date.now(),
                  entry: entryMode,
                  section: currentSection(),
                  turns: history.length
                }));
              } catch (eAttr) { /* storage unavailable — attribution degrades to ambient */ }
              closePanel(); window.PorscheCheckout.open();
            }
            : function () { openAuthRow(this); });   /* this = the tapped button — the form mounts right under it */
          act.appendChild(ab);
          frag.appendChild(act);
        }
        i++; continue;
      }

      /* {{reply:...}} lines — tappable quick replies; consecutive lines group.
         CRITICAL: every line matching the {{reply: prefix MUST be consumed,
         well-formed or not. The old code broke out of the inner loop WITHOUT
         advancing when a pill failed the strict pattern (e.g. a label over the
         old 64-char cap — which the bot now produces for per-order pills), so
         the outer loop re-tested the same line forever and froze the page. */
      if (/^\{\{reply:/.test(trimmed)) {
        flushPara();
        var pills = [];
        while (i < n) {
          var rl = lines[i].replace(/^\s+|\s+$/g, '');
          if (!/^\{\{reply:/.test(rl)) { break; }
          i++; /* consume unconditionally — malformed pills are swallowed, never rendered, never looped on */
          var rm = /^\{\{reply:([^{}]{1,200})\}\}$/.exec(rl);
          if (!rm) { continue; }
          var full = rm[1].replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
          if (full && pills.length < 6) {
            pills.push({ send: full, show: full.length > 90 ? full.slice(0, 89) + '…' : full });
          }
        }
        if (pills.length) {
          var row = el('div', 'cx-replies cx-fade-in');
          row.setAttribute('role', 'group');
          row.setAttribute('aria-label', 'Suggested replies');
          pills.forEach(function (pill) {
            var pb = el('button', 'cx-reply', pill.show);
            pb.type = 'button';
            pb.addEventListener('click', function () {
              if (streaming) { return; }
              row.classList.add('cx-replies-used');
              var bs = row.querySelectorAll('button');
              for (var bi = 0; bi < bs.length; bi++) { bs[bi].disabled = true; }
              entryMode = 'pill';
              sendMessage(pill.send); /* the full label, even when the button shows an ellipsis */
            });
            row.appendChild(pb);
          });
          frag.appendChild(row);
        }
        continue;
      }

      /* {{form:slug:serial}} or serial-less {{form:slug}} line — structured
         input defined in the Studio. The serial is present for signed-in
         register-edit forms (address-change, etc.) and ABSENT for anonymous
         inquiry forms (make-an-offer, book-a-viewing → submit_inquiry). */
      var fm = /^\{\{form:([a-z0-9-]{2,40})(?::(\d{1,6}))?\}\}$/.exec(trimmed);
      if (fm) {
        flushPara();
        var fdef = remoteForms[fm[1]];
        if (fdef) { frag.appendChild(buildChatForm(fm[1], fm[2] ? parseInt(fm[2], 10) : null, fdef)); }
        else {
          /* Unknown or disabled form slug: never drop the line silently — a
             reply that is ONLY this token would land as a blank bubble
             wearing feedback arrows. Ask for the details in words instead. */
          frag.appendChild(el('p', '',
            'The register can’t raise that card right now — tell me the details here and I’ll enter them by hand.'));
        }
        i++; continue;
      }

      /* Any OTHER {{token}} on its own line is internal plumbing the model
         leaked — an un-whitelisted action (e.g. a tool name like
         {{action:recall_context}}), a malformed form, etc. Swallow it so it
         never reaches the shopper as raw text. */
      if (/^\{\{[a-z_]+(?::[^}]*)?\}\}$/i.test(trimmed)) { i++; continue; }

      /* pipe table: needs header row + separator row */
      if (trimmed.charAt(0) === '|' && i + 1 < n && isTableSep(lines[i + 1])) {
        flushPara();
        var header = splitTableRow(trimmed);
        var rows = [];
        var j = i + 2;
        while (j < n) {
          var rt = lines[j].replace(/^\s+|\s+$/g, '');
          if (!rt || rt.charAt(0) !== '|') { break; }
          rows.push(splitTableRow(rt));
          j++;
        }
        var wrap = el('div', 'cx-tablewrap cx-fade-in');
        var table = document.createElement('table');
        var thead = document.createElement('thead');
        var trh = document.createElement('tr');
        var c;
        for (c = 0; c < header.length; c++) {
          var th = document.createElement('th');
          renderInline(header[c], th);
          trh.appendChild(th);
        }
        thead.appendChild(trh);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        var r;
        for (r = 0; r < rows.length; r++) {
          var tr = document.createElement('tr');
          for (c = 0; c < header.length; c++) {
            var td = document.createElement('td');
            renderInline(rows[r][c] != null ? rows[r][c] : '', td);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        frag.appendChild(wrap);
        i = j; continue;
      }

      /* unordered list */
      if (/^-\s+/.test(trimmed)) {
        flushPara();
        var ul = document.createElement('ul');
        while (i < n) {
          var ut = lines[i].replace(/^\s+|\s+$/g, '');
          if (!/^-\s+/.test(ut)) { break; }
          var li = document.createElement('li');
          renderInline(ut.replace(/^-\s+/, ''), li);
          ul.appendChild(li);
          i++;
        }
        frag.appendChild(ul);
        continue;
      }

      /* ordered list */
      if (/^\d+[.)]\s+/.test(trimmed)) {
        flushPara();
        var ol = document.createElement('ol');
        while (i < n) {
          var ot = lines[i].replace(/^\s+|\s+$/g, '');
          if (!/^\d+[.)]\s+/.test(ot)) { break; }
          var oli = document.createElement('li');
          renderInline(ot.replace(/^\d+[.)]\s+/, ''), oli);
          ol.appendChild(oli);
          i++;
        }
        frag.appendChild(ol);
        continue;
      }

      /* plain paragraph line */
      para.push(trimmed);
      i++;
    }
    flushPara();
    return markAsk(frag);
  }

  /* ----------------------------------------------------------
     4. Section tracking
  ---------------------------------------------------------- */
  var observedSection = SECTIONS[0];
  function currentSection() {
    var s = window.__porscheState;
    if (s && typeof s === 'object' && typeof s.section === 'string' && s.section) {
      return s.section;
    }
    return observedSection;
  }
  function initSectionObserver() {
    if (!('IntersectionObserver' in window)) { return; }
    var ratios = {};
    var io = new IntersectionObserver(function (entries) {
      var i;
      for (i = 0; i < entries.length; i++) {
        ratios[entries[i].target.id] = entries[i].isIntersecting ? entries[i].intersectionRatio : 0;
      }
      var best = null, bestR = 0, id;
      for (id in ratios) {
        if (ratios.hasOwnProperty(id) && ratios[id] > bestR) { bestR = ratios[id]; best = id; }
      }
      if (best && best !== observedSection) {
        observedSection = best;
        onSectionChange(best);
      } else if (best) {
        observedSection = best;
      }
    }, { threshold: [0, 0.15, 0.3, 0.5, 0.75, 1] });
    var i, node;
    for (i = 0; i < SECTIONS.length; i++) {
      node = document.getElementById(SECTIONS[i]);
      if (node) { io.observe(node); }
    }
  }

  /* ----------------------------------------------------------
     5. UI construction
  ---------------------------------------------------------- */
  var launcher, chipEl, scrim, panel, msgsEl, inputEl, sendBtn, newPill, statusDot, wrapRow;
  var authMailEl = null, authBtn = null, authRow = null;
  var roots = [];

  function syncReduced() {
    var i;
    for (i = 0; i < roots.length; i++) {
      if (roots[i]) {
        if (REDUCED) { roots[i].classList.add('cx-reduced'); }
        else { roots[i].classList.remove('cx-reduced'); }
      }
    }
  }

  function buildUI() {
    /* launcher */
    launcher = el('button', 'cx-launch');
    launcher.id = 'cx-launch';
    launcher.type = 'button';
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.setAttribute('aria-label', 'Ask about the car — open product concierge');
    launcher.appendChild(el('span', 'cx-star', '✳'));
    launcher.appendChild(el('span', 'cx-label', 'Ask about the car'));
    launcher.addEventListener('click', function () {
      if (pendingSay && !history.length) {
        entryMode = 'outreach:' + (pendingKind || 'launcher');
        history.push({ role: 'assistant', content: pendingSay, ts: Date.now() });
        saveHistory();
      }
      pendingSay = ''; pendingKind = '';
      clearLauncherUnread();
      openPanel();
    });

    /* context chip (built lazily on show) */

    /* scrim */
    scrim = el('div', 'cx-scrim');
    scrim.addEventListener('click', function () { closePanel(); });

    /* panel */
    panel = el('aside', 'cx-panel');
    panel.id = 'cx-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Product concierge');
    panel.setAttribute('tabindex', '-1');

    var handle = el('div', 'cx-handle');
    handle.setAttribute('aria-hidden', 'true');
    panel.appendChild(handle);

    /* header */
    var head = el('header', 'cx-head');
    head.appendChild(stampImg('cx-stamp'));
    var headLeft = el('div', 'cx-headleft');
    headLeft.appendChild(el('h2', 'cx-title', 'The Porsche Concierge'));
    var sub = el('div', 'cx-sub');
    statusDot = el('span', 'cx-dot');
    syncStatusDot();
    sub.appendChild(statusDot);
    sub.appendChild(el('span', null, '2003 PORSCHE 911 TURBO'));
    headLeft.appendChild(sub);
    head.appendChild(headLeft);
    if (authEnabled()) {
      var authBox = el('div', 'cx-authbox');
      authMailEl = el('span', 'cx-authmail');
      authMailEl.style.display = 'none';
      authBox.appendChild(authMailEl);
      authBtn = el('button', 'cx-authlink', 'Sign in');
      authBtn.type = 'button';
      authBtn.addEventListener('click', onAuthLink);
      authBox.appendChild(authBtn);
      head.appendChild(authBox);
    }
    var closeBtn = el('button', 'cx-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close concierge');
    closeBtn.addEventListener('click', function () { closePanel(); });
    head.appendChild(closeBtn);
    panel.appendChild(head);

    /* messages */
    msgsEl = el('div', 'cx-msgs');
    msgsEl.setAttribute('aria-live', 'polite');
    panel.appendChild(msgsEl);

    /* composer */
    var compose = el('div', 'cx-compose');
    newPill = el('button', 'cx-newpill', '↓ new');
    newPill.type = 'button';
    newPill.addEventListener('click', function () {
      pinned = true;
      scrollToBottom(true);
      hideNewPill();
    });
    compose.appendChild(newPill);
    var row = el('div', 'cx-inputrow');
    inputEl = document.createElement('textarea');
    inputEl.className = 'cx-input';
    inputEl.rows = 1;
    inputEl.placeholder = 'Ask about the car…';
    inputEl.setAttribute('aria-label', 'Your question');
    inputEl.addEventListener('input', function () { lastTypeTs = Date.now(); autogrow(); });
    inputEl.addEventListener('keydown', function (e) {
      lastTypeTs = Date.now();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitInput();
      }
    });
    row.appendChild(inputEl);

    /* A quiet "⋯" menu beside the send button: the visitor's own signals —
       pause me, or wrap up. The popover opens upward from the composer. */
    var menuWrap = el('div', 'cx-menuwrap');
    var menuBtn = el('button', 'cx-menu-btn', '⋯');
    menuBtn.type = 'button';
    menuBtn.setAttribute('aria-label', 'Conversation options');
    menuBtn.setAttribute('aria-haspopup', 'true');
    menuBtn.setAttribute('aria-expanded', 'false');
    var menuEl = el('div', 'cx-menu');
    menuEl.setAttribute('role', 'menu');
    menuEl.hidden = true;
    function closeMenu() {
      menuEl.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
    }
    function openMenu() {
      menuEl.hidden = false;
      menuBtn.setAttribute('aria-expanded', 'true');
    }
    menuBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (menuEl.hidden) { openMenu(); } else { closeMenu(); }
    });
    var quietItem = el('button', 'cx-menu-item', 'Don’t message me until I write back');
    quietItem.type = 'button';
    quietItem.setAttribute('role', 'menuitem');
    quietItem.addEventListener('click', function () { closeMenu(); enterQuietMode(); });
    var closeItem = el('button', 'cx-menu-item', 'That’s all for now');
    closeItem.type = 'button';
    closeItem.setAttribute('role', 'menuitem');
    closeItem.addEventListener('click', function () { closeMenu(); wrapUpByCustomer(); });
    menuEl.appendChild(quietItem);
    menuEl.appendChild(closeItem);
    document.addEventListener('click', function (ev) {
      if (!menuEl.hidden && ev.target !== menuBtn && !menuEl.contains(ev.target)) { closeMenu(); }
    });
    menuWrap.appendChild(menuBtn);
    menuWrap.appendChild(menuEl);
    row.appendChild(menuWrap);

    sendBtn = el('button', 'cx-send', '↑');
    sendBtn.type = 'button';
    sendBtn.setAttribute('aria-label', 'Send question');
    sendBtn.addEventListener('click', submitInput);
    row.appendChild(sendBtn);
    compose.appendChild(row);
    panel.appendChild(compose);

    /* footer — with an optional admin-set Privacy link (inquiry forms collect a
       name + contact, so a privacy notice is a real obligation, not decoration) */
    var foot = el('div', 'cx-foot',
      'An automated AI concierge — answers by Anthropic\'s Claude · advice, not warranty · mberenji@gmail.com');
    if (remotePrivacyUrl && safeUrl(remotePrivacyUrl)) {
      foot.appendChild(document.createTextNode(' · '));
      var priv = el('a', 'cx-foot-privacy', 'Privacy');
      priv.setAttribute('href', remotePrivacyUrl);
      priv.setAttribute('target', '_blank');
      priv.setAttribute('rel', 'noopener noreferrer');
      foot.appendChild(priv);
    }
    panel.appendChild(foot);

    document.body.appendChild(launcher);
    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    roots = [launcher, scrim, panel];
    syncReduced();

    msgsEl.addEventListener('scroll', onMsgsScroll);
    initDrag(handle, head);
    panel.addEventListener('keydown', trapFocus);
  }

  function autogrow() {
    inputEl.style.height = 'auto';
    var max = 3 * 1.5 * 16 + 14; /* ~3 lines */
    var h = Math.min(inputEl.scrollHeight, max);
    inputEl.style.height = h + 'px';
  }

  /* ----------------------------------------------------------
     5b. Outreach — the concierge initiates, visibly, chat closed or not.
     Tap: the line becomes the concierge's own message and the panel opens.
     Caps: at most 2 ambient outreaches per session; congrats are exempt;
     each kind shows once per session.
  ---------------------------------------------------------- */
  var outreachEl = null;
  var pendingSay = '';          /* an outreach line not yet seen in the panel */
  var pendingKind = '';

  function orCfg() {
    /* admin-set timings (from ?config=1) win; fall back to the static window
       config, then to the built-in defaults each caller supplies */
    if (remoteOutreach && typeof remoteOutreach === 'object') { return remoteOutreach; }
    var c = cfg().outreach;
    return (c && typeof c === 'object') ? c : {};
  }
  function orSeen(kind) {
    try { return !!window.sessionStorage.getItem('cx-or-' + kind); } catch (e) { return true; }
  }
  function orMark(kind) {
    try { window.sessionStorage.setItem('cx-or-' + kind, '1'); } catch (e) { /* ignore */ }
  }
  function orCount() {
    try { return parseInt(window.sessionStorage.getItem('cx-or-n') || '0', 10) || 0; } catch (e) { return 9; }
  }
  function orBump() {
    try { window.sessionStorage.setItem('cx-or-n', String(orCount() + 1)); } catch (e) { /* ignore */ }
  }

  function markLauncherUnread(text) {
    if (!launcher) { return; }
    launcher.classList.add('cx-unread');
    /* an unread reach-out must be visible even if they haven't scrolled */
    if (!panelOpen) { launcher.classList.add('cx-on'); }
    try { launcher.setAttribute('data-cx-say', String(text).slice(0, 140)); } catch (e) { /* ignore */ }
  }
  function clearLauncherUnread() {
    if (!launcher) { return; }
    launcher.classList.remove('cx-unread');
    try { launcher.removeAttribute('data-cx-say'); } catch (e) { /* ignore */ }
  }

  function orDismissAll() {
    if (outreachEl) {
      try { outreachEl.remove(); } catch (e) { /* ignore */ }
      outreachEl = null;
    }
    pendingSay = '';
    clearLauncherUnread();
  }

  /* Returns true only if a bubble actually rendered (so callers like the
     welcome-back can avoid marking themselves 'done' when they silently bailed).
     `repeatable` skips the once-per-session seen-guard for beats that manage
     their own budget (re-engagement). */
  function showOutreach(kind, text, exempt, repeatable) {
    if (!text || panelOpen) { return false; }
    if (checkoutOpen()) { noteSkip('bubble(' + kind + '): the register sheet is open — never interrupt an order'); return false; }
    if (outreachEl) { noteSkip('bubble(' + kind + '): another outreach bubble is already on screen'); return false; }
    if (quietMode) { noteSkip('bubble(' + kind + '): QUIET MODE is on for this tab'); return false; }
    if (!repeatable && orSeen(kind)) { noteSkip('bubble(' + kind + '): already shown this visit — one-time bubbles never repeat'); return false; }
    /* ambient reach-out budget: admin maxAmbient wins, else scales with
       assertiveness (driving settings earn one more knock). */
    var oc = orCfg();
    var ambientCap = (typeof oc.maxAmbient === 'number') ? oc.maxAmbient : (assertLevel() >= 4 ? 3 : 2);
    if (!exempt && orCount() >= ambientCap) { noteSkip('bubble(' + kind + '): ambient reach-out budget spent (' + orCount() + '/' + ambientCap + ')'); return false; }
    if (!repeatable) { orMark(kind); }
    if (!exempt) { orBump(); }
    /* the launcher carries an unread mark until the visitor engages */
    markLauncherUnread(text);
    pendingSay = text; pendingKind = kind;

    var b = el('div', 'cx-outreach');
    b.setAttribute('role', 'status');
    b.appendChild(stampImg(''));
    b.appendChild(el('span', 'cx-or-text', text));
    var x = el('button', 'cx-or-x', '\u00d7');
    x.setAttribute('aria-label', 'Dismiss');
    x.addEventListener('click', function (ev) {
      ev.stopPropagation();
      b.remove();
      outreachEl = null;
    });
    b.appendChild(x);
    function openFromOutreach() {
      /* do the bookkeeping defensively, but ALWAYS open the panel */
      try {
        b.remove();
        outreachEl = null;
        clearLauncherUnread();
        pendingSay = '';
        entryMode = 'outreach:' + kind;
        var lastH = history.length ? history[history.length - 1] : null;
        if (!lastH || lastH.content !== text) {   /* may already be in the transcript */
          history.push({ role: 'assistant', content: text, ts: Date.now() });
          saveHistory();
        }
      } catch (eOR) { /* never let bookkeeping block the open */ }
      openPanel();
    }
    b.addEventListener('click', openFromOutreach);
    document.body.appendChild(b);
    outreachEl = b;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { b.classList.add('cx-on'); });
    });
    /* an unheeded outreach withdraws on its own — snooze, not siege */
    setTimeout(function () {
      if (outreachEl === b) {
        b.classList.remove('cx-on');
        setTimeout(function () { b.remove(); if (outreachEl === b) { outreachEl = null; } }, 700);
      }
    }, (typeof oc.bubbleWithdrawMs === 'number' && oc.bubbleWithdrawMs > 0) ? oc.bubbleWithdrawMs : 22000);
    return true;
  }

  /* congrats after a commission — waits for the register card to be put down */
  window.addEventListener('ck:commissioned', function (ev) {
    var d = (ev && ev.detail) || {};
    /* Persist a marker so the NEXT visit/refresh can check back \u2014 the immediate
       congrats below fires now; the post-purchase check-in fires next load. */
    try {
      window.localStorage.setItem('porsche_last_purchase', JSON.stringify({
        serial: d.serial || null, count: d.count || 1, ts: Date.now()
      }));
    } catch (ePM) { /* ignore */ }
    var no = d.serial ? 'N\u00ba ' + Number(d.serial).toLocaleString('en-US') : 'Your number';
    var line = 'Congratulations \u2014 ' + no + ' is entered in the workshop ledger under your name.';
    if (d.count === 1) {
      line += ' When it ships, the tracking will be right here with me.';
    } else if (d.count === 2) {
      line += ' That makes you a returning guest — the house notices.';
    } else if (d.count >= 5) {
      line += ' A patron of the house — the owner knows your name by now.';
    } else if (d.count >= 3) {
      line += ' A friend of the house — always welcome at the desk.';
    }
    var tries = 0;
    var waitClose = setInterval(function () {
      tries++;
      var sheetOpen = document.querySelector('.ck-panel.ck-open');
      if (!sheetOpen || tries > 120) {
        clearInterval(waitClose);
        try { window.sessionStorage.removeItem('cx-or-congrats'); } catch (e) { /* re-arm per sale */ }
        setTimeout(function () {
          /* Guarantee the congratulations lands. Put it in the transcript (so it's
             there the moment they look at the chat), render it now if the panel is
             open — the common case, since the commission button lives in the open
             chat — and raise the bubble as a heads-up only when the panel is closed.
             The old behaviour was bubble-only, which showOutreach suppresses while
             the panel is open, so a purchase made from the chat got no congrats. */
          try {
            var last = history.length ? history[history.length - 1] : null;
            if (!last || last.content !== line) {
              history.push({ role: 'assistant', content: line, ts: Date.now() });
              saveHistory();
            }
          } catch (eH) { /* ignore */ }
          if (panelOpen && msgsEl && !streaming) {
            try { renderHistory(); scrollToBottom(false); } catch (eR) { /* ignore */ }
          } else if (!panelOpen) {
            showOutreach('congrats', line, true);
          }
        }, 1200);
      }
    }, 1000);
  });

  /* Post-purchase check-back — the piece that was missing. On a LATER load
     (a refresh or return visit) after a recent commission, the concierge
     reaches out once to make sure every need was met and to open the next
     door. Fires from a persisted marker, so it survives the refresh; the
     immediate congrats above handles the purchase moment itself. */
  (function () {
    var mark = null;
    try { mark = JSON.parse(window.localStorage.getItem('porsche_last_purchase') || 'null'); } catch (e) { mark = null; }
    if (!mark || !mark.ts) { return; }
    var age = Date.now() - mark.ts;
    if (age > 48 * 3600000) { return; }            /* only recent purchases */
    var doneKey = 'porsche_checkin_' + (mark.serial || 'x');
    try { if (window.localStorage.getItem(doneKey) === '1') { return; } } catch (e2) { /* ignore */ }
    setTimeout(function () {
      if (panelOpen || quietMode) { noteSkip('post-purchase check-in: stood down (' + (panelOpen ? 'panel open' : 'quiet mode') + ') — stays un-marked, a later reload retries'); return; }
      var no = mark.serial ? 'Nº ' + Number(mark.serial).toLocaleString('en-US') : 'your number';
      var line = 'Welcome back — ' + no + ' is safely in the ledger. Before anything else: is ' +
        'there anything you still need from me? A delivery detail, a companion car for another ' +
        'room, or anything about the making.';
      /* Only mark it done once the bubble actually rendered — otherwise (panel
         open, another bubble showing) leave it un-marked so a later refresh
         gets another chance. This is the reliability fix. */
      if (showOutreach('checkin-' + (mark.serial || 'x'), line, true)) {
        try { window.localStorage.setItem(doneKey, '1'); } catch (e3) { /* ignore */ }
      }
    }, 7000);
  })();

  /* a dwell opener — one considered line, once, after real attention */
  (function () {
    var dwellMs = typeof orCfg().dwellMs === 'number' ? orCfg().dwellMs : 45000;
    setTimeout(function () {
      if (panelOpen || history.length) { noteSkip('dwell opener: stood down — ' + (panelOpen ? 'the panel is open' : 'a conversation already exists') + ' (one-shot, will not retry)'); return; }
      /* Reach out to an idle visitor even if they haven't scrolled — the dwell
         time is itself the "they're here and lingering" signal. Admins can turn
         this off (idleReach:false) to require a scroll first, as before. */
      var y = window.scrollY || window.pageYOffset || 0;
      if (orCfg().idleReach === false && y < window.innerHeight * 0.5) { noteSkip('dwell opener: idleReach is OFF in admin and the page has not been scrolled past half a screen (one-shot, will not retry)'); return; }
      var sec = currentSection();
      var lines = {
        'what-makes-it-special': 'Good evening. The car you\u2019re reading about \u2014 I’m happy to answer anything about it.',
        'sec-20-407-invested-all-documented': 'Good evening. Care questions are my favorite kind \u2014 ask me anything.',
        'every-angle-every-light': 'Good evening. If this one is meant as a gift, I can arrange a card in another name.',
        'serious-buyers-get-serious-answers': 'Good evening. I\u2019m right here \u2014 ask me anything about it.'
      };
      showOutreach('dwell', lines[sec] ||
        'Good evening. I\u2019m the concierge for 2003 Porsche 911 Turbo \u2014 ask me anything about it.');
    }, dwellMs);
  })();

  /* a second, later beat for a reader who lingers but hasn't opened the panel —
     desire-building, not a repeat. Only at a warm-or-driving assertiveness (>=3),
     and only if the ambient budget still allows it. */
  (function () {
    var dwellMs = typeof orCfg().dwellMs === 'number' ? orCfg().dwellMs : 45000;
    var dwell2Ms = typeof orCfg().dwell2Ms === 'number' ? orCfg().dwell2Ms : Math.round(dwellMs * 2.4);
    setTimeout(function () {
      if (panelOpen || history.length || orSeen('dwell2') || assertLevel() < 3) {
        noteSkip('dwell2 beat: stood down — ' + (panelOpen ? 'panel open' : history.length ? 'conversation exists' : orSeen('dwell2') ? 'already shown this visit' : 'assertiveness below Warm (3) in admin') + ' (one-shot, will not retry)');
        return;
      }
      if (orCfg().idleReach === false) {
        var y = window.scrollY || window.pageYOffset || 0;
        if (y < window.innerHeight * 0.5) { noteSkip('dwell2 beat: idleReach is OFF in admin and the page has not been scrolled past half a screen (one-shot, will not retry)'); return; }
      }
      var sec = currentSection();
      var lines = {
        'what-makes-it-special': 'Still with the car? I’m happy to help whenever you like.',
        'every-angle-every-light': 'If a name should go on the card, I can arrange that too.',
        'serious-buyers-get-serious-answers': 'Your number is still held. When you’re ready I can open the ledger in a moment — no payment, this is a demonstration.'
      };
      showOutreach('dwell2', lines[sec] ||
        'One more thought — I’m right here whenever you’d like to talk it through.');
    }, dwell2Ms);
  })();

  /* a half-written entry — offer to finish it together */
  (function () {
    var draftMs = typeof orCfg().draftMs === 'number' ? orCfg().draftMs : 25000;
    var check = setInterval(function () {
      if (orSeen('draft')) { clearInterval(check); return; }
      if (panelOpen || document.querySelector('.ck-panel.ck-open')) { return; }
      var draft = null;
      try { draft = JSON.parse(window.sessionStorage.getItem('ck-draft') || 'null'); } catch (e) { draft = null; }
      if (!draft || !draft.act || draft.act < 2) { return; }
      clearInterval(check);
      showOutreach('draft',
        'Your entry rests half-written in the register \u2014 your number is still held. Shall we finish it together?');
    }, draftMs);
  })();

  /* ----------------------------------------------------------
     6. Launcher visibility & scroll choreography
  ---------------------------------------------------------- */
  var lastY = 0, idleTimer = null, tucked = false;

  function updateLauncher() {
    if (!launcher) { return; }
    if (panelOpen) {
      launcher.classList.remove('cx-on');
      return;
    }
    var eligible = (window.scrollY || window.pageYOffset || 0) > window.innerHeight * 0.6;
    /* keep it up while a reach-out is waiting, wherever they've scrolled to */
    if (eligible || launcher.classList.contains('cx-unread')) { launcher.classList.add('cx-on'); }
    else { launcher.classList.remove('cx-on'); }
    if (currentSection() === 'reserve') { launcher.classList.add('cx-dock'); }
    else { launcher.classList.remove('cx-dock'); }
    if (tucked) { launcher.classList.add('cx-tuck'); }
    else { launcher.classList.remove('cx-tuck'); }
  }

  function onScroll() {
    var y = window.scrollY || window.pageYOffset || 0;
    var dy = y - lastY;
    lastY = y;
    if (dy > 4) { tucked = true; }
    else if (dy < -4) { tucked = false; }
    if (idleTimer) { clearTimeout(idleTimer); }
    idleTimer = setTimeout(function () { tucked = false; updateLauncher(); }, 900);
    updateLauncher();
  }

  /* ----------------------------------------------------------
     7. Context chips (dwell nudge)
  ---------------------------------------------------------- */
  var dwellTimer = null, chipHideTimer = null;

  function ssGet(key) {
    try { return window.sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function ssSet(key, val) {
    try { window.sessionStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }
  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }
  function lsDel(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  /* Per-pageview chip state — in memory, so a reload starts fresh and the
     nudges behave predictably. Caps (all admin-configurable via outreach):
     chipCap per view, once per section unless chipRepeatMs re-arms it,
     chipLingerMs on screen. */
  var chipShownCount = 0;
  var chipSeenAt = {};          /* section id -> when its chip last showed */
  var CHIP_CAP = 5;
  var CHIP_DWELL_MS = 1100;
  var CHIP_LINGER_MS = 9000;
  function chipCfg() {
    var o = orCfg();
    return {
      cap: (typeof o.chipCap === 'number' && o.chipCap >= 0) ? o.chipCap : CHIP_CAP,
      dwell: (typeof o.chipDwellMs === 'number' && o.chipDwellMs >= 0) ? o.chipDwellMs : CHIP_DWELL_MS,
      linger: (typeof o.chipLingerMs === 'number' && o.chipLingerMs > 0) ? o.chipLingerMs : CHIP_LINGER_MS,
      repeat: (typeof o.chipRepeatMs === 'number' && o.chipRepeatMs > 0) ? o.chipRepeatMs : 0
    };
  }

  function onSectionChange(sectionId) {
    updateLauncher();
    if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
    hideChip();
    if (panelOpen) { return; }
    var cc = chipCfg();
    if (chipShownCount >= cc.cap) { return; }
    var seenTs = chipSeenAt[sectionId];
    /* once per section per view — unless the admin allows a re-show after
       chipRepeatMs (the "it stopped appearing" dial) */
    if (seenTs && (!cc.repeat || (Date.now() - seenTs) < cc.repeat)) { return; }
    var sugg = suggestedMap();
    if (!sugg) { return; }
    var list = sugg[sectionId];
    if (Object.prototype.toString.call(list) !== '[object Array]' || !list.length) { return; }
    var question = String(list[0]);
    dwellTimer = setTimeout(function () {
      dwellTimer = null;
      if (panelOpen || currentSection() !== sectionId || chipShownCount >= chipCfg().cap) { return; }
      showChip(sectionId, question);
    }, cc.dwell);
  }

  function showChip(sectionId, question) {
    hideChip();
    chipSeenAt[sectionId] = Date.now();
    chipShownCount++;
    chipEl = el('button', 'cx-chip', question);
    chipEl.type = 'button';
    if (REDUCED) { chipEl.classList.add('cx-reduced'); }
    chipEl.addEventListener('click', function () {
      var q = question;
      hideChip();
      openPanel(q);
    });
    document.body.appendChild(chipEl);
    /* force layout, then fade in */
    void chipEl.offsetWidth;
    chipEl.classList.add('cx-on');
    chipHideTimer = setTimeout(hideChip, chipCfg().linger);
  }

  function hideChip() {
    if (chipHideTimer) { clearTimeout(chipHideTimer); chipHideTimer = null; }
    if (chipEl && chipEl.parentNode) {
      var node = chipEl;
      chipEl = null;
      node.classList.remove('cx-on');
      if (REDUCED) {
        if (node.parentNode) { node.parentNode.removeChild(node); }
      } else {
        setTimeout(function () {
          if (node.parentNode) { node.parentNode.removeChild(node); }
        }, 650);
      }
    } else {
      chipEl = null;
    }
  }

  /* ----------------------------------------------------------
     8. History (sessionStorage)
  ---------------------------------------------------------- */
  var history = [];

  function loadHistory() {
    try {
      var raw = ssGet(HISTORY_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (Object.prototype.toString.call(arr) !== '[object Array]') { arr = []; }
      history = [];
      var i, t;
      for (i = 0; i < arr.length; i++) {
        t = arr[i];
        if (t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string') {
          history.push({ role: t.role, content: t.content, ts: (typeof t.ts === 'number') ? t.ts : 0 });
        }
      }
    } catch (e) { history = []; }
  }
  function saveHistory() {
    if (history.length > HISTORY_CAP) { history = history.slice(history.length - HISTORY_CAP); }
    ssSet(HISTORY_KEY, JSON.stringify(history));
    ssSet(OWNER_KEY, authEmail || '');   /* tag whose conversation this is */
    /* A signed-in patron's transcript also survives the TAB: kept device-side,
       keyed to their identity, so closing and reopening doesn't lose the thread
       — for them or for the bot (which otherwise repeats itself against an
       empty transcript). Anonymous chats stay per-tab for privacy; the keep is
       wiped on sign-out / identity change (resetConversation). */
    if (authEmail) {
      lsSet(KEEP_KEY, JSON.stringify({ owner: authEmail, ts: Date.now(), turns: history }));
    }
  }
  var KEEP_KEY = 'cx-history-keep';
  function keepWindowMs() {
    var o = orCfg();
    return (typeof o.historyKeepMs === 'number' && o.historyKeepMs > 0) ? o.historyKeepMs : 7 * 86400000;
  }
  /* Adopt the kept transcript for this identity when the tab has none of its
     own. Runs whenever a signed-in identity resolves; a stale keep (older than
     the admin's window) is discarded instead of resurrected. */
  function restoreKeptHistory() {
    if (!authEmail || history.length || storedHistoryLen() > 0) { return; }
    var stash = null;
    try { stash = JSON.parse(lsGet(KEEP_KEY) || 'null'); } catch (eKH) { stash = null; }
    if (!stash || stash.owner !== authEmail) { return; }
    if (typeof stash.ts !== 'number' || (Date.now() - stash.ts) > keepWindowMs()) { lsDel(KEEP_KEY); return; }
    var turns = stash.turns, i, t;
    if (Object.prototype.toString.call(turns) !== '[object Array]' || !turns.length) { return; }
    for (i = 0; i < turns.length; i++) {
      t = turns[i];
      if (t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string') {
        history.push({ role: t.role, content: t.content, ts: (typeof t.ts === 'number') ? t.ts : 0 });
      }
    }
    if (history.length) {
      saveHistory();
      if (panelOpen && msgsEl) { renderHistory(); }
    }
  }
  function storedHistoryLen() {
    try { var a = JSON.parse(ssGet(HISTORY_KEY) || '[]'); return (Object.prototype.toString.call(a) === '[object Array]') ? a.length : 0; } catch (e) { return 0; }
  }

  /* ----------------------------------------------------------
     9. Message rendering
  ---------------------------------------------------------- */
  var pinned = true;

  function scrollToBottom(force) {
    if (!msgsEl) { return; }
    if (pinned || force) { msgsEl.scrollTop = msgsEl.scrollHeight; }
    else { showNewPill(); }
  }
  function onMsgsScroll() {
    var slack = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight;
    var wasPinned = pinned;
    pinned = slack < 48;
    if (pinned && !wasPinned) { hideNewPill(); }
  }
  function showNewPill() { if (newPill) { newPill.classList.add('cx-on'); } }
  function hideNewPill() { if (newPill) { newPill.classList.remove('cx-on'); } }

  var lastTurnTs = 0;           /* when the last visible turn was placed */
  var DIVIDER_MS = 20000;      /* a pause longer than this earns a time marker */

  function relGap(ms) {
    var m = Math.round(ms / 60000);
    if (ms < 90000) { return 'a moment later'; }
    if (m < 60) { return m + ' minutes later'; }
    var h = Math.round(m / 60);
    if (h < 24) { return h === 1 ? 'an hour later' : h + ' hours later'; }
    return 'later';
  }

  /* Insert a divider before the next turn when real time has passed — so a
     re-engagement reads as the concierge coming back, not one long message. */
  function maybeTimeDivider(ts) {
    if (!lastTurnTs) { lastTurnTs = ts; return; }
    var gap = ts - lastTurnTs;
    lastTurnTs = ts;
    if (gap < DIVIDER_MS) { return; }
    var d = el('div', 'cx-timedivider');
    d.setAttribute('aria-hidden', 'true');
    d.appendChild(el('span', null, relGap(gap)));
    msgsEl.appendChild(d);
  }

  function addUserTurn(text) {
    maybeTimeDivider(Date.now());
    var turn = el('div', 'cx-turn cx-turn-user', text);
    msgsEl.appendChild(turn);
    scrollToBottom(false);
    return turn;
  }

  function addAssistantShell() {
    maybeTimeDivider(Date.now());
    var turn = el('div', 'cx-turn cx-turn-assistant');
    var body = el('div', 'cx-pre');
    turn.appendChild(body);
    msgsEl.appendChild(turn);
    var buffer = '';          /* everything received */
    var queue = '';           /* received but not yet woven into the DOM */
    var loom = null;          /* drain interval */
    var ended = false;        /* stream finished; finalize when queue drains */
    var started = false;
    var caret = el('span', 'cx-caret');
    caret.setAttribute('aria-hidden', 'true');
    var dots = el('span', 'cx-dots');
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    var statusEl = el('span', 'cx-status');
    var think = el('span', 'cx-think');
    think.setAttribute('aria-hidden', 'true');
    think.appendChild(stampImg('cx-stamp-mini'));
    think.appendChild(dots);
    think.appendChild(statusEl);
    if (!REDUCED) { body.appendChild(think); }
    scrollToBottom(false);

    function beginWeave() {
      if (started) { return; }
      started = true;
      if (think.parentNode) { think.parentNode.removeChild(think); }
      body.appendChild(caret);
    }
    /* Weave one word (with its leading whitespace) before the caret. */
    function placeNext() {
      var m = queue.match(/^\s*\S+\s?|^\s+/);
      if (!m) { return false; }
      var tok = m[0];
      queue = queue.slice(tok.length);
      var node = el('span', 'cx-w', tok);
      body.insertBefore(node, caret);
      void node.offsetWidth;
      node.className = 'cx-w cx-w-in';
      return true;
    }
    function finalize() {
      if (loom) { clearInterval(loom); loom = null; }
      while (body.firstChild) { body.removeChild(body.firstChild); }
      body.className = '';
      body.appendChild(mdRender(buffer));
      if (!REDUCED) { body.classList.add('cx-fade-in'); }
      scrollToBottom(false);
    }
    /* Steady drain: ~1 word / 36ms, weaving faster when a burst backs up. */
    function ensureLoom() {
      if (loom) { return; }
      loom = setInterval(function () {
        var steps = 1 + Math.min(3, Math.floor(queue.length / 140));
        var wove = false, i;
        for (i = 0; i < steps; i++) { if (placeNext()) { wove = true; } }
        if (wove) { scrollToBottom(false); }
        if (!queue.length) {
          clearInterval(loom); loom = null;
          if (ended) { finalize(); }
        }
      }, 36);
    }

    return {
      turn: turn,
      getText: function () { return buffer; },
      /* server status caption ("Reading the register…") shown by the
         thinking dots until the first text chunk starts the weave */
      status: function (text) {
        if (started) { return; }
        statusEl.textContent = String(text || '');
        scrollToBottom(false);
      },
      append: function (chunk) {
        buffer += chunk;
        if (REDUCED) {
          /* reduced motion: plain immediate text, no weave */
          beginWeave();
          while (body.firstChild) { body.removeChild(body.firstChild); }
          body.appendChild(document.createTextNode(buffer));
          scrollToBottom(false);
          return;
        }
        queue += chunk;
        beginWeave();
        ensureLoom();
      },
      done: function () {
        ended = true;
        if (REDUCED || (!queue.length && !loom)) { finalize(); }
        /* otherwise the loom finalizes when the queue drains */
      },
      fail: function () {
        ended = true;
        if (loom) { clearInterval(loom); loom = null; }
        while (body.firstChild) { body.removeChild(body.firstChild); }
        if (buffer) {
          body.className = '';
          body.appendChild(mdRender(buffer));
        } else if (turn.parentNode) {
          turn.parentNode.removeChild(turn);
        }
      }
    };
  }

  function addSysLine(text) {
    var turn = el('div', 'cx-turn cx-sysline', text);
    msgsEl.appendChild(turn);
    scrollToBottom(false);
    return turn;
  }

  function addSuggestChips(questions) {
    var list = [], j, seen = {};
    function push(q) { q = String(q); if (q && !seen[q]) { seen[q] = true; list.push(q); } }
    /* Signed in: lead with context-aware starters built from their own orders
       (from ?starters=1); fall back to the generic "track" chip if none loaded. */
    if (authEmail) {
      if (personalStarters && personalStarters.length) {
        for (j = 0; j < personalStarters.length; j++) { push(personalStarters[j]); }
      } else {
        push(TRACK_QUESTION);
      }
    }
    if (questions && questions.length) {
      for (j = 0; j < questions.length; j++) { push(questions[j]); }
    }
    if (!list.length) { return; }
    var cap = authEmail ? 4 : 3;
    var box = el('div', 'cx-suggest');
    var i;
    for (i = 0; i < list.length && i < cap; i++) {
      (function (q) {
        var b = el('button', 'cx-sbtn', q);
        b.type = 'button';
        b.addEventListener('click', function () {
          if (box.parentNode) { box.parentNode.removeChild(box); }
          sendMessage(String(q));
        });
        box.appendChild(b);
      })(String(list[i]));
    }
    msgsEl.appendChild(box);
    scrollToBottom(false);
  }

  function addRetryChip() {
    var box = el('div', 'cx-suggest');
    var b = el('button', 'cx-sbtn', 'Retry');
    b.type = 'button';
    b.addEventListener('click', function () {
      if (box.parentNode) { box.parentNode.removeChild(box); }
      resendLast();
    });
    box.appendChild(b);
    msgsEl.appendChild(box);
    scrollToBottom(false);
  }

  function renderHistory() {
    /* the auth row lives IN the flow now — a re-render wipes it with the rest */
    if (authRow && msgsEl.contains(authRow)) { authRow = null; }
    while (msgsEl.firstChild) { msgsEl.removeChild(msgsEl.firstChild); }
    if (!history.length) {
      var greet = el('div', 'cx-turn cx-turn-assistant');
      greet.appendChild(mdRender(kbGreeting()));
      if (authEmail) {
        greet.appendChild(el('div', 'cx-signedline', 'Signed in as ' + authEmail + '.'));
      }
      msgsEl.appendChild(greet);
      addSuggestChips(kbSuggested(currentSection()));
      updateWrapPill();
      return;
    }
    var i, t, prevTs = 0;
    for (i = 0; i < history.length; i++) {
      t = history[i];
      if (prevTs && t.ts && (t.ts - prevTs) >= DIVIDER_MS) {
        var d = el('div', 'cx-timedivider');
        d.setAttribute('aria-hidden', 'true');
        d.appendChild(el('span', null, relGap(t.ts - prevTs)));
        msgsEl.appendChild(d);
      }
      if (t.ts) { prevTs = t.ts; }
      if (t.role === 'user') {
        msgsEl.appendChild(el('div', 'cx-turn cx-turn-user', t.content));
      } else {
        var turn = el('div', 'cx-turn cx-turn-assistant');
        var rendered = mdRender(t.content);
        /* a legacy plumbing-only line already persisted before the blank-bubble
           guard existed would re-render as an empty bubble forever — skip it */
        if (!((rendered.textContent || '').replace(/\s+/g, '')) &&
            !(rendered.querySelector && rendered.querySelector('.cx-form,.cx-actionrow,.cx-replies,img,button'))) {
          continue;
        }
        turn.appendChild(rendered);
        msgsEl.appendChild(turn);
      }
    }
    if (history.length) { lastTurnTs = history[history.length - 1].ts || Date.now(); }
    updateWrapPill();
  }

  /* ----------------------------------------------------------
     10. Transport
  ---------------------------------------------------------- */
  var streaming = false;
  var proactiveStream = false;  /* the current stream is the bot speaking on its own */
  var currentAbort = null;
  var demoTimers = [];
  var nudgeTimer = null;        /* silence timer while the panel is open */
  var nudgeArmedMs = 0;         /* the wait the CURRENT timer was armed with (diagnostics) */
  var nudgeArmedAt = 0;         /* when it was armed (ms epoch) */
  var nudgeArmedWhy = '';       /* the arithmetic of that arm (rung, dial, floor, overrides) */
  var nudgeCount = 0;           /* proactive follow-ups since the visitor last spoke */
  var pendingNudge = null;      /* {seconds,count} carried into the next request */
  var pendingOpener = null;     /* 'reengage' | 'greet' — carried into the next request */
  var reengagedThisOpen = false;/* the bot has already opened contextually this panel session */
  var unacked = 0;              /* proactive reach-outs since the visitor last showed a sign of life */
  var lastActivityTs = 0;       /* when the visitor last did something real */
  var hadActivity = false;      /* any real activity this visit (gates re-engagement) */
  var activeSinceReengage = false; /* fresh activity since the last re-engage reach-out */
  var reengageCount = 0;        /* closed-panel re-engagements fired this visit */

  /* Any sign the visitor is actually present — a scroll, tap, key, or the tab
     coming back into view. This is our stand-in for a read receipt: it clears
     the "unacknowledged" count so the concierge resumes a light presence, and
     if it had gone quiet (paused), it picks the thread back up. It also stamps
     the activity clock the closed-panel re-engagement watches. */
  var lastActivitySrc = '';     /* WHAT last reset the idle clock (tap/key/scroll/…) */
  var maxIdleMs = 0;            /* longest idle span this visit — proves whether the
                                   re-engage threshold was ever actually reached */
  function noteActivity(src) {
    if (hadActivity && lastActivityTs) {
      var span = Date.now() - lastActivityTs;
      if (span > maxIdleMs) { maxIdleMs = span; }
    }
    lastActivitySrc = (typeof src === 'string' && src) ? src : 'activity';
    lastActivityTs = Date.now();
    hadActivity = true;
    activeSinceReengage = true;
    if (unacked !== 0) {
      unacked = 0;
      if (panelOpen && !streaming && !quietMode && !nudgeTimer) {
        /* re-opening a RESTED loop is a new chapter — the silent-hold streak
           starts over, so the "N/4 holds" readout never exceeds its budget
           (movement mid-streak doesn't get here: a timer is already armed) */
        holdAttempts = 0;
        scheduleNudge();
      }
    }
  }

  /* Reading time the last reply has earned: ~300ms per word of the newest
     assistant message, capped at 90s. The first follow-up rung never fires
     sooner — a beat that interrupts someone mid-paragraph reads as impatience,
     not attentiveness. */
  function readFloorMs() {
    var i, m = null;
    for (i = history.length - 1; i >= 0; i--) { if (history[i].role === 'assistant') { m = history[i]; break; } }
    if (!m || typeof m.content !== 'string') { return 0; }
    var words = m.content.split(/\s+/).filter(function (w) { return !!w; }).length;
    return Math.min(90000, words * 300);
  }

  /* Closed-panel re-engagement: when the visitor was active and then went idle
     (panel closed), reach out with a contextual line — the "they paused, notice
     it" beat. Cadence derives from the assertiveness dial (Attentive baseline),
     with per-audience admin overrides. Re-arms only on FRESH activity, so a
     visitor who truly left isn't nagged; one who's actively browsing gets a
     timely nudge. Signed-in patrons get a warmer, faster default than anons. */
  function reengageCfg() {
    var o = orCfg();
    var signed = !!authEmail;
    var mult = assertDelayMult();                 /* [1.5,1.25,1,0.8,0.65] by assertiveness */
    var idleMs = Math.round((signed ? 30000 : 40000) * mult);   /* Attentive baseline */
    var maxN = Math.max(0, (signed ? 3 : 2) + (assertLevel() - 3));
    var ci = signed ? o.reengageIdleSignedMs : o.reengageIdleAnonMs;   /* custom overrides win */
    var cm = signed ? o.reengageMaxSigned : o.reengageMaxAnon;
    if (typeof ci === 'number' && ci > 0) { idleMs = ci; }
    if (typeof cm === 'number' && cm >= 0) { maxN = cm; }
    return { idleMs: idleMs, max: maxN, enabled: o.reengageEnabled !== false };
  }
  function reengageLine(postSale) {
    if (postSale) {
      /* they already commissioned — invite a SECOND entry, never "still eyeing" */
      return authEmail
        ? 'Your number’s in the ledger. When you’re ready — anything else I can help you with?'
        : 'Your number is safely in the ledger. A companion car for another room, or one sent as a gift — I can arrange either.';
    }
    var sec = currentSection();
    if (authEmail) {
      var s = {
        'what-makes-it-special': 'Still weighing it? Ask me anything and I’ll help.',
        'serious-buyers-get-serious-answers': 'Your number is held while you decide — say the word and I’ll open the ledger.',
        'every-angle-every-light': 'Thinking it over? I’m here for any question whenever you like.'
      };
      return s[sec] || 'Still here whenever you’d like to pick this back up — anything I can pull up for you?';
    }
    var a = {
      'what-makes-it-special': 'Good evening — ask me anything about the car.',
      'sec-20-407-invested-all-documented': 'Questions about care or the making? Ask me anything.',
      'every-angle-every-light': 'If this one is a gift, the card can carry another name — I can arrange it.',
      'serious-buyers-get-serious-answers': 'Your number is held while you decide. Ask me anything about it.'
    };
    return a[sec] || 'Good evening — I’m the concierge for 2003 Porsche 911 Turbo. Ask me anything about it.';
  }
  var reengageBusy = false;
  var reengageBusyAt = 0;       /* watchdog: a hung compose must never mute the bubble */
  /* Ask the server for a goal + journey aware line (it reads the open goals and
     the section the visitor is in). Falls back to the client line on any failure
     so the beat still fires offline / if the endpoint is unavailable. */
  function fetchReengageLine(postSale, cb) {
    if (isDemo()) { cb(reengageLine(postSale)); return; }
    var body = JSON.stringify({ session_key: sessionKey(), section: currentSection(), post_sale: !!postSale });
    var url = endpoint() + (endpoint().indexOf('?') === -1 ? '?reengage=1' : '&reengage=1');
    getAccessToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) { headers['Authorization'] = 'Bearer ' + token; }
      fetch(url, { method: 'POST', headers: headers, body: body })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          /* a deliberate server hold — everything worth saying was said;
             stay SILENT rather than falling back to the canned line */
          if (j && j.hold) { cb(null); return; }
          cb(j && typeof j.text === 'string' && j.text ? j.text : reengageLine(postSale));
        })
        ['catch'](function () { cb(reengageLine(postSale)); });
    })['catch'](function () { cb(reengageLine(postSale)); });
  }
  function purchaseAgeMs() {
    try {
      var lp = JSON.parse(window.localStorage.getItem('porsche_last_purchase') || 'null');
      return (lp && lp.ts) ? (Date.now() - lp.ts) : null;
    } catch (e) { return null; }
  }
  /* Admin-tunable post-sale behaviour (from ?config outreach). The window sets
     the DURATION; postSaleMode picks what happens inside it:
       'upsell'   — re-engage for a second sale (companion / gift). Default.
       'presence' — keep the normal warm check-ins, no selling frame.
       'quiet'    — no bubble at all until the window passes (named in lastSkip).
     Legacy: reengagePostSaleEnabled=false (the old checkbox) maps to 'quiet'. */
  function reengagePostCfg() {
    var o = orCfg();
    var mode = (o.postSaleMode === 'presence' || o.postSaleMode === 'quiet' || o.postSaleMode === 'upsell')
      ? o.postSaleMode
      : (o.reengagePostSaleEnabled === false ? 'quiet' : 'upsell');
    return {
      graceMs: (typeof o.reengageGraceMs === 'number' && o.reengageGraceMs >= 0) ? o.reengageGraceMs : 4 * 60000,
      windowMs: (typeof o.reengagePostSaleWindowMs === 'number' && o.reengagePostSaleWindowMs > 0) ? o.reengagePostSaleWindowMs : 48 * 3600000,
      mode: mode
    };
  }
  function reengageTick() {
    /* panel open / demo are not diagnostic — stay silent so lastSkip keeps
       the in-panel story; everything below names its gate. */
    if (isDemo() || panelOpen) { return; }
    if (reengageBusy) {
      /* composing is momentary — but a hung request must never mute the
         bubble forever. Abandon a stuck compose and name it. */
      if (Date.now() - reengageBusyAt > 45000) {
        reengageBusy = false;
        noteSkip('reengage: a stuck line request was abandoned after 45s — resuming normal checks');
      }
      return;
    }
    if (quietMode) { noteSkip('reengage: QUIET MODE — pauses for ' + Math.round(effQuietMs() / 60000) + 'min; lifts by itself, on reload, or when you type'); return; }
    if (streaming) { noteSkip('reengage: a reply is streaming'); return; }
    if (outreachEl) { noteSkip('reengage: an outreach bubble is already on screen (it withdraws by itself after ~22s)'); return; }
    if (checkoutOpen()) { noteSkip('reengage: the register sheet is open — never interrupt an order'); return; }
    var pc = reengagePostCfg();
    var pa = purchaseAgeMs();
    if (pa !== null && pa < pc.graceMs) {                        /* fresh sale — congrats owns it */
      noteSkip('reengage: fresh commission — congrats grace window, ' + Math.ceil((pc.graceMs - pa) / 1000) + 's left');
      return;
    }
    /* Recently purchased with the post-sale mode set to QUIET in admin: the
       bubble stays silent for the WHOLE window (admin sets its length in
       hours, minutes, or seconds). This used to be the only unnamed gate in
       the path — a buyer could hit it for two days straight with no
       diagnostic. */
    if (pa !== null && pa < pc.windowMs && pc.mode === 'quiet') {
      noteSkip('reengage: commissioned ' + fmtDur(pa) + ' ago and the post-sale mode is QUIET in admin (Tuning → Engagement → ⑤ After they buy) — silent for the remaining ' + fmtDur(pc.windowMs - pa) + ' of the ' + fmtDur(pc.windowMs) + ' window');
      return;
    }
    if (!hadActivity) { noteSkip('reengage: no page activity seen yet this visit — scroll/tap/move first (console use doesn\'t count)'); return; }
    if (!activeSinceReengage) { noteSkip('reengage: waiting for FRESH activity since the last reach-out (so someone who truly left isn\'t nagged)'); return; }
    var c = reengageCfg();
    if (!c.enabled) { noteSkip('reengage: turned OFF in admin (outreach.reengageEnabled)'); return; }
    if (reengageCount >= c.max) { noteSkip('reengage: budget spent (' + reengageCount + '/' + c.max + ' this visit)'); return; }
    var idleFor = Date.now() - lastActivityTs;
    if (idleFor < c.idleMs) {                                    /* not idle long enough yet */
      noteSkip('reengage: not idle long enough — fires after ' + Math.round(c.idleMs / 1000) + 's still; last activity ' + Math.round(idleFor / 1000) + 's ago via ' + (lastActivitySrc || 'page activity') + ' (any tap, key, scroll or mouse-move resets the clock — checking the console counts too)');
      return;
    }
    /* Past the grace but recently purchased → what happens depends on the
       admin's post-sale mode: 'upsell' frames the line for a SECOND sale
       (companion cloth / gift, never "still eyeing"); 'presence' keeps the
       normal warm check-in with no selling frame. The 'quiet' case already
       returned above, with its name. */
    var postSale = pc.mode === 'upsell' && pa !== null && pa < pc.windowMs;
    reengageBusy = true;
    reengageBusyAt = Date.now();
    fetchReengageLine(postSale, function (line) {
      reengageBusy = false;
      /* the server held — nothing new to say. Treat it like a spoken beat for
         pacing (fresh activity required before another try), so the tick
         doesn't re-ask the register every 4 seconds. */
      if (!line) {
        noteSkip('reengage: the register held — everything worth saying has been said (a reply re-opens it)');
        activeSinceReengage = false;
        return;
      }
      /* re-check — state may have changed while the line was being composed */
      if (panelOpen || quietMode || streaming || outreachEl) {
        noteSkip('reengage: the line was ready but the moment passed while composing (' +
          (panelOpen ? 'panel opened' : quietMode ? 'quiet mode began' : streaming ? 'a reply started streaming' : 'another bubble appeared') + ') — dropped');
        return;
      }
      var c2 = reengageCfg();
      if (!c2.enabled || reengageCount >= c2.max) {
        noteSkip('reengage: the line was ready but config changed while composing (' + (!c2.enabled ? 'turned off' : 'budget spent') + ') — dropped');
        return;
      }
      if (showOutreach('reengage-' + reengageCount, line, true, true)) {
        reengageCount++;
        activeSinceReengage = false;                             /* require fresh activity before the next */
      }
    });
  }
  setInterval(reengageTick, 4000);

  /* ----------------------------------------------------------
     Conversation lifecycle — closing / snoozing (a mix of both:
     the visitor's own signal AND the bot winding down)
  ---------------------------------------------------------- */
  var quietMode = false;        /* visitor asked for room — a time-boxed pause, not a switch */
  var quietTimer = null;        /* auto-lift after the quiet window */
  var quietUntil = 0;           /* when the current quiet spell ends (for status()) */
  /* How long "that's all" / "don't message me" holds: admin outreach.quietMs,
     default 30 minutes. Deliberately NOT persisted — a reload starts fresh,
     and typing always lifts it early. */
  function effQuietMs() {
    var o = orCfg();
    return (typeof o.quietMs === 'number' && o.quietMs > 0) ? o.quietMs : 30 * 60000;
  }
  var wrappedUp = false;        /* this conversation has been recorded as closed/snoozed */

  function setQuiet(on) {
    quietMode = on;
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
    if (on) {
      var win = effQuietMs();
      quietUntil = Date.now() + win;
      /* the pause lifts by itself — the bot resumes a light presence rather
         than staying dark until the visitor happens to type */
      quietTimer = setTimeout(function () {
        quietTimer = null;
        if (!quietMode) { return; }
        quietMode = false;
        quietUntil = 0;
        updateWrapPill();
        /* the quiet window ending is a new chapter too — fresh hold streak */
        if (panelOpen && !streaming && !nudgeTimer) { holdAttempts = 0; scheduleNudge(); }
      }, win);
    } else {
      quietUntil = 0;
    }
    updateWrapPill();
  }

  /* The wrap-up chip rides at the end of the message flow — shown exactly when
     there is something to wrap (a real exchange, not already wrapped, not in
     quiet mode, nothing streaming). Rebuilt after each reply so it always sits
     under the latest line; it is presentation only, never part of history. */
  function updateWrapPill() {
    if (!msgsEl) { return; }
    var old = msgsEl.querySelector('.cx-wrapend');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    if (wrappedUp || quietMode || streaming || !hasRealExchange()) { return; }
    /* Contextual, not constant: the chip appears when ending is plausibly on
       the visitor's mind — once the bot has begun following up on its own
       (that's what "that's all for now" answers), or once the exchange runs
       deep — never parked under the very first reply. Admin-tunable:
       outreach.wrapChipMinTurns (patron turns before it appears, default 3;
       0 = always) and wrapChipOnFollowup (show it whenever a follow-up beat
       has fired, default on). */
    var oWrap = orCfg();
    var minTurns = (typeof oWrap.wrapChipMinTurns === 'number' && oWrap.wrapChipMinTurns >= 0) ? oWrap.wrapChipMinTurns : 3;
    var onFollowup = oWrap.wrapChipOnFollowup !== false;
    var userTurns = 0, wi;
    for (wi = 0; wi < history.length; wi++) { if (history[wi].role === 'user') { userTurns++; } }
    if (!((onFollowup && (nudgeCount > 0 || unacked > 0)) || userTurns >= minTurns)) { return; }
    var rowEnd = el('div', 'cx-wrapend');
    var btn = el('button', 'cx-wrapbtn', 'That’s all for now ✓');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Wrap up this conversation — the concierge stays quiet until you write again');
    btn.title = 'Wrap up — the concierge stays quiet until you write again';
    btn.addEventListener('click', function () { wrapUpByCustomer(); });
    rowEnd.appendChild(btn);
    msgsEl.appendChild(rowEnd);
  }

  /* A real exchange = at least one visitor turn AND one bot turn. Only then is
     there a conversation worth recording as wrapped. */
  function hasRealExchange() {
    var u = false, a = false, i;
    for (i = 0; i < history.length; i++) {
      if (history[i].role === 'user') { u = true; }
      else if (history[i].role === 'assistant') { a = true; }
    }
    return u && a;
  }

  /* Start a fresh conversation server-side. The visible transcript stays; the
     next message opens a new conversation the bot reads as a re-engagement. */
  function rotateSessionKey() {
    _sessionKey = '';
    try { window.sessionStorage.removeItem(SKEY_KEY); } catch (eRK) { /* ignore */ }
  }

  /* Tell the register the conversation closed or snoozed. Fire-and-forget;
     keepalive lets it survive a page dismissal. */
  function postWrapup(reason) {
    if (isDemo()) { return; }
    var key = sessionKey();
    getAccessToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) { headers['Authorization'] = 'Bearer ' + token; }
      try {
        fetch(endpoint() + (endpoint().indexOf('?') === -1 ? '?wrapup=1' : '&wrapup=1'), {
          method: 'POST', headers: headers, keepalive: true,
          body: JSON.stringify({ session_key: key, reason: reason })
        })['catch'](function () { /* nothing to recover */ });
      } catch (eW) { /* ignore */ }
    })['catch'](function () { /* no token — still fine, anonymous wrapup */
      try {
        fetch(endpoint() + (endpoint().indexOf('?') === -1 ? '?wrapup=1' : '&wrapup=1'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
          body: JSON.stringify({ session_key: key, reason: reason })
        })['catch'](function () {});
      } catch (eW2) { /* ignore */ }
    });
  }

  /* Record the wrap once. Only an EXPLICIT customer signal (close / quiet)
     starts a brand-new conversation; a plain panel-close does NOT rotate, so
     browsing away and back stays one conversation instead of fragmenting into
     many tiny rows. A genuine return in a new browser session (new session key)
     is what the register reads as a re-engagement. */
  function doWrapup(reason) {
    if (wrappedUp || !hasRealExchange()) { return; }
    postWrapup(reason);
    if (reason === 'close' || reason === 'quiet') { rotateSessionKey(); }
    wrappedUp = true;
    clearNudge();
    updateWrapPill();
  }

  /* Visitor: "Don't message me until I write back." */
  function enterQuietMode() {
    setQuiet(true);
    clearNudge();
    orDismissAll();
    doWrapup('quiet');
    if (hasRealExchange()) {
      addSysLine('Understood — I’ll leave you to browse in peace. Write whenever you like and I’ll be right here.');
    } else {
      addSysLine('Of course — browse at your leisure. I’m here the moment you want me.');
    }
  }

  /* Visitor: "That's all for now." */
  function wrapUpByCustomer() {
    setQuiet(true);
    clearNudge();
    orDismissAll();
    doWrapup('close');
    addSysLine('A pleasure. 2003 Porsche 911 Turbo is here whenever you return — your number will be waiting.');
    if (panelOpen) {
      setTimeout(function () { if (panelOpen) { closePanel(); } }, REDUCED ? 0 : 1500);
    }
  }

  /* Diagnostic: type "selftest" in the chat to see exactly what the register
     knows about you — recognized as signed in? your orders, standing, notes,
     which tables exist. Renders the raw report so it can be pasted for support. */
  function runSelfTest() {
    addUserTurn('selftest');
    if (isDemo()) { addSysLine('Self-test needs the live endpoint (demo mode is on).'); return; }
    var el2 = el('div', 'cx-turn cx-sysline', 'Running self-test…');
    el2.style.whiteSpace = 'pre-wrap';
    el2.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    el2.style.fontSize = '.66rem';
    msgsEl.appendChild(el2);
    scrollToBottom(false);
    getAccessToken().then(function (token) {
      var headers = {};
      if (token) { headers['Authorization'] = 'Bearer ' + token; }
      return fetch(endpoint() + (endpoint().indexOf('?') === -1 ? '?selftest=1' : '&selftest=1'),
        { headers: headers });
    }).then(function (res) { return res.json(); }).then(function (j) {
      el2.textContent = 'SELF-TEST\n' + JSON.stringify(j, null, 2);
      scrollToBottom(false);
    })['catch'](function () {
      el2.textContent = 'Self-test could not reach the register.';
    });
  }

  /* A device with a real pointer (mouse/trackpad) — desktop, INCLUDING a narrow
     window. On touch-primary devices we avoid auto-focusing the composer so the
     on-screen keyboard doesn't spring up unbidden. Keyed off pointer type, not
     window width, so a half-screen desktop window still keeps the box focused. */
  function pointerFine() {
    try {
      if (window.matchMedia) { return window.matchMedia('(pointer: fine)').matches; }
    } catch (e) { /* fall through */ }
    return !('ontouchstart' in window);
  }

  function setStreaming(on, proactive) {
    streaming = on;
    proactiveStream = on ? !!proactive : false;
    /* A turn the VISITOR started locks the composer until the reply lands. But a
       PROACTIVE line (a nudge/opener the bot speaks on its own) must never seize
       the field — the customer has to be able to keep typing right through it. */
    var lock = on && !proactive;
    if (sendBtn) { sendBtn.disabled = lock; }
    if (inputEl) {
      inputEl.disabled = lock;
      /* Pull focus back to the composer when a visitor turn finishes (disabling
         it mid-stream blurred it), so they can type the next message without
         clicking. Skip ONLY if they've genuinely moved on — typing in another
         field, or a draft is sitting in the box. (The old check used a "typed in
         the last 4s" heuristic, which is always true right after hitting Enter,
         so focus never came back on a quick reply.) */
      if (!on && panelOpen && pointerFine()) {
        var af = document.activeElement;
        var typingElsewhere = af && af !== inputEl && af !== document.body &&
          (af.tagName === 'INPUT' || af.tagName === 'TEXTAREA' || af.isContentEditable);
        var draft = (inputEl.value || '').replace(/^\s+|\s+$/g, '');
        if (!typingElsewhere && !draft) {
          try { inputEl.focus(); } catch (e) { /* ignore */ }
        }
      }
    }
  }

  /* Is the visitor actively composing? Text sitting in the box, or a keystroke
     within the last few seconds. (Focus alone doesn't count — the composer
     auto-focuses on open, and the opener still needs to be able to speak.) */
  var lastTypeTs = 0;
  function composing() {
    if (!inputEl) { return false; }
    if ((inputEl.value || '').replace(/^\s+|\s+$/g, '')) { return true; }
    return (Date.now() - lastTypeTs) < 4000;
  }

  function clearDemoTimers() {
    var i;
    for (i = 0; i < demoTimers.length; i++) { clearTimeout(demoTimers[i]); }
    demoTimers = [];
  }

  function abortStream() {
    if (currentAbort) {
      try { currentAbort.abort(); } catch (e) { /* ignore */ }
      currentAbort = null;
    }
    clearDemoTimers();
  }

  function submitInput() {
    var text = (inputEl.value || '').replace(/^\s+|\s+$/g, '');
    if (!text) { return; }
    if (streaming) {
      /* their own turn is still landing — wait for it. But if the bot was just
         speaking on its own (a nudge/opener), the visitor takes over: step aside
         and send theirs. */
      if (!proactiveStream) { return; }
      abortStream();
      setStreaming(false);
    }
    inputEl.value = '';
    autogrow();
    sendMessage(text);
  }

  function sendMessage(text) {
    if (streaming) { return; }
    if (text && text.replace(/^\s+|\s+$/g, '').toLowerCase() === 'selftest') {
      pinned = true; hideNewPill(); runSelfTest();
      return;
    }
    pinned = true;
    hideNewPill();
    addUserTurn(text);
    history.push({ role: 'user', content: text, ts: Date.now() });
    saveHistory();
    /* Reset the entry mode BEFORE the request: a typed reply must be sent as
       'typed', not carrying a stale 'opener:*'/'outreach:*' from the last
       proactive beat — otherwise the server treats mid-conversation replies as
       fresh openers and re-greets ("what brings you back today?"). */
    entryMode = 'typed'; /* until the next tap says otherwise */
    performRequest();
    lastSentAt = Date.now();
    nudgeCount = 0;      /* they spoke — the follow-up budget resets */
    holdAttempts = 0;
    unacked = 0;         /* a reply is the clearest sign of life */
    /* the visitor wrote back — quiet mode lifts, and this begins a fresh
       (possibly re-engaged) conversation the register can wrap again later */
    if (quietMode) { setQuiet(false); }
    wrappedUp = false;
    clearNudge();
  }

  function resendLast() {
    if (streaming) { return; }
    /* last user message is already in history — just re-run */
    var i, has = false;
    for (i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') { has = true; break; }
    }
    if (!has) { return; }
    pinned = true;
    performRequest();
  }

  /* A deferred shell for proactive follow-ups: no turn (and no typing dots)
     appear until the bot actually commits a word. If it holds, nothing was
     ever shown — the visitor never sees a phantom "typing" that vanishes. */
  function lazyShell() {
    var real = null;
    var proxy = {
      held: false, mid: null, cid: null, turn: null,
      append: function (t) {
        if (!real) { real = addAssistantShell(); proxy.turn = real.turn; }
        real.append(t);
      },
      status: function () { /* proactive lines show no thinking indicator */ },
      done: function () { if (real) { real.done(); } },
      fail: function () { if (real) { real.fail(); } },
      getText: function () { return real ? real.getText() : ''; }
    };
    return proxy;
  }

  function performRequest(opts) {
    var proactive = !!(opts && opts.quiet);
    setStreaming(true, proactive);
    var shell = proactive ? lazyShell() : addAssistantShell();
    shell.proactive = proactive;   /* a proactive follow-up may hold; a reply may not */
    if (isDemo()) { demoRespond(shell); }
    else { liveRespond(shell); }
  }

  var holdAttempts = 0;         /* times the bot chose to give space */

  function finishTurn(shell) {
    /* Giving space (a hold) is ONLY valid for a proactive follow-up the bot
       started itself. A direct message from the visitor must never be met with
       silence — fall through to a graceful line below. */
    if (shell.held && shell.proactive) {
      shell.fail();
      if (nudgeCount > 0) { nudgeCount--; }
      holdAttempts++;
      noteSkip('beat: the register HELD (' + entryMode + ') — the model judged nothing new worth saying (' + holdAttempts + '/' + effHoldBudget() + ' holds)');
      setStreaming(false);
      if (holdAttempts < effHoldBudget()) { scheduleNudge(true); } /* keep a light presence a while longer */
      return;
    }
    var content = shell.getText();
    /* Probe what the visitor will actually SEE. A reply can be non-empty as
       text yet render to nothing (plumbing-only: a stray action token, markup
       the renderer drops). A blank bubble wearing feedback arrows is worse
       than silence — so check the render, not the raw string. */
    var probe = mdRender(content || '');
    var visiblyBlank = !((probe.textContent || '').replace(/\s+/g, '')) &&
      !(probe.querySelector && probe.querySelector('.cx-form,.cx-actionrow,.cx-replies,img,button'));
    if (visiblyBlank && shell.proactive) {
      /* a proactive line with nothing to show — withdraw the bubble entirely
         and treat it like a hold: quiet now, circle back spaciously */
      if (shell.turn && shell.turn.parentNode) { shell.turn.parentNode.removeChild(shell.turn); }
      noteSkip('beat: the line rendered EMPTY (plumbing-only reply) — bubble withdrawn (' + entryMode + ')');
      setStreaming(false);
      scheduleNudge(true);
      return;
    }
    if (visiblyBlank) {
      /* the reply came back with nothing visible (a bare tool call, a stray
         hold) — never leave the visitor's message hanging; stay present */
      content = 'Of course — I’m right here whenever you need anything at all.';
      shell.append(content);
    }
    shell.done();
    content = shell.getText();
    /* The model's own wind-down signal: a typed "that's all" earns a warm
       send-off carrying {{action:snooze}} — honoring it enters quiet mode and
       records the wrap exactly as if they'd tapped the chip. The token is
       stripped before the transcript keeps the line. */
    var snoozed = false;
    if (content && content.indexOf('{{action:snooze}}') !== -1) {
      snoozed = true;
      content = content.replace(/[ \t]*\{\{action:snooze\}\}[ \t]*/g, '')
        .replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
    }
    if (content) {
      if (shell.proactive) { holdAttempts = 0; } /* it spoke — refresh the give-space budget */
      history.push({ role: 'assistant', content: content, ts: Date.now() });
      saveHistory();
      /* a line landed — if this conversation had been recorded as wound down
         (auto-wrap on close), it has audibly resumed: eligible to wrap again */
      wrappedUp = false;
    }
    if (content && shell.mid != null && hasSupabase()) {
      addFeedback(shell.turn, shell.mid);
    }
    setStreaming(false);
    if (snoozed) {
      /* the send-off in the reply IS the goodbye — no extra system line */
      setQuiet(true);
      orDismissAll();
      doWrapup('quiet');
      noteSkip('snooze: the bot wound the visit down on the patron\'s cue — quiet for the configured window');
    } else {
      scheduleNudge();
    }
    updateWrapPill();
  }

  function clearNudge() {
    if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
  }

  /* The concierge keeps a light, human presence while the panel is open — it
     circles back a couple of times with substance, then settles into occasional
     "still here whenever you need me" check-ins at growing intervals, the way a
     good clerk lingers nearby without hovering. Quiet mode stops it entirely. */
  /* First rung leads FAST — the moments after a customer's message are the
     hottest in the conversation, and dead air there loses them; later rungs
     back off. All overridable (nudge1Ms…nudge5Ms), all scaled by the dial. */
  var NUDGE_DELAYS = [8000, 30000, 90000, 180000, 300000]; /* last value repeats */
  var NUDGE_CAP = 6;            /* total proactive check-ins before it fully rests */
  var UNACKED_CAP = 2;          /* stop after this many reach-outs with no sign of life */
  var HOLD_BUDGET = 4;          /* consecutive silent holds before the bot rests */
  /* Effective caps: the admin's outreach config wins outright; otherwise the
     built-in default, shifted by the assertiveness dial where noted. */
  function effUnackedCap() {
    var o = orCfg();
    if (typeof o.unackedCap === 'number' && o.unackedCap >= 0) { return o.unackedCap; }
    return assertLevel() >= 4 ? 3 : UNACKED_CAP;
  }
  function effHoldBudget() {
    var o = orCfg();
    return (typeof o.holdBudget === 'number' && o.holdBudget >= 0) ? o.holdBudget : HOLD_BUDGET;
  }
  /* The register sheet is sacred ground: while the checkout panel is open,
     NO proactive beat fires anywhere — a bot line mid-order-form is the most
     expensive interruption there is (they share the same space on desktop). */
  function checkoutOpen() {
    try {
      var p = document.querySelector('.ck-panel.ck-open');
      return !!p;
    } catch (eCk) { return false; }
  }
  function scheduleNudge(spacious, quickMs) {
    clearNudge();
    if (isDemo()) { noteSkip('nudge: demo mode'); return; }
    if (!panelOpen) { noteSkip('nudge: panel is closed'); return; }
    if (quietMode) { noteSkip('nudge: QUIET MODE — pauses for ' + Math.round(effQuietMs() / 60000) + 'min; lifts by itself, on reload, or when you type'); return; }
    if (checkoutOpen()) { noteSkip('nudge: the register sheet is open — never interrupt an order'); return; }
    var o = orCfg();
    /* Effective caps scale with assertiveness: a more driving concierge circles
       back a couple more times; admin nudgeCap overrides entirely. */
    var cap = (typeof o.nudgeCap === 'number') ? o.nudgeCap : (NUDGE_CAP + (assertLevel() - 3));
    if (nudgeCount >= cap) { noteSkip('nudge: follow-up budget spent (' + nudgeCount + '/' + cap + ' this visit)'); return; }
    /* Don't talk into the void: if the last couple of reach-outs went completely
       unacknowledged (no scroll, tap, type, or return to the tab), the visitor
       isn't watching — pause. Any sign of life resets this and resumes us. */
    var ucap = effUnackedCap();
    if (unacked >= ucap) { noteSkip('nudge: ' + unacked + ' reach-outs unacknowledged (no scroll/tap/type) — paused until a sign of life'); return; }
    /* only when a real exchange is underway and the last word was the bot's */
    if (!history.length || history[history.length - 1].role !== 'assistant') { noteSkip('nudge: waiting — last word is the visitor\'s or no exchange yet'); return; }
    /* Normally we only circle back once the visitor has spoken — but a signed-in
       patron we already know earns a proactive follow-up even before they type. */
    var spoke = false, i;
    for (i = 0; i < history.length; i++) { if (history[i].role === 'user') { spoke = true; break; } }
    if (!spoke && !authEmail && o.anonNudges !== true) { noteSkip('nudge: anonymous visitor has not typed yet — the bot waits for them (default; enable "Follow up with guests before they’ve typed" in Tuning â Engagement â â¢ to change)'); return; }
    var idx = Math.min(nudgeCount, NUDGE_DELAYS.length - 1);
    var wait = NUDGE_DELAYS[idx];
    if (idx === 0 && typeof o.nudge1Ms === 'number') { wait = o.nudge1Ms; }
    if (idx === 1 && typeof o.nudge2Ms === 'number') { wait = o.nudge2Ms; }
    if (idx === 2 && typeof o.nudge3Ms === 'number') { wait = o.nudge3Ms; }
    if (idx === 3 && typeof o.nudge4Ms === 'number') { wait = o.nudge4Ms; }
    if (idx >= 4 && typeof o.nudge5Ms === 'number') { wait = o.nudge5Ms; }
    var armBase = wait;    /* rung base after config, BEFORE dial (diagnostics) */
    wait = Math.round(wait * assertDelayMult());          /* assertiveness scales the pace */
    if (spacious) { wait = Math.round(wait * 1.5); } /* a declined moment earns more room */
    /* Reading-time floor (first rung only): a long reply earns its reading
       time — the first follow-up must never land while they're mid-paragraph.
       ~300ms per word, capped at 90s so one long reply can't stall the ladder.
       Exposed as readFloorMs in status() so the conformance harness expects
       the same number the widget enforces. */
    var rfl = 0;
    if (idx === 0) {
      rfl = readFloorMs();
      if (rfl > wait) { wait = rfl; }
    }
    /* an attention beat (panel just opened) overrides the ladder — absolute,
       not dial-scaled: the moment is now either way */
    if (typeof quickMs === 'number' && quickMs >= 0) { wait = quickMs; }
    nudgeArmedMs = wait;   /* status() reports it — the armed wait is a lookup, not a guess */
    nudgeArmedAt = Date.now();
    /* the full arithmetic of THIS arm, so a surprising fire time is a lookup */
    nudgeArmedWhy = 'rung#' + (idx + 1) + ' base ' + armBase + ' × dial ' + assertDelayMult().toFixed(2) +
      (spacious ? ' × 1.5 spacious' : '') +
      (idx === 0 ? ' | floor ' + rfl + ' (' + (history.length ? 'last-assistant words counted' : 'no history') + ')' : '') +
      ((typeof quickMs === 'number' && quickMs >= 0) ? ' | quick override ' + quickMs : '') +
      ' → ' + wait;
    nudgeTimer = setTimeout(function () {
      nudgeTimer = null;   /* this arm is consumed — !nudgeTimer checks stay honest */
      if (streaming || !panelOpen || quietMode) {
        noteSkip('nudge: stood down at fire time — ' + (streaming ? 'a reply is streaming' : !panelOpen ? 'the panel closed while waiting' : 'quiet mode began while waiting'));
        return;
      }
      if (checkoutOpen()) { noteSkip('nudge: the register sheet is open — never interrupt an order'); scheduleNudge(true); return; }
      /* never speak over someone mid-sentence — wait and try again shortly */
      if (composing()) { scheduleNudge(spacious); return; }
      if (!history.length || history[history.length - 1].role !== 'assistant') {
        noteSkip('nudge: stood down at fire time — the visitor spoke last (their reply resets the ladder)');
        return;
      }
      nudgeCount++;
      unacked++;                 /* this reach-out is unacknowledged until they show a sign of life */
      entryMode = 'nudge';
      pendingNudge = { seconds: Math.round(wait / 1000), count: nudgeCount, signedIn: !!authEmail };
      noteSkip('nudge: FIRED (#' + nudgeCount + ') — requesting the line now');
      performRequest({ quiet: true }); /* no phantom typing if it holds */
    }, wait);
  }

  /* On opening the panel, the concierge speaks first — contextually. A returning
     visitor with a thread in progress is re-engaged; a signed-in patron we know
     is greeted by name toward the goals. Nothing fires in quiet mode, for a
     purely anonymous first-timer (the static greeting serves them), or right on
     the heels of an outreach line they just tapped. */
  function maybeOpenerOnOpen() {
    openerOnOpenCore();
    /* Whatever the opener decided, the panel must never sit silent with no
       beat armed: if no opener timer is pending and nothing is streaming,
       start the light-presence loop. This covers the tapped-outreach path —
       the tapped line IS the opener, but before this fallback nothing ever
       armed the follow-ups, so the bot went mute until the visitor typed.
       And because an open panel is the visit's highest-attention moment,
       this first follow-up comes QUICKLY (openerFollowMs, default 8s) — a
       goal beat while they're actually looking, not 20s later. scheduleNudge
       still applies all its own gates (demo/quiet/caps/anonymous). */
    if (panelOpen && !nudgeTimer && !streaming) {
      var oa = orCfg();
      var quick = (typeof oa.openerFollowMs === 'number' && oa.openerFollowMs >= 0) ? oa.openerFollowMs : 8000;
      scheduleNudge(false, quick);
    } else if (panelOpen && !streaming) {
      noteSkip('opener follow-up: not armed — an opener/follow-up timer is already pending (it will speak in its own time)');
    }
  }
  function openerOnOpenCore() {
    if (isDemo()) { noteSkip('opener: demo mode'); return; }
    if (quietMode) { noteSkip('opener: QUIET MODE — pauses for ' + Math.round(effQuietMs() / 60000) + 'min; lifts by itself, on reload, or when you type'); return; }
    if (streaming) { noteSkip('opener: a reply is already streaming'); return; }
    if (reengagedThisOpen) { noteSkip('opener: already spoke once this panel session'); return; }
    var last = history.length ? history[history.length - 1] : null;
    /* an outreach line they just tapped is itself the opener — don't double up */
    if (last && last.role === 'assistant' && (Date.now() - (last.ts || 0) < 5000)) {
      reengagedThisOpen = true;
      noteSkip('opener: the outreach line just tapped is itself the opener');
      return;
    }
    var hadUser = false, i;
    for (i = 0; i < history.length; i++) { if (history[i].role === 'user') { hadUser = true; break; } }
    var oo = orCfg();
    var kind = '', delay = 1100;
    if (last && last.role === 'assistant' && hadUser) {
      /* Opener COOLDOWN — the design fix for "every refresh repeats the same
         greeting": the restored transcript already ends with the bot's line,
         unanswered, on their screen. While that line is still fresh, a
         re-open lets the thread STAND (the quick attention follow-up is
         armed instead, and it is substance-gated). A clerk doesn't re-greet
         someone who glanced away for a minute. */
      /* default 90s: enough to stop rapid-refresh greeting spam, short enough
         that a genuine return gets spoken to (set 0 to speak on EVERY open —
         the opener now sees its own recent lines and varies instead of
         repeating, so frequent openers no longer echo) */
      var cool = (typeof oo.openerCooldownMs === 'number' && oo.openerCooldownMs >= 0) ? oo.openerCooldownMs : 90000;
      if (last.ts && (Date.now() - last.ts) < cool) {
        reengagedThisOpen = true;
        noteSkip('opener: my last line is still fresh (' + Math.round((Date.now() - last.ts) / 1000) +
          's old, cooldown ' + Math.round(cool / 60000) + 'min) — the restored thread stands, no re-greeting');
        return;
      }
      kind = 'reengage';                         /* came back to a live thread — pick it up now */
      delay = (typeof oo.openerReengageMs === 'number' && oo.openerReengageMs >= 0) ? oo.openerReengageMs : 1100;
    } else if (!history.length) {
      kind = 'greet';
      /* Opening the panel is the visit's highest-attention moment — the goal
         beat lands while they're actually looking. A known patron is greeted
         personally almost at once; an anonymous visitor gets the goal-directed
         follow-up shortly after the house greeting (was 16s — attention has
         moved on by then). Both admin-tunable. */
      delay = authEmail
        ? ((typeof oo.openerSignedMs === 'number' && oo.openerSignedMs >= 0) ? oo.openerSignedMs : 1200)
        : ((typeof oo.openerAnonMs === 'number' && oo.openerAnonMs >= 0) ? oo.openerAnonMs : 3000);
    }
    if (!kind) { noteSkip('opener: last word is the visitor\'s — the bot replies rather than re-opens'); return; }
    reengagedThisOpen = true;
    nudgeCount = 0; holdAttempts = 0; clearNudge();
    function fireOpener() {
      if (!panelOpen) { noteSkip('opener(' + kind + '): panel closed before it fired'); return; }
      if (streaming) { noteSkip('opener(' + kind + '): a reply is streaming'); return; }
      if (quietMode) { noteSkip('opener(' + kind + '): QUIET MODE is on for this tab'); return; }
      if (checkoutOpen()) { noteSkip('opener(' + kind + '): the register sheet is open — never interrupt an order'); return; }
      /* if they engaged during the wait (tapped a pill, typed), let them lead */
      if (kind === 'greet' && history.length) { noteSkip('opener(greet): visitor engaged during the wait — they lead'); return; }
      /* don't open over someone already typing — hold the thought a beat */
      if (composing()) { nudgeTimer = setTimeout(fireOpener, 2000); return; }
      pendingOpener = kind;
      entryMode = 'opener:' + kind;
      noteSkip('opener(' + kind + '): FIRED — requesting the line now');
      performRequest({ quiet: true }); /* lazy shell — no phantom typing if it holds */
    }
    nudgeTimer = setTimeout(fireOpener, delay);
  }

  function failTurn(shell) {
    shell.fail();
    var partial = shell.getText();
    if (partial) {
      history.push({ role: 'assistant', content: partial });
      saveHistory();
    }
    /* A PROACTIVE beat that failed (network / rate limit) must not splash an
       error at someone who asked nothing — but it must not vanish from the
       diagnostics either: it was the last invisible lifecycle state (FIRED →
       …nothing). Name it, and retry later, spaciously. */
    if (shell.proactive) {
      noteSkip('beat: request FAILED (' + entryMode + ') — network error or rate limit; nothing was shown');
      setStreaming(false);
      scheduleNudge(true);
      return;
    }
    addSysLine(ERROR_LINE);
    addRetryChip();
    setStreaming(false);
  }

  /* ---- LIVE: SSE over fetch ---- */
  function liveRespond(shell) {
    var turns = history.slice(Math.max(0, history.length - SEND_TURNS));
    var messages = [], i;
    for (i = 0; i < turns.length; i++) {
      messages.push({ role: turns[i].role, content: turns[i].content });
    }
    var ctx = freshState();
    if (pendingNudge) { ctx.nudge = pendingNudge; pendingNudge = null; }
    if (pendingOpener) { ctx.opener = pendingOpener; pendingOpener = null; }
    var body = JSON.stringify({
      messages: messages,
      context: ctx,
      session_key: sessionKey()
    });
    var ac = null;
    try { ac = new AbortController(); } catch (eAC) { ac = null; }
    currentAbort = ac;
    var aborted = false;

    getAccessToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) { headers['Authorization'] = 'Bearer ' + token; }
      return fetch(endpoint(), {
        method: 'POST',
        headers: headers,
        body: body,
        signal: ac ? ac.signal : undefined
      });
    }).then(function (res) {
      if (!res.ok) {
        if (res.status === 503) {
          /* the shop is closed for the moment — calm mono notice */
          return res.json()['catch'](function () { return null; }).then(function (j) {
            var msg = '';
            if (typeof j === 'string') { msg = j; }
            else if (j && typeof j.error === 'string') { msg = j.error; }
            else if (j && typeof j.message === 'string') { msg = j.message; }
            shell.fail();
            addSysLine(msg || BUSY_LINE);
            setStreaming(false);
          });
        }
        return res.json()['catch'](function () { return {}; }).then(function () {
          throw new Error('HTTP ' + res.status);
        });
      }
      if (!res.body || !res.body.getReader) {
        /* no streaming support — read whole text */
        return res.text().then(function (full) {
          consumeSSE(full, shell);
          consumeSSEFlush(shell);
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      var doneFlag = { v: false };

      function pump() {
        return reader.read().then(function (step) {
          if (doneFlag.v) { return; }
          if (step.done) {
            buf += decoder.decode();
            processBuf(true);
            if (!doneFlag.v) { doneFlag.v = true; finishTurn(shell); }
            return;
          }
          buf += decoder.decode(step.value, { stream: true });
          processBuf(false);
          if (!doneFlag.v) { return pump(); }
        });
      }

      function processBuf(flush) {
        var parts = buf.split('\n\n');
        buf = flush ? '' : parts.pop();
        if (flush && parts.length && parts[parts.length - 1] === '') { parts.pop(); }
        var p, lines, L, payload, obj;
        for (p = 0; p < parts.length; p++) {
          lines = parts[p].split('\n');
          for (L = 0; L < lines.length; L++) {
            if (lines[L].indexOf('data:') !== 0) { continue; }
            payload = lines[L].slice(5).replace(/^\s/, '');
            if (payload === '[DONE]') {
              doneFlag.v = true;
              finishTurn(shell);
              return;
            }
            try {
              obj = JSON.parse(payload);
              if (obj && typeof obj.t === 'string') { shell.append(obj.t); }
              if (obj && typeof obj.s === 'string' && shell.status) { shell.status(obj.s); }
              if (obj && obj.hold) { shell.held = true; }
              if (obj && obj.m && typeof obj.m === 'object') {
                if (obj.m.mid != null) { shell.mid = obj.m.mid; }
                if (obj.m.cid != null) { shell.cid = obj.m.cid; }
              }
            } catch (eJ) { /* skip malformed frame */ }
          }
        }
      }

      return pump();
    })['catch'](function (err) {
      if (aborted || (err && err.name === 'AbortError')) {
        /* If a newer turn already superseded this one (the visitor typed over a
           proactive line), just drop this shell — don't touch the live stream
           state or we'd unlock the composer mid-reply. */
        if (currentAbort !== ac) {
          if (shell.proactive) { noteSkip('beat: superseded — the visitor typed while the line was composing (their turn wins)'); }
          shell.done();
          return;
        }
        /* panel closed mid-stream: keep what we have quietly */
        if (shell.proactive) { noteSkip('beat: the stream was cut mid-line (panel closed or navigation) — partial text kept in the transcript'); }
        shell.done();
        var partial = shell.getText();
        if (partial) {
          history.push({ role: 'assistant', content: partial });
          saveHistory();
        }
        setStreaming(false);
        return;
      }
      failTurn(shell);
    }).then(function () {
      if (currentAbort === ac) { currentAbort = null; }
    });
  }

  /* fallback single-shot SSE parse (non-streaming bodies) */
  var _fullDone = false;
  function consumeSSE(full, shell) {
    _fullDone = false;
    var parts = String(full).split('\n\n');
    var p, lines, L, payload, obj;
    for (p = 0; p < parts.length; p++) {
      lines = parts[p].split('\n');
      for (L = 0; L < lines.length; L++) {
        if (lines[L].indexOf('data:') !== 0) { continue; }
        payload = lines[L].slice(5).replace(/^\s/, '');
        if (payload === '[DONE]') { _fullDone = true; return; }
        try {
          obj = JSON.parse(payload);
          if (obj && typeof obj.t === 'string') { shell.append(obj.t); }
          if (obj && typeof obj.s === 'string' && shell.status) { shell.status(obj.s); }
          if (obj && obj.hold) { shell.held = true; }
          if (obj && obj.m && typeof obj.m === 'object') {
            if (obj.m.mid != null) { shell.mid = obj.m.mid; }
            if (obj.m.cid != null) { shell.cid = obj.m.cid; }
          }
        } catch (eJ) { /* ignore */ }
      }
    }
  }
  function consumeSSEFlush(shell) { finishTurn(shell); }

  /* ---- DEMO: keyword scoring + simulated stream ---- */
  function demoAnswerFor(userText) {
    var q = String(userText).toLowerCase();
    var entries = kbDemoEntries();
    var best = null, bestScore = 0;
    var i, j, entry, score, kw;
    for (i = 0; i < entries.length; i++) {
      entry = entries[i];
      if (!entry || typeof entry.answer !== 'string') { continue; }
      var match = entry.match;
      if (Object.prototype.toString.call(match) !== '[object Array]') { continue; }
      score = 0;
      for (j = 0; j < match.length; j++) {
        kw = String(match[j]).toLowerCase();
        if (kw && q.indexOf(kw) !== -1) { score++; }
      }
      if (score >= 1 && score > bestScore) { bestScore = score; best = entry; }
    }
    return best ? best.answer : null;
  }

  function demoFallbackAnswer() {
    return 'That one runs past my ledger, I’m afraid. I can speak with certainty ' +
      'about the **car**, the **people who make it**, the **numbering of the batch**, ' +
      'and how your car **arrives**. Pull on one of those, and I’ll take it up properly.';
  }

  function demoRespond(shell) {
    var lastUser = '';
    var i;
    for (i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') { lastUser = history[i].content; break; }
    }
    var answer = demoAnswerFor(lastUser);
    var fallback = false;
    if (answer == null) { answer = demoFallbackAnswer(); fallback = true; }

    var words = String(answer).split(/(\s+)/);
    /* build 2–5 word chunks (word + trailing space pairs) */
    var chunks = [], k = 0;
    while (k < words.length) {
      var take = (2 + Math.floor(Math.random() * 4)) * 2; /* 2–5 words incl. separators */
      chunks.push(words.slice(k, k + take).join(''));
      k += take;
    }

    var idx = 0;
    function emit() {
      if (!panelOpen && !streaming) { return; }
      if (idx >= chunks.length) {
        finishTurn(shell);
        if (fallback) { addSuggestChips(kbSuggested(null)); }
        return;
      }
      shell.append(chunks[idx]);
      idx++;
      var delay = REDUCED ? 0 : (24 + Math.floor(Math.random() * 17));
      demoTimers.push(setTimeout(emit, delay));
    }
    demoTimers.push(setTimeout(emit, REDUCED ? 0 : 500));
  }

  /* ----------------------------------------------------------
     10b. Accounts — magic link via supabase-js (lazy UMD load)
  ---------------------------------------------------------- */
  var sbClient = null, sbPromise = null;
  var authEmail = '';

  function ensureSupabase() {
    if (sbPromise) { return sbPromise; }
    sbPromise = new Promise(function (resolve) {
      if (!hasSupabase()) { resolve(null); return; }
      if (window.supabase && window.supabase.createClient) { resolve(makeSbClient()); return; }
      var s = document.createElement('script');
      s.src = SUPABASE_CDN;
      s.async = true;
      s.onload = function () { resolve(makeSbClient()); };
      s.onerror = function () { resolve(null); };
      (document.head || document.documentElement).appendChild(s);
    });
    return sbPromise;
  }

  function makeSbClient() {
    if (sbClient) { return sbClient; }
    try {
      if (!window.supabase || !window.supabase.createClient) { return null; }
      /* persistSession + detectSessionInUrl are supabase-js defaults;
         the magic-link redirect is picked up automatically */
      sbClient = window.supabase.createClient(supaUrl(), supaKey());
      try {
        sbClient.auth.onAuthStateChange(function (evt, session) { setAuthState(session); });
        sbClient.auth.getSession().then(function (r) {
          setAuthState(r && r.data ? r.data.session : null);
        }, function () { /* ignore */ });
      } catch (eL) { /* ignore */ }
    } catch (eC) { sbClient = null; }
    return sbClient;
  }

  function getAccessToken() {
    return new Promise(function (resolve) {
      /* A proactive opener can fire ~1.2s after the panel opens — before
         supabase-js has finished loading. Resolving null then sends a KNOWN
         patron's request out anonymous, so the opener greets them like a
         stranger (no name, no order history, generic discovery questions).
         When a session is expected (we remember their email), wait briefly
         for the client instead of giving up immediately. */
      var waited = 0;
      function attempt() {
        if (sbClient) {
          try {
            sbClient.auth.getSession().then(function (r) {
              var s = r && r.data ? r.data.session : null;
              resolve((s && s.access_token) ? s.access_token : null);
            }, function () { resolve(null); });
          } catch (eG) { resolve(null); }
          return;
        }
        if (!authEmail || waited >= 3600) { resolve(null); return; }
        waited += 180;
        setTimeout(attempt, 180);
      }
      attempt();
    });
  }

  /* Re-render just the greeting's suggestion chips (used when personalized
     starters arrive after the greeting was already drawn). */
  function refreshGreetingChips() {
    if (!msgsEl || history.length) { return; }
    var old = msgsEl.querySelector('.cx-suggest');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    addSuggestChips(kbSuggested(currentSection()));
  }

  /* Signed-in: pull context-aware starters built from the patron's own orders.
     Best-effort — on any failure the generic starters stand. */
  function fetchPersonalStarters() {
    if (!authEmail || !endpoint()) { return; }
    getAccessToken().then(function (token) {
      if (!token || !authEmail) { return; }
      var url = endpoint() + (endpoint().indexOf('?') === -1 ? '?starters=1' : '&starters=1');
      var ac = null;
      try { ac = new AbortController(); } catch (eA) { ac = null; }
      var timer = setTimeout(function () { if (ac) { try { ac.abort(); } catch (eT) { /* ignore */ } } }, 4000);
      fetch(url, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + token },
        signal: ac ? ac.signal : undefined
      }).then(function (res) {
        return res.ok ? res.json() : null;
      }).then(function (j) {
        clearTimeout(timer);
        if (!j || Object.prototype.toString.call(j.starters) !== '[object Array]') { return; }
        var clean = [], i;
        for (i = 0; i < j.starters.length; i++) {
          if (typeof j.starters[i] === 'string' && j.starters[i]) { clean.push(j.starters[i]); }
        }
        personalStarters = clean;
        if (panelOpen && !streaming) { refreshGreetingChips(); }
      }, function () { clearTimeout(timer); });
    });
  }

  /* Start a completely fresh conversation — used when the identity changes so
     one person's chat never bleeds into another's (or into an anonymous view). */
  function resetConversation() {
    abortStream();
    history = [];
    try { ssSet(HISTORY_KEY, '[]'); } catch (eRC) { /* ignore */ }
    lsDel(KEEP_KEY);             /* the kept transcript belongs to the old identity */
    ssSet(OWNER_KEY, authEmail || '');
    rotateSessionKey();
    reengagedThisOpen = false;
    wrappedUp = false;
    nudgeCount = 0;
    holdAttempts = 0;
    unacked = 0;
    pendingNudge = null;
    pendingOpener = null;
    clearNudge();
    setStreaming(false);
    if (panelOpen && msgsEl) {
      renderHistory();
      maybeOpenerOnOpen();
    }
  }

  /* On sign-out, drop the device-level purchase traces too, so the
     "welcome back Nº …" bubble can't surface to a signed-out viewer. */
  function clearDevicePurchaseTraces() {
    try {
      window.localStorage.removeItem('porsche_last_purchase');
      var i, keys = [];
      for (i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (k && k.indexOf('porsche_checkin_') === 0) { keys.push(k); }
      }
      for (i = 0; i < keys.length; i++) { window.localStorage.removeItem(keys[i]); }
    } catch (e) { /* ignore */ }
  }

  var authResolved = false;     /* the first auth read on load is not a change */

  /* Sign-in buttons rendered while the visitor was anonymous must not survive
     as live CTAs once they ARE signed in — the transcript isn't re-rendered on
     an adopt-the-thread sign-in (continuity is kept), so sweep the DOM. */
  function sweepSigninButtons() {
    if (!authEmail || !msgsEl) { return; }
    try {
      var bs = msgsEl.querySelectorAll('.cx-action-signin');
      for (var i = 0; i < bs.length; i++) {
        bs[i].disabled = true;
        bs[i].style.opacity = '0.45';
        bs[i].textContent = '✳ Signed in — the register is open to you';
      }
    } catch (eSw) { /* cosmetic only */ }
  }

  function setAuthState(session) {
    var em = '';
    try {
      em = (session && session.user && typeof session.user.email === 'string')
        ? session.user.email : '';
    } catch (eE) { em = ''; }
    var firstResolve = !authResolved;
    authResolved = true;

    if (em !== authEmail) {
      var prevOwner = authEmail;   /* who the current thread belonged to before this change */
      var wasResolved = !firstResolve;
      authEmail = em;
      /* Remember the verified email so it prefills the next sign-in (survives
         sign-out on purpose — it's this device's convenience, not a session). */
      if (em) { try { window.localStorage.setItem('porsche_last_email', em); } catch (eSE) { /* ignore */ } }
      if (em) { closeAuthRow(); }
      updateAuthUI();
      if (em) { personalStarters = []; fetchPersonalStarters(); } else { personalStarters = []; }
      if (wasResolved) {
        if (prevOwner && prevOwner !== em) {
          /* sign-out, or a switch to a DIFFERENT person — wipe so no thread bleeds */
          if (!em) { clearDevicePurchaseTraces(); }
          resetConversation();
        } else {
          /* anonymous → signed in: adopt this thread as the patron's, keeping
             continuity. The next turn backfills identity server-side, and we let
             the concierge acknowledge them now that it knows who they are. */
          ssSet(OWNER_KEY, em);
          restoreKeptHistory();
          if (panelOpen && msgsEl && !streaming) {
            reengagedThisOpen = false;
            if (!history.length) { renderHistory(); }
            sweepSigninButtons();
            maybeOpenerOnOpen();
          }
        }
        return;
      }
      /* first resolve WITH a restored identity — fall through to reconcile */
    } else if (!firstResolve) {
      return; /* no change and not the first read — nothing to do */
    }

    if (firstResolve) {
      /* Reconcile the stored conversation with who is actually signed in now.
         Wipe only when the saved thread belongs to a DIFFERENT real identity
         (e.g. leftover signed-in chat while now signed out); an anonymous thread
         (owner '') is adopted, so continuity is kept across a sign-in. */
      var owner = '';
      try { owner = ssGet(OWNER_KEY) || ''; } catch (eO) { owner = ''; }
      if (storedHistoryLen() > 0 && owner && owner !== em) {
        if (!em) { clearDevicePurchaseTraces(); }
        resetConversation();
      } else {
        ssSet(OWNER_KEY, em);
        if (em) { restoreKeptHistory(); }
        if (panelOpen && !streaming && !history.length && msgsEl) { renderHistory(); }
        sweepSigninButtons();
      }
    }
  }

  function shortEmail(em) {
    var at = em.indexOf('@');
    if (at < 1) { return em; }
    var local = em.slice(0, at);
    if (local.length > 7) { local = local.slice(0, 6) + '…'; }
    return local + em.slice(at);
  }

  function updateAuthUI() {
    if (!authBtn || !authMailEl) { return; }
    if (authEmail) {
      authMailEl.textContent = shortEmail(authEmail);
      authMailEl.title = authEmail;
      authMailEl.style.display = '';
      authBtn.textContent = 'Sign out';
      authBtn.setAttribute('aria-label', 'Sign out of ' + authEmail);
    } else {
      authMailEl.textContent = '';
      authMailEl.style.display = 'none';
      authBtn.textContent = 'Sign in';
      authBtn.setAttribute('aria-label', 'Sign in with a magic link');
    }
  }

  function onAuthLink() {
    if (authEmail) {
      ensureSupabase().then(function (client) {
        if (!client) { return; }
        try {
          client.auth.signOut().then(function () { setAuthState(null); },
            function () { /* ignore */ });
        } catch (eO) { /* ignore */ }
      });
      return;
    }
    if (authRow) { closeAuthRow(); return; }
    openAuthRow();
  }

  function openAuthRow(anchorEl) {
    if (!panel) { return; }
    if (authRow) {
      if (authRow.parentNode && document.contains(authRow)) {
        /* already open — a second tap must never look like a dead button:
           bring the form to the reader and focus it */
        try { authRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (eSv) { /* ignore */ }
        try { var ai = authRow.querySelector('.cx-authinput'); if (ai) { ai.focus(); } } catch (eAf) { /* ignore */ }
        return;
      }
      authRow = null; /* stale reference — a re-render wiped the node; rebuild */
    }
    ensureSupabase();
    authRow = el('div', 'cx-authrow');
    var cap = el('div', 'cx-authcap', 'Your email — we send a key, no passwords.');
    authRow.appendChild(cap);
    var line = el('div', 'cx-authline');
    var input = document.createElement('input');
    input.type = 'email';
    input.className = 'cx-authinput';
    input.placeholder = 'you@example.com';
    input.autocomplete = 'email';
    input.setAttribute('aria-label', 'Email for sign-in key');
    /* Prefill the last email this device signed in with, so a returning patron
       needn't retype it — selected, so a tap-Enter sends or a keystroke replaces. */
    var lastEmail = '';
    try { lastEmail = window.localStorage.getItem('porsche_last_email') || ''; } catch (eLE) { lastEmail = ''; }
    if (lastEmail) {
      input.value = lastEmail;
      cap.textContent = 'Welcome back — send a key to this email, or edit it.';
    }
    var send = el('button', 'cx-authsend', 'Send key');
    send.type = 'button';
    function fail(err) {
      send.disabled = false;
      send.textContent = 'Send key';
      var noClient = !!(err && err.noClient);
      var msg = '', status = 0, code = '';
      try {
        if (err && typeof err === 'object' && !noClient) {
          msg = err.message || (err.error && err.error.message) || '';
          status = err.status || (err.error && err.error.status) || 0;
          code = (err.code || (err.error && err.error.code) || '').toString();
        } else if (typeof err === 'string') { msg = err; }
      } catch (eM) { msg = ''; }
      try { if (window.console && window.console.warn) { window.console.warn('[concierge] sign-in failed:', err); } } catch (eC) { /* ignore */ }
      var rateLike = /rate|too many|seconds|limit/i.test(msg) || status === 429 || /rate/i.test(code);
      /* Distinguish "the sign-in library never loaded" (Supabase is never even
         contacted, so its logs are empty) from a real send failure. An opaque/
         empty error on a send is almost always the email sender's rate limit. */
      if (noClient) {
        cap.textContent = 'The sign-in service didn’t load — check your connection or a script/ad blocker, then retry.';
      } else if (rateLike) {
        cap.textContent = 'Too many key requests just now — the email sender is rate-limited. Wait a few minutes and try again.';
      } else if (msg) {
        cap.textContent = 'Could not send the key: ' + msg;
      } else {
        cap.textContent = 'The key couldn’t be sent — usually the email sender hitting its limit. Wait a few minutes and retry; if it keeps failing, the site’s email settings need a look.';
      }
    }
    function submit() {
      if (send.disabled) { return; }
      var em = (input.value || '').replace(/^\s+|\s+$/g, '');
      if (!em || em.indexOf('@') < 1) {
        try { input.focus(); } catch (eF) { /* ignore */ }
        return;
      }
      send.disabled = true;
      send.textContent = 'Sending…';
      /* Clean redirect target — never carry a leftover #access_token hash from a
         previous magic link, which can fail the redirect allow-list. */
      var redirectTo = location.origin + location.pathname;
      ensureSupabase().then(function (client) {
        if (!client) { fail({ noClient: true }); return; }
        try {
          client.auth.signInWithOtp({
            email: em,
            options: { emailRedirectTo: redirectTo }
          }).then(function (r) {
            if (r && r.error) { fail(r.error); return; }
            /* Remember the email so it prefills next time they sign in. */
            try { window.localStorage.setItem('porsche_last_email', em); } catch (eRem) { /* ignore */ }
            var row = authRow;
            if (!row) { return; }
            while (row.firstChild) { row.removeChild(row.firstChild); }
            row.appendChild(el('div', 'cx-authcap',
              'Sent. Check your inbox — the key can take a minute, and first keys sometimes land in spam.'));
            /* The key is on its way — every sign-in button in the transcript
               reflects that instead of standing as a fresh call-to-action. */
            try {
              var sbs = (msgsEl || document).querySelectorAll('.cx-action-signin');
              for (var sbi = 0; sbi < sbs.length; sbi++) {
                sbs[sbi].disabled = true;
                sbs[sbi].style.opacity = '0.45';
                sbs[sbi].textContent = '✳ Key sent — check your inbox';
              }
            } catch (eSb) { /* cosmetic only */ }
          }, fail);
        } catch (eS) { fail(eS); }
      });
    }
    send.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    line.appendChild(input);
    line.appendChild(send);
    authRow.appendChild(line);
    /* IN the conversation flow, not pinned: the form mounts DIRECTLY UNDER the
       sign-in button that was tapped (or at the thread's end when opened from
       the header), and scrolls away with the conversation — a bar pinned to
       the panel that follows the reader while they scroll is nagging. */
    var anchorRow = null;
    try {
      anchorRow = (anchorEl && anchorEl.closest) ? anchorEl.closest('.cx-actionrow') : null;
    } catch (eAn) { anchorRow = null; }
    if (anchorRow && anchorRow.parentNode) {
      anchorRow.parentNode.insertBefore(authRow, anchorRow.nextSibling);
    } else {
      msgsEl.appendChild(authRow);
    }
    try { authRow.scrollIntoView({ block: 'nearest' }); } catch (eSc) { /* ignore */ }
    try { input.focus(); if (lastEmail) { input.select(); } } catch (eI) { /* ignore */ }
  }

  function closeAuthRow() {
    if (authRow && authRow.parentNode) { authRow.parentNode.removeChild(authRow); }
    authRow = null;
  }

  /* ----------------------------------------------------------
     10c. Feedback — ↑/↓ under completed assistant messages
  ---------------------------------------------------------- */
  function addFeedback(turn, mid) {
    var box = el('div', 'cx-fb');
    var up = el('button', 'cx-fbbtn', '↑');
    up.type = 'button';
    up.setAttribute('aria-label', 'Helpful');
    var down = el('button', 'cx-fbbtn', '↓');
    down.type = 'button';
    down.setAttribute('aria-label', 'Not helpful');
    function remove() {
      if (box.parentNode) { box.parentNode.removeChild(box); }
    }
    function vote(rating) {
      if (up.disabled) { return; } /* one vote per message */
      up.disabled = true;
      down.disabled = true;
      try {
        fetch(supaUrl() + '/rest/v1/concierge_feedback', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supaKey(),
            'Authorization': 'Bearer ' + supaKey(),
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ message_id: mid, rating: rating })
        }).then(function (res) {
          if (res.ok) {
            while (box.firstChild) { box.removeChild(box.firstChild); }
            box.appendChild(el('span', 'cx-fbnote', 'Noted.'));
          } else {
            remove();
          }
        }, remove);
      } catch (eV) { remove(); }
    }
    up.addEventListener('click', function () { vote(1); });
    down.addEventListener('click', function () { vote(-1); });
    box.appendChild(up);
    box.appendChild(down);
    turn.appendChild(box);
    scrollToBottom(false);
  }

  /* ----------------------------------------------------------
     10d. Inline conversation starters woven into the page
          Second starter per section (index 1) — the floating
          context chip already uses index 0.
  ---------------------------------------------------------- */
  var LIGHT_SECTIONS = { 'what-makes-it-special': 1, 'every-angle-every-light': 1 }; /* light-coloured backgrounds → ink text */

  /* Where the inline "Ask about the car ✳" starters render — admin-configurable
     (outreach.inlineSections, an array of section keys) with the baked list as
     default. 'hero' is a valid key: the hero header's DOM id is 'top', so it
     is mapped explicitly (checking hero in the starters config used to do
     nothing because getElementById('hero') found no element). */
  function inlinePlacementList() {
    var o = orCfg();
    var raw = o.inlineSections;
    if (Object.prototype.toString.call(raw) !== '[object Array]') { return INLINE_SECTIONS; }
    var out = [], i, v;
    for (i = 0; i < raw.length && out.length < 12; i++) {
      v = raw[i];
      if (typeof v === 'string' && /^[a-z0-9_-]{1,32}$/i.test(v)) { out.push(v.toLowerCase()); }
    }
    return out.length ? out : INLINE_SECTIONS;
  }
  function initInlineStarters() {
    var list0 = inlinePlacementList(), i;
    for (i = 0; i < list0.length; i++) {
      (function (id) {
        var section = document.getElementById(id) ||
          (id === 'hero' ? (document.getElementById('top') || document.querySelector('header.hero')) : null);
        if (!section) { return; }
        var list = kbSuggested(id);   /* override + baked top-up, so never sparse */
        if (list.length < 2) { return; }
        var question = String(list[1]);
        if (!question) { return; }
        /* match the section's own gutters by living inside its inner wrapper */
        var target = section.querySelector('.hero-content,.scrub-inner,.specs-inner,.ritual-inner,.arrival-inner');
        var pad = false;
        if (!target) {
          var head = section.querySelector('.benefits-head');
          if (head && head.parentNode) { target = head.parentNode; }
          else { target = section; pad = true; }
        }
        var b = el('button', 'cx-inline');
        b.type = 'button';
        if (LIGHT_SECTIONS[id]) { b.className += ' cx-inline-ink'; }
        if (pad) { b.className += ' cx-inline-pad'; }
        b.setAttribute('aria-label', 'Ask about the car: ' + question);
        b.appendChild(el('span', 'cx-inline-star', '✳'));
        b.appendChild(el('span', 'cx-inline-q', question));
        b.appendChild(el('span', 'cx-inline-arrow', '→'));
        b.addEventListener('click', function () { openPanel(question); });
        target.appendChild(b);
        roots.push(b);
      })(INLINE_SECTIONS[i]);
    }
    syncReduced();
  }

  /* ----------------------------------------------------------
     10e. Brass shimmer across the panel's top hairline
  ---------------------------------------------------------- */
  var shimmerTimer = null;

  function runShimmer() {
    if (REDUCED || !panel) { return; }
    var old = panel.querySelector('.cx-shimline');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    if (shimmerTimer) { clearTimeout(shimmerTimer); shimmerTimer = null; }
    var line = el('div', 'cx-shimline');
    line.setAttribute('aria-hidden', 'true');
    line.appendChild(el('i'));
    panel.appendChild(line);
    shimmerTimer = setTimeout(function () {
      shimmerTimer = null;
      if (line.parentNode) { line.parentNode.removeChild(line); }
    }, 2400);
  }

  /* ----------------------------------------------------------
     11. Panel open / close, focus trap, body lock
  ---------------------------------------------------------- */
  var panelOpen = false;
  var lastFocused = null;
  var savedBodyOverflow = '', savedHtmlOverflow = '';

  function lockBody() {
    savedBodyOverflow = document.body.style.overflow;
    savedHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  }
  function unlockBody() {
    document.body.style.overflow = savedBodyOverflow;
    document.documentElement.style.overflow = savedHtmlOverflow;
  }

  function openPanel(prefillQuestion) {
    if (!panel) { return; } /* not mounted (yet), or remotely disabled */
    /* Only short-circuit if the panel is TRULY open on screen. If panelOpen got
       stuck true (e.g. a prior open threw before it finished), recover and open
       anyway rather than swallowing the click. */
    if (panelOpen && panel.classList.contains('cx-open')) {
      if (typeof prefillQuestion === 'string' && prefillQuestion && !streaming) {
        sendMessage(prefillQuestion);
      }
      return;
    }
    panelOpen = true;
    sendBeacon('chat_open');
    /* Make it visible FIRST, so nothing below (a render hiccup, Supabase load)
       can leave the panel invisible while panelOpen is true. */
    hideChip();
    scrim.classList.add('cx-on');
    panel.classList.add('cx-open');
    lockBody();
    updateLauncher();
    if (hasSupabase()) { try { ensureSupabase(); } catch (eSb) { /* ignore */ } }
    lastFocused = (document.activeElement && document.activeElement !== document.body)
      ? document.activeElement : launcher;
    try { loadHistory(); renderHistory(); } catch (eR) { /* a render hiccup must not block opening */ }
    pinned = true;
    runShimmer();
    maybeSwipeHint();
    try { scrollToBottom(true); } catch (eSc) { /* ignore */ }
    setTimeout(function () {
      /* On a pointer device, land the cursor in the composer so they can type
         at once; on touch, focus the panel so the keyboard doesn't spring up. */
      try { ((pointerFine() && inputEl && !inputEl.disabled) ? inputEl : panel).focus(); } catch (e) { /* ignore */ }
    }, REDUCED ? 0 : 80);
    if (typeof prefillQuestion === 'string' && prefillQuestion && !streaming) {
      sendMessage(prefillQuestion);
    } else {
      maybeOpenerOnOpen();
    }
  }

  function closePanel() {
    if (!panelOpen) { return; }
    /* Bot-automatic half of the "mix of both": dismissing the panel after a
       real exchange records the conversation as wound down, so the next visit
       reads as a re-engagement rather than one endless thread. */
    doWrapup('auto');
    panelOpen = false;
    reengagedThisOpen = false;   /* next open may re-engage afresh */
    abortStream();
    clearNudge();
    panel.classList.remove('cx-open');
    panel.classList.remove('cx-tall');
    scrim.classList.remove('cx-on');
    unlockBody();
    updateLauncher();
    if (lastFocused && lastFocused.focus) {
      try { launcher.focus(); } catch (e) { /* ignore */ }
    } else if (launcher) {
      try { launcher.focus(); } catch (e2) { /* ignore */ }
    }
    lastFocused = null;
  }

  function trapFocus(e) {
    if (e.key !== 'Tab') { return; }
    var focusables = panel.querySelectorAll(
      'button:not(:disabled),textarea:not(:disabled),input:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) { return; }
    var list = [], i;
    for (i = 0; i < focusables.length; i++) {
      if (focusables[i].offsetParent !== null || focusables[i] === document.activeElement) {
        list.push(focusables[i]);
      }
    }
    if (!list.length) { return; }
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && panelOpen) {
      e.preventDefault();
      closePanel();
    }
  }

  /* ----------------------------------------------------------
     12. Bottom-sheet drag (mobile)
  ---------------------------------------------------------- */
  /* One-time tutorial: on mobile the sheet expands on a swipe up, but nothing
     said so. A rising chevron + caption over the handle teaches it — shown at
     most twice ever, gone the moment they drag, and permanently done once
     they've expanded. Reduced motion gets the caption without the animation. */
  var swipeHintEl = null;
  function dismissSwipeHint(learned) {
    if (learned) { lsSet('cx-swipe-hint', 'done'); }
    if (swipeHintEl && swipeHintEl.parentNode) { swipeHintEl.parentNode.removeChild(swipeHintEl); }
    swipeHintEl = null;
    if (panel) { panel.classList.remove('cx-hintnudge'); }
  }
  function maybeSwipeHint() {
    if (window.innerWidth >= 900) { return; }        /* the sheet only drags on mobile */
    if (!panel || panel.classList.contains('cx-tall')) { return; }
    var state = lsGet('cx-swipe-hint') || '';
    if (state === 'done') { return; }
    var seen = parseInt(state, 10) || 0;
    if (seen >= 2) { lsSet('cx-swipe-hint', 'done'); return; }  /* twice is teaching; more is nagging */
    var handle = panel.querySelector('.cx-handle');
    if (!handle) { return; }
    lsSet('cx-swipe-hint', String(seen + 1));
    dismissSwipeHint(false);
    swipeHintEl = el('div', 'cx-swipehint');
    swipeHintEl.appendChild(el('span', 'cx-swipearr', '↑'));
    swipeHintEl.appendChild(el('span', '', 'swipe up for more room'));
    handle.appendChild(swipeHintEl);
    panel.classList.add('cx-hintnudge');   /* the sheet demonstrates its own gesture */
    setTimeout(function () { dismissSwipeHint(false); }, REDUCED ? 3500 : 6000);
  }

  function initDrag(handle, head) {
    var startY = 0, delta = 0, dragging = false;

    function onStart(e) {
      if (window.innerWidth >= 900) { return; }
      dismissSwipeHint(false);   /* they've grabbed the handle — the hint has served */
      dragging = true;
      delta = 0;
      startY = (e.touches ? e.touches[0].clientY : e.clientY);
      panel.classList.add('cx-dragging');
    }
    function onMove(e) {
      if (!dragging) { return; }
      var y = (e.touches ? e.touches[0].clientY : e.clientY);
      delta = y - startY;
      if (delta > 0) {
        panel.style.transform = 'translateY(' + delta + 'px)';
      } else {
        panel.style.transform = 'translateY(0)';
      }
      if (e.cancelable) { e.preventDefault(); }
    }
    function onEnd() {
      if (!dragging) { return; }
      dragging = false;
      panel.classList.remove('cx-dragging');
      panel.style.transform = '';
      if (delta > 90) {
        closePanel();
      } else if (delta < -60) {
        panel.classList.add('cx-tall');
        dismissSwipeHint(true);   /* learned — never show the tutorial again */
      }
      delta = 0;
    }

    var targets = [handle, head], t;
    for (t = 0; t < targets.length; t++) {
      if (!targets[t]) { continue; }
      targets[t].addEventListener('touchstart', onStart, { passive: true });
      targets[t].addEventListener('mousedown', onStart);
    }
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
  }

  /* ----------------------------------------------------------
     13. visualViewport — keep composer above the keyboard
  ---------------------------------------------------------- */
  function initVisualViewport() {
    var vv = window.visualViewport;
    if (!vv) { return; }
    function onVV() {
      if (!panelOpen || window.innerWidth >= 900) {
        panel.style.bottom = '';
        panel.style.maxHeight = '';
        return;
      }
      var inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      if (inset > 40) {
        panel.style.bottom = inset + 'px';
        panel.style.maxHeight = Math.max(240, vv.height - 12) + 'px';
      } else {
        panel.style.bottom = '';
        panel.style.maxHeight = '';
      }
      if (pinned) { scrollToBottom(true); }
    }
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
  }

  /* ----------------------------------------------------------
     14. Section polling (catches __porscheState-driven changes)
  ---------------------------------------------------------- */
  var lastKnownSection = null;
  function initSectionPoll() {
    lastKnownSection = currentSection();
    setInterval(function () {
      var s = currentSection();
      if (s !== lastKnownSection) {
        lastKnownSection = s;
        onSectionChange(s);
      }
    }, 250);
  }

  /* ----------------------------------------------------------
     15. Boot
  ---------------------------------------------------------- */
  /* ── Funnel beacons (?track=1) — PII-free events feeding the admin's
     Conversion funnel: 'visit' (page loaded) and 'chat_open' (panel opened)
     from here; 'checkout_open' from checkout.js. One per kind per tab
     session (the funnel dedupes by visit_key anyway); fire-and-forget —
     a beacon must never affect the page. See ATTRIBUTION.md. */
  function beaconVisitKey() {
    try {
      var k = window.localStorage.getItem('porsche_visit');
      if (k && /^[A-Za-z0-9_-]{8,64}$/.test(k)) { return k; }
      k = 'v';
      var a = new Uint8Array(16);
      if (window.crypto && window.crypto.getRandomValues) { window.crypto.getRandomValues(a); }
      else { for (var j = 0; j < a.length; j++) { a[j] = Math.floor(Math.random() * 256); } }
      for (var i = 0; i < a.length; i++) { k += (a[i] % 36).toString(36); }
      window.localStorage.setItem('porsche_visit', k);
      return k;
    } catch (eV) { return ''; }
  }
  function sendBeacon(kind, extra) {
    if (isDemo()) { return; }
    try {
      if (window.sessionStorage.getItem('cx-ev-' + kind) === '1') { return; }
      window.sessionStorage.setItem('cx-ev-' + kind, '1');
    } catch (eD) { /* no storage — still send once */ }
    try {
      var vk = beaconVisitKey();
      if (!vk) { return; }
      var body = { kind: kind, visit_key: vk, section: currentSection() };
      var sk = '';
      try { sk = window.sessionStorage.getItem('cx-skey') || ''; } catch (eK) { /* ignore */ }
      if (sk) { body.session_key = sk; }
      if (extra) { for (var p in extra) { if (extra[p] != null) { body[p] = extra[p]; } } }
      fetch(endpoint() + (endpoint().indexOf('?') === -1 ? '?track=1' : '&track=1'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        keepalive: true, body: JSON.stringify(body)
      })['catch'](function () { /* nothing to recover */ });
    } catch (eB) { /* a beacon never breaks the page */ }
  }

  function mountAll() {
    buildUI();
    sendBeacon('visit');
    initInlineStarters();
    initSectionObserver();
    initSectionPoll();
    initVisualViewport();
    lastY = window.scrollY || window.pageYOffset || 0;
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', updateLauncher);
    document.addEventListener('keydown', onKeydown);
    /* Record the wind-down when the visitor leaves. pagehide covers close /
       navigation on desktop; visibilitychange→hidden is the reliable signal on
       mobile (where pagehide is often skipped) and when the tab is backgrounded.
       The keepalive beacon survives the page being frozen/unloaded, and the
       once-only wrappedUp guard means a quick tab-switch fires it at most once —
       returning and writing again resumes the same conversation. */
    window.addEventListener('pagehide', function () {
      if (panelOpen) { doWrapup('auto'); }   /* a real unload: close / navigate away */
    });
    /* A brief tab-switch (glancing at another tab, e.g. the admin) must NOT end a
       live conversation. Only wind down if the tab stays hidden a while — a real
       leave. Returning before then cancels it; pagehide still handles an outright
       close/navigation immediately. */
    var hiddenWrapTimer = null;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        if (panelOpen && !hiddenWrapTimer) {
          hiddenWrapTimer = setTimeout(function () {
            hiddenWrapTimer = null;
            if (document.visibilityState === 'hidden' && panelOpen) { doWrapup('auto'); }
          }, 60000);
        }
      } else if (document.visibilityState === 'visible') {
        if (hiddenWrapTimer) { clearTimeout(hiddenWrapTimer); hiddenWrapTimer = null; }
        noteActivity('tab-return');            /* they came back — a sign of life */
        /* If the away-wrap ran while the panel stayed OPEN, every timer was
           cleared and no click can restart them (a launcher tap on an open panel
           is a no-op) — the bot was structurally mute. Returning to an open,
           wound-down panel re-engages exactly like a re-open. */
        if (panelOpen && wrappedUp && !streaming) {
          reengagedThisOpen = false;
          maybeOpenerOnOpen();
        }
      }
    });
    /* Presence signals — any of these means the visitor is here and could see a
       message, so they acknowledge the concierge's reach-outs and resume it. */
    var actOpts = { passive: true };
    document.addEventListener('pointerdown', function () { noteActivity('tap'); }, actOpts);
    document.addEventListener('keydown', function () { noteActivity('key'); }, actOpts);
    document.addEventListener('touchstart', function () { noteActivity('touch'); }, actOpts);
    document.addEventListener('scroll', function () { noteActivity('scroll'); }, actOpts);
    var lastMove = 0;
    document.addEventListener('pointermove', function () {
      var now = Date.now();
      if (now - lastMove > 4000) { lastMove = now; noteActivity('mouse-move'); }
    }, actOpts);
    updateLauncher();
    /* Resolve any signed-in session early (and collect a magic-link redirect if
       present), so the concierge knows who they are BEFORE the panel opens —
       otherwise a signed-in patron gets the slow anonymous greeting timing. */
    if (authEnabled()) {
      ensureSupabase();
    }
  }

  function boot() {
    injectStyle();
    fetchRemoteConfig(function () {
      /* remotely switched off: mount nothing — no launcher, chips or starters */
      if (endpoint() && remoteCfgOk && remoteEnabled === false) { return; }
      mountAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* ----------------------------------------------------------
     16. Public API
  ---------------------------------------------------------- */
  window.PorscheConcierge = {
    open: function (prefillQuestion) { openPanel(prefillQuestion); },
    close: function () { closePanel(); },
    /* Diagnostic snapshot: why is the bot talking — or not? Run
       PorscheConcierge.status() in the console. lastSkip names the exact
       gate that stopped the most recent proactive beat. Set
       window.PORSCHE_CX_DEBUG = true to also see each skip logged live. */
    status: function () {
      var oc = orCfg();
      var cap = (typeof oc.nudgeCap === 'number') ? oc.nudgeCap : (NUDGE_CAP + (assertLevel() - 3));
      var ucap = effUnackedCap();
      var spoke = false, i;
      for (i = 0; i < history.length; i++) { if (history[i].role === 'user') { spoke = true; break; } }
      return {
        signedIn: !!authEmail,
        email: authEmail || null,
        panelOpen: panelOpen,
        checkoutOpen: checkoutOpen(),
        quietMode: quietMode,
        quietRemainingMs: quietMode ? Math.max(0, quietUntil - Date.now()) : 0,
        wrappedUp: wrappedUp,
        visitorHasTyped: spoke,
        nudgeCount: nudgeCount,
        nudgeCap: cap,
        unacked: unacked,
        unackedCap: ucap,
        holdAttempts: holdAttempts,
        holdBudget: effHoldBudget(),
        reengageCount: reengageCount,
        historyTurns: history.length,
        lastRole: history.length ? history[history.length - 1].role : null,
        entryMode: entryMode,
        nudgeTimerArmed: !!nudgeTimer,
        nudgeArmedMs: nudgeArmedMs,
        nudgeArmedAgoMs: nudgeArmedAt ? (Date.now() - nudgeArmedAt) : null,
        nudgeArmedWhy: nudgeArmedWhy,
        readFloorMs: readFloorMs(),
        reengage: (function () {
          var c = reengageCfg(), pc = reengagePostCfg(), pa = purchaseAgeMs();
          return {
            enabled: c.enabled,
            count: reengageCount,
            max: c.max,
            firesAfterIdleMs: c.idleMs,
            idleForMs: hadActivity ? (Date.now() - lastActivityTs) : null,
            maxIdleMsThisVisit: maxIdleMs,
            lastActivitySource: lastActivitySrc || null,
            hadPageActivity: hadActivity,
            freshActivitySinceLast: activeSinceReengage,
            bubbleOnScreen: !!outreachEl,
            postSaleGraceActive: pa !== null && pa < pc.graceMs
          };
        })(),
        postSale: (function () {
          var pc = reengagePostCfg(), pa = purchaseAgeMs();
          return {
            purchasedAgoMs: pa,
            graceMs: pc.graceMs,
            graceActive: pa !== null && pa < pc.graceMs,
            windowMs: pc.windowMs,
            windowActive: pa !== null && pa < pc.windowMs,
            mode: pc.mode,
            secondSaleBeatEnabled: pc.mode === 'upsell'
          };
        })(),
        lastSkip: lastSkip || '(no proactive beat has been skipped yet)',
        recentSkips: skipLog.slice().reverse()
      };
    }
  };
})();
