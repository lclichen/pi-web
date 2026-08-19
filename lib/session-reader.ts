import {
  SessionManager,
  buildContextEntries as piBuildContextEntries,
  buildSessionContext as piBuildSessionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { closeSync, openSync, readSync } from "fs";
import { normalize as normalizePath } from "path";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { sessionPathKey } from "./session-path";
import { isPathInSpace, spaceDir, spaceKey, type SessionSpace } from "./session-spaces";
import { resolveProject, type ProjectInfo } from "./worktree";

export { getAgentDir };

async function loadAllSessions(space: SessionSpace = { kind: "host" }): Promise<SessionInfo[]> {
  // User shards list their own directory; the host space lists the global
  // root (the users/ shard itself holds no session files directly, so it
  // never leaks into the host listing).
  const piSessions: PiSessionInfo[] = space.kind === "host"
    ? await SessionManager.listAll()
    : await SessionManager.listAll(spaceDir(space));
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(sessionPathKey(s.path), s.id);

  // Resolve each unique cwd to its project root (main repo shared by all
  // worktrees). resolveProject caches per-cwd, so this is cheap after warmup.
  const uniqueCwds = [...new Set(piSessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  return piSessions.map((s) => {
    cacheSessionPath(s.id, s.path);
    const project = s.cwd ? projectByCwd.get(s.cwd) : undefined;
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath ? pathToId.get(sessionPathKey(s.parentSessionPath)) : undefined,
      projectRoot: project?.projectRoot ?? s.cwd,
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    };
  });
}

export async function listAllSessions(space: SessionSpace = { kind: "host" }): Promise<SessionInfo[]> {
  const key = spaceKey(space);
  const bundle = spaceBundle(key);
  const generation = bundle.listGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (bundle.listCache && Date.now() - bundle.listCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return bundle.listCache.data;
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (bundle.listPromise && bundle.listPromiseGeneration === generation) {
    return bundle.listPromise;
  }

  const loadPromise = loadAllSessions(space).then((data) => {
    // An invalidation may happen while the scan is in flight. Do not let that
    // older result repopulate the cache after a session mutation.
    if ((bundle.listGeneration ?? 0) === generation) {
      bundle.listCache = { data, ts: Date.now() };
    }
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (bundle.listPromise === trackedPromise) {
      bundle.listPromise = undefined;
      bundle.listPromiseGeneration = undefined;
    }
  });

  bundle.listPromise = trackedPromise;
  bundle.listPromiseGeneration = generation;
  return trackedPromise;
}

// ============================================================================
// Session path caches, stored on globalThis for hot-reload safety
// (see SpaceCacheBundle above — one bundle per session space).
// ============================================================================

const SESSION_LIST_CACHE_TTL_MS = 30_000;

interface SpaceCacheBundle {
  listCache?: { data: SessionInfo[]; ts: number };
  listPromise?: Promise<SessionInfo[]>;
  listPromiseGeneration?: number;
  listGeneration?: number;
  pathCache: Map<string, string>;
  idToPathCache: Map<string, string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __piSessionSpaceCaches: Map<string, SpaceCacheBundle> | undefined;
}

function spaceBundle(key: string): SpaceCacheBundle {
  if (!globalThis.__piSessionSpaceCaches) {
    globalThis.__piSessionSpaceCaches = new Map();
  }
  let bundle = globalThis.__piSessionSpaceCaches.get(key);
  if (!bundle) {
    bundle = { pathCache: new Map(), idToPathCache: new Map() };
    globalThis.__piSessionSpaceCaches.set(key, bundle);
  }
  return bundle;
}

export function invalidateSessionListCache(space?: SessionSpace): void {
  if (space) {
    const bundle = spaceBundle(spaceKey(space));
    bundle.listGeneration = (bundle.listGeneration ?? 0) + 1;
    bundle.listCache = undefined;
    return;
  }
  for (const bundle of globalThis.__piSessionSpaceCaches?.values() ?? []) {
    bundle.listGeneration = (bundle.listGeneration ?? 0) + 1;
    bundle.listCache = undefined;
  }
}

export async function resolveSessionPath(sessionId: string, space: SessionSpace = { kind: "host" }): Promise<string | null> {
  const bundle = spaceBundle(spaceKey(space));
  const cached = bundle.pathCache.get(sessionId);
  if (cached) return isPathInSpace(cached, space) ? cached : null;

  // Cache miss: scan the space to populate its cache, then retry
  await listAllSessions(space);
  const resolved = bundle.pathCache.get(sessionId);
  if (!resolved) return null;
  return isPathInSpace(resolved, space) ? resolved : null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  for (const bundle of globalThis.__piSessionSpaceCaches?.values() ?? []) {
    const cached = bundle.idToPathCache.get(pathKey);
    if (cached) return cached;
  }

  await listAllSessions();
  const host = spaceBundle("host");
  return host.idToPathCache.get(pathKey);
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  for (const bundle of globalThis.__piSessionSpaceCaches?.values() ?? []) {
    const pathCache = bundle.pathCache;
    const reverseCache = bundle.idToPathCache;
    const previousPath = pathCache.get(sessionId);
    const previousPathKey = previousPath ? sessionPathKey(previousPath) : undefined;
    const previousSessionId = reverseCache.get(pathKey);
    const previousOwnerPath = previousSessionId ? pathCache.get(previousSessionId) : undefined;
    if (previousPathKey && previousPathKey !== pathKey && reverseCache.get(previousPathKey) === sessionId) {
      reverseCache.delete(previousPathKey);
    }
    if (
      previousSessionId &&
      previousSessionId !== sessionId &&
      previousOwnerPath &&
      sessionPathKey(previousOwnerPath) === pathKey
    ) {
      pathCache.delete(previousSessionId);
    }
    pathCache.set(sessionId, normalizedPath);
    reverseCache.set(pathKey, sessionId);
  }
}

export function invalidateSessionPathCache(sessionId: string): void {
  for (const bundle of globalThis.__piSessionSpaceCaches?.values() ?? []) {
    const pathCache = bundle.pathCache;
    const reverseCache = bundle.idToPathCache;
    const filePath = pathCache.get(sessionId);
    pathCache.delete(sessionId);
    const pathKey = filePath ? sessionPathKey(filePath) : undefined;
    if (pathKey && reverseCache.get(pathKey) === sessionId) {
      reverseCache.delete(pathKey);
    }
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const maxHeaderBytes = 64 * 1024;
    let position = 0;
    let foundNewline = false;

    while (position < maxHeaderBytes && !foundNewline) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxHeaderBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const data = buffer.subarray(0, bytesRead);
      const newlineIndex = data.indexOf(0x0a);
      chunks.push(newlineIndex === -1 ? data : data.subarray(0, newlineIndex));
      position += bytesRead;
      foundNewline = newlineIndex !== -1;
    }

    if (!foundNewline && position >= maxHeaderBytes) return null;
    const firstLine = Buffer.concat(chunks).toString("utf8").trimEnd();
    if (!firstLine) return null;
    try {
      const header = JSON.parse(firstLine) as SessionHeader;
      return header.type === "session" ? header : null;
    } catch {
      return null;
    }
  } finally {
    closeSync(fd);
  }
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {},
): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  const contextEntries = piBuildContextEntries(
    piEntries,
    leafId,
    byId as unknown as Map<string, PiSessionEntry>,
  );

  // Convert the SDK-selected context entries and their IDs together. This keeps
  // fork/navigation targets aligned while preserving pi's compaction ordering.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of contextEntries) {
    const localEntry = entry as unknown as SessionEntry;
    const m = entryToUiMessage(localEntry, options);
    if (m) {
      messages.push(m);
      entryIds.push(localEntry.id);
    }
  }

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function omitToolResultBase64Images(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      const message = options.deferToolResultImages
        ? omitToolResultBase64Images(normalizeToolCalls(entry.message))
        : normalizeToolCalls(entry.message);
      if (!options.deferThinking || message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
