import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import type { AppUpdateResponse } from "@/lib/api-types";
import {
  getPiWebReleaseUrl,
  isNewerSemver,
  isNewerStableVersion,
  parseUpdateCatalog,
  selectCatalogTarget,
  type UpdateCatalog,
} from "@/lib/app-update";
import { detectPkgKind, readRuntimeVersion, canSelfUpdate } from "@/lib/update-runtime";
import { requireUserIdentity } from "@/lib/web-session";

export const dynamic = "force-dynamic";

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const SKIP_VERSION_CHECK = process.env.PI_WEB_SKIP_VERSION_CHECK === "1";

interface UpdateCache {
  catalog?: { value: UpdateCatalog; expiresAt: number };
  npm?: { value: AppUpdateResponse; expiresAt: number };
  inFlight?: Promise<unknown>;
}

declare global {
  var __piWebAppUpdateCache: UpdateCache | undefined;
}

function getCache(): UpdateCache {
  return globalThis.__piWebAppUpdateCache ??= {};
}

/** catalog 源：http(s) URL 或本地文件路径（AMEDAC_UPDATE_CATALOG_URL）。 */
async function loadCatalog(source: string): Promise<UpdateCatalog> {
  let text: string;
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`catalog 源返回 HTTP ${response.status}`);
    text = await response.text();
  } else {
    text = await readFile(source, "utf8");
  }
  return parseUpdateCatalog(JSON.parse(text));
}

function buildCatalogResponse(catalog: UpdateCatalog): AppUpdateResponse {
  const { version: currentVersion, channel } = readRuntimeVersion();
  const pkgKind = detectPkgKind();
  const target = selectCatalogTarget(catalog, channel);
  const updateAvailable = target !== null && isNewerSemver(target.version, currentVersion);
  const frameworks = target
    ? (Object.keys(target.frameworks) as Array<keyof typeof target.frameworks>)
        .filter((kind) => target.frameworks[kind] !== undefined)
        .map((kind) => ({
          kind: kind as "tarball" | "appimage" | "electron",
          fileName: target.frameworks[kind]!.file_name,
          sizeBytes: target.frameworks[kind]!.size_bytes,
        }))
    : [];
  return {
    currentVersion,
    latestVersion: target?.version ?? currentVersion,
    updateAvailable,
    releaseUrl: "",
    source: "catalog",
    channel,
    pkgKind: pkgKind ?? undefined,
    canSelfUpdate: canSelfUpdate(),
    ...(target ? {
      target: {
        version: target.version,
        channel: target.channel,
        releasedAt: target.released_at,
        frameworks,
      },
    } : {}),
  };
}

async function loadCatalogStatus(catalogUrl: string): Promise<AppUpdateResponse> {
  const cache = getCache();
  if (cache.catalog && cache.catalog.expiresAt > Date.now()) {
    return buildCatalogResponse(cache.catalog.value);
  }
  if (!cache.inFlight) {
    cache.inFlight = loadCatalog(catalogUrl).then((value) => {
      cache.catalog = { value, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS };
      return value;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }
  const catalog = (await cache.inFlight) as UpdateCatalog;
  return buildCatalogResponse(catalog);
}

/* ------------------------- 上游 npm 回落（旧行为，开发场景） ------------------------- */

const NPM_LATEST_URL = "https://registry.npmjs.org/@agegr%2Fpi-web/latest";
const NPM_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

async function fetchNpmLatest(): Promise<AppUpdateResponse> {
  const { version: currentVersion } = readRuntimeVersion();
  const response = await fetch(NPM_LATEST_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);

  const body = await response.json() as { version?: unknown };
  const latestVersion = typeof body.version === "string" ? body.version : "";
  const releaseUrl = getPiWebReleaseUrl(latestVersion);
  if (!releaseUrl) throw new Error("npm registry returned an invalid version");

  return {
    currentVersion,
    latestVersion,
    updateAvailable: isNewerStableVersion(latestVersion, currentVersion),
    releaseUrl,
    source: "npm",
  };
}

async function loadNpmStatus(): Promise<AppUpdateResponse> {
  const cache = getCache();
  if (cache.npm && cache.npm.expiresAt > Date.now()) return cache.npm.value;
  if (!cache.inFlight) {
    cache.inFlight = fetchNpmLatest().then((value) => {
      cache.npm = { value, expiresAt: Date.now() + NPM_CACHE_TTL_MS };
      return value;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }
  try {
    return (await cache.inFlight) as AppUpdateResponse;
  } catch (error) {
    if (cache.npm) return cache.npm.value;
    throw error;
  }
}

export async function GET(req: Request) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  if (SKIP_VERSION_CHECK) {
    const { version, channel } = readRuntimeVersion();
    return NextResponse.json({
      currentVersion: version,
      latestVersion: version,
      updateAvailable: false,
      releaseUrl: "",
      source: "off",
      channel,
    } satisfies AppUpdateResponse);
  }
  const catalogUrl = process.env.AMEDAC_UPDATE_CATALOG_URL?.trim();
  try {
    if (catalogUrl) return NextResponse.json(await loadCatalogStatus(catalogUrl));
    return NextResponse.json(await loadNpmStatus());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
