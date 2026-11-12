// Watch Sync — offscreen document.
// Holds the PeerJS connection to your partner and keeps clocks aligned, so
// timestamps from their side can be translated into ours.

const PREFIX = "chris203-ws-";
let peer = null, conn = null, party = null, retryTimer = null;
let offset = 0, bestRtt = Infinity; // partnerClock ≈ Date.now() + offset

const toBg = msg => chrome.runtime.sendMessage(Object.assign({ to: "bg" }, msg)).catch(() => {});
const status = (s, partnerName) => toBg({ type: "peerStatus", status: s, partnerName });
const idFor = role => `${PREFIX}${party.code}-${role}`;

function close() {
  clearTimeout(retryTimer);
  if (conn) { try { conn.close(); } catch {} conn = null; }
  if (peer) { try { peer.destroy(); } catch {} peer = null; }
}

function open(p, attempt = 0) {
  close();
  party = p;
  peer = new Peer(idFor(p.role), { debug: 1 });
  peer.on("open", () => {
    status(p.role === "host" ? "waiting" : "connecting");
    if (p.role === "guest") dial();
  });
  peer.on("connection", c => { if (party && party.role === "host") attach(c); });
  peer.on("disconnected", () => { if (peer && !peer.destroyed) peer.reconnect(); });
  peer.on("error", e => {
    if (!party) return;
    if (e.type === "peer-unavailable") { status("partner-offline"); retryTimer = setTimeout(dial, 3000); }
    else if (e.type === "unavailable-id" && attempt < 10) { retryTimer = setTimeout(() => open(party, attempt + 1), 3000); }
    else if (["network", "server-error", "socket-error", "socket-closed"].includes(e.type)) { status("reconnecting"); retryTimer = setTimeout(() => open(party), 4000); }
  });
}

function dial() {
  if (!peer || peer.destroyed || !party) return;
  attach(peer.connect(idFor("host"), { reliable: true }));
}

function ping() { if (conn && conn.open) conn.send({ type: "ping", c: Date.now() }); }
setInterval(() => { bestRtt *= 1.05; ping(); }, 5000);

function attach(c) {
  if (conn && conn !== c) { try { conn.close(); } catch {} }
  conn = c;
  c.on("open", () => {
    bestRtt = Infinity;
    for (let i = 0; i < 6; i++) setTimeout(ping, i * 150);
    c.send({ type: "hello", name: party.name });
    status("connected");
    // Let the clock samples land before the tab exchanges state.
    setTimeout(() => toBg({ type: "peerMsg", msg: { type: "joined" } }), 900);
  });
  c.on("data", m => {
    if (!m || typeof m !== "object") return;
    if (m.type === "ping") return c.send({ type: "pong", c: m.c, h: Date.now() });
    if (m.type === "pong") {
      const t = Date.now(), rtt = t - m.c;
      if (rtt <= bestRtt * 1.5 || rtt < 40) { offset = m.h + rtt / 2 - t; bestRtt = Math.min(bestRtt, rtt); }
      return;
    }
    if (m.type === "hello") { status("connected", m.name); return; }
    if (typeof m.at === "number") m.at -= offset; // their clock → ours
    toBg({ type: "peerMsg", msg: m });
  });
  c.on("close", () => {
    if (conn !== c) return;
    conn = null;
    if (!party) return;
    status(party.role === "host" ? "waiting" : "reconnecting");
    if (party.role === "guest") retryTimer = setTimeout(dial, 3000);
  });
}

chrome.runtime.onMessage.addListener(m => {
  if (!m || m.to !== "off") return;
  if (m.cmd === "open") {
    const same = party && peer && !peer.destroyed && party.code === m.party.code && party.role === m.party.role;
    if (!same) open(m.party);
  }
  else if (m.cmd === "close") { party = null; close(); }
  else if (m.cmd === "send" && conn && conn.open) conn.send(m.msg);
});

// If this document was recreated (e.g. after the extension reloaded), rejoin.
toBg({ type: "offReady" }).then(r => { if (r && r.party && !party) open(r.party); });
