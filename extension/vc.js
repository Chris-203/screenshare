// Watch Sync — video chat. Runs in vc.html, which content.js shows in a small frame on the party's tab.
// Camera and mic go straight to each other person who has video chat open (one RTCPeerConnection
// per person). The offers, answers and ICE candidates travel over the party's own connection
// (offscreen.js), so only people the host let in can reach you.
//
// For each pair, the one with the lower member id makes the single offer, with one audio and one
// video transceiver. After that, turning the camera or mic on and off only swaps the sender's track
// (replaceTrack), so there is never a second offer and the two sides never offer at once. An ICE
// restart after a failed connection is also made by the offering side only.
// Nothing is captured until you press the camera or mic button.

const $ = id => document.getElementById(id);
const MAX_PEERS = 8;
const MAX_SDP = 20000;
const VIDEO = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 24 } };
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO_BPS = 300000;

let me = null, up = false;
const local = { video: null, audio: null };       // our live tracks, or null when off
const peers = new Map();                          // member id -> { id, name, pc, offerer, stream, tile, state, ice: [] }
let blockedAudio = false;                         // the browser stopped autoplay with sound until a click

const sig = (dest, d) => chrome.runtime.sendMessage({ to: "off", cmd: "vc", dest, d }).catch(() => {});
const cleanName = n => String(n == null ? "" : n).replace(/\s+/g, " ").trim().slice(0, 20) || "Guest";
const myState = () => ({ cam: !!local.video, mic: !!local.audio });
const note = (text, btn, onClick) => {
  const el = $("note"); el.textContent = text || "";
  if (btn) { const b = document.createElement("button"); b.textContent = btn; b.onclick = onClick; el.append(" ", b); }
  fit();
};

// ------------------------------------------------------------ tiles
function makeTile(name, mine) {
  const tile = document.createElement("div"); tile.className = "tile nocam nomic" + (mine ? " me" : "");
  const video = document.createElement("video"); video.autoplay = true; video.playsInline = true; video.muted = !!mine;
  const av = document.createElement("div"); av.className = "av";
  const letter = document.createElement("span"); av.append(letter);
  const label = document.createElement("div"); label.className = "name";
  const text = document.createElement("span"); const muted = document.createElement("i"); muted.textContent = "🔇"; muted.title = "Mic off";
  label.append(text, muted);
  // Only used as separate bubbles: a corner to resize this bubble by.
  const rz = document.createElement("div"); rz.className = "rz"; rz.title = "Drag to resize";
  tile.append(video, av, label, rz);
  // With the camera off, the circle shows the first letter of the person's name (yours too, not "Y" for "You").
  const setLetter = n => { letter.textContent = (Array.from(cleanName(n))[0] || "?").toUpperCase(); };
  const setName = n => { text.textContent = n; setLetter(n); };
  setName(name);
  return { tile, video, setName, setLetter, setWait: on => {
    let w = tile.querySelector(".wait");
    if (on && !w) { w = document.createElement("div"); w.className = "wait"; w.textContent = "Connecting…"; tile.append(w); }
    if (!on && w) w.remove();
  } };
}
const mine = makeTile("You", true);
$("tiles").append(mine.tile);

function renderMine() {
  const s = myState();
  mine.tile.classList.toggle("nocam", !s.cam); mine.tile.classList.toggle("nomic", !s.mic);
  const shown = mine.video.srcObject && mine.video.srcObject.getVideoTracks()[0];
  if ((shown || null) !== local.video) mine.video.srcObject = local.video ? new MediaStream([local.video]) : null;
  for (const [k, b] of [["cam", $("cam")], ["mic", $("mic")]]) {
    b.classList.toggle("on", s[k]); b.setAttribute("aria-pressed", String(s[k]));
    b.title = k === "cam" ? (s.cam ? "Turn camera off" : "Turn camera on") : (s.mic ? "Mute" : "Turn mic on");
  }
  fit();
}
function renderPeer(p) {
  p.tile.tile.classList.toggle("nocam", !p.state.cam || !p.stream.getVideoTracks().length);
  p.tile.tile.classList.toggle("nomic", !p.state.mic);
  p.tile.setName(p.name);
  fit();
}
// Tell content.js how tall we are, so the frame fits the tiles.
let lastH = 0;
function fit() {
  requestAnimationFrame(() => {
    if (layout === "bubbles") return placeBubbles();
    // The full height the tiles want, even while the list is capped and scrolling; content.js caps the frame.
    const t = $("tiles"), h = Math.ceil($("wrap").scrollHeight - t.clientHeight + t.scrollHeight);
    // The tiles are as wide as the frame, so the height follows the width: report the change after a resize too.
    if (h !== lastH && parent !== window) { lastH = h; parent.postMessage({ wsvc: "size", h }, "*"); }
  });
}
new ResizeObserver(fit).observe($("wrap"));
window.addEventListener("resize", fit);
// Show the camera and mic buttons for a few seconds after opening, so they can be found; after that, on hover.
document.body.classList.add("hint");
setTimeout(() => document.body.classList.remove("hint"), 4000);

function play(video) {
  video.play().catch(() => {
    if (blockedAudio) return;
    blockedAudio = true;
    note("Click here to hear everyone.");
  });
}
document.addEventListener("click", () => {
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  if (!blockedAudio) return;
  blockedAudio = false; note("");
  peers.forEach(p => play(p.tile.video));
}, true);

// Green outline on whoever is talking.
let audioCtx = null;
function watchTalk(tile, stream) {
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    const an = audioCtx.createAnalyser(); an.fftSize = 512;
    const src = audioCtx.createMediaStreamSource(stream); src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    tile.meter = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += (v - 128) * (v - 128);
      tile.tile.classList.toggle("talk", Math.sqrt(sum / buf.length) > 6);
    };
    tile.stopMeter = () => { try { src.disconnect(); } catch {} tile.meter = null; tile.tile.classList.remove("talk"); };
  } catch {}
}
setInterval(() => {
  if (mine.meter) mine.meter();
  peers.forEach(p => p.tile.meter && p.tile.meter());
}, 200);

// ------------------------------------------------------------ connections
function ensure(id, name) {
  let p = peers.get(id);
  if (p) { p.name = name || p.name; return p; }
  if (peers.size >= MAX_PEERS) return null;
  const tile = makeTile(name, false);
  p = { id, name, pc: null, offerer: false, stream: new MediaStream(), tile, state: { cam: false, mic: false }, ice: [] };
  tile.video.srcObject = p.stream;
  tile.setWait(true);
  $("tiles").append(tile.tile);
  peers.set(id, p);
  renderPeer(p);
  return p;
}
function drop(id) {
  const p = peers.get(id);
  if (!p) return;
  peers.delete(id);
  if (p.pc) { try { p.pc.close(); } catch {} }
  if (p.tile.stopMeter) p.tile.stopMeter();
  p.tile.tile.remove();
  fit();
}
function dropAll() { [...peers.keys()].forEach(drop); }

function capBitrate(pc) {
  for (const t of pc.getTransceivers()) {
    if (!t.sender || t.receiver.track.kind !== "video") continue;
    const prm = t.sender.getParameters();
    if (!prm.encodings || !prm.encodings.length) continue;
    prm.encodings[0].maxBitrate = VIDEO_BPS;
    t.sender.setParameters(prm).catch(() => {});
  }
}
function makePc(p, offerer) {
  const pc = new RTCPeerConnection(ICE.config);
  p.pc = pc; p.offerer = offerer;
  pc.onicecandidate = e => { if (e.candidate && p.pc === pc) sig(p.id, { t: "ice", c: e.candidate.toJSON() }); };
  pc.ontrack = e => {
    if (p.pc !== pc) return;
    p.stream.getTracks().filter(t => t.kind === e.track.kind && t !== e.track).forEach(t => p.stream.removeTrack(t));
    if (!p.stream.getTracks().includes(e.track)) p.stream.addTrack(e.track);
    if (e.track.kind === "audio") { if (p.tile.stopMeter) p.tile.stopMeter(); watchTalk(p.tile, new MediaStream([e.track])); }
    // Firefox and Chrome both need a fresh srcObject to pick up a track added later.
    p.tile.video.srcObject = p.stream;
    play(p.tile.video);
    renderPeer(p);
  };
  pc.onconnectionstatechange = () => {
    if (p.pc !== pc) return;
    const s = pc.connectionState;
    p.tile.setWait(s !== "connected");
    if (s === "connected") capBitrate(pc);
    if (s === "failed" && p.offerer) pc.restartIce();
  };
  if (offerer) {
    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription(await pc.createOffer());
        sig(p.id, { t: "offer", sdp: pc.localDescription.sdp });
      } catch (e) { console.warn("Video chat offer failed:", e); }
    };
    pc.addTransceiver(local.audio || "audio", { direction: "sendrecv" });
    pc.addTransceiver(local.video || "video", { direction: "sendrecv" });
  }
  return pc;
}
async function connect(p) {
  if (p.pc) { try { p.pc.close(); } catch {} p.pc = null; }
  await ICE.ready();
  if (peers.get(p.id) !== p || p.pc) return;
  makePc(p, true);
}
async function flushIce(p) {
  const list = p.ice.splice(0);
  for (const c of list) await p.pc.addIceCandidate(c).catch(() => {});
}

const okSdp = s => typeof s === "string" && s.length > 0 && s.length <= MAX_SDP;
function okCandidate(c) {
  if (!c || typeof c !== "object" || typeof c.candidate !== "string" || c.candidate.length > 1000) return null;
  return {
    candidate: c.candidate,
    sdpMid: typeof c.sdpMid === "string" ? c.sdpMid.slice(0, 32) : null,
    sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
  };
}

async function onSignal(from, name, d) {
  if (typeof from !== "string" || !from || from === me || !me) return;
  name = cleanName(name);
  const takeState = p => { if (p && typeof d.cam === "boolean") { p.state = { cam: d.cam, mic: !!d.mic }; renderPeer(p); } };
  switch (d.t) {
    case "join": {
      // Someone opened video chat (or reopened it): start that pair over.
      drop(from);
      const p = ensure(from, name); if (!p) return;
      takeState(p);
      sig(from, Object.assign({ t: "here" }, myState()));
      if (me < from) connect(p);
      return;
    }
    case "here": {
      const p = ensure(from, name); if (!p) return;
      takeState(p);
      if (me < from && !p.pc) connect(p);
      return;
    }
    case "state": takeState(peers.get(from)); return;
    case "bye": drop(from); return;
    case "offer": {
      if (me < from || !okSdp(d.sdp)) return;      // the lower id offers, never us
      const p = ensure(from, name); if (!p) return;
      const fresh = !p.pc;
      if (fresh) { await ICE.ready(); if (peers.get(from) !== p) return; if (!p.pc) makePc(p, false); }
      const pc = p.pc;
      try {
        await pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
        for (const t of pc.getTransceivers()) {
          const kind = t.receiver.track.kind;
          if (kind !== "audio" && kind !== "video") continue;
          t.direction = "sendrecv";
          await t.sender.replaceTrack(local[kind]);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        sig(from, { t: "answer", sdp: pc.localDescription.sdp });
        await flushIce(p);
      } catch (e) { console.warn("Video chat answer failed:", e); }
      return;
    }
    case "answer": {
      const p = peers.get(from);
      if (!p || !p.pc || !p.offerer || p.pc.signalingState !== "have-local-offer" || !okSdp(d.sdp)) return;
      try { await p.pc.setRemoteDescription({ type: "answer", sdp: d.sdp }); await flushIce(p); } catch (e) { console.warn("Video chat answer rejected:", e); }
      return;
    }
    case "ice": {
      const p = peers.get(from), c = okCandidate(d.c);
      if (!p || !c) return;
      if (!p.pc || !p.pc.remoteDescription) { if (p.ice.length < 50) p.ice.push(c); return; }
      p.pc.addIceCandidate(c).catch(() => {});
      return;
    }
  }
}

// ------------------------------------------------------------ camera and mic
function blockedBySite(kind) {
  const pol = document.permissionsPolicy || document.featurePolicy;
  try { return !!pol && !pol.allowsFeature(kind === "video" ? "camera" : "microphone"); } catch { return false; }
}
let retryKind = null;
async function getTrack(kind) {
  try {
    const s = await navigator.mediaDevices.getUserMedia(kind === "video" ? { video: VIDEO } : { audio: AUDIO });
    return s.getTracks()[0];
  } catch (e) {
    const what = kind === "video" ? "camera" : "mic";
    if (blockedBySite(kind)) note(`This site doesn't allow a ${what} here. You can still see and hear everyone.`);
    else if (e.name === "NotAllowedError" || e.name === "SecurityError") {
      // Inside a streaming site, Chrome may not ask on its own. The extension's own page can ask once,
      // and after that the frame is allowed too.
      retryKind = kind;
      note(`Chrome needs your OK for the ${what}.`, "Allow", () => chrome.tabs.create({ url: chrome.runtime.getURL("allow.html") }));
    }
    else if (e.name === "NotFoundError" || e.name === "OverconstrainedError") note(`No ${what} found.`);
    else if (e.name === "NotReadableError") note(`Your ${what} is busy in another app.`);
    else note(`Couldn't start the ${what}.`);
    return null;
  }
}
function setTrack(kind, track) {
  for (const p of peers.values()) {
    if (!p.pc) continue;
    for (const t of p.pc.getTransceivers()) if (t.receiver.track.kind === kind && !t.stopped) t.sender.replaceTrack(track).catch(() => {});
  }
}
async function turn(kind, on) {
  if (!on) {
    if (local[kind]) { local[kind].stop(); local[kind] = null; setTrack(kind, null); }
    if (kind === "audio" && mine.stopMeter) mine.stopMeter();
  } else if (!local[kind]) {
    const t = await getTrack(kind);
    if (!t) return;
    note("");
    if (local[kind]) { t.stop(); return; }    // pressed twice while waiting
    local[kind] = t;
    t.onended = () => { if (local[kind] === t) turn(kind, false); }; // unplugged, or stopped by the browser
    setTrack(kind, t);
    if (kind === "audio") watchTalk(mine, new MediaStream([t]));
  }
  renderMine();
  save();
  if (up) sig("*", Object.assign({ t: "state" }, myState()));
}
$("cam").onclick = () => turn("video", !local.video);
$("mic").onclick = () => turn("audio", !local.audio);

// What was on survives the frame reloading (a page reload, or some fullscreen switches) during the same party.
const save = () => chrome.storage.session.set({ vc: myState() }).catch(() => {});
chrome.storage.onChanged.addListener((ch, area) => {
  // allow.html says the browser said yes: try again.
  if (area === "session" && ch.vcAllowed && retryKind) { const k = retryKind; retryKind = null; turn(k, true); }
});

// ------------------------------------------------------------ joining
function announce() {
  if (!up || !me) return;
  sig("*", Object.assign({ t: "join" }, myState()));
}
async function hello() {
  let r = null;
  try { r = await chrome.runtime.sendMessage({ to: "off", cmd: "vcHello" }); } catch {}
  if (!r || !r.id) { up = false; note("Video chat starts when your party is connected."); return; }
  const was = up && me === r.id;
  if (me && me !== r.id) dropAll();
  me = r.id;
  if (r.name) mine.setLetter(r.name);
  up = !!r.up;
  if (was) return;                    // already in; a second join would make everyone reconnect to us
  if (up) { if ($("note").textContent.startsWith("Video chat starts")) note(""); announce(); }
  else note("Video chat starts when your party is connected.");
}

chrome.runtime.onMessage.addListener(m => {
  if (!m || m.to !== "vc") return;
  if (m.reset) { up = false; dropAll(); return; }
  if (m.up) { hello(); return; }
  if (m.d && typeof m.d === "object") onSignal(m.from, m.name, m.d);
});

// ------------------------------------------------------------ layout: one box, or separate bubbles
// In the box, content.js owns the frame's size and place. As separate bubbles, the frame covers the
// whole page with a see-through background, and each bubble is moved and resized here. content.js only
// lets the pointer into the frame while it is over a bubble (from the shapes sent with "shapes"), so
// the rest of the page stays clickable.
const BUBBLE_MIN = 70, BUBBLE_MAX = 420, GAP = 10;
let layout = "box", origin = { x: 18, y: 18, w: 160 }, dragging = false;
const spots = new WeakMap();                       // tile element -> { x, y, s }
const toParent = msg => { if (parent !== window) parent.postMessage(Object.assign({ wsvc: "" }, msg), "*"); };
const clampSpot = sp => {
  sp.s = Math.max(BUBBLE_MIN, Math.min(sp.s, BUBBLE_MAX, innerWidth, innerHeight));
  sp.x = Math.max(0, Math.min(sp.x, innerWidth - sp.s)); sp.y = Math.max(0, Math.min(sp.y, innerHeight - sp.s));
  return sp;
};
function placeBubbles() {
  let prev = null, prevEl = null;
  const shapes = [];
  for (const el of $("tiles").children) {
    let sp = spots.get(el);
    if (!sp) {
      // A new bubble goes under the one before it, or starts a new column at the bottom of the screen.
      const s = Math.round(Math.max(BUBBLE_MIN, Math.min(origin.w, 200)));
      // Under your own bubble, leave room for your buttons.
      const gap = prevEl === mine.tile ? GAP + $("tools").offsetHeight + 6 : GAP;
      sp = prev ? { x: prev.x, y: prev.y + prev.s + gap, s } : { x: origin.x, y: origin.y, s };
      if (prev && sp.y + s > innerHeight) { sp.x = prev.x + prev.s + GAP; sp.y = origin.y; }
      spots.set(el, sp);
    }
    clampSpot(sp);
    el.style.left = `${sp.x}px`; el.style.top = `${sp.y}px`; el.style.width = el.style.height = `${sp.s}px`;
    shapes.push({ x: sp.x, y: sp.y, w: sp.s, h: sp.s, round: true });
    prev = sp; prevEl = el;
  }
  // Your buttons go in a pill just under your bubble (or just above it, at the bottom of the screen),
  // and a note under that. Both count as part of the bubbles for the pointer.
  const me = spots.get(mine.tile), t = $("tools"), n = $("note");
  let below = me.y + me.s + 6;
  const tw = t.offsetWidth, th = t.offsetHeight;
  const tx = Math.max(0, Math.min(me.x + me.s / 2 - tw / 2, innerWidth - tw));
  const ty = below + th <= innerHeight ? below : Math.max(0, me.y - th - 6);
  t.style.left = `${tx}px`; t.style.top = `${ty}px`;
  shapes.push({ x: tx, y: ty, w: tw, h: th, round: false });
  if (ty >= below) below = ty + th + 4;
  if (n.textContent) {
    n.style.left = `${me.x}px`; n.style.top = `${Math.min(below, innerHeight - n.offsetHeight)}px`;
    const r = n.getBoundingClientRect();
    shapes.push({ x: r.left, y: r.top, w: r.width, h: r.height, round: false });
  }
  toParent({ wsvc: "shapes", shapes });
}
function setLayout(mode, o) {
  layout = mode === "bubbles" ? "bubbles" : "box";
  if (o) origin = { x: +o.x || 18, y: +o.y || 18, w: +o.w || 160 };
  document.body.classList.toggle("bubbles", layout === "bubbles");
  // The camera and mic buttons sit inside your own bubble, or float over the bottom of the box.
  if (layout === "bubbles") $("tools").append($("bar"), $("ctl"));
  else { document.body.append($("bar")); $("wrap").append($("ctl")); }
  for (const el of $("tiles").children) if (layout === "box") el.removeAttribute("style");
  $("note").removeAttribute("style"); $("tools").removeAttribute("style");
  lastH = 0;
  fit();
}
// Drag a bubble to move it, or its corner to resize it. Pointer capture keeps the drag on the bubble.
document.addEventListener("pointerdown", e => {
  if (layout !== "bubbles" || e.button !== 0 || e.target.closest("button")) return;
  const el = e.target.closest(".tile"), sp = el && spots.get(el);
  if (!sp) return;
  e.preventDefault();
  const resize = !!e.target.closest(".rz"), start = { x: e.clientX, y: e.clientY, sp: Object.assign({}, sp) };
  el.setPointerCapture(e.pointerId); dragging = true; el.classList.add("drag");
  const move = ev => {
    const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
    if (resize) sp.s = start.sp.s + (Math.abs(dx) > Math.abs(dy) ? dx : dy);
    else { sp.x = start.sp.x + dx; sp.y = start.sp.y + dy; }
    placeBubbles();
  };
  const end = () => { dragging = false; el.classList.remove("drag"); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", end); el.removeEventListener("pointercancel", end); };
  el.addEventListener("pointermove", move); el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
});
// Hover is tracked by hand (the "hov" class) rather than with :hover, which stays stuck on once
// content.js takes the pointer away from the frame. Off the bubbles, the pointer goes back to the page.
let hovTile = null, inside = false;
function hover(el) { if (!el) document.body.classList.remove("mehov"); if (hovTile === el) return; if (hovTile) hovTile.classList.remove("hov"); hovTile = el; if (el) el.classList.add("hov"); }
function inFrame(on) { if (inside === on) return; inside = on; document.body.classList.toggle("hov", on); toParent({ wsvc: "hover", on }); }
const cold = () => { if (layout !== "bubbles" || dragging) return; hover(null); inFrame(false); toParent({ wsvc: "cold" }); };
document.addEventListener("pointermove", e => {
  if (dragging) return;
  inFrame(true); hover(e.target.closest(".tile"));
  // Your buttons show while you point at your own bubble or at the buttons themselves.
  document.body.classList.toggle("mehov", !!e.target.closest(".tile.me, #tools"));
  if (!e.target.closest(".tile, #note, #tools")) cold();
});
const left = () => { if (dragging) return; hover(null); inFrame(false); cold(); };
document.documentElement.addEventListener("pointerleave", left);
document.addEventListener("pointerout", e => { if (!e.relatedTarget) left(); });   // leaving the frame altogether

// Your own bubble's – ⧉ × (as bubbles there is no box to put them on); content.js does the rest.
for (const [id, c] of [["bmin", "min"], ["blay", "layout"], ["bx", "close"]]) $(id).onclick = () => toParent({ wsvc: "cmd", c });

// From content.js: which layout, and "leave" before it removes the frame, so everyone drops our tile right away.
window.addEventListener("message", e => {
  if (e.source !== parent || parent === window || !e.data) return;
  if (e.data.wsvc === "leave") leave();
  else if (e.data.wsvc === "layout") setLayout(e.data.mode, e.data);
  else if (e.data.wsvc === "out") { inside = false; hover(null); document.body.classList.remove("hov"); }
});
function leave() {
  if (up) sig("*", { t: "bye" });
  turn("video", false); turn("audio", false);
  dropAll();
}
window.addEventListener("pagehide", () => { if (up) sig("*", { t: "bye" }); });

(async () => {
  renderMine();
  toParent({ wsvc: "ready" });
  await hello();
  let saved = null;
  try { saved = (await chrome.storage.session.get("vc")).vc; } catch {}
  if (saved && saved.cam) turn("video", true);
  if (saved && saved.mic) turn("audio", true);
})();
