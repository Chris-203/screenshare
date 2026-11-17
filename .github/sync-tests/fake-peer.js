// Test stand-in for PeerJS. Same surface the pages and the extension use (Peer, DataConnection,
// their events), but every message goes through the local hub in run.mjs over a WebSocket
// instead of the public broker and WebRTC. The hub adds latency and jitter, so the tests
// need no internet and give the same result on every run.
// run.mjs puts `self.__SYNC_TEST_HUB = "ws://127.0.0.1:<port>";` in front of this file.

(() => {
  class Emitter {
    constructor() { this._h = {}; }
    on(type, fn) { (this._h[type] ||= []).push(fn); return this; }
    off(type, fn) { this._h[type] = (this._h[type] || []).filter(f => f !== fn); return this; }
    removeAllListeners(type) { if (type) delete this._h[type]; else this._h = {}; return this; }
    emit(type, ...args) { (this._h[type] || []).slice().forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } }); }
  }

  class DataConnection extends Emitter {
    constructor(owner, cid, remote) { super(); this._owner = owner; this._cid = cid; this.peer = remote; this.open = false; this.reliable = true; }
    send(payload) { if (this.open) this._owner._tx({ op: "data", cid: this._cid, payload }); }
    close() {
      if (this._closed) return;
      const wasKnown = this._owner._conns.delete(this._cid);
      this._closed = true; this.open = false;
      if (wasKnown) this._owner._tx({ op: "close", cid: this._cid });
      this.emit("close");
    }
    _remoteClosed() { if (this._closed) return; this._owner._conns.delete(this._cid); this._closed = true; this.open = false; this.emit("close"); }
  }

  let seq = 0;
  class Peer extends Emitter {
    constructor(id, _opts) {
      super();
      this.id = typeof id === "string" ? id : null;
      this.destroyed = false; this.disconnected = false;
      this._conns = new Map(); this._queue = [];
      const ws = this._ws = new WebSocket(self.__SYNC_TEST_HUB);
      ws.onopen = () => { ws.send(JSON.stringify({ op: "register", id: this.id })); this._queue.splice(0).forEach(m => ws.send(m)); };
      ws.onmessage = e => this._rx(JSON.parse(e.data));
      ws.onclose = () => { if (this.destroyed) return; this.disconnected = true; [...this._conns.values()].forEach(c => c._remoteClosed()); this.emit("disconnected"); };
    }
    _tx(msg) { const s = JSON.stringify(msg); if (this._ws.readyState === 1) this._ws.send(s); else if (this._ws.readyState === 0) this._queue.push(s); }
    _rx(m) {
      if (this.destroyed) return;
      if (m.op === "open") { this.id = m.id; this.emit("open", m.id); }
      else if (m.op === "error") { const e = new Error(m.type); e.type = m.type; this.emit("error", e); }
      else if (m.op === "incoming") { const c = new DataConnection(this, m.cid, m.from); this._conns.set(m.cid, c); this.emit("connection", c); }
      else if (m.op === "connopen") { const c = this._conns.get(m.cid); if (c) { c.open = true; c.emit("open"); } }
      else if (m.op === "data") { const c = this._conns.get(m.cid); if (c && c.open) c.emit("data", m.payload); }
      else if (m.op === "close") { const c = this._conns.get(m.cid); if (c) c._remoteClosed(); }
    }
    connect(to) {
      const cid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${seq++}`;
      const c = new DataConnection(this, cid, to);
      this._conns.set(cid, c);
      this._tx({ op: "connect", to, cid });
      return c;
    }
    call() { throw new Error("fake-peer: media calls are not part of the sync tests"); }
    reconnect() {}
    disconnect() {}
    destroy() {
      if (this.destroyed) return;
      [...this._conns.values()].forEach(c => c.close());
      this.destroyed = true; this.disconnected = true;
      try { this._ws.close(); } catch {}
      this.emit("close");
    }
  }

  self.Peer = Peer;
})();
