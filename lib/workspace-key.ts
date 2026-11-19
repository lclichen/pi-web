import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { projectHome, readProjectSandboxConfig, type ProjectRecord } from "./projects";
import { readSshConfig } from "./ssh";

/**
 * Stable identity of a project's active workspace.
 *
 * v1 assumes one active workspace per project (workdir/machine/container).
 * Changing any of them changes the key: preview tokens and projection
 * manifests must not be reused across a different workspace.
 */
export interface WorkspaceIdentity {
  key: string;
  mode: ProjectRecord["mode"];
  root: string;
  backend: string;
}

function lexicalRoot(root: string | undefined | null): string {
  const value = (root ?? "").trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return value || "/";
}

/**
 * Canonical root for host/ssh workspaces: prefer the local realpath so one
 * physical directory (through symlinks / drive substitutions / case drift)
 * maps to one key; fall back to lexical normalization when the path is not
 * locally resolvable (remote paths, missing mounts).
 */
function canonicalRoot(root: string | undefined | null): string {
  const lexical = lexicalRoot(root);
  if (!isAbsolute(lexical)) return lexical;
  try {
    return lexicalRoot(realpathSync(lexical));
  } catch {
    return lexical;
  }
}

/**
 * Platform identity for sandbox backends (PI_WEB_PLATFORM_URL). Same
 * deployment → same identity; different deployments (origin differs) →
 * different keys, so a container id is never confused across platforms.
 */
function platformBackendIdentity(): string {
  const raw = process.env.PI_WEB_PLATFORM_URL?.trim().replace(/\/+$/, "");
  if (!raw) return "platform:unconfigured";
  try {
    return `platform:${new URL(raw).origin}`;
  } catch {
    return `platform:${raw}`;
  }
}

export function resolveWorkspaceIdentity(project: ProjectRecord): WorkspaceIdentity {
  if (project.mode === "sandbox") {
    const containerId = Number(readProjectSandboxConfig(project).containerId) || Number(project.containerId) || 0;
    return {
      mode: project.mode,
      root: "/workspace",
      backend: `${platformBackendIdentity()}#container:${containerId || "auto"}`,
      key: "",
    };
  }
  if (project.mode === "ssh") {
    const config = readSshConfig(projectHome(project));
    const host = config ? `${config.host}:${config.port ?? 22}` : "ssh:unconfigured";
    return {
      mode: project.mode,
      root: canonicalRoot(project.workdir ?? "/"),
      backend: host,
      key: "",
    };
  }
  return {
    mode: project.mode,
    root: canonicalRoot(project.workdir ?? ""),
    backend: `machine:${project.machineId ?? "default"}`,
    key: "",
  };
}

/** Hash the identity into a filesystem-safe key (32 hex chars). */
export function workspaceKeyFor(project: ProjectRecord): string {
  const identity = resolveWorkspaceIdentity(project);
  const key = createHash("sha256")
    .update(`${identity.mode}\n${identity.root}\n${identity.backend}`)
    .digest("hex")
    .slice(0, 32);
  return key;
}

/** Debug/response helper: identity + key in one object. */
export function workspaceDescriptor(project: ProjectRecord): WorkspaceIdentity & { key: string } {
  const identity = resolveWorkspaceIdentity(project);
  return { ...identity, key: workspaceKeyFor(project) };
}
