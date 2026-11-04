import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./WebUIGuide.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

/**
 * 教学第 4 步「和 Agent 对话」：新用户此时还没有会话，聊天区不存在。
 * 向导应在无会话时先引导「新建项目 / 快速会话」，并把聚光灯指向侧栏入口；
 * 已有会话时保持原文案。
 */
test("guide step 4 offers session creation when no session is open", () => {
  assert.match(source, /hasSession\?: boolean/);
  assert.match(source, /onNewProject\?: \(\) => void/);
  assert.match(source, /const chatNeedsSession = step === "chat" && !hasSession/);
  // No-session branch: explanation + both entry points.
  assert.match(source, /guide\.chatNoSessionTitle/);
  assert.match(source, /guide\.chatNoSessionBody/);
  assert.match(source, /guide\.newProject/);
  assert.match(source, /guide\.startQuickSession/);
  // Spotlight moves to the sidebar's New project control.
  assert.match(source, /data-guide="new-project"/);
});

test("AppShell tells the guide whether a session exists and wires New project", () => {
  assert.match(shell, /<WebUIGuide[\s\S]*?hasSession=\{showChat\}/);
  assert.match(
    shell,
    /onNewProject=\{\(\) => window\.dispatchEvent\(new CustomEvent\("pi-web:open-project-wizard"\)\)\}/,
  );
  // The sidebar listener must open the wizard for a mode-less event too (it
  // used to ignore everything except mode:"ssh", so the guide button did
  // nothing).
  assert.match(sidebar, /setWizardInitialMethod\(mode === "sandbox" \|\| mode === "local" \|\| mode === "ssh" \? mode : null\)/);
  assert.match(sidebar, /setShowProjectWizard\(true\)/);
});

/**
 * 每种创建方式的独立教学：四张模式卡片各有“创建步骤 + 去创建”按钮；
 * 沙盒/本地/SSH 直接进入向导对应配置步，快速会话立即新建。
 */
test("each session mode has its own guided creation card", () => {
  assert.match(source, /onCreateProject\?: \(method: "sandbox" \| "local" \| "ssh"\) => void/);
  for (const key of ["guide.modeStepsLocal", "guide.modeStepsSandbox", "guide.modeStepsSsh", "guide.modeStepsQuick"]) {
    assert.match(source, new RegExp(key), `${key} must be shown`);
  }
  assert.match(source, /id: "local"/);
  assert.match(source, /id: "sandbox"/);
  assert.match(source, /id: "ssh"/);
  assert.match(source, /id: "quick"/);
  assert.match(source, /onCreateProject\?\.\(mode\.id\)/);
  assert.match(source, /guide\.modeCreate/);
  assert.match(source, /guide\.modeCreateHint/);
});

test("per-mode create buttons open the project wizard at that method", () => {
  assert.match(
    shell,
    /onCreateProject=\{\(mode\) =>\s*window\.dispatchEvent\(new CustomEvent\("pi-web:open-project-wizard", \{ detail: \{ mode \} \}\)\)/,
  );
  // The wizard receives the method and starts on its configuration step.
  assert.match(sidebar, /<RemoteConnectWizard\s+initialMethod=\{wizardInitialMethod\}/);
});
