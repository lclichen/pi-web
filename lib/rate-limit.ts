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

type HeaderBag = Headers | Record<string, unknown>;

/** Read one header from either a WHATWG Headers object or Node's header bag. */
function readHeader(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name);
    return value && value.length > 0 ? value : undefined;
  }
  const raw = (headers as Record<string, unknown>)[name];
  if (typeof raw === "string") return raw.length > 0 ? raw : undefined;
  if (Array.isArray(raw)) {
    return raw.find((value): value is string => typeof value === "string" && value.length > 0);
  }
  return undefined;
}

/**
 * Client IP for rate-limit keys: first hop of x-forwarded-for, then x-real-ip,
 * then the socket address.
 *
 * Route handlers receive a WHATWG `Request`, whose `headers` is a `Headers`
 * object — bracket access (`headers["x-forwarded-for"]`) is always undefined,
 * which used to bucket every login under "unknown" (10/min globally). Node
 * callers (the relay WebSocket server) pass an IncomingMessage-style bag, so
 * both shapes are supported. Next's own server fills x-forwarded-for from the
 * socket when a direct client sends none.
 */
export function clientIpOf(req: { headers: HeaderBag; socket?: { remoteAddress?: string } }): string {
  const fwd = readHeader(req.headers, "x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = readHeader(req.headers, "x-real-ip");
  if (real) return real.trim();
  return req.socket?.remoteAddress ?? "unknown";
}
