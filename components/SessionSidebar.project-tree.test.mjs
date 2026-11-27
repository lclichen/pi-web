import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The managed project tree is product UI: it only makes sense with a signed-in
 * platform identity (projects are records, not cwd groups) and it carries its
 * own space switch (projects / Quick / Host), project menus and machine badges.
 */
const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const hook = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

test("signed-in sessions render the managed project tree, auth-off keeps the plain tree", () => {
  assert.match(sidebar, /\{authInfo\?\.enabled && authInfo\.user \? \(/);
  assert.match(sidebar, /<ProjectSessionTree/);
  assert.match(sidebar, /sessionSpace=\{sessionSpace\}/);
  assert.match(sidebar, /onSessionSpaceChange=\{handleSessionSpaceChange\}/);
  assert.match(sidebar, /isAdmin=\{authInfo\.user\.role === "admin"\}/);
  assert.match(sidebar, /projectsRefreshKey=\{projectsRefreshKey\}/);
});

test("the Host space lists the host shard for admins only", () => {
  assert.match(sidebar, /space = authInfoRef\.current\?\.enabled &&/);
  assert.match(sidebar, /authInfoRef\.current\.user\?\.role === "admin"/);
  assert.match(sidebar, /sessionSpaceRef\.current === "host"/);
  assert.match(sidebar, /params\.set\("space", space\)/);
  // Switching spaces persists the choice and refetches.
  assert.match(sidebar, /window\.localStorage\.setItem\("pi-web:sidebar-space", space\)/);
  assert.match(sidebar, /void loadSessions\(false, true\)/);
});

test("project rows create sessions with their project binding, Quick with its template", () => {
  assert.match(sidebar, /onNewSessionInProject=\{\(project\) => \{/);
  assert.match(sidebar, /mode: project\.mode,\s*projectId: project\.id,\s*projectLabel: project\.name/);
  assert.match(sidebar, /onNewSessionFromTemplate=\{\(templateId, templateName\) => \{/);
  assert.match(sidebar, /mode: "quick",\s*templateId,\s*projectLabel: templateName/);
  // Host space directory picking registers the folder and opens a session there.
  assert.match(sidebar, /hostDirPickRef\.current = true/);
  assert.match(sidebar, /fetch\("\/api\/host\/dirs", \{/);
  // The top-bar ⚡ menu starts a Quick draft from any template.
  assert.match(sidebar, /fetch\("\/api\/quick-templates"\)/);
  assert.match(sidebar, /mode: "quick",\s*templateId: template\.id,\s*projectLabel: template\.name/);
});

test("the wizard enters its new project and the shell passes the identity down", () => {
  assert.match(sidebar, /onCreated=\{\(project\) => \{/);
  assert.match(sidebar, /setProjectsRefreshKey\(\(key\) => key \+ 1\)/);
  assert.match(sidebar, /mode: project\.mode,\s*projectId: project\.id,\s*projectLabel: project\.name/);
  assert.match(shell, /authInfo=\{authInfo\}/);
  assert.match(shell, /newSessionProjectId=\{newSessionProjectId\}/);
  assert.match(shell, /newSessionMode=\{newSessionMode\}/);
  assert.match(shell, /newSessionTemplateId=\{newSessionTemplateId\}/);
});

test("Quick drafts resolve their per-template workspace and send the template id", () => {
  assert.match(shell, /setNewSessionCwd\(`\/api\/quick-workspace\/\$\{templateId\}`\)/);
  assert.match(shell, /newSessionTemplateId=\{newSessionTemplateId\}/);
  assert.match(hook, /newSessionTemplateId\?: string \| null/);
  assert.match(hook, /newSessionMode === "quick" && newSessionTemplateId \? \{ templateId: newSessionTemplateId \}/);
});
