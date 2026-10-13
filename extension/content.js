// Watch Sync — content script on streaming sites.
// Watches the page's <video>, sends your play/pause/seek to your partner,
// and applies theirs. Each person plays from their own account; only
// tiny control messages travel between you.

(() => {
  if (window.top !== window) return;               // only the top page
  const isNetflix = /(^|\.)netflix\.com$/.test(location.hostname);

  let active = false, role = null, partner = "Partner", linkStatus = "idle";
  let video = null, suppressUntil = 0, pausedMismatch = 0;
  const off = [];

  const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
  const send = msg => chrome.runtime.sendMessage({ to: "bg", cmd: "send", msg }).catch(() => {});
  const suppress = (ms = 1000) => { suppressUntil = Date.now() + ms; };

  // ------------------------------------------------------------ on-page UI (shadow DOM so site CSS can't touch it)
  const hostEl = document.createElement("div");
  hostEl.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;";
  const root = hostEl.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      .pill { position: fixed; left: 18px; bottom: 18px; display: flex; align-items: center; gap: 8px;
        font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #eceef2;
        background: rgba(18,19,23,.86); border: 1px solid #2a2d35; border-radius: 999px; padding: 8px 12px;
        backdrop-filter: blur(10px); transition: opacity .4s; pointer-events: none; }
      .pill.dim { opacity: 0; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #9095a1; }
      .dot.on { background: #34d399; box-shadow: 0 0 0 3px rgba(52,211,153,.2); }
      .toast { position: fixed; left: 50%; top: 22px; transform: translate(-50%, -150%); transition: transform .25s;
        font: 500 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #eceef2;
        background: rgba(18,19,23,.92); border: 1px solid #2a2d35; border-radius: 999px; padding: 10px 16px;
        display: flex; gap: 10px; align-items: center; max-width: 80vw; }
      .toast.show { transform: translate(-50%, 0); }
      .toast button { all: unset; cursor: pointer; background: #a78bfa; color: #140b2e; font-weight: 600; padding: 5px 12px; border-radius: 999px; }
    </style>
    <div class="pill dim" id="pill"><span class="dot" id="dot"></span><span id="ptxt"></span></div>
    <div class="toast" id="toast"><span id="ttxt"></span><button id="tbtn" hidden></button></div>`;
  const $ = id => root.getElementById(id);
  let toastT, pillT;
  function toast(text, btn, onClick, ms = 2800) {
    $("ttxt").textContent = text;
    const b = $("tbtn"); b.hidden = !btn; b.textContent = btn || ""; b.onclick = onClick || null;
    $("toast").classList.add("show"); clearTimeout(toastT);
    toastT = setTimeout(() => $("toast").classList.remove("show"), ms);
  }
  function pill(text, on, stay) {
    $("ptxt").textContent = text; $("dot").className = "dot" + (on ? " on" : "");
    $("pill").classList.remove("dim"); clearTimeout(pillT);
    if (!stay) pillT = setTimeout(() => $("pill").classList.add("dim"), 4000);
  }
  function mountUI() {
    const parent = document.fullscreenElement && document.fullscreenElement.tagName !== "VIDEO" ? document.fullscreenElement : document.documentElement;
    if (hostEl.parentNode !== parent) parent.appendChild(hostEl);
  }
  document.addEventListener("fullscreenchange", () => active && mountUI());

  function renderStatus() {
    const map = {
      connected: [`Synced with ${partner}`, true],
      waiting: ["Waiting for your partner to join…", false],
      connecting: ["Connecting…", false],
      "partner-offline": [`Waiting for ${partner === "Partner" ? "the host" : partner}…`, false],
      reconnecting: ["Reconnecting…", false],
    };
    const [t, on] = map[linkStatus] || ["Watch Sync", false];
    pill(t, on, !on);
  }

  // ------------------------------------------------------------ finding the right <video>
  function findVideo() {
    let best = null, area = 0;
    document.querySelectorAll("video").forEach(v => {
      const r = v.getBoundingClientRect(), a = r.width * r.height;
      if (a > area && (v.currentSrc || v.src || v.srcObject || v.readyState > 0)) { area = a; best = v; }
    });
    return best;
  }
  function bind() {
    const v = findVideo();
    if (v === video) return;
    off.splice(0).forEach(f => f());
    video = v;
    if (!v) return;
    ["play", "pause", "seeked"].forEach(type => {
      const fn = () => onLocal(type);
      v.addEventListener(type, fn);
      off.push(() => v.removeEventListener(type, fn));
    });
  }

  // ------------------------------------------------------------ controlling playback
  // Netflix's player breaks if you set currentTime directly, so we go through its own API (netflix-main.js).
  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || e.data.__ws !== "nf-fail" || !video) return;
    if (e.data.op === "play") video.play().catch(() => {});
    if (e.data.op === "pause") video.pause();
  });
  const nf = (op, t) => window.postMessage({ __ws: "nf", op, t }, "*");
  const doPlay = () => { if (isNetflix) nf("play"); else video.play().catch(() => toast(`${partner} pressed play — click play to catch up`)); };
  const doPause = () => { if (isNetflix) nf("pause"); else video.pause(); };
  const doSeek = t => { if (isNetflix) nf("seek", t); else video.currentTime = Math.max(0, t); };

  // ------------------------------------------------------------ local → partner
  function onLocal(type) {
    if (!active || !video || Date.now() < suppressUntil) return;
    const t = video.currentTime, at = Date.now();
    if (type === "seeked") send({ type: "seek", t, paused: video.paused, at });
    else send({ type, t, at });
  }

  // ------------------------------------------------------------ partner → local
  function applyRemote(m) {
    bind();
    if (!video) return toast(`${partner} is playing something, open the same title to sync`);
    const elapsed = Math.max(0, (Date.now() - m.at) / 1000);
    suppress(1200);
    if (m.type === "play") {
      const target = m.t + elapsed;
      if (Math.abs(video.currentTime - target) > 0.6) doSeek(target);
      if (video.paused) doPlay();
      toast(`${partner} pressed play`);
    } else if (m.type === "pause") {
      if (!video.paused) doPause();
      if (Math.abs(video.currentTime - m.t) > 0.6) setTimeout(() => doSeek(m.t), 80);
      toast(`${partner} paused`);
    } else if (m.type === "seek") {
      const target = m.paused ? m.t : m.t + elapsed;
      doSeek(target);
      toast(`${partner} jumped to ${fmt(target)}`);
    }
  }

  // Guest quietly follows the host's heartbeat to correct any drift.
  function onTick(m) {
    if (role !== "guest" || !video) return;
    const elapsed = Math.max(0, (Date.now() - m.at) / 1000);
    const target = m.paused ? m.t : m.t + elapsed;
    if (m.force || m.paused !== video.paused) {
      pausedMismatch++;
      if (m.force || pausedMismatch >= 2) {
        suppress(1500);
        if (Math.abs(video.currentTime - target) > 0.6) doSeek(target);
        if (m.paused && !video.paused) doPause();
        if (!m.paused && video.paused) doPlay();
        pausedMismatch = 0;
      }
      return;
    }
    pausedMismatch = 0;
    if (!m.paused && Math.abs(video.currentTime - target) > 1.2 && Date.now() > suppressUntil) { suppress(1500); doSeek(target); }
  }

  function sendTick(force) {
    if (!active || role !== "host" || !video) return;
    send({ type: "tick", t: video.currentTime, paused: video.paused, at: Date.now(), force: !!force });
  }

  function sendNav() { if (active) send({ type: "nav", url: location.href, title: document.title }); }
  function onNav(m) {
    try {
      const theirs = new URL(m.url);
      if (theirs.hostname === location.hostname && theirs.pathname === location.pathname) return;
      const title = (m.title || "").replace(/\s*[|\-–—]\s*(Netflix|Disney\+|Max|Hulu|Prime Video|YouTube|Peacock|Paramount\+).*$/i, "").trim();
      toast(`${partner} is on ${title || theirs.hostname}`, "Open", () => { location.href = m.url; }, 9000);
    } catch {}
  }

  function onPeer(m) {
    if (!active || !m) return;
    if (m.type === "joined") { sendNav(); setTimeout(() => sendTick(true), 400); return; }
    if (m.type === "play" || m.type === "pause" || m.type === "seek") applyRemote(m);
    else if (m.type === "tick") onTick(m);
    else if (m.type === "nav") onNav(m);
  }

  // ------------------------------------------------------------ lifecycle
  let timers = [];
  let lastHref = location.href;
  function activate(info) {
    active = true; role = info.role; if (info.partnerName) partner = info.partnerName;
    linkStatus = info.status || linkStatus;
    mountUI(); renderStatus();
    timers.forEach(clearInterval);
    timers = [
      setInterval(bind, 1000),
      setInterval(() => sendTick(false), 4000),
      setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; sendNav(); } }, 1000),
    ];
    bind(); sendNav();
  }
  function deactivate() {
    active = false; timers.forEach(clearInterval); timers = [];
    off.splice(0).forEach(f => f()); video = null;
    hostEl.remove();
  }

  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (!m || m.to) return;   // messages with `to` are for the background/offscreen, not us
    reply({ ok: true });
    if (m.type === "activate") activate(m);
    else if (m.type === "deactivate") deactivate();
    else if (m.type === "peer") onPeer(m.msg);
    else if (m.type === "status") {
      const was = linkStatus; linkStatus = m.status; if (m.partnerName) partner = m.partnerName;
      if (active) { renderStatus(); if (was !== "connected" && linkStatus === "connected") toast(`${partner} joined`); }
    }
  });

  chrome.runtime.sendMessage({ to: "bg", cmd: "hello" }).then(r => { if (r && r.active) activate(r); }).catch(() => {});
})();
