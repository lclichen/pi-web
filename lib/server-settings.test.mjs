import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Deployment settings: the config-bundle upload cap is seeded from the
 * environment, overridable by an admin at runtime, persisted, and resettable.
 * Invalid values must fail loudly (never silently fall back to a wrong cap).
 */

process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "server-settings-"));
process.env.PI_WEB_BUNDLE_UPLOAD_MAX_MB = "300";
process.env.PI_WEB_PUBLIC_URL = "https://pi.example.test/pi-web/";

// server-settings.ts uses bundler-style extensionless imports — load via jiti
// (same loader the app's tests use), not bare node ESM resolution.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  BUNDLE_UPLOAD_DEFAULT_MB,
  BUNDLE_UPLOAD_CONFIRM_MB,
  getBundleUploadMaxMb,
  getPublicBaseUrl,
  getServerSettings,
  normalizePackageMirrorUrl,
  normalizePublicBaseUrl,
  normalizeOtelEndpoint,
  normalizeOtelHeaders,
  normalizeUploadMaxMb,
  updateServerSettings,
} = await jiti.import("./server-settings.ts");
const { resetStateStoresForTests } = await jiti.import("./state/json-store.ts");

const SETTINGS_FILE = join(process.env.PI_WEB_DATA_DIR, "state", "global", "server-settings.json");

function freshRead() {
  // Simulate a process restart: drop the in-memory cache, re-read the file.
  resetStateStoresForTests();
}

test("env seeds the bundle cap; the default applies without one", () => {
  assert.equal(getBundleUploadMaxMb(), 300);
  assert.equal(BUNDLE_UPLOAD_CONFIRM_MB, 200);
  assert.ok(BUNDLE_UPLOAD_DEFAULT_MB >= BUNDLE_UPLOAD_CONFIRM_MB);
});

test("admin override persists and survives a restart", () => {
  const updated = updateServerSettings({ bundleUploadMaxMb: 512 });
  assert.equal(updated.bundleUploadMaxMb, 512);
  assert.equal(getBundleUploadMaxMb(), 512);
  freshRead();
  assert.equal(getBundleUploadMaxMb(), 512);
  const stored = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")).data;
  assert.equal(stored.bundleUploadMaxMb, 512);
});

test("clearing the override restores the env seed, not a hardcoded number", () => {
  updateServerSettings({ bundleUploadMaxMb: null });
  freshRead();
  assert.equal(getBundleUploadMaxMb(), 300);
  assert.equal(getServerSettings().bundleUploadMaxMb, 300);
});

test("invalid caps are rejected and leave the previous value intact", () => {
  assert.equal(normalizeUploadMaxMb("1024", "x"), 1024);
  assert.equal(normalizeUploadMaxMb(64, "x"), 64);
  assert.equal(normalizeUploadMaxMb("", "x"), undefined);
  assert.equal(normalizeUploadMaxMb(null, "x"), undefined);
  for (const bad of [0, -1, 1.5, 65537, "abc", "12MB"]) {
    assert.throws(() => normalizeUploadMaxMb(bad, "bundleUploadMaxMb"), /bundleUploadMaxMb/);
  }
  updateServerSettings({ bundleUploadMaxMb: 700 });
  assert.throws(() => updateServerSettings({ bundleUploadMaxMb: 0 }), /bundleUploadMaxMb/);
  assert.equal(getBundleUploadMaxMb(), 700);
});

test("public base URL: env seed, normalization, override and reset", () => {
  // Env seeded + normalized (trailing slash stripped).
  assert.equal(getPublicBaseUrl(), "https://pi.example.test/pi-web");
  assert.equal(normalizePublicBaseUrl("pi-web.internal:30141"), "http://pi-web.internal:30141");
  assert.equal(normalizePublicBaseUrl("https://Example.com/pi-web/"), "https://example.com/pi-web");
  assert.equal(normalizePublicBaseUrl(""), undefined);
  assert.equal(normalizePublicBaseUrl(null), undefined);
  for (const bad of ["ftp://host", "http://user:pass@host", "http://host/?a=1", "http://host/#x"]) {
    assert.throws(() => normalizePublicBaseUrl(bad), /publicBaseUrl/);
  }

  updateServerSettings({ publicBaseUrl: "https://share.example.test/prefix/" });
  assert.equal(getPublicBaseUrl(), "https://share.example.test/prefix");
  freshRead();
  assert.equal(getPublicBaseUrl(), "https://share.example.test/prefix");
  const stored = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")).data;
  assert.equal(stored.publicBaseUrl, "https://share.example.test/prefix");

  // Clearing the override falls back to the deployment env seed.
  updateServerSettings({ publicBaseUrl: "" });
  assert.equal(getServerSettings().publicBaseUrl, undefined);
  assert.equal(getPublicBaseUrl(), "https://pi.example.test/pi-web");
});

test("disableNpmPackages toggles PI_OFFLINE without overriding an operator value", () => {
  const previous = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  freshRead();
  try {
    const enabled = updateServerSettings({ disableNpmPackages: true });
    assert.equal(enabled.disableNpmPackages, true);
    assert.equal(process.env.PI_OFFLINE, "1");
    freshRead();
    assert.equal(getServerSettings().disableNpmPackages, true);

    const disabled = updateServerSettings({ disableNpmPackages: false });
    assert.equal(disabled.disableNpmPackages, false);
    assert.equal(process.env.PI_OFFLINE, undefined);

    // Operator-provided offline mode is never cleared by the pi-web toggle.
    process.env.PI_OFFLINE = "1";
    updateServerSettings({ disableNpmPackages: false });
    assert.equal(process.env.PI_OFFLINE, "1");
  } finally {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  }
});

test("package mirrors normalize and project into npm/pip env", () => {
  const names = ["NPM_CONFIG_REGISTRY", "npm_config_registry", "PIP_INDEX_URL"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  // npm itself exports npm_config_registry when tests run under `npm test`;
  // the module captured that value before this test, so clearing the admin
  // override must restore it rather than hard-code undefined.
  const baseline = { ...previous };
  for (const name of names) delete process.env[name];
  freshRead();
  try {
    assert.equal(
      normalizePackageMirrorUrl("https://registry.npmmirror.com/", "npmRegistry"),
      "https://registry.npmmirror.com",
    );
    assert.equal(
      normalizePackageMirrorUrl("https://pypi.tuna.tsinghua.edu.cn/simple/", "pipIndexUrl"),
      "https://pypi.tuna.tsinghua.edu.cn/simple",
    );
    for (const bad of ["ftp://mirror", "http://user:pass@mirror", "http://mirror/?x=1"]) {
      assert.throws(() => normalizePackageMirrorUrl(bad, "npmRegistry"), /npmRegistry/);
    }

    updateServerSettings({
      npmRegistry: "https://registry.npmmirror.com/",
      pipIndexUrl: "https://pypi.tuna.tsinghua.edu.cn/simple/",
    });
    assert.equal(process.env.NPM_CONFIG_REGISTRY, "https://registry.npmmirror.com");
    assert.equal(process.env.npm_config_registry, "https://registry.npmmirror.com");
    assert.equal(process.env.PIP_INDEX_URL, "https://pypi.tuna.tsinghua.edu.cn/simple");
    freshRead();
    assert.equal(getServerSettings().npmRegistry, "https://registry.npmmirror.com");
    assert.equal(getServerSettings().pipIndexUrl, "https://pypi.tuna.tsinghua.edu.cn/simple");

    updateServerSettings({ npmRegistry: "", pipIndexUrl: "" });
    for (const name of names) assert.equal(process.env[name], baseline[name]);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("npm package installs default to disabled; the admin can opt in", () => {
  const previousToggle = process.env.PI_WEB_DISABLE_NPM_PACKAGES;
  const previousOffline = process.env.PI_OFFLINE;
  try {
    rmSync(SETTINGS_FILE, { force: true });
    delete process.env.PI_WEB_DISABLE_NPM_PACKAGES;
    delete process.env.PI_OFFLINE;
    freshRead();
    assert.equal(getServerSettings().disableNpmPackages, true, "offline-first default");

    process.env.PI_WEB_DISABLE_NPM_PACKAGES = "0";
    freshRead();
    assert.equal(getServerSettings().disableNpmPackages, false, "explicit 0 re-enables installs");
  } finally {
    if (previousToggle === undefined) delete process.env.PI_WEB_DISABLE_NPM_PACKAGES;
    else process.env.PI_WEB_DISABLE_NPM_PACKAGES = previousToggle;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    freshRead();
  }
});

test("OTLP settings: endpoint and headers are validated and persisted", () => {
  assert.equal(normalizeOtelEndpoint("http://localhost:8087/"), "http://localhost:8087");
  assert.equal(normalizeOtelEndpoint("localhost:8087"), "http://localhost:8087");
  assert.equal(normalizeOtelEndpoint("https://mlflow.example.test/mlflow/"), "https://mlflow.example.test/mlflow");
  assert.equal(normalizeOtelEndpoint(""), undefined);
  for (const bad of ["ftp://host", "http://user:pass@host", "http://host/?a=1", "http://host/#x"]) {
    assert.throws(() => normalizeOtelEndpoint(bad), /OTLP/);
  }
  assert.deepEqual(normalizeOtelHeaders({ "x-mlflow-experiment-id": "42" }), {
    "x-mlflow-experiment-id": "42",
  });
  assert.equal(normalizeOtelHeaders({}), undefined);
  assert.throws(() => normalizeOtelHeaders({ "bad header": "x" }), /OTLP/);
  assert.throws(() => normalizeOtelHeaders({ ok: "line\nbreak" }), /OTLP/);

  const updated = updateServerSettings({
    otelEnabled: true,
    otelEndpoint: "http://localhost:8087",
    otelHeaders: { "x-mlflow-experiment-id": "42" },
  });
  assert.equal(updated.otelEnabled, true);
  assert.equal(updated.otelEndpoint, "http://localhost:8087");
  assert.equal(updated.otelHeaders["x-mlflow-experiment-id"], "42");
  freshRead();
  assert.equal(getServerSettings().otelEnabled, true);

  updateServerSettings({ otelEnabled: false, otelEndpoint: null, otelHeaders: null });
  freshRead();
  assert.equal(getServerSettings().otelEnabled, false);
  assert.equal(getServerSettings().otelEndpoint, undefined);
  assert.equal(getServerSettings().otelHeaders, undefined);
});
