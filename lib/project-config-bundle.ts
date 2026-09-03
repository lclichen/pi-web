/**
 * Project config bundles — shareable zip archives of a project's teaching
 * configuration, for the "导入项目配置 / 导出配置包" workflow.
 *
 * Bundle layout (zip root):
 *   manifest.json        export metadata (name, exportedAt, format version)
 *   AGENTS.md            project instructions (optional, exported when present)
 *   .pi/…                agent config: agents/, extensions/, skills/,
 *                        subagents.json, models.json, … (credentials excluded)
 *   labs/…               lab handbook YAML
 *
 * Import is additive-with-overwrite: existing files with the same path are
 * replaced, everything else is kept — same intent as "复制为新项目", but the
 * source is an uploaded archive instead of another project.
 *
 * Security posture: imports are untrusted input. Entries are confined to the
 * whitelist above, path traversal and symlink escapes are rejected, and
 * count/size caps bound zip bombs. Credentials (auth.json) never travel in
 * either direction.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";

export const BUNDLE_FORMAT = "amedac-project-config";
export const BUNDLE_VERSION = 1;

export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_UNCOMPRESSED_BYTES = 600 * 1024 * 1024;

/** Never exported, never imported — credentials and machine/user state. */
const DENIED_BASENAMES = new Set(["auth.json"]);
/**
 * Path segments (at any depth) excluded from bundles both ways. Note
 * node_modules is deliberately NOT here: bundles target offline deployment,
 * so extension dependencies must travel with the archive.
 */
const DENIED_SEGMENTS = new Set(["sessions", "tmp", "bin", "cache", ".git"]);
/** Top-level prefixes an import may write into the project home. */
const ALLOWED_PREFIXES = [".pi/", "labs/"];
/** Root files a bundle may carry: archive metadata + shared project files. */
const ALLOWED_ROOT_FILES = new Set(["manifest.json", "readme.md", "agents.md"]);
/** ALLOWED_ROOT_FILES entries that are archive metadata only — never written. */
const METADATA_ROOT_FILES = new Set(["manifest.json", "readme.md"]);

export interface ExportStats {
  files: number;
  bytes: number;
  /** Top-level sections that were empty (and therefore absent from the zip). */
  skipped: string[];
}

export interface ImportStats {
  added: number;
  overwritten: number;
  /** Written paths (relative to home), for the result report. */
  files: string[];
}

function isDeniedPath(relPath: string): boolean {
  const segments = relPath.split("/");
  if (segments.some((s) => DENIED_SEGMENTS.has(s.toLowerCase()))) return true;
  const base = segments[segments.length - 1]?.toLowerCase() ?? "";
  if (DENIED_BASENAMES.has(base)) return true;
  return false;
}

async function* walkFiles(root: string, rel: string): AsyncGenerator<{ rel: string; abs: string }> {
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return; // absent section — nothing to add
  }
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walkFiles(root, relPath);
    } else if (entry.isFile()) {
      yield { rel: relPath, abs: join(root, relPath) };
    }
    // Symlinks are skipped on purpose: a link out of the home must not leak
    // files into a shared bundle.
  }
}

/** Build a config bundle zip for a project home. Returns the archive bytes. */
export async function exportProjectConfigBundle(
  home: string,
  projectName: string,
): Promise<{ bytes: Buffer; stats: ExportStats }> {
  const zip = new JSZip();
  const stats: ExportStats = { files: 0, bytes: 0, skipped: [] };

  for (const section of [".pi", "labs"]) {
    let sectionFiles = 0;
    for await (const file of walkFiles(home, section)) {
      if (isDeniedPath(file.rel)) continue;
      const content = await readFile(file.abs);
      zip.file(file.rel, content);
      sectionFiles += 1;
      stats.files += 1;
      stats.bytes += content.length;
    }
    if (sectionFiles === 0) stats.skipped.push(section);
  }

  // 根级 AGENTS.md（项目指令，会话系统提示词的来源之一）随包共享；
  // 缺失时静默跳过，不进 skipped 列表（非目录 section）。
  try {
    const agents = await readFile(join(home, "AGENTS.md"));
    zip.file("AGENTS.md", agents);
    stats.files += 1;
    stats.bytes += agents.length;
  } catch {
    // no AGENTS.md — nothing to add
  }

  zip.file("manifest.json", JSON.stringify({
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    project: projectName,
    exportedAt: new Date().toISOString(),
  }, null, 2));

  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return { bytes, stats };
}

/** Sanitize one zip entry name; returns a posix rel-path or rejects. */
function sanitizeEntryPath(name: string): string {
  if (name.includes("\0")) throw new Error(`非法文件名: ${JSON.stringify(name.slice(0, 60))}`);
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`不支持绝对路径: ${normalized.slice(0, 60)}`);
  }
  const segments = normalized.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(`不支持路径穿越: ${normalized.slice(0, 60)}`);
  }
  return segments.join("/");
}

function assertAllowed(relPath: string): void {
  const lower = relPath.toLowerCase();
  if (ALLOWED_ROOT_FILES.has(lower)) return;
  if (ALLOWED_PREFIXES.some((p) => lower.startsWith(p) || lower === p.slice(0, -1))) return;
  throw new Error(`包内不支持的路径（仅支持 .pi/ 与 labs/）: ${relPath.slice(0, 80)}`);
}

/**
 * Apply an uploaded bundle to a project home. Validation happens fully before
 * the first write, so a malformed archive leaves the project untouched.
 */
export async function importProjectConfigBundle(
  home: string,
  data: Buffer,
): Promise<ImportStats> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(data);
  } catch {
    throw new Error("无法解析压缩包（需要 zip 格式的配置包）");
  }

  const entries = Object.values(archive.files).filter((e) => !e.dir);
  if (entries.length === 0) throw new Error("压缩包为空");
  if (entries.length > MAX_ENTRIES) throw new Error(`压缩包条目过多（>${MAX_ENTRIES}）`);

  // Validate everything first; collect writes for a single pass afterwards.
  const writes: Array<{ rel: string; content: Buffer; existed: boolean }> = [];
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const rel = sanitizeEntryPath(entry.name);
    assertAllowed(rel);
    if (isDeniedPath(rel)) continue; // silently skip denied files (auth.json etc.)
    if (METADATA_ROOT_FILES.has(rel.toLowerCase())) continue; // archive metadata, never written
    if (seen.has(rel)) continue;
    seen.add(rel);
    const content = await entry.async("nodebuffer");
    totalBytes += content.length;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("解压后内容过大（>120MB），疑似压缩炸弹");
    }
    let existed = false;
    try {
      await stat(join(home, rel));
      existed = true;
    } catch {
      existed = false;
    }
    writes.push({ rel, content, existed });
  }
  if (writes.length === 0) throw new Error("包内没有可导入的配置文件（仅支持 .pi/ 与 labs/）");

  const stats: ImportStats = { added: 0, overwritten: 0, files: [] };
  for (const write of writes) {
    const target = join(home, write.rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, write.content);
    if (write.existed) stats.overwritten += 1;
    else stats.added += 1;
    stats.files.push(write.rel);
  }
  stats.files.sort();
  return stats;
}

/** Serve bundle bytes as a download response (streamed, attachment header). */
export function bundleDownloadResponse(bytes: Buffer, filename: string): Response {
  // ASCII fallback + RFC 5987 encoded name so CJK project names survive.
  const asciiName = filename.replace(/[^\x20-\x7E]/g, "_");
  const encodedName = encodeURIComponent(filename);
  const stream = Readable.from(bytes);
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "no-store",
    },
  });
}

// ---- Skills bundle import -------------------------------------------------
//
// A skills zip holds skill folders at its root (each containing a SKILL.md),
// or a single skill's contents directly at the root. It unpacks into
// <cwd>/.pi/skills/ — the same offline-share story as project config bundles,
// scoped to skills only.

const SKILL_ALLOWED_EXT = new Set([
  ".md", ".json", ".yaml", ".yml", ".txt", ".js", ".mjs", ".ts", ".tsx",
  ".py", ".sh", ".css", ".html", ".svg", ".png", ".jpg", ".jpeg", ".gif",
  ".webp", ".toml", ".ini", ".csv", ".xml",
]);
const SKILL_MAX_ENTRIES = 4_000;
const SKILL_MAX_BYTES = 200 * 1024 * 1024;

function skillEntryAllowed(rel: string): boolean {
  const lower = rel.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return false;
  return SKILL_ALLOWED_EXT.has(lower.slice(dot));
}

export interface SkillsImportStats {
  skill: string;          // folder name created under .pi/skills/
  files: number;
}

/**
 * Unpack a skills zip into <cwd>/.pi/skills/.
 *
 * Layout rules:
 *  - single root folder        → unpack as .pi/skills/<folder>/…
 *  - SKILL.md at the zip root  → unpack as .pi/skills/<zip name>/…
 *  - multiple root folders     → each becomes .pi/skills/<folder>/…
 */
export async function importSkillsZip(
  cwd: string,
  data: Buffer,
  zipName: string,
): Promise<SkillsImportStats> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(data);
  } catch {
    throw new Error("无法解析压缩包（需要 zip 格式的技能包）");
  }
  const entries = Object.values(archive.files).filter((e) => !e.dir);
  if (entries.length === 0) throw new Error("压缩包为空");
  if (entries.length > SKILL_MAX_ENTRIES) throw new Error(`压缩包条目过多（>${SKILL_MAX_ENTRIES}）`);

  const cleaned: Array<{ rel: string; content: Buffer }> = [];
  let total = 0;
  for (const entry of entries) {
    const rel = sanitizeEntryPath(entry.name);
    if (!skillEntryAllowed(rel)) continue; // skip unsupported files (e.g. binaries)
    const content = await entry.async("nodebuffer");
    total += content.length;
    if (total > SKILL_MAX_BYTES) throw new Error("解压后内容过大（>200MB）");
    cleaned.push({ rel, content });
  }
  if (cleaned.length === 0) throw new Error("包内没有可识别的技能文件（需要 SKILL.md）");

  // Layout: every entry at the zip root (no folders) means one skill shipped
  // bare — give it the zip's name. Anything else (skill folders at the root,
  // or a bare skill mixed with folders) unpacks as-is; each root folder is a
  // skill in its own right.
  const allAtRoot = cleaned.every((f) => !f.rel.includes("/"));
  const zipBase = zipName.replace(/\.zip$/i, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
  const targetPrefix = allAtRoot ? zipBase : "";

  // A skills bundle must yield at least one SKILL.md somewhere.
  const hasSkillMd = cleaned.some((f) => {
    const rel = f.rel.toLowerCase();
    if (rel === "skill.md") return true;
    const segs = rel.split("/");
    return segs.length >= 2 && segs[1] === "skill.md";
  });
  if (!hasSkillMd) throw new Error("包内没有 SKILL.md（每个技能目录需包含一个）");

  const skillsRoot = join(resolve(cwd), ".pi", "skills");
  await mkdir(skillsRoot, { recursive: true });

  let files = 0;
  for (const file of cleaned) {
    const rel = targetPrefix ? `${targetPrefix}/${file.rel}` : file.rel;
    const target = join(skillsRoot, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
    files += 1;
  }

  const skillName = targetPrefix || "(多个技能)";
  return { skill: skillName, files };
}
