// Video quality for the screen share and the watch party's file stream.
// Each viewer picks a size and a bitrate (or Auto); the host applies that choice to
// the stream it sends to that viewer only. Auto keeps computers at full quality and
// gives phones 720p at 1.5 Mbps and tablets 1080p at 2.5 Mbps, which look the same on a small screen
// and costs far less battery and data.
(() => {
  const UA = navigator.userAgent;
  // iPadOS says "Macintosh"; Android tablets leave "Mobile" out of the user agent.
  const TABLET = /iPad/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1) || (/Android/i.test(UA) && !/Mobile/i.test(UA));
  const PHONE = TABLET || /iPhone|iPod|Android/i.test(UA);
  const SIZES = ["source", "1080", "720", "480"];
  const RATES = [8, 6, 4, 2.5, 1.5, 0.8];                 // Mbps
  const AUTO_RATE = { 1080: 2.5, 720: 1.5, 480: 0.8 };    // Mbps for each size when bitrate is Auto
  const label = s => s === "source" ? "Original" : s + "p";

  // Whatever arrives from the other side is untrusted: keep only known values.
  const clean = q => ({
    res: q && SIZES.includes(q.res) ? q.res : "auto",
    rate: q && RATES.includes(q.rate) ? q.rate : "auto",
    phone: !!q && q.phone === true,
    tablet: !!q && q.tablet === true,
  });
  // -> { res: "source" | "1080" | ..., mbps } for a host whose top bitrate is maxMbps
  function resolve(q, maxMbps) {
    q = clean(q);
    const res = q.res !== "auto" ? q.res : q.tablet ? "1080" : q.phone ? "720" : "source";
    const mbps = q.rate !== "auto" ? q.rate : res === "source" ? maxMbps : AUTO_RATE[res];
    return { res, mbps: Math.min(mbps, maxMbps) };
  }

  // Put H.264 first in an offer or answer (PeerJS sdpTransform). Without this, Chrome
  // picks VP8, which Windows encodes in software and iPhones and iPads decode in software:
  // both sides heat up, and after a few minutes the frames come late and the share lags.
  // H.264 uses the graphics chip on both ends. If the other side lacks it, nothing changes.
  function preferH264(sdp) {
    const lines = sdp.split("\r\n");
    const m = lines.findIndex(l => l.startsWith("m=video "));
    if (m < 0) return sdp;
    let end = lines.findIndex((l, i) => i > m && l.startsWith("m="));
    if (end < 0) end = lines.length;
    const sec = lines.slice(m, end), map = {}, fmtp = {};
    sec.forEach(l => {
      let x = /^a=rtpmap:(\d+) ([^/]+)/.exec(l); if (x) map[x[1]] = x[2].toUpperCase();
      x = /^a=fmtp:(\d+) (.*)/.exec(l); if (x) fmtp[x[1]] = x[2];
    });
    const parts = lines[m].split(" "), pts = parts.slice(3);
    // Packetization mode 1 is what browsers expect; constrained baseline (42e0) is the most widely accelerated.
    const rank = pt => map[pt] !== "H264" ? 9 : !/packetization-mode=1/.test(fmtp[pt] || "") ? 3 : /profile-level-id=42e0/i.test(fmtp[pt] || "") ? 0 : 1;
    const h264 = pts.filter(pt => rank(pt) < 9).sort((a, b) => rank(a) - rank(b));
    if (!h264.length) return sdp;
    const rtx = pts.filter(pt => map[pt] === "RTX" && h264.some(h => new RegExp("apt=" + h + "(;|$)").test(fmtp[pt] || "")));
    const first = h264.concat(rtx);
    lines[m] = parts.slice(0, 3).concat(first, pts.filter(pt => !first.includes(pt))).join(" ");
    return lines.join("\r\n");
  }

  // Host side: apply a viewer's choice to the video sender of their call.
  function apply(pc, q, maxMbps, extra) {
    if (!pc) return;
    const r = resolve(q, maxMbps);
    pc.getSenders().forEach(s => {
      if (!s.track || s.track.kind !== "video") return;
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      const h = s.track.getSettings().height || 0;
      p.encodings[0].maxBitrate = Math.round(r.mbps * 1e6);
      p.encodings[0].scaleResolutionDownBy = r.res !== "source" && h > +r.res ? h / +r.res : 1;
      if (extra) extra(p);
      s.setParameters(p).catch(() => {});
    });
  }

  // Viewer side: a button that opens a small panel with the two choices.
  // send(q) is called with the current choice now and after every change.
  function mount(button, maxMbps, storeKey, send) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storeKey) || "{}"); } catch {}
    let q = clean(Object.assign({}, saved, { phone: PHONE, tablet: TABLET }));

    const css = document.createElement("style");
    css.textContent = ".qpanel{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(max(16px,env(safe-area-inset-bottom)) + 64px);z-index:20;"
      + "display:grid;grid-template-columns:auto auto;gap:10px 12px;align-items:center;padding:14px 16px;background:rgba(23,25,30,.94);"
      + "border:1px solid var(--line);border-radius:14px;color:var(--text);font-size:14px}"
      + ".qpanel select{font:inherit;color:inherit;background:var(--panel,#17191e);border:1px solid var(--line);border-radius:8px;padding:6px 8px}"
      + ".qpanel .qnote{grid-column:1/-1;color:var(--muted,#8b90a0);font-size:12px;max-width:240px}";
    document.head.append(css);

    const panel = document.createElement("div"); panel.className = "qpanel hidden";
    const row = (text, sel) => { const l = document.createElement("label"); l.textContent = text; panel.append(l, sel); };
    const resSel = document.createElement("select"), rateSel = document.createElement("select");
    const note = document.createElement("div"); note.className = "qnote";
    note.textContent = PHONE ? "Lower settings save battery and data." : "Lower settings help on a slow connection.";
    row("Quality", resSel); row("Bitrate", rateSel); panel.append(note);
    document.body.append(panel);

    const opt = (sel, value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; sel.append(o); };
    function render() {
      const r = resolve(q, maxMbps), auto = resolve({ res: q.res, phone: q.phone, tablet: q.tablet }, maxMbps);
      resSel.textContent = ""; rateSel.textContent = "";
      opt(resSel, "auto", `Auto (${label(resolve({ phone: q.phone, tablet: q.tablet }, maxMbps).res)})`);
      SIZES.forEach(s => opt(resSel, s, label(s)));
      opt(rateSel, "auto", `Auto (${auto.mbps} Mbps)`);
      RATES.filter(m => m <= maxMbps).forEach(m => opt(rateSel, m, `${m} Mbps`));
      resSel.value = q.res; rateSel.value = String(q.rate);
      button.textContent = q.res === "auto" && q.rate === "auto" ? "Quality" : label(r.res); // short: the bar is narrow on phones
    }
    function change() {
      q = clean({ res: resSel.value, rate: rateSel.value === "auto" ? "auto" : +rateSel.value, phone: PHONE, tablet: TABLET });
      try { localStorage.setItem(storeKey, JSON.stringify({ res: q.res, rate: q.rate })); } catch {}
      render(); send(q);
    }
    resSel.onchange = change; rateSel.onchange = change;
    button.onclick = e => { e.stopPropagation(); panel.classList.toggle("hidden"); };
    panel.addEventListener("pointerdown", e => e.stopPropagation());
    document.addEventListener("pointerdown", () => panel.classList.add("hidden"));
    render();
    return { get: () => q, hide: () => panel.classList.add("hidden") };
  }

  window.Quality = { PHONE, clean, resolve, apply, mount, preferH264 };
})();
