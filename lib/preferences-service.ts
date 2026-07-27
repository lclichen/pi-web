import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "@/lib/atomic-write";
import { DEFAULT_PREFERENCES, type WebPreferences } from "@/lib/api-types";

const PREFS_FILE = "web-preferences.json";

export function prefsPath(cwd: string): string {
  return join(cwd, ".pi", PREFS_FILE);
}

export function readPreferences(cwd: string): WebPreferences {
  const path = prefsPath(cwd);
  if (!existsSync(path)) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<WebPreferences>;
    return {
      mcpEnabled: raw.mcpEnabled ?? DEFAULT_PREFERENCES.mcpEnabled,
      subagentsEnabled: raw.subagentsEnabled ?? DEFAULT_PREFERENCES.subagentsEnabled,
      labVerifyEnabled: raw.labVerifyEnabled ?? DEFAULT_PREFERENCES.labVerifyEnabled,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writePreferences(cwd: string, prefs: WebPreferences): void {
  atomicWriteFile(prefsPath(cwd), `${JSON.stringify(prefs, null, 2)}\n`);
}
