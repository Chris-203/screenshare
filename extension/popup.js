const $ = id => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle("hidden", !on);
const bg = msg => chrome.runtime.sendMessage(Object.assign({ to: "bg" }, msg));
let tabId = null;

const LABELS = {
  connected: p => `Synced with ${p || "your partner"}`,
  waiting: () => "Waiting for your partner to join…",
  connecting: () => "Connecting…",
  "partner-offline": () => "Waiting for the host to come online…",
  reconnecting: () => "Reconnecting…",
};

function err(msg) { $("err").textContent = msg || ""; show($("err"), !!msg); }

async function render() {
  const s = await bg({ cmd: "status", tabId });
  show($("idle"), !s.party);
  show($("inParty"), !!s.party);
  if (!s.party) return;
  $("codeOut").textContent = s.party.code;
  $("codeHint").textContent = s.party.role === "host" ? "Send this code to your partner" : "You joined party";
  $("stat").textContent = (LABELS[s.status] || (() => s.status))(s.partnerName);
  $("dot").className = "dot" + (s.status === "connected" ? " on" : "");
  show($("bind"), !s.isPartyTab);
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
$("leave").onclick = async () => { await bg({ cmd: "leave" }); render(); };
