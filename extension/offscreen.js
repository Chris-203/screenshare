// Watch Sync — offscreen document.
// Holds the PeerJS connection to your partner and keeps clocks aligned, so
// timestamps from their side can be translated into ours.

const PREFIX = "chris203-ws-";
let peer = null, conn = null, party = null, retryTimer = null;
let offset = 0, bestRtt = Infinity; // partnerClock ≈ Date.now() + offset
let lastSeen = 0;                   // when the current connection was attached or last sent us anything
const STALE_MS = 12000;             // pings arrive every 5s, so this is two missed in a row

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
  peer.on("connection", c => {
    if (!party || party.role !== "host") return;
    // A party is two people. While a guest is connected (or still connecting) and has been
    // heard from recently, turn anyone else away instead of letting them replace the guest.
    // A connection that has gone quiet is treated as dead, so the real guest can get back in
    // after a network drop without waiting for WebRTC to notice.
    if (conn && conn !== c && Date.now() - lastSeen < STALE_MS) refuse(c);
    else attach(c);
  });
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

// Tell the caller the party is full, then hang up. Nothing they send is read.
function refuse(c) {
  const hangUp = () => { clearTimeout(giveUp); try { c.close(); } catch {} };
  const giveUp = setTimeout(hangUp, 10000);
  c.on("open", () => { try { c.send({ type: "busy" }); } catch {} setTimeout(hangUp, 500); });
  c.on("error", hangUp);
}

function ping() { if (conn && conn.open) conn.send({ type: "ping", c: Date.now() }); }
setInterval(() => { bestRtt *= 1.05; ping(); }, 5000);

function attach(c) {
  if (conn && conn !== c) { try { conn.close(); } catch {} }
  conn = c;
  lastSeen = Date.now();
  let refused = false, joinTimer = null;
  const connected = partnerName => {
    status("connected", partnerName);
    // Let the clock samples land before the tab exchanges state.
    if (!joinTimer) joinTimer = setTimeout(() => { if (conn === c) toBg({ type: "peerMsg", msg: { type: "joined" } }); }, 900);
  };
  c.on("open", () => {
    bestRtt = Infinity;
    for (let i = 0; i < 6; i++) setTimeout(ping, i * 150);
    c.send({ type: "hello", name: party.name });
    // The guest waits for the host's hello, because a host that already has a guest answers
    // with "busy" instead and this must not show as connected first.
    if (party.role === "host") connected();
  });
  c.on("data", m => {
    if (conn !== c || !m || typeof m !== "object") return;
    lastSeen = Date.now();
    if (m.type === "ping") return c.send({ type: "pong", c: m.c, h: Date.now() });
    if (m.type === "pong") {
      const t = Date.now(), rtt = t - m.c;
      if (rtt <= bestRtt * 1.5 || rtt < 40) { offset = m.h + rtt / 2 - t; bestRtt = Math.min(bestRtt, rtt); }
      return;
    }
    if (m.type === "busy") { if (party.role === "guest") { refused = true; status("party-full"); } return; }
    if (refused) return;
    if (m.type === "hello") { connected(m.name); return; }
    if (typeof m.at === "number") m.at -= offset; // their clock → ours
    toBg({ type: "peerMsg", msg: m });
  });
  c.on("close", () => {
    clearTimeout(joinTimer);
    if (conn !== c) return;
    conn = null;
    if (!party) return;
    if (!refused) status(party.role === "host" ? "waiting" : "reconnecting");
    // Keep trying after a refusal too, more slowly: the seat frees up when the other guest leaves.
    if (party.role === "guest") { clearTimeout(retryTimer); retryTimer = setTimeout(dial, refused ? 8000 : 3000); }
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
