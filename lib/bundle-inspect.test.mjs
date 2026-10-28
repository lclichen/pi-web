import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { inspectBundleZip, isPreviewablePath, looksBinary, readBundleFileFromZip } from "./bundle-inspect.ts";

async function sampleZip() {
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({
      format: { version: 2, exportedAt: "2026-10-23T00:00:00Z" },
      package: {
        name: "deep-researcher",
        title: "深度研究员",
        description: "研究型 Agent 定义",
        version: "1.4.0",
        channel: "stable",
        dependencies: ["node>=20", "python>=3.11"],
      },
    }),
  );
  zip.file("readme.md", "# readme");
  zip.file("agents.md", "# instructions");
  zip.file(".pi/extensions/researcher/index.js", "// extension code");
  zip.file(".pi/extensions/researcher/package.json", '{"name":"researcher"}');
  zip.file(".pi/skills/dep-check/SKILL.md", "---\nname: dep-check\n---");
  zip.file(".pi/agents/planner.md", "# planner");
  zip.file(".pi/subagents.json", "[]");
  zip.file(
    ".pi/models.json",
    JSON.stringify({ modelList: [{ id: "qwen-3.8" }, { id: "glm-5.3" }, { id: "qwen-3.8" }] }),
  );
  zip.file(".pi/mcp.json", JSON.stringify({ mcpServers: { weather: { command: "x" }, db: { command: "y" } } }));
  zip.file("labs/lab1.yaml", "name: lab1");
  zip.file(".pi/settings.json", "{}");
  return zip.generateAsync({ type: "nodebuffer" });
}

test("classifies bundle contents and extracts package identity + dependencies", async () => {
  const inspection = await inspectBundleZip(await sampleZip());
  assert.equal(inspection.package?.name, "deep-researcher");
  assert.equal(inspection.package?.version, "1.4.0");
  assert.deepEqual(inspection.dependencies, ["node>=20", "python>=3.11"]);
  assert.equal(inspection.format.version, 2);
  assert.equal(inspection.hasReadme, true);
  assert.equal(inspection.counts.extensions, 2);
  assert.equal(inspection.counts.skills, 1);
  assert.equal(inspection.counts.agents, 2); // agents/planner.md + subagents.json
  // Duplicate model ids are deduped.
  assert.equal(inspection.counts.models, 2);
  assert.deepEqual(inspection.models[0].models, ["qwen-3.8", "glm-5.3"]);
  assert.equal(inspection.counts.mcp, 2);
  assert.deepEqual(inspection.mcp[0].servers, ["weather", "db"]);
  assert.equal(inspection.counts.labs, 1);
  assert.equal(inspection.counts.other, 1); // .pi/settings.json
  assert.ok(inspection.manifest);
});

test("preview whitelist and bounded file reads", async () => {
  const bytes = await sampleZip();
  assert.equal(isPreviewablePath(".pi/extensions/researcher/index.js"), true);
  assert.equal(isPreviewablePath("labs/lab1.yaml"), true);
  assert.equal(isPreviewablePath("readme.md"), true);
  assert.equal(isPreviewablePath("../etc/passwd"), false);
  assert.equal(isPreviewablePath("manifest.json"), false); // metadata, not previewable

  const file = await readBundleFileFromZip(bytes, ".pi/extensions/researcher/index.js");
  assert.equal(file.bytes.toString("utf8"), "// extension code");
  assert.equal(file.truncated, false);

  await assert.rejects(() => readBundleFileFromZip(bytes, "nope.txt"));
  assert.equal(looksBinary(Buffer.from("plain text")), false);
  assert.equal(looksBinary(Buffer.from([0x00, 0x01, 0x02, 0x03])), true);
});

test("malformed archives fail with a clear error", async () => {
  await assert.rejects(() => inspectBundleZip(Buffer.from("not a zip")), /无法解析压缩包/);
});
