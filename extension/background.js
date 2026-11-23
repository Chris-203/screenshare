// Watch Sync — service worker.
// Routes messages between the popup, the synced tab's content script, and the
// offscreen document that holds the peer-to-peer connection (it survives page
// reloads and navigation, unlike a content script).

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ALPHABET[b % ALPHABET.length]).join("");

// Messages arrive concurrently (popup polling, content-script ticks, peer status), and every
// handler awaits. A queue runs its jobs strictly one after another, so a read-modify-write of
// the saved state can't interleave with another one and drop its patch.
const makeQueue = () => {
  let tail = Promise.resolve();
  return job => { const run = tail.then(job); tail = run.catch(() => {}); return run; };
};
const stateQueue = makeQueue();
const commandQueue = makeQueue();
const COMMANDS = new Set(["start", "join", "bindTab", "leave", "linkJoin"]);
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(36).padStart(2, "0")).join("");

// `requests` is the host's list of people waiting for Allow / Deny: [{ id, name }].
// `hostOnly`: the host keeps play, pause, skip and changing titles to themselves.
// `pendingJoin`: an invite link was opened in this tab; join once the show's page there says hello.
const IDLE = { party: null, tabId: null, status: "idle", partnerName: null, requests: [], hostOnly: false, pendingJoin: null };
async function readState() {
  const { ws } = await chrome.storage.session.get("ws");
  return ws || { ...IDLE };
}
// getState waits for writes that were requested before it, so it never returns a stale snapshot.
const getState = () => stateQueue(readState);
// `patch` is an object, or a function of the current state that returns a patch (or null for
// no change) when the decision has to be made against the state at the moment of writing.
const setState = patch => stateQueue(async () => {
  const s = await readState();
  const p = typeof patch === "function" ? patch(s) : patch;
  if (!p) return s;
  Object.assign(s, p);
  await chrome.storage.session.set({ ws: s });
  return s;
});

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WEB_RTC"],
      justification: "Keeps the peer-to-peer connections used to sync playback with your party.",
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
  if (!s.party) return false;
  if (s.tabId != null && s.tabId !== tabId) await toTab({ type: "deactivate" }, s.tabId);
  await setState({ tabId });
  return toTab({ type: "activate", role: s.party.role, partnerName: s.partnerName, status: s.status, requests: s.requests || [], hostOnly: !!s.hostOnly }, tabId);
}

// ------------------------------------------------------------ invite links
// The host copies a link to sync.html on the site. Opened by someone who has the extension, invite.js
// there hands the code and the host's page to us; we open that page in the same tab and join once the
// show's page loads. Someone without the extension just sees the install steps on that page.
const INVITE_PAGE = "https://chris-203.github.io/screenshare/sync.html";
// Hosts content.js runs on, from manifest.json, so a link can only ever open a supported streaming site.
const SITES = (() => {
  const out = [];
  for (const cs of chrome.runtime.getManifest().content_scripts || []) {
    if (!(cs.js || []).includes("content.js")) continue;
    for (const pat of cs.matches || []) { const mm = /^[^:]+:\/\/(\*\.)?([a-z0-9.-]+)\//i.exec(pat); if (mm) out.push({ base: mm[2].toLowerCase(), sub: !!mm[1] }); }
  }
  return out;
})();
function siteUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let u; try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  return SITES.some(e => h === e.base || (e.sub && h.endsWith("." + e.base))) ? u : null;
}
const cleanCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
async function savedName() { try { return (await chrome.storage.local.get("name")).name || ""; } catch { return ""; } }
async function inviteLink(s) {
  let page = null;
  if (s.tabId != null) { try { const r = await chrome.tabs.sendMessage(s.tabId, { type: "where" }); page = r && siteUrl(r.url); } catch {} }
  return `${INVITE_PAGE}?join=${s.party.code}` + (page ? `&to=${encodeURIComponent(page.href)}` : "");
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
      // `id` makes each guest's peer ID its own, so several guests can be in one party.
      const party = { code: m.cmd === "start" ? newCode() : m.code, role: m.cmd === "start" ? "host" : "guest", name: m.name || (m.cmd === "start" ? "Chris" : "Partner"), id: newId() };
      await setState({ party, status: "connecting", partnerName: null, requests: [], hostOnly: false });
      const ok = await activateTab(m.tabId);
      if (!ok) { await setState({ party: null, tabId: null, status: "idle" }); return { ok: false, error: "Open Netflix, Disney+, Max, Hulu, Prime Video or another supported site in this tab first, then try again." }; }
      await ensureOffscreen();
      await toOffscreen({ cmd: "open", party });
      return { ok: true, party };
    }

    case "bindTab": {
      if (!s.party) return { ok: false, error: "There's no party to move. Start or join one first." };
      const ok = await activateTab(m.tabId);
      return ok ? { ok: true } : { ok: false, error: "This tab isn't a supported streaming site." };
    }

    case "leave":
      await toOffscreen({ cmd: "close" });
      await toTab({ type: "deactivate" });
      await setState({ party: null, tabId: null, status: "idle", partnerName: null, requests: [], hostOnly: false, pendingJoin: null });
      try { await chrome.offscreen.closeDocument(); } catch {}
      chrome.action.setBadgeText({ text: "" });
      return { ok: true };

    case "invite":
      if (!s.party) return { ok: false };
      return { ok: true, link: await inviteLink(s) };

    // ---------- from invite.js on the invite page
    case "linkJoin": {
      if (!sender.tab || !sender.url || !sender.url.startsWith(INVITE_PAGE)) return { ok: false };
      const code = cleanCode(m.code), page = siteUrl(m.url);
      if (code.length !== 6) return { ok: false, error: "This invite link is broken. Ask for a new one." };
      if (s.party && s.party.code === code && s.party.role === "host") return { ok: false, error: "That's the link to your own party. Send it to the people joining." };
      if (!page) return { ok: false, error: `Open the show, then click the Watch Sync button and join with the code ${code}.` };
      // Opening someone's link means "put me in that party", so a different party you're in ends first.
      if (s.party && s.party.code !== code) await handle({ to: "bg", cmd: "leave" }, {});
      await setState({ pendingJoin: { tabId: sender.tab.id, code, at: Date.now() } });
      await chrome.tabs.update(sender.tab.id, { url: page.href });
      return { ok: true, site: page.hostname.replace(/^www\./, "") };
    }

    // ---------- from the popup or the synced tab: the host's answer to someone asking to join
    case "decide":
      if (!s.party || s.party.role !== "host" || typeof m.id !== "string") return { ok: false };
      if (sender.tab && sender.tab.id !== s.tabId) return { ok: false };
      await toOffscreen({ cmd: "decide", id: m.id, allow: !!m.allow });
      return { ok: true };

    // ---------- from the popup: who may control playback
    case "setControl": {
      if (!s.party || s.party.role !== "host") return { ok: false };
      const hostOnly = !!m.hostOnly;
      await setState({ hostOnly });
      await toTab({ type: "control", hostOnly });
      return { ok: true };
    }

    // ---------- from content scripts
    case "hello": {
      const pj = s.pendingJoin;
      if (pj && sender.tab && sender.tab.id === pj.tabId) {
        await setState({ pendingJoin: null });
        if (Date.now() - pj.at < 120000) {
          // Joining activates this tab itself, so this page doesn't activate twice.
          const tabId = sender.tab.id, name = await savedName();
          if (s.party && s.party.code === pj.code) commandQueue(() => handle({ to: "bg", cmd: "bindTab", tabId }, {}));
          else commandQueue(() => handle({ to: "bg", cmd: "join", tabId, code: pj.code, name }, {}));
          return { active: false };
        }
      }
      const active = !!s.party && sender.tab && sender.tab.id === s.tabId;
      return active ? { active, role: s.party.role, partnerName: s.partnerName, status: s.status, requests: s.requests || [], hostOnly: !!s.hostOnly } : { active: false };
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
      if (Array.isArray(m.requests)) patch.requests = m.requests;
      // A status that lands after "leave" must not bring a finished party back to life.
      const ns = await setState(cur => cur.party ? patch : null);
      const asking = ns.party ? (ns.requests || []).length : 0;
      await toTab({ type: "status", status: ns.status, partnerName: ns.partnerName, requests: ns.requests || [], joined: m.joined });
      // "?" means someone is waiting for the host to press Allow or Deny.
      chrome.action.setBadgeText({ text: asking ? "?" : ns.status === "connected" ? "ON" : ns.party ? "…" : "" });
      chrome.action.setBadgeBackgroundColor({ color: asking ? "#a78bfa" : ns.status === "connected" ? "#10b981" : "#6b7280" });
      return;
    }
    case "peerMsg":
      await toTab({ type: "peer", msg: m.msg });
      return;
  }
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || m.to !== "bg") return;
  // Popup commands each make several state changes, so they also run one at a time: a
  // double-clicked Start, or Leave during a Join, finishes one before the next begins.
  const run = () => handle(m, sender);
  (COMMANDS.has(m.cmd) ? commandQueue(run) : run()).then(reply, e => reply({ ok: false, error: String(e) }));
  return true;
});

// If the synced tab is closed, keep the party but forget the tab.
chrome.tabs.onRemoved.addListener(id => { setState(s => s.tabId === id ? { tabId: null } : null); });

// Browser restarted with a party still saved (session storage is cleared on restart, so this is just a safety net).
chrome.runtime.onStartup.addListener(async () => { const s = await getState(); if (s.party) { await ensureOffscreen(); toOffscreen({ cmd: "open", party: s.party }); } });
