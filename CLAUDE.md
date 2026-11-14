# Screenshare

Personal two-person tools served by GitHub Pages at https://chris-203.github.io/screenshare/.
Everything is static: no build step, no package.json, no bundler, no test suite. Pages serves the repo files as they are, so whatever lands on `main` is live.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Screen share. Host captures a screen with `getDisplayMedia` and calls each viewer over WebRTC. |
| `party.html` | Watch party. Synced YouTube, direct video URL, or a local file (the viewer plays their own copy, or the host streams it). |
| `sync.html` | Install and usage page for the extension. Static, no script. |
| `extension/` | Watch Sync, a Manifest V3 extension for Chrome and Edge that syncs play, pause and seek on streaming sites. |
| `watch-sync.zip` | Built by CI from `extension/`. Linked from `sync.html`. |
| `.github/workflows/build-extension.yml` | On pushes to `main` that touch `extension/`: downloads PeerJS into `extension/peerjs.min.js`, zips the extension, commits both back to `main`. |
| `.github/workflows/check-extension.yml` | On every pull request and push to `main`: runs `.github/scripts/check-extension.mjs`. |

## How the pieces talk

All three tools use PeerJS 1.5.4 and its free public broker for the handshake; media and data then go peer to peer. Peer IDs are a per-tool prefix plus a short code: `chris203-ss-` (screen share), `chris203-wp-` (watch party), `chris203-ws-` (extension, with `-host` or `-guest` appended). The broker is public, so anyone who knows or guesses an ID can connect to it. Treat everything arriving on a connection as untrusted input.

`index.html` and `party.html` are each one file with one inline `<script>` that holds both roles: `startHost()` and `startViewer(code)`. The host is the source of truth. In the watch party the host broadcasts state, and viewers estimate the clock offset with ping/pong and correct drift with small playback-rate nudges or a seek.

The extension has four contexts that only talk through `chrome.runtime` messages. A message carries `to: "bg"` or `to: "off"`; a message with no `to` is for the content script.

- `background.js`: service worker and router. State lives in `chrome.storage.session` under the key `ws` because the worker can be stopped at any time. Do not keep state in module variables there.
- `offscreen.js` with `offscreen.html`: holds the PeerJS connection so it survives tab navigation, and translates the partner's timestamps into the local clock.
- `content.js`: runs in the top frame of the sites listed in `manifest.json`. Watches the page's `<video>`, sends local play, pause and seek, applies the partner's. Its UI is in a closed shadow root.
- `netflix-main.js`: runs in Netflix's own page context (`"world": "MAIN"`) because setting `currentTime` directly crashes the Netflix player. `content.js` reaches it with `window.postMessage`.
- `popup.js` with `popup.html`: start, join and leave.

## Rules for changes

- Keep it dependency-free and build-free. Plain ES2020+ classic scripts, no modules, no frameworks, no npm packages.
- Match the existing style: two-space indent, double quotes, semicolons, compact one-line helpers, `$ = id => document.getElementById(id)`.
- Extension pages cannot run inline or remote scripts (MV3 content security policy). Any library must be a file inside `extension/`.
- Do not hand-edit `extension/peerjs.min.js` or `watch-sync.zip`. The build workflow overwrites and commits them, so `main` can gain a "Build extension zip" commit right after a merge. Pull before pushing again.
- If you add a streaming site, add it to `content_scripts[0].matches` in `extension/manifest.json`, the site list in `sync.html`, and the error text in `background.js`.
- If you change the version of PeerJS, change it everywhere it appears: both HTML pages and the build workflow.
- User-visible text is written for two specific people and stays plain and short. Use `textContent`, never `innerHTML`, for anything that came from the other peer (names, titles, URLs).
- The pages must keep working in Safari on iPhone and iPad (viewer side) and Chrome or Edge on Windows (host side).

## Checking a change

The only automated check is static:

```
node .github/scripts/check-extension.mjs
```

It runs `node --check` on every `extension/*.js`, validates `extension/manifest.json` (JSON, MV3 required fields, match patterns, every referenced file exists), and rejects inline or remote scripts in `extension/*.html`. It needs Node 18 or newer and nothing else. It does not cover the inline scripts in `index.html` and `party.html`, and it cannot tell whether anything works.

Everything else is checked by hand, and every change should say how:

- Pages: serve the repo root (`python3 -m http.server 8000`) and open `http://localhost:8000/` as host in one browser window. `getDisplayMedia` needs HTTPS or `localhost`, so the host must be on `localhost`; a phone on the same network can only be the viewer, and only against the deployed Pages site or a tunnel. Open the viewer link in a second browser or a private window.
- Extension: `chrome://extensions`, Developer mode, Load unpacked, pick `extension/`. Use two browser profiles, each signed in to the streaming service, start a party in one and join from the other. After editing, press reload on the extension card and reload the streaming tab. Errors from the worker and the offscreen document are behind the "service worker" and "offscreen.html" links on that card.
- Things that need two real devices or networks to check honestly: reconnect after a network drop, Safari on iOS, WebRTC across different networks (no TURN server is configured, so strict NATs can fail), and DRM-protected players.

State plainly what was not tested.

## Git

Work on a `chris/<topic>` branch and open a pull request against `main`, one topic per pull request.

No AI attribution anywhere in this repo:

- Commit messages carry no `Co-Authored-By` line for an AI, no session link, and no other AI trailer.
- Pull request titles and descriptions carry no "Requested by" line, no "Generated with Claude Code" footer, no session or thread link, and no hidden attribution comment.
- The same goes for code comments and files. Do not name a model or an assistant in them.
