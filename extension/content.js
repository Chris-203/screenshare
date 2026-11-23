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
  let askedSync = false, following = false;
  let hostOnly = false, lastHost = null;   // lastHost: the host's latest { t, paused, at }, for putting a guest back
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
  // Avatars are made here, nothing is fetched: a colored circle with initials, or one emoji from this fixed set.
  // The color comes from the name, so the same name always gets the same color on every screen.
  const AVATARS = ["😀", "😎", "🤓", "🥳", "😺", "🐶", "🦊", "🐼", "🐸", "🐵", "🦄", "🐙", "👻", "🤖", "👽", "🍿"];
  const cleanAv = a => AVATARS.includes(a) ? a : "";
  const initials = n => (n.trim().split(/\s+/).slice(0, 2).map(w => Array.from(w)[0] || "").join("") || "?").toUpperCase();
  const colorOf = n => { let h = 0; for (const c of n) h = (h * 31 + c.codePointAt(0)) >>> 0; return `hsl(${h % 360} 55% 42%)`; };
  function avatar(name, av) {
    const el = document.createElement("span"); el.className = "av";
    if (cleanAv(av)) { el.textContent = av; el.classList.add("emo"); } else { el.textContent = initials(name); el.style.background = colorOf(name); }
    return el;
  }

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
      .row { display: flex; gap: 8px; align-items: flex-start; }
      .msg { flex: 1; min-width: 0; }
      .av { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; overflow: hidden;
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; background: #2a2d35; }
      .av.emo { font-size: 17px; background: #2a2d35; }
      .head .hb { display: flex; gap: 4px; align-items: center; }
      .head #pbtn { padding: 0; border-radius: 50%; }
      .head #pbtn .av { width: 26px; height: 26px; font-size: 11px; }
      .head #pbtn .av.emo { font-size: 16px; }
      .prof { padding: 10px 14px; border-bottom: 1px solid #2a2d35; display: flex; flex-direction: column; gap: 8px; }
      .prof label { font-size: 12px; color: #9095a1; }
      .avs { display: flex; flex-wrap: wrap; gap: 4px; }
      .avs button { all: unset; cursor: pointer; border-radius: 50%; padding: 2px; border: 2px solid transparent; }
      .avs button.on { border-color: #a78bfa; }
      .typing { padding: 0 14px 6px; font-size: 12px; color: #9095a1; font-style: italic; }
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
      .vcbtn { all: unset; box-sizing: border-box; position: fixed; right: 14px; top: calc(50% + 54px); transform: translateY(-50%); width: 44px; height: 44px;
        display: grid; place-items: center; cursor: pointer; font-size: 19px; line-height: 1; border-radius: 50%;
        background: rgba(18,19,23,.86); border: 1px solid #2a2d35; backdrop-filter: blur(10px); transition: opacity .4s; }
      .vcbtn.dim { opacity: 0; }
      .vcbtn:focus-visible { outline: 2px solid #a78bfa; }
      .vcbtn.live::after { content: ""; position: absolute; top: 3px; right: 3px; width: 9px; height: 9px; border-radius: 50%; background: #34d399; }
      .vc { position: fixed; left: 18px; top: 18px; border-radius: 14px; overflow: hidden;
        background: #0e0f12; border: 1px solid #2a2d35; box-shadow: 0 6px 24px rgba(0,0,0,.45); }
      .vc.min { visibility: hidden; pointer-events: none; }
      /* The drag strip, minimize and close sit over the top of the videos and only show on hover. */
      .vctop { position: absolute; z-index: 1; left: 0; top: 0; right: 0; height: 26px; display: flex; justify-content: flex-end; align-items: center; gap: 3px;
        padding: 0 6px; cursor: grab; touch-action: none; user-select: none; opacity: 0; transition: opacity .2s; background: linear-gradient(rgba(0,0,0,.6), transparent); }
      .vctop button { all: unset; cursor: pointer; width: 20px; height: 18px; border-radius: 6px; text-align: center;
        font: 600 14px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #eceef2; background: rgba(0,0,0,.6); }
      .vctop button:hover { background: #2a2d35; }
      .vctop button:focus-visible { outline: 2px solid #a78bfa; }
      .grip { position: absolute; z-index: 1; right: 0; bottom: 0; width: 20px; height: 20px; cursor: nwse-resize; touch-action: none; opacity: 0; transition: opacity .2s; }
      .grip::after { content: ""; position: absolute; right: 4px; bottom: 4px; width: 9px; height: 9px; border-right: 2px solid #eceef2; border-bottom: 2px solid #eceef2; border-radius: 0 0 3px 0; }
      .vc:hover .vctop, .vc:hover .grip, .vc.hov .vctop, .vc.hov .grip, .vc.drag .vctop, .vc.drag .grip, .vctop:has(:focus-visible) { opacity: 1; }
      .vc.drag { cursor: grabbing; }
      .vc.drag iframe { pointer-events: none; }
      .vc iframe { display: block; border: 0; width: 180px; height: 150px; background: #0e0f12; color-scheme: dark; }
      /* Separate bubbles: the frame covers the page, see-through, and only takes the pointer over a bubble (.hot). */
      .vc.bubbles { left: 0 !important; top: 0 !important; width: 100vw; height: 100vh; border: 0; border-radius: 0; background: transparent; box-shadow: none; pointer-events: none; }
      .vc.bubbles .vctop, .vc.bubbles .grip { display: none; }
      .vc.bubbles iframe { width: 100% !important; height: 100% !important; background: transparent; pointer-events: none; }
      .vc.bubbles.hot iframe { pointer-events: auto; }
      @keyframes rise { from { transform: translateY(0) scale(.6); opacity: 0; } 15% { transform: translateY(-6vh) scale(1.1); opacity: 1; } to { transform: translateY(-55vh) scale(1); opacity: 0; } }
    </style>
    <div class="pill dim" id="pill"><span class="dot" id="dot"></span><span id="ptxt"></span></div>
    <div class="toast" id="toast"><span id="ttxt"></span><button id="tbtn" hidden></button></div>
    <div class="reqs" id="reqs"></div>
    <div class="floats" id="floats"></div>
    <button class="vcbtn dim" id="vbtn" title="Video chat" aria-label="Video chat">🎥</button>
    <div class="vc" id="vc" hidden>
      <div class="vctop" id="vctop" title="Drag to move"><button id="vclay" title="Separate bubbles" aria-label="Separate bubbles">⧉</button><button id="vcmin" title="Hide videos (you stay in the call)" aria-label="Hide videos">–</button><button id="vcx" title="Leave video chat" aria-label="Leave video chat">×</button></div>
      <div class="grip" id="vcgrip" title="Drag to resize"></div>
    </div>
    <button class="chatbtn dim" id="cbtn" title="Chat" aria-label="Chat">💬<span class="badge" id="badge" hidden></span></button>
    <div class="panel" id="panel">
      <div class="head"><span>Chat</span><span class="hb"><button id="pbtn" title="Your name and picture" aria-label="Your name and picture"></button><button id="cclose" title="Close" aria-label="Close chat">×</button></span></div>
      <div class="prof" id="prof" hidden>
        <label for="pname">Your name</label>
        <input id="pname" type="text" maxlength="20" placeholder="Your name" autocomplete="off" spellcheck="false">
        <label>Your picture</label>
        <div class="avs" id="avs"></div>
      </div>
      <div class="log" id="log"></div>
      <div class="typing" id="typing" hidden></div>
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
    if (hostEl.parentNode === parent) return;
    // moveBefore keeps the video chat frame running through the move; appendChild would reload it.
    if (parent.moveBefore && hostEl.isConnected) { try { parent.moveBefore(hostEl, null); return; } catch {} }
    parent.appendChild(hostEl);
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
    $("cbtn").classList.remove("dim"); $("vbtn").classList.remove("dim"); clearTimeout(btnT);
    btnT = setTimeout(() => { if (!unread) $("cbtn").classList.add("dim"); $("vbtn").classList.add("dim"); }, 3000);
  }
  function setUnread(n) { unread = n; $("badge").hidden = !n; $("badge").textContent = n > 9 ? "9+" : String(n); if (n) showBtn(); }
  function openChat(on) {
    $("panel").classList.toggle("open", on);
    $("reqs").classList.toggle("beside", on); // keep the host's Allow / Deny prompts clear of the open panel
    $("cbtn").hidden = on;
    if (on) { setUnread(0); $("log").scrollTop = $("log").scrollHeight; if (!$("cin").disabled) $("cin").focus(); }
    else { $("cin").blur(); showBtn(); }
  }
  function addMsg(who, text, mine, name, av) {
    const row = document.createElement("div"); row.className = mine ? "row me" : "row";
    const msg = document.createElement("div"); msg.className = "msg";
    const head = document.createElement("div"); head.className = "who";
    head.textContent = `${who} · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    const body = document.createElement("div"); body.className = "txt"; body.textContent = text;
    msg.append(head, body); row.append(avatar(name || who, av), msg);
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
    $("cin").value = ""; typedAt = 0;
    send({ type: "chat", text, av: myAv });
    addMsg("You", text, true, myName(), myAv);
  };
  function onChat(m) {
    const text = cleanText(m.text);
    if (!text || !chatIn()) return;
    const who = nameOf(m); // in a party of several, partner is everyone's names; the host stamps each message with its sender
    typingBy.delete(who); renderTyping();
    addMsg(who, text, false, who, m.av);
    if (chatOpen()) return;
    setUnread(unread + 1);
    toast(`${who}: ${text.length > 80 ? text.slice(0, 80) + "…" : text}`, "Reply", () => openChat(true), 5000);
  }
  function onReact(m) { if (REACTIONS.includes(m.emoji) && reactIn()) float(m.emoji); }

  // "Sam is typing…": while there is text in the box, a small note goes out at most every 2 seconds.
  // Each note keeps that person's line up for 3.5 seconds; their message, or silence, clears it.
  const typingBy = new Map(), typingIn = limiter(10, 2000);
  let typedAt = 0, typingT;
  $("cin").addEventListener("input", () => {
    if (linkStatus !== "connected" || !$("cin").value.trim() || Date.now() - typedAt < 2000) return;
    typedAt = Date.now(); send({ type: "typing" });
  });
  function onTyping(m) { if (!typingIn()) return; typingBy.set(nameOf(m), Date.now()); renderTyping(); }
  function renderTyping() {
    const t = Date.now();
    for (const [k, at] of typingBy) if (t - at > 3500) typingBy.delete(k);
    const n = [...typingBy.keys()];
    $("typing").hidden = !n.length;
    $("typing").textContent = n.length === 1 ? `${n[0]} is typing…` : n.length === 2 ? `${n[0]} and ${n[1]} are typing…` : "Several people are typing…";
    clearTimeout(typingT); if (n.length) typingT = setTimeout(renderTyping, 1000);
  }

  // Your name and picture, saved in this browser. The name is the one the popup uses too,
  // and a change reaches everyone in the party right away.
  // partyName is the name the others see in this party; savedName is what's saved for next time.
  let savedName = "", partyName = "", myAv = "";
  const myName = () => partyName || savedName || (role === "host" ? "Chris" : "Guest");
  function renderProfile() {
    $("pbtn").replaceChildren(avatar(myName(), myAv));
    if (root.activeElement !== $("pname")) $("pname").value = savedName;
    const box = $("avs"); box.replaceChildren();
    ["", ...AVATARS].forEach(a => {
      const b = document.createElement("button"); b.type = "button"; b.className = a === myAv ? "on" : "";
      b.title = a ? a : "Initials"; b.setAttribute("aria-label", a ? `Picture ${a}` : "Initials");
      b.append(avatar(myName(), a));
      b.onclick = () => { myAv = a; chrome.storage.local.set({ avatar: a }).catch(() => {}); renderProfile(); };
      box.append(b);
    });
  }
  $("pbtn").onclick = () => { $("prof").hidden = !$("prof").hidden; if (!$("prof").hidden) $("pname").focus(); };
  $("pname").addEventListener("change", () => {
    const name = $("pname").value.replace(/\s+/g, " ").trim().slice(0, 20);
    if (name === savedName) return;
    savedName = name; chrome.storage.local.set({ name }).catch(() => {});
    if (name && active) partyName = name;
    if (name) chrome.runtime.sendMessage({ to: "bg", cmd: "rename", name }).catch(() => {});
    renderProfile();
  });
  chrome.storage.local.get(["name", "avatar"]).then(r => { savedName = (r.name || "").slice(0, 20); myAv = cleanAv(r.avatar); renderProfile(); }).catch(() => renderProfile());
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    if (c.name) savedName = (c.name.newValue || "").slice(0, 20);
    if (c.avatar) myAv = cleanAv(c.avatar.newValue);
    if (c.name || c.avatar) renderProfile();
  });

  // ------------------------------------------------------------ video chat
  // The tiles, camera and mic live in vc.html, an extension page shown in a frame here. The frame has
  // the extension's own origin, so the site's scripts can't read the video, and Chrome asks for the
  // camera and mic for Watch Sync rather than for the streaming site. It only exists while it is open.
  // – hides the videos but keeps you in the call (audio keeps playing, others still see you); the 🎥 button,
  // with a green dot while you're in, brings them back. × leaves video chat.
  const VC_MIN_W = 120, VC_MAX_W = 520;
  // ⧉ switches between one box and separate bubbles; the choice and the box's width are remembered.
  let vcFrame = null, vcPos = null, vcW = 180, vcLayout = "box", vcShapes = [];
  try { chrome.storage.local.get(["vcWidth", "vcLayout"]).then(r => { if (r && r.vcWidth > 0) vcW = r.vcWidth; if (r && r.vcLayout === "bubbles") vcLayout = "bubbles"; }).catch(() => {}); } catch {}
  const vcButton = () => {
    const live = !!vcFrame;
    $("vbtn").classList.toggle("live", live);
    $("vbtn").hidden = live && !$("vc").classList.contains("min");
    $("vbtn").title = live ? "Show video chat" : "Video chat";
  };
  function openVc() {
    const box = $("vc");
    box.classList.remove("min");
    if (!vcFrame) {
      vcFrame = document.createElement("iframe");
      // "*" because a frame's own origin isn't matched reliably for extension pages with a dynamic URL;
      // the frame can only ever hold vc.html.
      vcFrame.allow = "camera *; microphone *; autoplay *";
      vcFrame.title = "Video chat";
      vcFrame.src = chrome.runtime.getURL("vc.html");
      box.append(vcFrame);
      box.hidden = false;
    }
    showLayout();
    vcButton();
  }
  function showLayout() {
    const box = $("vc"), bubbles = vcLayout === "bubbles";
    // Bubbles start where the box was.
    const r = box.classList.contains("bubbles") ? null : box.getBoundingClientRect();
    const at = vcPos || (r && r.width ? { x: r.left, y: r.top } : { x: 18, y: 18 });
    box.classList.toggle("bubbles", bubbles); box.classList.remove("hot"); vcShapes = [];
    if (!bubbles) { sizeVc(vcW); placeVc(at.x, at.y); }
    if (vcFrame) try { vcFrame.contentWindow.postMessage({ wsvc: "layout", mode: vcLayout, x: at.x, y: at.y, w: vcW }, "*"); } catch {}
  }
  function switchLayout() {
    vcLayout = vcLayout === "bubbles" ? "box" : "bubbles";
    try { chrome.storage.local.set({ vcLayout }).catch(() => {}); } catch {}
    showLayout();
  }
  function closeVc() {
    if (!vcFrame) return;
    const f = vcFrame; vcFrame = null;
    // Let it say goodbye first, so everyone drops this tile right away.
    try { f.contentWindow.postMessage({ wsvc: "leave" }, "*"); } catch {}
    setTimeout(() => f.remove(), 300);
    $("vc").hidden = true; $("vc").classList.remove("min", "hot", "hov");
    vcButton();
  }
  function minVc() {
    $("vc").classList.add("min"); $("vc").classList.remove("hot", "hov"); vcButton(); showBtn();
    try { vcFrame.contentWindow.postMessage({ wsvc: "out" }, "*"); } catch {}   // nothing stays highlighted for when it comes back
  }
  function placeVc(x, y) {
    const box = $("vc"), r = box.getBoundingClientRect();
    x = Math.max(0, Math.min(x, innerWidth - r.width)); y = Math.max(0, Math.min(y, innerHeight - Math.min(r.height, 40)));
    vcPos = { x, y };
    box.style.left = `${x}px`; box.style.top = `${y}px`;
  }
  // Width only: the tiles keep a 4:3 shape, and the frame reports the height that gives them.
  function sizeVc(w) {
    vcW = Math.round(Math.max(VC_MIN_W, Math.min(w, VC_MAX_W, innerWidth - 20)));
    if (vcFrame) vcFrame.style.width = `${vcW}px`;
  }
  $("vbtn").onclick = openVc;
  $("vcx").onclick = closeVc;
  $("vcmin").onclick = minVc;
  $("vclay").onclick = switchLayout;
  // Pointer capture keeps a drag going when the pointer passes over the frame.
  function dragWith(el, onMove, onEnd) {
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.target.closest("button")) return;
      e.preventDefault();
      const box = $("vc"), r = box.getBoundingClientRect(), start = { x: e.clientX, y: e.clientY, r, w: vcW };
      el.setPointerCapture(e.pointerId); box.classList.add("drag");
      const move = ev => onMove(ev, start);
      const end = () => { box.classList.remove("drag"); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", end); el.removeEventListener("pointercancel", end); if (onEnd) onEnd(); };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
    });
  }
  dragWith($("vctop"), (ev, s) => placeVc(s.r.left + ev.clientX - s.x, s.r.top + ev.clientY - s.y));
  dragWith($("vcgrip"), (ev, s) => {
    const dx = ev.clientX - s.x, dy = (ev.clientY - s.y) * 4 / 3;   // a diagonal drag, whichever way moved more
    sizeVc(s.w + (Math.abs(dx) > Math.abs(dy) ? dx : dy));
  }, () => { try { chrome.storage.local.set({ vcWidth: vcW }).catch(() => {}); } catch {} });
  window.addEventListener("resize", () => { if (vcLayout !== "box") return; if (vcFrame) sizeVc(vcW); if (vcPos) placeVc(vcPos.x, vcPos.y); });
  // As bubbles, the pointer goes to the frame only while it is over a bubble or its note.
  const overShape = (x, y) => vcShapes.some(s => s.round
    ? (x - s.x - s.w / 2) ** 2 + (y - s.y - s.h / 2) ** 2 <= (s.w / 2) ** 2
    : x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h);
  // In the box, the frame can't always tell that the pointer left it, so a move seen out here says so.
  window.addEventListener("pointermove", e => {
    if (!vcFrame) return;
    const box = $("vc");
    if (vcLayout === "bubbles") { if (overShape(e.clientX, e.clientY)) box.classList.add("hot"); return; }
    if (!box.classList.contains("hov")) return;
    const r = box.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      box.classList.remove("hov");
      try { vcFrame.contentWindow.postMessage({ wsvc: "out" }, "*"); } catch {}
    }
  }, { capture: true, passive: true });
  // Messages from the frame. Only the frame itself is listened to, and only known fields are read.
  const num = (v, max) => { v = Number(v); return isFinite(v) ? Math.max(-max, Math.min(v, max)) : 0; };
  window.addEventListener("message", e => {
    if (!vcFrame || e.source !== vcFrame.contentWindow || !e.data || typeof e.data.wsvc !== "string") return;
    const m = e.data;
    if (m.wsvc === "size" && vcLayout === "box") {
      const h = Number(m.h);
      if (isFinite(h)) vcFrame.style.height = `${Math.max(60, Math.min(Math.round(h), innerHeight - 60))}px`;
    }
    else if (m.wsvc === "ready") showLayout();
    else if (m.wsvc === "shapes" && Array.isArray(m.shapes)) vcShapes = m.shapes.slice(0, 12).map(s => ({ x: num(s.x, 1e5), y: num(s.y, 1e5), w: num(s.w, 1e5), h: num(s.h, 1e5), round: !!s.round }));
    else if (m.wsvc === "cold") $("vc").classList.remove("hot");
    else if (m.wsvc === "hover") $("vc").classList.toggle("hov", !!m.on);   // the pointer is over the frame (box layout)
    else if (m.wsvc === "cmd") { if (m.c === "min") minVc(); else if (m.c === "close") closeVc(); else if (m.c === "layout") switchLayout(); }
  });

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
      "room-busy": ["Waiting for the room to close from last time…", false],
      "room-taken": ["Someone else has this room open", false],
    };
    const [t, on] = map[linkStatus] || ["Watch Sync", false];
    const waits = waitingOn();
    if (on && myAd) pill(waits.length ? `Ad break. Waiting for ${namesOf(waits)} too` : "You're in an ad. Everyone will wait for you", true, true);
    else if (on && myBuf) pill(waits.length ? `Your video is loading. Waiting for ${namesOf(waits)} too` : "Your video is loading. Everyone will wait for you", true, true);
    else if (on && held) pill(`${holdText(waits)}…`, false, true);
    else pill(t, on, !on);
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
    // A guest on a freshly loaded page (after following the host, or a reload) asks for the host's spot right away.
    if (active && role === "guest" && !askedSync) { askedSync = true; send({ type: "syncreq" }); }
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
    // During your own ad the video's events belong to the ad, so none of them go out.
    if (!active || !video || myAd || Date.now() < suppressUntil) return;
    if (held && type === "play") { suppress(800); doPause(); askToWait(); return; }
    if (role === "guest" && hostOnly && !adsBy.size && !bufBy.size) return putBack();
    const t = video.currentTime, at = Date.now();
    if (type === "seeked") send({ type: "seek", t, paused: video.paused, at });
    else send({ type, t, at });
  }

  // ------------------------------------------------------------ partner → local
  // With more than two people, the host stamps each message with who it came from.
  const nameOf = m => (typeof m.from === "string" && m.from.trim().slice(0, 20)) || partner;
  function applyRemote(m) {
    const partner = nameOf(m);
    if (m.fromHost === true && role === "guest") lastHost = { t: m.t, paused: m.type === "seek" ? !!m.paused : m.type === "pause", at: m.at };
    if (hostOnly && !(role === "guest" && m.fromHost === true)) {
      // Host only: a guest's play, pause or skip changes nothing; the host answers with its spot so they snap back.
      if (role === "host" && snapIn()) setTimeout(() => sendTick(true), 150);
      return;
    }
    // Whoever everyone is waiting for (their ad, or their video loading) is never paused or moved by the others.
    if (myAd || myBuf || following || (held && m.type === "play")) return;
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
    if (role !== "guest") return;
    if (m.fromHost === true) { lastHost = { t: m.t, paused: !!m.paused, at: m.at }; setHostOnly(m.hostOnly === true); }
    if (!video || myAd || myBuf || held || following || adsBy.size || bufBy.size) return;
    // Everyone just waited for this person and the host picks up from their spot, so they aren't moved right
    // after: on a slow connection, or in an ad, being moved starts the loading over and everyone waits again.
    if (Date.now() - bufEnded < 4000) { pausedMismatch = 0; return; }
    const elapsed = Math.max(0, (Date.now() - m.at) / 1000);
    const target = m.paused ? m.t : m.t + elapsed;
    if (m.force || m.paused !== video.paused) {
      pausedMismatch++;
      if (m.force || pausedMismatch >= 2) {
        suppress(1500);
        // Right after a wait (an ad or someone buffering) everyone lines up exactly, so nobody stays half a second off.
        if (Math.abs(video.currentTime - target) > (m.snap ? 0.25 : 0.6)) doSeek(target);
        if (m.paused && !video.paused) doPause();
        if (!m.paused && video.paused) doPlay();
        pausedMismatch = 0;
      }
      return;
    }
    pausedMismatch = 0;
    if (!m.paused && Math.abs(video.currentTime - target) > 1.2 && Date.now() > suppressUntil) { suppress(1500); doSeek(target); }
  }

  function sendTick(force, snap) {
    if (!active || role !== "host" || !video || myAd) return;
    send({ type: "tick", t: video.currentTime, paused: video.paused, at: Date.now(), force: !!force, snap: !!snap, hostOnly });
  }

  // `moved` means this person just went to another page (not a reply to someone joining), so the others may follow.
  function sendNav(moved) { if (active) send({ type: "nav", url: location.href, title: document.title, moved: !!moved }); }
  // Whether this tab arrived on a new page since the last one the party saw. Kept across page loads.
  function arrived() {
    let moved = false;
    try {
      const key = pageKey(new URL(location.href)), last = sessionStorage.getItem("watchsync-page");
      moved = !!last && last !== key;
      sessionStorage.setItem("watchsync-page", key);
    } catch {}
    return moved;
  }
  // Hosts the extension runs on, read from manifest.json's content_scripts so
  // the list can't drift. "*://*.netflix.com/*" -> any netflix.com subdomain,
  // "*://tv.apple.com/*" -> that exact host.
  const navHosts = (() => {
    const out = [];
    try {
      for (const cs of chrome.runtime.getManifest().content_scripts || []) {
        if (!(cs.js || []).includes("content.js")) continue;   // only the streaming sites, not the invite page
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

  // Pages where a title is actually playing. Prime Video and Apple TV+ open their player over
  // the title's page without a URL of its own, so they get the "Open" prompt instead.
  const WATCH_PAGES = [
    [/(^|\.)netflix\.com$/, /^\/watch\//],
    [/(^|\.)disneyplus\.com$/, /\/(video|play)\//],
    [/(^|\.)(max|hbomax)\.com$/, /\/(video\/watch|play)\//],
    [/(^|\.)hulu\.com$/, /^\/watch\//],
    [/(^|\.)youtube\.com$/, /^\/watch$/],
    [/(^|\.)peacocktv\.com$/, /^\/watch\/playback\//],
    [/(^|\.)paramountplus\.com$/, /\/video\//],
    [/(^|\.)crunchyroll\.com$/, /^\/([a-z]{2}(-[a-z]{2})?\/)?watch\//],
  ];
  const isWatchPage = u => WATCH_PAGES.some(([h, p]) => h.test(u.hostname) && p.test(u.pathname));
  // Two addresses are the same page if host, path and (YouTube's) video id match; tracking bits in the query don't count.
  const pageKey = u => u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + (u.searchParams.get("v") ? "?v=" + u.searchParams.get("v") : "");
  // Follow the same address at most once a minute, so a service that redirects one of us somewhere
  // else can't turn this into a reload loop. Kept per tab, across the reload that following causes.
  function canFollow(href) {
    try {
      const last = JSON.parse(sessionStorage.getItem("watchsync-follow") || "null");
      if (last && last.href === href && Date.now() - last.at < 60000) return false;
      sessionStorage.setItem("watchsync-follow", JSON.stringify({ href, at: Date.now() }));
    } catch {}
    return true;
  }

  function onNav(m) {
    const theirs = navTarget(m && m.url);
    if (!theirs || following) return;
    const partner = nameOf(m);
    if (pageKey(theirs) === pageKey(new URL(location.href))) return;
    const title = String(m.title || "").slice(0, 120).replace(/\s*[|\-–—]\s*(Netflix|Disney\+|Max|Hulu|Prime Video|YouTube|Peacock|Paramount\+).*$/i, "").trim();
    // When the host starts something else (the next episode, autoplay, a new title), guests go with them.
    // Only the host's own messages count: the host's side marks them, and a guest can't fake that mark.
    // Who is followed: always the host. With everyone in control, also anyone who just moved to another title.
    const leader = (role === "guest" && m.fromHost === true) || (!hostOnly && m.moved === true);
    if (leader && isWatchPage(theirs) && canFollow(theirs.href)) {
      following = true;
      toast(`Following ${partner} to ${title || "the next video"}…`, null, null, 4000);
      setTimeout(() => { location.href = theirs.href; }, 700);
      return;
    }
    toast(`${partner} is on ${title || theirs.hostname}`, "Open", () => { location.href = theirs.href; }, 9000);
  }

  function onPeer(m) {
    if (!active || !m) return;
    if (m.type === "joined") { sendNav(); sendAd(); sendBuf(); if (role === "host") send({ type: "control", hostOnly }); setTimeout(() => sendTick(true), 400); return; }
    if (m.type === "syncreq") { if (role === "host" && syncIn()) { sendNav(); sendAd(); setTimeout(() => sendTick(true), 300); } return; }
    if (m.type === "ad") return onAd(m);
    if (m.type === "buffer") return onBuffer(m);
    if (m.type === "nowait") return onNoWait(m);
    if (m.type === "control") { if (role === "guest" && m.fromHost === true) setHostOnly(m.hostOnly === true); return; }
    if (m.type === "play" || m.type === "pause" || m.type === "seek") applyRemote(m);
    else if (m.type === "tick") onTick(m);
    else if (m.type === "nav") onNav(m);
    else if (m.type === "chat") onChat(m);
    else if (m.type === "react") onReact(m);
    else if (m.type === "typing") onTyping(m);
  }

  // ------------------------------------------------------------ host only
  // The host can keep play, pause, skip and changing titles to themselves. A guest who tries is put
  // straight back on the host's spot, first from the host's last known state, then exactly by asking it.
  const snapIn = limiter(4, 2000), putBackNote = limiter(1, 4000);
  function setHostOnly(on) {
    if (on === hostOnly) return;
    hostOnly = on;
    if (active) toast(on ? `Only ${partnerHost()} can play, pause and skip now` : "Everyone can play, pause and skip now");
  }
  const partnerHost = () => (partner === "Partner" ? "the host" : partner.split(/,| and /)[0].trim() || "the host");
  function putBack() {
    if (putBackNote()) toast(`Only ${partnerHost()} can play, pause and skip`);
    if (lastHost && video) {
      const target = lastHost.paused ? lastHost.t : lastHost.t + Math.max(0, (Date.now() - lastHost.at) / 1000);
      suppress(1500);
      if (Math.abs(video.currentTime - target) > 0.6) doSeek(target);
      if (lastHost.paused && !video.paused) doPause();
      if (!lastHost.paused && video.paused) doPlay();
    }
    if (snapIn()) send({ type: "syncreq" });
  }

  // ------------------------------------------------------------ ad breaks
  // Ads on ad-supported plans are part of the stream and can't be skipped, so instead the party waits:
  // whoever is in an ad tells the others, everyone else pauses, and when the last ad ends the host
  // picks up where it paused and brings everyone back to its spot.
  // Each service marks its ad UI differently, so there are two checks: known ad elements anywhere on
  // the page, and ad wording ("Ad 1 of 2", "Ad · 0:30", "Your show will resume…") near the video.
  const AD_SELECTORS = [
    ".html5-video-player.ad-showing", ".html5-video-player.ad-interrupting",                            // YouTube
    "[data-qa='ad-badge-overlay.badge']", ".progress-bar__ad-playing",                                       // Disney+
    ".atvwebplayersdk-ad-timer", ".atvwebplayersdk-ad-timer-text", ".atvwebplayersdk-adtimeindicator-text", // Prime Video
    "[data-uia^='ads-']", "[data-uia*='ad-break']", "[data-uia*='advert']",                              // Netflix with ads
    ".AdUnitView", ".ad-countdown", "[class*='AdCountdown']", "[class*='adCountdown']",                   // Hulu, Peacock and others
    "[class*='AdBadge']", "[class*='ad-badge']", "[data-testid*='ad-badge']", "[data-testid*='ad-countdown']", "[data-testid*='ad-timer']",
  ].join(",");
  const AD_TEXT = [
    /^(ad|ads|advertisement)$/i,
    /^ads?\s*\d+\s*(of|\/)\s*\d+/i,
    /^ads?\s*[·•:|-]?\s*\(?\d{1,2}:\d{2}\)?$/i,
    /^(ad|commercial) break\b/i,
    /\b(your|the) (show|video|program|movie|episode) will (resume|continue|start|begin)\b/i,
    /\b(show|video|program|movie|episode) (resumes|continues|starts|begins) in\b/i,
  ];
  const AD_STALE = 15000;   // someone in an ad (or buffering) repeats it every 5 s; past this they're treated as gone
  let myAd = false, adMisses = 0, adSent = 0, held = false, resumeAfterHold = false, lastPlaying = 0, wasBusy = false, adKey = "";
  const adsBy = new Map();     // name -> when we last heard they're in an ad
  const bufBy = new Map();     // name -> when we last heard their video is stuck loading
  const adIgnored = new Set(); // names this person chose not to wait for, until that ad or loading ends
  const adIn = limiter(10, 1000), syncIn = limiter(3, 3000);
  const namesOf = a => a.length < 2 ? (a[0] || "") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
  const waitingOn = () => [...new Set([...adsBy.keys(), ...bufBy.keys()])].filter(n => !adIgnored.has(n));
  // "Waiting for Sam's ad to end", "Waiting for Sam to buffer", or both kinds at once.
  function holdText(waits) {
    const ads = waits.filter(n => adsBy.has(n)), bufs = waits.filter(n => !adsBy.has(n));
    if (!bufs.length) return `Waiting for ${namesOf(ads)}'s ad${ads.length > 1 ? "s" : ""} to end`;
    if (!ads.length) return `Waiting for ${namesOf(bufs)} to buffer`;
    return `Waiting for ${namesOf(waits)}`;
  }

  const visible = el => {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  };
  const up = n => n.parentElement || (n.parentNode && n.parentNode.host) || null;   // steps out of shadow roots too
  function playerRoot(v) {
    let n = v;
    for (let i = 0; i < 6; i++) { const p = up(n); if (!p || p === document.body || p === document.documentElement) break; n = p; }
    return n;
  }
  // Short visible text near the video, including inside open shadow roots (Disney+ and Max use them).
  function adText(start) {
    let budget = 4000, found = false;
    const walk = node => {
      for (let c = node.firstChild; c && !found && budget-- > 0; c = c.nextSibling) {
        if (c.nodeType === 3) { const t = c.data.trim(); if (t && t.length <= 60 && AD_TEXT.some(r => r.test(t)) && visible(c.parentElement)) found = true; }
        else if (c.nodeType === 1 && c.tagName !== "SCRIPT" && c.tagName !== "STYLE") { if (c.shadowRoot) walk(c.shadowRoot); walk(c); }
      }
    };
    walk(start);
    return found;
  }
  // Some players show the ad in a second video while the show's own video sits "playing" but frozen.
  // Without this that looks like loading, and the person in the ad was treated as buffering.
  const seenAt = new WeakMap();
  let mainT = -1;
  function adInOtherVideo() {
    const t = video.currentTime, frozen = !video.paused && !video.ended && Math.abs(t - mainT) < 0.01;
    mainT = t;
    let other = false;
    for (const v of document.querySelectorAll("video")) {
      if (v === video) continue;
      const last = seenAt.get(v); seenAt.set(v, v.currentTime);
      if (!v.paused && !v.ended && last !== undefined && Math.abs(v.currentTime - last) > 0.05 && visible(v)) other = true;
    }
    return frozen && other;
  }
  // A visible match for `sel` anywhere on the page, including inside open shadow roots. Disney+ puts its
  // "Ad" badge in a shadow root next to the player rather than around the video, so neither a plain
  // querySelectorAll nor the text check near the video sees it.
  function deepFind(sel) {
    const roots = [document];
    let budget = 20000;
    while (roots.length) {
      const root = roots.pop();
      for (const el of root.querySelectorAll(sel)) if (visible(el)) return true;
      for (const el of root.querySelectorAll("*")) { if (el.shadowRoot) roots.push(el.shadowRoot); if (--budget <= 0) return false; }
    }
    return false;
  }
  function adOnPage() {
    if (!video) return false;   // an ad needs a player; this keeps menus and account pages out of it
    try {
      if (adInOtherVideo()) return true;
      if (deepFind(AD_SELECTORS)) return true;
      return !!video && adText(playerRoot(video));
    } catch { return false; }
  }

  const sendAd = () => { if (myAd) { adSent = Date.now(); send({ type: "ad", on: true, at: adSent }); } };
  // "Watch anyway" counts for everyone, so the people not in the ad or loading carry on together.
  function watchAnyway() {
    const names = waitingOn();
    names.forEach(n => adIgnored.add(n));
    send({ type: "nowait", names });
    updateHold();
    if (video && video.paused) doPlay();
  }
  function onNoWait(m) {
    if (!adIn() || !Array.isArray(m.names)) return;
    m.names.slice(0, 8).forEach(n => { if (typeof n === "string" && (adsBy.has(n) || bufBy.has(n))) adIgnored.add(n); });
    updateHold();
  }
  const askToWait = () => toast(holdText(waitingOn()), "Watch anyway", watchAnyway, 8000);

  function checkAd() {
    if (!active) return;
    bind();
    const now = Date.now(), hit = adOnPage();
    adMisses = hit ? 0 : adMisses + 1;
    if (!myAd && hit) { myAd = true; sendAd(); }
    else if (myAd && adMisses >= 3) { myAd = false; suppress(1500); send({ type: "ad", on: false, at: now }); }  // 1.5 s clear, so a flicker isn't an end
    else if (myAd && now - adSent > 5000) sendAd();
    checkBuffer(now);
    if (video && !video.paused && !myAd && !held) lastPlaying = now;
    for (const m of [adsBy, bufBy]) for (const [n, t] of m) if (now - t > AD_STALE) { m.delete(n); if (!adsBy.has(n) && !bufBy.has(n)) adIgnored.delete(n); }
    updateHold();
  }

  function onAd(m) {
    if (!adIn()) return;
    const who = nameOf(m);
    if (m.on === true) adsBy.set(who, Date.now());
    else { adsBy.delete(who); if (!bufBy.has(who)) adIgnored.delete(who); }
    updateHold();
  }

  // ------------------------------------------------------------ buffering
  // Same idea as an ad break: whoever's video is stuck loading tells the others, everyone else pauses,
  // and when it's moving again the host picks up and brings everyone back to its spot.
  // "Stuck" means playing (not paused) while the time hasn't moved for BUF_AFTER. That works on every
  // player, including ones that never fire a "waiting" event, and a quick seek that loads fast doesn't count.
  const BUF_AFTER = 1000;
  // The end of someone's loading carries where their video is, so the host can pick up from there
  // instead of sending them forward to its own spot, which would make them load all over again.
  let myBuf = false, bufSent = 0, lastT = -1, stallSince = 0, moving = 0, caughtUp = null, bufEnded = 0;
  const sendBuf = () => { if (myBuf) { bufSent = Date.now(); send({ type: "buffer", on: true, at: bufSent }); } };
  function endBuf(now) { if (!myBuf) return; myBuf = false; bufEnded = now; send({ type: "buffer", on: false, at: now, t: video ? video.currentTime : null }); }
  function checkBuffer(now) {
    const t = video ? video.currentTime : -1;
    const playing = !!video && !video.paused && !video.ended && !myAd && !held;
    if (playing && Math.abs(t - lastT) < 0.01) { stallSince ||= now; moving = 0; }
    else { stallSince = 0; moving = playing ? moving + 1 : 0; }
    lastT = t;
    if (!myBuf && stallSince && now - stallSince >= BUF_AFTER) { myBuf = true; sendBuf(); }
    else if (myBuf && (!playing || moving >= 2)) endBuf(now);   // moving again for two checks in a row, or paused / gone
    else if (myBuf && now - bufSent > 5000) sendBuf();
  }
  function onBuffer(m) {
    if (!adIn()) return;
    const who = nameOf(m);
    if (m.on === true) bufBy.set(who, Date.now());
    else {
      if (bufBy.has(who) && Number.isFinite(m.t) && Number.isFinite(m.at) && m.t >= 0) caughtUp = { t: m.t, at: m.at };
      bufBy.delete(who); if (!adsBy.has(who)) adIgnored.delete(who);
    }
    updateHold();
  }

  function updateHold() {
    const waits = waitingOn(), busy = myAd || myBuf || waits.length > 0, was = held;
    held = !myAd && !myBuf && waits.length > 0;
    // The host remembers whether the show was playing when the break began, to pick up again after it.
    if (busy && !wasBusy && role === "host") { resumeAfterHold = myAd || myBuf || Date.now() - lastPlaying < 3000; caughtUp = null; }
    if (held) {
      bind();
      if (video && !video.paused) { suppress(1500); doPause(); }
      if (!was) askToWait();
    }
    if (!busy && wasBusy && role === "host") {
      // Everyone's ad is over: play again if we were playing, then put everyone on the host's spot.
      setTimeout(() => {
        const c = caughtUp; caughtUp = null;
        if (!active || myAd || myBuf || held) return;
        // We waited for someone's video to load: carry on from where theirs is now. The host kept playing a
        // moment after they got stuck, so its own spot is ahead, and sending them there makes them load again,
        // which pauses everyone again, over and over.
        if (resumeAfterHold && video && c && Date.now() - c.at < 5000) {
          const target = c.t + Math.max(0, (Date.now() - c.at) / 1000);
          if (Math.abs(video.currentTime - target) > 0.15) { suppress(1500); doSeek(target); }
        }
        if (resumeAfterHold && video && video.paused) { suppress(1500); doPlay(); }
        setTimeout(() => sendTick(true, true), 400);
      }, 500);
    }
    wasBusy = busy;
    const key = `${myAd}|${myBuf}|${held}|${waits.map(n => (adsBy.has(n) ? "a:" : "b:") + n).join(",")}`;
    if (key !== adKey) { adKey = key; if (active) renderStatus(); }
  }

  // ------------------------------------------------------------ lifecycle
  let timers = [];
  let lastHref = location.href;
  function activate(info) {
    active = true; role = info.role; if (info.partnerName) partner = info.partnerName;
    partyName = typeof info.name === "string" ? info.name.slice(0, 20) : "";
    if (role === "host") hostOnly = info.hostOnly === true;
    linkStatus = info.status || linkStatus;
    requests = Array.isArray(info.requests) ? info.requests : [];
    mountUI(); renderStatus(); renderRequests(); renderProfile();
    timers.forEach(clearInterval);
    askedSync = false;
    timers = [
      setInterval(bind, 1000),
      setInterval(checkAd, 500),
      setInterval(() => sendTick(false), 4000),
      setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; sendNav(arrived()); } }, 1000),
    ];
    bind(); sendNav(arrived());
    document.addEventListener("mousemove", showBtn, { passive: true });
    showBtn();
  }
  function deactivate() {
    active = false; timers.forEach(clearInterval); timers = [];
    off.splice(0).forEach(f => f()); video = null;
    hostOnly = false; lastHost = null;
    myAd = false; held = false; wasBusy = false; adMisses = 0; adsBy.clear(); adIgnored.clear(); adKey = "";
    myBuf = false; bufBy.clear(); lastT = -1; stallSince = 0; moving = 0; caughtUp = null; bufEnded = 0;
    closeVc();
    hostEl.remove();
    document.removeEventListener("mousemove", showBtn);
    openChat(false); setUnread(0); $("log").replaceChildren(); $("floats").replaceChildren(); typingBy.clear(); renderTyping(); $("prof").hidden = true;
  }

  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (!m || m.to) return;   // messages with `to` are for the background/offscreen, not us
    // The host's invite link carries the page it's on, so a guest opening the link lands on the same title.
    if (m.type === "where") return reply({ ok: true, url: location.href, title: document.title });
    reply({ ok: true });
    if (m.type === "activate") activate(m);
    else if (m.type === "deactivate") deactivate();
    else if (m.type === "peer") onPeer(m.msg);
    else if (m.type === "control") { if (active && role === "host") { hostOnly = m.hostOnly === true; send({ type: "control", hostOnly }); toast(hostOnly ? "Only you can play, pause and skip now" : "Everyone can play, pause and skip now"); } }
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
