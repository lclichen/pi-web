"use strict";

// Next bakes three preview-mode secrets into .next/prerender-manifest.json at
// build time. `next start` compares the `x-prerender-revalidate` request header
// with `preview.previewModeId` *before* running middleware/proxy, and skips the
// proxy when they match (next-server.js -> checkIsOnDemandRevalidate). A
// published package therefore leaks a header value that bypasses proxy.ts:
// the login gate and the Host/Origin/Fetch-Metadata checks.
//
// Rotate the three secrets with fresh random values before every `next start`.
// This must run in each launch path (bin/pi-web.js, start-all.sh, VM scripts),
// not at build time: a build-time value would still be readable from the
// distributed package.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require("crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const PRERENDER_MANIFEST = "prerender-manifest.json";

function freshPreviewSecrets() {
  return {
    // Lengths mirror what Next generates at build time.
    previewModeId: crypto.randomBytes(16).toString("hex"),
    previewModeSigningKey: crypto.randomBytes(32).toString("hex"),
    previewModeEncryptionKey: crypto.randomBytes(32).toString("hex"),
  };
}

/**
 * Rewrite the preview-mode secrets in `<nextDir>/prerender-manifest.json`.
 * Never throws: returns a status the caller can surface. A read-only install
 * (AppImage/squashfs) cannot rotate, so warn instead of silently staying
 * vulnerable.
 *
 * @param {string} nextDir absolute path to the package's `.next` directory
 * @returns {{ ok: boolean, reason?: "missing"|"unreadable"|"unexpected-shape"|"unwritable", error?: Error }}
 */
function rotatePreviewSecrets(nextDir) {
  const manifestPath = path.join(nextDir, PRERENDER_MANIFEST);

  let manifest;
  let mode;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    mode = fs.statSync(manifestPath).mode;
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: false, reason: "missing" };
    if (error instanceof SyntaxError) return { ok: false, reason: "unreadable", error };
    return { ok: false, reason: "unreadable", error };
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, reason: "unexpected-shape" };
  }
  if (
    manifest.preview !== undefined &&
    (typeof manifest.preview !== "object" || manifest.preview === null || Array.isArray(manifest.preview))
  ) {
    return { ok: false, reason: "unexpected-shape" };
  }

  manifest.preview = { ...(manifest.preview ?? {}), ...freshPreviewSecrets() };

  // Write to a sibling temp file and rename so a concurrent `next start` never
  // reads a half-written manifest.
  const tempPath = path.join(nextDir, `${PRERENDER_MANIFEST}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(manifest));
    // Keep the manifest's permissions (0644 normally; some installs use 0600).
    if (typeof mode === "number") fs.chmodSync(tempPath, mode);
    fs.renameSync(tempPath, manifestPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort: a stray temp file is harmless.
    }
    return { ok: false, reason: "unwritable", error };
  }

  return { ok: true };
}

function getRotationWarning(reason) {
  const detail =
    reason === "unwritable"
      ? "the install directory is not writable"
      : reason === "missing"
        ? "its prerender manifest is missing"
        : reason === "unreadable"
          ? "its prerender manifest could not be read"
          : "its prerender manifest has an unexpected format";
  return [
    `Warning: could not rotate pi-web's preview-mode secrets because ${detail}.`,
    "This instance keeps the published preview id, so a client that knows it can",
    "bypass the proxy's authentication and Host/Origin checks via the",
    "x-prerender-revalidate header. Run from a writable install, or restrict",
    "network access to this instance.",
  ].join("\n");
}

function main(argv) {
  const strict = argv.includes("--strict");
  const nextDir = argv.find((arg) => !arg.startsWith("--")) ?? path.join(__dirname, "..", ".next");
  const result = rotatePreviewSecrets(path.resolve(nextDir));
  if (!result.ok) {
    process.stderr.write(`${getRotationWarning(result.reason)}\n`);
    if (strict) process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  PRERENDER_MANIFEST,
  freshPreviewSecrets,
  rotatePreviewSecrets,
  getRotationWarning,
};
