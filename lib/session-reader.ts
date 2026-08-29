import {
  SessionManager,
  buildContextEntries as piBuildContextEntries,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { closeSync, type Dirent, fstatSync, openSync, readSync } from "fs";
import { readdir } from "fs/promises";
import { isAbsolute, join, normalize as normalizePath, relative, resolve as resolvePath, sep } from "path";
import type { AgentMessage, ImageContent, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { projectIdentityKey } from "./project-identity";
import { sessionPathKey } from "./session-path";
import { isPathInSpace, spaceDir, spaceKey, type SessionSpace } from "./session-spaces";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "./tool-result-images";
import { resolveProject, type ProjectInfo } from "./worktree";
import { readSubagentRun, SUBAGENT_META_TYPE } from "./subagents";

export { getAgentDir };

const SESSION_HEADER_MAX_BYTES = 64 * 1024;
const SESSION_RELATION_MAX_BYTES = 256 * 1024;
const SESSION_RELATION_MAX_LINES = 2;
const SESSION_RESULT_MAX_BYTES = 256 * 1024;

function readBoundedLines(filePath: string, maxBytes: number, maxLines: number): string[] {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    let newlineCount = 0;
    let reachedEof = false;

    while (position < maxBytes && newlineCount < maxLines) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }
      position += bytesRead;
      const data = buffer.subarray(0, bytesRead);
      let end = data.length;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0a) continue;
        newlineCount += 1;
        if (newlineCount === maxLines) {
          end = index + 1;
          break;
        }
      }
      chunks.push(data.subarray(0, end));
    }

    const source = Buffer.concat(chunks).toString("utf8");
    const lines = source.split("\n");
    if (!reachedEof && !source.endsWith("\n")) lines.pop();
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  } finally {
    closeSync(fd);
  }
}

function readBoundedTailLines(filePath: string, maxBytes: number): string[] {
  const fd = openSync(filePath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const start = Math.max(0, fileSize - maxBytes);
    const buffer = Buffer.allocUnsafe(fileSize - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    if (bytesRead === 0) return [];

    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) {
      const previousByte = Buffer.allocUnsafe(1);
      readSync(fd, previousByte, 0, 1, start - 1);
      if (previousByte[0] !== 0x0a) lines.shift();
    }
    if (lines.at(-1) === "") lines.pop();
    return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  } finally {
    closeSync(fd);
  }
}

function parseSessionEntries(lines: readonly string[]): SessionEntry[] {
  return lines.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as SessionEntry;
      return [entry];
    } catch {
      return [];
    }
  });
}

function readSessionRelationEntries(filePath: string): SessionEntry[] {
  const prefixEntries = parseSessionEntries(
    readBoundedLines(filePath, SESSION_RELATION_MAX_BYTES, SESSION_RELATION_MAX_LINES).slice(1),
  );
  const isSubagent = prefixEntries.some((entry) => (
    entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE
  ));
  if (!isSubagent) return prefixEntries;

  return [
    ...prefixEntries,
    ...parseSessionEntries(readBoundedTailLines(filePath, SESSION_RESULT_MAX_BYTES)),
  ];
}

export async function attachSessionProjectInfo(sessions: SessionInfo[]): Promise<SessionInfo[]> {
  const uniqueCwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  return sessions.map((session) => {
    const project = session.cwd ? projectByCwd.get(session.cwd) : undefined;
    const projectRoot = project?.projectRoot ?? session.cwd;
    return {
      ...session,
      projectRoot,
      projectKey: projectIdentityKey(projectRoot),
      ...(project?.branch ? { branch: project.branch } : {}),
      ...(project?.isWorktree ? { isWorktree: true } : {}),
    };
  });
}

export function mergeSessionLists(
  persistedSessions: SessionInfo[],
  supplementalSessions: SessionInfo[],
): SessionInfo[] {
  const byId = new Map(supplementalSessions.map((session) => [session.id, session]));
  // A disk scan is authoritative once the JSONL exists. In particular, this
  // replaces a transient registry snapshot without briefly rendering two rows.
  for (const session of persistedSessions) byId.set(session.id, session);
  return [...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

async function loadAllSessions(space: SessionSpace = { kind: "host" }): Promise<SessionInfo[]> {
  // User shards list their own directory; the host space lists the global
  // root (the users/ shard itself holds no session files directly, so it
  // never leaks into the host listing).
  const piSessions: PiSessionInfo[] = space.kind === "host"
    ? await SessionManager.listAll()
    : await SessionManager.listAll(spaceDir(space));
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(sessionPathKey(s.path), s.id);

  const sessions = piSessions.map((s) => {
    cacheSessionPath(s.id, s.path);
    const originSessionId = s.parentSessionPath ? pathToId.get(sessionPathKey(s.parentSessionPath)) : undefined;
    let subagent = null;
    if (s.parentSessionPath) {
      try {
        subagent = readSubagentRun(readSessionRelationEntries(s.path), s.id, s.path);
      } catch { /* malformed or concurrently removed session */ }
    }
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: originSessionId,
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: subagent.status } }
        : s.parentSessionPath
          ? { relation: { kind: "fork" as const, ...(originSessionId ? { originSessionId } : {}) } }
          : {}),
      transient: false,
    };
  });
  return attachSessionProjectInfo(sessions);
}

export async function listAllSessions(
  spaceOrOptions: SessionSpace | { force?: boolean } = { kind: "host" },
  maybeOptions: { force?: boolean } = {},
): Promise<SessionInfo[]> {
  // Accept both call styles: listAllSessions(space, { force }) and the
  // upstream-style legacy listAllSessions({ force }).
  const space: SessionSpace = "kind" in spaceOrOptions ? spaceOrOptions : { kind: "host" };
  const options = "force" in spaceOrOptions ? spaceOrOptions as { force?: boolean } : maybeOptions;
  const key = spaceKey(space);
  const bundle = spaceBundle(key);
  if (options.force) invalidateSessionListCache(space);
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
    // If a mutation invalidated this scan, make this caller join (or start) a
    // scan for the current generation. Returning the stale result here made a
    // refresh race indistinguishable from a successful refresh.
    if ((bundle.listGeneration ?? 0) !== generation) {
      return listAllSessions(space);
    }
    bundle.listCache = { data, ts: Date.now() };
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
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function defaultSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

function resolvePathWithinDefaultSessions(
  filePath: string,
  sessionsDir = resolvePath(defaultSessionsDir()),
): string | null {
  const candidatePath = resolvePath(filePath);
  const relativePath = relative(sessionsDir, candidatePath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
    ? candidatePath
    : null;
}

async function findSessionPathById(sessionId: string): Promise<string | null> {
  // The filename is only a candidate hint; the bounded header check remains
  // authoritative so future layouts and malformed files use the full fallback.
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;

  let projectDirs: Dirent[];
  const sessionsDir = resolvePath(defaultSessionsDir());
  try {
    projectDirs = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const suffix = `_${sessionId}.jsonl`;
  let match: string | undefined;
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory() && !projectDir.isSymbolicLink()) continue;
    const projectPath = resolvePathWithinDefaultSessions(
      join(sessionsDir, projectDir.name),
      sessionsDir,
    );
    if (!projectPath) continue;

    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(suffix)) continue;
      const candidate = resolvePathWithinDefaultSessions(
        join(projectPath, file),
        sessionsDir,
      );
      if (!candidate) continue;
      try {
        if (readSessionHeader(candidate)?.id !== sessionId) continue;
      } catch {
        continue;
      }
      // Do not choose between duplicate candidates; retain the existing
      // catalogue fallback for its current resolution semantics.
      if (match && match !== candidate) return null;
      match = candidate;
    }
  }

  return match ?? null;
}

function findSessionIdByPath(filePath: string): string | undefined {
  if (!filePath.endsWith(".jsonl")) return undefined;
  const candidate = resolvePathWithinDefaultSessions(filePath);
  if (!candidate) return undefined;
  try {
    const sessionId = readSessionHeader(candidate)?.id;
    if (!sessionId) return undefined;
    cacheSessionPath(sessionId, candidate);
    return sessionId;
  } catch {
    return undefined;
  }
}

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

/** Exposed for tests: per-space cache bundles replaced the old global caches. */
export function spaceBundle(key: string): SpaceCacheBundle {
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

/**
 * Path acceptance for resolution: in-space paths always resolve. For the host
 * space, paths OUTSIDE the whole sessions root (tests, SDK-embedded hosts with
 * custom session dirs) cannot belong to any user shard, so an explicitly
 * cached mapping is honored — the fence exists to stop cross-USER leaks, and
 * no shard can claim such a path.
 */
function isResolvableInSpace(filePath: string, space: SessionSpace): boolean {
  if (isPathInSpace(filePath, space)) return true;
  if (space.kind !== "host") return false;
  const root = resolvePath(spaceDir({ kind: "host" }));
  const p = resolvePath(filePath);
  // Inside the sessions tree but outside the host space = a user shard: refuse.
  return !(p === root || p.startsWith(root + sep));
}

export async function resolveSessionPath(sessionId: string, space: SessionSpace = { kind: "host" }): Promise<string | null> {
  const bundle = spaceBundle(spaceKey(space));
  const cached = bundle.pathCache.get(sessionId);
  if (cached) return isResolvableInSpace(cached, space) ? cached : null;

  // Targeted lookup (host space only — shard spaces live outside the default
  // sessions dir): resolve by filename suffix plus a bounded header check
  // instead of scanning every session file.
  if (space.kind === "host") {
    const targetedPath = await findSessionPathById(sessionId);
    if (targetedPath) {
      cacheSessionPath(sessionId, targetedPath);
      const resolved = bundle.pathCache.get(sessionId);
      if (resolved) return resolved;
    }
  }

  // Unknown layouts, malformed candidates, and duplicate IDs retain the
  // existing authoritative catalogue scan instead of negative-caching a miss.
  await listAllSessions(space);
  const resolved = bundle.pathCache.get(sessionId);
  if (!resolved) return null;
  return isResolvableInSpace(resolved, space) ? resolved : null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  for (const bundle of globalThis.__piSessionSpaceCaches?.values() ?? []) {
    const cached = bundle.idToPathCache.get(pathKey);
    if (cached) return cached;
  }

  const targetedId = findSessionIdByPath(filePath);
  if (targetedId) return targetedId;

  await listAllSessions();
  const host = spaceBundle("host");
  return host.idToPathCache.get(pathKey);
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  // The host bundle must always receive the mapping: callers may cache before
  // any space has been listed (e.g. registerRpcWrapper on a brand-new session),
  // and iterating only existing bundles would silently drop those writes.
  const bundles = [...(globalThis.__piSessionSpaceCaches?.values() ?? []), spaceBundle("host")];
  const seen = new Set<SpaceCacheBundle>();
  for (const bundle of bundles) {
    if (seen.has(bundle)) continue;
    seen.add(bundle);
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
  const firstLine = readBoundedLines(filePath, SESSION_HEADER_MAX_BYTES, 1)[0]?.trimEnd();
  if (!firstLine) return null;
  try {
    const header = JSON.parse(firstLine) as SessionHeader;
    return header.type === "session" ? header : null;
  } catch {
    return null;
  }
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

function getSessionSettings(entries: SessionEntry[], leafId?: string | null): Pick<SessionContext, "thinkingLevel" | "model"> {
  if (leafId === null) return { thinkingLevel: "off", model: null };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = leafId ? byId.get(leafId) : undefined;
  current ??= entries[entries.length - 1];
  let thinkingLevel: string | undefined;
  let model: SessionContext["model"] | undefined;

  while (current && (thinkingLevel === undefined || model === undefined)) {
    if (thinkingLevel === undefined && current.type === "thinking_level_change") {
      thinkingLevel = current.thinkingLevel;
    }
    if (model === undefined && current.type === "model_change") {
      model = { provider: current.provider, modelId: current.modelId };
    } else if (model === undefined && current.type === "message" && current.message.role === "assistant") {
      const message = current.message as { provider?: unknown; model?: unknown };
      if (typeof message.provider === "string" && typeof message.model === "string") {
        model = { provider: message.provider, modelId: message.model };
      }
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return { thinkingLevel: thinkingLevel ?? "off", model: model ?? null };
}

export interface BuildSessionContextOptions {
  deferThinking?: boolean;
  deferToolResultImages?: boolean;
  tail?: number;
  excludeLeaf?: boolean;
  /** Session id used to build lazy URLs for historical tool-result images. */
  sessionId?: string;
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: BuildSessionContextOptions = {},
): SessionContext {
  const { tail, excludeLeaf } = options;
  // Restrict SDK conversion and the response payload to the requested page.
  const sliced = tail && tail > 0 ? sliceActiveBranch(entries, leafId ?? null, tail, excludeLeaf) : entries;
  const hasMore = Boolean(tail && tail > 0 && sliced[0]?.parentId);
  const byId = new Map<string, SessionEntry>();
  for (const e of sliced) byId.set(e.id, e);

  const piEntries = sliced as unknown as PiSessionEntry[];
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
    oldestEntryId: sliced[0]?.id ?? null,
    hasMore,
    ...getSessionSettings(entries, leafId),
  };
}

/**
 * Extract the ancestor chain from `leafId` back toward the root, capped at
 * `tail` entries (most-recent first after the final reverse). Iterative: a
 * linear session's chain length equals its entry count, so a recursive walk
 * would overflow the stack. The result is still a valid prefix of the active
 * branch — older history is loaded on demand via pagination.
 */
export function sliceActiveBranch(
  entries: SessionEntry[],
  leafId: string | null,
  tail: number,
  excludeLeaf = false,
): SessionEntry[] {
  if (tail <= 0) return entries;
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  let leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  // Pagination: `before` is the oldest entry already loaded, so the next page
  // must start at its parent to avoid duplicating `before` when prepended.
  if (excludeLeaf) leaf = leaf?.parentId ? byId.get(leaf.parentId) : undefined;
  if (!leaf) return [];
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current && chain.length < tail) {
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  chain.reverse();
  return chain;
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

function deferToolResultBase64Images(
  message: AgentMessage,
  sessionId: string | undefined,
  entryId: string,
): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.flatMap((block, blockIndex) => {
    const image = base64ImageInfo(block);
    if (!image) return [block];

    // Keep the initial history response small, but preserve an image block that
    // the browser can load only when its collapsed tool result is expanded.
    if (
      sessionId &&
      image.mime &&
      TOOL_RESULT_IMAGE_MIMES.has(image.mime) &&
      image.bytes > 0 &&
      image.bytes <= MAX_TOOL_RESULT_IMAGE_BYTES
    ) {
      const source: ImageContent["source"] = {
        type: "url",
        media_type: image.mime,
        url: `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/tool-result-image?blockIndex=${blockIndex}`,
      };
      return [{ type: "image", source } satisfies ImageContent];
    }

    // Retain the old bounded fallback for callers that do not have a session id.
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return [];
  });
  if (omitted === 0) return { ...message, content };

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
  options: BuildSessionContextOptions,
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      let message = options.deferToolResultImages
        ? deferToolResultBase64Images(normalizeToolCalls(entry.message), options.sessionId, entry.id)
        : normalizeToolCalls(entry.message);
      const legacyContent = message.role === "assistant" ? (message as { content: unknown }).content : undefined;
      if (typeof legacyContent === "string") {
        message = { ...message, content: [{ type: "text", text: legacyContent }] } as AgentMessage;
      }
      if (!options.deferThinking || message.role !== "assistant") return message;
      const content = message.content;
      return {
        ...message,
        content: content.map((block) => (
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
