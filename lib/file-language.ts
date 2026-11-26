/**
 * File extension → viewer language id (shared by /api/files and /api/remotefs).
 *
 * The FileViewer switches to markdown/HTML preview on `language`, so the
 * REMOTE file API must classify files exactly like the local one — it used to
 * hardcode "text", which silently disabled markdown preview in sandbox /
 * local-machine / ssh sessions.
 *
 * Pure — no node built-ins — so client code may import it too.
 */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", php: "php", lua: "lua", pl: "perl", r: "r",
  go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  scala: "scala", groovy: "groovy", gradle: "groovy", dart: "dart", zig: "zig",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp", mm: "objectivec",
  ex: "elixir", exs: "elixir", hs: "haskell", ml: "ocaml", clj: "clojure", nix: "nix",
  html: "html", htm: "html", vue: "markup", svelte: "markup", astro: "markup",
  css: "css", scss: "scss", less: "less",
  json: "json", jsonl: "json", csv: "csv", tsv: "tsv", yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "ini", cfg: "ini", properties: "properties",
  xml: "xml", md: "markdown", mdx: "markdown", tex: "latex",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  ps1: "powershell", psm1: "powershell", bat: "batch", cmd: "batch",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl", diff: "diff", patch: "diff",
  env: "bash", gitignore: "bash", txt: "text",
  // Streamed by ?type=read, never shown as source.
  pdf: "pdf", docx: "word",
};

/** Basename without relying on node:path (separator-agnostic). */
function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

export function detectFileLanguage(filePath: string): string {
  const base = basename(filePath).toLowerCase();
  // Special full-name matches
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}
