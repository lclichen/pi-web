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

test("scopes the session list and creates sessions through the workspace props", () => {
  assert.match(source, /fetch\("\/api\/sessions"/);
  assert.match(source, /newSessionCwd=\{selected \? null : scope\.cwd\}/);
  assert.match(source, /newSessionProjectId=\{selected \? null : scope\.kind === "project" \? scope\.projectId : null\}/);
  assert.match(source, /onSessionCreated=\{handleSessionCreated\}/);
  assert.match(source, /onSessionForked=\{handleSessionForked\}/);
});

test("measures the container and switches density for side rails and bottom bars", () => {
  assert.match(source, /new ResizeObserver\(update\)/);
  assert.match(source, /size\.height < 240/);
  assert.match(source, /size\.height < 480/);
  assert.match(source, /size\.width < 420/);
  assert.match(source, /data-density=\{density\}/);
  assert.match(cssSource, /\.embed-shell\[data-density="compact"\] \.embed-header \{[\s\S]*?height: 36px/);
  assert.match(cssSource, /\.embed-shell\[data-density="mini"\] \.embed-header \{[\s\S]*?height: 30px/);
  assert.match(cssSource, /\.embed-shell\[data-density="compact"\] \.embed-sessions-popover \{[\s\S]*?left: 6px/);
  assert.match(cssSource, /height: 100%;[\s\S]*?min-height: 0;/);
});

test("exposes session switching and new chat without a project picker", () => {
  assert.match(source, /aria-label=\{t\("embed\.sessions"\)\}/);
  assert.match(source, /aria-label=\{t\("embed\.newChat"\)\}/);
  assert.match(source, /window\.history\.replaceState/);
  assert.match(source, /setNewDraftKey\(`embed-\$\{token\.slice\(-8\)\}-new-\$\{Date\.now\(\)\}`\)/);
});
