import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const menuSource = await readFile(new URL("./EnvironmentsMenu.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const connectSource = await readFile(new URL("./relay/ConnectLocalMachine.tsx", import.meta.url), "utf8");

test("top bar consolidates machine/workspace/sandbox entries into the 环境 menu", () => {
  assert.match(shellSource, /<EnvironmentsMenu/);
  assert.match(shellSource, /onOpenWorkspace=\{\(\) => setMyWorkspaceOpen\(true\)\}/);
  assert.match(shellSource, /onOpenSandbox=\{\(\) => setSandboxManager\(\{\}\)\}/);
  // 三个原顶栏按钮不再平铺渲染（由菜单项触发既有对话框）。
  assert.doesNotMatch(shellSource, /<ConnectLocalMachine \/>/);
  assert.match(menuSource, /role="menu"/);
  assert.match(menuSource, /relay\.localMachine/);
  assert.match(menuSource, /app\.myWorkspace/);
  assert.match(menuSource, /app\.sandboxContainer/);
});

test("machines modal is exported for the menu; wizard keeps the inline pairing content", () => {
  assert.match(connectSource, /export function LocalMachinesDialog\(\{ open, onClose \}/);
  assert.match(menuSource, /LocalMachinesDialog open=\{machinesOpen\}/);
  // 顶栏按钮形态已删除；embedded 配对内容保留给远程连接向导。
  assert.doesNotMatch(connectSource, /embedded = false/);
  assert.doesNotMatch(connectSource, /aria-label=\{online \? t\("relay\.connected"/);
});

test("menu closes on outside click and Escape without leaking the keydown", () => {
  assert.match(menuSource, /addEventListener\("mousedown", onPointerDown\)/);
  assert.match(menuSource, /event\.key !== "Escape" \|\| event\.defaultPrevented/);
  assert.match(menuSource, /event\.preventDefault\(\);\s*setMenuOpen\(false\)/);
});
