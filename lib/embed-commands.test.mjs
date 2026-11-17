import assert from "node:assert/strict";
import test from "node:test";

const {
  EMBED_BUILTIN_COMMANDS,
  isEmbedCommandAllowed,
  normalizeEmbedCommandName,
  slashCommandNameFromText,
} = await import("./embed-commands.ts");

test("normalizes slash-prefixed command names", () => {
  assert.equal(normalizeEmbedCommandName("/Compact"), "compact");
  assert.equal(normalizeEmbedCommandName(" skill:Foo "), "skill:foo");
  assert.equal(normalizeEmbedCommandName("///name"), "name");
  assert.equal(normalizeEmbedCommandName(""), "");
});

test("allows explicit names, wildcard, and null allowlists", () => {
  assert.equal(isEmbedCommandAllowed(null, "anything"), true);
  assert.equal(isEmbedCommandAllowed(["*"], "anything"), true);
  assert.equal(isEmbedCommandAllowed(["compact", "skill:foo"], "/COMPACT"), true);
  assert.equal(isEmbedCommandAllowed(["compact"], "skill:foo"), false);
  assert.equal(isEmbedCommandAllowed([], "compact"), false);
});

test("extracts only command-like slash tokens", () => {
  assert.equal(slashCommandNameFromText("/compact"), "compact");
  assert.equal(slashCommandNameFromText("/name my session"), "name");
  assert.equal(slashCommandNameFromText("/skill:deploy now"), "skill:deploy");
  assert.equal(slashCommandNameFromText("/tmp/file"), null);
  assert.equal(slashCommandNameFromText("/"), null);
  assert.equal(slashCommandNameFromText("not a command"), null);
});

test("exposes the built-in command names without the slash", () => {
  assert.deepEqual([...EMBED_BUILTIN_COMMANDS], ["compact", "reload", "name", "session", "copy", "clone"]);
});
