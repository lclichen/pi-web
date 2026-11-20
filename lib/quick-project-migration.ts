import { getSessionMetas, recordSessionMeta } from "./session-metas";
import { descriptorFromMeta } from "./session-descriptor";
import { ensureQuickProject, findQuickProject } from "./projects";
import { getQuickTemplate } from "./quick-templates";

/**
 * Lazily link pre-Quick-Project sessions to their stable (owner, template)
 * project. Called from the session list once per process; subsequent list
 * calls see projectId and skip the work.
 */
export async function migrateQuickSessionMetas(ownerId: number): Promise<boolean> {
  const metas = getSessionMetas();
  let changed = false;
  for (const [sessionId, meta] of Object.entries(metas)) {
    if (meta.mode !== "quick" || meta.projectId || meta.ownerId !== ownerId) continue;
    const templateId = meta.templateId;
    if (!templateId) continue;
    let project = findQuickProject(ownerId, templateId);
    if (!project) {
      const template = getQuickTemplate(templateId);
      if (!template) continue;
      project = await ensureQuickProject(ownerId, meta.ownerName, template);
    }
    const descriptor = meta.descriptor ?? descriptorFromMeta(meta);
    recordSessionMeta(sessionId, {
      ...meta,
      projectId: project.id,
      ...(descriptor ? { descriptor: { ...descriptor, projectId: project.id } } : {}),
    });
    changed = true;
  }
  return changed;
}
