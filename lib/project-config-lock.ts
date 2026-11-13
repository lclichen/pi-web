import { mkdirSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { dataDir } from "./mode-homes";

/**
 * Per-project configuration lock.
 *
 * Writers (workspace-config-sync apply/rollback, bundle apply, settings,
 * models/MCP/sandbox config, project PATCH) take the write lock; session
 * start/restore takes the read lock while the ResourceLoader loads `.pi`, so a
 * running apply can never be observed as a mixed old/new config.
 *
 * Cross-process writers are excluded with proper-lockfile on a per-project
 * lock directory. The in-process RW lock additionally lets concurrent session
 * starts proceed in parallel (read) while a single writer waits.
 */

export class ProjectConfigLockBusyError extends Error {
  constructor(projectId: string) {
    super(`项目配置正在被另一个进程修改（${projectId}），请稍后重试`);
    this.name = "ProjectConfigLockBusyError";
  }
}

interface Waiter {
  type: "read" | "write";
  resolve: (release: () => void) => void;
}

class ProjectRwLock {
  private readers = 0;
  private writer = false;
  private queue: Waiter[] = [];

  acquire(type: "read" | "write"): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push({ type, resolve });
      this.pump();
    });
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next.type === "read") {
        if (this.writer) return;
        this.queue.shift();
        this.readers += 1;
        next.resolve(() => {
          this.readers = Math.max(0, this.readers - 1);
          this.pump();
        });
      } else {
        if (this.writer || this.readers > 0) return;
        this.queue.shift();
        this.writer = true;
        next.resolve(() => {
          this.writer = false;
          this.pump();
        });
      }
    }
  }
}

const rwLocks = new Map<string, ProjectRwLock>();

function rwLock(projectId: string): ProjectRwLock {
  let lock = rwLocks.get(projectId);
  if (!lock) {
    lock = new ProjectRwLock();
    rwLocks.set(projectId, lock);
  }
  return lock;
}

function safeProjectId(projectId: string): string {
  return projectId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function projectLockDir(projectId: string, rootDir = dataDir()): string {
  return join(rootDir, "locks", safeProjectId(projectId));
}

/** Read lock: concurrent session starts/restores; blocked while an apply runs. */
export async function withProjectConfigReadLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const release = await rwLock(projectId).acquire("read");
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Raw read-lock handle for long-lived phases (session start's ResourceLoader). */
export function acquireProjectConfigReadLock(projectId: string): Promise<() => void> {
  return rwLock(projectId).acquire("read");
}

/**
 * Write lock: one config writer per project across processes. Fails fast
 * (ELOCKED) instead of queuing a user action behind a stuck writer.
 */
export async function withProjectConfigWriteLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  // Queue on the in-process writer first so same-process writers serialize and
  // a writer is ordered before readers that arrive after it. The file lock is
  // only for cross-process exclusion and fails fast (ELOCKED).
  const releaseRw = await rwLock(projectId).acquire("write");
  try {
    const lockDir = projectLockDir(projectId);
    mkdirSync(lockDir, { recursive: true });
    let releaseFile: (() => Promise<void>) | undefined;
    try {
      releaseFile = await lockfile.lock(lockDir, {
        realpath: false,
        stale: 30_000,
        retries: 0,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOCKED") throw new ProjectConfigLockBusyError(projectId);
      throw err;
    }
    try {
      return await operation();
    } finally {
      await releaseFile().catch(() => {
        // stale lock cleanup is best-effort; proper-lockfile's stale window
        // releases it if the process dies
      });
    }
  } finally {
    releaseRw();
  }
}
