import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Remote backends have no in-process watcher: the watch route polls the
// parent listing and speaks the same SSE events the local watcher does, so
// every remote viewer refreshes on change without a client-side special case.
const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("remote watch serves a polled SSE stream instead of a 501", () => {
  const watchStart = source.indexOf('if (type === "watch")');
  const watchBlock = source.slice(watchStart, source.indexOf('if (type === "list")', watchStart));
  assert.notEqual(watchStart, -1, "watch branch not found");
  assert.match(watchBlock, /remoteList\(remote\.ctx, directory\)/);
  assert.match(watchBlock, /Content-Type": "text\/event-stream/);
  assert.match(watchBlock, /event: \$\{event\}/);
  assert.match(watchBlock, /send\("connected"/);
  assert.match(watchBlock, /send\("change"/);
  assert.match(watchBlock, /send\("ping"/);
  assert.match(watchBlock, /setInterval\(\(\) => void poll\(\), 3_000\)/);
});

test("ssh listings carry mtime so a same-size edit still changes the watch signature", async () => {
  const remote = await readFile(new URL("../../../lib/remote-session.ts", import.meta.url), "utf8");
  assert.match(remote, /modified: e\.attrs\.mtime \? new Date\(e\.attrs\.mtime \* 1000\)\.toISOString\(\) : ""/);
});
