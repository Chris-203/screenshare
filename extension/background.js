// Watch Sync — service worker.
// Routes messages between the popup, the synced tab's content script, and the
// offscreen document that holds the peer-to-peer connection (it survives page
// reloads and navigation, unlike a content script).

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ALPHABET[b % ALPHABET.length]).join("");

async function getState() {
  const { ws } = await chrome.storage.session.get("ws");
  return ws || { party: null, tabId: null, status: "idle", partnerName: null };
}
async function setState(patch) {
  const s = Object.assign(await getState(), patch);
  await chrome.storage.session.set({ ws: s });
  return s;
}

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WEB_RTC"],
      justification: "Keeps the peer-to-peer connection used to sync playback with your partner.",
    });
  } catch (e) { if (!String(e).includes("single offscreen")) throw e; }
}
const toOffscreen = msg => chrome.runtime.sendMessage(Object.assign({ to: "off" }, msg)).catch(() => {});
const toTab = async (msg, tabId) => {
  const id = tabId ?? (await getState()).tabId;
  if (id == null) return false;
  try { await chrome.tabs.sendMessage(id, msg); return true; } catch { return false; }
};

async function activateTab(tabId) {
  const s = await getState();
  if (s.tabId != null && s.tabId !== tabId) await toTab({ type: "deactivate" }, s.tabId);
  await setState({ tabId });
  return toTab({ type: "activate", role: s.party.role, partnerName: s.partnerName, status: s.status }, tabId);
}

async function handle(m, sender) {
  if (m.to !== "bg") return;
  const s = await getState();

  switch (m.cmd || m.type) {
    // ---------- from popup
    case "status":
      return { ...s, isPartyTab: m.tabId != null && m.tabId === s.tabId };

    case "start":
    case "join": {
      const party = { code: m.cmd === "start" ? newCode() : m.code, role: m.cmd === "start" ? "host" : "guest", name: m.name || (m.cmd === "start" ? "Chris" : "Partner") };
      await setState({ party, status: "connecting", partnerName: null });
      const ok = await activateTab(m.tabId);
      if (!ok) { await setState({ party: null, tabId: null, status: "idle" }); return { ok: false, error: "Open Netflix, Disney+, Max, Hulu, Prime Video or another supported site in this tab first, then try again." }; }
      await ensureOffscreen();
      await toOffscreen({ cmd: "open", party });
      return { ok: true, party };
    }

    case "bindTab": {
      const ok = await activateTab(m.tabId);
      return ok ? { ok: true } : { ok: false, error: "This tab isn't a supported streaming site." };
    }

    case "leave":
      await toOffscreen({ cmd: "close" });
      await toTab({ type: "deactivate" });
      await setState({ party: null, tabId: null, status: "idle", partnerName: null });
      try { await chrome.offscreen.closeDocument(); } catch {}
      return { ok: true };

    // ---------- from content scripts
    case "hello": {
      const active = !!s.party && sender.tab && sender.tab.id === s.tabId;
      return active ? { active, role: s.party.role, partnerName: s.partnerName, status: s.status } : { active: false };
    }
    case "send":
      if (!s.party || !sender.tab || sender.tab.id !== s.tabId) return;
      await ensureOffscreen();
      await toOffscreen({ cmd: "send", msg: m.msg });
      return;

    // ---------- from offscreen
    case "offReady":
      return { party: s.party };
    case "peerStatus": {
      const patch = { status: m.status };
      if (m.partnerName) patch.partnerName = m.partnerName;
      const ns = await setState(patch);
      await toTab({ type: "status", status: ns.status, partnerName: ns.partnerName });
      chrome.action.setBadgeText({ text: ns.status === "connected" ? "ON" : ns.party ? "…" : "" });
      chrome.action.setBadgeBackgroundColor({ color: ns.status === "connected" ? "#10b981" : "#6b7280" });
      return;
    }
    case "peerMsg":
      await toTab({ type: "peer", msg: m.msg });
      return;
  }
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || m.to !== "bg") return;
  handle(m, sender).then(reply, e => reply({ ok: false, error: String(e) }));
  return true;
});

// If the synced tab is closed, keep the party but forget the tab.
chrome.tabs.onRemoved.addListener(async id => { const s = await getState(); if (s.tabId === id) await setState({ tabId: null }); });

// Browser restarted with a party still saved (session storage is cleared on restart, so this is just a safety net).
chrome.runtime.onStartup.addListener(async () => { const s = await getState(); if (s.party) { await ensureOffscreen(); toOffscreen({ cmd: "open", party: s.party }); } });
