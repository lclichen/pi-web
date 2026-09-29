/**
 * Background shell tasks — model-launched long-running processes (dev
 * servers, build watchers) that keep running across turns (ZCode 对标，
 * harness-research/09 方案落地).
 *
 * Model surface: bg_run / bg_list / bg_stop. Output goes to
 * <cwd>/.pi/tmp/bg/<taskId>.log and the model reads it with the ordinary
 * read tool — ZCode deprecated its TaskOutput tool for exactly this path
 * (files compose with offset/tail reads and never bloat the context).
 *
 * Execution is mode-routed (pi-web multi-mode support): the extension talks
 * to a BgExecChannel; pi-web registers a remote channel per session via
 * registerBgChannel (ssh = one-shot exec over the pooled client, sandbox =
 * platform tools/bash, local-machine = relay exec.run). With no registered
 * channel the local spawn executor is used (pi CLI and host-mode sessions).
 *
 * Registry is in-memory per sessionId (globalThis, restart-safe lookup):
 * after a restart bg_list honestly reports tasks as lost — matching ZCode's
 * degradation; remote processes may still be alive and are killable by pid.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export const BG_TASKS_WIDGET_KEY = "bg-tasks";
// Model-visible output dir as a POSIX path (the read tool and remote shells
// both expect forward slashes; join() would flip them on Windows).
const BG_DIR = ".pi/tmp/bg";
const BG_DIR_LOCAL = [".pi", "tmp", "bg"];
const MAX_TASKS_PER_SESSION = 5;
const TAIL_BYTES = 4096;
const REMOTE_POLL_MS = 5_000;

export type BgTaskStatus = "running" | "completed" | "failed" | "cancelled" | "lost";

export interface BgTask {
  taskId: string;
  name: string;
  command: string;
  channel: string;
  pid: string;
  /** Model-visible relative path of the output log. */
  outputFile: string;
  startedAt: number;
  endedAt?: number;
  status: BgTaskStatus;
  exitCode?: number | null;
  /** Internal bookkeeping (registry keys, local absolute log path) — the
   *  widget channel whitelists fields, so these never reach the wire. */
  sessionId?: string;
  outputFileAbs?: string;
}

/** Execution channel — remote modes implement run() only (nohup pattern). */
export interface BgExecChannel {
  label: string;
  kind: "local" | "remote";
  /** One-shot command execution (remote channels; also used for kill/tail). */
  run(command: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}

// ---------------------------------------------------------------------------
// Registries (globalThis: hot-reload safe, shared with pi-web's stop bridge)
// ---------------------------------------------------------------------------

interface BgRegistry {
  tasks: Map<string, Map<string, BgTask>>;
  channels: Map<string, BgExecChannel>;
  timers: Map<string, ReturnType<typeof setInterval>>;
  children: Map<string, ChildProcess>;
}
declare global {
  var __amedacBgShell: BgRegistry | undefined;
}

function registry(): BgRegistry {
  if (!globalThis.__amedacBgShell) {
    globalThis.__amedacBgShell = {
      tasks: new Map(),
      channels: new Map(),
      timers: new Map(),
      children: new Map(),
    };
  }
  return globalThis.__amedacBgShell;
}

/** pi-web wiring: register the mode channel for a session BEFORE it starts. */
export function registerBgChannel(sessionId: string, channel: BgExecChannel): void {
  registry().channels.set(sessionId, channel);
}

export function listBgTasks(sessionId: string): BgTask[] {
  return [...(registry().tasks.get(sessionId)?.values() ?? [])];
}

/** Stop bridge entry (wrapper `stop_bg` command / UI stop buttons). */
export async function stopBgTask(sessionId: string, taskId: string): Promise<{ ok: boolean; error?: string }> {
  const reg = registry();
  const task = reg.tasks.get(sessionId)?.get(taskId);
  if (!task) return { ok: false, error: "任务不存在（或已随服务重启丢失）" };
  if (task.status !== "running") return { ok: false, error: `任务已处于终态: ${task.status}` };
  try {
    await killPid(task);
    task.status = "cancelled";
    task.endedAt = Date.now();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Local + remote execution helpers
// ---------------------------------------------------------------------------

function localChannel(cwd: string): BgExecChannel {
  return {
    label: "host",
    kind: "local",
    run: (command, timeoutMs = 30_000) =>
      new Promise((resolve) => {
        const child = spawn(command, { shell: true, cwd, windowsHide: true });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("error", (e) => { clearTimeout(timer); resolve({ stdout, stderr: `${stderr}${e.message}`, exitCode: null }); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code }); });
      }),
  };
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function killPid(task: BgTask): Promise<void> {
  const reg = registry();
  const channel = reg.channels.get(task.sessionId ?? "") ?? null;
  const child = reg.children.get(task.taskId);
  if (child) {
    // local: tree kill per platform
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* group gone */ }
    }
    return;
  }
  if (channel && task.pid) {
    await channel.run(`kill -- -${task.pid} 2>/dev/null; kill ${task.pid} 2>/dev/null; true`);
    return;
  }
  throw new Error("无可用的停止通道（服务已重启且任务为远端进程？）");
}

async function tailLog(task: BgTask, sessionId: string): Promise<string> {
  const reg = registry();
  const channel = reg.channels.get(sessionId);
  if (channel?.kind === "remote") {
    const r = await channel.run(`tail -c ${TAIL_BYTES} ${shQuote(task.outputFile)} 2>/dev/null || true`);
    return r.stdout.slice(-TAIL_BYTES);
  }
  try {
    const content = readFileSync(task.outputFileAbs ?? task.outputFile, "utf8");
    return content.slice(-TAIL_BYTES);
  } catch {
    return "";
  }
}

// outputFileAbs / sessionId are internal bookkeeping fields on BgTask
// (local reads + registry keys); the widget channel whitelists fields so
// they never reach the wire.

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const textBlock = (s: string) => ({ type: "text" as const, text: s });

export function makeBgShellExtension(): InlineExtension {
  return (pi: ExtensionAPI): void => {
    let sessionId = "";
    let channel: BgExecChannel | null = null;
    let cwd = "";

    const publish = (ctx: ExtensionContext) => {
      try {
        const setWidget = ctx.ui?.setWidget?.bind(ctx.ui);
        if (!setWidget) return;
        const tasks = listBgTasks(sessionId);
        if (tasks.length === 0) {
          setWidget(BG_TASKS_WIDGET_KEY, undefined);
          return;
        }
        if (ctx.mode === "tui") {
          setWidget(
            BG_TASKS_WIDGET_KEY,
            tasks.map((t) => `bg ${t.status === "running" ? "▶" : "·"} ${t.name} (${t.pid})`),
            { placement: "aboveEditor" },
          );
          return;
        }
        setWidget(BG_TASKS_WIDGET_KEY, [JSON.stringify(tasks.map(({ taskId, name, status, startedAt, pid, outputFile }) => ({ taskId, name, status, startedAt, pid, outputFile })))]);
      } catch {
        // best-effort
      }
    };

    /**
     * Terminal-state wake-up (ZCode <task-notification> parity): when a task
     * the model started exits on its own, deliver a user message so the agent
     * starts a new turn and can react (check the tail, continue verification).
     * deliverAs "followUp" queues while the agent is busy and fires when idle.
     * Manual bg_stop / shutdown cleanup do NOT notify — the user already knows.
     */
    const notifyTaskExit = async (task: BgTask, ctx: ExtensionContext) => {
      try {
        const send = (ctx as ExtensionContext & {
          sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
        }).sendUserMessage;
        if (typeof send !== "function") return; // headless host without the channel
        const tail = await tailLog(task, task.sessionId ?? "");
        const tailTrimmed = tail.length > 2048 ? `\n${tail.slice(-2048)}\n(tailed)` : tail ? `\n${tail}` : "";
        send(
          `<task-notification>Background task "${task.name}" (${task.taskId}) has ${task.status}` +
            `${task.exitCode != null ? ` with exit code ${task.exitCode}` : ""}.` +
            ` Output file: ${task.outputFile}.${tailTrimmed}</task-notification>`,
          { deliverAs: "followUp" },
        );
      } catch {
        // best-effort — the task state itself is already recorded
      }
    };

    const monitor = (task: BgTask, ctx: ExtensionContext) => {
      const reg = registry();
      const child = reg.children.get(task.taskId);
      if (child) {
        child.on("exit", (code) => {
          task.status = code === 0 ? "completed" : "failed";
          task.exitCode = code;
          task.endedAt = Date.now();
          reg.children.delete(task.taskId);
          publish(ctx);
          void notifyTaskExit(task, ctx);
        });
        return;
      }
      // Remote: poll liveness (kill -0). Exit code is unknowable for a
      // non-child process — completion is enough.
      const timer = setInterval(async () => {
        if (task.status !== "running") {
          clearInterval(timer);
          reg.timers.delete(task.taskId);
          return;
        }
        try {
          const ch = reg.channels.get(task.sessionId ?? "");
          if (!ch) return;
          const r = await ch.run(`kill -0 ${task.pid} 2>/dev/null && echo ALIVE || echo GONE`);
          if (r.stdout.trim().endsWith("GONE")) {
            task.status = "completed";
            task.exitCode = null;
            task.endedAt = Date.now();
            clearInterval(timer);
            reg.timers.delete(task.taskId);
            publish(ctx);
            void notifyTaskExit(task, ctx);
          }
        } catch {
          // channel hiccup — keep polling
        }
      }, REMOTE_POLL_MS);
      reg.timers.set(task.taskId, timer);
    };

    pi.on("session_start", async (_event, ctx) => {
      sessionId = ctx.sessionManager.getSessionId();
      cwd = ctx.cwd;
      channel = registry().channels.get(sessionId) ?? localChannel(cwd);
      // Tasks from before a restart are lost to us — mark honestly, keep pids
      // for manual cleanup guidance.
      for (const t of listBgTasks(sessionId)) {
        if (t.status === "running" && !registry().children.has(t.taskId)) t.status = "lost";
      }
      publish(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      // Local children die with the session; remote processes get a
      // best-effort kill so dev servers don't outlive their session.
      for (const t of listBgTasks(sessionId)) {
        if (t.status !== "running" && t.status !== "lost") continue;
        try { await killPid(t); t.status = "cancelled"; } catch { /* best-effort */ }
      }
      for (const timer of registry().timers.values()) clearInterval(timer);
      registry().timers.clear();
      publish(ctx);
    });

    pi.registerTool(defineTool({
      name: "bg_run",
      label: "Background Run",
      description:
        "Start a LONG-RUNNING command as a background task that keeps running across turns (dev servers, build watchers, " +
        "compilers in watch mode). Returns a taskId, the pid and the output file path — read that file with the `read` tool to " +
        "check progress (e.g. wait for the \"listening on\" line). When the task exits on its own you receive a " +
        "<task-notification> message with the exit code and output tail. Do NOT use this for one-shot commands; use bash for those.",
      promptSnippet: "bg_run — start a long-running background task (dev server / watcher); you are notified when it exits",
      promptGuidelines: [
        "When a task needs a long-running process (dev server, build --watch, API mock), start it with bg_run instead of blocking bash; then read the output file to confirm it is ready (look for the port/ready line) before testing against it.",
        "You will receive a <task-notification> when a background task exits — react to it (inspect the tail, verify, continue) instead of polling forever. Clean up remaining tasks with bg_stop when the verification is done.",
      ],
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to run detached (it keeps running across turns)." }),
        name: Type.Optional(Type.String({ description: "Short label for lists/UI, e.g. 'web' or 'api'." })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const command = params.command?.trim();
        if (!command) return { content: [textBlock("Error: command is required")], details: {}, isError: true };
        const reg = registry();
        const tasks = reg.tasks.get(sessionId) ?? new Map();
        reg.tasks.set(sessionId, tasks);
        const live = [...tasks.values()].filter((t) => t.status === "running").length;
        if (live >= MAX_TASKS_PER_SESSION) {
          return { content: [textBlock(`Error: already ${live} running background tasks (max ${MAX_TASKS_PER_SESSION}). Stop one with bg_stop first.`)], details: {}, isError: true };
        }
        const taskId = `bg-${randomUUID().slice(0, 8)}`;
        const outputFile = `${BG_DIR}/${taskId}.log`;
        const task: BgTask = {
          taskId,
          name: params.name?.trim() || command.split(/\s+/).slice(0, 3).join(" ").slice(0, 40),
          command,
          channel: channel?.label ?? "host",
          pid: "",
          outputFile,
          startedAt: Date.now(),
          status: "running",
          sessionId,
        };

        try {
          if (channel?.kind === "local") {
            const absLog = join(cwd, ...BG_DIR_LOCAL);
            mkdirSync(absLog, { recursive: true });
            // Windows: `shell:true` re-quoting through `cmd /d /s /c` pops a
            // conhost window (spawn error 0x800700e8 / ERROR_NO_DATA). Write
            // the command to a script file first — same pattern as the remote
            // nohup path — and spawn the interpreter directly, detached and
            // hidden, so no console host is ever created.
            const isWin = process.platform === "win32";
            const scriptPath = join(absLog, `${taskId}${isWin ? ".cmd" : ".sh"}`);
            writeFileSync(scriptPath, isWin ? `@echo off\r\n${command}\r\n` : `${command}\n`, "utf8");
            const fd = openSync(join(absLog, `${taskId}.log`), "a");
            const child = isWin
              ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", scriptPath], {
                  cwd, detached: true, windowsHide: true,
                  stdio: ["ignore", fd, fd],
                })
              : spawn("/bin/sh", [scriptPath], {
                  cwd, detached: true,
                  stdio: ["ignore", fd, fd],
                });
            child.unref();
            // The parent must close its copy of the log fd after spawning —
            // otherwise the session process leaks one fd per task AND keeps
            // the log file locked on Windows (rm/EBUSY).
            try { closeSync(fd); } catch { /* already closed */ }
            task.pid = String(child.pid);
            task.outputFileAbs = join(absLog, `${taskId}.log`);
            reg.children.set(taskId, child);
          } else if (channel) {
            // Remote nohup pattern: script via base64 to dodge quoting hell,
            // detached with nohup + /dev/null stdin, pid echoed back.
            const b64 = Buffer.from(command, "utf8").toString("base64");
            await channel.run(`mkdir -p ${BG_DIR} && printf %s ${shQuote(b64)} | base64 -d > ${BG_DIR}/${taskId}.sh`);
            const r = await channel.run(`nohup sh ${BG_DIR}/${taskId}.sh > ${BG_DIR}/${taskId}.log 2>&1 < /dev/null & echo $!`);
            const pid = r.stdout.trim().split("\n").pop() ?? "";
            if (!/^\d+$/.test(pid)) {
              return { content: [textBlock(`Error: 远端启动失败（未取得 pid）: ${r.stderr || r.stdout || "unknown"}`)], details: {}, isError: true };
            }
            task.pid = pid;
          } else {
            return { content: [textBlock("Error: no execution channel")], details: {}, isError: true };
          }
        } catch (e) {
          task.status = "failed";
          return { content: [textBlock(`Error starting background task: ${e instanceof Error ? e.message : String(e)}`)], details: {}, isError: true };
        }

        tasks.set(taskId, task);
        await new Promise((r) => setTimeout(r, 400)); // let the first output lines land
        const tail = await tailLog(task, sessionId);
        publish(ctx);
        monitor(task, ctx);
        return {
          content: [
            textBlock(
              `Background task started (id ${taskId}, pid ${task.pid}, ${task.channel}).\n` +
              `Output file: ${outputFile} — read it with the read tool to watch progress (it keeps running across turns).\n` +
              `First output:\n${tail || "(no output yet)"}` +
              (tail.length >= TAIL_BYTES ? "\n(tailed)" : ""),
            ),
          ],
          details: { taskId, pid: task.pid, outputFile },
        };
      },
    }));

    pi.registerTool(defineTool({
      name: "bg_list",
      label: "Background Tasks",
      description: "List this session's background tasks (id, name, status, pid, output file).",
      promptSnippet: "bg_list — list background tasks",
      parameters: Type.Object({}),
      execute: async () => {
        const tasks = listBgTasks(sessionId);
        if (tasks.length === 0) {
          return { content: [textBlock("No background tasks in this session. (The registry is in-memory — tasks started before a service restart show up in later calls as lost; kill such pids manually via bash if needed.)")], details: { tasks: [] } };
        }
        const lines = tasks.map((t) =>
          `${t.taskId}  ${t.status.padEnd(9)}  pid ${t.pid.padEnd(7)}  ${t.name}  → ${t.outputFile}`,
        );
        return { content: [textBlock(`Background tasks (${tasks.filter((t) => t.status === "running").length} running):\n${lines.join("\n")}`)], details: { tasks } };
      },
    }));

    pi.registerTool(defineTool({
      name: "bg_stop",
      label: "Stop Background Task",
      description: "Stop a running background task by id (kills its process tree).",
      promptSnippet: "bg_stop — stop a background task",
      parameters: Type.Object({ taskId: Type.String({ description: "Task id from bg_run / bg_list." }) }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const result = await stopBgTask(sessionId, params.taskId?.trim() ?? "");
        publish(ctx);
        if (!result.ok) return { content: [textBlock(`Error: ${result.error}`)], details: {}, isError: true };
        return { content: [textBlock(`Background task ${params.taskId} stopped.`)], details: { stopped: true } };
      },
    }));
  };
}
