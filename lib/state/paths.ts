/**
 * Canonical paths for pi-web runtime state.
 *
 * Small JSON metadata lives under <dataDir>/state so it has one layout,
 * one schema envelope and one migration story:
 *
 *   state/global/<name>.json
 *   state/users/u<id>/<name>.json
 *   state/projects/<projectId>/<name>.json
 *
 * Large/runtime assets (sessions JSONL, images, attachments, bundle archives,
 * workspace homes) intentionally stay where they are. `dataDir()` remains the
 * single root resolver (lib/mode-homes.ts).
 */
import { join } from "node:path";
import { dataDir } from "../mode-homes.ts";

export type StateScope =
  | { kind: "global" }
  | { kind: "user"; userId: number }
  | { kind: "project"; projectId: string };

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROJECT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid state store name: ${name}`);
}

/** Directory that owns one scope's state files. */
export function stateDir(scope: StateScope): string {
  if (scope.kind === "global") return join(dataDir(), "state", "global");
  if (scope.kind === "user") {
    if (!Number.isInteger(scope.userId) || scope.userId < 0) {
      throw new Error(`Invalid state user id: ${String(scope.userId)}`);
    }
    return join(dataDir(), "state", "users", `u${scope.userId}`);
  }
  if (!PROJECT_PATTERN.test(scope.projectId)) {
    throw new Error(`Invalid state project id: ${scope.projectId}`);
  }
  return join(dataDir(), "state", "projects", scope.projectId);
}

export function statePath(scope: StateScope, name: string): string {
  assertName(name);
  return join(stateDir(scope), `${name}.json`);
}

/** Lock target path (proper-lockfile appends `.lock`). Never user-controlled. */
export function stateLockPath(scope: StateScope, name: string): string {
  assertName(name);
  const scopeKey =
    scope.kind === "global"
      ? "global"
      : scope.kind === "user"
        ? join("users", `u${scope.userId}`)
        : join("projects", scope.projectId);
  return join(dataDir(), "locks", "state", scopeKey, name);
}

/** Legacy data-dir path used only for read-once migration. */
export function legacyDataPath(...parts: string[]): string {
  return join(dataDir(), ...parts);
}
