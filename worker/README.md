# TURN credentials Worker

Some networks (strict firewalls, carrier NAT, some school and office Wi-Fi) block direct
WebRTC connections. A TURN server relays the video and data for those viewers. This
Cloudflare Worker hands out TURN credentials that last 12 hours, so the TURN API token
stays on Cloudflare and never appears in the site or the extension.

`extension/ice.js` asks this Worker for credentials before connecting. If `TURN_URL` in that
file is empty, or the Worker doesn't answer within 4 seconds, everything connects the way
it did before (STUN only).

## One-time setup

1. Sign in at https://dash.cloudflare.com (a free account works).
2. Create the TURN key: in the sidebar open **Realtime**, then **TURN Server**, then
   **Create**. Name it `screenshare`. Copy the **Turn Token ID** and the **API Token**.
   The API token is shown only once.
3. Create the Worker: open **Workers & Pages**, **Create**, **Create Worker**, name it
   `screenshare-turn`, and **Deploy** the starter code.
4. Open **Edit code**, replace everything with the contents of `worker/turn.js`, and
   **Deploy** again.
5. In the Worker's **Settings**, **Variables and Secrets**, add two variables of type
   **Secret**:
   - `TURN_KEY_ID`: the Turn Token ID
   - `TURN_KEY_API_TOKEN`: the API Token
6. Copy the Worker's URL (it looks like `https://screenshare-turn.<name>.workers.dev`) and
   put it in `TURN_URL` at the top of `extension/ice.js`. Merging that change publishes the
   site and rebuilds the extension zip.

Command line instead of steps 3 to 5, from this folder:

```
npx wrangler login
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
npx wrangler deploy
```

## Checking it

`curl -H "Origin: https://chris-203.github.io" https://screenshare-turn.<name>.workers.dev`
should print JSON with `iceServers` and `ttl`. Without that `Origin` header it answers 403.

On the site, open the browser console: a line starting `No TURN relay` means the Worker
call failed and the page fell back to STUN. In Chrome, `chrome://webrtc-internals` shows
the candidate pair in use; a `relay` candidate means traffic went through TURN.

## Cost and abuse

Cloudflare bills TURN by data relayed, with a free monthly allowance (1,000 GB when this
was written; check the current Realtime pricing page). Only connections that can't go
direct use the relay, so most sessions cost nothing. The Worker only answers this site,
`localhost` and Chrome extensions, but the `Origin` header can be faked by scripts outside
a browser, so set a billing notification in the Cloudflare dashboard to be safe.
