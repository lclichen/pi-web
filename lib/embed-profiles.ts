import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./mode-homes.ts";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { normalizeEmbedCommandName } from "./embed-commands.ts";
import type { EmbedProductProfile } from "./embed-types.ts";

/**
 * Product profiles for embeddable sessions:
 *   <dataDir>/embed-profiles.json
 *
 * A token binds one product profile; the profile decides which slash commands
 * are visible/allowed and which parent origins may frame the page. Profiles are
 * admin-managed through /api/admin/embed-profiles and apply immediately.
 */

const FILE_NAME = "embed-profiles.json";
const MAX_PRODUCTS = 50;
const MAX_COMMANDS = 200;
const MAX_ORIGINS = 20;
const MAX_NAME_LENGTH = 80;

export const DEFAULT_EMBED_PROFILE: EmbedProductProfile = {
  id: "default",
  name: "Default",
  allowedCommands: ["compact", "reload", "name", "copy", "clone"],
  allowedOrigins: [],
  enabled: true,
};

interface ProfileFile {
  version: 1;
  products: EmbedProductProfile[];
}

interface ProfileStore {
  path: string;
  mtime: number;
  lastStatAt: number;
  products: EmbedProductProfile[];
}

declare global {
   
  var __piEmbedProfiles: ProfileStore | undefined;
}

function filePath(): string {
  return join(dataDir(), FILE_NAME);
}

function cloneProfile(profile: EmbedProductProfile): EmbedProductProfile {
  return {
    ...profile,
    allowedCommands: [...profile.allowedCommands],
    allowedOrigins: [...profile.allowedOrigins],
  };
}

function readStore(): ProfileStore {
  const path = filePath();
  const now = Date.now();
  const cached = globalThis.__piEmbedProfiles;
  if (cached && cached.path === path && now - cached.lastStatAt < 100) return cached;

  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // Missing file: fall back to the built-in profile (not persisted).
  }
  if (cached && cached.path === path && cached.mtime === mtime) {
    cached.lastStatAt = now;
    return cached;
  }

  let products: EmbedProductProfile[] = [cloneProfile(DEFAULT_EMBED_PROFILE)];
  if (mtime > 0) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProfileFile>;
      if (Array.isArray(parsed.products)) products = validateEmbedProfiles(parsed.products);
    } catch {
      // A malformed store must not brick token auth; the default is safe.
      products = [cloneProfile(DEFAULT_EMBED_PROFILE)];
    }
  }

  const next: ProfileStore = { path, mtime, lastStatAt: now, products };
  globalThis.__piEmbedProfiles = next;
  return next;
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`Invalid origin: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http/https origins are allowed: ${value}`);
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`Origin must not include a path, query, or credentials: ${value}`);
  }
  return parsed.origin;
}

/** Validate and normalize admin-supplied profiles (throws on invalid input). */
export function validateEmbedProfiles(input: unknown): EmbedProductProfile[] {
  if (!Array.isArray(input)) throw new Error("products must be an array");
  if (input.length > MAX_PRODUCTS) throw new Error(`At most ${MAX_PRODUCTS} products are allowed`);

  const ids = new Set<string>();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Product #${index + 1} is invalid`);
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim().toLowerCase() : "";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      throw new Error(`Product #${index + 1}: id must match [a-z0-9][a-z0-9_-]{0,63}`);
    }
    if (ids.has(id)) throw new Error(`Duplicate product id: ${id}`);
    ids.add(id);

    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw new Error(`Product ${id}: name must be 1-${MAX_NAME_LENGTH} characters`);
    }

    const rawCommands = item.allowedCommands;
    if (!Array.isArray(rawCommands) || rawCommands.length > MAX_COMMANDS) {
      throw new Error(`Product ${id}: allowedCommands must be an array (max ${MAX_COMMANDS})`);
    }
    const allowedCommands: string[] = [];
    for (const entry of rawCommands) {
      if (typeof entry !== "string") throw new Error(`Product ${id}: command names must be strings`);
      const normalized = normalizeEmbedCommandName(entry);
      if (normalized === "*") {
        if (allowedCommands.length > 0) throw new Error(`Product ${id}: "*" cannot be combined with other commands`);
        allowedCommands.push("*");
        continue;
      }
      if (allowedCommands.includes("*")) {
        throw new Error(`Product ${id}: "*" cannot be combined with other commands`);
      }
      if (!/^[a-z0-9][a-z0-9_:.-]{0,127}$/.test(normalized)) {
        throw new Error(`Product ${id}: invalid command name "${entry}"`);
      }
      if (!allowedCommands.includes(normalized)) allowedCommands.push(normalized);
    }

    const rawOrigins = item.allowedOrigins;
    if (!Array.isArray(rawOrigins) || rawOrigins.length > MAX_ORIGINS) {
      throw new Error(`Product ${id}: allowedOrigins must be an array (max ${MAX_ORIGINS})`);
    }
    const allowedOrigins: string[] = [];
    for (const entry of rawOrigins) {
      if (typeof entry !== "string") throw new Error(`Product ${id}: origins must be strings`);
      const origin = normalizeOrigin(entry);
      if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
    }

    return {
      id,
      name,
      allowedCommands,
      allowedOrigins,
      enabled: item.enabled !== false,
    };
  });
}

export function listEmbedProfiles(): EmbedProductProfile[] {
  return readStore().products.map(cloneProfile);
}

export function getEmbedProfile(id: string): EmbedProductProfile | undefined {
  const profile = readStore().products.find((entry) => entry.id === id);
  return profile ? cloneProfile(profile) : undefined;
}

/** Replace the full profile list (admin API). */
export function saveEmbedProfiles(input: unknown): EmbedProductProfile[] {
  const products = validateEmbedProfiles(input);
  const path = filePath();
  writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, products }, null, 2));
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // The write above succeeded; a missing stat only disables cache freshness.
  }
  globalThis.__piEmbedProfiles = {
    path,
    mtime,
    lastStatAt: Date.now(),
    products: products.map(cloneProfile),
  };
  return products.map(cloneProfile);
}
