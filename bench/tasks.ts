/**
 * Benchmark task set (P0-2).
 *
 * Each task is a self-contained fixture: files written into an isolated
 * workspace, one natural-language prompt, and deterministic checks judged
 * after the run. Areas map to framework capabilities so a failure localizes
 * the defective module (edit / bash / todo / plan / refactor ...), and the
 * todo tasks double as the live usability suite required by P0-1.
 *
 * Adding a task = adding an entry here; fixture validation runs in CI
 * (bench.test.mjs) so broken tasks cannot land.
 */
import type { Check } from "./checks.ts";

export interface BenchTask {
  id: string;
  /** Capability area — used for report grouping / blame localization. */
  area: "edit" | "bash" | "todo" | "plan" | "plan-mode" | "refactor" | "verify";
  description: string;
  prompt: string;
  /** Files written into the isolated workspace before the run. */
  files: Record<string, string>;
  checks: Check[];
  /** Per-task wall-clock budget. Default 300s. */
  timeoutMs?: number;
}

const MATH_TS = `export function average(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}
`;

const MATH_TEST_MJS = `import assert from "node:assert/strict";
import test from "node:test";
import { average } from "../src/math.ts";

test("average of integers", () => {
  assert.equal(average([1, 2, 3, 4]), 2.5);
});

test("average of decimals", () => {
  assert.equal(average([0.1, 0.2, 0.3]), 0.2);
});
`;

const WORDS_TXT = `banana
apple
cherry
date
apple
banana
elderberry
`;

export const TASKS: BenchTask[] = [
  {
    id: "edit-fix-average",
    area: "edit",
    description: "Fix the truncating-cast bug in average() and make the node:test suite pass.",
    prompt:
      "The tests in test/ are failing. Investigate why, fix the code under src/ (do NOT weaken the tests), " +
      "and run the test suite with: node --experimental-strip-types --test 'test/*.test.mjs' — make it pass.",
    files: {
      "src/math.ts": MATH_TS.replace("return sum / values.length;", "return (sum / values.length) | 0;"),
      "test/math.test.mjs": MATH_TEST_MJS,
    },
    checks: [
      {
        kind: "command",
        argv: [process.execPath, "--experimental-strip-types", "--test", "test/*.test.mjs"],
        name: "tests pass",
      },
      { kind: "file_not_contains", path: "src/math.ts", regex: "\\| 0", name: "no truncating cast" },
    ],
    timeoutMs: 420_000,
  },
  {
    id: "bash-sorted-artifact",
    area: "bash",
    description: "Sort words from an input file into an output artifact via shell tools.",
    prompt:
      "Create data/out.txt containing the UNIQUE words from data/words.txt, sorted alphabetically, one per line, " +
      "with no trailing blank lines. Use shell commands (e.g. sort -u) rather than writing the file by hand.",
    files: { "data/words.txt": WORDS_TXT },
    checks: [
      { kind: "file_exists", path: "data/out.txt" },
      {
        kind: "node_script",
        name: "out.txt is unique+sorted",
        script: `
          const { readFileSync } = require("node:fs");
          const out = readFileSync("data/out.txt", "utf8").replace(/\\r/g, "").replace(/\\n$/, "");
          const lines = out.split("\\n");
          const expect = [...new Set(lines)].sort();
          if (JSON.stringify(lines) !== JSON.stringify(expect)) { console.error(lines, expect); process.exit(1); }
          if (new Set(lines).size !== lines.length) process.exit(1);
        `,
      },
    ],
  },
  {
    id: "todo-multi-step-discipline",
    area: "todo",
    description: "Multi-step task that must be tracked with the todo tool end-to-end (P0-1 live usability suite).",
    prompt:
      "Do the following, using the todo tool to track your progress (create the list first, keep exactly one step " +
      "in_progress, mark each completed as you finish it):\n" +
      "1. Create notes/a.md containing the single line: alpha\n" +
      "2. Create notes/b.md containing the single line: beta\n" +
      "3. Create notes/c.md containing the single line: gamma\n" +
      "4. Append the line done to notes/c.md\n",
    files: {},
    checks: [
      { kind: "file_exists", path: "notes/a.md" },
      { kind: "file_contains", path: "notes/a.md", text: "alpha" },
      { kind: "file_contains", path: "notes/b.md", text: "beta" },
      { kind: "file_contains", path: "notes/c.md", regex: "gamma[\\s\\S]*done", name: "c.md has gamma+done" },
      { kind: "todo_used", minCalls: 3, forbidErrors: true, name: "todo used, no misuse" },
      { kind: "todo_all_completed", name: "all steps completed" },
    ],
    timeoutMs: 420_000,
  },
  {
    id: "plan-save-and-implement",
    area: "plan",
    description: "Plan first (plan_save with checkbox steps), then implement per the plan.",
    prompt:
      "Plan then implement: add a README.md with a '## Usage' section containing the exact command from " +
      "package.json's scripts.start field, and add a LICENSE file containing 'MIT' on the first line. " +
      "Save the implementation plan with the plan_save tool BEFORE implementing — include 3-5 steps as " +
      "`- [ ]` checkboxes — and keep the plan file updated as you complete steps.",
    files: { "package.json": JSON.stringify({ name: "fixture", scripts: { start: "node server.js" } }, null, 2) + "\n" },
    checks: [
      { kind: "plan_saved", name: "plan file with checkbox steps" },
      { kind: "file_contains", path: "README.md", text: "node server.js", name: "README has start command" },
      { kind: "file_contains", path: "LICENSE", regex: "^MIT", name: "LICENSE is MIT" },
    ],
    timeoutMs: 420_000,
  },
  {
    id: "plan-mode-workflow",
    area: "plan-mode",
    description: "Full PLAN→approve→EXECUTE loop: auto-enter plan mode, gated exploration, saved plan, handoff implementation (P1-1 live suite).",
    prompt:
      "This task involves multiple files and needs planning first. Requirement: create two files — docs/alpha.md " +
      "containing the single line 'A' and docs/beta.md containing the single line 'B'. Follow the plan-mode " +
      "workflow your tools provide: plan before touching anything, then implement after approval.",
    files: {},
    checks: [
      { kind: "tool_called", tool: "enter_plan_mode", minCalls: 1, name: "auto-entered plan mode" },
      { kind: "plan_saved", name: "plan saved during planning" },
      { kind: "tool_called", tool: "exit_plan_mode", minCalls: 1, name: "approval requested" },
      { kind: "file_contains", path: "docs/alpha.md", regex: "^A\\s*$", name: "alpha.md created" },
      { kind: "file_contains", path: "docs/beta.md", regex: "^B\\s*$", name: "beta.md created" },
    ],
    timeoutMs: 480_000,
  },
  {
    id: "refactor-rename-across-files",
    area: "refactor",
    description: "Rename an exported function across module + consumer + test, keep tests green.",
    prompt:
      "Rename the exported function `getUserNam` to `getUserName` everywhere it is referenced " +
      "(src/user.ts, src/api.ts, test/user.test.mjs — fix typos in the rename, do not leave stale references), " +
      "then run: node --experimental-strip-types --test 'test/*.test.mjs' and make it pass.",
    files: {
      "src/user.ts": "export function getUserNam(): string {\n  return \"ada\";\n}\n",
      "src/api.ts": "import { getUserNam } from \"./user.ts\";\nexport function greet(): string {\n  return `hello ${getUserNam()}`;\n}\n",
      "test/user.test.mjs":
        'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { greet } from "../src/api.ts";\n\ntest("greet", () => {\n  assert.equal(greet(), "hello ada");\n});\n',
    },
    checks: [
      { kind: "file_not_contains", path: "src/user.ts", text: "getUserNam", name: "user.ts renamed" },
      { kind: "file_not_contains", path: "src/api.ts", text: "getUserNam", name: "api.ts renamed" },
      {
        kind: "command",
        argv: [process.execPath, "--experimental-strip-types", "--test", "test/*.test.mjs"],
        name: "tests pass",
      },
    ],
    timeoutMs: 420_000,
  },
  {
    id: "verify-faithful-report",
    area: "verify",
    description: "Run the failing suite, fix root cause, report honestly (the report itself is judged via the workspace state).",
    prompt:
      "src/stats.ts should provide median() but the implementation is wrong for even-length inputs " +
      "(it returns the lower middle instead of the average of both middles). Fix it, verify with " +
      "node --experimental-strip-types --test 'test/*.test.mjs', and write the exact test command you ran plus its exit " +
      "outcome (PASS or FAIL, one word) as the last line of REPORT.md.",
    files: {
      "src/stats.ts": "export function median(values: number[]): number {\n  const s = [...values].sort((a, b) => a - b);\n  return s[Math.floor((s.length - 1) / 2)];\n}\n",
      "test/stats.test.mjs":
        'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { median } from "../src/stats.ts";\n\ntest("odd length", () => {\n  assert.equal(median([3, 1, 2]), 2);\n});\n\ntest("even length", () => {\n  assert.equal(median([4, 1, 3, 2]), 2.5);\n});\n',
    },
    checks: [
      {
        kind: "command",
        argv: [process.execPath, "--experimental-strip-types", "--test", "test/*.test.mjs"],
        name: "tests pass",
      },
      {
        kind: "node_script",
        name: "REPORT.md is faithful",
        script: `
          const { readFileSync } = require("node:fs");
          const report = readFileSync("REPORT.md", "utf8").replace(/\\r/g, "");
          const last = report.trim().split("\\n").pop().trim();
          if (!/PASS\\b/.test(last)) { console.error("last line: " + last); process.exit(1); }
        `,
      },
      { kind: "file_not_contains", path: "test/stats.test.mjs", text: "2, 2.5", name: "tests not weakened" },
    ],
    timeoutMs: 420_000,
  },
];

export function getTask(id: string): BenchTask | undefined {
  return TASKS.find((t) => t.id === id);
}
