# Tools reference (full)

Register an LLM-callable tool with `pi.registerTool(def)` or
`pi.registerTool(defineTool(def))` — both equivalent. `defineTool` is from
`@earendil-works/pi-coding-agent`.

## Full definition shape

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "my_tool",                       // string
  label: "My Tool",                      // display label
  description: "What this tool does",    // shown to the LLM
  promptSnippet: "one-liner",            // optional; appears in "Available tools"
  promptGuidelines: ["Use my_tool when..."], // optional bullets in "Guidelines"; each MUST name the tool
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),   // StringEnum for ALL enums (Google compat)
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {               // optional compat shim; runs BEFORE schema validation
    // normalize legacy field names, etc.
    return args;
  },
  // executionMode: "sequential",        // 0.84: opt this tool out of parallel execution
  // constrainedSampling: false,         // 0.84: false = disable provider-side constrained sampling

  async execute(toolCallId, params, signal, onUpdate, ctx) {  // 5 args
    // signal: AbortSignal | undefined — check signal?.aborted
    // onUpdate?: (partial) => void — stream progress; partial = { content?, details? }
    if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
    onUpdate?.({ content: [{ type: "text", text: "Working..." }], details: { progress: 50 } });

    const result = await pi.exec("some-cmd", [], { signal });
    if (!result.stdout) throw new Error("empty output");   // throw → isError:true

    return {
      content: [{ type: "text", text: "done" }],  // sent to the LLM
      details: { data: result },                  // for rendering + state reconstruction
      // usage: nestedModelResponse.usage,        // optional: nested-LLM token usage
      // addedToolNames: ["derived_tool"],        // optional (0.84): tools this result introduces
      // terminate: true,                          // optional: skip follow-up LLM call
                                                  //   (only if ALL tools in the batch set it)
    };
  },

  // Optional custom TUI rendering:
  renderCall(args, theme, context) { /* return a TUI Component (e.g. new Text(...)) */ },
  renderResult(result, { expanded, isPartial }, theme, context) { /* ... */ },
  // renderShell: "self",  // tool renders its own shell (no default Box framing)
});
```

## `execute` return shape
- `content` — `Array<{type:"text", text}>` (sent to the LLM).
- `details` — any object (rendering + state reconstruction; persisted on the tool result).
- `usage` (optional) — `Usage` for nested LLM calls; persisted, shown in footer/`/session`/RPC totals; `tool_result` handlers can inspect/replace it.
- `addedToolNames` (optional, 0.84) — names of tools this result introduces; they become available from this transcript point onward.
- `terminate` (optional, boolean) — hint to skip the auto follow-up call. Only takes effect when **every** tool result in the current batch returns `terminate: true`.
- **`isError` is NOT a field** — errors are signaled only by throwing (see below).

## `executionMode` / `constrainedSampling` (0.84)
- `executionMode?: "sequential" | "parallel"` — per-tool override of the default
  execution mode. Use `"sequential"` for tools that must not interleave with
  other tool calls (global state, exclusive resources) instead of a global flag.
- `constrainedSampling?: false | ConstrainedSamplingConfig` — provider-side
  constrained sampling for this tool. `false` explicitly disables it (same as
  omitting); otherwise a `ConstrainedSamplingConfig` from `@earendil-works/pi-ai`.

## Errors: throw, don't return
Throwing → caught, reported to the LLM with `isError: true`, execution continues. A returned value never sets the error flag regardless of contents.
```typescript
async execute(_id, params) {
  if (!valid(params.input)) throw new Error(`Invalid input: ${params.input}`);
  return { content: [{ type: "text", text: "OK" }], details: {} };
}
```

## promptSnippet / promptGuidelines gotchas
- `promptSnippet`: one-line entry in `Available tools`. Omit to keep the tool out of that section.
- `promptGuidelines`: bullets appended **flat** to `Guidelines`, **no tool-name prefix or grouping**. Each bullet must name the tool ("Use my_tool when..."). Shown only while the tool is active.

## Path normalization
Some models prepend `@` to path args. Built-ins strip a leading `@`; do the same in custom tools.

## Truncation helpers (import from `@earendil-works/pi-coding-agent`)
- `truncateHead(output, { maxLines, maxBytes })` — keep first N (file reads, search).
- `truncateTail(...)` — keep last N (logs, command output).
- `truncateLine(line, maxBytes)` — truncate one line with ellipsis.
- `formatSize(bytes)` — human-readable ("50KB", "1.5MB").
- `DEFAULT_MAX_BYTES` = **50KB**, `DEFAULT_MAX_LINES` = **2000**.
- Result: `{ content, truncated, outputLines, totalLines, outputBytes, totalBytes }`.
- Always tell the LLM when truncated + where the full output is saved.

```typescript
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async execute(_id, params, _signal, _onUpdate, ctx) {
  const full = /* big output */;
  const t = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  let text = t.content;
  if (t.truncated) {
    const dir = await mkdtemp(join(tmpdir(), "mytool-"));
    const file = join(dir, "output.txt");
    await withFileMutationQueue(file, async () => { await writeFile(file, full); });
    text += `\n\n[Output truncated: ${t.outputLines}/${t.totalLines} lines. Full output: ${file}]`;
  }
  return { content: [{ type: "text", text }], details: { truncation: t, fullOutputPath: t.truncated ? file : undefined } };
}
```

## `withFileMutationQueue` — REQUIRED for file-mutating tools
Tool calls run in **parallel** by default. Wrap any read-modify-write of a file so it shares the per-file lock with built-in `edit`/`write`. Pass the **resolved absolute** path.

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

async execute(_id, params, _signal, _onUpdate, ctx) {
  const abs = resolve(ctx.cwd, params.path);
  return withFileMutationQueue(abs, async () => {
    const cur = await readFile(abs, "utf8");
    const next = cur.replace(params.old, params.new);
    await writeFile(abs, next, "utf8");
    return { content: [{ type: "text", text: `Updated ${params.path}` }], details: {} };
  });
}
```

## Dynamic tool loading (progressive disclosure)
Register every tool with `pi.registerTool()` (so it's in `pi.getAllTools()`); keep "loader" tools active and searchable tools inactive; add matching tools inside the loader's `execute`:

```typescript
// loader tool stays active all session
async execute(_id, params) {
  const matching = /* find tools whose description matches params.query */;
  // MUST be additive — don't remove currently-active tools in the same call
  pi.setActiveTools([...pi.getActiveTools(), ...matching.map(t => t.name)]);
  return { content: [{ type: "text", text: `Loaded: ${matching.map(t=>t.name).join(", ")}` }], details: {} };
}
```
- Names passed to `setActiveTools` must already be registered (unknown names ignored).
- Native deferred loading: Anthropic Sonnet/Opus/Fable 4.5+ (not Haiku); OpenAI gpt-5.4+. Enable on custom/proxy via `compat.supportsToolReferences: true` (anthropic-messages) or `compat.supportsToolSearch: true` (openai-responses/codex-responses).
- Lazily-loaded tools should usually OMIT `promptSnippet`/`promptGuidelines` (activating a tool with those rebuilds the system prompt → cache prefix invalidated even on deferred-schema providers).

## Overriding built-ins
Register a tool with the same `name` as a built-in: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Interactive mode shows a warning. `--no-builtin-tools` starts with none but keeps extension tools.
- **Rendering is per-slot; execution override and rendering override are independent.** Omit `renderCall`/`renderResult` to inherit the built-in renderer (syntax highlighting, diffs).
- **`promptSnippet`/`promptGuidelines` are NOT inherited** — define on the override.
- **Your implementation must match the exact result `details` shape** (`ReadToolDetails`, `BashToolDetails`, `GrepToolDetails`, `FindToolDetails`, `LsToolDetails`).

```typescript
pi.registerTool({
  name: "read",                       // override built-in "read"
  label: "read (audited)",
  description: "Read a file with access logging",
  parameters: readSchema,             // match the built-in schema
  async execute(_id, params, _s, _u, ctx) {
    const abs = resolve(ctx.cwd, params.path);
    await logAccess(abs);             // your audit
    // ... read + return matching ReadToolDetails ...
    return { content: [{ type: "text", text }], details: { lines: n } /* + shape built-in expects */ };
  },
  // no renderCall/renderResult → inherit built-in rendering
});
```

## Remote-execution tool factories
For routing tools to another machine (SSH, sandbox):
- Import `createReadTool`, `createBashTool`, `createEditTool`, `createWriteTool`, `createGrepTool`, `createFindTool`, `createLsTool`, `createCodingTools`, `createReadOnlyTools`.
- Operations interfaces: `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations`, `GrepOperations`, `FindOperations`.
- `BashOperations` is a single `exec(command, cwd, { onData(data: Buffer), signal?, timeout?, env? }) → Promise<{ exitCode: number | null }>` — stream output through `onData` as Buffers; resolve `exitCode: null` when killed/aborted.
- `createBashTool(cwd, { spawnHook: ({command, cwd, env}) => ({...}), exposeSessionEnvironment: false })` — spawn hook can rewrite command/cwd/env. Bash exposes session via env vars `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` (injected before spawnHook).
- `createLocalBashOperations()` — reuse pi's local shell backend (also used by `user_bash`).
- Pair the tool overrides with a `user_bash` handler (same `BashOperations`) so the
  user's `!`/`!!` commands reach the same remote machine — see events.md §User bash.

## Custom rendering
- `renderCall(args, theme, context)` — renders the tool call/header.
- `renderResult(result, { expanded, isPartial }, theme, context)` — renders result.
- `renderShell: "self"` — tool renders its own shell (own framing/padding/background).
- `context` object: `{ args, state (row-local across slots), lastComponent, invalidate(), toolCallId, cwd, executionStarted, argsComplete, isPartial, expanded, showImages, isError }`.
- Use `Text` with padding `(0, 0)`; default `Box` handles padding.
- Fallbacks: if a slot renderer is undefined or throws, `renderCall` → tool name; `renderResult` → raw text from `content`. If a slot has no content, return an empty `Component` (e.g. empty `Container`).
- Keybinding helpers: `keyHint(id, desc)`, `keyText(id)`, `rawKeyHint(key, desc)`. Namespaced ids: `app.*` (coding-agent), `tui.*` (shared TUI).

## Stateful tools — persistence pattern
Put the full new state in tool-result `details` every call; reconstruct on `session_start`/`session_tree`:

```typescript
let todos: Todo[] = []; let nextId = 1;
function reconstruct(ctx: ExtensionContext) {
  todos = []; nextId = 1;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role === "toolResult" && m.toolName === "todo") {
      const d = m.details as TodoDetails | undefined;
      if (d) { todos = d.todos; nextId = d.nextId; }
    }
  }
}
pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));
```
This makes branching/forking correct (each branch has its own state). For opaque
extension data not tied to a tool result, use `pi.appendEntry(customType, data)`
(see commands-providers.md).

## Minimal tool (no extra fields)
```typescript
import { Type } from "typebox";
pi.registerTool({
  name: "hello", label: "Hello", description: "Greet",
  parameters: Type.Object({ name: Type.String() }),
  async execute(_id, p) { return { content: [{ type: "text", text: `Hi ${p.name}` }], details: {} }; },
});
```
