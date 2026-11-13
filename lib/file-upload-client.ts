import { buildAtMentionText } from "./file-fuzzy";
import { encodeFilePathForApi, joinFilePath } from "./file-paths";

/**
 * Browser side of the file upload APIs:
 *   · /api/files/<dir>?type=upload      — host sessions
 *   · /api/remotefs/<dir>?src=<id>...   — sandbox / local-machine / ssh sessions
 *
 * The chat composer, the attach button and the drop handler all share these
 * helpers so a file lands exactly the same way in every session mode.
 */

export type UploadConflictStrategy = "error" | "skip";

export interface UploadError {
  name: string;
  error: string;
}

export interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
  /** Remote uploads with hostCache=1: names also written to the Host primary store. */
  hostCached?: string[];
  /** Saved on the Host but NOT mirrored remotely (the path is not readable on the remote side). */
  hostOnly?: string[];
  /** Absolute Host directory holding the primary copies. */
  hostDir?: string;
  /** Human-readable warning about the Host/remote mirror. */
  warning?: string;
}

/** A directory files can be written to, plus the remote session that owns it. */
export interface UploadTarget {
  /** Host absolute path, or "/" (the workspace root) for remote modes. */
  directory: string;
  /** Remote session id — when set, uploads go through /api/remotefs. */
  sessionId?: string | null;
}

function directoryUrl(target: UploadTarget): string {
  const encoded = encodeFilePathForApi(target.directory);
  return target.sessionId
    ? `/api/remotefs/${encoded}?src=${encodeURIComponent(target.sessionId)}`
    : `/api/files/${encoded}`;
}

/**
 * Uploads files into one directory through the file API.
 * @param target Directory to write to (host path or remote workspace root)
 * @param files The files, written under the given names
 * @param strategy What the server does with a name that already exists
 * @param fileNames Optional upload names (images get a unique attachment name)
 * @returns The HTTP status and the parsed response body
 */
export async function uploadFiles(
  target: UploadTarget,
  files: File[],
  strategy: UploadConflictStrategy,
  fileNames?: string[],
  options: { hostCache?: boolean } = {},
): Promise<{ status: number; data: UploadResponse }> {
  const formData = new FormData();
  files.forEach((file, index) => {
    const name = fileNames?.[index] ?? file.name;
    formData.append("files", file, name);
  });

  const base = directoryUrl(target);
  const separator = base.includes("?") ? "&" : "?";
  // The Host primary copy only exists for remote targets; host sessions are
  // already writing into their own workspace.
  const hostCache = options.hostCache && target.sessionId ? "&hostCache=1" : "";
  const response = await fetch(`${base}${separator}type=upload&conflict=${strategy}${hostCache}`, {
    method: "POST",
    body: formData,
  });
  let data: UploadResponse = {};
  try {
    data = (await response.json()) as UploadResponse;
  } catch {
    // Non-JSON error body (proxy/HTML) — surface the status instead.
  }
  return { status: response.status, data };
}

/** Creates the upload directory (PUT {type:"dir"}); an existing dir counts as success. */
export async function ensureUploadDirectory(target: UploadTarget): Promise<boolean> {
  try {
    const response = await fetch(directoryUrl(target), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "dir" }),
    });
    if (response.ok || response.status === 409) return true;
    const text = await response.text().catch(() => "");
    return /exist/i.test(text);
  } catch {
    return false;
  }
}

/**
 * Attachments live in a runtime folder inside the workspace. The folder is
 * excluded from config bundles and workspace config sync, and pi's path guard
 * does not treat it as a protected runtime path (unlike .pi/tmp), so tools can
 * read the files when a service needs an image or document by path.
 */
export const ATTACHMENTS_DIR = ".pi/attachments";

export function attachmentsTarget(target: UploadTarget): UploadTarget {
  return { ...target, directory: joinFilePath(target.directory, ATTACHMENTS_DIR) };
}

/** One file or folder dropped onto the chat. */
export type DroppedItem = { kind: "file"; file: File } | { kind: "folder"; name: string };

/**
 * Sorts a chat drop: images are attached to the prompt as before, other files
 * are uploaded into the working directory and mentioned, and folders are left
 * out because the upload endpoint takes files only.
 */
export function splitDroppedItems(items: DroppedItem[]): { images: File[]; files: File[]; folders: string[] } {
  const images: File[] = [];
  const files: File[] = [];
  const folders: string[] = [];
  for (const item of items) {
    if (item.kind === "folder") folders.push(item.name);
    else if (item.file.type.startsWith("image/")) images.push(item.file);
    else files.push(item.file);
  }
  return { images, files, folders };
}

/** The `@` mentions for paths now present in the working directory, in order. */
export function mentionText(paths: string[]): string {
  return paths.map((path) => buildAtMentionText(path, false)).join("");
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  const ext = name.slice(dot);
  return /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext.toLowerCase() : "";
}

function sanitizeAttachmentBase(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const cleaned = base
    // Path separators and Windows-invalid characters become spaces; a name
    // picked in a browser never carries a path, but a hand-built File can.
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned || "attachment";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local-time compact stamp, e.g. 20261113-142530. */
export function attachmentStamp(now: number): string {
  const date = new Date(now);
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * A collision-free, human-readable name for a stored attachment. The stamp
 * keeps uploads in chat order and the random token makes a repeated name in
 * the same second impossible; the original base name is kept for context.
 */
export function attachmentFileName(
  file: Pick<File, "name" | "type">,
  now: number = Date.now(),
  token: string = randomToken(),
): string {
  const extension = extensionOf(file.name) || MIME_EXTENSIONS[file.type.toLowerCase()] || "";
  return `${attachmentStamp(now)}-${token}-${sanitizeAttachmentBase(file.name)}${extension}`;
}
