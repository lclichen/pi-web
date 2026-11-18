import { createHash } from "node:crypto";
import {
  createProject,
  ensureProjectHome,
  findEmbedProject,
  getOwnedProject,
  getProject,
  listProjects,
  projectHome,
  setProjectEmbed,
  type ProjectRecord,
} from "./projects.ts";
import { getBundleInfo, applyBundleToDirectory } from "./config-bundles-store.ts";
import { markProjectionDirty } from "./projection/reconcile.ts";
import { validateAgentDirectory } from "./relay/browse.ts";
import { requireCompatibleAgent } from "./relay/agent-gate.ts";
import { createEmbedAccessToken } from "./embed-access.ts";
import type {
  EmbedMode,
  EmbedProductProfile,
  EmbedProjectBinding,
  EmbedProjectView,
  EmbedUser,
} from "./embed-types.ts";

/** Product project lifecycle: stable project ids, reuse, config bundle, open. */
export class EmbedWorkspaceError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "EmbedWorkspaceError";
    this.status = status;
    this.code = code;
  }
}

const CLIENT_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MACHINE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function normalizeKey(value: unknown, fallback = "default"): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;
  if (!CLIENT_ID_RE.test(raw)) throw new EmbedWorkspaceError("clientId/externalRef contains invalid characters");
  return raw;
}

function projectNameFor(product: EmbedProductProfile, user: EmbedUser, clientId: string): string {
  const base = `${product.name} · ${user.username}` + (clientId === "default" ? "" : ` · ${clientId}`);
  return base.slice(0, 64);
}

function uniqueProjectName(base: string, ownerId: number, externalRef: string): string {
  const existing = new Set(listProjects(ownerId).map((project) => project.name));
  if (!existing.has(base)) return base;
  const suffix = externalRef === "default" ? "" : ` · ${externalRef}`;
  const candidate = `${base}${suffix}`.slice(0, 64);
  if (!existing.has(candidate)) return candidate;
  for (let i = 2; i < 100; i += 1) {
    const next = `${base}${suffix} (${i})`.slice(0, 64);
    if (!existing.has(next)) return next;
  }
  return `${base.slice(0, 55)}-${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 8)}`;
}

export function embedConfigUpdateAvailable(
  project: ProjectRecord,
  product: EmbedProductProfile,
): boolean {
  const bundleName = product.configBundle;
  if (!bundleName) return false;
  const info = getBundleInfo(bundleName);
  if (!info) return false;
  const binding = project.embed;
  if (!binding) return true;
  return (
    binding.bundleName !== bundleName ||
    binding.bundleVersion !== info.version ||
    binding.bundleSha256 !== info.sha256
  );
}

export function embedProjectView(project: ProjectRecord, product: EmbedProductProfile): EmbedProjectView {
  const binding = project.embed!;
  return {
    id: project.id,
    name: project.name,
    mode: project.mode,
    clientId: binding.clientId,
    externalRef: binding.externalRef,
    bundleName: binding.bundleName ?? null,
    bundleVersion: binding.bundleVersion ?? null,
    configUpdateAvailable: embedConfigUpdateAvailable(project, product),
    createdAt: project.createdAt,
  };
}

export interface CreateEmbedProjectInput {
  product: EmbedProductProfile;
  user: EmbedUser;
  apiKey: string;
  body: {
    projectId?: unknown;
    clientId?: unknown;
    externalRef?: unknown;
    name?: unknown;
    mode?: unknown;
    machineId?: unknown;
    workdir?: unknown;
    ssh?: unknown;
    applyConfig?: unknown;
  };
}

async function applyProductBundle(project: ProjectRecord, product: EmbedProductProfile): Promise<EmbedProjectBinding | null> {
  const bundleName = product.configBundle;
  if (!bundleName) return null;
  const info = getBundleInfo(bundleName);
  if (!info) throw new EmbedWorkspaceError(`产品配置包不存在：${bundleName}`, 400);
  await applyBundleToDirectory(bundleName, ensureProjectHome(project));
  markProjectionDirty(project.id);
  return {
    productId: product.id,
    clientId: project.embed?.clientId ?? "default",
    externalRef: project.embed?.externalRef ?? "default",
    bundleName,
    bundleVersion: info.version,
    bundleSha256: info.sha256,
    createdAt: project.embed?.createdAt ?? Date.now(),
  };
}

export async function createOrReuseEmbedProject(
  input: CreateEmbedProjectInput,
): Promise<{ project: ProjectRecord; reused: boolean; binding: EmbedProjectBinding }> {
  const { product, user } = input;
  const clientId = normalizeKey(input.body.clientId);
  const externalRef = normalizeKey(input.body.externalRef);

  // Bind an existing owned project (product switch / migration path).
  if (typeof input.body.projectId === "string" && input.body.projectId.trim()) {
    const project = getOwnedProject(input.body.projectId.trim(), user.id, false);
    if (!project) throw new EmbedWorkspaceError("项目不存在", 404);
    if (project.embed && project.embed.productId !== product.id) {
      throw new EmbedWorkspaceError("项目已绑定其他产品", 409);
    }
    const binding: EmbedProjectBinding = {
      productId: product.id,
      clientId,
      externalRef,
      createdAt: project.embed?.createdAt ?? Date.now(),
    };
    setProjectEmbed(project.id, binding);
    const withBinding = getProject(project.id)!;
    if (product.configBundle && input.body.applyConfig !== false) {
      const updated = await applyProductBundle(withBinding, product);
      if (updated) setProjectEmbed(project.id, updated);
    }
    const final = getProject(project.id)!;
    return { project: final, reused: true, binding: final.embed! };
  }

  const existing = findEmbedProject(product.id, user.id, clientId, externalRef);
  if (existing) {
    return { project: existing, reused: true, binding: existing.embed! };
  }

  const rawMode = typeof input.body.mode === "string" ? input.body.mode : "";
  const mode = (rawMode || product.defaultMode || "local-machine") as EmbedMode;
  if (mode !== "local-machine" && mode !== "sandbox" && mode !== "ssh") {
    throw new EmbedWorkspaceError(`Unsupported project mode: ${mode}`);
  }

  const machineId =
    typeof input.body.machineId === "string" && input.body.machineId.trim()
      ? input.body.machineId.trim()
      : undefined;
  if (machineId && !MACHINE_ID_RE.test(machineId)) {
    throw new EmbedWorkspaceError("machineId format is invalid");
  }
  let workdir = typeof input.body.workdir === "string" ? input.body.workdir.trim() : "";

  if (mode === "local-machine") {
    const gate = requireCompatibleAgent(user.id, machineId);
    if (!gate.ok) {
      throw new EmbedWorkspaceError(gate.error, gate.status === 503 ? 503 : gate.status, "agent_offline");
    }
    if (workdir) {
      try {
        workdir = await validateAgentDirectory(user.id, machineId, workdir);
      } catch (error) {
        throw new EmbedWorkspaceError(
          `工作目录不可用：${error instanceof Error ? error.message : String(error)}`,
          400,
        );
      }
    }
  }

  const bundleInfo = product.configBundle ? getBundleInfo(product.configBundle) : null;
  if (product.configBundle && !bundleInfo) {
    throw new EmbedWorkspaceError(`产品配置包不存在：${product.configBundle}`, 400);
  }

  const baseName =
    typeof input.body.name === "string" && input.body.name.trim()
      ? input.body.name.trim().slice(0, 64)
      : projectNameFor(product, user, clientId);
  const name = uniqueProjectName(baseName, user.id, externalRef);

  const binding: EmbedProjectBinding = {
    productId: product.id,
    clientId,
    externalRef,
    ...(bundleInfo
      ? {
          bundleName: product.configBundle!,
          bundleVersion: bundleInfo.version,
          bundleSha256: bundleInfo.sha256,
        }
      : {}),
    createdAt: Date.now(),
  };

  const result = await createProject({
    name,
    ownerId: user.id,
    ownerName: user.username,
    mode,
    ...(workdir ? { workdir } : {}),
    ...(machineId ? { machineId } : {}),
    ...(mode === "ssh" && input.body.ssh ? { ssh: input.body.ssh as never } : {}),
    ...(product.configBundle ? { presetBundle: product.configBundle } : {}),
    embed: binding,
  });
  if (!result.ok) throw new EmbedWorkspaceError(result.error);

  // createProject applies presetBundle before persist; the binding is already
  // written. Keep projection cache honest for config projections.
  markProjectionDirty(result.project.id);
  return { project: result.project, reused: false, binding: { ...binding } };
}

export function listEmbedProjects(
  productId: string,
  userId: number,
  clientId?: string,
): ProjectRecord[] {
  return listProjects(userId).filter(
    (project) =>
      project.embed?.productId === productId &&
      (!clientId || project.embed.clientId === clientId),
  );
}

export function getBoundEmbedProject(
  projectId: string,
  productId: string,
  userId: number,
): ProjectRecord {
  const project = getProject(projectId);
  if (!project || project.ownerId !== userId || !project.embed || project.embed.productId !== productId) {
    throw new EmbedWorkspaceError("项目不存在", 404);
  }
  return project;
}

/** Issue a short-lived access token for a bound project. */
export function openEmbedProject(
  project: ProjectRecord,
  product: EmbedProductProfile,
  user: EmbedUser,
  apiKey: string,
): { token: string; expiresAt: number } {
  const binding = project.embed;
  if (!binding || binding.productId !== product.id) throw new EmbedWorkspaceError("项目不存在", 404);
  const access = createEmbedAccessToken({
    user,
    apiKey,
    productId: product.id,
    scope: {
      kind: "project",
      projectId: project.id,
      cwd: projectHome(project),
    },
    allowedRoots: [projectHome(project)],
    mode: project.mode,
    label: project.name,
  });
  return { token: access.token, expiresAt: access.record.expiresAt };
}

export async function reapplyEmbedConfig(
  project: ProjectRecord,
  product: EmbedProductProfile,
): Promise<EmbedProjectView> {
  if (!product.configBundle) throw new EmbedWorkspaceError("产品未绑定配置包");
  const info = getBundleInfo(product.configBundle);
  if (!info) throw new EmbedWorkspaceError(`产品配置包不存在：${product.configBundle}`);
  await applyBundleToDirectory(product.configBundle, ensureProjectHome(project));
  markProjectionDirty(project.id);
  const binding: EmbedProjectBinding = {
    productId: product.id,
    clientId: project.embed?.clientId ?? "default",
    externalRef: project.embed?.externalRef ?? "default",
    bundleName: product.configBundle,
    bundleVersion: info.version,
    bundleSha256: info.sha256,
    createdAt: project.embed?.createdAt ?? Date.now(),
  };
  setProjectEmbed(project.id, binding);
  return embedProjectView({ ...project, embed: binding }, product);
}
