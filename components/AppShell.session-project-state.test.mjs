import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

/**
 * Stale draft-only state (newSessionProjectId/label/template) used to survive
 * selecting another session; model loading then asked /api/models?projectId=<id>
 * for a project that could already be deleted ("项目不存在").
 */

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function callbackBody(name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

test("every transition to an existing session clears draft-only project state", () => {
  for (const [name, nextName] of [
    ["handleSelectSession", "handleNewSession"],
    ["handleSessionCreated", "handleAgentEnd"],
    ["handleSessionForked", "handleInitialRestoreDone"],
    ["restoreWorkspaceContext", "handleCwdChange"],
  ]) {
    const body = callbackBody(name, nextName);
    assert.match(body, /setNewSessionProjectId\(null\);/, `${name} must clear newSessionProjectId`);
    assert.match(body, /setNewSessionProjectLabel\(null\);/, `${name} must clear newSessionProjectLabel`);
    assert.match(body, /setNewSessionTemplateId\(null\);/, `${name} must clear newSessionTemplateId`);
  }
});

test("selecting a session drops stale project state from a previously open draft", () => {
  const state = {
    selectedSession: null,
    sessionKey: 0,
    branchTree: [{ entry: {} }],
    branchActiveLeafId: "leaf",
    systemPrompt: "stale prompt",
    systemTools: [],
    systemInfoLoading: true,
    initialSessionRestored: false,
    newSessionCwd: "/stale-cwd",
    newSessionProjectId: "deleted-project",
    newSessionProjectLabel: "Deleted project",
    newSessionTemplateId: "stale-template",
    searchTarget: null,
    fileTabs: [],
    activeFileTabId: null,
    rightPanelOpen: true,
    activeTopPanel: null,
    sidebarOpen: true,
  };
  const routerCalls = [];
  const set = (key) => (value) => {
    state[key] = typeof value === "function" ? value(state[key]) : value;
  };
  const context = vm.createContext({
    state,
    URLSearchParams,
    workspaceKeyOf: (session) => session.projectKey ?? session.cwd,
    parkedNewSessionDraftKey: (cwd) => `parked:${cwd}`,
    rekeyDraft() {},
    invalidateWorkspaceRestore() {},
    activeNewSessionDraftKeyRef: { current: null },
    activeProjectKeyRef: { current: "/stale-cwd" },
    branchLeafChangeFnRef: { current: null },
    activeCwd: "/stale-cwd",
    newSessionCwd: "/stale-cwd",
    selectedSession: null,
    activeFileTabId: null,
    isMobile: false,
    router: { replace: (url) => routerCalls.push(url) },
    setSearchTarget: set("searchTarget"),
    setFileTabs: set("fileTabs"),
    setActiveFileTabId: set("activeFileTabId"),
    setRightPanelOpen: set("rightPanelOpen"),
    setActiveTopPanel: set("activeTopPanel"),
    setNewSessionCwd: set("newSessionCwd"),
    setNewSessionProjectId: set("newSessionProjectId"),
    setNewSessionProjectLabel: set("newSessionProjectLabel"),
    setNewSessionTemplateId: set("newSessionTemplateId"),
    setSelectedSession: set("selectedSession"),
    setSessionKey: set("sessionKey"),
    setBranchTree: set("branchTree"),
    setBranchActiveLeafId: set("branchActiveLeafId"),
    setSystemPrompt: set("systemPrompt"),
    setSystemTools: set("systemTools"),
    setSystemInfoLoading: set("systemInfoLoading"),
    setInitialSessionRestored: set("initialSessionRestored"),
    setSidebarOpen: set("sidebarOpen"),
  });
  context.useCallback = (callback) => callback;
  vm.runInContext(
    stripTypeScriptTypes(`
      ${callbackBody("handleSelectSession", "handleNewSession")}
      globalThis.selectSession = handleSelectSession;
    `),
    context,
  );

  context.selectSession({
    id: "s1",
    path: "/sessions/s1.jsonl",
    cwd: "/projects/live",
    projectKey: "/projects/live",
    created: "",
    modified: "",
    messageCount: 1,
    firstMessage: "hi",
  });

  assert.equal(state.selectedSession?.id, "s1");
  assert.equal(state.newSessionCwd, null);
  assert.equal(state.newSessionProjectId, null);
  assert.equal(state.newSessionProjectLabel, null);
  assert.equal(state.newSessionTemplateId, null);
  assert.ok(routerCalls.includes("?session=s1"));
});
