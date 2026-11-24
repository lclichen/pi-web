/**
 * Per-user sidebar pins (projects and sessions), kept on the server so pins
 * survive reloads, browser storage resets and multiple windows/devices.
 *
 * Host-mode directories and sessions have no ProjectRecord, so both kinds of
 * pin live here instead of on the project record:
 *   - pinnedProjects: stable keys (`project:<id>` / `host:<root>`)
 *   - pinnedSessions: session ids (newest pin first)
 *
 * Legacy per-project `pinnedSessions` are merged in by the API route and are
 * cleared there on unpin.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./mode-homes";
import { JsonStore } from "./state/json-store";
import { legacyDataPath } from "./state/paths";
import type { SidebarPinState } from "./sidebar-state-shared";
import { isSidebarProjectKey } from "./sidebar-state-shared";

const MAX_PINNED_PROJECTS = 500;
const MAX_PINNED_SESSIONS = 2000;
const MAX_PROJECT_ORDER = 500;
const MAX_KEY_LENGTH = 4096;
const MAX_SESSION_ID_LENGTH = 256;

interface SidebarStateData {
  pinnedProjects: string[];
  pinnedSessions: string[];
  projectOrder: string[];
}

function sidebarStore(userId: number): JsonStore<SidebarStateData> {
  return new JsonStore<SidebarStateData>({
    name: "sidebar-state",
    scope: { kind: "user", userId },
    legacyPaths: () => [legacyDataPath("sidebar-state", `u${userId}.json`)],
    defaults: () => ({ pinnedProjects: [], pinnedSessions: [], projectOrder: [] }),
    parse: (value) => sanitize(value),
  });
}

function cleanList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > maxLength || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanProjectKeys(value: unknown): string[] {
  return cleanList(value, MAX_PROJECT_ORDER, MAX_KEY_LENGTH).filter(isSidebarProjectKey);
}

function sanitize(value: unknown): SidebarStateData {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    pinnedProjects: cleanProjectKeys(record.pinnedProjects),
    pinnedSessions: cleanList(record.pinnedSessions, MAX_PINNED_SESSIONS, MAX_SESSION_ID_LENGTH),
    projectOrder: cleanProjectKeys(record.projectOrder),
  };
}

function stateOf(state: SidebarStateData): SidebarPinState {
  return {
    pinnedProjects: state.pinnedProjects,
    pinnedSessions: state.pinnedSessions,
    projectOrder: state.projectOrder,
  };
}

export function readSidebarPins(userId: number): SidebarPinState {
  return stateOf(sidebarStore(userId).read());
}

/** Pin/unpin a project group. A newly pinned key goes to the front. */
export function setPinnedProject(userId: number, key: string, pinned: boolean): SidebarPinState {
  const store = sidebarStore(userId);
  const state = store.update((data) => {
    const projects = Array.isArray(data.pinnedProjects) ? data.pinnedProjects : [];
    data.pinnedProjects = cleanList(
      pinned ? [key, ...projects.filter((entry) => entry !== key)] : projects.filter((entry) => entry !== key),
      MAX_PINNED_PROJECTS,
      MAX_KEY_LENGTH,
    );
  });
  return stateOf(state);
}

/** Pin/unpin a session. A newly pinned id goes to the front. */
export function setPinnedSession(userId: number, sessionId: string, pinned: boolean): SidebarPinState {
  const store = sidebarStore(userId);
  const state = store.update((data) => {
    const sessions = Array.isArray(data.pinnedSessions) ? data.pinnedSessions : [];
    data.pinnedSessions = cleanList(
      pinned ? [sessionId, ...sessions.filter((entry) => entry !== sessionId)] : sessions.filter((entry) => entry !== sessionId),
      MAX_PINNED_SESSIONS,
      MAX_SESSION_ID_LENGTH,
    );
  });
  return stateOf(state);
}

/** Persist the user's drag order for "project first" (keys are stored verbatim). */
export function setProjectOrder(userId: number, order: readonly string[]): SidebarPinState {
  const store = sidebarStore(userId);
  const state = store.update((data) => {
    data.projectOrder = cleanProjectKeys(order);
  });
  return stateOf(state);
}

/** New project creation: put its group at the front without pinning it. */
export function moveProjectToFront(userId: number, key: string): SidebarPinState {
  const store = sidebarStore(userId);
  const state = store.update((data) => {
    const order = cleanProjectKeys(data.projectOrder).filter((entry) => entry !== key);
    data.projectOrder = [key, ...order].slice(0, MAX_PROJECT_ORDER);
  });
  return stateOf(state);
}

/**
 * Project deletion: remove the project from every user's pin and drag order.
 * Returns how many users had either entry.
 */
export function removeProjectPinsEverywhere(projectId: string): number {
  const key = `project:${projectId}`;
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(join(dataDir(), "state", "users"), { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^u(\d+)$/.exec(entry.name);
    if (!match) continue;
    const userId = Number(match[1]);
    const pins = readSidebarPins(userId);
    const had = pins.pinnedProjects.includes(key) || pins.projectOrder.includes(key);
    if (!had) continue;
    if (pins.pinnedProjects.includes(key)) setPinnedProject(userId, key, false);
    if (pins.projectOrder.includes(key)) {
      setProjectOrder(
        userId,
        pins.projectOrder.filter((entry) => entry !== key),
      );
    }
    removed += 1;
  }
  return removed;
}
