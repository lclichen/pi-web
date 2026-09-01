/**
 * Preset config bundles (配置模板) — platform-managed zips that users can
 * apply to a project (at creation or later) to scaffold its .pi/ config +
 * labs. Stored under <dataDir>/config-bundles/ as <name>.zip with a meta
 * index. Admin-managed (upload/delete); listing is open to logged-in users
 * so the wizard can offer templates at creation time.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./mode-homes";
import { importProjectConfigBundle } from "./project-config-bundle";

export interface BundleMeta {
  name: string;
  description: string;
  size: number;
  createdAt: number;
}

function bundlesDir(): string {
  return join(dataDir(), "config-bundles");
}

function metaPath(): string {
  return join(bundlesDir(), "meta.json");
}

function readMeta(): Record<string, { description: string; createdAt: number }> {
  try {
    return JSON.parse(readFileSync(metaPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeMeta(meta: Record<string, { description: string; createdAt: number }>): void {
  writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
}

export function bundleZipPath(name: string): string {
  // Names are validated at write time ([\w.-]+), so the join is traversal-safe.
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
    if (!file.endsWith(".zip")) continue;
    const name = file.slice(0, -4);
    try {
      const st = statSync(join(dir, file));
      out.push({
        name,
        description: meta[name]?.description ?? "",
        size: st.size,
        createdAt: meta[name]?.createdAt ?? st.mtimeMs,
      });
    } catch {
      // deleted between readdir and stat — skip
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function bundleExists(name: string): boolean {
  return existsSync(bundleZipPath(name));
}

export function readBundle(name: string): Buffer {
  return readFileSync(bundleZipPath(name));
}

export function saveBundle(name: string, description: string, data: Buffer): void {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(bundlesDir(), { recursive: true });
  writeFileSync(bundleZipPath(name), data);
  const meta = readMeta();
  meta[name] = { description, createdAt: meta[name]?.createdAt ?? Date.now() };
  writeMeta(meta);
}

export function deleteBundle(name: string): boolean {
  const target = bundleZipPath(name);
  if (!existsSync(target)) return false;
  unlinkSync(target);
  const meta = readMeta();
  delete meta[name];
  writeMeta(meta);
  return true;
}

/** Apply a stored preset to a directory (project home or host dir). */
export async function applyBundleToDirectory(name: string, home: string): Promise<void> {
  const bytes = readFileSync(bundleZipPath(name));
  await importProjectConfigBundle(home, bytes);
}

export function removeBundleFiles(name: string): void {
  rmSync(bundleZipPath(name), { force: true });
}
