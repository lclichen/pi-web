#!/usr/bin/env node
/**
 * Benchmark CLI runner (P0-2).
 *
 *   node --experimental-strip-types bench/runner.mjs [--task id|area:edit|all] \
 *        --provider <p> --model <m> [--keep] [--out bench-results]
 *
 * Or via npm:  npm run bench -- --provider zai --model glm-4.7
 * Env fallback: PI_PROVIDER / PI_MODEL (same convention as pi/packages/evals).
 *
 * Real-model only — the runner refuses to start without a model selection so
 * CI (which runs bench.test.mjs only) can never hit the network by accident.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { runBenchTask, resolveModelSelection } from "./harness.ts";
import { runChecks, todoMetrics } from "./checks.ts";
import { TASKS } from "./tasks.ts";
import { renderMarkdownReport, toTaskRecord } from "./report.ts";

function parseArgs(argv) {
  const args = { task: "all", provider: undefined, model: undefined, keep: false, out: "bench-results" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--task") args.task = argv[++i];
    else if (a === "--provider") args.provider = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--keep") args.keep = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("usage: runner.mjs [--task id|area:<name>|all] --provider P --model M [--keep] [--out DIR]");
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function selectTasks(selector) {
  if (selector === "all") return TASKS;
  if (selector.startsWith("area:")) {
    const area = selector.slice(5);
    const tasks = TASKS.filter((t) => t.area === area);
    if (tasks.length === 0) {
      throw new Error(`no tasks in area '${area}' (areas: ${[...new Set(TASKS.map((t) => t.area))].join(", ")})`);
    }
    return tasks;
  }
  const task = TASKS.find((t) => t.id === selector);
  if (!task) throw new Error(`unknown task '${selector}' (available: ${TASKS.map((t) => t.id).join(", ")})`);
  return [task];
}

const args = parseArgs(process.argv.slice(2));
const selection = resolveModelSelection(
  args.provider && args.model ? { provider: args.provider, id: args.model } : undefined,
);
const tasks = selectTasks(args.task);
const startedAt = new Date();
const resultsRoot = join(process.cwd(), args.out);
const outDir = join(resultsRoot, startedAt.toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });

console.log(`▶ harness bench: ${selection.provider}/${selection.id} × ${tasks.length} task(s)`);
console.log(`  results → ${outDir}`);

const records = [];
for (const task of tasks) {
  process.stdout.write(`  [${task.id}] running… `);
  let checks = [];
  let todo = undefined;
  const result = await runBenchTask(task, selection, {
    keepArtifacts: args.keep,
    afterRun: async ({ cwd, messages }) => {
      checks = await runChecks(task.checks, { cwd, messages });
      if (task.area === "todo") {
        const m = todoMetrics(messages);
        todo = { calls: m.calls, errorCalls: m.errorCalls, noChangeCalls: m.noChangeCalls };
      }
    },
  });
  const pass = result.pass && checks.every((c) => c.pass);
  records.push(
    toTaskRecord(task.id, task.area, selection, pass, checks, result.usage, result.durationMs, result.error, todo),
  );
  const ok = checks.filter((c) => c.pass).length;
  process.stdout.write(
    `${pass ? "PASS" : "FAIL"} (${ok}/${checks.length} checks, ${(result.durationMs / 1000).toFixed(1)}s)\n`,
  );
}

const report = renderMarkdownReport(
  { startedAt: startedAt.toISOString(), provider: selection.provider, model: selection.id, taskCount: tasks.length },
  records,
);
writeFileSync(join(outDir, "report.md"), report, "utf8");
// Cross-run trend index at the results root; per-run dir keeps the report.
appendFileSync(
  join(resultsRoot, "runs.jsonl"),
  records.map((r) => JSON.stringify({ ...r, runDir: outDir })).join("\n") + "\n",
  "utf8",
);

const passCount = records.filter((r) => r.pass).length;
console.log(`\n✔ done: ${passCount}/${records.length} passed — report: ${join(outDir, "report.md")}`);
if (passCount < records.length) process.exitCode = 1;
