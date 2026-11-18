import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./EmbedShell.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("mounts a session-only chat shell without project navigation", () => {
  assert.match(source, /<ChatWindow/);
  assert.match(source, /embedded\s+embeddedDensity=\{density\}/);
  assert.match(source, /commandAllowlist=\{allowedCommands\}/);
  assert.doesNotMatch(source, /#session-sidebar/);
  assert.doesNotMatch(source, /ProjectSessionTree/);
  assert.doesNotMatch(source, /EnvironmentsMenu/);
  assert.doesNotMatch(source, /\/api\/projects/);
});

test("scopes the session list to the stable project", () => {
  assert.match(source, /fetch\(`\/api\/sessions\$\{showArchived \? "\?includeArchived=1" : ""\}`/);
  assert.match(source, /newSessionCwd=\{selected \? null : scope\.cwd\}/);
  assert.match(source, /newSessionProjectId=\{selected \? null : scope\.projectId\}/);
  assert.match(source, /onSessionCreated=\{handleSessionCreated\}/);
});

test("measures the container and switches density for side rails and bottom bars", () => {
  assert.match(source, /new ResizeObserver\(update\)/);
  assert.match(source, /size\.height < 240/);
  assert.match(source, /size\.height < 480/);
  assert.match(source, /size\.width < 420/);
  assert.match(source, /data-density=\{density\}/);
  assert.match(cssSource, /\.embed-shell\[data-density="compact"\] \.embed-header \{[\s\S]*?height: 36px/);
  assert.match(cssSource, /\.embed-shell\[data-density="mini"\] \.embed-header \{[\s\S]*?height: 30px/);
  assert.match(cssSource, /height: 100%;[\s\S]*?min-height: 0;/);
});

test("supports session rename, archive, delete, and account switching", () => {
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /archived: !session\.archivedAt/);
  assert.match(source, /setRenamingId\(session\.id\)/);
  assert.match(source, /onSwitchAccount/);
  assert.match(source, /onAuthExpired/);
  assert.match(source, /includeArchived=1/);
});

test("offers explicit product config reapply and honours the access-token expiry", () => {
  assert.match(source, /\/api\/embed\/workspace\/reapply-config/);
  assert.match(source, /configUpdateAvailable/);
  assert.match(source, /onAuthExpired\(\)/);
  assert.match(source, /pi-embed-last:\$\{scope\.projectId\}/);
});
