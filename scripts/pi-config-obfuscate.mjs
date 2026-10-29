#!/usr/bin/env node
/**
 * Obfuscate the packaged pi-config extensions (`config/pi/extensions/*`).
 *
 * WHY: `package-linux.sh` copies pi-config/** verbatim, so the distributed
 * template ships our extension TypeScript sources. The pi runtime loads them
 * with type-stripping (jiti), which is why they cannot be pre-compiled in the
 * source tree. At PACKAGE time we can do better: bundle each extension entry
 * into a single minified ESM file (identifier mangling, comments dropped, no
 * sourcemap), drop every `.ts` source, and point `pi.extensions` at the built
 * file. The runtime then loads a minified JS bundle instead of readable TS.
 *
 * WHAT IT IS NOT: encryption. The runtime must execute the code, so the key
 * would ship next to it — anything claiming otherwise is theater. Real
 * secrecy only exists for code that runs out-of-process (see lib/apkg-open.ts
 * spawning the internal Go binary). Markdown skills/prompts cannot be hidden
 * either: the model has to read them.
 *
 * SCOPE: only extensions listed in OBFUSCATE_EXTENSIONS (default: our own
 * amedac-core). Vendored third-party extensions (e.g. rpiv-*) keep their
 * sources — they are not our IP and may read sibling asset files at runtime.
 *
 * Usage: node scripts/pi-config-obfuscate.mjs <config/pi dir>
 */
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const OUR_EXTENSIONS = ["amedac-core"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Remove now-empty source directories (e.g. `src/`) bottom-up. */
function removeEmptyDirs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    removeEmptyDirs(p);
    if (readdirSync(p).length === 0) rmSync(p, { recursive: true, force: true });
  }
}

function pickEntry(dir, pkg) {
  const declared = pkg?.pi?.extensions ?? [];
  for (const rel of declared) {
    if (typeof rel === "string" && /\.(ts|js)$/.test(rel)) return join(dir, rel);
  }
  for (const candidate of ["index.ts", "index.js"]) {
    try {
      if (statSync(join(dir, candidate)).isFile()) return join(dir, candidate);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

async function obfuscateExtension(extDir) {
  const pkgPath = join(extDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const entry = pickEntry(extDir, pkg);
  if (!entry) throw new Error(`找不到扩展入口: ${extDir}`);
  const outFile = join(extDir, "index.js");
  // `packages: external` keeps @earendil-works/* and node builtins as imports —
  // the runtime provides them; bundling them would bloat and break versioning.
  await build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    minify: true,
    format: "esm",
    platform: "node",
    target: "node20",
    packages: "external",
    legalComments: "none",
    sourcemap: false,
    logLevel: "silent",
  });

  // Drop sources only after a successful build.
  let removed = 0;
  for (const file of walk(extDir)) {
    if (file.endsWith(".ts") && !file.endsWith(".d.ts")) {
      rmSync(file, { force: true });
      removed += 1;
    }
  }
  pkg.pi = { ...(pkg.pi ?? {}), extensions: ["./index.js"] };
  if (typeof pkg.main === "string" && /\.(ts)$/.test(pkg.main)) pkg.main = "./index.js";
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  removeEmptyDirs(extDir);
  const size = statSync(outFile).size;
  console.log(`[pi-config-obfuscate] ${extDir.split(/[\\/]/).pop()}: index.js ${size}B · removed ${removed} .ts`);
}

async function main() {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node scripts/pi-config-obfuscate.mjs <config/pi dir>");
    process.exit(2);
  }
  const extsDir = join(root, "extensions");
  const only = (process.env.OBFUSCATE_EXTENSIONS ?? OUR_EXTENSIONS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let count = 0;
  for (const name of readdirSync(extsDir)) {
    if (!only.includes(name)) continue;
    const dir = join(extsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    await obfuscateExtension(dir);
    count += 1;
  }
  console.log(`[pi-config-obfuscate] done: ${count} extension(s)`);
}

main().catch((err) => {
  console.error(`[pi-config-obfuscate] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
