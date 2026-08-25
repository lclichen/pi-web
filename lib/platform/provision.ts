import { platformGet, platformPost } from "./client";

/**
 * Auto-provision a container for a freshly-created sandbox project.
 *
 * Rationale: the sandbox extension's CLI fallback auto-provisions a container
 * only when it has an image to use — with the demo images removed that path
 * fails silently and the project stays empty. pi-web provisions eagerly at
 * project creation so the failure surfaces immediately with a clear message,
 * and each project gets its own bound container:
 *
 *   1. a running container not bound to another project  → bind it
 *   2. a stopped container not bound to another project  → start it (restore)
 *   3. nothing free → create a new container from the first public image
 */

export type ProvisionStatus = "bound-running" | "restored" | "created";

export interface ProvisionResult {
  containerId: number;
  status: ProvisionStatus;
}

interface PlatformContainer {
  id: number;
  name: string;
  status: string;
  image_id: number;
}

interface PlatformImage {
  id: number;
  name: string;
}

/** Map a project name to a container name the platform schema accepts
 *  (letters, digits, `_ . space -` only, max 128). */
export function sanitizeContainerName(projectName: string): string {
  const cleaned = projectName
    .replace(/[^a-zA-Z0-9_.\s-]/g, "")
    .trim()
    .slice(0, 96);
  return cleaned || `pi-project-${Date.now().toString(36)}`;
}

export async function provisionContainerForProject(
  apiKey: string,
  projectName: string,
  excludedContainerIds: number[],
  opts?: { imageId?: number; workspaceId?: number },
): Promise<ProvisionResult> {
  const excluded = new Set(excludedContainerIds);
  const list = await platformGet<{ containers: PlatformContainer[] }>(
    "/api/v1/containers",
    apiKey,
    { filter: "all" },
  );
  let free = (list.containers ?? []).filter((c) => !excluded.has(c.id));
  // A chosen image constrains reuse: a free container built from a DIFFERENT
  // image must not be silently bound (the user picked the environment).
  if (opts?.imageId) {
    free = free.filter((c) => c.image_id === opts.imageId);
  }

  // 1. Reuse a running container (e.g. restored from a previous session).
  const running = free.find((c) => c.status === "running");
  if (running) return { containerId: running.id, status: "bound-running" };

  // 2. Restore (start) a stopped container.
  const stopped = free.find((c) => c.status === "stopped");
  if (stopped) {
    const started = await platformPost<{ id: number }>(
      `/api/v1/containers/${stopped.id}/start`,
      apiKey,
    );
    return { containerId: started.id, status: "restored" };
  }

  // 3. Create a fresh container — image chosen in the new-project dialog
  //    (falls back to the first public image), optionally seeding /workspace
  //    from the user's cloud workspace.
  const images = await platformGet<{ images: PlatformImage[] }>("/api/v1/images", apiKey);
  const image = opts?.imageId
    ? (images.images ?? []).find((i) => i.id === opts.imageId)
    : (images.images ?? [])[0];
  if (!image) {
    throw new Error("平台没有可用的镜像：请先在容器平台的 Admin 后台添加一个镜像（SIF），再重试创建沙箱项目");
  }
  const created = await platformPost<{ id: number }>("/api/v1/containers", apiKey, {
    imageId: image.id,
    name: sanitizeContainerName(projectName),
    ...(opts?.workspaceId ? { workspaceId: opts.workspaceId } : {}),
  });
  return { containerId: created.id, status: "created" };
}
