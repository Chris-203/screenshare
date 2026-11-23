# Screenshare

Personal two-person tools served by GitHub Pages at https://chris-203.github.io/screenshare/.
Everything is static: no build step, no bundler, and no package.json outside the CI-only tests in `.github/sync-tests/`. Pages serves the repo files as they are, so whatever lands on `main` is live.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Screen share. Host captures a screen with `getDisplayMedia` and calls each viewer over WebRTC. |
| `party.html` | Watch party. Synced YouTube, direct video URL, or a local file (the viewer plays their own copy, or the host streams it). |
| `sync.html` | Install and usage page for the extension, and the target of its invite links (`sync.html?join=CODE&to=PAGE`). One small inline script that shows install steps when the extension doesn't answer. |
| `extension/` | Watch Sync, a Manifest V3 extension for Chrome and Edge that syncs play, pause and seek on streaming sites. |
| `extension/ice.js` | ICE server config for all three tools. Fetches TURN credentials from the Worker, falls back to PeerJS defaults. |
| `quality.js` | Viewer quality picker (size and bitrate, Auto by default) for the screen share and the watch party's file stream. The viewer sends its pick; the host applies it to that viewer's sender only. |
| `extension/vc.html`, `vc.js` | Video chat: camera and mic bubbles, shown by `content.js` in a frame on the party's tab. |
| `extension/allow.html`, `allow.js` | Asks Chrome for the camera and mic from the extension's own page, when the frame on a streaming site can't. |
| `worker/` | Cloudflare Worker that mints short-lived TURN credentials. Deployed by hand, see `worker/README.md`. |
| `watch-sync.zip` | Built by CI from `extension/`. Linked from `sync.html`. |
| `.github/workflows/build-extension.yml` | On pushes to `main` that touch `extension/`: downloads PeerJS into `extension/peerjs.min.js`, zips the extension, commits both back to `main`. |
| `.github/workflows/check-extension.yml` | On every pull request and push to `main`: runs `.github/scripts/check-extension.mjs`, then the sync drift tests. |
| `.github/sync-tests/` | Sync drift tests: `run.mjs`, the PeerJS stand-in `fake-peer.js`, a 150 second test video, and the only `package.json` in the repo (Playwright and `ws`, used by CI and nowhere else). |

## How the pieces talk

All three tools use PeerJS 1.5.4 and its free public broker for the handshake; media and data then go peer to peer, or through Cloudflare TURN when a direct path fails. Every `new Peer` passes `config: ICE.config`, and a side that dials waits for `ICE.ready()` first. Peer IDs are a per-tool prefix plus a short code: `chris203-ss-` (screen share), `chris203-wp-` (watch party), `chris203-ws-` (extension, with `-host` or `-guest-<random id>` appended; the extension's code can also be a saved room name like `MOVIE-NIGHT`, 3 to 24 letters, digits and dashes, reused every time that host starts). The broker is public, so anyone who knows or guesses an ID can connect to it. Treat everything arriving on a connection as untrusted input.

`index.html` and `party.html` are each one file with one inline `<script>` that holds both roles: `startHost()` and `startViewer(code)`. The host is the source of truth. In the watch party the host broadcasts state, and viewers estimate the clock offset with ping/pong and correct drift with small playback-rate nudges or a seek.

The extension's contexts only talk through `chrome.runtime` messages. A message carries `to: "bg"`, `to: "off"` or `to: "vc"` (for the video chat frame); a message with no `to` is for the content script.

- `background.js`: service worker and router. State lives in `chrome.storage.session` under the key `ws` because the worker can be stopped at any time. Do not keep state in module variables there.
- `offscreen.js` with `offscreen.html`: holds the PeerJS connections so they survive tab navigation. The host is the hub: each guest connects only to the host, waits for the host's Allow, and the host relays one guest's messages to the others. The host keeps a clock offset per guest and every guest keeps one for the host, so timestamps are translated into the local clock at each hop.
- `content.js`: runs in the top frame of the sites listed in `manifest.json`. Watches the page's `<video>`, sends local play, pause and seek, applies the partner's. Its UI is in a closed shadow root.
- `netflix-main.js`: runs in Netflix's own page context (`"world": "MAIN"`) because setting `currentTime` directly crashes the Netflix player. `content.js` reaches it with `window.postMessage`.
- `popup.js` with `popup.html`: start, join, copy the invite link, and leave.
- `invite.js`: runs only on the deployed `sync.html`. Passes an invite link's code and page to the service worker, which opens that page (only a supported streaming site) in the same tab and joins once `content.js` there says hello.
- `vc.js` with `vc.html`: video chat. A web-accessible extension page that `content.js` puts in a frame inside its shadow root only after the 🎥 button is pressed, so the camera belongs to the extension's origin and the site can't read it. It holds one plain `RTCPeerConnection` per person (a mesh, no PeerJS) and talks to `offscreen.js` directly with `to: "off"` (`cmd: "vcHello"`, `cmd: "vc"`); the offscreen document answers with `to: "vc"`. Offers, answers and candidates ride on the party connection as `{ type: "vc" }`, routed by the host to one member id (`"host"` or a guest's peer ID) or `"*"`, with `from` and `name` stamped by the host. In each pair the lower id makes the only offer, with one audio and one video transceiver; camera and mic toggles use `replaceTrack`, so there is no renegotiation. Nothing is captured until the person presses 📷 or 🎙️. `content.js` moves its UI into the fullscreen element with `moveBefore` where available, which keeps the frame running. Two layouts, switched with ⧉ and remembered in `chrome.storage.local`: one box (`content.js` moves it and sets its width; the frame reports its height with `{ wsvc: "size" }`), or separate bubbles, where the frame covers the page with a see-through background, `vc.js` places each bubble and sends their shapes, and `content.js` turns on the frame's `pointer-events` only while the pointer is over one, so the page stays clickable. Hover is tracked with classes, not `:hover`, because the frame doesn't always hear that the pointer left.

## Rules for changes

- Keep it dependency-free and build-free. Plain ES2020+ classic scripts, no modules, no frameworks, no npm packages.
- Match the existing style: two-space indent, double quotes, semicolons, compact one-line helpers, `$ = id => document.getElementById(id)`.
- Extension pages cannot run inline or remote scripts (MV3 content security policy). Any library must be a file inside `extension/`.
- Do not hand-edit `extension/peerjs.min.js` or `watch-sync.zip`. The build workflow overwrites and commits them, so `main` can gain a "Build extension zip" commit right after a merge. Pull before pushing again.
- If you add a streaming site, add it to `content_scripts[0].matches` and `web_accessible_resources[0].matches` in `extension/manifest.json`, the site list in `sync.html`, and the error text in `background.js`.
- If you change the version of PeerJS, change it everywhere it appears: both HTML pages and the build workflow.
- User-visible text is written for two specific people and stays plain and short. Use `textContent`, never `innerHTML`, for anything that came from the other peer (names, titles, URLs).
- The pages must keep working in Safari on iPhone and iPad (viewer side) and Chrome or Edge on Windows (host side).

## Checking a change

There are two automated checks, and both run on every pull request.

The static one:

```
node .github/scripts/check-extension.mjs
```

It runs `node --check` on every `extension/*.js`, validates `extension/manifest.json` (JSON, MV3 required fields, match patterns, every referenced file exists), and rejects inline or remote scripts in `extension/*.html`. It needs Node 18 or newer and nothing else. It does not cover the inline scripts in `index.html` and `party.html`, and it cannot tell whether anything works.

The sync drift tests:

```
cd .github/sync-tests && npm ci && npx playwright install chromium
node run.mjs            # or: node run.mjs party | node run.mjs extension | node run.mjs screen
```

Two separate headless Chromium browsers play the same test video, one as host and one as viewer, first through `party.html` (video link mode) and then through the extension on a stand-in page answered locally for a youtube.com address. Play, pause and skips are made from both sides, then the extension run adds an ad break on each side (the stand-in page marks it the way YouTube does), the host moving to a next video, which the guest must follow, and each side's video stalling (playback rate 0), which the other side must wait for, a guest whose video is slow to start and starts loading over whenever it's moved (the host must wait and then pick up from the guest's spot, not loop), and an ad shown in a second video while the show's video sits frozen (the host waits, the guest's ad and show are left alone). Both suites then run "Host only" mode, where the viewer's pause and skip must be undone and the host must not move. The extension run ends with the guest joining from an invite link (the invite page is answered locally from `sync.html`), and checks that a browser without the extension gets the install steps. The run fails if the two positions are further apart than the limits at the top of `run.mjs` (150 ms playing and 300 ms paused for the page, 500 ms and 650 ms for the extension). After the chat checks the extension run opens video chat on both sides with Chromium's fake camera and mic and checks that each picture arrives, that each side hears the other's mic (also with the camera off), that camera off and on reaches the other side, and that closing video chat removes the tile; that media is a real `RTCPeerConnection` between the two browsers. `node run.mjs party --fault` drops the sync messages on purpose and must exit 1; CI runs that too. A third suite, `node run.mjs screen`, checks the screen share's sound: the host's `getDisplayMedia` is replaced by a moving canvas and a 440 Hz tone, the call is a real `RTCPeerConnection` (`fake-peer.js` carries only its offer and answer), and the viewer's browser keeps Chromium's normal autoplay rule. It checks that the viewer hears the tone after their one "Ask to watch" click, still hears it after Switch window, that a browser which refuses sound until a tap (as Safari does) shows the picture muted with a "Tap for sound" button, and that the host is warned when a share comes back without sound.

`party.html` and the extension scripts run unmodified. Only PeerJS is replaced: `fake-peer.js` carries the same messages through a local hub with 60 to 100 ms of delay each way, and the page test also sets the viewer's clock 4.3 seconds ahead. So these tests cover the sync logic. Apart from that video chat check they do not cover WebRTC, the PeerJS broker, YouTube mode, streaming a local file, Netflix's player path, Safari, or reconnecting. If a change makes sync looser on purpose, change the limit in `run.mjs` in the same pull request and say why. If you use a PeerJS feature the tests have not seen (a new event or method), add it to `fake-peer.js`.

Everything else is checked by hand, and every change should say how:

- Pages: serve the repo root (`python3 -m http.server 8000`) and open `http://localhost:8000/` as host in one browser window. `getDisplayMedia` needs HTTPS or `localhost`, so the host must be on `localhost`; a phone on the same network can only be the viewer, and only against the deployed Pages site or a tunnel. Open the viewer link in a second browser or a private window.
- Extension: `chrome://extensions`, Developer mode, Load unpacked, pick `extension/`. Use two browser profiles, each signed in to the streaming service, start a party in one and join from the other. After editing, press reload on the extension card and reload the streaming tab. Errors from the worker and the offscreen document are behind the "service worker" and "offscreen.html" links on that card.
- Things that need two real devices or networks to check honestly: reconnect after a network drop, Safari on iOS, WebRTC across different networks (TURN only works once the Worker is deployed and `TURN_URL` is set), and DRM-protected players.

State plainly what was not tested.

## Git

Work on a `chris/<topic>` branch and open a pull request against `main`, one topic per pull request.

No AI attribution anywhere in this repo:

- Commit messages carry no `Co-Authored-By` line for an AI, no session link, and no other AI trailer.
- Pull request titles and descriptions carry no "Requested by" line, no "Generated with Claude Code" footer, no session or thread link, and no hidden attribution comment.
- The same goes for code comments and files. Do not name a model or an assistant in them.
