/**
 * Pure ordering helpers for the sidebar's project/host groups.
 *
 * Pinned groups always come first (in pin order). The rest follow the view
 * menu's sort mode:
 *   - project:    newest session first, connection type ignored.
 *   - connection: connection types ordered by their newest session, then the
 *                 projects inside each type by their newest session.
 */

import type { SidebarSortMode } from "./sidebar-state-shared";

export interface SortableSidebarGroup {
  key: string;
  name: string;
  /** Project mode ("sandbox" / "local-machine" / "ssh" / "host"). */
  mode: string;
  /** ISO timestamp of the group's newest session ("" when it has none). */
  latest: string;
  pinned: boolean;
  /** Index in the server's pinnedProjects array; -1 when not pinned. */
  pinRank: number;
}

function timeOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function compareActivity(a: SortableSidebarGroup, b: SortableSidebarGroup): number {
  const left = timeOf(a.latest);
  const right = timeOf(b.latest);
  if (left === right) return a.name.localeCompare(b.name);
  return left > right ? -1 : 1;
}

/** Sort groups for the sidebar view menu. Never mutates the input. */
export function sortSidebarGroups<T extends SortableSidebarGroup>(
  groups: readonly T[],
  sortMode: SidebarSortMode,
): T[] {
  const modeOrder = new Map<string, number>();
  if (sortMode === "connection") {
    const latestByMode = new Map<string, number>();
    for (const group of groups) {
      const latest = timeOf(group.latest);
      const current = latestByMode.get(group.mode);
      if (current === undefined || latest > current) latestByMode.set(group.mode, latest);
    }
    [...latestByMode.entries()]
      .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1))
      .forEach(([mode], index) => modeOrder.set(mode, index));
  }

  return [...groups].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      const leftRank = a.pinRank < 0 ? Number.MAX_SAFE_INTEGER : a.pinRank;
      const rightRank = b.pinRank < 0 ? Number.MAX_SAFE_INTEGER : b.pinRank;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return compareActivity(a, b);
    }
    if (sortMode === "connection") {
      const leftMode = modeOrder.get(a.mode) ?? Number.MAX_SAFE_INTEGER;
      const rightMode = modeOrder.get(b.mode) ?? Number.MAX_SAFE_INTEGER;
      if (leftMode !== rightMode) return leftMode - rightMode;
    }
    return compareActivity(a, b);
  });
}

/** True when at least one expandable group is currently open. */
export function anySidebarGroupExpanded(groupKeys: readonly string[], collapsed: ReadonlySet<string>): boolean {
  return groupKeys.some((key) => !collapsed.has(key));
}

/** Apply "collapse all" / "expand all" to exactly the given group keys. */
export function setAllSidebarGroups(
  collapsed: ReadonlySet<string>,
  groupKeys: readonly string[],
  collapse: boolean,
): Set<string> {
  const next = new Set(collapsed);
  for (const key of groupKeys) {
    if (collapse) next.add(key);
    else next.delete(key);
  }
  return next;
}
