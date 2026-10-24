/**
 * Local client (agent-client) version contract.
 *
 * The WebUI pins the minimum client version it can drive. Checks happen in
 * two places:
 *   1. pairing (`/pair/exchange`) — an outdated download is rejected before it
 *      ever gets a token;
 *   2. runtime (`hello` → registry/status, plus project/batch routes) — a
 *      client that was upgraded server-side after pairing is flagged
 *      incompatible instead of silently misbehaving.
 *
 * Bump REQUIRED_CLIENT_VERSION whenever the relay protocol or the WebUI's
 * expectations change. Keep the Go constant `version` in agent/main.go in
 * sync (the client reports it in pair/hello).
 */
export const CLIENT_NAME = "agent-client";
export const REQUIRED_CLIENT_VERSION = "0.3.0";

export interface ClientCompatibility {
  compatible: boolean;
  version?: string;
  requiredVersion: string;
  message?: string;
}

/** Parse "0.2.1" / "v0.2.1" into comparable numbers. */
export function parseClientVersion(raw: string | null | undefined): [number, number, number] | null {
  if (!raw) return null;
  const match = /^[vV]?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareClientVersions(a: string, b: string): number {
  const pa = parseClientVersion(a);
  const pb = parseClientVersion(b);
  if (!pa || !pb) return Number.NaN;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function clientCompatibility(version: string | null | undefined): ClientCompatibility {
  const parsed = parseClientVersion(version);
  if (!parsed) {
    return {
      compatible: false,
      requiredVersion: REQUIRED_CLIENT_VERSION,
      message: `无法识别客户端版本${version ? `（${version}）` : ""}；请下载最新 ${CLIENT_NAME}（需要 ≥ ${REQUIRED_CLIENT_VERSION}）`,
    };
  }
  const compatible = compareClientVersions(version!, REQUIRED_CLIENT_VERSION) >= 0;
  return {
    compatible,
    version: version ?? undefined,
    requiredVersion: REQUIRED_CLIENT_VERSION,
    ...(compatible
      ? {}
      : { message: `客户端版本过低（${version}），需要 ≥ ${REQUIRED_CLIENT_VERSION}；请重新下载 ${CLIENT_NAME}` }),
  };
}

/** Installer asset filename for a host OS/arch (served by the download route). */
export function clientAssetName(os: string, arch = "amd64"): string {
  const normalizedOs = os.toLowerCase();
  const normalizedArch = arch.toLowerCase() === "arm64" || arch.toLowerCase() === "aarch64" ? "arm64" : "amd64";
  if (normalizedOs.startsWith("win")) return `agent-client-windows-${normalizedArch}.exe`;
  if (normalizedOs.includes("darwin") || normalizedOs.includes("mac")) return `agent-client-darwin-${normalizedArch}`;
  return `agent-client-linux-${normalizedArch}`;
}
