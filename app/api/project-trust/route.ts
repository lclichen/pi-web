import { stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { requireUserIdentity } from "@/lib/web-session";
import { isCallerOwnedProjectHome } from "@/lib/projects";
import type {
  McpErrorResponse,
  McpRefusalReason,
  ProjectMcpListing,
  ProjectTrustResponse,
  ProjectTrustUnreadableResponse,
} from "@/lib/api-types";
import { readProjectMcpServers } from "@/lib/mcp-config-read";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getProjectTrustStatus, trustProject } from "@/lib/project-trust";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { destroyRpcSessionsForCwd, hasBusyRpcSessionForCwd } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refusal(status: number, reason: McpRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies McpErrorResponse, { status });
}

async function validateCwd(req: Request, value: unknown): Promise<
  { cwd: string } | { response: NextResponse }
> {
  if (typeof value !== "string" || !value.trim()) {
    return { response: NextResponse.json({ error: "cwd required" }, { status: 400 }) };
  }

  const cwd = resolve(value);
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return { response: NextResponse.json({ error: "cwd must be a directory" }, { status: 400 }) };
    }
  } catch {
    return { response: NextResponse.json({ error: "Directory does not exist" }, { status: 400 }) };
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    // 项目空间（沙盒/SSH/本机）的会话 cwd 是项目 home，位于常规文件根之外；
    // 归属校验通过即放行——项目技能的信任提示同样需要能查/能解除。
    // MERGE-NOTE(upgrade/1.0): upstream gates by the global roots alone
    // (validateMcpProject); dev keeps the per-user ownership fence.
    const identity = requireUserIdentity(req);
    const owned = identity.ok
      && isCallerOwnedProjectHome(cwd, identity.session.user.id, identity.session.user.role === "admin");
    if (!owned) {
      return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
    }
  }
  return { cwd };
}

// MERGE-NOTE(upgrade/1.0): upstream's trust dialog lists the servers the
// project's `.pi/mcp.json` declares before anyone trusts the folder
// (ADR 0006, files-only read). Dev keeps its adapter MCP stack for /api/mcp
// but returns the same listing shape here; a failed listing degrades to an
// empty one so the trust status still comes through.
async function listProjectMcpServers(agentDir: string, cwd: string): Promise<ProjectMcpListing> {
  try {
    const { file, servers } = await readProjectMcpServers({
      agentDir,
      cwd,
      allowedRoots: await getAllowedFileRoots(),
    });
    return { mcpFile: file, mcpServers: servers };
  } catch (error) {
    return { mcpServers: [], mcpError: errorMessage(error) };
  }
}

// GET /api/project-trust?cwd=<folder>: the trust status, and the servers the
// project's `.pi/mcp.json` declares, so the trust dialog lists what trusting
// would connect before anyone trusts the folder (ADR 0006). The listing reads
// the files only, like GET /api/mcp: no server is spawned, no value resolved,
// no `!command` run, and env and header values never leave the server.
export async function GET(req: Request) {
  const result = await validateCwd(req, new URL(req.url).searchParams.get("cwd"));
  if ("response" in result) return result.response;
  const agentDir = getAgentDir();
  // Listed whatever the trust store says: the listing does not depend on it,
  // and a dialog left without one would offer Trust with nothing listed.
  const listing = await listProjectMcpServers(agentDir, result.cwd);
  try {
    return NextResponse.json({ ...getProjectTrustStatus(result.cwd, agentDir), ...listing } satisfies ProjectTrustResponse);
  } catch (error) {
    // trust.json unparsable, or locked by another process (the pi CLI) past the
    // store's short wait; trusting would fail the same way right now.
    return NextResponse.json(
      { error: errorMessage(error), reason: "trust-unreadable", ...listing } satisfies ProjectTrustUnreadableResponse,
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "content-type", "Content-Type must be application/json");
  try {
    // A body that is not JSON names no cwd.
    const body = await req.json().catch(() => null) as { cwd?: unknown } | null;
    const result = await validateCwd(req, body?.cwd);
    if ("response" in result) return result.response;

    const agentDir = getAgentDir();
    const current = getProjectTrustStatus(result.cwd, agentDir);
    if (!current.requiresTrust) {
      return refusal(409, "trust-not-required", "This project has no resources that require trust");
    }
    if (hasBusyRpcSessionForCwd(result.cwd)) {
      return refusal(409, "session-busy", "Wait for the active session to finish before trusting this project");
    }

    const status = trustProject(result.cwd, agentDir);
    invalidateModelsCache();
    await destroyRpcSessionsForCwd(result.cwd);
    return NextResponse.json(status);
  } catch (error) {
    return refusal(500, "internal", errorMessage(error));
  }
}
