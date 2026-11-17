// Cloudflare Worker: hands out short-lived Cloudflare TURN credentials to the
// screen share, watch party and Watch Sync extension, so the TURN API token
// never ships in the site or the extension. Deploy steps: worker/README.md.
//
// Secrets (set with `wrangler secret put`): TURN_KEY_ID, TURN_KEY_API_TOKEN.

const TTL = 12 * 60 * 60; // credential lifetime in seconds

// Only these pages may ask. (A browser can't fake its Origin; a script can,
// so this keeps other websites out but is not a hard lock.)
const ALLOWED = [
  /^https:\/\/chris-203\.github\.io$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
  /^chrome-extension:\/\/[a-p]{32}$/,
];

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = ALLOWED.some(r => r.test(origin));
    const cors = allowed ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: allowed ? 204 : 403, headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    }
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });
    if (!allowed) return new Response("Forbidden", { status: 403, headers: cors });

    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL }),
    });
    if (!r.ok) return new Response("TURN credentials unavailable", { status: 502, headers: cors });

    const data = await r.json();
    const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    // Browsers block or time out on port 53, so leave those URLs out.
    const iceServers = list
      .filter(s => s && s.urls)
      .map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)) }))
      .filter(s => s.urls.length);

    return Response.json({ iceServers, ttl: TTL }, { headers: { ...cors, "Cache-Control": "no-store" } });
  },
};
