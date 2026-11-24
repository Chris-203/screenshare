// Test stand-in for PeerJS. Same surface the pages and the extension use (Peer, DataConnection,
// their events), but every message goes through the local hub in run.mjs over a WebSocket
// instead of the public broker and WebRTC. The hub adds latency and jitter, so the tests
// need no internet and give the same result on every run.
// Media calls (peer.call / "call") are real: a plain RTCPeerConnection between the two browsers,
// with its offer and answer carried by the hub. Only the screen share test uses them.
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

  // A real RTCPeerConnection behind PeerJS's MediaConnection surface. No trickle ICE: each side
  // waits for its candidates before sending its description, which is quick on one machine.
  const gathered = pc => pc.iceGatheringState === "complete" ? Promise.resolve() : new Promise(r => {
    pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") r(); });
    setTimeout(r, 3000);
  });
  class MediaConnection extends Emitter {
    constructor(owner, cid, remote, localStream, opts) {
      super();
      this._owner = owner; this._cid = cid; this.peer = remote; this.open = false; this.type = "media";
      this.localStream = localStream || null; this.remoteStream = null; this.options = opts || {};
      const pc = this.peerConnection = new RTCPeerConnection();
      pc.ontrack = e => { this.remoteStream = e.streams[0]; this.emit("stream", e.streams[0]); };
      pc.oniceconnectionstatechange = () => {
        this.emit("iceStateChanged", pc.iceConnectionState);
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") this.open = true;
      };
      if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }
    async _offer() {
      const pc = this.peerConnection;
      await pc.setLocalDescription(this._transform(await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true })));
      await gathered(pc);
      if (!this._closed) this._owner._tx({ op: "call", to: this.peer, cid: this._cid, sdp: pc.localDescription.sdp });
    }
    // PeerJS's sdpTransform option: applied to our own offer or answer before it is set and sent.
    _transform(d) { const f = this.options.sdpTransform; return typeof f === "function" ? { type: d.type, sdp: f(d.sdp) || d.sdp } : d; }
    answer(stream, opts) {
      if (opts && opts.sdpTransform) this.options.sdpTransform = opts.sdpTransform;
      if (stream) { this.localStream = stream; stream.getTracks().forEach(t => this.peerConnection.addTrack(t, stream)); }
      (async () => {
        const pc = this.peerConnection;
        await pc.setRemoteDescription({ type: "offer", sdp: this._offerSdp });
        await pc.setLocalDescription(this._transform(await pc.createAnswer()));
        await gathered(pc);
        if (!this._closed) this._owner._tx({ op: "data", cid: this._cid, payload: { __answer: pc.localDescription.sdp } });
      })().catch(e => console.error(e));
    }
    _signal(payload) { if (payload && payload.__answer) this.peerConnection.setRemoteDescription({ type: "answer", sdp: payload.__answer }).catch(e => console.error(e)); }
    close() {
      if (this._closed) return;
      const wasKnown = this._owner._conns.delete(this._cid);
      this._closed = true; this.open = false;
      try { this.peerConnection.close(); } catch {}
      if (wasKnown) this._owner._tx({ op: "close", cid: this._cid });
      this.emit("close");
    }
    _remoteClosed() { if (this._closed) return; this._owner._conns.delete(this._cid); this._closed = true; this.open = false; try { this.peerConnection.close(); } catch {} this.emit("close"); }
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
      else if (m.op === "incomingcall") { const c = new MediaConnection(this, m.cid, m.from); c._offerSdp = m.sdp; this._conns.set(m.cid, c); this.emit("call", c); }
      else if (m.op === "data") { const c = this._conns.get(m.cid); if (c instanceof MediaConnection) c._signal(m.payload); else if (c && c.open) c.emit("data", m.payload); }
      else if (m.op === "close") { const c = this._conns.get(m.cid); if (c) c._remoteClosed(); }
    }
    connect(to) {
      const cid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${seq++}`;
      const c = new DataConnection(this, cid, to);
      this._conns.set(cid, c);
      this._tx({ op: "connect", to, cid });
      return c;
    }
    call(to, stream, opts) {
      const cid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${seq++}`;
      const c = new MediaConnection(this, cid, to, stream, opts);
      this._conns.set(cid, c);
      c._offer().catch(e => console.error(e));
      return c;
    }
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
