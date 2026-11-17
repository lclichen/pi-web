import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-embed-profiles-"));
process.env.PI_WEB_DATA_DIR = dataDir;

const { DEFAULT_EMBED_PROFILE, getEmbedProfile, listEmbedProfiles, saveEmbedProfiles } = await import(
  "./embed-profiles.ts"
);

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test("falls back to the built-in product before any admin configuration", () => {
  const products = listEmbedProfiles();
  assert.equal(products.length, 1);
  assert.equal(products[0].id, DEFAULT_EMBED_PROFILE.id);
  assert.deepEqual(products[0].allowedCommands, DEFAULT_EMBED_PROFILE.allowedCommands);
});

test("saves products with normalized commands and canonical origins", () => {
  const saved = saveEmbedProfiles([
    {
      id: "CRM",
      name: " CRM ",
      allowedCommands: ["/compact", "Skill:Foo", "compact"],
      allowedOrigins: ["https://app.example.com/"],
      enabled: true,
    },
  ]);
  assert.equal(saved[0].id, "crm");
  assert.equal(saved[0].name, "CRM");
  assert.deepEqual(saved[0].allowedCommands, ["compact", "skill:foo"]);
  assert.deepEqual(saved[0].allowedOrigins, ["https://app.example.com"]);
  assert.deepEqual(getEmbedProfile("crm")?.allowedCommands, ["compact", "skill:foo"]);
});

test("supports a wildcard-only command list", () => {
  const saved = saveEmbedProfiles([
    { id: "all", name: "All", allowedCommands: ["*"], allowedOrigins: [], enabled: true },
  ]);
  assert.deepEqual(saved[0].allowedCommands, ["*"]);
});

test("rejects duplicate ids, invalid commands, and non-origin URLs", () => {
  assert.throws(
    () =>
      saveEmbedProfiles([
        { id: "a", name: "A", allowedCommands: [], allowedOrigins: [] },
        { id: "a", name: "B", allowedCommands: [], allowedOrigins: [] },
      ]),
    /Duplicate product id/,
  );
  assert.throws(
    () => saveEmbedProfiles([{ id: "a", name: "A", allowedCommands: ["bad command"], allowedOrigins: [] }]),
    /invalid command name/,
  );
  assert.throws(
    () => saveEmbedProfiles([{ id: "a", name: "A", allowedCommands: [], allowedOrigins: ["https://app.example.com/path"] }]),
    /Origin must not include a path/,
  );
  assert.throws(
    () => saveEmbedProfiles([{ id: "a", name: "A", allowedCommands: ["*", "compact"], allowedOrigins: [] }]),
    /cannot be combined/,
  );
});

test("disabled products remain stored but are not returned by the enabled lookup used for links", async () => {
  saveEmbedProfiles([{ id: "off", name: "Off", allowedCommands: [], allowedOrigins: [], enabled: false }]);
  assert.equal(getEmbedProfile("off")?.enabled, false);
});
