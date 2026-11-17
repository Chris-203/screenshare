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
    <video src="/sample.webm" width="640" height="360" controls preload="auto"></video>`;
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
    const ctx = await chromium.launchPersistentContext(join(work, name), {
      channel: "chromium", headless: true,
      args: [...LAUNCH_ARGS, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    await ctx.route("https://www.youtube.com/**", serve);
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
    return { ctx, page, popup, bg };
  };

  const sides = [];
  try {
    const host = await open("host"); sides.push(host);
    const guest = await open("guest"); sides.push(guest);
    const started = await until("the host to start a party", async () => { const r = await host.bg({ cmd: "start", name: "Host" }); return r && r.ok && r; });
    await until("the guest to join", async () => { const r = await guest.bg({ cmd: "join", code: started.party.code, name: "Guest" }); return r && r.ok; });
    for (const s of sides) await until("both sides to connect", async () => (await s.bg({ cmd: "status" })).status === "connected");
    for (const s of sides) { await s.popup.close(); }
    await sleep(2500);   // clock samples and the first forced heartbeat

    await expectPausedInSync("extension", "Guest joins before anything plays", host.page, guest.page, { settle: 500 });
    await scenario("extension", host.page, guest.page, hub, { host: "Host", viewer: "Guest" });
  } finally {
    await Promise.all(sides.map(s => s.ctx.close().catch(() => {})));
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- run
function summary() {
  const failed = results.filter(r => !r.ok);
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (out) {
    const ms = n => (isFinite(n) ? `${Math.round(n)} ms` : "n/a");
    const rows = results.map(r => `| ${r.suite} | ${r.step} | ${r.kind} | ${ms(r.worst)} | ${r.limit} ms | ${r.ok ? "ok" : "**FAIL**"} | ${r.note} |`);
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
