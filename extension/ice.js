// ICE servers for WebRTC, shared by index.html, party.html and the extension.
// Without a TURN relay, people behind strict firewalls or carrier NAT can't connect.
// TURN_URL points at the small Cloudflare Worker in worker/, which hands out short-lived
// TURN credentials. Until it answers (or if it fails), PeerJS's own defaults are used,
// which is exactly how things worked before.
//
// Usage: new Peer(id, { debug: 1, config: ICE.config }), and wait for ICE.ready() before
// dialing. PeerJS reads ICE.config each time it opens a connection, so updating it in
// place is enough for every later connection to pick up fresh credentials.
(() => {
  const TURN_URL = ""; // e.g. "https://screenshare-turn.<your-subdomain>.workers.dev"
  const pj = window.peerjs && window.peerjs.util;
  const defaults = (pj && pj.defaultConfig) || { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  const config = Object.assign({}, defaults, { iceServers: defaults.iceServers.slice() });
  let expires = 0, pending = null;

  function ready() {
    if (!TURN_URL || Date.now() < expires) return Promise.resolve();
    if (pending) return pending;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000); // never hold up a connection for long
    pending = fetch(TURN_URL, { signal: ctl.signal, cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error("TURN " + r.status)))
      .then(d => {
        if (!d || !Array.isArray(d.iceServers) || !d.iceServers.length) throw new Error("TURN: no servers");
        config.iceServers = d.iceServers.concat({ urls: "stun:stun.l.google.com:19302" });
        // Refresh at half the lifetime so a long session never dials with expired credentials.
        expires = Date.now() + (d.ttl > 0 ? d.ttl : 3600) * 500;
      })
      .catch(e => { console.warn("No TURN relay, using STUN only:", e.message); expires = Date.now() + 60000; })
      .finally(() => { clearTimeout(timer); pending = null; });
    return pending;
  }

  ready();
  setInterval(ready, 5 * 60000); // keeps the host's config fresh while it waits for viewers
  window.ICE = { config, ready };
})();
