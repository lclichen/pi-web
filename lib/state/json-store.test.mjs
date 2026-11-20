import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * JsonStore: one envelope, atomic replacement, .bak rotation, legacy
 * read-once migration and mtime-visible cache across store instances.
 */

const dataDir = mkdtempSync(join(tmpdir(), "json-store-"));
process.env.PI_WEB_DATA_DIR = dataDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { JsonStore, resetStateStoresForTests } = await jiti.import("./json-store.ts");

test.after(() => {
  delete process.env.PI_WEB_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function objectStore(name, legacy) {
  return new JsonStore({
    name,
    scope: { kind: "global" },
    legacyPaths: legacy ? () => [legacy] : undefined,
    defaults: () => ({ value: 0 }),
    parse: (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const value = raw.value;
      return typeof value === "number" ? { value } : null;
    },
  });
}

test("writes a versioned envelope, keeps a previous .bak and is 0600", () => {
  resetStateStoresForTests();
  const store = objectStore("probe");
  store.write({ value: 1 });
  assert.equal(store.path, join(dataDir, "state", "global", "probe.json"));
  const first = JSON.parse(readFileSync(store.path, "utf8"));
  assert.deepEqual(first, { schemaVersion: 1, data: { value: 1 } });

  store.update((current) => {
    current.value = 2;
  });
  assert.equal(store.read().value, 2);
  assert.deepEqual(JSON.parse(readFileSync(`${store.path}.bak`, "utf8")), first);

  if (process.platform !== "win32") {
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(store.path)).mode & 0o777, 0o700);
  }
});

test("migrates a legacy file once and never writes it again", () => {
  resetStateStoresForTests();
  const legacy = join(dataDir, "legacy-probe.json");
  writeFileSync(legacy, JSON.stringify({ value: 9 }));
  mkdirSync(join(dataDir, "state", "global"), { recursive: true });
  const store = objectStore("legacy-probe", legacy);

  assert.equal(store.read().value, 9);
  assert.ok(existsSync(store.path));
  assert.equal(JSON.parse(readFileSync(store.path, "utf8")).data.value, 9);
  assert.ok(existsSync(legacy), "legacy source stays in place for one release");

  // A later old-file change must not be visible once the new file exists.
  writeFileSync(legacy, JSON.stringify({ value: 10 }));
  resetStateStoresForTests();
  assert.equal(store.read().value, 9);
  store.update((current) => {
    current.value = 11;
  });
  assert.equal(JSON.parse(readFileSync(legacy, "utf8")).value, 10, "legacy file is read-only");
  assert.equal(store.read().value, 11);
});

test("a damaged envelope falls back to .bak and repairs the target", () => {
  resetStateStoresForTests();
  const store = objectStore("repair-probe");
  store.write({ value: 1 });
  store.write({ value: 2 });
  writeFileSync(store.path, '{"schemaVersion":1,"data":');
  resetStateStoresForTests();

  assert.equal(store.read().value, 1);
  assert.deepEqual(JSON.parse(readFileSync(store.path, "utf8")).data, { value: 1 });
});

test("user scope is isolated under state/users/u<id>", () => {
  resetStateStoresForTests();
  const store = new JsonStore({
    name: "preferences",
    scope: { kind: "user", userId: 7 },
    defaults: () => ({ value: 0 }),
    parse: (raw) => (raw && typeof raw === "object" && typeof raw.value === "number" ? { value: raw.value } : null),
  });
  store.write({ value: 3 });
  assert.equal(store.path, join(dataDir, "state", "users", "u7", "preferences.json"));
  assert.equal(store.read().value, 3);
  assert.throws(
    () => new JsonStore({ name: "../escape", scope: { kind: "global" }, defaults: () => ({}), parse: () => ({}) }).path,
    /Invalid state store name/,
  );
});

test("a second store instance sees the first instance's write via mtime", () => {
  resetStateStoresForTests();
  const a = objectStore("shared-probe");
  const b = objectStore("shared-probe");
  a.write({ value: 4 });
  assert.equal(b.read().value, 4);
  b.write({ value: 5 });
  assert.equal(a.read().value, 5);
});
