import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile } from "./atomic-write";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isUserScopedConfig, userSettingsDiffPath } from "./user-config";

type Scope = "global" | "project";
type LockFn = (current: string | undefined) => string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return result;
}

/** Everything in `next` that differs from `base`; nested objects recurse. */
function diffFrom(base: unknown, next: unknown): unknown | undefined {
  if (next === undefined) return undefined;
  if (isRecord(base) && isRecord(next)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      const child = diffFrom(base[key], value);
      if (child !== undefined) out[key] = child;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return JSON.stringify(base) === JSON.stringify(next) ? undefined : next;
}

function ensureLockTarget(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, "{}\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function withLock<T>(path: string, fn: () => T): T {
  ensureLockTarget(path);
  let release: (() => void) | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      release = lockfile.lockSync(path, { realpath: false });
      break;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ELOCKED" || attempt === 9) throw error;
      const start = Date.now();
      while (Date.now() - start < 20) {
        // Synchronous retry, matching the SDK's FileSettingsStorage.
      }
    }
  }
  if (!release) throw lastError instanceof Error ? lastError : new Error("Failed to acquire settings lock");
  try {
    return fn();
  } finally {
    release();
  }
}

/**
 * SettingsStorage for a web user:
 *   - global reads = deepMerge(global settings.json, user diff)
 *   - global writes = only the diff against the real global file
 *   - project reads/writes = the normal project .pi/settings.json
 *
 * The resource loader still receives the real global agentDir, so installed
 * skills/extensions stay shared; only settings are personalized.
 */
export class UserSettingsStorage {
  private readonly globalPath: string;
  private readonly userPath: string;
  private readonly projectPath: string;

  constructor(cwd: string, userId: number, globalAgentDir = getAgentDir()) {
    this.globalPath = join(globalAgentDir, "settings.json");
    this.userPath = userSettingsDiffPath(userId);
    this.projectPath = join(cwd, ".pi", "settings.json");
  }

  withLock(scope: Scope, fn: LockFn): void {
    if (scope === "project") {
      // Do not create `.pi/settings.json` just by reading: its existence is a
      // project-trust signal. Only lock/create when a write is requested.
      if (!existsSync(this.projectPath)) {
        const next = fn(undefined);
        if (next !== undefined) {
          ensureLockTarget(this.projectPath);
          withLock(this.projectPath, () => {
            atomicWriteFile(this.projectPath, next);
          });
        }
        return;
      }
      withLock(this.projectPath, () => {
        const current = readFileSync(this.projectPath, "utf8");
        const next = fn(current);
        if (next !== undefined) atomicWriteFile(this.projectPath, next);
      });
      return;
    }

    const writeDiff = () => {
      const global = readJson(this.globalPath);
      const user = readJson(this.userPath);
      const merged = deepMerge(global, user);
      const nextRaw = fn(JSON.stringify(merged));
      if (nextRaw === undefined) return;
      let next: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(nextRaw);
        next = isRecord(parsed) ? parsed : {};
      } catch {
        return;
      }
      const diff = diffFrom(global, next);
      writePrivateFileAtomicSync(this.userPath, `${JSON.stringify(diff ?? {}, null, 2)}\n`);
    };

    // A missing user diff is a read-only merge; don't create an empty file on
    // every session startup. Writes create it under the lock.
    if (!existsSync(this.userPath)) {
      const global = readJson(this.globalPath);
      const nextRaw = fn(JSON.stringify(global));
      if (nextRaw === undefined) return;
      ensureLockTarget(this.userPath);
      withLock(this.userPath, () => {
        const globalAgain = readJson(this.globalPath);
        const parsed: unknown = JSON.parse(nextRaw);
        const next = isRecord(parsed) ? parsed : {};
        const diff = diffFrom(globalAgain, next);
        writePrivateFileAtomicSync(this.userPath, `${JSON.stringify(diff ?? {}, null, 2)}\n`);
      });
      return;
    }

    withLock(this.userPath, writeDiff);
  }
}

/** Merge a raw pi-settings patch into one user's diff file. */
export function updateUserAgentSettings(
  userId: number,
  patch: Record<string, unknown>,
): void {
  if (!isUserScopedConfig(userId)) return;
  const path = userSettingsDiffPath(userId);
  withLock(path, () => {
    const next = deepMerge(readJson(path), patch);
    writePrivateFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`);
  });
}

/**
 * A SettingsManager whose global layer is global settings + this user's diff.
 * Auth-off (user id 0) keeps the plain global manager.
 */
export function createUserSettingsManager(
  cwd: string,
  userId: number,
  options: { projectTrusted?: boolean; agentDir?: string } = {},
): SettingsManager {
  const globalAgentDir = options.agentDir ?? getAgentDir();
  if (!isUserScopedConfig(userId)) {
    return SettingsManager.create(cwd, globalAgentDir, { projectTrusted: options.projectTrusted });
  }
  const storage = new UserSettingsStorage(cwd, userId, globalAgentDir);
  return SettingsManager.fromStorage(storage as never, { projectTrusted: options.projectTrusted });
}
