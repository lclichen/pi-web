import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { dataDir } from "./mode-homes";
import type { SessionMode } from "./session-modes";

/**
 * Sidecar metadata for sessions created through pi-web: execution mode and
 * owning user. The pi session files themselves carry neither, and the
 * in-memory registry only covers live sessions — this store fills the gap
 * for list rendering after reloads. Registry entries win when both exist.
 */

export interface SessionMeta {
  mode: SessionMode;
  ownerId: number;
  /** Owning project (project-scoped sessions). */
  projectId?: string;
  ownerName?: string;
  createdAt?: number;
}

interface MetaFile {
  version: 1;
  sessions: Record<string, SessionMeta>;
}

declare global {
  // eslint-disable-next-line no-var
  var __piSessionMetas: { path: string; data: MetaFile } | undefined;
}

function store(): { path: string; data: MetaFile } {
  if (!globalThis.__piSessionMetas || globalThis.__piSessionMetas.path !== metaFilePath()) {
    let data: MetaFile = { version: 1, sessions: {} };
    try {
      const raw = readFileSync(metaFilePath(), "utf8");
      const parsed = JSON.parse(raw) as MetaFile;
      if (parsed && parsed.sessions) data = parsed;
    } catch {
      // fresh store
    }
    globalThis.__piSessionMetas = { path: metaFilePath(), data };
  }
  return globalThis.__piSessionMetas;
}

function metaFilePath(): string {
  return join(dataDir(), "session-metas.json");
}

export function recordSessionMeta(sessionId: string, meta: SessionMeta): void {
  const s = store();
  s.data.sessions[sessionId] = { ...meta, createdAt: meta.createdAt ?? Date.now() };
  try {
    writeFileSync(s.path, JSON.stringify(s.data, null, 2), "utf8");
  } catch {
    // metadata is best-effort
  }
}

export function getSessionMetas(): Record<string, SessionMeta> {
  return store().data.sessions;
}

export function getSessionMeta(sessionId: string): SessionMeta | undefined {
  return store().data.sessions[sessionId];
}

/** Sessions a user may see in listings: their own plus (admin) host-space ones. */
export function metaVisibleTo(meta: SessionMeta | undefined, ownerId: number, role: "admin" | "user", viewingHostSpace: boolean): boolean {
  if (!meta) return viewingHostSpace || role === "admin"; // unknown provenance: only host/admin view
  if (viewingHostSpace) return role === "admin" || meta.ownerId === ownerId;
  return meta.ownerId === ownerId;
}
