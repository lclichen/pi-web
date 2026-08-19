import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { platformUrl } from "./platform/client";
import type { SessionMode } from "./session-modes";

/**
 * Per-user stub home directories for remote-execution modes (design doc §5).
 *
 * The agent process always runs inside pi-web, so its session needs a local
 * cwd — for sandbox/local-machine sessions that cwd is a synthetic home whose
 * only real content is the per-user channel config:
 *
 *   <data>/sandbox-homes/u<id>/.pi/sandbox-platform.json  (pi-sandbox-extension
 *   reads this project-level config: platform url, the user's API key, chosen
 *   container, and disableLocalFallback).
 *
 * Tool calls never touch these directories — the injected extension routes
 * them to the container / relay, and local fallback is disabled.
 */

export function dataDir(): string {
  const dir = process.env.PI_WEB_DATA_DIR
    ? process.env.PI_WEB_DATA_DIR
    : join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export interface SandboxHomeConfig {
  url: string;
  apiKey: string;
  containerId?: number | string;
  disableLocalFallback: boolean;
}

export function sandboxHomeDir(userId: number): string {
  return join(dataDir(), "sandbox-homes", `u${userId}`);
}

export function localHomeDir(userId: number): string {
  return join(dataDir(), "local-homes", `u${userId}`);
}

export function ensureSandboxHome(userId: number, config: SandboxHomeConfig): string {
  const home = sandboxHomeDir(userId);
  const piDir = join(home, ".pi");
  if (!existsSync(piDir)) mkdirSync(piDir, { recursive: true });
  const current = readSandboxHomeConfig(userId);
  const next: SandboxHomeConfig = { ...current, ...config, url: config.url || current.url, disableLocalFallback: true };
  writeFileSync(
    join(piDir, "sandbox-platform.json"),
    JSON.stringify(next, null, 2),
    "utf8",
  );
  return home;
}

export function readSandboxHomeConfig(userId: number): SandboxHomeConfig {
  try {
    const raw = readFileSync(join(sandboxHomeDir(userId), ".pi", "sandbox-platform.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<SandboxHomeConfig>;
    return {
      url: typeof parsed.url === "string" ? parsed.url : (safePlatformUrl() ?? ""),
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      ...(parsed.containerId !== undefined ? { containerId: parsed.containerId } : {}),
      disableLocalFallback: parsed.disableLocalFallback !== false,
    };
  } catch {
    return { url: safePlatformUrl() ?? "", apiKey: "", disableLocalFallback: true };
  }
}

/** Set (or clear) the pinned container for the user's sandbox sessions. */
export function setSandboxContainer(userId: number, containerId: number | string | null): void {
  const current = readSandboxHomeConfig(userId);
  const next: SandboxHomeConfig = {
    ...current,
    ...(containerId === null
      ? {}
      : { containerId }),
  };
  if (containerId === null) delete next.containerId;
  ensureSandboxHome(userId, next);
}

export function ensureLocalHome(userId: number): string {
  const home = localHomeDir(userId);
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

/** Resolve the stub cwd for a mode (host sessions use the real cwd). */
export function homeForMode(mode: SessionMode, userId: number): string | null {
  if (mode === "sandbox") {
    // ensureSandboxHome needs a config at least once; reuse whatever is there.
    return sandboxHomeDir(userId);
  }
  if (mode === "local-machine") return ensureLocalHome(userId);
  return null;
}

function safePlatformUrl(): string | undefined {
  try {
    return platformUrl();
  } catch {
    return undefined;
  }
}
