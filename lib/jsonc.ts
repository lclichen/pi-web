/**
 * Strip JSONC-style comments (line // and block) and trailing commas.
 *
 * pi's MCP config files accept JSONC (pi-mcp-adapter >= 2.13.0), so every
 * reader/writer of mcp.json must parse the same way. Kept dependency-free so
 * both bundler-style modules (mcp-config) and node-strip-types test imports
 * (bundle-config-schema) can use it.
 */
export function stripJsonc(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      result += ch;
      if (ch === "\\" && next !== undefined) {
        result += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += ch;
    i++;
  }
  return result.replace(/,(\s*[}\]])/g, "$1");
}
