import { NextResponse } from "next/server";
import {
  getOwnedProject,
  readProjectSandboxConfig,
  updateProject,
  writeSandboxConfig,
  projectHome,
  publicProject,
} from "@/lib/projects";
import { getProjectRuntimeBusy } from "@/lib/rpc-manager";
import { deleteProjectCascade } from "@/lib/state/lifecycle";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { invalidateModelsCache } from "@/lib/models-cache";
import { validateAgentDirectory } from "@/lib/relay/browse";
import { getMachinesForUser } from "@/lib/relay/registry";
import { listAgentTokens } from "@/lib/relay/relay-store";
import { DEFAULT_MACHINE_ID } from "@/lib/relay/protocol";
import { withProjectConfigWriteLock, ProjectConfigLockBusyError } from "@/lib/project-config-lock";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

function own(req: Request, id: string) {
  const identity = requireUserIdentity(req);
  if (!identity.ok) return { error: NextResponse.json({ error: "登录已失效" }, { status: identity.status }) };
  const project = getOwnedProject(id, identity.session.user.id, identity.session.user.role === "admin");
  if (!project) return { error: NextResponse.json({ error: "项目不存在" }, { status: 404 }) };
  return { identity, project };
}

// GET /api/projects/:id — record + project-scoped model credential files.
export async function GET(req: Request, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const r = own(req, id);
  if (r.error) return r.error;
  const readOptional = (name: string): string | null => {
    try {
      return readFileSync(`${projectHome(r.project!)}/.pi/${name}`, "utf8");
    } catch {
      return null;
    }
  };
  let agentsMd: string | null = null;
  try {
    agentsMd = readFileSync(`${projectHome(r.project!)}/AGENTS.md`, "utf8");
  } catch {
    // absent — inherited from the global layer / SDK defaults
  }
  return NextResponse.json({
    project: publicProject(r.project!),
    ...(r.project!.mode === "sandbox" ? { sandbox: readProjectSandboxConfig(r.project!) } : {}),
    modelsJson: readOptional("models.json"),
    authJson: readOptional("auth.json"),
    agentsMd,
  });
}

// PATCH /api/projects/:id { name?, containerId?, pinSessionId?, unpinSessionId?,
//                            modelsJson?, authJson?, apiKey? }
export async function PATCH(req: Request, ctx: RouteCtx) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { id } = await ctx.params;
  const r = own(req, id);
  if (r.error) return r.error;
  const project = r.project!;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Local-machine 改绑机器（「重新连接机器」）：非空 machineId 必须是该用户
  // 机器目录里的一台——否则客户端可以把项目绑到不属于自己的机器上。空串 /
  // null = 清除绑定（回落到默认机器），不做归属校验。错误信息不回显机器名，
  // 避免泄漏别的用户的信息。
  const callerId = r.identity!.session.user.id;
  const requestedMachineId =
    body.machineId !== undefined && (body.machineId === null || typeof body.machineId === "string")
      ? (body.machineId as string | null)
      : undefined;
  const nextMachineId = typeof requestedMachineId === "string" && requestedMachineId ? requestedMachineId : "";
  if (project.mode === "local-machine" && nextMachineId) {
    // 正常归属：该用户机器目录里的一台。auth-off（userId 0）是隐式 host 单用户
    // ——与 getOwnedProject 对 0 的放行一致，token 目录里的机器都算「本机」：
    // 部署曾开启多用户时，旧 token 的 userId 非 0，只看 getMachinesForUser(0)
    // 会把合法的改绑全部拒掉，而浏览器侧（getStatus()）仍能看到那台机器。
    // auth-on 不做这条豁免；0 之外的任何身份都必须真的拥有该机器。
    const paired = getMachinesForUser(callerId).some((m) => m.machineId === nextMachineId);
    const authOffMachine =
      callerId === 0 &&
      listAgentTokens().some(({ record }) => (record.machineId ?? DEFAULT_MACHINE_ID) === nextMachineId);
    if (!paired && !authOffMachine) {
      return NextResponse.json({ error: "该机器未在当前账号下配对，请先完成本机配对后再绑定" }, { status: 400 });
    }
  }

  // 项目 home 配置写入（ADR-0004 §4.2 共享写锁）：models/auth 凭据、
  // AGENTS.md、sandbox 平台凭据统一在 withProjectConfigWriteLock 内落盘，
  // 与 sync apply/rollback、bundle apply 互斥，不出现半写。校验全部前置，
  // 非法输入在任何写之前 400（原实现逐项边验边写，一项失败可能留下半写）。
  // 凭据文件：JSON 校验，空串 = 删除（回退继承全局）。
  interface CredentialWrite {
    path: string;
    remove: boolean;
    value: string;
  }
  const credentialWrites: CredentialWrite[] = [];
  for (const key of ["modelsJson", "authJson"] as const) {
    if (body[key] === undefined) continue;
    const value = body[key];
    if (typeof value !== "string") return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
    if (value.trim() === "") {
      credentialWrites.push({
        path: `${projectHome(project)}/.pi/${key === "modelsJson" ? "models.json" : "auth.json"}`,
        remove: true,
        value: "",
      });
      continue;
    }
    try {
      JSON.parse(value);
    } catch {
      return NextResponse.json({ error: `${key} 不是合法 JSON` }, { status: 400 });
    }
    credentialWrites.push({
      path: `${projectHome(project)}/.pi/${key === "modelsJson" ? "models.json" : "auth.json"}`,
      remove: false,
      value,
    });
  }
  // Project instructions (AGENTS.md): written at the home root — the SDK
  // loads it as session instructions from the session cwd (the home), it
  // rides along on project duplication, and agent edits made in the
  // workspace are mirrored back here (sandbox extension / relay tools).
  // Empty string deletes the file.
  const agentsMd = typeof body.agentsMd === "string" ? body.agentsMd : null;
  // Sandbox credentials (platform API key) merge into the project config.
  const sessionApiKey = r.identity!.session.apiKey;
  const sandboxApiKey = typeof body.apiKey === "string" && body.apiKey && sessionApiKey ? sessionApiKey : null;

  if (credentialWrites.length > 0 || agentsMd !== null || sandboxApiKey !== null) {
    try {
      await withProjectConfigWriteLock(project.id, async () => {
        for (const write of credentialWrites) {
          if (write.remove) {
            try {
              unlinkSync(write.path);
            } catch {
              /* absent is fine */
            }
            continue;
          }
          mkdirSync(`${projectHome(project)}/.pi`, { recursive: true });
          writeFileSync(write.path, write.value, "utf8");
        }
        if (agentsMd !== null) {
          const agentsPath = `${projectHome(project)}/AGENTS.md`;
          mkdirSync(`${projectHome(project)}`, { recursive: true });
          if (agentsMd.trim() === "") {
            try {
              unlinkSync(agentsPath);
            } catch {
              /* absent is fine */
            }
          } else {
            writeFileSync(agentsPath, agentsMd, "utf8");
          }
        }
        if (sandboxApiKey !== null) {
          writeSandboxConfig(projectHome(project), { apiKey: sandboxApiKey });
        }
      });
    } catch (e) {
      if (e instanceof ProjectConfigLockBusyError) {
        return NextResponse.json({ error: e.message, code: "PROJECT_LOCKED" }, { status: 409 });
      }
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }
  // The 60s models cache would otherwise serve the previous provider list.
  if (credentialWrites.length > 0) invalidateModelsCache();

  // Local-machine workdir: validate on the paired machine before persisting,
  // so a typo cannot point the project at a directory that does not exist.
  // 校验必须打在**本次请求要绑定**的机器上：同一请求里既换机器又换目录正是
  // 「重新连接」的典型形态，拿项目当前（已解配的）旧机器去校验必然失败。
  let workdirPatch: string | undefined;
  if (typeof body.workdir === "string" && project.mode === "local-machine") {
    const candidate = body.workdir.trim();
    if (candidate) {
      try {
        workdirPatch = await validateAgentDirectory(
          r.identity!.session.user.id,
          nextMachineId || project.machineId,
          candidate,
        );
      } catch (error) {
        return NextResponse.json(
          { error: `工作目录不可用：${error instanceof Error ? error.message : String(error)}` },
          { status: 400 },
        );
      }
    } else {
      workdirPatch = "";
    }
  }

  const result = updateProject(id, {
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(body.containerId !== undefined && (body.containerId === null || typeof body.containerId === "number")
      ? { containerId: body.containerId as number | null }
      : {}),
    ...(workdirPatch !== undefined ? { workdir: workdirPatch } : {}),
    ...(body.machineId !== undefined && (body.machineId === null || typeof body.machineId === "string")
      ? { machineId: body.machineId as string | null }
      : {}),
    ...(typeof body.pinSessionId === "string" ? { pinSessionId: body.pinSessionId } : {}),
    ...(typeof body.unpinSessionId === "string" ? { unpinSessionId: body.unpinSessionId } : {}),
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ project: publicProject(result.project) });
}

// DELETE /api/projects/:id — record + home directory.
export async function DELETE(req: Request, ctx: RouteCtx) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const r = own(req, id);
  if (r.error) return r.error;
  try {
    // Serialize the busy check with session/project-config starts: a session
    // created between the check and the cascade would otherwise be deleted
    // underneath (TOCTOU). Session startup takes the project read lock.
    return await withProjectConfigWriteLock(id, async () => {
      const busy = await getProjectRuntimeBusy(id);
      if (busy.busy) {
        return NextResponse.json(
          {
            error: `项目仍有运行中的会话或批量任务，请先停止后再删除`,
            sessions: busy.sessions,
            batchTasks: busy.batchTasks,
          },
          { status: 409 },
        );
      }
      await deleteProjectCascade(r.project!);
      return NextResponse.json({ success: true });
    });
  } catch (e) {
    if (e instanceof ProjectConfigLockBusyError) {
      return NextResponse.json({ error: e.message, code: "PROJECT_LOCKED" }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
