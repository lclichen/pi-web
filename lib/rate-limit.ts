// Tiny in-process sliding-window rate limiter for the few endpoints that must
// resist brute force even without an upstream proxy (webauth login, relay
// pairing exchange). Stored on globalThis so Next.js hot-reload does not reset
// counters. Single-process by design — pi-web is a single-instance server.

interface Bucket {
  hits: number[];
}

interface Store {
  buckets: Map<string, Bucket>;
  sweeper?: ReturnType<typeof setInterval>;
}

const SWEEP_MS = 60 * 1000;

declare global {
  var __piRateLimit: Store | undefined;
}

function store(): Store {
  if (!globalThis.__piRateLimit) {
    globalThis.__piRateLimit = { buckets: new Map() };
  }
  const s = globalThis.__piRateLimit;
  if (!s.sweeper) {
    s.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of s.buckets) {
        bucket.hits = bucket.hits.filter((t) => now - t < 15 * 60 * 1000);
        if (bucket.hits.length === 0) s.buckets.delete(key);
      }
    }, SWEEP_MS);
    s.sweeper.unref?.();
  }
  return s;
}

/**
 * Record a hit for `key` and report whether it is still within `limit`
 * events per `windowMs`. Returns { allowed, retryAfterMs }.
 */
export function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const s = store();
  let bucket = s.buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    s.buckets.set(key, bucket);
  }
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0];
    return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - oldest)) };
  }
  bucket.hits.push(now);
  return { allowed: true, retryAfterMs: 0 };
}

/** Client IP for logging-key purposes: first untrusted-hop x-forwarded-for, else socket/remote-ish fallback. */
export function clientIpOf(req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  const hff = req.headers["x-real-ip"];
  if (typeof hff === "string" && hff.length > 0) return hff;
  return req.socket?.remoteAddress ?? "unknown";
}
