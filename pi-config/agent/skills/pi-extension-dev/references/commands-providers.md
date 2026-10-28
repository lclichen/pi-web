# Commands, shortcuts, flags, providers, messages

## `pi.registerCommand(name, options)`

```typescript
pi.registerCommand("deploy", {
  description: "Deploy to an environment",
  getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
    const items = ["dev","staging","prod"].map(e => ({ value: e, label: e }));
    const filtered = items.filter(i => i.value.startsWith(prefix));
    return filtered.length > 0 ? filtered : null;
  },
  handler: async (args: string, ctx: ExtensionCommandContext) => {
    ctx.ui.notify(`Deploying: ${args}`, "info");
  },
});
```
- `AutocompleteItem` from `@earendil-works/pi-tui`.
- Duplicate names: pi keeps all, suffixes by load order (`/review:1`, `/review:2`).
- Invoked as `/name args`.

### `ExtensionCommandContext` (commands ONLY — not in event handlers)
These can deadlock in event handlers, so they're command-only:

| Method | Description |
|--------|-------------|
| `ctx.getSystemPromptOptions()` | Base inputs pi uses for the system prompt: `{ customPrompt, selectedTools, toolSnippets, promptGuidelines, appendSystemPrompt, cwd, contextFiles, skills }`. Same shape/mutability as `before_agent_start`'s `event.systemPromptOptions`. May include full context file contents — treat as sensitive. |
| `ctx.waitForIdle()` | Wait for agent to fully settle (retries, auto-compaction, queued continuations). |
| `ctx.newSession(options?)` | `{ parentSession?, setup?(sm), withSession?(ctx) }` → `{ cancelled }`. |
| `ctx.fork(entryId, options?)` | `{ position?: "before"\|"at", withSession?(ctx) }` → `{ cancelled }`. |
| `ctx.navigateTree(targetId, options?)` | `{ summarize?, customInstructions?, replaceInstructions?, label? }`. |
| `ctx.switchSession(sessionPath, options?)` | `{ withSession?(ctx) }` → `{ cancelled }`. |
| `ctx.reload()` | Same flow as `/reload`. Emits `session_shutdown`, reloads, emits `session_start{reason:"reload"}` + `resources_discover`. **Treat as terminal:** `await ctx.reload(); return;`. Tools (which run with `ExtensionContext`, not command context) can't call this directly — expose a tool that queues the reload as a follow-up user message. |

### Session-replacement footguns (`withSession`)
- Receives a fresh `ReplacedSessionContext` (extends `ExtensionCommandContext` with async `sendMessage()`/`sendUserMessage()` bound to the new session).
- Runs only AFTER old session emitted `session_shutdown`, old runtime torn down, replacement rebound, new extension instance already got `session_start`.
- The callback still executes in the OLD closure, not the new instance.
- Captured old `pi`/old `ctx` session-bound objects are STALE and will throw — use only the `ctx` passed to `withSession`.
- Captured raw objects (`const sm = ctx.sessionManager`) are still your responsibility — don't reuse after replacement.

## `pi.registerShortcut(key, options)`
```typescript
pi.registerShortcut("ctrl+alt+p", {  // see keybindings.md for full format (Key.* helpers from pi-tui)
  description: "Toggle plan mode",
  handler: async (ctx) => { /* ... */ },
});
```

## `pi.registerFlag(name, options)` + `pi.getFlag(name)`
```typescript
pi.registerFlag("plan", { description: "Start in plan mode", type: "boolean", default: false });
if (pi.getFlag("plan") === true) { /* ... */ }
```

## `pi.registerProvider` / `pi.unregisterProvider`
Two call forms.

**Object form** — pass a complete pi-ai `Provider` (with native `auth`, `getModels`, `refreshModels`, `filterModels`, `stream`, `streamSimple`).

**Config form:**
```typescript
pi.registerProvider("local-openai", {
  baseUrl: "http://localhost:1234/v1",
  apiKey: "$LOCAL_OPENAI_API_KEY",        // literal | env ("$VAR"/"${VAR}") | leading "!command". "$$" escapes "$"; "$!" escapes literal "!".
  api: "openai-completions",               // "anthropic-messages" | "openai-completions" | "openai-responses" | ...
  headers?: { ... },
  authHeader?: "...",
  models: [
    { id, name, reasoning: false, input: ["text"], cost: {input,output,cacheRead,cacheWrite},
      contextWindow, maxTokens },
  ],
  refreshModels?: async ({ signal, store, ... }) => { /* async discovery; returned models replace the list */ },
  oauth?: {
    name: "Custom (Claude Pro/Max)",
    login: loginFn,           // (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>
    refreshToken: refreshFn,  // (cred) => Promise<OAuthCredentials>
    getApiKey: (cred) => cred.access,
  },
  streamSimple: streamFn,     // (model, context, options?) => AssistantMessageEventStream
});
```
- Factory-phase calls are queued and flushed at runner init; post-startup calls take effect immediately (no `/reload`).
- Override just `baseUrl` for an existing provider: `pi.registerProvider("anthropic", { baseUrl: "..." })` (keeps models).
- `pi.unregisterProvider(name)` — removes provider + its models, restores built-in models it overrode. No effect if not registered. Immediate when called after load.

### OAuth + custom streaming (full)
`streamSimple` returns an `AssistantMessageEventStream` (build via `createAssistantMessageEventStream()` from `@earendil-works/pi-ai`) and pushes typed events: `start`, `text_start`/`text_delta`/`text_end`, `thinking_*`, `toolcall_*`, `done`, `error`. OAuth login uses `callbacks.onAuth({ url })` then `callbacks.onPrompt({ message })` to get a pasted code, returning `{ refresh, access, expires }`.

### Async factory provider (one-time remote model discovery)
```typescript
export default async function (pi: ExtensionAPI) {
  const res = await fetch("http://localhost:1234/v1/models");
  const payload = await res.json();
  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map(m => ({ id: m.id, name: m.name ?? m.id, reasoning: false, input: ["text"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow: m.context_window ?? 128000, maxTokens: m.max_tokens ?? 4096 })),
  });
}
```
The async factory is awaited before `session_start`/`resources_discover`/provider flush — fine for one-time init, but STILL don't start background resources here.

## Messages — `sendMessage` / `sendUserMessage` / `appendEntry`

```typescript
// A real user turn (always triggers a turn when not streaming):
pi.sendUserMessage("do X");
pi.sendUserMessage("refine", { deliverAs: "steer" });      // interrupt streaming
pi.sendUserMessage("then do Y", { deliverAs: "followUp" }); // queue behind current
pi.sendUserMessage([{ type: "text", text: "..." }, /* image content */]);

// A custom message (participates in LLM context, can have a custom renderer):
pi.sendMessage(
  { customType: "plan-mode-execute", content: execMessage, display: true },
  { triggerTurn: true, deliverAs: "followUp" },  // deliverAs: "steer"(default) | "followUp" | "nextTurn"
);

// Persist opaque extension data (NOT in LLM context):
pi.appendEntry("plan-mode", { enabled, todos, ... });
```

- `sendUserMessage(content, options?)` — `deliverAs` REQUIRED when streaming (throws otherwise).
- `appendEntry(customType, data?)` — read back via `ctx.sessionManager.getEntries()` filtering `entry.type === "custom" && entry.customType === "<your type>"`. Pair with `pi.registerEntryRenderer(customType, renderer)` for TUI display.
- `registerMessageRenderer(customType, (message, {expanded, outputPad}, theme) => Component)` — for messages created via `sendMessage`.

## Other `pi` methods

| Method | Description |
|--------|-------------|
| `pi.getActiveTools()` / `pi.getAllTools()` / `pi.setActiveTools(names)` | Tool management. |
| `pi.exec(command, args, options?)` | Run shell cmd → `{stdout, stderr, code, killed}`. Options: `signal`, `timeout`. |
| `pi.setModel(model)` | `Promise<boolean>` (false if no API key). |
| `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)` | Levels: `"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"`. Clamped to model; emits `thinking_level_select`. |
| `pi.events` | Cross-extension bus (`on`/`emit`/`off`). |
| `pi.setSessionName(name)` / `pi.getSessionName()` / `pi.setLabel(entryId, label \| undefined)` | Session metadata. |
| `pi.getCommands()` | Invokable slash commands: `{ name, description?, source, sourceInfo }`. |
| `pi.registerMarkdownTransformer(fn)` | Rewrite user/assistant Markdown before transcript rendering. `fn(markdown, { messageType: "user"\|"assistant"\|"assistant-thinking", isStreaming, availableWidth }) => string`. TUI transcript only — does not affect what the LLM sees. |
| `pi.registerMessageRenderer(customType, fn)` / `pi.registerEntryRenderer(customType, fn)` | Custom renderers for `sendMessage` messages / `appendEntry` entries. |

## `getCommands()` source shape
`source: "extension" | "prompt" | "skill"`; `sourceInfo: { path, source, scope: "user"|"project"|"temporary", origin: "package"|"top-level", baseDir? }`. Built-in interactive commands are NOT included.
