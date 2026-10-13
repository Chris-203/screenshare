# Screen Share & Watch Party

Personal tools for hanging out on FaceTime. Hosted on GitHub Pages: https://chris-203.github.io/screenshare/

| Page | What it does |
|---|---|
| `index.html` | **Screen share.** Stream my Windows desktop to a link she opens in Safari. |
| `party.html` | **Watch party.** YouTube links, direct video links, or a file on my PC, synced on any device (iPhone, iPad, Mac). |
| `sync.html` | **Watch Sync extension.** Teleparty-style sync for Netflix, Disney+, Max, Hulu, Prime Video, etc. in Chrome/Edge. |

## How sync stays tight (watch party)
- My page is the source of truth; it broadcasts `{paused, t, at}` every second and instantly on any change.
- Her page estimates the clock offset between our devices (NTP-style pings) and extrapolates where the video *should* be.
- Small drift is fixed with an invisible playback-speed nudge (±6%); big drift with a seek.
- If either side buffers, everyone pauses until it catches up (toggleable).
- Local files: if she has the same file she plays her own copy (perfect quality); otherwise it streams live from my PC over WebRTC.

## Extension
Source is in `extension/`. A GitHub Action bundles PeerJS into it and publishes `watch-sync.zip` on every change.
Install: unzip → `chrome://extensions` → Developer mode → Load unpacked.

Connections are peer-to-peer (WebRTC). The free PeerJS broker only handles the initial handshake.
