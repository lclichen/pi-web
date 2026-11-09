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

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { dataDir } from "./mode-homes";
import type { SidebarPinState } from "./sidebar-state-shared";

const MAX_PINNED_PROJECTS = 500;
const MAX_PINNED_SESSIONS = 2000;
const MAX_KEY_LENGTH = 4096;
const MAX_SESSION_ID_LENGTH = 256;

interface SidebarStateFile {
  version: 1;
  pinnedProjects: string[];
  pinnedSessions: string[];
}

function statePath(userId: number): string {
  return join(dataDir(), "sidebar-state", `u${userId}.json`);
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

function sanitize(value: unknown): SidebarStateFile {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    version: 1,
    pinnedProjects: cleanList(record.pinnedProjects, MAX_PINNED_PROJECTS, MAX_KEY_LENGTH),
    pinnedSessions: cleanList(record.pinnedSessions, MAX_PINNED_SESSIONS, MAX_SESSION_ID_LENGTH),
  };
}

function readState(userId: number): SidebarStateFile {
  try {
    return sanitize(JSON.parse(readFileSync(statePath(userId), "utf8")));
  } catch {
    return { version: 1, pinnedProjects: [], pinnedSessions: [] };
  }
}

function writeState(userId: number, state: SidebarStateFile): SidebarPinState {
  const next = sanitize(state);
  const path = statePath(userId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return { pinnedProjects: next.pinnedProjects, pinnedSessions: next.pinnedSessions };
}

export function readSidebarPins(userId: number): SidebarPinState {
  const state = readState(userId);
  return { pinnedProjects: state.pinnedProjects, pinnedSessions: state.pinnedSessions };
}

/** Pin/unpin a project group. A newly pinned key goes to the front. */
export function setPinnedProject(userId: number, key: string, pinned: boolean): SidebarPinState {
  const state = readState(userId);
  state.pinnedProjects = pinned
    ? [key, ...state.pinnedProjects.filter((entry) => entry !== key)].slice(0, MAX_PINNED_PROJECTS)
    : state.pinnedProjects.filter((entry) => entry !== key);
  return writeState(userId, state);
}

/** Pin/unpin a session. A newly pinned id goes to the front. */
export function setPinnedSession(userId: number, sessionId: string, pinned: boolean): SidebarPinState {
  const state = readState(userId);
  state.pinnedSessions = pinned
    ? [sessionId, ...state.pinnedSessions.filter((entry) => entry !== sessionId)].slice(0, MAX_PINNED_SESSIONS)
    : state.pinnedSessions.filter((entry) => entry !== sessionId);
  return writeState(userId, state);
}
