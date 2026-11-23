#!/usr/bin/env node
// Sync drift tests. Two separate headless Chromium browsers play the same test video,
// one as host and one as viewer, and the run fails if their playback positions end up
// further apart than the limits below.
//
//   cd .github/sync-tests && npm ci && npx playwright install chromium
//   node run.mjs                 both suites
//   node run.mjs party           only the watch party page (party.html)
//   node run.mjs extension       only the Watch Sync extension
//   node run.mjs party --fault   drops sync messages on purpose; must exit 1
//
// What is real: party.html and every extension script, unmodified, in real browsers
// playing a real video. What is replaced: PeerJS, by fake-peer.js, which carries the same
// messages through a small hub in this file with added latency and jitter. So this checks
// the sync logic, not WebRTC or the public PeerJS broker.
//
// Exit codes: 0 in sync, 1 drift over a limit, 2 the test itself broke.

import { createServer } from "node:http";
import { appendFileSync, cpSync, createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const num = (name, def) => (process.env[name] ? Number(process.env[name]) : def);

// ---------------------------------------------------------------- limits (milliseconds)
// While playing, the worst sample in each measuring window must stay under these.
// party.html nudges playback speed until it is within 25 ms and seeks past 400 ms.
// The extension only corrects with seeks (over 600 ms on play, over 1200 ms on a heartbeat),
// so its limit is looser. Paused limits match each tool's own snap distance.
const LIMITS = {
  party: { playing: num("SYNC_PARTY_PLAYING_MS", 150), paused: num("SYNC_PARTY_PAUSED_MS", 300) },
  extension: { playing: num("SYNC_EXT_PLAYING_MS", 500), paused: num("SYNC_EXT_PAUSED_MS", 650) },
};
// Simulated network, each way: fixed delay plus random jitter, delivered in order.
const NET = { delay: num("SYNC_NET_DELAY_MS", 60), jitter: num("SYNC_NET_JITTER_MS", 40) };
// The viewer's wall clock is set this far ahead of the host's, so the ping/pong clock
// estimate has real work to do (page tests only; an extension's clock can't be faked).
const CLOCK_SKEW = num("SYNC_CLOCK_SKEW_MS", 4321);

const args = process.argv.slice(2);
const fault = args.includes("--fault");
const suites = args.filter(a => !a.startsWith("--"));
const want = name => !suites.length || suites.includes(name);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
class DriftError extends Error {}

// ---------------------------------------------------------------- hub (stands in for the broker and the data channel)
function startHub() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const peers = new Map();   // id -> socket
  const conns = new Map();   // cid -> { a, b } sockets
  const hub = { dropSync: false, dropped: 0, port: 0, close: () => new Promise(r => { wss.clients.forEach(c => c.terminate()); wss.close(r); }) };
  const tx = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  // Delayed, but never reordered: a reliable data channel keeps order too.
  const later = (ws, msg) => {
    const at = Math.max(ws.nextAt || 0, Date.now() + NET.delay + Math.random() * NET.jitter);
    ws.nextAt = at;
    setTimeout(() => tx(ws, msg), at - Date.now());
  };
  const SYNC_TYPES = new Set(["state", "cmd", "tick", "play", "pause", "seek"]);
  wss.on("connection", ws => {
    ws.on("message", raw => {
      const m = JSON.parse(raw);
      if (m.op === "register") {
        const id = m.id || `anon-${Math.random().toString(36).slice(2)}`;
        if (peers.has(id)) return tx(ws, { op: "error", type: "unavailable-id" });
        ws.peerId = id; peers.set(id, ws);
        tx(ws, { op: "open", id });
      } else if (m.op === "connect") {
        const target = peers.get(m.to);
        if (!target) return later(ws, { op: "error", type: "peer-unavailable" });
        conns.set(m.cid, { a: ws, b: target });
        later(target, { op: "incoming", cid: m.cid, from: ws.peerId });
        later(target, { op: "connopen", cid: m.cid });
        later(ws, { op: "connopen", cid: m.cid });
      } else if (m.op === "data" || m.op === "close") {
        const c = conns.get(m.cid); if (!c) return;
        const other = c.a === ws ? c.b : c.a;
        if (m.op === "close") { conns.delete(m.cid); return later(other, { op: "close", cid: m.cid }); }
        if (hub.dropSync && m.payload && SYNC_TYPES.has(m.payload.type)) { hub.dropped++; return; }
        later(other, { op: "data", cid: m.cid, payload: m.payload });
      }
    });
    ws.on("close", () => {
      if (ws.peerId && peers.get(ws.peerId) === ws) peers.delete(ws.peerId);
      for (const [cid, c] of conns) if (c.a === ws || c.b === ws) { conns.delete(cid); later(c.a === ws ? c.b : c.a, { op: "close", cid }); }
    });
  });
  return new Promise(res => wss.on("listening", () => { hub.port = wss.address().port; res(hub); }));
}

// ---------------------------------------------------------------- static server for the repo, with Range (seeking needs it)
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".webm": "video/webm", ".zip": "application/zip" };
const fakePeerSource = hubPort => `self.__SYNC_TEST_HUB = "ws://127.0.0.1:${hubPort}";\n` + readFileSync(join(here, "fake-peer.js"), "utf8");
function startServer(hubPort) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/extension/peerjs.min.js") { res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" }); return res.end(fakePeerSource(hubPort)); }
    const file = path === "/__sync-test/sample.webm" ? join(here, "sample.webm") : normalize(join(root, path === "/" ? "index.html" : path));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end("not found"); }
    const size = statSync(file).size;
    const head = { "content-type": TYPES[extname(file)] || "application/octet-stream", "accept-ranges": "bytes", "cache-control": "no-store", "access-control-allow-origin": "*" };
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (r && (r[1] || r[2])) {
      const start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
      const end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
      if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { ...head, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, "content-length": size });
    createReadStream(file).pipe(res);
  });
  return new Promise(res => server.listen(0, "127.0.0.1", () => res({ port: server.address().port, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) })));
}

// ---------------------------------------------------------------- measuring
// Each browser reports its own position together with its own high-resolution wall time,
// so the two samples don't have to be taken at exactly the same instant.
const probe = page => page.evaluate(() => {
  const v = [...document.querySelectorAll("video")].find(x => x.currentSrc && !x.classList.contains("hidden"));
  return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState, at: performance.timeOrigin + performance.now() } : null;
});
const onVideo = (page, fn, arg) => page.evaluate(([src, a]) => {
  const v = [...document.querySelectorAll("video")].find(x => x.currentSrc && !x.classList.contains("hidden"));
  return new Function("v", "a", `return (${src})(v, a)`)(v, a);
}, [fn.toString(), arg]);

function record(suite, step, kind, worst, limit, ok, note = "") {
  results.push({ suite, step, kind, worst, limit, ok, note });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${step.padEnd(44)} ${kind.padEnd(8)} worst ${(isFinite(worst) ? Math.round(worst) + " ms" : "n/a").padStart(8)}   limit ${limit} ms${note ? "   " + note : ""}`);
  // With --fault one failure is the whole point; the steps after it would only time out.
  if (fault && !ok) throw new DriftError(step);
}
// A yes/no check that isn't a drift measurement.
function check(suite, step, ok, note = "") {
  results.push({ suite, step, kind: "check", worst: NaN, limit: null, ok, note });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${step.padEnd(44)} check${note ? "    " + note : ""}`);
  if (fault && !ok) throw new DriftError(step);
}

// Both playing: after `settle`, sample for `window` and compare positions.
async function expectPlayingInSync(suite, step, host, viewer, { settle = 4000, window = 6000 } = {}) {
  const limit = LIMITS[suite].playing;
  await sleep(settle);
  const drifts = []; let first = null, last = null, stuck = 0;
  const end = Date.now() + window;
  while (Date.now() < end) {
    const [h, v] = await Promise.all([probe(host), probe(viewer)]);
    if (!h || !v || h.paused || v.paused) stuck++;
    else { drifts.push((v.t - h.t) * 1000 - (v.at - h.at)); first ||= h; last = h; }
    await sleep(250);
  }
  const worst = drifts.reduce((m, d) => Math.max(m, Math.abs(d)), 0);
  const mean = drifts.length ? drifts.reduce((s, d) => s + d, 0) / drifts.length : 0;
  const advanced = first && last ? (last.t - first.t) / ((last.at - first.at) / 1000 || 1) : 0;
  let note = `mean ${mean >= 0 ? "+" : ""}${Math.round(mean)} ms, ${drifts.length} samples`;
  let ok = worst <= limit;
  if (stuck > 0) { ok = false; note = `${stuck} samples with a browser not playing`; }
  else if (advanced < 0.8 || advanced > 1.2) { ok = false; note = `host video advanced at ${advanced.toFixed(2)}x, expected 1x`; }
  record(suite, step, "playing", stuck ? Infinity : worst, limit, ok, note);
}

// Both paused on the same spot.
async function expectPausedInSync(suite, step, host, viewer, { settle = 2500 } = {}) {
  const limit = LIMITS[suite].paused;
  await sleep(settle);
  const [h, v] = await Promise.all([probe(host), probe(viewer)]);
  const bothPaused = h && v && h.paused && v.paused;
  const worst = bothPaused ? Math.abs(v.t - h.t) * 1000 : Infinity;
  record(suite, step, "paused", worst, limit, bothPaused && worst <= limit, bothPaused ? `at ${h.t.toFixed(2)} s` : "a browser is still playing");
}

async function until(what, fn, timeout = 20000) {
  const end = Date.now() + timeout; let lastErr;
  while (Date.now() < end) {
    try { const r = await fn(); if (r) return r; } catch (e) { lastErr = e; }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? ": " + lastErr.message : ""}`);
}
const hasVideo = page => until("a loaded video", async () => { const p = await probe(page); return p && p.ready >= 2; });

// The steps both suites share once host and viewer are connected and paused at the start.
async function scenario(suite, host, viewer, hub, labels) {
  await onVideo(host, v => v.play());
  await expectPlayingInSync(suite, `${labels.host} presses play`, host, viewer);

  if (fault) { hub.dropSync = true; console.log("  --fault: the hub now drops every sync message"); }

  await onVideo(host, v => { v.currentTime = 60; });
  await expectPlayingInSync(suite, `${labels.host} skips to 1:00 while playing`, host, viewer, { settle: 3500 });

  await onVideo(viewer, v => { v.currentTime = 20; });
  await expectPlayingInSync(suite, `${labels.viewer} skips back to 0:20`, host, viewer, { settle: 3500 });

  await onVideo(host, v => v.pause());
  await expectPausedInSync(suite, `${labels.host} pauses`, host, viewer);

  await onVideo(viewer, v => v.play());
  await expectPlayingInSync(suite, `${labels.viewer} presses play`, host, viewer, { settle: 3500 });

  await onVideo(viewer, v => v.pause());
  await expectPausedInSync(suite, `${labels.viewer} pauses`, host, viewer);

  await onVideo(host, v => { v.currentTime = 100; });
  await expectPausedInSync(suite, `${labels.host} skips to 1:40 while paused`, host, viewer);

  await onVideo(host, v => v.play());
  await expectPlayingInSync(suite, `${labels.host} presses play again`, host, viewer, { settle: 3500 });
}

const LAUNCH_ARGS = ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];
// Chromium's built-in test camera and mic, allowed without asking. Only the extension suite uses them.
const MEDIA_ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--disable-features=WebRtcHideLocalIpsWithMdns"];
const watchErrors = (page, who) => page.on("pageerror", e => console.log(`  [${who} page error] ${e.message}`));

// ---------------------------------------------------------------- suite: party.html
async function partySuite(hub, web) {
  console.log(`\nWatch party page (party.html), video link mode. Network ${NET.delay}-${NET.delay + NET.jitter} ms each way, viewer clock ${CLOCK_SKEW} ms ahead.`);
  const base = `http://127.0.0.1:${web.port}`;
  const browsers = await Promise.all([chromium.launch({ args: LAUNCH_ARGS }), chromium.launch({ args: LAUNCH_ARGS })]);
  try {
    const host = await browsers[0].newPage(); watchErrors(host, "host");
    const viewerCtx = await browsers[1].newContext();
    await viewerCtx.addInitScript(skew => { const real = Date.now.bind(Date); Date.now = () => real() + skew; }, CLOCK_SKEW);
    const viewer = await viewerCtx.newPage(); watchErrors(viewer, "viewer");

    await host.goto(`${base}/party.html?host`);
    const code = await until("the party code", () => host.textContent("#codeLabel"));
    await host.click('#tabs button[data-tab="url"]');
    await host.fill("#urlInput", `${base}/__sync-test/sample.webm`);
    await host.press("#urlInput", "Enter");
    await hasVideo(host);

    const join = async () => {
      await viewer.goto(`${base}/party.html?r=${code}`);
      await viewer.fill("#nameInput", "Tester");
      await viewer.press("#nameInput", "Enter");
      await host.click("#requests button.primary");   // Allow
      await hasVideo(viewer);
    };
    await join();
    await expectPausedInSync("party", "Viewer joins before anything plays", host, viewer);
    await scenario("party", host, viewer, hub, { host: "Host", viewer: "Viewer" });

    // Joining a party that is already playing.
    await join();
    await expectPlayingInSync("party", "Viewer reloads and rejoins mid-playback", host, viewer, { settle: 5000 });

    await hostOnly("party", "Viewer", host, viewer, on => on ? host.check("#ctrlOpt") : host.uncheck("#ctrlOpt"));

    // Chat: names, avatars, "is typing…" and the unread count, both ways.
    const dom = page => fn => page.evaluate(fn);
    await chatChecks("party", dom(host), dom(viewer), { host: "Chris", viewer: "Tester" });
  } finally {
    await Promise.all(browsers.map(b => b.close().catch(() => {})));
  }
}

// ---------------------------------------------------------------- suite: the extension
// Loads a copy of extension/ whose only difference is peerjs.min.js (the fake). The streaming
// site is a stand-in page answered locally for a youtube.com address, so the content script
// runs on it exactly as it would on the real site.
async function extensionSuite(hub, web) {
  console.log(`\nWatch Sync extension. Network ${NET.delay}-${NET.delay + NET.jitter} ms each way.`);
  const work = mkdtempSync(join(tmpdir(), "sync-tests-"));
  const ext = join(work, "extension");
  cpSync(join(root, "extension"), ext, { recursive: true });
  writeFileSync(join(ext, "peerjs.min.js"), fakePeerSource(hub.port));
  const SITE = "https://www.youtube.com/watch?v=sync-test";
  const html = `<!doctype html><meta charset="utf-8"><title>Sync test video</title><body style="margin:0;background:#000">
    <div id="movie_player" class="html5-video-player"><video src="/sample.webm" width="640" height="360" controls preload="auto"></video></div>`;
  // The video is answered here too (with Range, so seeking works) because Chromium asks for a
  // permission before a public https page may load anything from 127.0.0.1.
  const sample = readFileSync(join(here, "sample.webm"));
  const serve = route => {
    const req = route.request();
    if (new URL(req.url()).pathname !== "/sample.webm") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers().range || "");
    const start = r ? Number(r[1]) : 0, end = r && r[2] ? Math.min(Number(r[2]), sample.length - 1) : sample.length - 1;
    const headers = { "accept-ranges": "bytes", "cache-control": "no-store" };
    if (r) headers["content-range"] = `bytes ${start}-${end}/${sample.length}`;
    return route.fulfill({ status: r ? 206 : 200, contentType: "video/webm", headers, body: sample.subarray(start, end + 1) });
  };

  const open = async name => {
    // The invite page is answered locally too, from this repo's sync.html.
    const ctx = await chromium.launchPersistentContext(join(work, name), {
      channel: "chromium", headless: true,
      args: [...LAUNCH_ARGS, ...MEDIA_ARGS, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    await ctx.route("https://www.youtube.com/**", serve);
    await ctx.route("https://chris-203.github.io/**", serveInvite);
    const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 });
    const id = new URL(worker.url()).host;
    const page = ctx.pages()[0] || await ctx.newPage(); watchErrors(page, name);
    await page.goto(SITE);
    await hasVideo(page);
    // Stand in for the popup: an extension page that sends the popup's own commands for the video tab.
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const bg = cmd => popup.evaluate(async c => {
      const me = await chrome.tabs.getCurrent();
      const tab = (await chrome.tabs.query({})).find(t => t.id !== me.id);
      return chrome.runtime.sendMessage({ to: "bg", ...c, tabId: tab.id });
    }, cmd);
    // A command sent from a fresh popup page, for after the first one is closed.
    const once = async c => { const p = await ctx.newPage(); await p.goto(`chrome-extension://${id}/popup.html`); const r = await p.evaluate(c => chrome.runtime.sendMessage({ to: "bg", ...c }), c); await p.close(); return r; };
    return { ctx, page, popup, bg, worker, once, id };
  };

  const sides = [];
  try {
    const host = await open("host"); sides.push(host);
    const guest = await open("guest"); sides.push(guest);
    // The host starts with a saved room name, so the code (and the invite link) is the room's.
    const started = await until("the host to start a party", async () => { const r = await host.bg({ cmd: "start", name: "Host", room: "movie night" }); return r && r.ok && r; });
    check("extension", "Saved room name becomes the party code", started.party.code === "MOVIE-NIGHT", started.party.code);
    await until("the guest to join", async () => { const r = await guest.bg({ cmd: "join", code: started.party.code, name: "Guest" }); return r && r.ok; });
    // The host has to let the guest in. The real Allow buttons are in the popup and in the tab's
    // closed shadow root, and the service worker only takes that answer from those two places,
    // so the worker hands the answer to the offscreen document here the way it does for them.
    const asking = await until("the guest's request to reach the host", async () => { const r = (await host.bg({ cmd: "status" })).requests; return r && r.length && r; });
    await host.worker.evaluate(id => chrome.runtime.sendMessage({ to: "off", cmd: "decide", id, allow: true }), asking[0].id);
    for (const s of sides) await until("both sides to connect", async () => (await s.bg({ cmd: "status" })).status === "connected");
    for (const s of sides) { await s.popup.close(); }
    await sleep(2500);   // clock samples and the first forced heartbeat

    await expectPausedInSync("extension", "Guest joins before anything plays", host.page, guest.page, { settle: 500 });
    await scenario("extension", host.page, guest.page, hub, { host: "Host", viewer: "Guest" });

    // Ad breaks. The stand-in page marks an ad the way YouTube does (ad-showing on the player), and the
    // video keeps playing as the ad would. The other side has to wait, and both pick up together after.
    await adBreak("Guest", guest.page, host.page, guest.page);
    await adBreak("Host", host.page, host.page, guest.page);

    // Next episode: the host moves to another video and starts it; the guest follows by itself.
    const next = SITE.replace("sync-test", "sync-test-2");
    await host.page.goto(next);
    await hasVideo(host.page);
    await onVideo(host.page, v => v.play());
    let followed = true;
    try { await until("the guest to follow the host", async () => guest.page.url() === next, 20000); } catch { followed = false; }
    check("extension", "Host starts the next episode, guest follows", followed, followed ? "" : `guest stayed on ${guest.page.url()}`);
    if (followed) {
      await hasVideo(guest.page);
      await expectPlayingInSync("extension", "Both play the next episode together", host.page, guest.page, { settle: 5000 });
    }

    // Buffering: a video that's playing but stuck (playback rate 0 stands in for a stalled stream) makes
    // the other side pause until it's moving again, then both carry on together.
    if (followed) {
      await bufferHold("Guest", guest.page, host.page, guest.page);
      await bufferHold("Host", host.page, host.page, guest.page);
      await slowGuestPlays(host.page, guest.page);
      await adInOwnPlayer(host.page, guest.page);
    }

    await hostOnly("extension", "Guest", host.page, guest.page, on => host.once({ cmd: "setControl", hostOnly: on }));

    // Chat: the same checks through the extension's on-page panel, plus a rename reaching the host's party list.
    await chatChecks("extension", await shadow(host.page), await shadow(guest.page), { host: "Host", viewer: "Guest" },
      async () => (await host.once({ cmd: "status" })).partnerName);

    await videoChat(host, guest);

    // Invite link: the guest leaves, the host moves on to another title and copies the link,
    // and the guest opening it lands on that title and joins by itself.
    await guest.once({ cmd: "leave" });
    const third = SITE.replace("sync-test", "sync-test-3");
    await host.page.goto(third);
    await hasVideo(host.page);
    await onVideo(host.page, v => v.play());
    await sleep(1500);
    const invite = await host.once({ cmd: "invite" });
    const link = invite && invite.ok ? invite.link : "";
    check("extension", "Invite link carries the code and the title", link.startsWith(INVITE_PAGE + "?join=" + started.party.code) && link.includes("&to=" + encodeURIComponent(third)), link || "no link");
    // Someone without Watch Sync gets the install steps instead.
    const plain = await chromium.launch({ args: LAUNCH_ARGS });
    try {
      const p = await plain.newPage();
      await p.route("https://chris-203.github.io/**", serveInvite);
      await p.goto(link);
      await sleep(3200);
      const text = await p.textContent("#inviteText");
      check("extension", "Without Watch Sync the link shows install steps", /Install Watch Sync first/.test(text) && text.includes(started.party.code), text);
    } finally { await plain.close(); }
    await guest.page.goto(link);
    let landed = true;
    try { await until("the guest to land on the host's title", async () => guest.page.url() === third, 20000); } catch { landed = false; }
    check("extension", "Opening the link opens the host's title", landed, landed ? "" : `guest is on ${guest.page.url()}`);
    if (landed) {
      await hasVideo(guest.page);
      const asking2 = await until("the link guest's request to reach the host", async () => { const r = (await host.once({ cmd: "status" })).requests; return r && r.length && r; });
      await host.worker.evaluate(id => chrome.runtime.sendMessage({ to: "off", cmd: "decide", id, allow: true }), asking2[0].id);
      await until("the link guest to connect", async () => (await guest.once({ cmd: "status" })).status === "connected");
      await expectPlayingInSync("extension", "Guest joins from the invite link mid-playback", host.page, guest.page, { settle: 5000 });
    }
  } finally {
    await Promise.all(sides.map(s => s.ctx.close().catch(() => {})));
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- chat
// Runs a function against the extension's closed shadow root. Page scripts can't reach it, so this
// goes through the DevTools protocol, which can. `fn` gets an object with the same $ (by id) as content.js.
async function shadow(page) {
  const cdp = await page.context().newCDPSession(page);
  return async fn => {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const find = n => { if (!n) return null; for (const r of n.shadowRoots || []) if (r.shadowRootType === "closed") return r; for (const c of n.children || []) { const f = find(c); if (f) return f; } return null; };
    const sr = find(root);
    if (!sr) throw new Error("no Watch Sync panel on the page");
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: sr.backendNodeId });
    const src = `function () { const document = { getElementById: id => this.getElementById(id) }; return (${fn.toString()})(); }`;
    const r = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: src, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
}

// The same chat checks for the page and the extension. Element ids differ, so each step looks both up.
// `run(page)(fn)` runs fn where `document.getElementById` finds that tool's chat elements.
async function chatChecks(suite, host, viewer, names, partnerName) {
  const ui = () => {
    const $ = id => document.getElementById(id);
    const pick = (...ids) => ids.map($).find(Boolean);
    return {
      input: pick("chatInput", "cin"), form: pick("chatForm", "cform"), log: pick("chatLog", "log"), typing: $("typing"),
      badge: pick("chatBadge", "badge"), profBtn: pick("profBtn", "pbtn"), profName: pick("profName", "pname"), avs: $("avs"), close: pick("chatClose", "cclose"),
    };
  };
  const helpers = `const U = (${ui.toString()})();
    const visible = el => !!el && !el.hidden && !el.classList.contains("hidden");
    const last = () => { const r = U.log.lastElementChild; return r ? { who: r.querySelector(".who").textContent, av: r.querySelector(".av").textContent, txt: r.querySelector(".txt").textContent } : null; };`;
  const on = (side, body) => side(new Function(`${helpers} ${body}`));
  const type = (side, text) => on(side, `U.input.value = ${JSON.stringify(text)}; U.input.dispatchEvent(new Event("input", { bubbles: true }));`);
  const submit = side => on(side, `U.form.requestSubmit();`);
  const typingText = side => on(side, `return visible(U.typing) ? U.typing.textContent : "";`);
  const badge = side => on(side, `return visible(U.badge) ? U.badge.textContent : "";`);
  const lastMsg = side => on(side, `return last();`);
  const soft = async (what, fn, ms = 8000) => { try { return await until(what, fn, ms); } catch { return null; } };

  // Both chats closed. The viewer picks the fox picture, starts typing, then sends.
  await on(host, `if (U.close) U.close.click();`); await on(viewer, `if (U.close) U.close.click();`);
  await on(viewer, `U.profBtn.click(); [...U.avs.querySelectorAll("button")].find(b => b.textContent === "🦊").click(); U.profBtn.click();`);
  await type(viewer, "hel");
  const seen = await soft("the host to see the typing note", async () => { const t = await typingText(host); return t && t; });
  check(suite, `Host sees "${names.viewer} is typing…"`, seen === `${names.viewer} is typing…`, seen || "nothing shown");
  await type(viewer, "hello there"); await submit(viewer);
  const got = await soft("the message to reach the host", async () => { const m = await lastMsg(host); return m && m.txt === "hello there" && m; });
  check(suite, "Host sees the sender's name and picture", !!got && got.who.startsWith(names.viewer + " ·") && got.av === "🦊", got ? `${got.who} ${got.av}` : "no message");
  check(suite, "Typing note clears when the message lands", (await typingText(host)) === "");
  const b1 = await badge(host);
  check(suite, "Closed chat shows an unread count", b1 === "1", b1 || "no badge");

  // The host answers with the initials avatar. The viewer's own row reads "You".
  await type(host, "hi!"); await submit(host);
  const back = await soft("the reply to reach the viewer", async () => { const m = await lastMsg(viewer); return m && m.txt === "hi!" && m; });
  const initial = names.host[0].toUpperCase();
  check(suite, "Viewer sees the host's name and initials", !!back && back.who.startsWith(names.host + " ·") && back.av === initial, back ? `${back.who} ${back.av}` : "no message");
  const b2 = await badge(viewer);
  check(suite, "Viewer's closed chat counts the reply", b2 === "1", b2 || "no badge");
  await on(viewer, `document.getElementById("chatBtn") ? document.getElementById("chatBtn").click() : document.getElementById("cbtn").click();`);
  check(suite, "Opening the chat clears the count", (await badge(viewer)) === "");

  // The viewer renames themselves in the chat panel; their next message carries the new name.
  await on(viewer, `U.profBtn.click(); U.profName.value = "Sam"; U.profName.dispatchEvent(new Event("change", { bubbles: true })); U.profBtn.click();`);
  await sleep(1500);
  await type(viewer, "new name"); await submit(viewer);
  const renamed = await soft("the renamed message to reach the host", async () => { const m = await lastMsg(host); return m && m.txt === "new name" && m; });
  check(suite, "A new name shows on the next message", !!renamed && renamed.who.startsWith("Sam ·"), renamed ? renamed.who : "no message");
  if (partnerName) {
    const list = await soft("the host's party list to show the new name", async () => { const n = await partnerName(); return n === "Sam" && n; });
    check(suite, "The host's party list shows the new name", list === "Sam", list || "unchanged");
  }
}

// The invite page, from this repo. Anything else on that site is a 404.
const INVITE_PAGE = "https://chris-203.github.io/screenshare/sync.html";
const serveInvite = route => new URL(route.request().url()).pathname === "/screenshare/sync.html"
  ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: readFileSync(join(root, "sync.html"), "utf8") })
  : route.fulfill({ status: 404, body: "not found" });

// Someone's video stalls while playing. The other side pauses and waits, the stalled side's position
// stays put, and once it's moving again both play on in sync.
async function bufferHold(who, slow, hostPage, guestPage) {
  const other = slow === hostPage ? guestPage : hostPage;
  await onVideo(slow, v => { v.playbackRate = 0; });
  await sleep(3000);
  const [a, w] = await Promise.all([probe(slow), probe(other)]);
  check("extension", `${who} buffering: the other side waits`, !!(a && w && !a.paused && w.paused), w ? `waiting at ${w.t.toFixed(2)} s, stuck at ${a.t.toFixed(2)} s` : "no video");
  await sleep(2000);
  const w2 = await probe(other);
  check("extension", `${who} buffering: still waiting 5 s in`, !!(w2 && w2.paused), w2 ? `other side ${w2.paused ? "paused" : "playing"} at ${w2.t.toFixed(2)} s` : "no video");
  await onVideo(slow, v => { v.playbackRate = 1; });
  await expectPlayingInSync("extension", `${who}'s video loads, both play on`, hostPage, guestPage, { settle: 5000 });
}

// The guest presses play and their video takes 3 s to start (a slow connection, or an ad loading), and any
// move in the 20 s after that starts the loading over (an ad does that when it's skipped around in). The
// host waits for the guest, then both must settle into playing together. Snapping the guest to the host's
// spot after the wait started the loading over, which paused the host again, over and over, so the guest's
// play button seemed to do nothing.
async function slowGuestPlays(hostPage, guestPage) {
  await onVideo(guestPage, v => v.pause());
  await expectPausedInSync("extension", "Guest pauses before a slow start", hostPage, guestPage);
  await onVideo(guestPage, v => {
    let started = 0;
    const stall = () => { v.playbackRate = 0; clearTimeout(v.__slow); v.__slow = setTimeout(() => { v.playbackRate = 1; }, 3000); };
    v.__stall = e => { if (e.type === "play") { started = Date.now(); stall(); } else if (Date.now() - started < 20000) stall(); };
    v.addEventListener("play", v.__stall);
    v.addEventListener("seeking", v.__stall);
  });
  await onVideo(guestPage, v => v.play());
  await expectPlayingInSync("extension", "Slow guest presses play, both play on", hostPage, guestPage, { settle: 12000, window: 8000 });
  await onVideo(guestPage, v => { v.removeEventListener("play", v.__stall); v.removeEventListener("seeking", v.__stall); clearTimeout(v.__slow); v.playbackRate = 1; });
}

// An ad that plays in a second video while the show's video sits "playing" but frozen (some players do this).
// The host waits, and the guest's ad and show are left alone: nothing pauses or moves them.
async function adInOwnPlayer(hostPage, guestPage) {
  await onVideo(guestPage, v => {
    v.playbackRate = 0;
    const ad = document.createElement("video");
    ad.id = "fake-ad"; ad.src = "/sample.webm"; ad.muted = true; ad.width = 320; ad.height = 180;
    v.parentElement.appendChild(ad); ad.play();
  });
  await sleep(4000);
  const adState = () => guestPage.evaluate(() => { const a = document.getElementById("fake-ad"); return { t: a.currentTime, paused: a.paused }; });
  const [h, g, a1] = await Promise.all([probe(hostPage), probe(guestPage), adState()]);
  await sleep(3000);
  const [g2, a2] = await Promise.all([probe(guestPage), adState()]);
  check("extension", "Guest's ad in its own player: host waits", !!(h && h.paused), h ? `host ${h.paused ? "paused" : "playing"} at ${h.t.toFixed(2)} s` : "no video");
  check("extension", "The guest's ad keeps playing", !a2.paused && a2.t - a1.t > 2, `ad at ${a1.t.toFixed(2)} s, then ${a2.t.toFixed(2)} s`);
  check("extension", "The guest's show isn't paused or moved", !!(g && g2 && !g2.paused && Math.abs(g2.t - g.t) < 0.05), g2 ? `${g2.paused ? "paused" : "playing"} at ${g2.t.toFixed(2)} s` : "no video");
  await onVideo(guestPage, v => { document.getElementById("fake-ad").remove(); v.playbackRate = 1; });
  await expectPlayingInSync("extension", "Guest's ad ends, both play on", hostPage, guestPage, { settle: 5000 });
}

// Host only: with both playing, the guest's pause and skip are undone and the host doesn't move.
// Then everyone gets control back and the guest's pause counts again.
async function hostOnly(suite, who, host, viewer, setHostOnly) {
  await setHostOnly(true);
  await sleep(1500);
  await onVideo(viewer, v => v.pause());
  await expectPlayingInSync(suite, `Host only: ${who.toLowerCase()}'s pause is undone`, host, viewer, { settle: 3000 });
  const h0 = (await probe(host)).t, target = h0 > 60 ? h0 - 30 : h0 + 30;
  await onVideo(viewer, (v, t) => { v.currentTime = t; }, target);
  await expectPlayingInSync(suite, `Host only: ${who.toLowerCase()}'s skip is undone`, host, viewer, { settle: 3500 });
  const h1 = (await probe(host)).t;
  check(suite, `Host only: the host stays put`, Math.abs(h1 - target) > 15, `host at ${h1.toFixed(2)} s, ${who.toLowerCase()} tried ${target.toFixed(2)} s`);
  await setHostOnly(false);
  await sleep(1500);
  await onVideo(viewer, v => v.pause());
  await expectPausedInSync(suite, `Everyone again: ${who.toLowerCase()}'s pause counts`, host, viewer);
}

// One person's ad break, from start to end. `hostPage` and `guestPage` are only for the drift check.
async function adBreak(who, inAd, hostPage, guestPage) {
  const other = inAd === hostPage ? guestPage : hostPage;
  const setAd = on => inAd.evaluate(on => document.querySelector(".html5-video-player").classList.toggle("ad-showing", on), on);
  await setAd(true);
  await sleep(2500);
  const [a, w] = await Promise.all([probe(inAd), probe(other)]);
  check("extension", `${who} in an ad: the other side waits`, !!(a && w && !a.paused && w.paused), w ? `waiting at ${w.t.toFixed(2)} s` : "no video");
  // The ad has its own timeline. Nothing it does may reach the side that's waiting.
  await onVideo(inAd, v => { v.currentTime = 5; });
  await sleep(2000);
  const w2 = await probe(other);
  check("extension", `${who}'s ad seeks stay on ${who === "Host" ? "the host" : "the guest"}`, !!(w && w2 && w2.paused && Math.abs(w2.t - w.t) < 0.3), w2 ? `other side at ${w2.t.toFixed(2)} s` : "no video");
  await setAd(false);
  await expectPlayingInSync("extension", `${who}'s ad ends, both play on`, hostPage, guestPage, { settle: 5000 });
}

// ---------------------------------------------------------------- video chat (extension)
// vc.html is opened as its own tab on each side (on a real site it sits in a frame in the party's
// tab, which a test can't reach through the closed shadow root). Chromium's fake camera and mic
// stand in for real ones. The signaling goes through the party connection above (the fake PeerJS);
// the media is a real RTCPeerConnection between the two browsers.
async function videoChat(host, guest) {
  console.log("\nVideo chat");
  const vc = async s => { const p = await s.ctx.newPage(); watchErrors(p, "video chat"); await p.goto(`chrome-extension://${s.id}/vc.html`); return p; };
  // What one side sees of the other: [has a live picture, mic shown as on].
  const remote = p => p.evaluate(() => {
    const t = document.querySelector(".tile:not(.me)"); if (!t) return null;
    const v = t.querySelector("video");
    return { picture: !t.classList.contains("nocam") && v.videoWidth > 0 && v.readyState >= 2, mic: !t.classList.contains("nomic"), connecting: !!t.querySelector(".wait") };
  });
  const check = async (step, fn, timeout = 25000) => {
    const t0 = Date.now();
    try { await until(step, fn, timeout); record("extension", step, "video", NaN, "-", true, `${Date.now() - t0} ms`); }
    catch (e) { record("extension", step, "video", NaN, "-", false, String(e.message || e).slice(0, 120)); throw new VideoStop(); }
  };
  class VideoStop extends Error {}   // the steps after a failed one would only time out
  const [a, b] = [await vc(host), await vc(guest)];
  try {
    await check("Both open video chat, nothing captured", async () => {
      const [ra, rb] = [await remote(a), await remote(b)];
      return ra && rb && !ra.picture && !rb.picture && !ra.mic && !rb.mic;
    });
    await a.click("#cam"); await a.click("#mic");
    await check("Host turns camera and mic on, guest sees it", async () => { const r = await remote(b); return r && r.picture && r.mic && !r.connecting; });
    // The guest must actually receive the host's mic: audio packets arrive and the tile's element is playing it.
    const hears = p => p.evaluate(async () => {
      const x = [...peers.values()][0]; if (!x || !x.pc) return null;
      let bytes = 0; (await x.pc.getStats()).forEach(r => { if (r.type === "inbound-rtp" && r.kind === "audio") bytes = r.bytesReceived; });
      // Whatever element plays the sound must really be running (readyState 2+), not just "not paused".
      const el = [...x.tile.tile.querySelectorAll("audio, video")].find(m => !m.muted && m.srcObject && m.srcObject.getAudioTracks().length);
      const at = el && el.srcObject.getAudioTracks()[0];
      return { bytes, playing: !!el && !el.paused && el.readyState >= 2 && el.volume > 0, track: !!at && at.readyState === "live" && !at.muted };
    });
    await check("Guest hears the host's mic", async () => { const h = await hears(b); return h && h.bytes > 2000 && h.playing && h.track; });
    await b.click("#mic");
    // The guest's camera is still off: their voice must play without a picture.
    await check("Host hears the guest's mic, guest's camera off", async () => { const h = await hears(a); return h && h.bytes > 2000 && h.playing && h.track; });
    await b.click("#mic");
    await b.click("#cam");
    await check("Guest turns camera on, host sees it", async () => { const r = await remote(a); return r && r.picture && !r.mic; });
    await a.click("#cam");
    await check("Host turns camera off, guest sees that", async () => { const r = await remote(b); return r && !r.picture && r.mic; });
    await a.click("#cam");
    await check("Host turns camera back on", async () => { const r = await remote(b); return r && r.picture; });
    await b.close();
    await check("Guest closes video chat, host drops the tile", async () => !(await a.$(".tile:not(.me)")));
  } catch (e) { if (!(e instanceof VideoStop)) throw e; }
  await a.close().catch(() => {}); await b.close().catch(() => {});
}

// ---------------------------------------------------------------- run
function summary() {
  const failed = results.filter(r => !r.ok);
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (out) {
    const ms = n => (isFinite(n) ? `${Math.round(n)} ms` : "n/a");
    const rows = results.map(r => `| ${r.suite} | ${r.step} | ${r.kind} | ${ms(r.worst)} | ${r.limit == null ? "n/a" : r.limit + " ms"} | ${r.ok ? "ok" : "**FAIL**"} | ${r.note} |`);
    appendFileSync(out, [`### Sync drift${fault ? " (fault injected, failure expected)" : ""}`, "", "| Suite | Step | State | Worst drift | Limit | Result | Notes |", "|---|---|---|---|---|---|---|", ...rows, ""].join("\n"));
  }
  return failed;
}

let exit = 0;
const hub = await startHub();
const web = await startServer(hub.port);
try {
  if (want("party")) await partySuite(hub, web);
  if (want("extension")) { hub.dropSync = false; await extensionSuite(hub, web); }
  const failed = summary();
  if (failed.length) { exit = 1; console.log(`\n${failed.length} of ${results.length} checks out of sync.`); }
  else console.log(`\nAll ${results.length} checks in sync.`);
} catch (e) {
  summary();
  if (e instanceof DriftError) { exit = 1; console.log(`\n--fault: "${e.message}" went out of sync after ${hub.dropped} dropped messages, as it should.`); }
  else { exit = 2; console.error(`\nThe test could not finish: ${e.stack || e}`); }
} finally {
  await web.close(); await hub.close();
}
process.exit(exit);
