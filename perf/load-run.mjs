#!/usr/bin/env node
/**
 * pi-web multi-user load driver (dev 批次5). Zero dependencies (Node >= 22).
 *
 * Provisions N platform users, logs each into pi-web, starts S sessions per
 * user against the mock model provider, and drives prompt/SSE turns while
 * probing canary endpoints; emits a JSON + markdown report.
 *
 *   node perf/load-run.mjs --users 5 --per-user 2 \
 *     --base http://127.0.0.1:30141 --platform http://10.99.9.7:3000 \
 *     --admin-user admin --admin-pass <pass> \
 *     --duration 300 --tokens 300
 *
 *   node perf/load-run.mjs cleanup --platform http://10.99.9.7:3000 \
 *     --admin-user admin --admin-pass <pass> --user-prefix load
 *
 * Turn prompts steer the mock model: "MOCKLEN:<tokens> MOCKTOOL round N" —
 * each round exercises a real bash tool execution on the pi-web host followed
 * by a fair-share-rate-limited streamed answer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    users: { type: "string", default: "5" },
    "per-user": { type: "string", default: "2" },
    base: { type: "string", default: "http://127.0.0.1:30141" },
    platform: { type: "string", default: "http://10.99.9.7:3000" },
    "admin-user": { type: "string", default: "admin" },
    "admin-pass": { type: "string", default: process.env.LOAD_ADMIN_PASS ?? "" },
    "user-prefix": { type: "string", default: "load" },
    "user-pass": { type: "string", default: "LoadTest#2026" },
    cwd: { type: "string" },
    provider: { type: "string", default: "mock-load" },
    model: { type: "string", default: "mock-load-default" },
    duration: { type: "string", default: "300" },
    ramp: { type: "string", default: "8000" },
    think: { type: "string", default: "1500" },
    tokens: { type: "string", default: "300" },
    "tool-rounds": { type: "string", default: "1" },
    "canary-ms": { type: "string", default: "2000" },
    "mock-base": { type: "string" },
    out: { type: "string" },
  },
});

const CONFIG = {
  users: Math.max(1, Number(args.users)),
  perUser: Math.max(1, Number(args["per-user"])),
  base: args.base.replace(/\/$/, ""),
  platform: args.platform.replace(/\/$/, ""),
  adminUser: args["admin-user"],
  adminPass: args["admin-pass"],
  userPrefix: args["user-prefix"],
  userPass: args["user-pass"],
  cwd: args.cwd ?? os.tmpdir(),
  provider: args.provider,
  model: args.model,
  durationMs: Number(args.duration) * 1000,
  rampMs: Number(args.ramp),
  thinkMs: Number(args.think),
  tokens: Math.max(5, Number(args.tokens)),
  toolRounds: Number(args["tool-rounds"]),
  canaryMs: Number(args["canary-ms"]),
  mockBase: args["mock-base"] ? args["mock-base"].replace(/\/$/, "") : null,
};

if (!CONFIG.adminPass) {
  console.error("missing --admin-pass (or LOAD_ADMIN_PASS): needed to provision platform users");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

async function fetchJson(url, options = {}, { okStatuses = [200] } = {}) {
  const started = performance.now();
  const res = await fetch(url, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!okStatuses.includes(res.status)) {
    const detail = body?.error ?? "";
    throw new Error(`${res.status} ${url}: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 200)}`);
  }
  return { res, body, ms: performance.now() - started };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Platform user provisioning.
// ---------------------------------------------------------------------------

async function platformAdminToken() {
  const { body } = await fetchJson(`${CONFIG.platform}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: CONFIG.adminUser, password: CONFIG.adminPass }),
  });
  if (!body?.accessToken) throw new Error("platform login returned no accessToken");
  return body.accessToken;
}

async function importUsers(token) {
  const csv = Array.from({ length: CONFIG.users }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return `${CONFIG.userPrefix}${n},${CONFIG.userPass}`;
  }).join("\n");
  const { body } = await fetchJson(
    `${CONFIG.platform}/api/v1/admin/users/import`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ csv, mustChangePassword: false }),
    },
    { okStatuses: [201] },
  );
  return body;
}

async function cleanupUsers() {
  const token = await platformAdminToken();
  const { body } = await fetchJson(
    `${CONFIG.platform}/api/v1/admin/users?search=${encodeURIComponent(CONFIG.userPrefix)}&limit=500`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const users = body?.users ?? body?.data ?? [];
  let removed = 0;
  for (const user of users) {
    if (!String(user.username ?? "").startsWith(CONFIG.userPrefix)) continue;
    const res = await fetch(`${CONFIG.platform}/api/v1/admin/users/${user.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 200 || res.status === 204) removed += 1;
    else console.warn(`cleanup: user ${user.username} delete -> ${res.status}`);
  }
  console.log(`cleanup: removed ${removed}/${users.length} ${CONFIG.userPrefix}* users`);
}

// ---------------------------------------------------------------------------
// pi-web session driver.
// ---------------------------------------------------------------------------

function piwebHeaders(cookie) {
  return {
    "Content-Type": "application/json",
    Cookie: cookie,
    Origin: CONFIG.base,
  };
}

async function piwebLogin(username, password) {
  const { res } = await fetchJson(
    `${CONFIG.base}/api/webauth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
    { okStatuses: [200] },
  );
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error(`no session cookie for ${username}`);
  return cookie;
}

class SessionDriver {
  constructor(label, cookie, sessionId, onSample) {
    this.label = label;
    this.cookie = cookie;
    this.sessionId = sessionId;
    this.onSample = onSample;
    this.turns = 0;
    this.turnMs = [];
    this.toolCalls = 0;
    this.errors = [];
    this.tokens = 0;
    this.stopped = false;
    this.agentEndResolve = null;
  }

  async consumeEvents() {
    try {
      const res = await fetch(`${CONFIG.base}/api/agent/${this.sessionId}/events`, {
        headers: { Cookie: this.cookie, Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          this.handleFrame(frame);
        }
      }
      await reader.cancel().catch(() => {});
    } catch (error) {
      if (!this.stopped) this.errors.push(`sse: ${error.message}`);
    }
  }

  handleFrame(frame) {
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) return;
    let event;
    try {
      event = JSON.parse(dataLine.slice(6));
    } catch {
      return;
    }
    if (event.type === "agent_end") {
      this.agentEndResolve?.();
    } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.tokens += 1;
      this.onSample?.(this, "token");
    } else if (event.type === "tool_execution_start") {
      this.toolCalls += 1;
      this.onSample?.(this, "tool");
    } else if (event.type === "startup_error") {
      this.errors.push(`startup: ${event.errorMessage}`);
    }
  }

  waitForAgentEnd() {
    return new Promise((resolve) => {
      this.agentEndResolve = resolve;
    });
  }

  async promptTurn(round) {
    // toolRounds: 0 = never, 1 = every round, N > 1 = every Nth round.
    const useTool =
      CONFIG.toolRounds === 0 ? false : CONFIG.toolRounds === 1 ? true : round % CONFIG.toolRounds === 0;
    const message = `MOCKLEN:${CONFIG.tokens}${useTool ? " MOCKTOOL" : ""} round ${round} MOCKMARK:${this.label}`;
    const started = performance.now();
    const endPromise = this.waitForAgentEnd();
    await fetchJson(
      `${CONFIG.base}/api/agent/${this.sessionId}`,
      {
        method: "POST",
        headers: piwebHeaders(this.cookie),
        body: JSON.stringify({ type: "prompt", message }),
      },
      { okStatuses: [200] },
    );
    // 100 concurrent streams share 300 tok/s → 300 tokens can take ~100s.
    const timeout = sleep(10 * 60 * 1000).then(() => "timeout");
    const result = await Promise.race([endPromise.then(() => "end"), timeout]);
    const ms = performance.now() - started;
    this.turns += 1;
    this.turnMs.push(ms);
    if (result === "timeout") this.errors.push(`round ${round} timed out`);
    return ms;
  }

  stop() {
    this.stopped = true;
    this.agentEndResolve?.();
  }
}

// ---------------------------------------------------------------------------
// Main run.
// ---------------------------------------------------------------------------

const canary = { running: [], sessions: [], me: [], errors: [] };
const debugSamples = [];
const mockSamples = [];

async function canaryLoop(cookies, adminCookie, deadline) {
  let tick = 0;
  while (Date.now() < deadline) {
    const cookie = cookies[tick % cookies.length];
    try {
      const r1 = await fetchJson(`${CONFIG.base}/api/agent/running`, { headers: { Cookie: cookie } });
      canary.running.push(r1.ms);
    } catch (error) {
      canary.errors.push(`running: ${error.message}`);
    }
    if (tick % 5 === 0) {
      try {
        const r2 = await fetchJson(`${CONFIG.base}/api/sessions`, { headers: { Cookie: cookie } });
        canary.sessions.push(r2.ms);
      } catch (error) {
        canary.errors.push(`sessions: ${error.message}`);
      }
    }
    if (adminCookie && tick % 3 === 0) {
      try {
        const r3 = await fetchJson(`${CONFIG.base}/api/agent/debug`, { headers: { Cookie: adminCookie } });
        canary.me.push(r3.ms);
        const p = r3.body?.process;
        if (p) {
          debugSamples.push({
            t: Date.now(),
            heapUsedMB: Math.round(p.heapUsedBytes / 1048576),
            rssMB: Math.round(p.rssBytes / 1048576),
            loopP95Ms: p.eventLoopDelayMs ? Number(p.eventLoopDelayMs.p95.toFixed(1)) : null,
            sessions: r3.body?.totals?.wrappers,
            running: r3.body?.totals?.running,
            parseQueued: p.parseQueue?.queued ?? 0,
            memoryGuardMB: p.memoryGuard ? Math.round(p.memoryGuard.limitBytes / 1048576) : null,
          });
        }
      } catch (error) {
        canary.errors.push(`debug: ${error.message}`);
      }
    }
    if (CONFIG.mockBase && tick % 3 === 0) {
      try {
        const m = await fetchJson(`${CONFIG.mockBase}/stats`);
        mockSamples.push({
          t: Date.now(),
          active: m.body.activeStreams,
          rate: m.body.currentRatePerStream,
          totalTokens: m.body.totalTokens,
        });
      } catch {
        /* mock server optional */
      }
    }
    tick += 1;
    await sleep(CONFIG.canaryMs);
  }
}

async function run() {
  const startedAt = Date.now();
  console.log(`[load-run] ${nowIso()} provisioning ${CONFIG.users} users on ${CONFIG.platform}`);
  const token = await platformAdminToken();
  const importResult = await importUsers(token);
  console.log(`[load-run] import: created=${importResult?.created} failed=${importResult?.failed}`);

  const adminCookie = await piwebLogin(CONFIG.adminUser, CONFIG.adminPass).catch(() => null);

  const drivers = [];
  const cookies = [];
  const deadline = startedAt + CONFIG.durationMs;
  let sessionIndex = 0;

  const rampStep = CONFIG.users > 1 ? CONFIG.rampMs / (CONFIG.users - 1) : 0;
  for (let u = 0; u < CONFIG.users; u += 1) {
    const username = `${CONFIG.userPrefix}${String(u + 1).padStart(2, "0")}`;
    let cookie;
    try {
      cookie = await piwebLogin(username, CONFIG.userPass);
    } catch (error) {
      console.error(`[load-run] login failed for ${username}: ${error.message}`);
      continue;
    }
    cookies.push(cookie);
    for (let s = 0; s < CONFIG.perUser; s += 1) {
      try {
        const { body } = await fetchJson(
          `${CONFIG.base}/api/agent/new`,
          {
            method: "POST",
            headers: piwebHeaders(cookie),
            body: JSON.stringify({
              mode: "host",
              type: "ensure_session",
              cwd: CONFIG.cwd,
              provider: CONFIG.provider,
              model: CONFIG.model,
            }),
          },
          { okStatuses: [200] },
        );
        if (!body?.sessionId) throw new Error(body?.error ?? "no sessionId");
        const driver = new SessionDriver(`u${u + 1}s${s + 1}`, cookie, body.sessionId);
        drivers.push(driver);
        sessionIndex += 1;
        void driver.consumeEvents();
        console.log(`[load-run] session ${driver.label} -> ${body.sessionId.slice(0, 8)} (${sessionIndex} total)`);
      } catch (error) {
        console.error(`[load-run] session create failed (${username} #${s + 1}): ${error.message}`);
      }
    }
    if (u < CONFIG.users - 1) await sleep(rampStep);
  }

  if (drivers.length === 0) throw new Error("no sessions were created");

  // Prompt loops: each driver runs independently until the deadline; canaries
  // probe concurrently.
  const loops = drivers.map(async (driver) => {
    let round = 0;
    // Stagger the first prompt across the fleet so streams overlap.
    await sleep(Math.random() * 2000);
    while (Date.now() < deadline && !driver.stopped) {
      round += 1;
      try {
        await driver.promptTurn(round);
      } catch (error) {
        driver.errors.push(`turn: ${error.message}`);
      }
      await sleep(CONFIG.thinkMs + Math.random() * CONFIG.thinkMs);
    }
  });

  console.log(`[load-run] ${nowIso()} driving ${drivers.length} sessions for ${CONFIG.durationMs / 1000}s`);
  const canaryPromise = canaryLoop(cookies, adminCookie, deadline);
  const overallGuard = sleep(CONFIG.durationMs - (Date.now() - startedAt) + 180_000);
  await Promise.race([Promise.all([...loops, canaryPromise]), overallGuard]);
  drivers.forEach((d) => d.stop());

  const allTurns = drivers.flatMap((d) => d.turnMs);
  const report = {
    config: { ...CONFIG, adminPass: undefined, startedAt: nowIso(), endedAt: nowIso() },
    totals: {
      users: CONFIG.users,
      sessions: drivers.length,
      turns: drivers.reduce((sum, d) => sum + d.turns, 0),
      toolCalls: drivers.reduce((sum, d) => sum + d.toolCalls, 0),
      tokens: drivers.reduce((sum, d) => sum + d.tokens, 0),
      errors: drivers.reduce((sum, d) => sum + d.errors.length, 0) + canary.errors.length,
    },
    turnDurationMs: stats(allTurns),
    canary: {
      runningMs: stats(canary.running),
      sessionsListMs: stats(canary.sessions),
      debugMs: stats(canary.me),
      errors: canary.errors.slice(0, 20),
    },
    sessions: drivers.map((d) => ({
      label: d.label,
      turns: d.turns,
      toolCalls: d.toolCalls,
      tokens: d.tokens,
      turnMs: stats(d.turnMs),
      errors: d.errors.slice(0, 5),
    })),
    debugSamples,
    mockSamples,
  };

  const outPath = args.out ?? `perf-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  const mdPath = outPath.replace(/\.json$/, ".md");
  fs.writeFileSync(mdPath, renderMarkdown(report));
  console.log(`[load-run] report: ${outPath} + ${mdPath}`);
  console.log(renderMarkdown(report));
  process.exit(0);
}

function renderMarkdown(report) {
  const s = (x) => (x === null || x === undefined ? "—" : x.toFixed ? Number(x.toFixed(1)) : x);
  const lines = [
    "# pi-web 负载测试报告",
    "",
    `- 时间：${report.config.endedAt}`,
    `- 配置：${report.config.users} 用户 × ${report.config.perUser} 会话，${report.config.tokens} tokens/回合，时长 ${report.config.durationMs / 1000}s`,
    `- 总计：${report.totals.turns} 回合 · ${report.totals.toolCalls} 次真实工具调用 · ${report.totals.tokens} tokens · ${report.totals.errors} 错误`,
    "",
    "| 指标 | p50 | p95 | p99 | max | n |",
    "|---|---|---|---|---|---|",
  ];
  const rows = [
    ["回合时长 ms", report.turnDurationMs],
    ["金丝雀 /api/agent/running ms", report.canary.runningMs],
    ["金丝雀 /api/sessions ms", report.canary.sessionsListMs],
    ["金丝雀 /api/agent/debug ms", report.canary.debugMs],
  ];
  for (const [label, x] of rows) {
    lines.push(`| ${label} | ${s(x?.p50)} | ${s(x?.p95)} | ${s(x?.p99)} | ${s(x?.max)} | ${x?.n ?? 0} |`);
  }
  if (report.debugSamples.length > 0) {
    const last = report.debugSamples[report.debugSamples.length - 1];
    const peakHeap = Math.max(...report.debugSamples.map((d) => d.heapUsedMB));
    const peakRss = Math.max(...report.debugSamples.map((d) => d.rssMB));
    const peakLoop = Math.max(...report.debugSamples.map((d) => d.loopP95Ms ?? 0));
    lines.push(
      "",
      `- 进程：峰值堆 ${peakHeap} MB / 峰值 RSS ${peakRss} MB / 事件循环 p95 峰值 ${peakLoop} ms；结束时 ${last.sessions} 会话（${last.running} 运行中），内存守卫上限 ${last.memoryGuardMB} MB`,
    );
  }
  if (report.mockSamples.length > 1) {
    const last = report.mockSamples[report.mockSamples.length - 1];
    const peakActive = Math.max(...report.mockSamples.map((m) => m.active));
    lines.push(`- Mock 模型：峰值并发流 ${peakActive}，结束时单流速率 ${last.rate} tok/s，累计 ${last.totalTokens} tokens`);
  }
  if (report.totals.errors > 0) {
    lines.push("", "## 错误样例", ...(report.canary.errors.slice(0, 5).map((e) => `- ${e}`)));
  }
  return lines.join("\n");
}

if (positionals[0] === "cleanup") {
  cleanupUsers().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  run().catch((error) => {
    console.error(`[load-run] fatal: ${error.message}`);
    process.exit(1);
  });
}
