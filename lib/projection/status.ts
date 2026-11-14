import { readFileSync } from "node:fs";
import { atomicWriteFileAsync } from "../atomic-write";
import { statusPath } from "./manifest";

/** Last reconcile result, exposed to the project "workspace sync status" UI. */
export interface ProjectionStatus {
  updatedAt: string;
  hostDigest: string;
  durationMs: number;
  timedOut: boolean;
  pushed: string[];
  deleted: string[];
  adopted: string[];
  dirty: string[];
  conflicts: string[];
  errors: Array<{ rel: string; error: string }>;
  truncated: { reason: string; skipped: number } | null;
  /** Last full-content attachment verification (stat is the fast path between). */
  lastVerifiedAt: string | null;
}

export function readProjectionStatus(projectId: string, key: string): ProjectionStatus | null {
  try {
    const parsed = JSON.parse(readFileSync(statusPath(projectId, key), "utf8")) as ProjectionStatus;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.pushed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeProjectionStatus(projectId: string, key: string, status: ProjectionStatus): Promise<void> {
  await atomicWriteFileAsync(statusPath(projectId, key), JSON.stringify(status, null, 2), 0o600);
}

export function emptyProjectionStatus(hostDigest = ""): ProjectionStatus {
  return {
    updatedAt: new Date().toISOString(),
    hostDigest,
    durationMs: 0,
    timedOut: false,
    pushed: [],
    deleted: [],
    adopted: [],
    dirty: [],
    conflicts: [],
    errors: [],
    truncated: null,
    lastVerifiedAt: null,
  };
}

/** Compact projection state for project-row badges. */
export interface ProjectionBadgeSummary {
  dirty: number;
  conflicts: number;
  errors: number;
  truncated: { reason: string; skipped: number } | null;
  timedOut: boolean;
  fileCount: number;
  updatedAt: string | null;
  lastVerifiedAt: string | null;
}

export function projectionBadgeSummary(
  status: ProjectionStatus | null,
  fileCount = 0,
): ProjectionBadgeSummary | null {
  if (!status) return null;
  return {
    dirty: status.dirty.length,
    conflicts: status.conflicts.length,
    errors: status.errors.length,
    truncated: status.truncated ?? null,
    timedOut: status.timedOut === true,
    fileCount,
    updatedAt: status.updatedAt ?? null,
    lastVerifiedAt: status.lastVerifiedAt ?? null,
  };
}
