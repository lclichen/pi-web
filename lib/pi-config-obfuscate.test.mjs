import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * scripts/pi-config-obfuscate.mjs — packaged config template hardening.
 *
 * The shipping template copies pi-config verbatim, so our own extension ships
 * as readable TypeScript. The opt-in packaging step bundles each OWN extension
 * into one minified index.js and drops the sources. This test pins the
 * contract: minified bundle, no `.ts` left, package.json repointed, and
 * everything we do NOT own (vendored extensions, skills/prompts) untouched.
 */

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("obfuscates our extension, leaves vendored code and prompts alone", () => {
  const work = mkdtempSync(join(tmpdir(), "pi-config-obf-"));
  try {
    const pi = join(work, "pi");
    cpSync(new URL("../pi-config/agent", import.meta.url), pi, { recursive: true });
    const res = spawnSync(process.execPath, [join(repoRoot, "scripts/pi-config-obfuscate.mjs"), pi], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);

    const ext = join(pi, "extensions", "amedac-core");
    const bundle = readFileSync(join(ext, "index.js"), "utf8");
    assert.ok(bundle.length > 1000, "bundle should be substantial");
    // Doc-comment prose from the sources must not survive minification.
    // (Searching for "/**" is unreliable: the code legitimately contains glob
    // strings like ".pi/sessions/**".)
    assert.ok(!bundle.includes("model-launched long-running processes"));
    assert.ok(!bundle.includes("Core session extensions shared by the pi CLI"));
    // Export names survive (the loader calls them by name).
    assert.match(bundle, /as makeTodoExtension/);
    assert.match(bundle, /as makeBgShellExtension/);

    const pkg = JSON.parse(readFileSync(join(ext, "package.json"), "utf8"));
    assert.deepEqual(pkg.pi.extensions, ["./index.js"]);

    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(ext);
    assert.ok(
      files.every((f) => !f.endsWith(".ts")),
      "no TypeScript sources may ship",
    );
    assert.ok(!existsSync(join(ext, "src")), "empty src dir is removed");

    // Vendored third-party extension keeps its sources.
    assert.ok(existsSync(join(pi, "extensions", "rpiv-ask-user-question", "index.ts")));
    // Prompts/skills are readable by design (the model must read them).
    assert.ok(existsSync(join(pi, "skills", "pi-extension-dev", "SKILL.md")));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
