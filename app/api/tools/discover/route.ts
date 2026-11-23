import { NextResponse } from "next/server";
import { readMcpConfig } from "@/lib/mcp-config";
import { requireUserIdentity } from "@/lib/web-session";
import { probeServer } from "@/lib/mcp-probe";
import { quickHomeDir } from "@/lib/mode-homes";
import type { McpTool } from "@/lib/api-types";

export const dynamic = "force-dynamic";

const BUILTIN_TOOLS = ["bash", "edit", "find", "grep", "ls", "read", "write"];

export interface McpServerTools {
  server: string;
  scope: "project" | "user" | "global" | "quick";
  transport: "stdio" | "http";
  tools: McpTool[];
  error?: string;
  needsAuth?: boolean;
}

// GET /api/tools/discover?cwd=&probe=true
// GET /api/tools/discover?quick=1&probe=true  — quick-session scope (no cwd)
// probe=false (default) returns builtin + config metadata only (instant)
// probe=true probes each MCP server for real tool lists (slower)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const quick = searchParams.get("quick") === "1";
  const cwdParam = searchParams.get("cwd");
  if (!quick && !cwdParam) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  const shouldProbe = searchParams.get("probe") === "true";

  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });
  // Quick tool discovery reads the caller's quick home: project scope
  // (materialized quick servers + user additions) + deployment quick scope +
  // global. The quick template editor is admin-only and uses the same pool.
  const cwd = quick ? quickHomeDir(identity.session.user.id) : cwdParam!;

  try {
    const doc = readMcpConfig(cwd, { userId: identity.session.user.id });

    if (!shouldProbe) {
      return NextResponse.json({
        builtin: BUILTIN_TOOLS,
        mcp: doc.servers.map((s) => ({
          server: s.name,
          scope: s.scope,
          transport: s.transport,
          tools: [],
        })),
      });
    }

    const probeResults: McpServerTools[] = await Promise.all(
      doc.servers.map(async (s) => {
        try {
          if (s.entry.command && s.entry.piWeb?.plane === "workspace") {
            // Never spawn a workspace-plane stdio server in the control plane.
            return {
              server: s.name,
              scope: s.scope,
              transport: s.transport,
              tools: [],
              error: "在会话配对机器上运行；本页不直接探测",
            };
          }
          const result = await probeServer(s.entry, 10000);
          return {
            server: s.name,
            scope: s.scope,
            transport: s.transport,
            tools: result.tools,
            error: result.error,
            needsAuth: result.needsAuth,
          };
        } catch (e) {
          return {
            server: s.name,
            scope: s.scope,
            transport: s.transport,
            tools: [],
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );

    return NextResponse.json({
      builtin: BUILTIN_TOOLS,
      mcp: probeResults,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
