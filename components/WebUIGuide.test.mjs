import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./WebUIGuide.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

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
});
