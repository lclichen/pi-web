/**
 * audit-collect — 代码巡检的事实收集工具（零依赖）。
 *
 * 注册工具 audit_collect(args)：
 *   - since: git 变更统计的时间窗（默认 "14 days ago"）
 *   - topFiles: 大文件 Top N（默认 5）
 *
 * 只返回事实（变更行数、TODO 分布、大文件），不做判断——判断由巡检规则技能
 * 与子代理完成。非 git 仓库时跳过变更统计并注明。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "data", ".venv", "__pycache__"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".md"]);
const MAX_SCAN_BYTES = 512 * 1024;

function run(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function gitChangeStats(cwd, since) {
  try {
    run(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { isRepo: false };
  }
  const perFile = new Map();
  const numstat = run(cwd, ["log", `--since=${since}`, "--numstat", "--pretty=format:"]);
  for (const line of numstat.split("\n")) {
    const [add, del, file] = line.split("\t");
    if (!file) continue;
    const entry = perFile.get(file) ?? { added: 0, deleted: 0 };
    entry.added += Number(add) || 0;
    entry.deleted += Number(del) || 0;
    perFile.set(file, entry);
  }
  const files = [...perFile.entries()]
    .map(([file, v]) => ({ file, ...v }))
    .sort((a, b) => b.added + b.deleted - (a.added + a.deleted));
  const totals = files.reduce((acc, f) => ({ added: acc.added + f.added, deleted: acc.deleted + f.deleted }), {
    added: 0,
    deleted: 0,
  });
  return { isRepo: true, since, files, totals };
}

function walk(dir, root, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), root, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    const abs = join(dir, entry.name);
    const ext = entry.name.slice(entry.name.lastIndexOf("."));
    if (!CODE_EXT.has(ext)) continue;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    acc.files.push({ rel: relative(root, abs).split("\\").join("/"), size: st.size, abs, ext });
  }
  return acc;
}

function scanTodos(root) {
  const { files } = walk(root, root, { files: [] });
  const todoRe = /\b(TODO|FIXME|HACK)\b[:\s]*(.{0,80})/g;
  const hits = [];
  for (const f of files) {
    if (f.size > MAX_SCAN_BYTES) continue;
    let text;
    try {
      text = readFileSync(f.abs, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(todoRe)) {
      hits.push({ file: f.rel, tag: m[1], text: m[2].trim() });
    }
  }
  return hits;
}

const handlers = {
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const cwd = ctx?.cwd ?? process.cwd();
    const since = typeof params.since === "string" && params.since.trim() ? params.since.trim() : "14 days ago";
    const topFiles = Number.isFinite(params.topFiles) ? Math.max(1, Math.min(20, Number(params.topFiles))) : 5;

    const changes = gitChangeStats(cwd, since);
    const todos = scanTodos(cwd);
    const { files } = walk(cwd, cwd, { files: [] });
    const largest = [...files].sort((a, b) => b.size - a.size).slice(0, topFiles);

    const lines = [];
    lines.push(`## 变更统计（since ${since}）`);
    if (!changes.isRepo) {
      lines.push("- 非 git 仓库：跳过变更统计");
    } else if (changes.files.length === 0) {
      lines.push("- 窗口内无提交");
    } else {
      lines.push(`- 合计 +${changes.totals.added} / -${changes.totals.deleted}，涉及 ${changes.files.length} 个文件`);
      for (const f of changes.files.slice(0, 10)) lines.push(`  - ${f.file} (+${f.added}/-${f.deleted})`);
    }
    lines.push("", "## TODO / FIXME 分布");
    if (todos.length === 0) lines.push("- 未发现标记");
    else {
      const byFile = new Map();
      for (const t of todos) byFile.set(t.file, (byFile.get(t.file) ?? 0) + 1);
      lines.push(`- 共 ${todos.length} 处，涉及 ${byFile.size} 个文件`);
      for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        lines.push(`  - ${file}: ${n} 处`);
      }
      for (const t of todos.slice(0, 5)) lines.push(`  - ${t.tag} ${t.file}: ${t.text}`);
    }
    lines.push("", `## 大文件 Top${topFiles}`);
    for (const f of largest) lines.push(`- ${f.rel} (${(f.size / 1024).toFixed(1)} KB)`);

    return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
  },
};

export default function (pi) {
  pi.registerTool({
    name: "audit_collect",
    label: "Audit Collect",
    description: "收集代码巡检事实：git 变更统计（since）、TODO/FIXME 分布、大文件 TopN。只返回事实，不做判断。",
    parameters: Type.Object({
      since: Type.Optional(Type.String({ description: 'git 变更时间窗，如 "14 days ago"、"2026-01-01"' })),
      topFiles: Type.Optional(Type.Number({ description: "大文件 Top N（1-20，默认 5）" })),
    }),
    ...handlers,
  });
}
