/**
 * Sidebar pin/sort/view constants shared by the client component and the
 * server store. Zero imports so client bundles and node tests can load it.
 */

export type SidebarSortMode = "project" | "connection";

export interface SidebarPinState {
  /** Stable group keys: `project:<ProjectRecord id>` / `host:<directory root>`. */
  pinnedProjects: string[];
  /** Pinned session ids, newest pin first. */
  pinnedSessions: string[];
}

export const SIDEBAR_SORT_STORAGE_KEY = "pi-web:sidebar-sort-mode-v1";
export const SIDEBAR_UNREAD_ONLY_STORAGE_KEY = "pi-web:sidebar-unread-only-v1";

const PROJECT_PIN_PREFIX = "project:";
const HOST_PIN_PREFIX = "host:";

export function projectPinKey(projectId: string): string {
  return `${PROJECT_PIN_PREFIX}${projectId}`;
}

export function hostPinKey(root: string): string {
  return `${HOST_PIN_PREFIX}${root}`;
}

export function isSidebarProjectKey(value: string): boolean {
  return value.startsWith(PROJECT_PIN_PREFIX) || value.startsWith(HOST_PIN_PREFIX);
}
