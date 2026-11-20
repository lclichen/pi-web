import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { join, relative, resolve } from "path";
import { randomUUID } from "crypto";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { dataDir } from "./mode-homes";
import { JsonStore } from "./state/json-store";
import { legacyDataPath } from "./state/paths";
import { cleanupProjectSyncPlans } from "./sync-plan-store";
import { ensureQuickSessionWorkspace, quickTemplateHash } from "./quick-session";
import type { QuickTemplate } from "./quick-templates";
import { dropSshClient, writeSshConfig, type SshConfigInput } from "./ssh";
import { applyBundleToDirectory, bundleExists, isValidBundleName } from "./config-bundles-store";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { platformUrl } from "./platform/client";
import { trustProject } from "./project-trust";
import type { EmbedProjectBinding } from "./embed-types";
import type { SessionMode } from "./session-modes";

/**
 * Projects — the user-facing unit of configuration (design doc §"项目与配置
 * 分层"). Each project owns a home directory whose `.pi/` carries the project
 * config layer (settings/agents/skills/extensions/sandbox container, and
 * optionally auth.json/models.json for project-scoped model credentials)
 * layered on top of the admin-managed global agent dir. Duplicating a project
 * copies its config snapshot — that is the "多套配置切换" workflow.
 */

/** Runtime chat attachments and sync backups live under .pi but are
 *  machine-local temps; project duplication must not carry them. */
function isRuntimeConfigPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    normalized === ".pi/attachments" ||
    normalized.startsWith(".pi/attachments/") ||
    normalized === ".pi/.sync-backups" ||
    normalized.startsWith(".pi/.sync-backups/")
  );
}

export interface ProjectRecord {
  id: string;
  name: string;
  ownerId: number;
  ownerName?: string;
  mode: Extract<SessionMode, "sandbox" | "local-machine" | "ssh" | "host" | "quick">;
  createdAt: number;
  /** Session ids pinned inside this project, in pin order. */
  pinnedSessions: string[];
  /** Host/Quick projects: the actual workspace root (external dir / quick workspace). */
  workspaceRoot?: string;
  /** Quick projects: template identity and current workspace version. */
  templateId?: string;
  quickDir?: string;
  templateHash?: string;
  templateMissing?: boolean;
  /** Sandbox: pinned container id for this project's sessions. */
  containerId?: number;
  /** Sandbox: image chosen at creation (duplicates carry it; environment identity). */
  imageId?: number;
  /** Local-machine: the project working directory on the user's machine (relay-side path). */
  workdir?: string;
  /** Local-machine: which of the user's paired machines this project runs on
   *  (multi-machine). Absent = the user's default (most recent) machine. */
  machineId?: string;
  /** SSH mode: connection for the remote host (stored 0600 in the project home). */
  ssh?: SshConfigInput;
  /** Optional preset config bundle applied to the fresh home. */
  presetBundle?: string;
  /** Product integration binding (fixed stable project reference). */
  embed?: EmbedProjectBinding;
  /** Game-save slots (sandbox): snapshot save points, newest first, ≤2. */
  snapshotSlots?: Array<{ id: number; name: string; createdAt: number }>;
}

interface ProjectData {
  projects: Record<string, ProjectRecord>;
}

const PROJECT_MODES = new Set(["sandbox", "local-machine", "ssh", "host", "quick"]);

const projectsStore = new JsonStore<ProjectData>({
  name: "projects",
  scope: { kind: "global" },
  legacyPaths: () => [legacyDataPath("projects.json")],
  defaults: () => ({ projects: {} }),
  parse: (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const projects = (value as { projects?: unknown }).projects;
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return null;
    return { projects: projects as Record<string, ProjectRecord> };
  },
});

function projectData(): ProjectData {
  return projectsStore.read();
}

export function listProjects(ownerId: number): ProjectRecord[] {
  return Object.values(projectData().projects)
    .filter((p) => p.ownerId === ownerId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Project record for API responses: omit the real workspace path. The client
 * only needs identity/mode/name; workdir is resolved server-side for tools.
 */
export function publicProject(project: ProjectRecord): Omit<ProjectRecord, "workdir" | "workspaceRoot"> {
  const copy: ProjectRecord = { ...project };
  delete copy.workdir;
  delete copy.workspaceRoot;
  return copy;
}

/** All projects across users (container-binding lookups; callers must not
 *  leak cross-user records to clients). */
export function allProjects(): ProjectRecord[] {
  return Object.values(projectData().projects);
}

export function getProject(projectId: string): ProjectRecord | undefined {
  return projectData().projects[projectId];
}

/** Ownership-checked fetch; cross-user access reads as "not found". */
export function getOwnedProject(projectId: string, ownerId: number, isAdmin = false): ProjectRecord | undefined {
  const project = getProject(projectId);
  if (!project) return undefined;
  if (project.ownerId !== ownerId && !isAdmin && ownerId !== 0) return undefined;
  return project;
}

export function projectHome(project: ProjectRecord): string {
  if (project.mode === "host" || project.mode === "quick") {
    if (!project.workspaceRoot) throw new Error(`项目 ${project.id} 缺少 workspaceRoot`);
    return project.workspaceRoot;
  }
  return join(
    dataDir(),
    `${project.mode === "sandbox" ? "sandbox-homes" : "local-homes"}`,
    `u${project.ownerId}`,
    project.id,
  );
}

/**
 * Is `homePath` the on-disk home of one of the caller's projects? Gates
 * cwd-taking APIs (e.g. /api/models) that must read a project's config layer
 * even though project homes are outside the regular file-access roots.
 */
export function isCallerOwnedProjectHome(homePath: string, ownerId: number, isAdmin = false): boolean {
  const target = resolve(homePath).toLowerCase();
  for (const project of Object.values(projectData().projects)) {
    if (project.ownerId !== ownerId && !isAdmin && ownerId !== 0) continue;
    if (resolve(projectHome(project)).toLowerCase() === target) return true;
  }
  return false;
}

/**
 * 反查：某绝对路径是否为某个项目的 home，是则返回其项目 id（配置类 API
 * 以 cwd 寻址时用于解析项目配置写锁的 projectId；不做归属校验——调用方
 * 已通过 isCallerOwnedProjectHome / getOwnedProject 完成授权）。
 */
export function projectIdForHome(homePath: string): string | undefined {
  const target = resolve(homePath).toLowerCase();
  for (const project of Object.values(projectData().projects)) {
    if (resolve(projectHome(project)).toLowerCase() === target) return project.id;
  }
  return undefined;
}

export function ensureProjectHome(project: ProjectRecord): string {
  const home = projectHome(project);
  if (project.mode === "host" || project.mode === "quick") {
    if (!existsSync(home) || !statSync(home).isDirectory()) {
      throw new Error(`项目工作区不存在：${home}`);
    }
    return home;
  }
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

export async function createProject(input: {
  name: string;
  ownerId: number;
  ownerName?: string;
  mode: string;
  containerId?: number;
  imageId?: number;
  seedFromProjectId?: string;
  /** Local-machine mode: the project's working directory on the user's machine. */
  workdir?: string;
  /** Host external-dir / Quick workspace root. */
  workspaceRoot?: string;
  templateId?: string;
  quickDir?: string;
  templateHash?: string;
  /** Local-machine mode: which paired machine this project runs on. */
  machineId?: string;
  /** SSH mode: connection for the remote host (stored 0600 in the project home). */
  ssh?: SshConfigInput;
  /** Optional preset config bundle applied to the fresh home. */
  presetBundle?: string;
  /** Product integration binding. */
  embed?: EmbedProjectBinding;
}): Promise<{ ok: true; project: ProjectRecord } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name || name.length > 64) return { ok: false, error: "项目名不能为空且不超过 64 字符" };
  if (!PROJECT_MODES.has(input.mode)) return { ok: false, error: `不支持的模式：${input.mode}` };
  // 同一用户下项目名唯一：重名会让侧栏分组与复制/导入的目标辨识混乱。
  const duplicate = Object.values(projectData().projects).find((p) => p.ownerId === input.ownerId && p.name === name);
  if (duplicate) {
    return { ok: false, error: `已存在同名项目「${name}」，请换一个名称` };
  }

  const externalWorkspace = input.mode === "host" || input.mode === "quick";
  if (externalWorkspace) {
    const root = typeof input.workspaceRoot === "string" ? resolve(input.workspaceRoot.trim()) : "";
    if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
      return { ok: false, error: "项目工作目录不存在或不是目录" };
    }
    if (input.presetBundle || input.seedFromProjectId) {
      return { ok: false, error: "Host/Quick 项目不支持预置模板或从其他项目复制" };
    }
  }

  const project: ProjectRecord = {
    id: randomUUID(),
    name,
    ownerId: input.ownerId,
    ...(input.ownerName ? { ownerName: input.ownerName } : {}),
    mode: input.mode as ProjectRecord["mode"],
    createdAt: Date.now(),
    pinnedSessions: [],
    ...(input.embed ? { embed: { ...input.embed } } : {}),
    ...(externalWorkspace ? { workspaceRoot: resolve(input.workspaceRoot!.trim()) } : {}),
    ...(input.mode === "quick"
      ? {
          ...(input.templateId ? { templateId: input.templateId } : {}),
          ...(input.quickDir ? { quickDir: input.quickDir } : {}),
          ...(input.templateHash ? { templateHash: input.templateHash } : {}),
        }
      : {}),
    ...(input.mode === "sandbox" && input.containerId !== undefined ? { containerId: input.containerId } : {}),
    ...(input.mode === "sandbox" && input.imageId !== undefined ? { imageId: input.imageId } : {}),
    ...((input.mode === "local-machine" || input.mode === "ssh") && input.workdir ? { workdir: input.workdir } : {}),
    ...(input.mode === "local-machine" && input.machineId ? { machineId: input.machineId } : {}),
  };

  const home = ensureProjectHome(project);
  if (project.mode === "sandbox") {
    writeSandboxConfig(home, {
      url: safePlatformUrl() ?? "",
      apiKey: "",
      ...(project.containerId !== undefined ? { containerId: project.containerId } : {}),
      disableLocalFallback: true,
    });
    // Clean any legacy .pi/extensions/pi-sandbox-extension link (pre-merge
    // projects): the sandbox tools now come from amedac-core, injected inline
    // per session (agent/new, restore, subagent-bridge) — a surviving link
    // would double-register the container tools.
    removeLegacySandboxExtensionLink(home);
  }
  if (project.mode === "ssh") {
    if (!input.ssh) return { ok: false, error: "SSH 项目需要连接配置（host/username）" };
    // SSH 凭据写入项目 home（0600），会话创建时按项目读取；不进配置包。
    writeSshConfig(home, input.ssh);
  }

  // 预置配置模板：在 seed 之前应用（seed 的整包复制应优先级更高）。
  if (input.presetBundle) {
    if (!isValidBundleName(input.presetBundle) || !bundleExists(input.presetBundle)) {
      return { ok: false, error: `配置模板不存在：${input.presetBundle}` };
    }
    await applyBundleToDirectory(input.presetBundle, home);
  }

  // Optionally seed from another project: copy its ENTIRE home — `.pi/` config
  // plus project-level data such as labs/ and .lab-training/ state (the
  // teaching workflow "复制项目" expects both to carry over). Copy after the
  // sandbox config write above so the fresh credentials survive.
  if (input.seedFromProjectId) {
    const seed = getProject(input.seedFromProjectId);
    if (seed && seed.ownerId === input.ownerId && seed.id !== project.id) {
      const seedHome = projectHome(seed);
      if (existsSync(seedHome)) {
        for (const entry of readdirSync(seedHome)) {
          if (entry === ".pi") {
            cpSync(join(seedHome, ".pi"), join(home, ".pi"), {
              recursive: true,
              // Runtime chat attachments are per-machine temp files; never
              // carry them into a duplicate project.
              filter: (src) => !isRuntimeConfigPath(relative(seedHome, src)),
            });
            // The copy carries the seed's sandbox credentials; re-write this
            // project's own binding on top.
            if (project.mode === "sandbox") {
              writeSandboxConfig(home, {
                url: safePlatformUrl() ?? "",
                apiKey: "",
                ...(project.containerId !== undefined ? { containerId: project.containerId } : {}),
                disableLocalFallback: true,
              });
            }
          } else {
            cpSync(join(seedHome, entry), join(home, entry), { recursive: true });
          }
        }
      }
    }
  }

  // All project homes are pi-web-managed (sandbox/local-machine/ssh sessions
  // WebUI-managed Host projects are explicitly created by an admin, so the
  // selected server directory is trusted; Quick workspaces are generated and
  // deliberately bypass trust. Managed stub homes are trusted as before.
  if (project.mode !== "quick") {
    trustProject(home, getAgentDir());
  }

  let added = false;
  projectsStore.update((data) => {
    // Re-check under the store lock: a concurrent create may have taken the
    // name while the home/preset work above was running.
    if (Object.values(data.projects).some((p) => p.ownerId === project.ownerId && p.name === project.name)) return;
    data.projects[project.id] = project;
    added = true;
  });
  if (!added) return { ok: false, error: `已存在同名项目「${name}」，请换一个名称` };
  return { ok: true, project };
}

export function updateProject(
  projectId: string,
  patch: {
    name?: string;
    containerId?: number | null;
    workdir?: string;
    machineId?: string | null;
    pinSessionId?: string;
    unpinSessionId?: string;
    snapshotSlots?: Array<{ id: number; name: string; createdAt: number }>;
  },
): { ok: true; project: ProjectRecord } | { ok: false; error: string } {
  let updated: ProjectRecord | undefined;
  let error: string | undefined;
  projectsStore.update((data) => {
    const project = data.projects[projectId];
    if (!project) {
      error = "项目不存在";
      return;
    }
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name || name.length > 64) {
        error = "项目名不能为空且不超过 64 字符";
        return;
      }
      project.name = name;
    }
    if (patch.workdir !== undefined && project.mode === "local-machine") {
      const dir = patch.workdir.trim();
      if (dir) project.workdir = dir;
      else delete project.workdir;
    }
    if (patch.machineId !== undefined && project.mode === "local-machine") {
      // null/empty clears the binding → the user's default machine.
      if (patch.machineId && /^[A-Za-z0-9_-]{1,64}$/.test(patch.machineId)) project.machineId = patch.machineId;
      else delete project.machineId;
    }
    if (patch.containerId !== undefined && project.mode === "sandbox") {
      if (patch.containerId === null) delete project.containerId;
      else project.containerId = patch.containerId;
      writeSandboxConfig(projectHome(project), {
        url: safePlatformUrl() ?? "",
        apiKey: "",
        ...(project.containerId !== undefined ? { containerId: project.containerId } : {}),
        disableLocalFallback: true,
      });
    }
    if (patch.pinSessionId) {
      project.pinnedSessions = [
        patch.pinSessionId,
        ...(project.pinnedSessions ?? []).filter((id) => id !== patch.pinSessionId),
      ].slice(0, 20);
    }
    if (patch.snapshotSlots !== undefined) {
      project.snapshotSlots = patch.snapshotSlots;
    }
    if (patch.unpinSessionId) {
      project.pinnedSessions = (project.pinnedSessions ?? []).filter((id) => id !== patch.unpinSessionId);
    }
    updated = project;
  });
  if (error || !updated) return { ok: false, error: error ?? "项目不存在" };
  return { ok: true, project: updated };
}

/** Find a product-bound project for a stable product/user/client/slot key. */
export function findEmbedProject(
  productId: string,
  ownerId: number,
  clientId: string,
  externalRef: string,
): ProjectRecord | undefined {
  return Object.values(projectData().projects).find(
    (project) =>
      project.ownerId === ownerId &&
      project.embed?.productId === productId &&
      project.embed.clientId === clientId &&
      project.embed.externalRef === externalRef,
  );
}

/** Bind/rebind a project to a product integration (or clear with null). */
export function setProjectEmbed(
  projectId: string,
  embed: EmbedProjectBinding | null,
): ProjectRecord | undefined {
  let updated: ProjectRecord | undefined;
  projectsStore.update((data) => {
    const project = data.projects[projectId];
    if (!project) return;
    if (embed) project.embed = { ...embed };
    else delete project.embed;
    updated = project;
  });
  return updated;
}

export function deleteProject(projectId: string): boolean {
  const project = projectData().projects[projectId];
  if (!project) return false;
  projectsStore.update((data) => {
    delete data.projects[projectId];
  });
  // Drop the pooled SSH connection (one per project, shared by every session):
  // a deleted project must not leave a live client behind.
  try {
    dropSshClient(projectId);
  } catch {
    // best-effort
  }
  try {
    // A managed Host project borrows an existing server directory: deleting the
    // record must never remove the user's files. Quick workspaces are generated
    // scratch state and may be removed with the project.
    if (project.mode !== "host") rmSync(projectHome(project), { recursive: true, force: true });
  } catch {
    // home removal is best-effort
  }
  // Runtime state keyed by the project id: projection manifests, unconsumed
  // sync-plan tokens and the collected-files library (P2).
  try {
    cleanupProjectSyncPlans(projectId);
  } catch {
    // best-effort
  }
  for (const dir of ["projection", "collections"]) {
    try {
      rmSync(join(dataDir(), dir, projectId), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  return true;
}

/**
 * Duplicate a project: copy its ENTIRE home under a new id. The container
 * binding is intentionally NOT carried over — two projects sharing one
 * container would overwrite each other's synced /workspace. The copy starts
 * unbound; session-start resolution picks/creates its own container.
 */
/** One Quick Project per (owner, template), independent of workspace version. */
export function findQuickProject(ownerId: number, templateId: string): ProjectRecord | undefined {
  return Object.values(projectData().projects).find(
    (project) => project.mode === "quick" && project.ownerId === ownerId && project.templateId === templateId,
  );
}

/** Mark Quick Projects whose template was deleted; sessions remain readable. */
export function markQuickTemplateMissing(templateId: string): void {
  projectsStore.update((data) => {
    for (const project of Object.values(data.projects)) {
      if (project.mode === "quick" && project.templateId === templateId) {
        project.templateMissing = true;
      }
    }
  });
}

/**
 * Ensure the stable Quick Project for a template and point it at the current
 * template-version workspace. Older sessions keep their own quickDir and are
 * unaffected by a template edit.
 */
export async function ensureQuickProject(  ownerId: number,
  ownerName: string | undefined,
  template: QuickTemplate,
): Promise<ProjectRecord> {
  const workspace = ensureQuickSessionWorkspace(ownerId, template);
  const templateHash = quickTemplateHash(template);
  const existing = findQuickProject(ownerId, template.id);
  if (existing) {
    let updated: ProjectRecord | undefined;
    projectsStore.update((data) => {
      const project = data.projects[existing.id];
      if (!project) return;
      project.workspaceRoot = workspace.dir;
      project.quickDir = workspace.slug;
      project.templateHash = templateHash;
      delete project.templateMissing;
      updated = project;
    });
    return updated ?? existing;
  }

  const baseName = template.name.trim() || `Quick ${template.id}`;
  let candidate = baseName;
  let suffix = 2;
  while (Object.values(projectData().projects).some((p) => p.ownerId === ownerId && p.name === candidate)) {
    candidate = `${baseName} (${suffix++})`;
  }
  const created = await createProject({
    name: candidate,
    ownerId,
    ...(ownerName ? { ownerName } : {}),
    mode: "quick",
    workspaceRoot: workspace.dir,
    templateId: template.id,
    quickDir: workspace.slug,
    templateHash,
  });
  if (created.ok) return created.project;
  // A concurrent first-use may have created it while this request was doing
  // the workspace/materialization work.
  const raced = findQuickProject(ownerId, template.id);
  if (raced) return raced;
  throw new Error(created.error);
}

export async function duplicateProject(
  projectId: string,
  newName: string,
): Promise<{ ok: true; project: ProjectRecord } | { ok: false; error: string }> {
  const source = getProject(projectId);
  if (!source) return { ok: false, error: "项目不存在" };
  if (source.mode === "host" || source.mode === "quick") {
    return { ok: false, error: "Host/Quick 项目不支持复制" };
  }
  // 复制的目标名若已占用，自动加序号后缀（用户的意图是"再来一份"）。
  let candidate = newName;
  let n = 2;
  while (Object.values(projectData().projects).some((p) => p.ownerId === source.ownerId && p.name === candidate)) {
    candidate = `${newName} (${n++})`;
  }
  return await createProject({
    name: candidate,
    ownerId: source.ownerId,
    ownerName: source.ownerName,
    mode: source.mode,
    // The copy keeps the source environment identity (same image).
    ...(source.imageId !== undefined ? { imageId: source.imageId } : {}),
    seedFromProjectId: source.id,
  });
}

// ---- sandbox project config ----

export interface ProjectSandboxConfig {
  url: string;
  apiKey: string;
  containerId?: number | string;
  disableLocalFallback: boolean;
}

export function readProjectSandboxConfig(project: ProjectRecord): ProjectSandboxConfig {
  try {
    const parsed = JSON.parse(
      readFileSync(join(projectHome(project), ".pi", "sandbox-platform.json"), "utf8"),
    ) as Partial<ProjectSandboxConfig>;
    return {
      url: typeof parsed.url === "string" ? parsed.url : (safePlatformUrl() ?? ""),
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      ...(parsed.containerId !== undefined ? { containerId: parsed.containerId } : {}),
      disableLocalFallback: parsed.disableLocalFallback !== false,
    };
  } catch {
    return { url: safePlatformUrl() ?? "", apiKey: "", disableLocalFallback: true };
  }
}

/** Merge credentials/config into a project's sandbox-platform.json. */
export function writeSandboxConfig(home: string, patch: Partial<ProjectSandboxConfig>): void {
  const piDir = join(home, ".pi");
  if (!existsSync(piDir)) mkdirSync(piDir, { recursive: true });
  const path = join(piDir, "sandbox-platform.json");
  let current: ProjectSandboxConfig = { url: safePlatformUrl() ?? "", apiKey: "", disableLocalFallback: true };
  try {
    current = { ...current, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectSandboxConfig>) };
  } catch {
    // fresh
  }
  writePrivateFileAtomicSync(path, JSON.stringify({ ...current, ...patch, disableLocalFallback: true }, null, 2));
}

function safePlatformUrl(): string | undefined {
  try {
    return platformUrl();
  } catch {
    return undefined;
  }
}

/** Resolve a request's project home for config APIs (plugins/agents): the
 *  caller must have already verified ownership. */
export function projectConfigCwd(project: ProjectRecord): string {
  return resolve(ensureProjectHome(project));
}

/** Remove the legacy .pi/extensions/pi-sandbox-extension link (or copied
 *  directory) from a project home. Pre-merge projects carried it; with the
 *  sandbox tools living in amedac-core (inline injection in pi-web sessions),
 *  a surviving copy would double-register the container tools. lstat covers
 *  broken symlinks that existsSync (which follows links) reports as absent. */
export function removeLegacySandboxExtensionLink(home: string): void {
  const linkPath = join(home, ".pi", "extensions", "pi-sandbox-extension");
  try {
    lstatSync(linkPath);
  } catch {
    return; // absent — nothing to clean
  }
  try {
    rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // best-effort; a stale copy only risks duplicate registration once
  }
}
