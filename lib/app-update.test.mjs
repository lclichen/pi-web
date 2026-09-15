import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getPiWebReleaseUrl, isNewerStableVersion, isNewerSemver, parseUpdateCatalog, selectCatalogTarget } = await jiti.import("./app-update.ts");

test("detects newer stable Pi Web versions", () => {
  assert.equal(isNewerStableVersion("0.8.8", "0.8.7"), true);
  assert.equal(isNewerStableVersion("0.9.0", "0.8.7"), true);
  assert.equal(isNewerStableVersion("1.0.0", "0.9.9"), true);
});

test("does not report equal, older, or unsupported versions as updates", () => {
  assert.equal(isNewerStableVersion("0.8.7", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.6", "0.8.7"), false);
  assert.equal(isNewerStableVersion("0.8.8-beta.1", "0.8.7"), false);
  assert.equal(isNewerStableVersion("invalid", "0.8.7"), false);
});

test("builds a release-notes URL only for stable versions", () => {
  assert.equal(
    getPiWebReleaseUrl("0.8.8"),
    "https://github.com/agegr/pi-web/releases/tag/v0.8.8",
  );
  assert.equal(getPiWebReleaseUrl("0.8.8-beta.1"), null);
});

test("semver comparison handles prerelease channels", () => {
  // 用户 catalog 的实际形态：0.0.3-alpha > 0.0.1-alpha
  assert.equal(isNewerSemver("0.0.3-alpha", "0.0.1-alpha"), true);
  assert.equal(isNewerSemver("0.0.1-alpha", "0.0.3-alpha"), false);
  // 同版本不算更新
  assert.equal(isNewerSemver("0.0.3-alpha", "0.0.3-alpha"), false);
  // 正式版 > 同号预发布
  assert.equal(isNewerSemver("0.1.0", "0.1.0-rc.1"), true);
  assert.equal(isNewerSemver("0.1.0-rc.1", "0.1.0"), false);
  // 预发布标识排序：alpha < beta < rc.1 < rc.2
  assert.equal(isNewerSemver("0.1.0-beta", "0.1.0-alpha"), true);
  assert.equal(isNewerSemver("0.1.0-rc.2", "0.1.0-rc.1"), true);
  assert.equal(isNewerSemver("0.1.0-rc.1", "0.1.0-rc.1"), false);
  // 数字段按数值比较（不是字典序）
  assert.equal(isNewerSemver("0.1.0-rc.10", "0.1.0-rc.9"), true);
  // 核心号优先于预发布
  assert.equal(isNewerSemver("0.2.0-alpha", "0.1.9"), true);
  assert.equal(isNewerSemver("not-a-version", "0.1.0"), false);
});

test("parses catalog.json and selects the channel target", () => {
  const catalog = parseUpdateCatalog({
    schema_version: 1,
    project: "amedac.ai-agent-framework",
    default_version: "0.0.3-alpha",
    latest_versions: { alpha: "0.0.3-alpha" },
    versions: [
      {
        version: "0.0.3-alpha",
        channel: "alpha",
        released_at: "2026-09-14T10:28:35Z",
        release_dir: "releases/alpha/0.0.3-alpha",
        frameworks: {
          tarball: {
            file_name: "amedac.ai-x64.tar.gz",
            relative_path: "releases/alpha/0.0.3-alpha/tarball/amedac.ai-x64.tar.gz",
            checksum_sha256: "66cb840f6e0cb04893230bde34a423e18529f94f93658d0a03baabde2c00a793",
            size_bytes: 286531768,
          },
          appimage: {
            file_name: "amedac.ai-x64.AppImage",
            relative_path: "releases/alpha/0.0.3-alpha/appimage/amedac.ai-x64.AppImage",
            // 用户示例的该 sha256 是 65 字符（多 1 位，解析器会拒）——测试用合成的
            // 合法 64 字符大写值，顺带验证大小写归一。
            checksum_sha256: "A".repeat(63) + "B",
            size_bytes: 241601016,
          },
        },
      },
    ],
  });
  assert.equal(catalog.project, "amedac.ai-agent-framework");
  const target = selectCatalogTarget(catalog, "alpha");
  assert.equal(target?.version, "0.0.3-alpha");
  assert.equal(target?.frameworks.tarball?.file_name, "amedac.ai-x64.tar.gz");
  // 大写 sha 归一为小写
  assert.equal(target?.frameworks.appimage?.checksum_sha256, "a".repeat(63) + "b");
  // channel 不匹配时回落 default_version 指到的条目
  assert.equal(selectCatalogTarget(catalog, "stable")?.version, "0.0.3-alpha");
});

test("rejects malformed catalogs", () => {
  assert.throws(() => parseUpdateCatalog({ schema_version: 2 }), /schema_version/);
  assert.throws(() => parseUpdateCatalog({ schema_version: 1 }), /default_version/);
  assert.throws(() => parseUpdateCatalog({ schema_version: 1, default_version: "0.0.1", versions: [] }), /没有可用版本/);
  // 坏 framework 被丢弃而不是炸整个 catalog
  const catalog = parseUpdateCatalog({
    schema_version: 1,
    default_version: "0.0.1",
    versions: [{ version: "0.0.1", channel: "alpha", frameworks: { tarball: { file_name: "x" } } }],
  });
  assert.equal(catalog.versions[0].frameworks.tarball, undefined);
});
