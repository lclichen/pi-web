/**
 * Unified JSON state store.
 *
 * Every file uses a versioned envelope:
 *
 *   { "schemaVersion": 1, "data": <store payload> }
 *
 * Guarantees for writes:
 *   - cross-process exclusion via proper-lockfile (<dataDir>/locks/state/...)
 *   - previous complete file copied to `<path>.bak`
 *   - temp-file + rename replacement (never a half-written target)
 *   - 0600 file / 0700 directory
 *
 * Legacy files are read once and migrated lazily. They are never written
 * again; keep them for one release so rollback can still inspect the old data.
 * Failures stay best-effort: a damaged store falls back to `.bak`, then the
 * legacy file, then defaults, so a corrupt sidecar cannot break a request.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { atomicWriteFileSync } from "../atomic-write.ts";
import { stateLockPath, statePath, type StateScope } from "./paths.ts";

export const STATE_SCHEMA_VERSION = 1;
const LOCK_RETRIES = 20;
const LOCK_RETRY_MS = 10;

export interface JsonStoreOptions<T> {
  /** Stable file basename under the scope directory (lowercase kebab-case). */
  name: string;
  scope: StateScope;
  /** Validate/normalize the payload; return null when the shape is unusable. */
  parse: (value: unknown) => T | null;
  defaults: () => T;
  /** Legacy locations to read once when the new file is missing/corrupt. */
  legacyPaths?: () => string[];
  /** Re-stat throttle for hot readers (0 = stat every read). */
  statTtlMs?: number;
  /** File mode for the new state file (default 0600). */
  mode?: number;
}

interface Envelope {
  schemaVersion: number;
  data: unknown;
}

interface CacheEntry {
  signature: string;
  lastStatAt: number;
  data: unknown;
}

declare global {
  var __piJsonStateStores: Map<string, CacheEntry> | undefined;
}

function cache(): Map<string, CacheEntry> {
  return (globalThis.__piJsonStateStores ??= new Map());
}

function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return "";
  }
}

function assertEnvelope(value: unknown): Envelope | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== STATE_SCHEMA_VERSION) return null;
  if (!Object.prototype.hasOwnProperty.call(record, "data")) return null;
  return { schemaVersion: STATE_SCHEMA_VERSION, data: record.data };
}

export class JsonStore<T> {
  private readonly options: JsonStoreOptions<T>;

  constructor(options: JsonStoreOptions<T>) {
    this.options = options;
  }

  get path(): string {
    return statePath(this.options.scope, this.options.name);
  }

  read(): T {
    const path = this.path;
    const signature = fileSignature(path);
    const entry = cache().get(path);
    if (entry) {
      const now = Date.now();
      // A hot reader can opt into a short stat TTL; otherwise a signature match
      // is required so writes from another module instance/process are visible.
      if (entry.signature === signature || (this.options.statTtlMs && now - entry.lastStatAt < this.options.statTtlMs)) {
        entry.lastStatAt = now;
        return entry.data as T;
      }
    }

    if (signature) {
      const parsed = this.readEnvelope(path);
      if (parsed !== null) return this.remember(path, signature, parsed);

      const backup = this.readEnvelope(`${path}.bak`);
      if (backup !== null) {
        try {
          this.withLock(() => this.writeData(backup, false));
        } catch {
          // Serve the backup even when repair cannot be persisted.
        }
        return this.remember(path, fileSignature(path), backup);
      }
    }

    const legacy = this.readLegacy();
    if (legacy) {
      const migrated = this.migrateLegacy(legacy.data);
      const migratedSignature = fileSignature(path);
      // If migration could not persist (busy lock / read-only disk), serve the
      // legacy value without caching it forever — a later read should retry.
      return migratedSignature
        ? this.remember(path, migratedSignature, migrated ?? legacy.data)
        : (migrated ?? legacy.data);
    }
    return this.options.defaults();
  }

  /** Read-modify-write under the store lock. The mutator may mutate in place. */
  update(mutator: (current: T) => T | void): T {
    return this.withLock(() => {
      const current = this.loadForUpdate();
      const result = mutator(current);
      const next = result === undefined ? current : result;
      this.writeData(next, true);
      return next;
    });
  }

  write(data: T): T {
    return this.update(() => data);
  }

  invalidate(): void {
    cache().delete(this.path);
  }

  private loadForUpdate(): T {
    const current = this.readEnvelope(this.path);
    if (current !== null) return current;

    const backup = this.readEnvelope(`${this.path}.bak`);
    if (backup !== null) return backup;

    const legacy = this.readLegacy();
    if (legacy) return legacy.data;

    return this.options.defaults();
  }

  private readEnvelope(path: string): T | null {
    try {
      const envelope = assertEnvelope(JSON.parse(readFileSync(path, "utf8")));
      return envelope ? this.options.parse(envelope.data) : null;
    } catch {
      return null;
    }
  }

  private readLegacy(): { data: T; path: string } | null {
    for (const path of this.options.legacyPaths?.() ?? []) {
      if (!path || !existsSync(path)) continue;
      try {
        const data = this.options.parse(JSON.parse(readFileSync(path, "utf8")));
        if (data !== null) return { data, path };
      } catch {
        // Try the next legacy location.
      }
    }
    return null;
  }

  private migrateLegacy(data: T): T | null {
    try {
      return this.withLock(() => {
        // Another process may have completed the migration while we waited.
        const current = this.readEnvelope(this.path);
        if (current !== null) return current;
        this.writeData(data, false);
        return data;
      });
    } catch {
      // Migration is opportunistic; never block a read on a busy lock.
      return null;
    }
  }

  private writeData(data: T, backup: boolean): void {
    const path = this.path;
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Windows / restricted filesystems: best effort.
    }

    if (backup && existsSync(path)) {
      // Only back up a parseable previous version. A corrupt target must not
      // overwrite the last good `.bak`.
      if (this.readEnvelope(path) !== null) {
        try {
          copyFileSync(path, `${path}.bak`);
        } catch {
          // A missing backup is better than failing the primary write.
        }
      }
    }

    const envelope: Envelope = { schemaVersion: STATE_SCHEMA_VERSION, data };
    atomicWriteFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, this.options.mode ?? 0o600);
    this.remember(path, fileSignature(path), data);
  }

  private remember(path: string, signature: string, data: T): T {
    cache().set(path, { signature, lastStatAt: Date.now(), data });
    return data;
  }

  private withLock<R>(fn: () => R): R {
    const lockTarget = stateLockPath(this.options.scope, this.options.name);
    mkdirSync(dirname(lockTarget), { recursive: true, mode: 0o700 });

    let release: (() => void) | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      try {
        release = lockfile.lockSync(lockTarget, { realpath: false, stale: 30_000 });
        break;
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === LOCK_RETRIES - 1) {
          throw error;
        }
        // proper-lockfile forbids sync retries; block briefly like the SDK.
        const until = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < until) {
          // synchronous backoff
        }
      }
    }
    if (!release) {
      throw lastError instanceof Error ? lastError : new Error("Failed to acquire state lock");
    }
    try {
      return fn();
    } finally {
      release();
    }
  }
}

/** Test seam: drop every cached store so the next read goes back to disk. */
export function resetStateStoresForTests(): void {
  cache().clear();
}
