# `ctx` (ExtensionContext) + UI reference

Every event handler receives `ctx: ExtensionContext`. Command handlers receive
`ExtensionCommandContext` (a superset — see commands-providers.md).

## `ctx` properties

| Property | Description |
|----------|-------------|
| `ctx.ui` | UI methods (see below). |
| `ctx.mode` | `"tui" \| "rpc" \| "json" \| "print"`. Guard TUI-only with `=== "tui"`. |
| `ctx.hasUI` | `true` in tui + rpc; `false` in print/json. Guard dialogs/notify. |
| `ctx.cwd` | Working dir. Use `CONFIG_DIR_NAME` (not hardcoded `.pi`) for project paths. |
| `ctx.isProjectTrusted()` | Whether project-local trust is active. |
| `ctx.sessionManager` | (read-only) `getEntries()`, `getBranch()`, `buildContextEntries()`, `getLeafId()`, `getSessionFile()`, `getSessionId()`, `getLabel(id)`. |
| `ctx.modelRegistry` | `getProvider(id)`, `getProviderAuth(id)`, `getAvailable()`, `find(provider, id)`. |
| `ctx.model` | Active model. |
| `ctx.thinkingLevel` | Current effective thinking level. |
| `ctx.scopedModels` | Read-only list of `{ model, thinkingLevel? }` scoped to the session. Empty = all available. |
| `ctx.signal` | Current agent `AbortSignal`, or `undefined` when no turn active. Defined during `tool_call`/`tool_result`/`message_update`/`turn_end`; usually `undefined` in idle events/commands. |
| `ctx.isIdle()` | false during agent run, retry, auto-compaction retry, or queued continuation. |
| `ctx.abort()` | Abort current operation. |
| `ctx.hasPendingMessages()` | Queued steering/follow-up messages exist. |
| `ctx.shutdown()` | Graceful shutdown (deferred until idle in interactive/rpc; no-op in print). Emits `session_shutdown` before exit. |
| `ctx.getContextUsage()` | Current context usage (`{tokens, ...}`); `null` if unavailable. |
| `ctx.compact({ customInstructions?, onComplete?, onError? })` | Trigger compaction (does not await). |
| `ctx.getSystemPrompt()` | Pi's current system prompt string. Reflects chained `before_agent_start` changes so far. Does NOT include later `context` mutations or `before_provider_request` payload rewrites. |

## `ctx.ui` — dialogs (block; guard with `ctx.hasUI`)

| Method | Returns | Timeout behavior |
|--------|---------|------------------|
| `ctx.ui.select(title, options)` | `Promise<string \| undefined>` | → `undefined` |
| `ctx.ui.confirm(title, message)` | `Promise<boolean>` | → `false` |
| `ctx.ui.input(title, placeholder?)` | `Promise<string \| undefined>` | → `undefined` |
| `ctx.ui.editor(title, prefill)` | `Promise<string>` | — |

All dialogs accept `{ timeout?: number }` or `{ signal?: AbortSignal }` (last arg).

```typescript
const choice = await ctx.ui.select("Pick one", ["A","B"], { timeout: 5000 });
const ok = await ctx.ui.confirm("Delete?", "Cannot be undone");
const name = await ctx.ui.input("Name:", "placeholder");
const text = await ctx.ui.editor("Edit:", "prefilled");
ctx.ui.notify("Done!", "info");  // "info" | "warning" | "error"
```

## `ctx.ui` — fire-and-forget (work in TUI AND RPC)

| Method | Description |
|--------|-------------|
| `ctx.ui.notify(message, "info"\|"warning"\|"error")` | Toast. |
| `ctx.ui.setStatus(key, text \| undefined)` | Footer status; `undefined` clears. |
| `ctx.ui.setWidget(key, lines[] \| factory \| undefined, { placement?: "aboveEditor" \| "belowEditor" })` | Above/below editor; `undefined` clears. Default `aboveEditor`. |
| `ctx.ui.setTitle(title)` | Terminal title. |
| `ctx.ui.setEditorText(text)` | Replace editor contents. |
| `ctx.ui.getEditorText()` | `string` (→ `""` in rpc). |
| `ctx.ui.pasteToEditor(text)` | Paste (with collapse for large content). |

## `ctx.ui` — working loader (TUI)

| Method | Description |
|--------|-------------|
| `ctx.ui.setWorkingMessage(text?)` | Loader text; `undefined`/no-arg restores default. |
| `ctx.ui.setWorkingVisible(boolean)` | Hide/show the built-in working loader row. |
| `ctx.ui.setWorkingIndicator({ frames: string[], intervalMs?: number })` | Custom spinner frames (rendered verbatim; color via `ctx.ui.theme.fg`). `{frames:[]}` hides; no-arg restores default. |

## `ctx.ui` — other TUI

| Method | Description |
|--------|-------------|
| `ctx.ui.setFooter(factory \| undefined)` | Replace built-in footer; `undefined` restores. |
| `ctx.ui.setHeader(factory \| undefined)` | Replace built-in header; `undefined` restores. (TUI; no-op in RPC.) |
| `ctx.ui.setEditorComponent(factory \| undefined)` | Replace editor; `factory = (tui, theme, keybindings) => Editor`. Capture previous via `getEditorComponent()` to wrap. |
| `ctx.ui.getEditorComponent()` | Current factory or `undefined`. |
| `ctx.ui.getToolsExpanded()` / `setToolsExpanded(boolean)` | Tool-row expansion. |
| `ctx.ui.addAutocompleteProvider((current) => ({ triggerCharacters, getSuggestions, applyCompletion, shouldTriggerFileCompletion? }))` | Stacks on built-in slash/path provider. |
| `ctx.ui.getAllThemes()` / `getTheme(name)` / `setTheme(name \| Theme) → {success, error?}` | Theme management. |
| `ctx.ui.theme` | `.fg(colorName, text)`, `.bg(...)`, `.bold`, `.italic`, `.strikethrough`. |

## `ctx.ui.custom` — TUI-only custom editor overlay
```typescript
if (ctx.mode !== "tui") { ctx.ui.notify("requires TUI", "error"); return; }
await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
  // return a TUI Component; call done(value) to close
  return new MyComponent(() => done());
}, { overlay?: true, overlayOptions?, onHandle? });
```
`custom()` returns `undefined` in RPC mode.

## Per-mode degradation

| Mode | `ctx.mode` | `ctx.hasUI` | Notes |
|------|------------|-------------|-------|
| Interactive | `"tui"` | `true` | Full TUI. |
| RPC (`--mode rpc`) | `"rpc"` | `true` | Dialogs + fire-and-forget via the extension UI protocol; `custom()` → `undefined`. |
| JSON (`--mode json`) | `"json"` | `false` | Event stream to stdout; UI methods are no-ops. |
| Print (`-p`) | `"print"` | `false` | Extensions run but can't prompt. |

**RPC-mode no-ops/degradations:** `custom()` → `undefined`; `setWorkingMessage`, `setWorkingIndicator`, `setFooter`, `setHeader`, `setEditorComponent`, `setToolsExpanded` are no-ops; `getEditorText()` → `""`; `getToolsExpanded()` → `false`; `pasteToEditor` delegates to `setEditorText`; `getAllThemes()` → `[]`; `getTheme()` → `undefined`; `setTheme()` → `{success:false, error}`.

## RPC extension UI protocol (for RPC clients)
When an extension calls a `ctx.ui` method in RPC mode, pi emits
`extension_ui_request` on stdout; the client replies (dialogs only) with
`extension_ui_response` carrying the same `id`.

**Request envelope:** `{ type: "extension_ui_request", id, method, ...fields }`.

| Method | Request fields | Response |
|--------|----------------|----------|
| `select` | `{ title, options, timeout? }` | `{ value }` or `{ cancelled: true }` |
| `confirm` | `{ title, message, timeout? }` | `{ confirmed: true\|false }` or `{ cancelled: true }` |
| `input` | `{ title, placeholder? }` | `{ value }` or `{ cancelled: true }` |
| `editor` | `{ title, prefill }` | `{ value }` or `{ cancelled: true }` |
| `notify` | `{ message, notifyType }` | (none) |
| `setStatus` | `{ statusKey, statusText }` | (none; `undefined` clears) |
| `setWidget` | `{ widgetKey, widgetLines, widgetPlacement? }` | (none; **string arrays only in RPC** — factories ignored) |
| `setTitle` | `{ title }` | (none) |
| `set_editor_text` | `{ text }` | (none) |

Timeouts are auto-resolved agent-side — the client doesn't track them.

**Framing gotcha:** RPC uses strict JSONL with LF only. Node `readline` is NOT
protocol-compliant (splits on U+2028/U+2029). Strip a trailing `\r`.
