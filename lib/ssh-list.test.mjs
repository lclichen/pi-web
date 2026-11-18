import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseSshDirectoryListing } = await jiti.import("./ssh.ts");

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
