// Watch Sync — content script on streaming sites.
// Watches the page's <video>, sends your play/pause/seek to your partner,
// and applies theirs. Each person plays from their own account; only
// tiny control messages travel between you.

(() => {
  if (window.top !== window) return;               // only the top page
  const isNetflix = /(^|\.)netflix\.com$/.test(location.hostname);

  let active = false, role = null, partner = "Partner", linkStatus = "idle";
  let requests = [];   // host only: people waiting for Allow / Deny, [{ id, name }]
  let video = null, suppressUntil = 0, pausedMismatch = 0;
  const off = [];

  const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
  const send = msg => chrome.runtime.sendMessage({ to: "bg", cmd: "send", msg }).catch(() => {});
  const suppress = (ms = 1000) => { suppressUntil = Date.now() + ms; };

  // Chat text and reactions come from the other peer, so they are cleaned and capped before use
  // and only ever shown with textContent. Reactions must be one of this fixed set.
  const REACTIONS = ["😂", "❤️", "😮", "😢", "👏", "🔥"];
  const MAX_CHAT = 500;
  const cleanText = s => Array.from((typeof s === "string" ? s : "").slice(0, 4000).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim()).slice(0, MAX_CHAT).join("");
  // At most n calls per ms; anything faster is dropped.
  const limiter = (n, ms) => { let seen = []; return () => { const t = Date.now(); seen = seen.filter(x => t - x < ms); if (seen.length >= n) return false; seen.push(t); return true; }; };

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
      .reqs { position: fixed; right: 18px; top: 18px; display: flex; flex-direction: column; gap: 8px; }
      .reqs.beside { right: 338px; }
      @media (max-width: 700px) { .reqs.beside { right: 18px; z-index: 1; } }
      .req { display: flex; gap: 8px; align-items: center; max-width: 340px;
        font: 500 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #eceef2;
        background: rgba(18,19,23,.92); border: 1px solid #2a2d35; border-radius: 14px; padding: 8px 10px 8px 14px; }
      .req span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .req button { all: unset; cursor: pointer; background: #2a2d35; color: #eceef2; font-weight: 600; padding: 5px 12px; border-radius: 999px; }
      .req button.yes { background: #a78bfa; color: #140b2e; }
      .toast button { all: unset; cursor: pointer; background: #a78bfa; color: #140b2e; font-weight: 600; padding: 5px 12px; border-radius: 999px; }
      [hidden] { display: none !important; }
      .chatbtn { all: unset; box-sizing: border-box; position: fixed; right: 14px; top: 50%; transform: translateY(-50%); width: 44px; height: 44px;
        display: grid; place-items: center; cursor: pointer; font-size: 20px; line-height: 1; border-radius: 50%;
        background: rgba(18,19,23,.86); border: 1px solid #2a2d35; backdrop-filter: blur(10px); transition: opacity .4s; }
      .chatbtn.dim { opacity: 0; }
      .chatbtn:focus-visible { outline: 2px solid #a78bfa; }
      .badge { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; box-sizing: border-box; padding: 0 5px; border-radius: 9px;
        font: 600 11px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: center; background: #a78bfa; color: #140b2e; }
      .panel { position: fixed; top: 0; right: 0; bottom: 0; width: 320px; max-width: 90vw; box-sizing: border-box; display: flex; flex-direction: column;
        font: 400 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #eceef2;
        background: rgba(14,15,18,.9); border-left: 1px solid #2a2d35; backdrop-filter: blur(12px);
        transform: translateX(100%); visibility: hidden; transition: transform .2s, visibility 0s .2s; }
      .panel.open { transform: none; visibility: visible; transition: transform .2s; }
      .panel * { box-sizing: border-box; }
      .head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #2a2d35; font-weight: 600; }
      .head button { all: unset; cursor: pointer; padding: 2px 8px; border-radius: 8px; color: #9095a1; font-size: 18px; line-height: 1; }
      .head button:hover { color: #eceef2; }
      .log { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
      .log:empty::before { content: "No messages yet"; color: #9095a1; }
      .who { font-size: 12px; color: #9095a1; }
      .me .who { color: #a78bfa; }
      .txt { overflow-wrap: anywhere; white-space: pre-wrap; }
      .reacts { display: flex; justify-content: space-between; padding: 6px 10px; border-top: 1px solid #2a2d35; }
      .reacts button { all: unset; cursor: pointer; font-size: 22px; line-height: 1; padding: 5px 6px; border-radius: 8px; }
      .reacts button:hover { background: #2a2d35; }
      .panel form { display: flex; gap: 8px; margin: 0; padding: 10px; border-top: 1px solid #2a2d35; }
      .panel input { all: unset; flex: 1; min-width: 0; font: inherit; color: #eceef2; background: #0e0f12; border: 1px solid #2a2d35; border-radius: 10px; padding: 9px 12px; cursor: text; }
      .panel input:focus { border-color: #a78bfa; }
      .panel input:disabled { opacity: .5; }
      .panel form button { all: unset; cursor: pointer; background: #a78bfa; color: #140b2e; font-weight: 600; padding: 9px 14px; border-radius: 10px; }
      .floats { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; overflow: hidden; pointer-events: none; }
      .float { position: absolute; bottom: 90px; font-size: 40px; line-height: 1; animation: rise 2.4s ease-out forwards; }
      @keyframes rise { from { transform: translateY(0) scale(.6); opacity: 0; } 15% { transform: translateY(-6vh) scale(1.1); opacity: 1; } to { transform: translateY(-55vh) scale(1); opacity: 0; } }
    </style>
    <div class="pill dim" id="pill"><span class="dot" id="dot"></span><span id="ptxt"></span></div>
    <div class="toast" id="toast"><span id="ttxt"></span><button id="tbtn" hidden></button></div>
    <div class="reqs" id="reqs"></div>
    <div class="floats" id="floats"></div>
    <button class="chatbtn dim" id="cbtn" title="Chat" aria-label="Chat">💬<span class="badge" id="badge" hidden></span></button>
    <div class="panel" id="panel">
      <div class="head"><span>Chat</span><button id="cclose" title="Close" aria-label="Close chat">×</button></div>
      <div class="log" id="log"></div>
      <div class="reacts" id="reacts"></div>
      <form id="cform"><input id="cin" type="text" maxlength="${MAX_CHAT}" placeholder="Message" autocomplete="off" spellcheck="false"><button>Send</button></form>
    </div>`;
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
  // The host answers people asking to join right on the page, so there's no need to leave the video.
  let requestsKey = "";
  function renderRequests() {
    const list = role === "host" ? requests : [];
    const key = list.map(r => r.id).join("|");
    if (key === requestsKey) return;   // rebuilt only on a change, so a button is never swapped out from under a click
    requestsKey = key;
    const box = $("reqs");
    box.textContent = "";
    for (const r of list) {
      const row = document.createElement("div"); row.className = "req";
      const who = document.createElement("span"); who.textContent = `${r.name} wants to join`;
      const yes = document.createElement("button"); yes.className = "yes"; yes.textContent = "Allow";
      const no = document.createElement("button"); no.textContent = "Deny";
      const answer = allow => () => { row.remove(); chrome.runtime.sendMessage({ to: "bg", cmd: "decide", id: r.id, allow }).catch(() => {}); };
      yes.onclick = answer(true); no.onclick = answer(false);
      row.append(who, yes, no);
      box.append(row);
    }
  }
  function mountUI() {
    const parent = document.fullscreenElement && document.fullscreenElement.tagName !== "VIDEO" ? document.fullscreenElement : document.documentElement;
    if (hostEl.parentNode !== parent) parent.appendChild(hostEl);
  }
  document.addEventListener("fullscreenchange", () => active && mountUI());

  // ------------------------------------------------------------ chat and reactions
  // Players react to clicks and keys anywhere on the page (space pauses, F leaves fullscreen).
  // Clicks inside our UI stop at the shadow root. Keys typed into it are stopped at the window,
  // before the page's own listeners; typing still works because that is the browser's default action.
  ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "wheel", "contextmenu"]
    .forEach(type => root.addEventListener(type, e => e.stopPropagation(), { passive: true }));
  ["keydown", "keyup", "keypress"].forEach(type => window.addEventListener(type, e => {
    if (e.target !== hostEl) return;
    e.stopImmediatePropagation();
    if (type === "keydown" && e.key === "Escape") openChat(false);
  }, true));

  let unread = 0, btnT;
  const chatOpen = () => $("panel").classList.contains("open");
  function showBtn() {
    $("cbtn").classList.remove("dim"); clearTimeout(btnT);
    btnT = setTimeout(() => { if (!unread) $("cbtn").classList.add("dim"); }, 3000);
  }
  function setUnread(n) { unread = n; $("badge").hidden = !n; $("badge").textContent = n > 9 ? "9+" : String(n); if (n) showBtn(); }
  function openChat(on) {
    $("panel").classList.toggle("open", on);
    $("reqs").classList.toggle("beside", on); // keep the host's Allow / Deny prompts clear of the open panel
    $("cbtn").hidden = on;
    if (on) { setUnread(0); $("log").scrollTop = $("log").scrollHeight; if (!$("cin").disabled) $("cin").focus(); }
    else { $("cin").blur(); showBtn(); }
  }
  function addMsg(who, text, mine) {
    const row = document.createElement("div"); row.className = mine ? "me" : "";
    const head = document.createElement("div"); head.className = "who";
    head.textContent = `${who} · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    const body = document.createElement("div"); body.className = "txt"; body.textContent = text;
    row.append(head, body);
    const log = $("log"); log.append(row);
    while (log.childElementCount > 200) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  function float(emoji) {
    const box = $("floats");
    if (box.childElementCount >= 20) return;
    const el = document.createElement("div"); el.className = "float"; el.textContent = emoji;
    el.style.right = `${(chatOpen() ? 340 : 70) + Math.random() * 140}px`;
    box.append(el);
    setTimeout(() => el.remove(), 2500);
  }
  const reactOut = limiter(5, 1000), reactIn = limiter(10, 1000), chatIn = limiter(12, 4000);
  REACTIONS.forEach(emoji => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = emoji;
    b.onclick = () => { if (linkStatus !== "connected" || !reactOut()) return; send({ type: "react", emoji }); float(emoji); };
    $("reacts").append(b);
  });
  $("cbtn").onclick = () => openChat(true);
  $("cclose").onclick = () => openChat(false);
  $("cform").onsubmit = e => {
    e.preventDefault();
    const text = cleanText($("cin").value);
    if (!text || linkStatus !== "connected") return;
    $("cin").value = "";
    send({ type: "chat", text });
    addMsg("You", text, true);
  };
  function onChat(m) {
    const text = cleanText(m.text);
    if (!text || !chatIn()) return;
    const who = nameOf(m); // in a party of several, partner is everyone's names; the host stamps each message with its sender
    addMsg(who, text, false);
    if (chatOpen()) return;
    setUnread(unread + 1);
    toast(`${who}: ${text.length > 80 ? text.slice(0, 80) + "…" : text}`, "Reply", () => openChat(true), 5000);
  }
  function onReact(m) { if (REACTIONS.includes(m.emoji) && reactIn()) float(m.emoji); }

  function renderStatus() {
    const map = {
      connected: [`Synced with ${partner}`, true],
      waiting: ["Waiting for someone to join…", false],
      asking: ["Asking the host to let you in…", false],
      denied: ["The host didn't let you in", false],
      connecting: ["Connecting…", false],
      "partner-offline": [`Waiting for ${partner === "Partner" ? "the host" : partner}…`, false],
      reconnecting: ["Reconnecting…", false],
      "party-full": ["Party is full", false],
    };
    const [t, on] = map[linkStatus] || ["Watch Sync", false];
    pill(t, on, !on);
    $("cin").disabled = !on;
    $("cin").placeholder = on ? "Message" : "Waiting for your partner…";
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
  const doPlay = who => { if (isNetflix) nf("play"); else video.play().catch(() => toast(`${who || partner} pressed play — click play to catch up`)); };
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
  // With more than two people, the host stamps each message with who it came from.
  const nameOf = m => (typeof m.from === "string" && m.from.trim().slice(0, 20)) || partner;
  function applyRemote(m) {
    const partner = nameOf(m);
    bind();
    if (!video) return toast(`${partner} is playing something, open the same title to sync`);
    const elapsed = Math.max(0, (Date.now() - m.at) / 1000);
    suppress(1200);
    if (m.type === "play") {
      const target = m.t + elapsed;
      if (Math.abs(video.currentTime - target) > 0.6) doSeek(target);
      if (video.paused) doPlay(partner);
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
  // Hosts the extension runs on, read from manifest.json's content_scripts so
  // the list can't drift. "*://*.netflix.com/*" -> any netflix.com subdomain,
  // "*://tv.apple.com/*" -> that exact host.
  const navHosts = (() => {
    const out = [];
    try {
      for (const cs of chrome.runtime.getManifest().content_scripts || []) {
        for (const pat of cs.matches || []) {
          const mm = /^[^:]+:\/\/(\*\.)?([a-z0-9.-]+)\//i.exec(pat);
          if (mm) out.push({ base: mm[2].toLowerCase(), sub: !!mm[1] });
        }
      }
    } catch {}
    return out;
  })();
  const hostListed = h => navHosts.some(e => h === e.base || (e.sub && h.endsWith("." + e.base)));
  // Only ever offer to open an https page on this service or another supported one.
  // Anything else from the partner (javascript:, data:, http:, unknown sites) is dropped.
  function navTarget(raw) {
    if (typeof raw !== "string" || raw.length > 2048) return null;
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const h = u.hostname.toLowerCase();
    if (h !== location.hostname.toLowerCase() && !hostListed(h)) return null;
    return u;
  }

  function onNav(m) {
    const theirs = navTarget(m && m.url);
    if (!theirs) return;
    const partner = nameOf(m);
    if (theirs.hostname === location.hostname && theirs.pathname === location.pathname) return;
    const title = String(m.title || "").slice(0, 120).replace(/\s*[|\-–—]\s*(Netflix|Disney\+|Max|Hulu|Prime Video|YouTube|Peacock|Paramount\+).*$/i, "").trim();
    toast(`${partner} is on ${title || theirs.hostname}`, "Open", () => { location.href = theirs.href; }, 9000);
  }

  function onPeer(m) {
    if (!active || !m) return;
    if (m.type === "joined") { sendNav(); setTimeout(() => sendTick(true), 400); return; }
    if (m.type === "play" || m.type === "pause" || m.type === "seek") applyRemote(m);
    else if (m.type === "tick") onTick(m);
    else if (m.type === "nav") onNav(m);
    else if (m.type === "chat") onChat(m);
    else if (m.type === "react") onReact(m);
  }

  // ------------------------------------------------------------ lifecycle
  let timers = [];
  let lastHref = location.href;
  function activate(info) {
    active = true; role = info.role; if (info.partnerName) partner = info.partnerName;
    linkStatus = info.status || linkStatus;
    requests = Array.isArray(info.requests) ? info.requests : [];
    mountUI(); renderStatus(); renderRequests();
    timers.forEach(clearInterval);
    timers = [
      setInterval(bind, 1000),
      setInterval(() => sendTick(false), 4000),
      setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; sendNav(); } }, 1000),
    ];
    bind(); sendNav();
    document.addEventListener("mousemove", showBtn, { passive: true });
    showBtn();
  }
  function deactivate() {
    active = false; timers.forEach(clearInterval); timers = [];
    off.splice(0).forEach(f => f()); video = null;
    hostEl.remove();
    document.removeEventListener("mousemove", showBtn);
    openChat(false); setUnread(0); $("log").replaceChildren(); $("floats").replaceChildren();
  }

  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (!m || m.to) return;   // messages with `to` are for the background/offscreen, not us
    reply({ ok: true });
    if (m.type === "activate") activate(m);
    else if (m.type === "deactivate") deactivate();
    else if (m.type === "peer") onPeer(m.msg);
    else if (m.type === "status") {
      const was = linkStatus; linkStatus = m.status; if (m.partnerName) partner = m.partnerName;
      requests = Array.isArray(m.requests) ? m.requests : [];
      if (active) {
        renderStatus(); renderRequests();
        // The host is told who just came in; a guest sees its own link come up.
        if (m.joined) toast(`${m.joined} joined`);
        else if (role !== "host" && was !== "connected" && linkStatus === "connected") toast(`Synced with ${partner}`);
      }
    }
  });

  chrome.runtime.sendMessage({ to: "bg", cmd: "hello" }).then(r => { if (r && r.active) activate(r); }).catch(() => {});
})();
