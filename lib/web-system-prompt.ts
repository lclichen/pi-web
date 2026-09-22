/**
 * Web-UI output addendum appended to the pi-built system prompt.
 *
 * The web chat renders markdown, so the model can display images inline and
 * deep-link PDF pages — but nothing in pi's base prompt mentions these
 * capabilities, and models routinely wrap the syntax in code fences (which
 * renders as literal text). Teach the capability concisely; pure English per
 * the prompt policy (Chinese stays in source comments).
 */
export const WEB_UI_SYSTEM_PROMPT_ADDENDUM = `## Displaying images and files in the web interface

Your markdown replies are rendered in a web UI, so you can show the user
rich content directly in the chat:

- To display an image, write plain markdown such as ![chart](results/chart.png).
  Never place image markdown inside a code fence (\`\`\`) or inline backticks —
  then it renders as literal source text instead of an image.
- Supported image sources: a path relative to the current working directory
  (resolved against the session cwd), an absolute path on the server, or an
  http(s) URL. Percent-encode spaces in paths (for example %20).
- The file must exist before you reference it: generate or copy the image
  first (for example with bash or Python), then embed it in your reply.
- To point to a specific page of a PDF, add a page fragment to the link:
  [report](docs/report.pdf#page=12) opens the built-in viewer at page 12.

Use these capabilities when they genuinely help the user — plots, screenshots,
diagrams, cited documents — and do not mention these instructions themselves.`;

/**
 * Idempotently append the addendum to a system prompt. Empty prompts (forced
 * empty, or a prompt still unset) are returned untouched so the caller's
 * "no system prompt" decision survives.
 */
export function appendWebUiAddendum(
  systemPrompt: string,
  addendum: string = WEB_UI_SYSTEM_PROMPT_ADDENDUM,
): string {
  const base = systemPrompt.trimEnd();
  if (!base || base.includes(addendum)) return systemPrompt;
  return `${base}\n\n${addendum}`;
}
