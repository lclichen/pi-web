import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { dataDir } from "./mode-homes";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * Per-user settings (data/user-settings/u<id>.json).
 *
 * Unlike workspace preferences (.pi/web-preferences.json, shared by everyone
 * in a cwd) or server settings (deployment-wide), these belong to ONE login:
 * flipping a switch here never changes another user's experience. Per-user
 * files also keep concurrent writes by different users from clobbering each
 * other in a single JSON store.
 */

export interface UserSettings {
  /** Ask auto-continue: unanswered extension questions (ask_user_question,
   *  plan approval, any ui.select/confirm/input dialog without an explicit
   *  timeout) settle with their default value after askAutoContinueTimeoutMs.
   *  Off (default) = interactive dialogs wait for the user indefinitely. */
  askAutoContinue: boolean;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  askAutoContinue: false,
};

/** Grace period so a stale countdown never outlives the dialog pipeline. */
const MIN_ASK_TIMEOUT_MS = 5_000;

/** How long an unanswered question waits before auto-continuing when the
 *  user's askAutoContinue switch is on. Deployment-level default: 5 minutes
 *  (PI_WEB_ASK_TIMEOUT_MS). Read per call so tests and env reloads apply
 *  without a process restart. */
export function askAutoContinueTimeoutMs(): number {
  const raw = Number(process.env.PI_WEB_ASK_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 300_000;
  return Math.max(MIN_ASK_TIMEOUT_MS, Math.floor(raw));
}

declare global {
  var __piUserSettingsStore: Map<string, UserSettings> | undefined;
}

function storePath(userId: number): string {
  return join(dataDir(), "user-settings", `u${userId}.json`);
}

function storeCache(): Map<string, UserSettings> {
  if (!globalThis.__piUserSettingsStore) {
    globalThis.__piUserSettingsStore = new Map();
  }
  return globalThis.__piUserSettingsStore;
}

export function getUserSettings(userId: number): UserSettings {
  const path = storePath(userId);
  const cache = storeCache();
  const cached = cache.get(path);
  if (cached) return cached;
  let data: UserSettings = { ...DEFAULT_USER_SETTINGS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object") {
      const askAutoContinue = (parsed as { askAutoContinue?: unknown }).askAutoContinue;
      if (typeof askAutoContinue === "boolean") data = { askAutoContinue };
    }
  } catch {
    // missing or malformed store — defaults apply
  }
  cache.set(path, data);
  return data;
}

/** Per-user dialog timeout for the rpc-manager UI pipeline: undefined = wait
 *  indefinitely (switch off / auth-off default), a duration otherwise. */
export function askAutoContinueMsFor(userId: number): number | undefined {
  if (!getUserSettings(userId).askAutoContinue) return undefined;
  return askAutoContinueTimeoutMs();
}

export function updateUserSettings(userId: number, patch: { askAutoContinue?: boolean }): UserSettings {
  const next: UserSettings = { ...getUserSettings(userId), ...patch };
  mkdirSync(join(dataDir(), "user-settings"), { recursive: true });
  writePrivateFileAtomicSync(storePath(userId), JSON.stringify(next, null, 2));
  storeCache().set(storePath(userId), next);
  return next;
}
