import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

const requestCounts = new Map<string, { count: number; resetAt: number }>();

// Loopback peers come straight from the kernel via the TCP socket and
// cannot be spoofed — when there's no proxy in front of us (local dev,
// docker host networking), the request lands here directly with no
// X-Forwarded-For / X-Real-IP. Trust the peer address in that case
// rather than 400'ing.
const LOOPBACK = new Set<string>([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

function peerAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export async function rateLimiter(c: Context, next: Next) {
  const path = c.req.path;

  if (path === "/api/auth/get-session") {
    await next();
    return;
  }

  let ip = c.var.clientIp;
  if (!ip) {
    const peer = peerAddress(c);
    if (peer !== null && LOOPBACK.has(peer)) {
      // Local dev: no proxy header is fine, the connection is loopback.
      ip = peer;
    } else {
      return c.json(
        { error: "Missing client IP — request must come through the proxy" },
        400,
      );
    }
  }
  const now = Date.now();
  const window = 60_000; // 1 minute
  const maxRequests = 100;

  const entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + window });
  } else if (entry.count >= maxRequests) {
    return c.json({ error: "Too many requests" }, 429);
  } else {
    entry.count++;
  }

  await next();
}
