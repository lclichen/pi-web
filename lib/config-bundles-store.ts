/**
 * Preset config bundles (配置模板) — platform-managed packages that users can
 * apply to a project (at creation or later) to scaffold its .pi/ config +
 * labs. Stored under <dataDir>/config-bundles/ as <name>.zip (plain) or
 * <name>.apkg (encrypted, commercial-protection.md: the ciphertext original
 * is stored verbatim; every apply decrypts in memory). Admin-managed
 * (upload/delete); listing is open to logged-in users so the wizard can
 * offer templates at creation time.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./mode-homes.ts";
import { importProjectConfigBundle } from "./project-config-bundle.ts";
import { isApkgBytes, readApkgHeader } from "./apkg-format.ts";

export interface BundleMeta {
  name: string;
  description: string;
  size: number;
  createdAt: number;
  /** "apkg" = encrypted package (apply decrypts in memory; imports lock). */
  kind: "zip" | "apkg";
  /** Content version from the package (manifest v2 / .apkg header). */
  version: string;
}

function bundlesDir(): string {
  return join(dataDir(), "config-bundles");
}

function metaPath(): string {
  return join(bundlesDir(), "meta.json");
}

interface MetaEntry {
  description: string;
  createdAt: number;
  kind?: "zip" | "apkg";
  version?: string;
}

function readMeta(): Record<string, MetaEntry> {
  try {
    return JSON.parse(readFileSync(metaPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeMeta(meta: Record<string, MetaEntry>): void {
  writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
}

/** Extension-agnostic path lookup: .apkg first, then the legacy .zip. */
export function bundleFilePath(name: string): string {
  const apkg = join(bundlesDir(), `${name}.apkg`);
  if (existsSync(apkg)) return apkg;
  return join(bundlesDir(), `${name}.zip`);
}

// Legacy export kept for callers that still address the plain zip explicitly.
export function bundleZipPath(name: string): string {
  return join(bundlesDir(), `${name}.zip`);
}

export function isValidBundleName(name: string): boolean {
  return /^[\w][\w.-]{0,63}$/.test(name);
}

export function listBundles(): BundleMeta[] {
  const dir = bundlesDir();
  if (!existsSync(dir)) return [];
  const meta = readMeta();
  const out: BundleMeta[] = [];
  for (const file of readdirSync(dir)) {
    const isZip = file.endsWith(".zip");
    const isApkg = file.endsWith(".apkg");
    if (!isZip && !isApkg) continue;
    const name = file.slice(0, -(isApkg ? 5 : 4));
    try {
      const st = statSync(join(dir, file));
      const kind: "zip" | "apkg" = isApkg ? "apkg" : "zip";
      let version = meta[name]?.version ?? "";
      // Header read is display-only; a broken header must not break listing.
      if (isApkg) {
        try {
          version = readApkgHeader(readFileSync(join(dir, file))).version || version;
        } catch {
          // keep meta fallback / empty
        }
      }
      out.push({
        name,
        description: meta[name]?.description ?? "",
        size: st.size,
        createdAt: meta[name]?.createdAt ?? st.mtimeMs,
        kind,
        version,
      });
    } catch {
      // deleted between readdir and stat — skip
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function bundleExists(name: string): boolean {
  return existsSync(bundleFilePath(name));
}

export function readBundle(name: string): Buffer {
  return readFileSync(bundleFilePath(name));
}

export function saveBundle(name: string, description: string, data: Buffer): void {
  mkdirSync(bundlesDir(), { recursive: true });
  // Encrypted uploads keep their ciphertext byte-for-byte; applies decrypt
  // in memory every time (no plaintext copy is ever stored).
  const kind: "zip" | "apkg" = isApkgBytes(data) ? "apkg" : "zip";
  const target = join(bundlesDir(), `${name}.${kind}`);
  writeFileSync(target, data);
  // Remove a stale twin of the other extension so one name = one package.
  const twin = join(bundlesDir(), `${name}.${kind === "apkg" ? "zip" : "apkg"}`);
  if (existsSync(twin)) unlinkSync(twin);
  let version = "";
  if (kind === "apkg") {
    try {
      version = readApkgHeader(data).version ?? "";
    } catch {
      version = "";
    }
  }
  const meta = readMeta();
  meta[name] = {
    description,
    createdAt: meta[name]?.createdAt ?? Date.now(),
    kind,
    ...(version ? { version } : {}),
  };
  writeMeta(meta);
}

export function deleteBundle(name: string): boolean {
  const target = bundleFilePath(name);
  if (!existsSync(target)) return false;
  unlinkSync(target);
  const meta = readMeta();
  delete meta[name];
  writeMeta(meta);
  return true;
}

/** Apply a stored preset (.zip or .apkg) to a directory (project home or host dir). */
export async function applyBundleToDirectory(name: string, home: string): Promise<void> {
  const bytes = readFileSync(bundleFilePath(name));
  await importProjectConfigBundle(home, bytes);
}

export function removeBundleFiles(name: string): void {
  rmSync(join(bundlesDir(), `${name}.zip`), { force: true });
  rmSync(join(bundlesDir(), `${name}.apkg`), { force: true });
}
