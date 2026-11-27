import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Remote sessions (sandbox / local-machine / SSH) run their tools on a remote
 * backend: the explorer lists /api/remotefs, the terminal talks to
 * /api/remoteterminal, and neither may fall back to the server's own files.
 */
const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const tabs = await readFile(new URL("./terminal-tab-state.ts", import.meta.url), "utf8");

test("the explorer switches to the remote listing while a remote session is selected", () => {
  assert.match(sidebar, /remoteSessionProp\?: \{ sessionId: string; label: string \} \| null/);
  assert.match(sidebar, /const remoteSession = remoteSessionProp \?\? null/);
  assert.match(sidebar, /cwd=\{remoteSession \? "\/" : explorerCwd\}/);
  assert.match(sidebar, /remote=\{remoteSession\}/);
  // Local-only actions disappear; upload/new/rename/delete stay (remote-aware).
  assert.match(sidebar, /\{!remoteSession && fileManagerButton\}/);
});

test("a remote draft waits instead of showing host files", () => {
  assert.match(sidebar, /pendingRemoteMode && pendingRemoteMode !== "host" && !remoteSession/);
  assert.match(sidebar, /sessions\.remoteFilesPending/);
});

test("the terminal opens on the session's remote backend", () => {
  assert.match(sidebar, /onOpenTerminal\?\.\("\/", remoteSession\)/);
  assert.match(shell, /const remoteSessionCtx = useMemo/);
  assert.match(shell, /activeSessionMode !== "host" && activeSessionMode !== "quick" && selectedSession/);
  assert.match(shell, /remoteSessionProp=\{remoteSessionCtx\}/);
  assert.match(shell, /pendingRemoteMode=\{pendingRemoteMode\}/);
  assert.match(shell, /<WorkspaceTerminal/);
  assert.match(shell, /remote=\{tab\.remote\}/);
  assert.match(tabs, /remote\?: \{ sessionId: string; label: string \}/);
  // Remote tabs are not restored as local ones (their cwd is "/").
  assert.match(shell, /terminalTabs\.filter\(\(tab\) => !tab\.remote\)/);
});

test("files opened from the remote explorer load through the remote viewer", async () => {
  assert.match(shell, /remote=\{remoteSessionCtx\}/);
  const viewer = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  assert.match(viewer, /remote = null,\s*onOpenFile,/);
  // Text, image, audio, video and document viewers all forward the context.
  assert.match(viewer, /<TextFileViewer[\s\S]*?remote=\{remote\}/);
  assert.match(viewer, /<ImageViewer[^>]*remote=\{remote\}/);
  assert.match(viewer, /<AudioViewer[^>]*remote=\{remote\}/);
  assert.match(viewer, /<VideoViewer[^>]*remote=\{remote\}/);
  assert.match(viewer, /<DocumentViewer[^>]*remote=\{remote\}/);
  assert.match(viewer, /getFileApiUrl\(filePath, "download", sourceSessionId, \{\}, remote\)/);
});
