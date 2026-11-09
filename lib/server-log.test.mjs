import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const previousDataDir = process.env.PI_WEB_DATA_DIR;
const previousFileLog = process.env.PI_WEB_FILE_LOG;

function tempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-server-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function todayLogPath(root) {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return path.join(root, "logs", `server-${day}.log`);
}

test("writes plain and structured lines into the daily file", async (t) => {
  const root = tempDataDir(t);
  process.env.PI_WEB_DATA_DIR = root;
  delete process.env.PI_WEB_FILE_LOG;
  const { resetServerLogForTests, logServerEvent, writeServerLog } = await import("./server-log.ts");
  resetServerLogForTests();

  writeServerLog("warn", "first line");
  logServerEvent("session_open", { sessionId: "s1", ms: 12 });

  const file = todayLogPath(root);
  assert.ok(await waitFor(() => fs.existsSync(file)), "log file should appear");
  const content = await waitFor(() => {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    return text.includes("session_open") ? text : null;
  });
  assert.ok(typeof content === "string", "both lines should flush");
  assert.match(content, /\[warn\] first line/);
  assert.match(content, /\[event\] .*session_open.*"sessionId":"s1"/);
});

test("tees console.error and console.warn into the file", async (t) => {
  const root = tempDataDir(t);
  process.env.PI_WEB_DATA_DIR = root;
  delete process.env.PI_WEB_FILE_LOG;
  const { installServerLogTee, resetServerLogForTests } = await import("./server-log.ts");
  resetServerLogForTests();

  const originalError = console.error;
  const originalWarn = console.warn;
  t.after(() => {
    console.error = originalError;
    console.warn = originalWarn;
  });

  installServerLogTee();
  console.error("teed error", new Error("boom").message);
  console.warn("teed warning");

  const file = todayLogPath(root);
  const content = await waitFor(() => {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    return text.includes("teed warning") ? text : null;
  });
  assert.ok(typeof content === "string", "teed lines should land in the file");
  assert.match(content, /\[error\] teed error boom/);
  assert.match(content, /\[warn\] teed warning/);
});

test("PI_WEB_FILE_LOG=0 keeps the filesystem untouched", async (t) => {
  const root = tempDataDir(t);
  process.env.PI_WEB_DATA_DIR = root;
  process.env.PI_WEB_FILE_LOG = "0";
  const { resetServerLogForTests, installServerLogTee, writeServerLog } = await import("./server-log.ts");
  resetServerLogForTests();

  installServerLogTee();
  writeServerLog("error", "never written");
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(fs.existsSync(path.join(root, "logs")), false);
});

test("installServerLogTee wraps the console only once", async (t) => {
  const root = tempDataDir(t);
  process.env.PI_WEB_DATA_DIR = root;
  delete process.env.PI_WEB_FILE_LOG;
  const { installServerLogTee, resetServerLogForTests } = await import("./server-log.ts");
  resetServerLogForTests();

  const originalWarn = console.warn;
  t.after(() => {
    console.warn = originalWarn;
  });

  installServerLogTee();
  const wrappedOnce = console.warn;
  installServerLogTee();
  assert.strictEqual(console.warn, wrappedOnce);
});

test.after(() => {
  if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
  else process.env.PI_WEB_DATA_DIR = previousDataDir;
  if (previousFileLog === undefined) delete process.env.PI_WEB_FILE_LOG;
  else process.env.PI_WEB_FILE_LOG = previousFileLog;
});
