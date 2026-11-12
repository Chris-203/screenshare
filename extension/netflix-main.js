// Watch Sync — runs in Netflix's own page context.
// Netflix crashes (error M7375) if a video's currentTime is set directly,
// so seeks and play/pause go through Netflix's internal player API instead.
(() => {
  window.addEventListener("message", e => {
    if (e.source !== window || !e.data || e.data.__ws !== "nf") return;
    const { op, t } = e.data;
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      const p = vp.getVideoPlayerBySessionId(ids[ids.length - 1]);
      if (op === "seek") p.seek(Math.round(t * 1000));
      else if (op === "play") p.play();
      else if (op === "pause") p.pause();
    } catch (err) {
      window.postMessage({ __ws: "nf-fail", op, t }, "*");
    }
  });
})();
