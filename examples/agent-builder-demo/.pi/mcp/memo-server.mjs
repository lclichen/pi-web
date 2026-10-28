#!/usr/bin/env node
/**
 * audit-memo — 零依赖 stdio MCP 服务器（巡检记录本）。
 *
 * 协议：MCP 2024-11-05，newline-delimited JSON-RPC 2.0 over stdio。
 * 工具：
 *   memo_save  { repo, conclusion, topRisk? }  → 追加一条 JSONL
 *   memo_list  { limit? }                      → 最近 N 条记录
 *
 * 存储：<session cwd>/.pi/audit-memos.jsonl（随项目走，可被导出配置包排除——
 * .pi 下除 deny 名单外都会进包，演示时可在导出后删除该文件再打包）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MEMO_FILE = join(process.cwd(), ".pi", "audit-memos.jsonl");
const SERVER_INFO = { name: "audit-memo", version: "1.0.0" };

const TOOLS = [
  {
    name: "memo_save",
    description: "记录一条巡检结论（仓库名、结论、最高风险项），便于下次对比。",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "仓库/巡检对象名" },
        conclusion: { type: "string", description: "一句话结论（可合并/有条件合并/需返工）" },
        topRisk: { type: "string", description: "最高风险项（可选）" },
      },
      required: ["repo", "conclusion"],
    },
  },
  {
    name: "memo_list",
    description: "列出最近的巡检记录（默认 5 条，按写入序倒排）。",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "条数（1-50，默认 5）" } },
    },
  },
];

function readMemos() {
  if (!existsSync(MEMO_FILE)) return [];
  const out = [];
  for (const line of readFileSync(MEMO_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function saveMemo(args) {
  mkdirSync(dirname(MEMO_FILE), { recursive: true });
  const entry = {
    at: new Date().toISOString(),
    repo: String(args.repo ?? ""),
    conclusion: String(args.conclusion ?? ""),
    ...(args.topRisk ? { topRisk: String(args.topRisk) } : {}),
  };
  appendFileSync(MEMO_FILE, JSON.stringify(entry) + "\n", "utf8");
  return { content: [{ type: "text", text: `已记录：${entry.repo} — ${entry.conclusion}` }] };
}

function listMemos(args) {
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 5));
  const memos = readMemos().slice(-limit).reverse();
  const text = memos.length
    ? memos
        .map((m) => `- ${m.at} ${m.repo} — ${m.conclusion}${m.topRisk ? `（最高风险：${m.topRisk}）` : ""}`)
        .join("\n")
    : "（暂无记录）";
  return { content: [{ type: "text", text }] };
}

function reply(id, result) {
  emit({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  emit({ jsonrpc: "2.0", id, error: { code, message } });
}
function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "notifications/initialized":
      return; // notification: no response
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        if (name === "memo_save") return reply(id, saveMemo(args));
        if (name === "memo_list") return reply(id, listMemos(args));
        return replyError(id, -32602, `unknown tool: ${name}`);
      } catch (err) {
        return replyError(id, -32603, err instanceof Error ? err.message : String(err));
      }
    }
    default:
      if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore malformed line
    }
  }
});
