import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { detectFileLanguage } = await jiti.import("./file-language.ts");

/**
 * Shared file-type classifier. The remote file API used to hardcode
 * language:"text", which silently disabled the markdown/HTML preview in
 * sandbox / local-machine / ssh sessions (the viewer gates preview on
 * language). Both APIs must classify identically.
 */

test("markdown/html/css/etc. classify like the local file API", () => {
  assert.equal(detectFileLanguage("/w/README.md"), "markdown");
  assert.equal(detectFileLanguage("/w/docs/guide.mdx"), "markdown");
  assert.equal(detectFileLanguage("/w/index.html"), "html");
  assert.equal(detectFileLanguage("/w/index.htm"), "html");
  assert.equal(detectFileLanguage("C:\\work\\site\\a.css"), "css");
  assert.equal(detectFileLanguage("/w/main.ts"), "typescript");
  assert.equal(detectFileLanguage("/w/data.json"), "json");
});

test("special file names and unknown extensions", () => {
  assert.equal(detectFileLanguage("/w/Dockerfile"), "dockerfile");
  assert.equal(detectFileLanguage("/w/Dockerfile.dev"), "dockerfile");
  assert.equal(detectFileLanguage("/w/.env"), "bash");
  assert.equal(detectFileLanguage("/w/.env.local"), "bash");
  assert.equal(detectFileLanguage("/w/Makefile"), "makefile");
  assert.equal(detectFileLanguage("/w/weird.qqq"), "text");
  assert.equal(detectFileLanguage("/w/noext"), "text");
});

test("remote + local file APIs share the classifier (source shape)", async () => {
  const { readFile } = await import("node:fs/promises");
  const remotefs = await readFile(new URL("../app/api/remotefs/[...path]/route.ts", import.meta.url), "utf8");
  assert.match(remotefs, /language: detectFileLanguage\(filePath\)/);
  assert.doesNotMatch(remotefs, /language: "text"/);
  const local = await readFile(new URL("../app/api/files/[...path]/route.ts", import.meta.url), "utf8");
  assert.match(local, /detectFileLanguage\(filePath\)/);
  assert.doesNotMatch(local, /EXT_TO_LANGUAGE/);
});
