import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseSshDirectoryListing, stripSshExecFence } = await jiti.import("./ssh.ts");

const OUTPUT = [
  "Welcome to AMEDAC appliance",
  "@@PI_SSH_LIST_BEGIN@@",
  "@@PI_SSH_LIST_PATH@@/srv/app",
  "@@PI_SSH_LIST_DIR@@src",
  "@@PI_SSH_LIST_DIR@@docs",
  "@@PI_SSH_LIST_END@@",
  "logout banner",
].join("\n");

test("the fenced listing ignores server banners before and after", () => {
  assert.deepEqual(parseSshDirectoryListing(OUTPUT), {
    path: "/srv/app",
    entries: [
      { name: "docs", isDir: true, size: 0 },
      { name: "src", isDir: true, size: 0 },
    ],
  });
});

test("CRLF output and a trailing slash on the path are tolerated", () => {
  const crlf = OUTPUT.replace(/\n/g, "\r\n").replace("/srv/app", "/srv/app/");
  assert.equal(parseSshDirectoryListing(crlf)?.path, "/srv/app");
});

test("missing markers are reported as unparseable, not as an empty directory", () => {
  assert.equal(parseSshDirectoryListing("Welcome\n/srv/app\nsrc\n"), null);
  assert.equal(parseSshDirectoryListing("@@PI_SSH_LIST_BEGIN@@\nsrc\n"), null);
});

test("exec fences drop .bashrc/startup output but keep the command result", () => {
  const stdout =
    "AMEDAC welcome\n" +
    "@@PI_SSH_EXEC_BEGIN_a1b2c3d4e5f60708@@\n" +
    "real stdout\n" +
    "\n@@PI_SSH_EXEC_END_a1b2c3d4e5f60708@@ 0\n";
  assert.deepEqual(stripSshExecFence(stdout), { text: "real stdout\n", code: 0 });

  const stderr =
    "banner on stderr\n@@PI_SSH_EXEC_BEGIN_a1b2c3d4e5f60708@@\noops\n\n@@PI_SSH_EXEC_END_a1b2c3d4e5f60708@@ 2\n";
  assert.deepEqual(stripSshExecFence(stderr), { text: "oops\n", code: 2 });
});

test("a command that replaced the shell keeps its output after the begin marker", () => {
  const stdout = "banner\n@@PI_SSH_EXEC_BEGIN_a1b2c3d4e5f60708@@\npartial output\n";
  assert.deepEqual(stripSshExecFence(stdout), { text: "partial output\n" });
});

test("output without a fence is returned unchanged (older/odd shells)", () => {
  assert.deepEqual(stripSshExecFence("plain\n"), { text: "plain\n" });
});
