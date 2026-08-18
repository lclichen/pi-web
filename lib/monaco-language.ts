/**
 * Map the server-side language ids (app/api/files EXT_TO_LANGUAGE +
 * getLanguage special cases) to Monaco editor language ids. The two sets are
 * mostly identical by construction; only these differ:
 *  - "text" (server catch-all) is Monaco's "plaintext"
 *  - "bash" is Monaco's "shell" basic-language id
 * Anything unknown degrades to plaintext rather than erroring the editor.
 */
const LANGUAGE_MAP: Record<string, string> = {
  text: "plaintext",
  bash: "shell",
};

export function monacoLanguage(language: string | undefined): string {
  if (!language) return "plaintext";
  return LANGUAGE_MAP[language] ?? language;
}
