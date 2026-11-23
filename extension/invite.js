// Watch Sync — runs on the invite page (sync.html?join=CODE&to=PAGE on the site).
// Tells the page Watch Sync is installed, so it doesn't show the install steps, and asks the
// service worker to open the host's title in this tab and join the party there.

(() => {
  document.documentElement.dataset.watchsync = "1";
  const q = new URLSearchParams(location.search);
  if (!q.has("join")) return;
  const code = (q.get("join") || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);
  const say = t => { const el = document.getElementById("inviteText"); if (el) el.textContent = t; };
  say("Joining the party…");
  chrome.runtime.sendMessage({ to: "bg", cmd: "linkJoin", code, url: q.get("to") || "" })
    .then(r => say(r && r.ok ? `Opening ${r.site}… The host will let you in.` : (r && r.error) || "Couldn't join. Try the link again."))
    .catch(() => say("Couldn't reach Watch Sync. Reload this page to try again."));
})();
