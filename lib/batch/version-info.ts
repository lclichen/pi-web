/**
 * Version info for batch test results — framework + config bundle versions
 * so test runs can be compared across deployments.
 *
 * Framework version comes from version.json (packaged) or
 * NEXT_PUBLIC_APP_VERSION (dev). Config bundle version comes from the
 * pi-config distribution marker (~/.pi/agent/.bundle-version, written by
 * install-pi-config.sh on deployed machines; absent on dev checkouts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readRuntimeVersion } from "../update-runtime.ts";

export interface BatchVersionInfo {
  /** pi-web framework version (e.g. "0.0.1-alpha"). */
  frameworkVersion: string;
  /** Release channel (e.g. "alpha" | "stable"). */
  frameworkChannel: string;
  /** pi SDK version (e.g. "0.85.1"). */
  piSdkVersion: string;
  /** Config bundle version from install-pi-config marker; null if not deployed. */
  configBundleVersion: string | null;
}

let cached: BatchVersionInfo | null = null;

export function getBatchVersionInfo(): BatchVersionInfo {
  if (cached) return cached;
  const runtime = readRuntimeVersion();

  let piSdkVersion = "unknown";
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
    ) as { version?: string };
    piSdkVersion = pkg.version ?? "unknown";
  } catch {
    // best-effort
  }

  let configBundleVersion: string | null = null;
  try {
    const marker = join(getAgentDir(), ".bundle-version");
    configBundleVersion = readFileSync(marker, "utf8").trim() || null;
  } catch {
    // Dev checkout or un-deployed machine — no bundle marker
  }

  cached = {
    frameworkVersion: runtime.version,
    frameworkChannel: runtime.channel,
    piSdkVersion,
    configBundleVersion,
  };
  return cached;
}
