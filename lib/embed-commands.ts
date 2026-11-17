/**
 * Command-name helpers shared by the embed page (client) and the API fence.
 * Pure by design: no node imports, safe in the browser bundle.
 */

/** Built-in composer commands (without the leading slash). */
export const EMBED_BUILTIN_COMMANDS = ["compact", "reload", "name", "session", "copy", "clone"] as const;

/** Normalize a product allowlist entry or a registered command name. */
export function normalizeEmbedCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

/** Does a product allowlist permit `name`? A null/undefined allowlist means all. */
export function isEmbedCommandAllowed(
  allowed: readonly string[] | null | undefined,
  name: string,
): boolean {
  if (!allowed) return true;
  const target = normalizeEmbedCommandName(name);
  if (!target) return false;
  return allowed.some((entry) => {
    const normalized = normalizeEmbedCommandName(entry);
    return normalized === "*" || normalized === target;
  });
}

/**
 * Extract a slash-command name from composer text.
 *
 * `/usr/bin` and other slash-prefixed paths deliberately do not match: a
 * command token cannot contain another slash. Callers still probe the
 * session's registered commands before treating a match as a command.
 */
export function slashCommandNameFromText(text: string): string | null {
  const match = text.trim().match(/^\/([^\s/]+)(?:\s|$)/);
  return match ? match[1] : null;
}
