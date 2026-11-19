/**
 * Server-side REST client for the sandbox platform. All calls run inside
 * pi-web API routes (BFF): the browser never sees platform credentials —
 * requests carry the calling user's API key from their web session.
 */

export interface PlatformError extends Error {
  code?: string;
  status?: number;
}

export function platformUrl(): string {
  const base = process.env.PI_WEB_PLATFORM_URL?.replace(/\/+$/, "");
  if (!base) throw new Error("PI_WEB_PLATFORM_URL is not configured");
  return base;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "[::1]";
}

function normalizeBrowserBase(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/**
 * Platform base URL a *browser* can reach, for redirects (OIDC begin).
 *
 * `platformUrl()` is the server-to-server address and is normally
 * `http://127.0.0.1:<port>`; sending the browser there would point at the
 * user's own machine. `PI_WEB_PLATFORM_PUBLIC_URL` overrides explicitly;
 * otherwise a loopback platform host is rewritten to the hostname the browser
 * used for pi-web (`browserOrigin`), keeping the platform port (standard
 * co-located deployment). The caller supplies the browser origin so this module
 * stays free of request/settings imports (avoids a server-settings → mode-homes
 * → client cycle).
 */
export function platformBrowserUrl(browserOrigin: string): string {
  const configured = process.env.PI_WEB_PLATFORM_PUBLIC_URL;
  if (configured?.trim()) {
    const normalized = normalizeBrowserBase(configured);
    if (normalized) return normalized;
    console.warn("[pi-web] ignoring invalid PI_WEB_PLATFORM_PUBLIC_URL");
  }
  const base = new URL(platformUrl());
  const basePath = base.pathname.replace(/\/+$/, "");
  if (!isLoopbackHostname(base.hostname)) {
    return `${base.origin}${basePath}`;
  }
  let origin: URL;
  try {
    origin = new URL(browserOrigin);
  } catch {
    return `${base.origin}${basePath}`;
  }
  if (isLoopbackHostname(origin.hostname)) {
    return `${base.origin}${basePath}`;
  }
  base.hostname = origin.hostname;
  return `${base.protocol}//${base.host}${basePath}`;
}

/**
 * 错误响应体常常不是 JSON（反代 502/504 的 HTML 页等）。解析失败一律按
 * null 处理：错误路径让 toError 走 `platform HTTP <status>` 兜底而不是把
 * SyntaxError 抛给调用方；成功路径与空 body 一样按 null 返回。
 */
function safeParseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toError(status: number, body: unknown): PlatformError {
  const err: PlatformError = new Error(
    body && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string"
      ? (body as { message: string }).message
      : `platform HTTP ${status}`,
  );
  if (body && typeof body === "object" && "code" in body && typeof (body as { code: unknown }).code === "string") {
    err.code = (body as { code: string }).code;
  }
  err.status = status;
  return err;
}

async function request<T>(
  method: string,
  path: string,
  credential: string,
  body?: unknown,
  opts?: { query?: Record<string, string | number | undefined> },
): Promise<T> {
  const url = new URL(platformUrl() + path);
  for (const [key, value] of Object.entries(opts?.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      "X-API-Key": credential,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  const parsed = safeParseJson(text);
  if (!res.ok) throw toError(res.status, parsed);
  return parsed as T;
}

export function platformGet<T>(
  path: string,
  credential: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  return request<T>("GET", path, credential, undefined, { query });
}

export function platformPost<T>(path: string, credential: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, credential, body);
}

export function platformDelete<T>(path: string, credential: string): Promise<T> {
  return request<T>("DELETE", path, credential);
}

export function platformPatch<T>(path: string, credential: string, body: unknown): Promise<T> {
  return request<T>("PATCH", path, credential, body);
}

export function platformPut<T>(path: string, credential: string, body: unknown): Promise<T> {
  return request<T>("PUT", path, credential, body);
}

/** Call with a Bearer JWT (short-lived, e.g. right after login). */
export function platformPostBearer<T>(path: string, bearerToken: string, body?: unknown): Promise<T> {
  const run = async (): Promise<T> => {
    const res = await fetch(platformUrl() + path, {
      method: "POST",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${bearerToken}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const text = await res.text();
    const parsed = safeParseJson(text);
    if (!res.ok) throw toError(res.status, parsed);
    return parsed as T;
  };
  return run();
}

/** Unauthenticated call (login/register/config only). */
export async function platformAnonPost<T>(
  path: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: PlatformError }> {
  const res = await fetch(platformUrl() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  const parsed = safeParseJson(text);
  if (!res.ok) return { ok: false, status: res.status, error: toError(res.status, parsed) };
  return { ok: true, data: parsed as T };
}

export async function platformAnonGet<T>(
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: PlatformError }> {
  const res = await fetch(platformUrl() + path, { cache: "no-store" });
  const text = await res.text();
  const parsed = safeParseJson(text);
  if (!res.ok) return { ok: false, status: res.status, error: toError(res.status, parsed) };
  return { ok: true, data: parsed as T };
}

// ---- Typed response shapes (kept local to this module's consumers) ----

export interface PlatformLoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: number;
    username: string;
    email: string | null;
    role: "admin" | "user";
    quota_id: number | null;
    status: string;
    must_change_password: boolean;
  };
}

export interface PlatformApiKeyCreated {
  id: number | string;
  key: string;
}
