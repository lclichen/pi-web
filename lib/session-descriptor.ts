/**
 * Canonical description of a session's management origin, project binding,
 * execution backend and workspace kind.
 *
 * The legacy `mode` string conflated several axes:
 *
 *   host          = external workspace + local execution
 *   quick         = scratch workspace + local execution + quick profile
 *   sandbox       = managed project + sandbox execution
 *   local-machine = managed project + relay execution
 *   ssh           = managed project + ssh execution
 *
 * New code resolves a descriptor once and derives the legacy mode for
 * compatibility with existing UI/API consumers.
 */
import { getProject, type ProjectRecord } from "./projects";
import type { SessionMeta } from "./session-metas";
import type { SessionMode } from "./session-modes";

export type SessionManagement = "webui" | "cli";
export type ExecutionBackend = "local" | "sandbox" | "relay" | "ssh";
export type WorkspaceKind = "managed-home" | "external-dir" | "scratch";
export type SessionProfile = "quick";

export interface SessionDescriptor {
  /** Was the session created by the WebUI, or discovered/created by the CLI? */
  management: SessionManagement;
  /** Managed project binding; absent for external Host and Quick sessions. */
  projectId?: string;
  execution: ExecutionBackend;
  workspace: WorkspaceKind;
  profile?: SessionProfile;
  ownerId: number;
  /** Server-side session cwd (the SDK session's working directory). */
  cwd?: string;
  /** Real workspace path for prompts/tools (remote workdir); cwd may be a stub home. */
  workspaceRoot?: string;
  templateId?: string;
  quickDir?: string;
}

const EXECUTIONS = new Set<ExecutionBackend>(["local", "sandbox", "relay", "ssh"]);
const WORKSPACES = new Set<WorkspaceKind>(["managed-home", "external-dir", "scratch"]);

export function executionForMode(mode: SessionMode): ExecutionBackend {
  if (mode === "sandbox") return "sandbox";
  if (mode === "local-machine") return "relay";
  if (mode === "ssh") return "ssh";
  return "local";
}

export function descriptorToLegacyMode(descriptor: Pick<SessionDescriptor, "execution" | "profile">): SessionMode {
  if (descriptor.profile === "quick") return "quick";
  if (descriptor.execution === "sandbox") return "sandbox";
  if (descriptor.execution === "relay") return "local-machine";
  if (descriptor.execution === "ssh") return "ssh";
  return "host";
}

export function isSessionDescriptor(value: unknown): value is SessionDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.management === "webui" || record.management === "cli") &&
    (record.execution === "local" ||
      record.execution === "sandbox" ||
      record.execution === "relay" ||
      record.execution === "ssh") &&
    (record.workspace === "managed-home" ||
      record.workspace === "external-dir" ||
      record.workspace === "scratch") &&
    typeof record.ownerId === "number" &&
    Number.isInteger(record.ownerId) &&
    record.ownerId >= 0
  );
}

export function descriptorForProject(
  project: ProjectRecord,
  ownerId: number,
  cwd?: string,
  workspaceRoot?: string,
): SessionDescriptor {
  const projectMode = project.mode as SessionMode;
  const profile = projectMode === "quick" ? "quick" : undefined;
  const execution = projectMode === "quick" ? "local" : executionForMode(projectMode);
  const workspace: WorkspaceKind =
    profile === "quick" ? "scratch" : projectMode === "host" ? "external-dir" : "managed-home";
  const root = workspaceRoot ?? project.workdir ?? project.workspaceRoot;
  return {
    management: "webui",
    projectId: project.id,
    execution,
    workspace,
    ...(profile ? { profile } : {}),
    ownerId,
    ...(cwd ? { cwd } : {}),
    ...(root ? { workspaceRoot: root } : {}),
  };
}

export interface NewSessionDescriptorInput {
  management?: SessionManagement;
  projectId?: string;
  mode: SessionMode;
  ownerId: number;
  cwd?: string;
  workspaceRoot?: string;
  templateId?: string;
  quickDir?: string;
}

/** Build a descriptor for a session being created. */
export function descriptorForNewSession(input: NewSessionDescriptorInput): SessionDescriptor {
  const profile = input.mode === "quick" ? "quick" : undefined;
  const workspace: WorkspaceKind =
    profile === "quick"
      ? "scratch"
      : input.projectId
        ? "managed-home"
        : input.mode === "host"
          ? "external-dir"
          : "managed-home";
  return {
    management: input.management ?? "webui",
    ...(input.projectId ? { projectId: input.projectId } : {}),
    execution: executionForMode(input.mode),
    workspace,
    ...(profile ? { profile } : {}),
    ownerId: input.ownerId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.quickDir ? { quickDir: input.quickDir } : {}),
  };
}

/**
 * Infer a descriptor for a legacy session meta. Returns null when the meta
 * cannot represent a safe execution (currently SSH without a project).
 */
export function inferDescriptorFromMeta(meta: SessionMeta): SessionDescriptor | null {
  const project = meta.projectId ? getProject(meta.projectId) : undefined;
  const mode = project?.mode ?? meta.mode;
  if (mode === "ssh" && !meta.projectId) return null;
  const profile = mode === "quick" ? "quick" : undefined;
  const workspace: WorkspaceKind =
    profile === "quick"
      ? "scratch"
      : mode === "host"
        ? "external-dir"
        : meta.projectId
          ? "managed-home"
          : "managed-home";
  return {
    management: meta.projectId ? "webui" : mode === "host" ? "cli" : "webui",
    ...(meta.projectId ? { projectId: meta.projectId } : {}),
    execution: executionForMode(mode),
    workspace,
    ...(profile ? { profile } : {}),
    ownerId: meta.ownerId,
    ...(meta.templateId ? { templateId: meta.templateId } : {}),
    ...(meta.quickDir ? { quickDir: meta.quickDir } : {}),
  };
}

/** Prefer the persisted descriptor, then infer from legacy fields. */
export function descriptorFromMeta(meta: SessionMeta | undefined): SessionDescriptor | null {
  if (!meta) return null;
  if (isSessionDescriptor(meta.descriptor)) return meta.descriptor;
  return inferDescriptorFromMeta(meta);
}

export function descriptorContainsExecution(
  descriptor: SessionDescriptor | null | undefined,
): descriptor is SessionDescriptor {
  return Boolean(descriptor && EXECUTIONS.has(descriptor.execution) && WORKSPACES.has(descriptor.workspace));
}
