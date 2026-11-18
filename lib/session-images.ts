/**
 * Durable per-session image store for MCP tool results.
 *
 * MCP services can be independent HTTP processes whose URLs expire; the bytes
 * therefore have to live with pi-web. Images are content-addressed
 * (`img_<sha256(base64)[0..16]>`) so duplicate payloads deduplicate and a file
 * is never overwritten. Files live under `<dataDir>/session-images/<session>`
 * and are retained as long as the session exists — there is no TTL.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./mode-homes";
import { sessionImageUrl } from "./mcp-image-markers";

export interface SessionImageMeta {
  id: string;
  mimeType: string;
  bytes: number;
  alt?: string;
  createdAt: string;
}

export interface StoredSessionImage {
  meta: SessionImageMeta;
  path: string;
  size: number;
}

export const SESSION_IMAGE_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

function normalizeMime(raw: string | undefined): string | null {
  const lower = (raw ?? "").trim().toLowerCase();
  const mime = lower === "image/jpg" ? "image/jpeg" : lower;
  return SESSION_IMAGE_EXT[mime] ? mime : null;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe && safe !== "." && safe !== ".." ? safe : "session";
}

function normalizedBase64(data: string | undefined): string | null {
  const normalized = (data ?? "").replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  return normalized;
}

/** Stable id; keep the algorithm in sync with pi-mcp-adapter/inline-images.ts. */
export function sessionImageIdForBase64(data: string): string {
  const normalized = data.replace(/\s+/g, "");
  return `img_${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

export function sessionImageDir(sessionId: string): string {
  return join(dataDir(), "session-images", safeSegment(sessionId));
}

function metaPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function imagePath(dir: string, id: string, mimeType: string): string {
  return join(dir, `${id}.${SESSION_IMAGE_EXT[mimeType] ?? "bin"}`);
}

/** Write one image; repeated content reuses the existing file. */
export function storeSessionImage(
  sessionId: string,
  data: string,
  mimeType: string | undefined,
  options: { id?: string; alt?: string } = {},
): SessionImageMeta | null {
  const mime = normalizeMime(mimeType);
  const normalized = normalizedBase64(data);
  if (!mime || !normalized) return null;
  const id = options.id && /^img_[a-z0-9]{8,64}$/.test(options.id) ? options.id : sessionImageIdForBase64(normalized);
  const dir = sessionImageDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const path = imagePath(dir, id, mime);
  const bytes = Buffer.from(normalized, "base64").length;
  if (!existsSync(path)) {
    const temp = join(dir, `.${id}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temp, Buffer.from(normalized, "base64"));
    renameSync(temp, path);
  }
  const meta: SessionImageMeta = {
    id,
    mimeType: mime,
    bytes,
    ...(options.alt ? { alt: options.alt } : {}),
    createdAt: new Date().toISOString(),
  };
  const tempMeta = join(dir, `.${id}.${process.pid}.${Date.now()}.json.tmp`);
  writeFileSync(tempMeta, JSON.stringify(meta));
  renameSync(tempMeta, metaPath(dir, id));
  return meta;
}

/** Read metadata + path for an image; null for unknown ids and foreign paths. */
export function readSessionImage(sessionId: string, imageId: string): StoredSessionImage | null {
  if (!/^img_[a-z0-9]{8,64}$/.test(imageId)) return null;
  const dir = sessionImageDir(sessionId);
  let meta: SessionImageMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath(dir, imageId), "utf8")) as SessionImageMeta;
  } catch {
    return null;
  }
  if (meta.id !== imageId || !normalizeMime(meta.mimeType)) return null;
  const path = imagePath(dir, imageId, meta.mimeType);
  try {
    const size = statSync(path).size;
    return { meta, path, size };
  } catch {
    return null;
  }
}

/** Session deletion/cleanup hook. */
export function deleteSessionImages(sessionId: string): void {
  rmSync(sessionImageDir(sessionId), { recursive: true, force: true });
}

/**
 * Fork/clone copies messages that may contain image markers. Copy the asset
 * directory too so the child session resolves the same ids without exposing
 * the parent's files through another path.
 */
export function copySessionImages(fromSessionId: string, toSessionId: string): void {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
  const from = sessionImageDir(fromSessionId);
  if (!existsSync(from)) return;
  try {
    const to = sessionImageDir(toSessionId);
    mkdirSync(to, { recursive: true });
    cpSync(from, to, { recursive: true, force: true });
  } catch (error) {
    // Fork/clone already succeeded; a missing asset copy is preferable to
    // failing the session operation. The markers show placeholders if needed.
    console.error(
      "[pi-web] failed to copy session images:",
      error instanceof Error ? error.message : error,
    );
  }
}

interface ImageBlockLike {
  type: "image";
  data?: string;
  mimeType?: string;
  source?: {
    type?: string;
    data?: string;
    media_type?: string;
    url?: string;
  };
}

function imagePayload(block: ImageBlockLike): { data: string; mimeType: string } | null {
  if (typeof block.data === "string" && typeof block.mimeType === "string") {
    return { data: block.data, mimeType: block.mimeType };
  }
  if (
    block.source?.type === "base64" &&
    typeof block.source.data === "string" &&
    typeof block.source.media_type === "string"
  ) {
    return { data: block.source.data, mimeType: block.source.media_type };
  }
  return null;
}

function mcpImageAltMap(details: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!details || typeof details !== "object") return map;
  const images = (details as { mcpImages?: unknown }).mcpImages;
  if (!Array.isArray(images)) return map;
  for (const image of images) {
    if (!image || typeof image !== "object") continue;
    const id = (image as { id?: unknown }).id;
    const alt = (image as { alt?: unknown }).alt;
    if (typeof id === "string" && typeof alt === "string" && alt) map.set(id, alt);
  }
  return map;
}

/**
 * Persist images in one tool-result content array and replace their bytes with
 * same-origin URLs for the browser. The model's copy is untouched: only the
 * event sent to the client uses this projection. Returns the original array
 * when there is nothing to project (or storage rejected the payload).
 */
export function projectToolResultContentForClient(
  sessionId: string,
  content: unknown[],
  details?: unknown,
): { content: unknown[]; changed: boolean } {
  const altById = mcpImageAltMap(details);
  let changed = false;
  const projected = content.map((block) => {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return block;
    const image = block as ImageBlockLike;
    const payload = imagePayload(image);
    if (!payload) return block;
    const id = sessionImageIdForBase64(payload.data);
    const meta = storeSessionImage(sessionId, payload.data, payload.mimeType, {
      id,
      ...(altById.get(id) ? { alt: altById.get(id) } : {}),
    });
    if (!meta) return block;
    changed = true;
    return {
      type: "image",
      source: {
        type: "url",
        media_type: meta.mimeType,
        url: sessionImageUrl(sessionId, meta.id),
      },
    };
  });
  return { content: changed ? projected : content, changed };
}

/** Project a live toolResult message for the browser (never mutates the SDK copy). */
export function projectToolResultMessageForClient(
  sessionId: string,
  message: unknown,
): unknown {
  if (!message || typeof message !== "object") return message;
  const record = message as { role?: unknown; content?: unknown; details?: unknown };
  if (record.role !== "toolResult" || !Array.isArray(record.content)) return message;
  const projected = projectToolResultContentForClient(sessionId, record.content, record.details);
  if (!projected.changed) return message;
  return { ...record, content: projected.content };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Exported HTML is standalone: resolve markers to data URLs so images survive
 * without the session API. This intentionally has no size cap — the export is
 * only as large as the images the session actually contains.
 */
export function inlineMcpImageMarkers(html: string, sessionId: string): string {
  if (!html.includes("[[image:")) return html;
  return html.replace(
    /\[\[image:(img_[A-Za-z0-9]+)(?:\|([^\]\n]*))?\]\]/g,
    (_full, imageId: string, alt?: string) => {
      const image = readSessionImage(sessionId, imageId);
      if (!image) return escapeHtml(alt?.trim() || `[image unavailable: ${imageId}]`);
      try {
        const data = readFileSync(image.path).toString("base64");
        return `<img src="data:${image.meta.mimeType};base64,${data}" alt="${escapeHtml(alt ?? image.meta.alt ?? "")}" />`;
      } catch {
        return escapeHtml(alt?.trim() || `[image unavailable: ${imageId}]`);
      }
    },
  );
}
