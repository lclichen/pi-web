import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { dataDir } from "./mode-homes";
import { platformUrl } from "./platform/client";
import type { SessionMode } from "./session-modes";

/**
 * Projects — the user-facing unit of configuration (design doc §"项目与配置
 * 分层"). Each project owns a home directory whose `.pi/` carries the project
 * config layer (settings/agents/skills/extensions/sandbox container, and
 * optionally auth.json/models.json for project-scoped model credentials)
 * layered on top of the admin-managed global agent dir. Duplicating a project
 * copies its config snapshot — that is the "多套配置切换" workflow.
 */

export interface ProjectRecord {
  id: string;
  name: string;
  ownerId: number;
  ownerName?: string;
  mode: Extract<SessionMode, "sandbox" | "local-machine">;
  createdAt: number;
  /** Session ids pinned inside this project, in pin order. */
  pinnedSessions: string[];
  /** Sandbox: pinned container id for this project's sessions. */
  containerId?: number;
  /** Sandbox: image chosen at creation (duplicates carry it; environment identity). */
  imageId?: number;
  /** Game-save slots (sandbox): snapshot save points, newest first, ≤2. */
  snapshotSlots?: Array<{ id: number; name: string; createdAt: number }>;
}

interface ProjectFile {
  version: 1;
  projects: Record<string, ProjectRecord>;
}

declare global {
  var __piProjectsStore: { path: string; data: ProjectFile } | undefined;
}

const PROJECT_MODES = new Set(["sandbox", "local-machine"]);

function storePath(): string {
  return join(dataDir(), "projects.json");
}

function store(): { path: string; data: ProjectFile } {
  if (!globalThis.__piProjectsStore || globalThis.__piProjectsStore.path !== storePath()) {
    let data: ProjectFile = { version: 1, projects: {} };
    try {
      const parsed = JSON.parse(readFileSync(storePath(), "utf8")) as ProjectFile;
      if (parsed && parsed.projects) data = parsed;
    } catch {
      // fresh store
    }
    globalThis.__piProjectsStore = { path: storePath(), data };
  }
  return globalThis.__piProjectsStore;
}

function persist(): void {
  const s = store();
  try {
    writeFileSync(s.path, JSON.stringify(s.data, null, 2), "utf8");
  } catch {
    // best-effort sidecar
  }
}

export function listProjects(ownerId: number): ProjectRecord[] {
  return Object.values(store().data.projects)
    .filter((p) => p.ownerId === ownerId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** All projects across users (container-binding lookups; callers must not
 *  leak cross-user records to clients). */
export function allProjects(): ProjectRecord[] {
  return Object.values(store().data.projects);
}

export function getProject(projectId: string): ProjectRecord | undefined {
  return store().data.projects[projectId];
}

/** Ownership-checked fetch; cross-user access reads as "not found". */
export function getOwnedProject(projectId: string, ownerId: number, isAdmin = false): ProjectRecord | undefined {
  const project = getProject(projectId);
  if (!project) return undefined;
  if (project.ownerId !== ownerId && !isAdmin && ownerId !== 0) return undefined;
  return project;
}

export function projectHome(project: ProjectRecord): string {
  return join(dataDir(), `${project.mode === "sandbox" ? "sandbox-homes" : "local-homes"}`, `u${project.ownerId}`, project.id);
}

/**
 * Is `homePath` the on-disk home of one of the caller's projects? Gates
 * cwd-taking APIs (e.g. /api/models) that must read a project's config layer
 * even though project homes are outside the regular file-access roots.
 */
export function isCallerOwnedProjectHome(homePath: string, ownerId: number, isAdmin = false): boolean {
  const target = resolve(homePath).toLowerCase();
  for (const project of Object.values(store().data.projects)) {
    if (project.ownerId !== ownerId && !isAdmin && ownerId !== 0) continue;
    if (resolve(projectHome(project)).toLowerCase() === target) return true;
  }
  return false;
}

export function ensureProjectHome(project: ProjectRecord): string {
  const home = projectHome(project);
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return home;
}

export function createProject(input: {
  name: string;
  ownerId: number;
  ownerName?: string;
  mode: string;
  containerId?: number;
  imageId?: number;
  seedFromProjectId?: string;
}): { ok: true; project: ProjectRecord } | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name || name.length > 64) return { ok: false, error: "项目名不能为空且不超过 64 字符" };
  if (!PROJECT_MODES.has(input.mode)) return { ok: false, error: `不支持的模式：${input.mode}` };
  // 同一用户下项目名唯一：重名会让侧栏分组与复制/导入的目标辨识混乱。
  const duplicate = Object.values(store().data.projects).find(
    (p) => p.ownerId === input.ownerId && p.name === name,
  );
  if (duplicate) {
    return { ok: false, error: `已存在同名项目「${name}」，请换一个名称` };
  }

  const project: ProjectRecord = {
    id: randomUUID(),
    name,
    ownerId: input.ownerId,
    ...(input.ownerName ? { ownerName: input.ownerName } : {}),
    mode: input.mode as ProjectRecord["mode"],
    createdAt: Date.now(),
    pinnedSessions: [],
    ...(input.mode === "sandbox" && input.containerId !== undefined ? { containerId: input.containerId } : {}),
    ...(input.mode === "sandbox" && input.imageId !== undefined ? { imageId: input.imageId } : {}),
  };

  const home = ensureProjectHome(project);
  if (project.mode === "sandbox") {
    writeSandboxConfig(home, {
      url: safePlatformUrl() ?? "",
      apiKey: "",
      ...(project.containerId !== undefined ? { containerId: project.containerId } : {}),
      disableLocalFallback: true,
    });
    // Symlink the sandbox extension into the project's .pi/extensions/ so the
    // SDK's normal extension discovery loads it for ANY session created with
    // this cwd — including subagents, restored sessions, plan mode, hooks.
    // This replaces the per-session additionalExtensionPaths injection, which
    // only covered /api/agent/new and was silently missing everywhere else.
    ensureSandboxExtensionLink(home);
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
            cpSync(join(seedHome, ".pi"), join(home, ".pi"), { recursive: true });
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

  store().data.projects[project.id] = project;
  persist();
  return { ok: true, project };
}

export function updateProject(
  projectId: string,
  patch: { name?: string; containerId?: number | null; pinSessionId?: string; unpinSessionId?: string; snapshotSlots?: Array<{ id: number; name: string; createdAt: number }> },
): { ok: true; project: ProjectRecord } | { ok: false; error: string } {
  const project = store().data.projects[projectId];
  if (!project) return { ok: false, error: "项目不存在" };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > 64) return { ok: false, error: "项目名不能为空且不超过 64 字符" };
    project.name = name;
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
      ...project.pinnedSessions.filter((id) => id !== patch.pinSessionId),
    ].slice(0, 20);
  }
  if (patch.snapshotSlots !== undefined) {
    project.snapshotSlots = patch.snapshotSlots;
  }
  if (patch.unpinSessionId) {
    project.pinnedSessions = project.pinnedSessions.filter((id) => id !== patch.unpinSessionId);
  }
  persist();
  return { ok: true, project };
}

export function deleteProject(projectId: string): boolean {
  const project = store().data.projects[projectId];
  if (!project) return false;
  delete store().data.projects[projectId];
  persist();
  try {
    rmSync(projectHome(project), { recursive: true, force: true });
  } catch {
    // home removal is best-effort
  }
  return true;
}

/**
 * Duplicate a project: copy its ENTIRE home under a new id. The container
 * binding is intentionally NOT carried over — two projects sharing one
 * container would overwrite each other's synced /workspace. The copy starts
 * unbound; session-start resolution picks/creates its own container.
 */
export function duplicateProject(
  projectId: string,
  newName: string,
): { ok: true; project: ProjectRecord } | { ok: false; error: string } {
  const source = getProject(projectId);
  if (!source) return { ok: false, error: "项目不存在" };
  // 复制的目标名若已占用，自动加序号后缀（用户的意图是"再来一份"）。
  let candidate = newName;
  let n = 2;
  while (Object.values(store().data.projects).some((p) => p.ownerId === source.ownerId && p.name === candidate)) {
    candidate = `${newName} (${n++})`;
  }
  return createProject({
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
    const parsed = JSON.parse(readFileSync(join(projectHome(project), ".pi", "sandbox-platform.json"), "utf8")) as Partial<ProjectSandboxConfig>;
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
  writeFileSync(path, JSON.stringify({ ...current, ...patch, disableLocalFallback: true }, null, 2), "utf8");
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

/** Symlink the sandbox extension into the project home's .pi/extensions/.
 *  The SDK's normal extension discovery scans this directory for ANY session
 *  created with this cwd — including subagents, restored sessions, plan mode.
 *  Uses a symlink so extension code updates propagate automatically; falls
 *  back to a copy on systems where symlinks need elevated privileges. */
export function ensureSandboxExtensionLink(home: string): void {
  const extPath = process.env.PI_WEB_SANDBOX_EXTENSION_PATH;
  if (!extPath || !existsSync(extPath)) return;
  const extDir = join(home, ".pi", "extensions");
  const linkPath = join(extDir, "pi-sandbox-extension");
  if (existsSync(linkPath)) return;
  try {
    mkdirSync(extDir, { recursive: true });
    symlinkSync(extPath, linkPath, "junction");
  } catch {
    try {
      cpSync(extPath, linkPath, { recursive: true });
    } catch {
      // Extension won't auto-discover; session-level additionalExtensionPaths
      // injection in /api/agent/new remains as a fallback for this project.
    }
  }
}
