/**
 * Quick-session workspace detection, dependency-free on purpose: the project
 * trust check (lib/project-trust.ts) is imported by plain `node --test` files
 * and must not pull in the quick-session/template engine.
 *
 * Quick workspaces live under <dataDir>/quick-homes/u<id>/… and are generated
 * by pi-web from admin-managed templates. Their .pi/mcp.json and template
 * snapshot are framework configuration, not user-supplied project resources,
 * so they must not trigger the project-trust gate ("受限模式") — every quick
 * session would otherwise be gated by its own generated files.
 */
import { join, resolve, sep } from "node:path";

function dataDirRoot(): string {
  return process.env.PI_WEB_DATA_DIR ? process.env.PI_WEB_DATA_DIR : join(process.cwd(), "data");
}

/** Is `cwd` inside the server-controlled quick-homes tree? */
export function isQuickWorkspaceDir(cwd: string): boolean {
  if (!cwd) return false;
  const root = resolve(join(dataDirRoot(), "quick-homes"));
  const target = resolve(cwd);
  if (target === root) return false; // the shared home itself is not a workspace
  return target.startsWith(root + sep);
}
