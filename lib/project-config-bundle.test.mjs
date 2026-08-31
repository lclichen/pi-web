import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  exportProjectConfigBundle,
  importProjectConfigBundle,
  BUNDLE_FORMAT,
} = await jiti.import("../lib/project-config-bundle.ts");
const JSZip = (await jiti.import("jszip")).default;

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "cfg-bundle-"));
  mkdirSync(join(home, ".pi", "agents"), { recursive: true });
  mkdirSync(join(home, ".pi", "extensions"), { recursive: true });
  mkdirSync(join(home, "labs"), { recursive: true });
  writeFileSync(join(home, ".pi", "agents", "auditor.md"), "---\ndescription: audit\n---\nAudit.\n");
  writeFileSync(join(home, ".pi", "models.json"), "{}");
  writeFileSync(join(home, ".pi", "auth.json"), "{\"apiKey\":\"SECRET\"}");
  mkdirSync(join(home, ".pi", "sessions"), { recursive: true });
  writeFileSync(join(home, ".pi", "sessions", "s1.jsonl"), "session-data");
  writeFileSync(join(home, "labs", "lab1.yaml"), "name: lab1\n");
  return home;
}

async function zipEntries(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("export strips credentials and machine state, keeps config and labs", async () => {
  const home = makeHome();
  try {
    const { bytes, stats } = await exportProjectConfigBundle(home, "demo");
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    assert.ok(names.includes(".pi/agents/auditor.md"));
    assert.ok(names.includes(".pi/models.json"));
    assert.ok(names.includes("labs/lab1.yaml"));
    assert.ok(names.includes("manifest.json"));
    assert.ok(!names.some((n) => n.includes("auth.json")), "auth.json must not travel");
    assert.ok(!names.some((n) => n.includes("sessions")), "sessions must not travel");
    const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
    assert.equal(manifest.format, BUNDLE_FORMAT);
    assert.equal(manifest.project, "demo");
    assert.equal(stats.files, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("import applies additively and reports added/overwritten", async () => {
  const home = makeHome();
  try {
    const bytes = await zipEntries({
      ".pi/agents/reviewer.md": "---\ndescription: review\n---\nReview.\n",
      ".pi/agents/auditor.md": "---\ndescription: v2\n---\nOverwritten.\n",
      "labs/lab2.yaml": "name: lab2\n",
      "readme.md": "hello",
    });
    const stats = await importProjectConfigBundle(home, bytes);
    assert.equal(stats.added, 2);
    assert.equal(stats.overwritten, 1);
    assert.ok(existsSync(join(home, ".pi", "agents", "reviewer.md")));
    assert.equal(readFileSync(join(home, ".pi", "agents", "auditor.md"), "utf8"), "---\ndescription: v2\n---\nOverwritten.\n");
    assert.ok(!existsSync(join(home, "readme.md")), "root readme is metadata, never written");
    // existing unrelated config survives
    assert.ok(existsSync(join(home, ".pi", "models.json")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("import rejects path traversal and outside-whitelist paths without writing", async () => {
  for (const evil of [
    { "../escape.md": "x" },
    { ".pi/../../escape.md": "x" },
    { "/etc/evil": "x" },
    { "etc/evil.conf": "x" },
    { ".pi/sessions/hijack.jsonl": "x" },
    { ".pi/auth.json": "{\"apiKey\":\"x\"}" },
  ]) {
    const home = mkdtempSync(join(tmpdir(), "cfg-bundle-guard-"));
    try {
      const bytes = await zipEntries(evil);
      if (Object.keys(evil)[0].includes("sessions") || Object.keys(evil)[0].includes("auth.json")) {
        // denied-but-whitelisted paths are skipped silently; a bundle with
        // nothing else importable then reports that honestly.
        await assert.rejects(() => importProjectConfigBundle(home, bytes), /没有可导入/);
      } else {
        await assert.rejects(() => importProjectConfigBundle(home, bytes), /不支持|路径|不支持绝对/);
      }
      assert.ok(!existsSync(join(home, "..", "escape.md".split("/").pop())), "no escape file");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("import rejects empty and non-zip payloads", async () => {
  const home = mkdtempSync(join(tmpdir(), "cfg-bundle-bad-"));
  try {
    await assert.rejects(() => importProjectConfigBundle(home, Buffer.from("not a zip")), /无法解析/);
    const emptyZip = await zipEntries({ "readme.md": "only metadata" });
    await assert.rejects(() => importProjectConfigBundle(home, emptyZip), /没有可导入/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("export → import roundtrip restores config into a fresh home", async () => {
  const src = makeHome();
  const dst = mkdtempSync(join(tmpdir(), "cfg-bundle-dst-"));
  try {
    const { bytes } = await exportProjectConfigBundle(src, "rt");
    const stats = await importProjectConfigBundle(dst, bytes);
    assert.equal(stats.added, 3);
    assert.equal(readFileSync(join(dst, ".pi", "agents", "auditor.md"), "utf8"), "---\ndescription: audit\n---\nAudit.\n");
    assert.ok(existsSync(join(dst, "labs", "lab1.yaml")));
    assert.ok(!existsSync(join(dst, ".pi", "auth.json")));
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});
