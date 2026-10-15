// Authentication relies on Tailscale. `tailscale serve` proxies tailnet traffic to this server from
// the same machine and adds identity headers. The server only listens on loopback, so a remote
// client can never reach it without passing through Tailscale, and cannot forge those headers.

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function authorize(req, allowedLogins = []) {
  // Funnel exposes the service to the public internet; it must never reach this app.
  if (req.headers["tailscale-funnel-request"]) return { ok: false, reason: "funnel" };

  const remote = req.socket?.remoteAddress ?? "";
  if (!LOOPBACK.has(remote)) return { ok: false, reason: "not-loopback" };

  const login = String(req.headers["tailscale-user-login"] ?? "").trim().toLowerCase();
  if (!login) return { ok: true, user: "local", via: "loopback" };

  if (allowedLogins.length && !allowedLogins.includes(login)) return { ok: false, reason: "login-not-allowed", user: login };
  return { ok: true, user: login, via: "tailscale" };
}

/**
 * Blocks cross-site writes: browsers always send Origin on cross-origin POST/PUT/PATCH/DELETE, and
 * it must name the host this request was addressed to.
 */
export function sameOriginWrite(req) {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
