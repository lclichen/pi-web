import { NextResponse } from "next/server";
import { readMcpConfig } from "@/lib/mcp-config";
import { probeServer } from "@/lib/mcp-probe";
import type { McpTool } from "@/lib/api-types";

export const dynamic = "force-dynamic";

const BUILTIN_TOOLS = ["bash", "edit", "find", "grep", "ls", "read", "write"];

export interface McpServerTools {
  server: string;
  scope: "project" | "global";
  transport: "stdio" | "http";
  tools: McpTool[];
  error?: string;
  needsAuth?: boolean;
}

// GET /api/tools/discover?cwd=&probe=true
// probe=false (default) returns builtin + config metadata only (instant)
// probe=true probes each MCP server for real tool lists (slower)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  const shouldProbe = searchParams.get("probe") === "true";

  try {
    const doc = readMcpConfig(cwd);

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
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
