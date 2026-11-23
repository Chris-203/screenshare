// Watch Sync — asks Chrome for the camera and mic once, from the extension's own page.
// Inside a streaming site the video chat frame can't always show Chrome's question itself,
// but once the extension is allowed here, the frame is allowed too. Nothing is kept running.

const $ = id => document.getElementById(id);

async function ask() {
  const got = [];
  for (const c of [{ video: true }, { audio: true }]) {
    try { (await navigator.mediaDevices.getUserMedia(c)).getTracks().forEach(t => { got.push(t.kind); t.stop(); }); } catch {}
  }
  if (!got.length) { $("msg").textContent = "Chrome didn't allow it. Click the camera icon in the address bar, pick Allow, then try again."; return; }
  $("msg").textContent = got.length === 2 ? "Done. You can go back to your show." : got[0] === "video" ? "Camera allowed (no mic found). You can go back to your show." : "Mic allowed (no camera found). You can go back to your show.";
  $("go").hidden = true;
  chrome.storage.session.set({ vcAllowed: Date.now() }).catch(() => {});
  setTimeout(() => chrome.tabs.getCurrent(t => t ? chrome.tabs.remove(t.id) : window.close()), 1500);
}
$("go").onclick = ask;
ask();
