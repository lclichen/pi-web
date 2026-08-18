#!/usr/bin/env node
/**
 * Copy Monaco's AMD distribution (node_modules/monaco-editor/min/vs) into
 * public/monaco/vs so the editor loads from our own origin — no CDN, which
 * keeps offline packaging (scripts/package-linux.sh) working. Idempotent:
 * skips the copy when the target already matches the installed version.
 *
 * Wired as predev/prebuild in package.json; `next build` then bundles
 * public/ as usual.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const src = join(root, "node_modules", "monaco-editor", "min", "vs");
const dest = join(root, "public", "monaco", "vs");
const versionFile = join(root, "public", "monaco", "VERSION");

if (!existsSync(src)) {
  console.error("[copy-monaco] monaco-editor not installed — skipping");
  process.exit(0);
}

const { version } = JSON.parse(
  readFileSync(join(root, "node_modules", "monaco-editor", "package.json"), "utf8"),
);

let current = null;
try {
  current = readFileSync(versionFile, "utf8").trim();
} catch {
  // not copied yet
}

// Validate an existing copy: version matches and the loader entry exists.
const copyLooksComplete =
  current === version &&
  existsSync(join(dest, "loader.js")) &&
  existsSync(join(dest, "editor", "editor.main.js"));

if (copyLooksComplete) {
  console.log(`[copy-monaco] ${dest} already at ${version} — skipping`);
  process.exit(0);
}

rmSync(join(root, "public", "monaco"), { recursive: true, force: true });
mkdirSync(join(root, "public", "monaco"), { recursive: true });
cpSync(src, dest, { recursive: true, dereference: true });
// Basic sanity: the AMD loader entry must exist after the copy.
statSync(join(dest, "loader.js"));
writeFileSync(versionFile, version + "\n");
console.log(`[copy-monaco] copied monaco-editor ${version} -> public/monaco/vs`);
