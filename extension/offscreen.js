// Watch Sync — offscreen document.
// Holds the PeerJS connections for the party and keeps clocks aligned, so
// timestamps from another person's side can be translated into ours.
//
// The host is the hub: every guest connects only to the host. The host asks before letting
// anyone in, keeps one clock offset per guest, and passes each guest's play, pause and seek
// on to the others. A guest only ever talks to the host.

const PREFIX = "chris203-ws-";
const MAX_GUESTS = 8;      // people let in, besides the host
const MAX_PENDING = 5;     // people waiting for Allow / Deny
const STALE_MS = 12000;    // pings arrive every 5s, so this is two missed in a row
// Message types that belong to this file. They are never passed on from one guest to another.
const RESERVED = new Set(["hello", "pending", "denied", "busy", "roster", "ping", "pong", "tick", "joined"]);

let peer = null, party = null, retryTimer = null;

// ---- guest side: one connection, to the host
let conn = null;
let offset = 0, bestRtt = Infinity; // hostClock ≈ Date.now() + offset
let pass = null;                    // given by the host once allowed, so a dropped connection gets back in without asking again
let welcomed = false, hostName = null, others = [];

// ---- host side
const guests = new Map();           // peerId -> { conn, name, ok, offset, bestRtt, lastSeen, joinTimer }; ok = allowed by the host
const passes = new Set();

const toBg = msg => chrome.runtime.sendMessage(Object.assign({ to: "bg" }, msg)).catch(() => {});
const status = (s, extra) => toBg(Object.assign({ type: "peerStatus", status: s }, extra));
const hostId = () => `${PREFIX}${party.code}-host`;
const guestId = () => `${PREFIX}${party.code}-guest${party.id ? "-" + party.id : ""}`;
const cleanName = n => String(n == null ? "" : n).replace(/\s+/g, " ").trim().slice(0, 20) || "Guest";
const newPass = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");
const listNames = a => a.length < 2 ? (a[0] || "") : a.length <= 3 ? `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}` : `${a[0]}, ${a[1]} and ${a.length - 2} others`;
const sendTo = (c, msg) => { if (c && c.open) { try { c.send(msg); } catch {} } };
const allowed = () => [...guests.values()].filter(g => g.ok);

function close() {
  clearTimeout(retryTimer);
  const old = [...guests.values()];
  guests.clear();
  old.forEach(g => { clearTimeout(g.joinTimer); try { g.conn.close(); } catch {} });
  if (conn) { try { conn.close(); } catch {} conn = null; }
  welcomed = false; others = [];
  if (peer) { try { peer.destroy(); } catch {} peer = null; }
}

function open(p, attempt = 0) {
  close();
  // Passes belong to one party. Starting or joining another one starts clean.
  if (!party || party.code !== p.code || party.role !== p.role) { passes.clear(); pass = null; }
  party = p;
  peer = new Peer(p.role === "host" ? hostId() : guestId(), { debug: 1 });
  peer.on("open", () => {
    if (p.role === "host") hostStatus(); else { status("connecting"); dial(); }
  });
  peer.on("connection", c => { if (party && party.role === "host") onGuest(c); });
  peer.on("disconnected", () => { if (peer && !peer.destroyed) peer.reconnect(); });
  peer.on("error", e => {
    if (!party) return;
    if (e.type === "peer-unavailable") { status("partner-offline"); clearTimeout(retryTimer); retryTimer = setTimeout(dial, 3000); }
    else if (e.type === "unavailable-id" && attempt < 10) { retryTimer = setTimeout(() => open(party, attempt + 1), 3000); }
    else if (["network", "server-error", "socket-error", "socket-closed"].includes(e.type)) { status("reconnecting"); retryTimer = setTimeout(() => open(party), 4000); }
  });
}

// ------------------------------------------------------------ clocks
// `o` is anything with offset and bestRtt: a guest record on the host, or `me` on a guest.
const me = { get offset() { return offset; }, set offset(v) { offset = v; }, get bestRtt() { return bestRtt; }, set bestRtt(v) { bestRtt = v; } };
function onPong(o, m) {
  if (typeof m.c !== "number" || typeof m.h !== "number") return;
  const t = Date.now(), rtt = t - m.c;
  if (rtt < 0) return;
  if (rtt <= o.bestRtt * 1.5 || rtt < 40) { o.offset = m.h + rtt / 2 - t; o.bestRtt = Math.min(o.bestRtt, rtt); }
}
const ping = c => sendTo(c, { type: "ping", c: Date.now() });
const burst = (o, c) => { o.bestRtt = Infinity; for (let i = 0; i < 6; i++) setTimeout(() => ping(c), i * 150); };
setInterval(() => {
  if (!party) return;
  if (party.role === "guest") { bestRtt *= 1.05; ping(conn); return; }
  const now = Date.now();
  for (const g of [...guests.values()]) {
    // A guest that has gone quiet is treated as gone, without waiting for WebRTC to notice.
    if (now - g.lastSeen > STALE_MS) { forget(g); continue; }
    if (g.ok) { g.bestRtt *= 1.05; ping(g.conn); }
  }
}, 5000);

// ------------------------------------------------------------ host
// What the host's tab and popup show: who is in, and who is asking.
function hostStatus(joined) {
  if (!party || party.role !== "host") return;
  const ok = allowed();
  const requests = [...guests.entries()].filter(([, g]) => !g.ok).map(([id, g]) => ({ id, name: g.name }));
  status(ok.length ? "connected" : "waiting", { partnerName: listNames(ok.map(g => g.name)), requests, joined });
}
// Each guest is told who else is in, so it can say "Synced with Chris and Sam".
function sendRoster() {
  const ok = allowed();
  ok.forEach(g => sendTo(g.conn, { type: "roster", names: ok.filter(x => x !== g).map(x => x.name) }));
}
function hangUp(c, last) {
  if (last) sendTo(c, last);
  setTimeout(() => { try { c.close(); } catch {} }, last ? 500 : 0); // give the message a moment to go out
}
function forget(g, last) {
  clearTimeout(g.joinTimer);
  const had = guests.get(g.conn.peer) === g;
  if (had) guests.delete(g.conn.peer);
  hangUp(g.conn, last);
  if (had) { if (g.ok) sendRoster(); hostStatus(); }
}
function admit(g, p) {
  if (!g.conn.open || guests.get(g.conn.peer) !== g) return hostStatus();
  g.ok = true; passes.add(p);
  // The host's hello is the welcome. Until it arrives the guest shows nothing as connected.
  sendTo(g.conn, { type: "hello", name: party.name, pass: p });
  burst(g, g.conn);
  sendRoster();
  hostStatus(g.name);
  // Let the clock samples land before the tab sends everyone the current state.
  g.joinTimer = setTimeout(() => { if (guests.get(g.conn.peer) === g) toBg({ type: "peerMsg", msg: { type: "joined" } }); }, 900);
}
function decide(id, allow) {
  const g = guests.get(id);
  if (!g || g.ok) return;
  if (!allow) forget(g, { type: "denied" });
  else if (allowed().length >= MAX_GUESTS) forget(g, { type: "busy" });
  else admit(g, newPass());
}

function onGuest(c) {
  const g = { conn: c, name: "", ok: false, offset: 0, bestRtt: Infinity, lastSeen: Date.now(), joinTimer: null };
  let greeted = false;
  // The guest has to introduce itself first; a connection that never does is closed.
  const noHello = setTimeout(() => { if (!greeted) hangUp(c); }, 15000);
  c.on("data", m => {
    if (!m || typeof m !== "object") return;
    if (m.type === "hello") {
      if (greeted) return;
      greeted = true; clearTimeout(noHello);
      g.name = cleanName(m.name);
      // The same person coming back (same peer ID) replaces their old connection.
      const old = guests.get(c.peer);
      if (old) { clearTimeout(old.joinTimer); guests.delete(c.peer); hangUp(old.conn); }
      const known = typeof m.pass === "string" && passes.has(m.pass);
      if (allowed().length >= MAX_GUESTS) { hangUp(c, { type: "busy" }); if (old) { sendRoster(); hostStatus(); } return; }
      guests.set(c.peer, g);
      if (known) return admit(g, m.pass);
      // Keep the list short: if it is full, the oldest request makes room (it may be someone who already left).
      const waiting = [...guests.values()].filter(x => !x.ok && x !== g);
      if (waiting.length >= MAX_PENDING) forget(waiting[0], { type: "denied" });
      sendTo(c, { type: "pending" });
      if (old && old.ok) sendRoster();
      hostStatus();
      return;
    }
    if (guests.get(c.peer) !== g) return;
    g.lastSeen = Date.now();
    if (m.type === "ping") return sendTo(c, { type: "pong", c: m.c, h: Date.now() });
    // Nothing else from a guest is read until the host has pressed Allow.
    if (!g.ok) return;
    if (m.type === "pong") return onPong(g, m);
    if (RESERVED.has(m.type)) return;
    if (typeof m.at === "number") m.at -= g.offset; // their clock → ours
    m.from = g.name;                                // set here, so a guest can't speak as someone else
    // Pass it on to everyone else. `at` is now on the host's clock, which is what each guest translates from.
    for (const x of guests.values()) if (x.ok && x !== g) sendTo(x.conn, m);
    toBg({ type: "peerMsg", msg: m });
  });
  const gone = () => { clearTimeout(noHello); if (guests.get(c.peer) === g) forget(g); };
  c.on("close", gone);
  c.on("error", gone);
}

// ------------------------------------------------------------ guest
function dial() {
  if (!peer || peer.destroyed || !party || party.role !== "guest") return;
  attach(peer.connect(hostId(), { reliable: true }));
}
const guestLabel = () => listNames([hostName, ...others]);

function attach(c) {
  if (conn && conn !== c) { try { conn.close(); } catch {} }
  conn = c; welcomed = false; others = [];
  let refused = false, denied = false, joinTimer = null;
  c.on("open", () => {
    sendTo(c, { type: "hello", name: party.name, pass });
    burst(me, c);
  });
  c.on("data", m => {
    if (conn !== c || !m || typeof m !== "object") return;
    if (m.type === "ping") return sendTo(c, { type: "pong", c: m.c, h: Date.now() });
    if (m.type === "pong") return onPong(me, m);
    if (m.type === "busy") { refused = true; status("party-full"); return; }
    if (m.type === "denied") { denied = true; pass = null; status("denied"); return; }
    if (refused || denied) return;
    if (m.type === "pending") { if (!welcomed) status("asking"); return; }
    if (m.type === "hello") {
      welcomed = true; hostName = cleanName(m.name);
      if (typeof m.pass === "string") pass = m.pass.slice(0, 64);
      status("connected", { partnerName: guestLabel() });
      // Let the clock samples land before the tab exchanges state.
      if (!joinTimer) joinTimer = setTimeout(() => { if (conn === c) toBg({ type: "peerMsg", msg: { type: "joined" } }); }, 900);
      return;
    }
    if (!welcomed) return;
    if (m.type === "roster") {
      others = (Array.isArray(m.names) ? m.names : []).slice(0, MAX_GUESTS).map(cleanName);
      status("connected", { partnerName: guestLabel() });
      return;
    }
    if (typeof m.at === "number") m.at -= offset; // host's clock → ours
    toBg({ type: "peerMsg", msg: m });
  });
  c.on("close", () => {
    clearTimeout(joinTimer);
    if (conn !== c) return;
    conn = null; welcomed = false;
    if (!party || denied) return; // no automatic retry after a no
    if (!refused) status("reconnecting");
    // Keep trying after "full" too, more slowly: a seat frees up when someone leaves.
    clearTimeout(retryTimer); retryTimer = setTimeout(dial, refused ? 8000 : 3000);
  });
}

// ------------------------------------------------------------ from the tab and popup, by way of the service worker
function send(msg) {
  if (!party || !msg || typeof msg !== "object") return;
  if (party.role === "guest") { if (welcomed) sendTo(conn, msg); return; }
  msg.from = party.name;
  for (const g of guests.values()) if (g.ok) sendTo(g.conn, msg);
}

chrome.runtime.onMessage.addListener(m => {
  if (!m || m.to !== "off") return;
  if (m.cmd === "open") {
    const same = party && peer && !peer.destroyed && party.code === m.party.code && party.role === m.party.role;
    if (!same) open(m.party);
  }
  else if (m.cmd === "close") { party = null; passes.clear(); pass = null; close(); }
  else if (m.cmd === "send") send(m.msg);
  else if (m.cmd === "decide" && party && party.role === "host") decide(m.id, !!m.allow);
});

// If this document was recreated (e.g. after the extension reloaded), rejoin.
toBg({ type: "offReady" }).then(r => { if (r && r.party && !party) open(r.party); });
