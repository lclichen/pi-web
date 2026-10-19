import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// server-settings 落盘在 dataDir——隔离到临时目录（PI_WEB_DATA_DIR）。
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-skillhub-"));
const prevDataDir = process.env.PI_WEB_DATA_DIR;
process.env.PI_WEB_DATA_DIR = dataDir;
test.after(() => {
  if (prevDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
  else process.env.PI_WEB_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const skillhub = await import("jiti").then(({ createJiti }) => createJiti(import.meta.url).import("./skillhub.ts"));
const { normalizeSkillhubBase, searchSkillhub, skillhubItemToSearchResult, downloadSkillhubZip } = skillhub;

test("normalizeSkillhubBase trims slashes and rejects non-http protocols", () => {
  assert.equal(normalizeSkillhubBase("http://h:1/skillhub/"), "http://h:1/skillhub");
  assert.equal(normalizeSkillhubBase("  https://hub.internal  "), "https://hub.internal");
  assert.throws(() => normalizeSkillhubBase("ftp://hub"), /http/);
  assert.throws(() => normalizeSkillhubBase("not a url"), /无效/);
});

test("searchSkillhub queries the web list API and maps items", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.match(String(input), /\/api\/web\/skills\?/);
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("q"), "flow");
    assert.equal(url.searchParams.get("namespace"), "global");
    assert.equal(url.searchParams.get("size"), "20");
    assert.equal(url.searchParams.get("page"), "0");
    return new Response(JSON.stringify({
      code: 0,
      data: {
        items: [
          { slug: "flowflow", namespace: "global", displayName: "Flow Flow", summary: " s ", downloadCount: 3, starCount: 0, updatedAt: "2026-08-11T08:13:58Z", publishedVersion: { version: "20260811.080411" } },
          { slug: "", namespace: "global" }, // 无 slug → 过滤
        ],
        total: 2,
      },
    }), { status: 200 });
  };
  try {
    const items = await searchSkillhub("http://hub/skillhub", { q: "flow", namespace: "global", size: 20 });
    assert.equal(items.length, 1);
    assert.equal(items[0].slug, "flowflow");
    assert.equal(items[0].displayName, "Flow Flow");
    assert.equal(items[0].summary, "s");
    assert.equal(items[0].latestVersion, "20260811.080411");
    assert.equal(items[0].downloads, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 1);
});

test("searchSkillhub surfaces hub errors (non-zero code / HTTP failure)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 400, msg: "bad" }), { status: 400 });
  await assert.rejects(() => searchSkillhub("http://hub", { q: "x" }), /HTTP 400/);
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 5, msg: "boom" }), { status: 200 });
  await assert.rejects(() => searchSkillhub("http://hub", { q: "x" }), /boom/);
  globalThis.fetch = originalFetch;
});

test("item → search result mapping (package=ns/slug, hub page url)", () => {
  const r = skillhubItemToSearchResult("http://hub/skillhub/", {
    namespace: "global", slug: "flowflow", displayName: "Flow", summary: "s",
    downloads: 1200, stars: 0, latestVersion: "20260811.080411", updatedAt: "",
  });
  assert.equal(r.source, "skillhub");
  assert.equal(r.package, "global/flowflow");
  assert.equal(r.installs, "1.2K downloads");
  assert.equal(r.url, "http://hub/skillhub/space/global/flowflow");
  assert.equal(r.version, "20260811.080411");
});

test("downloadSkillhubZip hits the v1 download endpoint and parses filename", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "http://hub/api/v1/skills/global/flowflow/versions/20260811.080411/download");
    return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 200,
      headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="flowflow-20260811.080411.zip"' },
    });
  };
  try {
    const dl = await downloadSkillhubZip("http://hub", "global", "flowflow", "20260811.080411");
    assert.equal(dl.filename, "flowflow-20260811.080411.zip");
    assert.equal(dl.data.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadSkillhubZip latest-version form omits the version path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "http://hub/api/v1/skills/global/flowflow/download");
    return new Response(new Uint8Array([1]), { status: 200 });
  };
  try {
    await downloadSkillhubZip("http://hub", "global", "flowflow");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// server-settings 的 skillhubUrl：env 播种、非法值拒绝、空串清除。
test("server-settings skillhubUrl: env seed, validation, clear", async () => {
  process.env.PI_WEB_SKILLHUB_URL = "http://hub.internal/skillhub/";
  const settings = await import("jiti").then(({ createJiti }) => createJiti(import.meta.url).import("./server-settings.ts"));
  // env 播种（尾斜杠归一）
  assert.equal(settings.getServerSettings().skillhubUrl, "http://hub.internal/skillhub");
  // 更新：非法协议拒绝
  assert.throws(() => settings.updateServerSettings({ skillhubUrl: "ftp://x" }), /http/);
  // 更新：合法值覆盖
  assert.equal(settings.updateServerSettings({ skillhubUrl: "http://hub2" }).skillhubUrl, "http://hub2");
  // 清除：空串
  const cleared = settings.updateServerSettings({ skillhubUrl: "" });
  assert.equal(cleared.skillhubUrl, undefined);
  delete process.env.PI_WEB_SKILLHUB_URL;
});
