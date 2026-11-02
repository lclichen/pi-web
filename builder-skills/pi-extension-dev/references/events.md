# Lifecycle events reference

Subscribe with `pi.on(event, handler)`. Every handler receives `(event, ctx)`
where `ctx` is `ExtensionContext` (or `ExtensionCommandContext` only inside
commands — never in plain event handlers). Handlers may be async.

## Processing order (verbatim from the docs)

```
pi starts
  │
  ├─► project_trust (user/global and CLI extensions only, before project resources load)
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }
      │
      ▼
user sends prompt ─────────────────────────────────────────┐
  │                                                        │
  ├─► (extension commands checked first, bypass if found)  │
  ├─► input (can intercept, transform, or handle)          │
  ├─► (skill/template expansion if not handled)            │
  ├─► before_agent_start (can inject message, modify system prompt)
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn (repeats while LLM calls tools) ───┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (can modify messages)            │       │
  │   ├─► before_provider_headers (can mutate headers)     |
  │   ├─► before_provider_request (can inspect or replace payload)
  │   ├─► after_provider_response (status + headers, before stream consume)
  │   │                                            │       │
  │   │   LLM responds, may call tools:            │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call (can block)              │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_result (can modify)           │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   └─► turn_end                                 │       │
  │                                                        │
  ├─► agent_end                                            │
  └─► agent_settled (no retry/compaction/follow-up left)   │
                                                           │
user sends another prompt ◄────────────────────────────────┘

/new or /resume: session_before_switch → session_shutdown → session_start{reason:"new"|"resume"} → resources_discover
/fork or /clone:  session_before_fork → session_shutdown → session_start{reason:"fork"} → resources_discover
/name or pi.setSessionName(): session_info_changed
/compact or auto-compaction: session_before_compact → session_compact (or session_compact_failed on error/abort)
/tree navigation: session_before_tree → session_tree
/model or Ctrl+P: thinking_level_select (if changed) → model_select
exit: session_shutdown
```

## Session lifecycle

### `project_trust` — before deciding to trust a project
Only user/global + CLI `-e` extensions (project-local not loaded yet). `ctx` is
limited: `cwd`, `mode`, `hasUI`, and `select/confirm/input/notify`.

```typescript
pi.on("project_trust", async (event, ctx) => {
  // event.cwd
  if (await ctx.ui.confirm("Trust project?", event.cwd)) return { trusted: "yes", remember: true };
  return { trusted: "undecided" }; // first yes/no wins; "undecided" defers
});
```

### `session_start` / `session_shutdown`
- `event.reason`: `"startup" | "reload" | "new" | "resume" | "fork"` (shutdown also `"quit"`).
- `event.previousSessionFile` (start, for new/resume/fork); `event.targetSessionFile` (shutdown, for replacement).
- **Build/teardown session-scoped state here.** No special return.

### `session_info_changed` — `event.name` (normalized, or `undefined`).

### `session_before_switch` / `session_before_fork`
- `before_switch`: `event.reason` (`"new"|"resume"`), `event.targetSessionFile` (resume only). Return `{ cancel: true }`.
- `before_fork`: `event.entryId`, `event.position` (`"before"` for /fork, `"at"` for /clone). Return `{ cancel: true }`.

### `session_before_compact` / `session_compact` / `session_compact_failed`
- `before_compact`: `{ preparation, branchEntries, customInstructions, reason, willRetry, signal }`. `reason`: `"manual"|"threshold"|"overflow"`. Return `{ cancel: true }` OR `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage? } }`.
- `session_compact`: `{ compactionEntry, fromExtension, reason, willRetry }`.
- `session_compact_failed` (0.84): `{ reason, errorMessage?, aborted, willRetry? }` — fires when compaction fails or is aborted. `reason`: `"manual"|"threshold"|"overflow"`; `aborted: true` when cancelled; `willRetry: true` when the aborted overflow turn will be retried.

### `session_before_tree` / `session_tree`
- `before_tree`: `{ preparation, signal }`. Return `{ cancel: true }` or `{ summary: { summary, usage?, details } }`.
- `session_tree`: `{ newLeafId, oldLeafId, summaryEntry, fromExtension }`.

## Agent loop

### `before_agent_start` — after prompt submitted, before the loop
Can inject a message and/or modify the system prompt.

```typescript
pi.on("before_agent_start", async (event) => {
  // event.prompt, event.images
  // event.systemPrompt (chained; includes earlier handlers' changes)
  // event.systemPromptOptions: { customPrompt, selectedTools, toolSnippets, promptGuidelines,
  //                              appendSystemPrompt, cwd, contextFiles, skills }
  return {
    message: { customType: "my-ext", content: "extra context for the LLM", display: true },
    systemPrompt: event.systemPrompt + "\n\nExtra instructions for this turn...",
  };
});
```
`display:false` hides the message from the TUI but the LLM still sees it.

### `agent_start` / `agent_end` / `agent_settled`
- `agent_end`: `event.messages` (this run's messages).
- `agent_settled`: pi will not continue automatically; `ctx.isIdle()` true here (unless another ext started a run).

### `turn_start` / `turn_end`
- `turn_start`: `{ turnIndex, timestamp }`.
- `turn_end`: `{ turnIndex, message, toolResults }`.

### `message_start` / `message_update` / `message_end`
- Fire for user, assistant, and toolResult messages.
- `message_update`: assistant streaming; `event.assistantMessageEvent` is the token-by-token stream event.
- `message_end`: return `{ message }` to replace (MUST keep same `role`).

### `context` — before each LLM call, modify messages non-destructively
```typescript
pi.on("context", async (event) => {
  // event.messages is a deep copy — safe to mutate
  return { messages: event.messages.filter(/* ... */) };
});
```

## Provider HTTP

### `before_provider_headers` — mutate `event.headers` IN PLACE
```typescript
pi.on("before_provider_headers", (event, ctx) => {
  event.headers["x-session-id"] = ctx.sessionManager.getSessionId();
  event.headers["X-OpenRouter-Title"] = null; // null deletes
});
```
Runs once per request; retries reuse the same headers.

### `before_provider_request` — `{ payload }` (mutable). Return `undefined` to keep; anything else replaces.
Gotcha: payload-level changes are NOT reflected by `ctx.getSystemPrompt()`.

### `after_provider_response` — `{ status, headers }`. Header availability depends on provider.

## Tool events

### `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `start`: `{ toolCallId, toolName, args }`.
- `update`: `{ toolCallId, toolName, args, partialResult }`.
- `end`: `{ toolCallId, toolName, result, isError }`.
- Parallel mode: `start` in assistant source order; `update` interleaves; `end` in completion order.

### `tool_call` — after start, before execution. CAN BLOCK. `event.input` is MUTABLE.
```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    event.input.command = `source ~/.profile\n${event.input.command}`; // mutation applies
    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "dangerous", terminate: true }; // terminate: hint to stop after this batch
    }
  }
  // typed custom tool:
  // if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) { event.input.action ... }
});
```
- Mutations to `event.input` affect execution; later handlers see them; no re-validation.
- Return `{ block: true, reason?, terminate? }`. `terminate` (0.84) hints the agent
  should stop after the current tool batch; early termination only happens when
  every finalized tool result in the batch agrees (same rule as the tool-result
  `terminate` field).
- A handler that throws BLOCKS the tool (fail-safe).

### `tool_result` — after execution, before end + final toolResult message. CAN MODIFY.
```typescript
pi.on("tool_result", async (event, ctx) => {
  // event: { toolName, toolCallId, input, content, details, isError, usage }
  return { isError: false };              // partial patch (chains like middleware)
  // return { content: [...], details: {...}, usage: ... }  // omit fields to keep current
});
```
Use `isBashToolResult(event)` to narrow (typed `event.details`).

## Model events

### `model_select` — `{ model, previousModel, source: "set"|"cycle"|"restore" }`.
### `thinking_level_select` — `{ level, previousLevel }`. **Notification-only; return values ignored.**

## User bash

### `user_bash` — `!`/`!!` commands. `{ command, excludeFromContext, cwd }`.
Return (first handler that returns a value wins):
- `{ operations: BashOperations }` — custom ops; pi runs the command through them and records the result in the session (chat transcript + optional LLM context).
- `{ operations: { exec(command, cwd, options) { ... } } }` — wrap built-in via `createLocalBashOperations()`.
- `{ result: { output, exitCode, cancelled, truncated } }` — full replacement for already-executed commands.

`BashOperations` (type from `@earendil-works/pi-coding-agent`) is a single `exec`:

```typescript
import type { BashOperations } from "@earendil-works/pi-coding-agent";

const ops: BashOperations = {
  exec: (command, cwd, { onData, signal, timeout }) =>
    new Promise((resolve, reject) => {
      // stream output as Buffers via onData(data: Buffer)
      // honor signal (abort → resolve({ exitCode: null })) and timeout (ms)
      // resolve with { exitCode: number | null } when done
    }),
};
```
Gotchas:
- pi may prepend the configured `shellCommandPrefix` as extra leading LINES of
  `command` — treat the command as a multi-line shell script, never assume it is
  a single line.
- The `cwd` handed to the event/ops is the LOCAL session cwd; when routing to
  another machine, map it to the remote project directory yourself.
- Hosts that forward `!` to a backend should treat "no handler returned ops" as
  "do not execute locally" if local execution would escape the backend's fence.

## UI prompts

### `ui_prompt_start` / `ui_prompt_end` (0.84) — blocking extension UI prompts
Fired when pi starts/ stops waiting on a user-facing extension dialog
(`ctx.ui.select/confirm/input/editor/custom`).
`{ kind: "select"|"confirm"|"input"|"editor"|"custom", title? }`. Useful for
RPC clients and status widgets that need to reflect "waiting on the user".
Notification-only; return values ignored.

## Input

### `input` — user input, after commands checked, before skill/template expansion
`{ text, images, source: "interactive"|"rpc"|"extension", streamingBehavior: "steer"|"followUp"|undefined }`.

Order: extension commands (`/cmd`) → `input` → skill expansion (`/skill:name`) → templates (`/template`) → agent.

Returns:
- `{ action: "continue" }` — pass through (default).
- `{ action: "transform", text }` — rewrite, continue (chains).
- `{ action: "handled" }` — skip the agent entirely (first handler wins).

## `resources_discover` — contribute skills/prompts/themes paths
```typescript
pi.on("resources_discover", async () => {
  return { skillPaths: ["/abs/path/skills"], promptPaths: [...], themePaths: [...] };
});
```

## Cross-extension event bus (`pi.events`)

A shared pub/sub bus independent of pi's lifecycle events. Handlers do NOT
receive `ctx` — cache it from `session_start`.

```typescript
let currentCtx: ExtensionContext | undefined;
pi.on("session_start", async (_e, ctx) => { currentCtx = ctx; });

pi.events.on("my-ext:notification", (data) => {
  const { message, from } = data as { message: string; from: string };
  currentCtx?.ui.notify(`From ${from}: ${message}`, "info");
});
pi.registerCommand("emit", {
  description: "Emit my-ext:notification",
  handler: async (args) => pi.events.emit("my-ext:notification", { message: args, from: "/emit" }),
});
```

Convention: namespace channels (`"my-ext:notification"`). This is also how
`@tintinweb/pi-subagents` exposes its RPC (spawn/stop/completed/failed over the
bus) — other extensions reuse subagents purely through `pi.events`, no imports.

SDK side: `import { createEventBus } from "@earendil-works/pi-coding-agent";`
then pass to `new DefaultResourceLoader({ eventBus })`.

## Error handling summary
- Extension errors are logged; the agent continues.
- `tool_call` handler errors BLOCK the tool (fail-safe).
- Tool `execute` errors must be signaled by **throwing** (→ `isError:true`, continues).
