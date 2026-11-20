import { JsonStore } from "./state/json-store";
import { legacyDataPath } from "./state/paths";

/**
 * Per-user settings (data/state/users/u<id>/user-settings.json).
 *
 * Unlike workspace preferences (.pi/web-preferences.json, shared by everyone
 * in a cwd) or server settings (deployment-wide), these belong to ONE login:
 * flipping a switch here never changes another user's experience. Per-user
 * files also keep concurrent writes by different users from clobbering each
 * other in a single JSON store.
 */

export interface UserSettingsUi {
  theme?: "light" | "dark" | "auto";
  locale?: string;
  chatWidth?: number;
  chatFontSize?: number;
  thinkingExpanded?: boolean;
  quoteSelection?: boolean;
}

export interface UserSettings {
  /** Ask auto-continue: unanswered extension questions (ask_user_question,
   *  plan approval, any ui.select/confirm/input dialog without an explicit
   *  timeout) settle with their default value after askAutoContinueTimeoutMs.
   *  Off (default) = interactive dialogs wait for the user indefinitely. */
  askAutoContinue: boolean;
  /** Browser-experience defaults that should follow the login across devices. */
  ui: UserSettingsUi;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  askAutoContinue: false,
  ui: {},
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

function parseUserSettings(value: unknown): UserSettings | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { askAutoContinue?: unknown; ui?: unknown };
  const ui: UserSettingsUi = {};
  if (raw.ui !== null && typeof raw.ui === "object" && !Array.isArray(raw.ui)) {
    const entry = raw.ui as Record<string, unknown>;
    if (entry.theme === "light" || entry.theme === "dark" || entry.theme === "auto") ui.theme = entry.theme;
    if (typeof entry.locale === "string") ui.locale = entry.locale;
    if (typeof entry.chatWidth === "number" && Number.isFinite(entry.chatWidth)) ui.chatWidth = entry.chatWidth;
    if (typeof entry.chatFontSize === "number" && Number.isFinite(entry.chatFontSize)) {
      ui.chatFontSize = entry.chatFontSize;
    }
    if (typeof entry.thinkingExpanded === "boolean") ui.thinkingExpanded = entry.thinkingExpanded;
    if (typeof entry.quoteSelection === "boolean") ui.quoteSelection = entry.quoteSelection;
  }
  return {
    askAutoContinue: typeof raw.askAutoContinue === "boolean" ? raw.askAutoContinue : false,
    ui,
  };
}

function userSettingsStore(userId: number): JsonStore<UserSettings> {
  return new JsonStore<UserSettings>({
    name: "user-settings",
    scope: { kind: "user", userId },
    legacyPaths: () => [legacyDataPath("user-settings", `u${userId}.json`)],
    defaults: () => ({ ...DEFAULT_USER_SETTINGS, ui: {} }),
    statTtlMs: 250,
    parse: parseUserSettings,
  });
}

export function getUserSettings(userId: number): UserSettings {
  return userSettingsStore(userId).read();
}

/** Per-user dialog timeout for the rpc-manager UI pipeline: undefined = wait
 *  indefinitely (switch off / auth-off default), a duration otherwise. */
export function askAutoContinueMsFor(userId: number): number | undefined {
  if (!getUserSettings(userId).askAutoContinue) return undefined;
  return askAutoContinueTimeoutMs();
}

export function updateUserSettings(
  userId: number,
  patch: { askAutoContinue?: boolean; ui?: Partial<UserSettingsUi> },
): UserSettings {
  return userSettingsStore(userId).update((current) => {
    return {
      ...current,
      ...(patch.askAutoContinue !== undefined ? { askAutoContinue: patch.askAutoContinue } : {}),
      ui: patch.ui ? { ...current.ui, ...patch.ui } : current.ui,
    };
  });
}
