---
name: pi-extension-dev
description: "Build extensions (plugins) for the pi coding agent (@earendil-works/pi-coding-agent). Use whenever the user wants to create, modify, or debug a pi extension — registering tools, slash commands, lifecycle hooks, custom providers, TUI widgets, or packaging/distributing a pi package. Covers the full extension API surface: tools, commands, events, ctx/ui, providers, persistence, cross-extension RPC, and the pi package manifest. Comprehensive enough to develop a well-integrated extension WITHOUT consulting the pi docs."
---

# pi-extension-dev

A **pi extension** is a TypeScript module that default-exports a factory function
`function (pi: ExtensionAPI) => void | Promise<void>`. pi loads it via jiti, so
plain `.ts` works — no build step required. Inside the factory you register
tools, commands, hooks, providers, etc.

This skill is the authoritative reference for the extension API. The body below
is a fast workflow + quick reference; the `references/` files hold the complete,
detailed API surface — read the relevant one when you need depth.

> Verified against `@earendil-works/pi-coding-agent` **0.84.4**. Notable since
> 0.83: `tool_call` veto gained `terminate`; new events `user_bash`,
> `session_compact_failed`, `ui_prompt_start/end`; tool defs gained
> `executionMode` and `constrainedSampling`; tool results gained `usage` and
> `addedToolNames`; `pi.exec`/`pi.setLabel`/markdown transformers; the SDK
> session factory split into `createAgentSessionServices` +
> `createAgentSessionFromServices`.

## When to use this skill

Trigger when the user wants to do any of:
- Create a new pi extension / plugin (tool, command, hook, provider, skill).
- Modify or debug an existing pi extension.
- Package/distribute a pi extension as an installable package.
- Add a custom tool the LLM can call, a `/slash` command, a keyboard shortcut,
  a custom model provider, or to hook into the agent lifecycle.

If the user is asking about the **ZCode** agent (this tool, not pi), that's a
different system — don't use this skill.

## How to build an extension — workflow

1. **Pick the shape** (§Shapes below): single file, directory, or package.
2. **Write the factory** in `index.ts` (or `my-ext.ts`). Default-export
   `function (pi: ExtensionAPI) { ... }`.
3. **Register capabilities** inside the factory: `pi.registerTool`,
   `pi.registerCommand`, `pi.on(event, ...)`, `pi.registerProvider`, etc.
   (§Quick reference).
4. **For session-scoped resources** (processes, watchers, sockets), start them
   in a `session_start` handler, NOT in the factory, and clean up in
   `session_shutdown`. The factory may run in sessions that never start.
5. **Load it to test**: `pi -e ./my-ext.ts` (temporary) or drop into
   `.pi/extensions/` (project-local) / `~/.pi/agent/extensions/` (global).
6. **For persistence** (state that survives reload/restart), store data in tool
   result `details` (for branching) or `pi.appendEntry(customType, data)` (for
   opaque extension data); reconstruct in `session_start`.
7. **To distribute** as an installable package, add a `package.json` with the
   `pi` manifest (§references/packaging.md).

## Shapes (where the code lives)

| Shape | Location | Notes |
|-------|----------|-------|
| Single file | `.pi/extensions/my-ext.ts` | Simplest. |
| Directory | `.pi/extensions/my-ext/index.ts` | Multi-file, relative imports. |
| Package | `package.json` + `src/...`, with deps | See `references/packaging.md`. |

Auto-discovery paths (project-local load only after the project is trusted):
- `~/.pi/agent/extensions/*.ts` and `~/.pi/agent/extensions/*/index.ts` — global.
- `.pi/extensions/*.ts` and `.pi/extensions/*/index.ts` — project-local.

Also: `pi -e ./path.ts` (or `npm:pkg`, `git:repo`) for a one-off run, and
`settings.json` `packages`/`extensions` arrays.

## Quick reference (the shapes you'll use most)

Read `references/<file>.md` for full detail on each.

### Factory

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // sync; return a Promise only for one-time async init (e.g. fetch model list).
  // NEVER start background resources here — defer to session_start.
  pi.on("session_start", async (_event, ctx) => { /* build state, start resources */ });
  pi.on("session_shutdown", async (_event, _ctx) => { /* tear down resources */ });
}
```

### Imports available (no install needed — host provides them)

| Package | Use for |
|---------|---------|
| `@earendil-works/pi-coding-agent` | `ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`, `defineTool`, `CONFIG_DIR_NAME`, `withFileMutationQueue`, `getAgentDir`, truncation helpers, `createLocalBashOperations`, `type BashOperations` (for `user_bash`), tool factories `createReadTool`/`createBashTool`/`createEditTool`/`createWriteTool`/`createGrepTool`/`createFindTool`/`createLsTool` (remote-execution ops), `isToolCallEventType`, `isBashToolResult`, SDK (`createAgentSession`). |
| `typebox` | `Type.Object/String/Optional/Array/...` for tool schemas. |
| `@earendil-works/pi-ai` | `StringEnum` (use for ALL string enums — `Type.Union`/`Type.Literal` break Google's API), `getModel`, `createProvider`. |
| `@earendil-works/pi-tui` | `Text`, `Box`, `Container`, `matchesKey`, `AutocompleteItem`. |

Node built-ins (`node:fs`, `node:path`, ...) and global `fetch` are available.

### Register a tool (LLM-callable)

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "todo",
  label: "Todo",
  description: "Add or list todo items",          // shown to the LLM
  promptSnippet: "Manage the project todo list",  // one-liner in "Available tools"
  promptGuidelines: ["Use todo when the user wants a task list."],  // bullets; name the tool
  parameters: Type.Object({
    action: StringEnum(["add", "list"] as const), // StringEnum, NOT Type.Literal
    text: Type.Optional(Type.String()),
  }),
  // executionMode: "sequential",            // opt OUT of parallel execution for this tool
  // constrainedSampling: false,             // disable/force provider-side constrained sampling
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) return { content: [{ type: "text", text: "cancelled" }] };
    onUpdate?.({ content: [{ type: "text", text: "working..." }], details: { progress: 50 } });
    // throw to signal an error (sets isError:true). Returning never sets isError.
    if (!params.text && params.action === "add") throw new Error("text required");
    return {
      content: [{ type: "text", text: "done" }],  // sent to LLM
      details: { todos: [...] },                  // for rendering / state reconstruction
      // usage,                // optional: Usage from nested LLM calls (footer/totals)
      // addedToolNames: [],   // optional: declare tools this result introduces
      // terminate: true,      // optional: skip follow-up LLM call (only if ALL tools in batch set it)
    };
  },
  // optional TUI rendering:
  renderCall(args, theme, _ctx) { /* return a TUI Component */ },
  renderResult(result, { expanded, isPartial }, theme, _ctx) { /* ... */ },
});
```
**Full detail (override built-ins, dynamic loading, truncation, file-mutation
queue, custom rendering): read `references/tools.md`.**

### Register a slash command

```typescript
pi.registerCommand("deploy", {
  description: "Deploy to an environment",
  getArgumentCompletions(prefix) {  // optional, from AutocompleteItem
    return ["dev","prod"].filter(v => v.startsWith(prefix)).map(v => ({ value: v, label: v }));
  },
  async handler(args, ctx) {  // ctx is ExtensionCommandContext here
    ctx.ui.notify(`Deploying: ${args}`, "info");
  },
});
```
Duplicate names get numeric suffixes (`/review:1`, `/review:2`).

### Subscribe to lifecycle events

```typescript
pi.on("event_name", async (event, ctx) => { /* maybe return something */ });
```

**The most common events:**
- `session_start` `{reason}` / `session_shutdown` `{reason}` — build/teardown state.
- `before_agent_start` → can return `{ message?, systemPrompt? }` to inject context or modify the prompt.
- `tool_call` `{toolName, toolCallId, input(mutable)}` → return `{ block: true, reason, terminate? }` to veto (terminate hints the agent to stop after the batch); mutate `event.input` to rewrite args.
- `tool_result` `{toolName, input, content, details, isError, usage}` → return a partial patch `{content?, details?, isError?, usage?}` (chains like middleware).
- `context` `{messages(deep copy)}` → return `{ messages }` to filter/rewrite what the LLM sees.
- `input` `{text, source, streamingBehavior}` → return `{action:"continue"|"transform",text}|"handled"`.
- `message_end` `{message}` → return `{message}` (same role) to replace.
- `user_bash` `{command, excludeFromContext, cwd}` → return `{operations}` (route `!`/`!!` to another machine) or `{result}` (pre-executed).

**Full event list + processing-order diagram: read `references/events.md`.**

### `ctx` (ExtensionContext) — what handlers receive

```typescript
ctx.cwd            // working dir
ctx.mode           // "tui" | "rpc" | "json" | "print"
ctx.hasUI          // true in tui + rpc; guard dialogs with this
ctx.signal         // agent AbortSignal during a turn; undefined when idle
ctx.isIdle(); ctx.abort(); ctx.hasPendingMessages(); ctx.shutdown();
ctx.sessionManager // getEntries(), getBranch(), getLeafId(), getSessionFile(), getLabel(id)
ctx.model; ctx.thinkingLevel; ctx.modelRegistry; ctx.scopedModels
ctx.getSystemPrompt(); ctx.getContextUsage(); ctx.compact({customInstructions})
ctx.isProjectTrusted()

ctx.ui.notify(msg, "info"|"warning"|"error")
ctx.ui.setStatus(key, text | undefined)           // footer status line
ctx.ui.setWidget(key, lines[] | undefined, {placement?})  // above/below editor
ctx.ui.confirm(title, msg) → Promise<boolean>     // false on timeout
ctx.ui.select(title, options[]) → Promise<string|undefined>
ctx.ui.input(title, placeholder?) → Promise<string|undefined>
ctx.ui.editor(title, prefill) → Promise<string>
ctx.ui.setStatus / setWidget / notify / setTitle / setEditorText / pasteToEditor  // fire-and-forget
// TUI-only (guard with ctx.mode === "tui"): custom(), setWorkingMessage, setFooter, setEditorComponent, theme.*
```
**Full ctx/ui surface + RPC behavior + mode degradation: read `references/context-ui.md`.**

### Other registrations

```typescript
pi.registerShortcut("ctrl+alt+p", { description: "...", handler: async (ctx) => {} });
pi.registerFlag("plan", { description: "...", type: "boolean", default: false });
if (pi.getFlag("plan") === true) { /* ... */ }
pi.registerProvider("my-prov", { baseUrl, apiKey: "$MY_KEY", api: "openai-completions", models: [...] });
pi.unregisterProvider("my-prov");
```

### Messages (inject into the conversation)

```typescript
pi.sendUserMessage("do X");                                   // a real user turn
pi.sendUserMessage("refine", { deliverAs: "steer" });         // interrupt streaming (or "followUp" to queue)
pi.sendMessage({ customType: "note", content: "...", display: true }, { triggerTurn: true, deliverAs: "followUp" });
pi.appendEntry("my-ext:state", { ... });   // persist (NOT in LLM context); read back via sessionManager.getEntries()
```

### Cross-extension communication

```typescript
pi.events.on("my-ext:status", (data) => { /* ... */ });
pi.events.emit("my-ext:status", { hello: true });
```
Cache `ctx` from `session_start` (event-bus handlers don't receive one).
**Full detail: read `references/events.md` §Cross-extension bus.**

## Critical gotchas (will bite you if missed)

1. **`StringEnum` for every string enum** (from `@earendil-works/pi-ai`). `Type.Union`/`Type.Literal` break Google API.
2. **Errors: throw, don't return.** A tool `execute` that throws → `isError:true` to the LLM and execution continues. Returning never sets the error flag.
3. **`tool_call` errors block (fail-safe).** A handler that itself throws blocks the tool.
4. **No background resources in the factory.** Factories may run in sessions that never start. Defer to `session_start`; clean up in `session_shutdown`.
5. **File-mutating tools must use `withFileMutationQueue(absolutePath, async () => {...})`** (from `@earendil-works/pi-coding-agent`) so they share the per-file lock with built-in `edit`/`write` (tool calls run in parallel by default).
6. **Output truncation:** built-in cap is 50KB / 2000 lines. Use `truncateHead`/`truncateTail` + tell the LLM where the full output is saved.
7. **Override built-ins** (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`) by registering the same name — but you must match the exact result `details` shape. Omit `renderCall`/`renderResult` to inherit the built-in renderer.
8. **Guard UI:** `ctx.hasUI` before dialogs/notify (false in print/json). `ctx.mode === "tui"` for TUI-only methods (`custom`, `setWorkingMessage`, etc.).
9. **Session-scoped state:** store in tool-result `details` (reconstruct via `ctx.sessionManager.getBranch()` filtering `role === "toolResult" && toolName === "..."`) so it survives branching/forking. `appendEntry` for opaque data.
10. **Path args:** some models prepend `@`; strip a leading `@` like the built-ins do.
11. **Async factory is awaited** before `session_start`/`resources_discover`/provider flush — fine for one-time init, but still don't start resources there.

## Minimal complete example

```typescript
// ~/.pi/agent/extensions/my-ext.ts
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const greet = defineTool({
  name: "greet",
  label: "Greet",
  description: "Greet someone by name",
  parameters: Type.Object({ name: Type.String() }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: {} };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(greet);
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => ctx.ui.notify(`Hi ${args || "world"}!`, "info"),
  });
  pi.on("session_start", async (_e, ctx) => ctx.ui.notify("my-ext loaded", "info"));
}
```

Test: `pi -e ~/.pi/agent/extensions/my-ext.ts`.

## Reference files (read on demand for depth)

- **`references/events.md`** — full event list + processing-order diagram + every payload/return + cross-extension bus + skills/prompts/themes discovery (`resources_discover`).
- **`references/tools.md`** — full tool definition (all fields), execute return, error semantics, truncation helpers, `withFileMutationQueue`, dynamic tool loading (`setActiveTools`), overriding built-ins, custom rendering, remote-execution tool factories.
- **`references/context-ui.md`** — every `ctx` property + every `ctx.ui` method (dialogs, fire-and-forget, working loader, TUI-only, theme) + RPC UI protocol + per-mode degradation table.
- **`references/commands-providers.md`** — `registerCommand`/autocomplete, `ExtensionCommandContext` extras (newSession/fork/switchSession/reload + the session-replacement footguns), `registerShortcut`/`registerFlag`, `registerProvider`/`unregisterProvider` (full shapes incl. OAuth, custom streaming), `sendMessage`/`sendUserMessage`/`appendEntry`.
- **`references/packaging.md`** — loading locations, `settings.json` arrays, `-e` flag, the `package.json` `pi` manifest, `pi-package` keyword, gallery fields, dependency rules (peer vs bundled), package sources + filtering, SDK embedding (`createAgentSession`).

When in doubt about an exact signature, read the relevant reference file — they quote the real shapes verbatim.
