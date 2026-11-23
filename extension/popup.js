const $ = id => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle("hidden", !on);
const bg = msg => chrome.runtime.sendMessage(Object.assign({ to: "bg" }, msg));
let tabId = null;

const LABELS = {
  connected: p => `Synced with ${p || "your partner"}`,
  waiting: () => "Waiting for someone to join…",
  asking: () => "Asking the host to let you in…",
  denied: () => "The host didn't let you in.",
  connecting: () => "Connecting…",
  "partner-offline": () => "Waiting for the host to come online…",
  reconnecting: () => "Reconnecting…",
  "party-full": () => "This party is full.",
};

function err(msg) { $("err").textContent = msg || ""; show($("err"), !!msg); }

async function render() {
  const s = await bg({ cmd: "status", tabId });
  show($("idle"), !s.party);
  show($("inParty"), !!s.party);
  if (!s.party) return;
  $("codeOut").textContent = s.party.code;
  $("codeHint").textContent = s.party.role === "host" ? "Send the invite link or this code to everyone joining" : "You joined party";
  $("stat").textContent = (LABELS[s.status] || (() => s.status))(s.partnerName);
  $("dot").className = "dot" + (s.status === "connected" ? " on" : "");
  show($("bind"), !s.isPartyTab);
  show($("ctrlRow"), s.party.role === "host");
  if (document.activeElement !== $("hostOnly")) $("hostOnly").checked = !!s.hostOnly;
  renderRequests(s.party.role === "host" ? s.requests || [] : []);
}

// People waiting for the host to let them in. Rebuilt only when the list changes, so a
// button is never swapped out from under a click.
let requestsKey = "";
function renderRequests(list) {
  const key = list.map(r => r.id).join("|");
  if (key === requestsKey) return;
  requestsKey = key;
  const box = $("requests");
  box.textContent = "";
  for (const r of list) {
    const row = document.createElement("div"); row.className = "req";
    const who = document.createElement("span"); who.textContent = `${r.name} wants to join`;
    const yes = document.createElement("button"); yes.className = "primary"; yes.textContent = "Allow";
    const no = document.createElement("button"); no.textContent = "Deny";
    yes.onclick = async () => { await bg({ cmd: "decide", id: r.id, allow: true }); render(); };
    no.onclick = async () => { await bg({ cmd: "decide", id: r.id, allow: false }); render(); };
    row.append(who, yes, no);
    box.append(row);
  }
  show(box, list.length > 0);
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  const { name } = await chrome.storage.local.get("name");
  $("name").value = name || "";
  await render();
  setInterval(render, 1000);
})();

$("name").addEventListener("change", () => chrome.storage.local.set({ name: $("name").value.trim() }));

$("start").onclick = async () => {
  err();
  const name = $("name").value.trim(); chrome.storage.local.set({ name });
  const r = await bg({ cmd: "start", tabId, name });
  if (!r.ok) err(r.error); render();
};
$("join").onclick = async () => {
  err();
  const code = $("code").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) return err("Codes are 6 characters.");
  const name = $("name").value.trim(); chrome.storage.local.set({ name });
  const r = await bg({ cmd: "join", tabId, code, name });
  if (!r.ok) err(r.error); render();
};
$("code").addEventListener("keydown", e => { if (e.key === "Enter") $("join").click(); });
$("bind").onclick = async () => { err(); const r = await bg({ cmd: "bindTab", tabId }); if (!r.ok) err(r.error); render(); };
$("copy").onclick = async () => { await navigator.clipboard.writeText($("codeOut").textContent); $("copy").textContent = "Copied"; setTimeout(() => $("copy").textContent = "Copy code", 1200); };
// The link opens the party page on the site: with Watch Sync installed it joins and opens this title, without it shows how to install.
$("invite").onclick = async () => {
  err();
  const r = await bg({ cmd: "invite" });
  if (!r || !r.ok) return err("Start or join a party first.");
  await navigator.clipboard.writeText(r.link);
  $("invite").textContent = "Copied"; setTimeout(() => $("invite").textContent = "Copy invite link", 1200);
};
$("hostOnly").onchange = async () => { await bg({ cmd: "setControl", hostOnly: $("hostOnly").checked }); render(); };
$("leave").onclick = async () => { await bg({ cmd: "leave" }); render(); };
