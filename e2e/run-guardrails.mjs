/**
 * 护栏 UI 场景测试（Playwright + 脚本化 mock 模型）。
 *
 * 覆盖能力（与 docs/dev/guardrail-test-strategy.md 的 L5 对应）：
 *   · ask 弹窗出现与四选交互；
 *   · 允许一次 / 拒绝 / 拒绝且不再询问 / 本项目始终允许 的落地效果
 *     （文件是否写入、决策文件、第二次调用是否再问）；
 *   · 切出会话再切回：弹窗消失并重放；
 *   · 页面刷新：待答弹窗重放；
 *   · 多窗口同会话：一处作答、另一处同步关闭。
 *
 * 不依赖真实模型：`e2e/mock-model.mjs` 让 Agent 循环确定性调用 `write`，
 * 目标路径在工作区外 → 触发路径护栏 ask。
 *
 * 运行：`npm run test:e2e:guardrails`（需要本机 Chrome 或已安装 Playwright chromium）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startMockModel } from "./mock-model.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.env.E2E_SERVER_MODE || "dev";
assert.ok(mode === "dev" || mode === "start", "E2E_SERVER_MODE must be dev or start");
assert.ok(mode !== "dev" || !existsSync(join(root, ".next/dev/lock")), "Use a checkout without an active dev server");

const artifacts = join(root, "test-results/guardrails");
mkdirSync(artifacts, { recursive: true });
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-guardrails-"));
const projectRoot = join(agentDir, "projects");
const outsideDir = join(agentDir, "outside");
mkdirSync(projectRoot, { recursive: true });
mkdirSync(outsideDir, { recursive: true });

const mock = await startMockModel();
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        "e2e-script": {
          api: "openai-completions",
          baseUrl: mock.baseUrl,
          apiKey: "e2e",
          models: [{ id: "e2e-script", name: "E2E Script", contextWindow: 32768, maxTokens: 4096 }],
        },
      },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ defaultProvider: "e2e-script", defaultModel: "e2e-script", theme: "light" }, null, 2),
);
writeFileSync(join(agentDir, "auth.json"), "{}\n");

const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
const base = `http://127.0.0.1:${port}`;

const serverLogPath = join(artifacts, "server.log");
const serverLog = createWriteStream(serverLogPath);
let server;
let serverError;
let serverExited;
let browser;
let context;
let page;
let interrupted = false;
const onSignal = () => {
  interrupted = true;
  process.exitCode = 130;
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

async function api(path, init = {}, status = 200) {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, status, `${init.method ?? "GET"} ${path}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function scenarioDir(name) {
  const dir = join(projectRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function createSession({ cwd, prompt, target }) {
  if (target) mock.queueTarget(target);
  const body = {
    cwd,
    type: prompt ? "prompt" : "ensure_session",
    provider: "e2e-script",
    modelId: "e2e-script",
    ...(prompt ? { message: prompt } : {}),
  };
  const result = await api("/api/agent/new", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.ok(result.sessionId, "session creation must return sessionId");
  return result.sessionId;
}

function askDialog() {
  return page.getByRole("dialog", { name: /路径护栏/ });
}

function displayPath(target) {
  return target.replaceAll(String.fromCharCode(92), "/");
}

async function openSession(sessionId) {
  await page.goto(`${base}/?session=${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
}

async function waitAssistantDone(turn) {
  await page.getByText(`mock-done-${turn}`, { exact: false }).first().waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: "Stop agent", exact: true }).waitFor({ state: "hidden" });
}

async function choose(option) {
  const dialog = page.getByRole("dialog", { name: /路径护栏/ });
  await dialog.getByRole("button", { name: option, exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

function readDecisions(cwd) {
  const file = join(cwd, ".pi/path-policy.decisions.json");
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8")).entries ?? [];
}

async function sessionText(sessionId) {
  const data = await api(`/api/sessions/${sessionId}/context?tail=50`);
  return JSON.stringify(data);
}

async function waitSessionText(sessionId, needle, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await sessionText(sessionId);
    if (last.includes(needle)) return;
    await delay(500);
  }
  throw new Error(`session ${sessionId} missing ${JSON.stringify(needle)}; tail=${last.slice(-800)}`);
}

async function waitDialogGone() {
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 30_000 });
}

async function expectDialogGone() {
  assert.equal(await page.getByRole("dialog").count(), 0, "dialog should stay closed");
}

async function resetPage() {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(180_000);
}

async function runScenarios() {
  const only = (process.env.E2E_SCENARIOS || "").split(",").filter(Boolean);
  const want = (name) => only.length === 0 || only.includes(name);
  // S1: ask 出现 + 允许一次 → 文件写入、无持久决策
  {
    if (!want("allow-once")) return;
    await resetPage();
    const cwd = scenarioDir("allow-once");
    const target = join(outsideDir, "allow-once.txt");
    const sid = await createSession({ cwd, prompt: "run the requested write", target });
    await openSession(sid);
    const dialog = askDialog();
    await dialog.waitFor({ timeout: 120_000 });
    await dialog.getByText(displayPath(target), { exact: false }).first().waitFor();
    for (const label of ["允许一次", "本项目始终允许（写入决策文件）", "拒绝", "拒绝且不再询问（写入决策文件）"]) {
      assert.equal(await dialog.getByRole("button", { name: label, exact: true }).count(), 1, `missing option: ${label}`);
    }
    await page.screenshot({ path: join(artifacts, "ask-dialog.png") });
    await choose("允许一次");
    await waitAssistantDone(1);
    assert.ok(existsSync(target), "allowed write should create the outside file");
    assert.deepEqual(readDecisions(cwd), [], "allow-once must not persist a decision");
    assert.equal(await page.getByText(/用户拒绝/).count(), 0);
    console.log("PASS: ask dialog + allow-once (file written, no persisted decision)");
  }

  // S2: 拒绝 → 不写入，工具错误卡显示原因
  {
    if (!want("deny")) return;
    await resetPage();
    const cwd = scenarioDir("deny");
    const target = join(outsideDir, "deny.txt");
    const sid = await createSession({ cwd, prompt: "run the requested write", target });
    await openSession(sid);
    await askDialog().waitFor({ timeout: 120_000 });
    await choose("拒绝");
    await waitAssistantDone(1);
    assert.equal(existsSync(target), false, "denied write must not create the file");
    assert.deepEqual(readDecisions(cwd), [], "plain deny must not persist");
    // 工具错误卡可能折叠在「处理详情」里：以会话上下文为准确认原因已回给模型/UI。
    assert.match(await sessionText(sid), /用户拒绝了本次操作/);
    console.log("PASS: deny (no file, readable reason surfaced)");
  }

  // S3: 拒绝且不再询问 → 决策落盘；第二次同一目标不再弹窗
  {
    if (!want("deny-always")) return;
    await resetPage();
    const cwd = scenarioDir("deny-always");
    const target = join(outsideDir, "deny-always.txt");
    const sid = await createSession({ cwd, prompt: "run the requested write", target });
    await openSession(sid);
    await askDialog().waitFor({ timeout: 120_000 });
    await choose("拒绝且不再询问（写入决策文件）");
    await waitAssistantDone(1);
    const decisions = readDecisions(cwd);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, "deny");
    assert.ok(decisions[0].path.endsWith("deny-always.txt"), `decision path: ${decisions[0].path}`);

    mock.queueTarget(target);
    const second = await api(`/api/agent/${sid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "prompt",
        message: "again",
        provider: "e2e-script",
        modelId: "e2e-script",
      }),
    });
    assert.ok(second?.success, `second prompt rejected: ${JSON.stringify(second)}`);
    await waitSessionText(sid, "mock-done-2");
    assert.equal(await page.getByRole("dialog").count(), 0, "persisted deny must not ask again");
    assert.match(await sessionText(sid), /不再询问/);
    assert.equal(existsSync(target), false);
    console.log("PASS: deny-and-never-again persists and skips the second prompt");
  }

  // S4: 本项目始终允许 → 决策落盘；第二次同一目标直接通过
  {
    if (!want("allow-always")) return;
    await resetPage();
    const cwd = scenarioDir("allow-always");
    const target = join(outsideDir, "allow-always.txt");
    const sid = await createSession({ cwd, prompt: "run the requested write", target });
    await openSession(sid);
    await askDialog().waitFor({ timeout: 120_000 });
    await choose("本项目始终允许（写入决策文件）");
    await waitAssistantDone(1);
    const decisions = readDecisions(cwd);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, "allow");

    mock.queueTarget(target);
    const second = await api(`/api/agent/${sid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "prompt",
        message: "again",
        provider: "e2e-script",
        modelId: "e2e-script",
      }),
    });
    assert.ok(second?.success, `second prompt rejected: ${JSON.stringify(second)}`);
    await waitSessionText(sid, "mock-done-2");
    assert.equal(await page.getByRole("dialog").count(), 0, "persisted allow must not ask again");
    assert.ok(existsSync(target));
    console.log("PASS: allow-and-never-again persists and passes the second prompt");
  }

  // S5: 切出会话 → 弹窗消失；切回 → 弹窗重放且仍可作答
  {
    if (!want("switch")) return;
    await resetPage();
    const cwd1 = scenarioDir("switch-a");
    const cwd2 = scenarioDir("switch-b");
    const target = join(outsideDir, "switch.txt");
    const sid1 = await createSession({ cwd: cwd1, prompt: "run the requested write", target });
    await openSession(sid1);
    await askDialog().waitFor({ timeout: 120_000 });

    const sid2 = await createSession({ cwd: cwd2 });
    await openSession(sid2);
    await waitDialogGone();
    await expectDialogGone();

    await openSession(sid1);
    await askDialog().waitFor({ timeout: 60_000 });
    await choose("拒绝");
    await waitAssistantDone(1);
    assert.equal(existsSync(target), false);
    console.log("PASS: pending dialog hides on session switch and replays on return");
  }

  // S6: 刷新页面 → 待答弹窗重放
  {
    if (!want("reload")) return;
    await resetPage();
    const cwd = scenarioDir("reload");
    const target = join(outsideDir, "reload.txt");
    const sid = await createSession({ cwd, prompt: "run the requested write", target });
    await openSession(sid);
    await askDialog().waitFor({ timeout: 120_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await askDialog().waitFor({ timeout: 60_000 });
    await choose("拒绝");
    await waitAssistantDone(1);
    console.log("PASS: pending dialog survives a page reload");
  }

  // S7: 两个窗口同会话（顺序 A：ask 已存在再开第二窗口）→ 双端弹窗，一处作答两端关闭。
  // 回归：每页曾各自开 3 条 relay-status SSE（EnvironmentsMenu /
  // LocalMachinesDialog / useAgentInstallInfo），两窗口 + agent 事件流超过
  // 浏览器 HTTP/1.1 的 6 连接上限，第二窗口的 /api/sessions/<id> 排不到连接而卡加载。
  {
    if (!want("multi-window")) return;
    await resetPage();
    const cwd = scenarioDir("multi-window");
    const target = join(outsideDir, "multi-window.txt");
    const sid = await createSession({ cwd, prompt: "run the requested write", target });
    await openSession(sid);
    await askDialog().waitFor({ timeout: 120_000 });

    const page2 = await context.newPage();
    try {
      await page2.goto(`${base}/?session=${encodeURIComponent(sid)}`, { waitUntil: "domcontentloaded" });
      await page2.locator("textarea").last().waitFor({ timeout: 60_000 });
      const dialog2 = page2.getByRole("dialog", { name: /路径护栏/ });
      await dialog2.waitFor({ timeout: 30_000 });
      await page
        .getByRole("dialog", { name: /路径护栏/ })
        .getByRole("button", { name: "允许一次", exact: true })
        .click();
      await dialog2.waitFor({ state: "hidden", timeout: 30_000 });
      await waitAssistantDone(1);
      assert.ok(existsSync(target));
      console.log("PASS: multi-window dialog mirrors and closes on one answer");
    } finally {
      await page2.close();
    }
  }

  // S8: 顺序 B — 双窗口先打开，再发 prompt 触发 ask；两窗口都保持可用。
  {
    if (!want("multi-window-b")) return;
    await resetPage();
    const cwd = scenarioDir("multi-window-b");
    const inside = join(cwd, "warm.txt");
    const target = join(outsideDir, "multi-window-b.txt");
    const sid = await createSession({ cwd, prompt: "warm up", target: inside });
    await openSession(sid);
    await waitAssistantDone(1);
    assert.ok(existsSync(inside));

    const page2 = await context.newPage();
    try {
      await page2.goto(`${base}/?session=${encodeURIComponent(sid)}`, { waitUntil: "domcontentloaded" });
      await page2.locator("textarea").last().waitFor({ timeout: 60_000 });
      assert.equal(await page.locator("textarea").last().isVisible(), true);

      mock.queueTarget(target);
      await page.locator("textarea").last().fill("run the requested write");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await askDialog().waitFor({ timeout: 60_000 });
      const dialog2 = page2.getByRole("dialog", { name: /路径护栏/ });
      await dialog2.waitFor({ timeout: 30_000 });

      await page
        .getByRole("dialog", { name: /路径护栏/ })
        .getByRole("button", { name: "允许一次", exact: true })
        .click();
      await dialog2.waitFor({ state: "hidden", timeout: 30_000 });
      await waitAssistantDone(2);
      assert.ok(existsSync(target));
      console.log("PASS: two windows open before the prompt; ask mirrors and one answer closes both");
    } finally {
      await page2.close();
    }
  }
}

try {
  server = spawn(
    process.execPath,
    [join(root, "node_modules/next/dist/bin/next"), mode, "-H", "127.0.0.1", "-p", String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        // Isolate per-user web state (user settings/locale, session metas, logs)
        // from a developer checkout's data/ directory.
        PI_WEB_DATA_DIR: join(agentDir, "web-data"),
        PI_WEB_PASSWORD: "",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.once("error", (error) => {
    serverError = error;
  });
  serverExited = once(server, "exit");
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });

  const deadline = Date.now() + 180_000;
  while (true) {
    if (serverError) throw serverError;
    assert.equal(server.exitCode, null, "Server exited before readiness; see test-results/guardrails/server.log");
    const response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (response?.ok) break;
    assert.ok(Date.now() < deadline, "Server readiness timed out; see test-results/guardrails/server.log");
    await delay(250);
  }

  const executable = chromium.executablePath();
  const channel = process.env.E2E_BROWSER_CHANNEL || (existsSync(executable) ? undefined : "chrome");
  browser = await chromium.launch({ channel });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  // 首次访问的「WebUI 操作教学」会全屏遮罩并拦截点击；E2E 一律跳过。
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("webui-guide-done", "1");
    } catch {
      /* ignore */
    }
  });
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(180_000);

  await runScenarios();
  console.log("PASS: guardrail UI suite completed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  if (context) await context.tracing.stop({ path: join(artifacts, "trace.zip") }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  await mock.close().catch(() => {});
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    const forceKill = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await serverExited;
    clearTimeout(forceKill);
  }
  serverLog.end();
  rmSync(agentDir, { recursive: true, force: true });
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
