// Video quality for the screen share and the watch party's file stream.
// Each viewer picks a size and a bitrate (or Auto); the host applies that choice to
// the stream it sends to that viewer only. Auto keeps computers at full quality and
// gives phones and tablets 1080p at 2.5 Mbps, which looks the same on a small screen
// and costs far less battery and data.
(() => {
  const PHONE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1); // iPadOS says "Macintosh"
  const SIZES = ["source", "1080", "720", "480"];
  const RATES = [8, 6, 4, 2.5, 1.5, 0.8];                 // Mbps
  const AUTO_RATE = { 1080: 2.5, 720: 1.5, 480: 0.8 };    // Mbps for each size when bitrate is Auto
  const label = s => s === "source" ? "Original" : s + "p";

  // Whatever arrives from the other side is untrusted: keep only known values.
  const clean = q => ({
    res: q && SIZES.includes(q.res) ? q.res : "auto",
    rate: q && RATES.includes(q.rate) ? q.rate : "auto",
    phone: !!q && q.phone === true,
  });
  // -> { res: "source" | "1080" | ..., mbps } for a host whose top bitrate is maxMbps
  function resolve(q, maxMbps) {
    q = clean(q);
    const res = q.res !== "auto" ? q.res : q.phone ? "1080" : "source";
    const mbps = q.rate !== "auto" ? q.rate : res === "source" ? maxMbps : AUTO_RATE[res];
    return { res, mbps: Math.min(mbps, maxMbps) };
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
    let q = clean(Object.assign({}, saved, { phone: PHONE }));

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
      const r = resolve(q, maxMbps), auto = resolve({ res: q.res, phone: q.phone }, maxMbps);
      resSel.textContent = ""; rateSel.textContent = "";
      opt(resSel, "auto", `Auto (${label(resolve({ phone: q.phone }, maxMbps).res)})`);
      SIZES.forEach(s => opt(resSel, s, label(s)));
      opt(rateSel, "auto", `Auto (${auto.mbps} Mbps)`);
      RATES.filter(m => m <= maxMbps).forEach(m => opt(rateSel, m, `${m} Mbps`));
      resSel.value = q.res; rateSel.value = String(q.rate);
      button.textContent = q.res === "auto" && q.rate === "auto" ? "Quality" : label(r.res); // short: the bar is narrow on phones
    }
    function change() {
      q = clean({ res: resSel.value, rate: rateSel.value === "auto" ? "auto" : +rateSel.value, phone: PHONE });
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

  window.Quality = { PHONE, clean, resolve, apply, mount };
})();
