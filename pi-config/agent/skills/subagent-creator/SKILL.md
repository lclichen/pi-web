---
name: subagent-creator
description: "Design and maintain reusable subagents in pi (tintinweb/pi-subagents). Use for agent configuration, role definition, capability assignment, tool integration, behavior specification, validation, multi-agent coordination, workflow orchestration (SubagentWorkflow), or agent lifecycle management. Not for one-off agent prompts or passive documentation."
---


# Subagent Creator Skill

This skill helps you create, manage, and work with autonomous sub-agents in pi.

> Based on @tintinweb/pi-subagents **v0.19.0** (requires pi >= 0.84.0). Full docs: `reference/README.md`; workflow guide: `reference/workflows.md`; RPC guide: `reference/rpc.md`.

## Overview

Sub-agents are Claude Code-style autonomous workers that run in isolated sessions, each with its own tools, system prompt, model, and thinking level. Since v0.18.0 **agents run in the background by default**: an unqualified `Agent` call returns an agent ID immediately and the result arrives as a completion notification. Pass `run_in_background: false` to block and get the output inline. You can steer agents mid-run, address them with `@handle` at the prompt, resume completed sessions, nest delegation via `allowed_subagents`, and orchestrate many agents deterministically with the `SubagentWorkflow` tool.

## When to Use This Skill

- You need to create custom agent types for specialized tasks
- You want to spawn sub-agents for parallel work
- You need to manage running agents or review their results
- You're setting up agent workflows for complex multi-step tasks
- You want a deterministic, scriptable fan-out (map/reduce over many files, generate-verify loops)

## Creating Custom Agents

### Basic Agent Definition

Create agent definition files in one of these locations (priority order):

1. `.pi/agents/<name>.md` - Project-level (highest priority; where `/agents` writes)
2. `.agents/agents/<name>.md` - Project-level alternative
3. `~/.pi/agent/agents/<name>.md` - Global (available everywhere; honors `PI_CODING_AGENT_DIR`)

The frontmatter `name:` is the agent's type — what `subagent_type` and `@handle` address — falling back to the filename when omitted. The filename does not have to match (`blubb.md` with `name: code-review` dispatches as `code-review`). A file claiming a default agent's name overrides it.

An unreadable or unparseable agent file is skipped with a warning, not fatal. Set `strictAgentFiles: true` in `subagents.json` to fail startup instead.

### Agent Frontmatter Fields

```yaml
---
description: Short description of the agent's purpose
name: my-agent  # The dispatch type; falls back to the filename
display_name: My Agent  # UI label only (widget, agent list, badges)
color: cyan  # Name badge color: red/blue/green/yellow/purple/orange/pink/cyan, "#8B5CF6", or aliases
tools: read, grep, find, bash  # Which tools the agent can use
model: anthropic/claude-haiku-4-5  # Model to use (or fuzzy name like "haiku")
thinking: medium  # off, minimal, low, medium, high, xhigh, max
max_turns: 30  # Maximum agentic turns before shutdown (0/omit = unlimited)
skills: skill-name1, skill-name2  # Preload ONLY these skills; true inherits parent's, false inherits none
memory: project  # project, local, or user
disallowed_tools: edit, write  # Tools to deny
isolation: worktree  # Run in isolated git worktree; "off" refuses one even if the caller asks
persist_session: true  # Persist as a normal pi session (default: rememberAgents, true)
output_transcript: true  # Write transcript file
prompt_mode: replace  # replace (standalone) or append (parent twin)
inherit_context: false  # Fork parent conversation
run_in_background: false  # Pin foreground; omit to follow backgroundByDefault
allowed_subagents: helper-a, helper-b  # Opt in to nested Agent tools (or "all"); default: none
isolated: true  # Hermetic: built-in tools only, no extensions/skills/context
enabled: true  # Set false to disable
---
```

Frontmatter is authoritative: `model`, `thinking`, `max_turns`, `inherit_context`, `run_in_background`, `isolated`, and `isolation` set here are locked; `Agent` tool parameters only fill fields the file leaves unspecified.

### Example: Security Auditor Agent

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor. Review code for vulnerabilities including:
- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

## Spawning Sub-Agents

### Using the Agent Tool

```typescript
Agent({
  subagent_type: "Explore",  // Built-in or custom agent type
  prompt: "Find all files that handle authentication",
  description: "Find auth files",  // 3-5 word summary
  name: "auth-files",  // Optional memorable handle, addressable as @auth-files
  run_in_background: true,  // Default true; false blocks and returns output inline
  model: "haiku",  // Optional: override agent's model
  thinking: "low",  // Optional: override thinking level
  max_turns: 20,  // Optional: override turn limit
  inherit_context: false,  // Optional: fork parent conversation
  isolation: "worktree",  // Optional: "worktree" | "off"
})
```

### Agent Types

| Type | Tools | Model | Description |
|------|-------|-------|-------------|
| `general-purpose` | all 7 | inherit | Parent twin with full system prompt |
| `Explore` | read, bash, grep, find, ls | haiku | Fast codebase exploration (read-only) |
| `Plan` | read, bash, grep, find, ls | inherit | Software architect for planning (read-only) |

Types are case-insensitive; an unknown type falls back to `fallbackSubagent` (default `general-purpose`) with a note — set it to `none` in `subagents.json` for strict fail-closed dispatch.

### Background vs Foreground

- **Background** (`run_in_background` omitted or `true`, default via `backgroundByDefault: true`): returns the agent ID immediately; the completion notification carries a preview (500 chars solo, 300 grouped) — use `get_subagent_result` for the full text
- **Foreground** (`run_in_background: false`): blocks until complete, returns the full result inline
- **Nested spawns are the exception**: an agent spawning its own agent always defaults to foreground (a detached child would be stopped when its parent settles)
- Because background is the default, nearly every spawn takes a `maxConcurrent` slot (default raised 4 → 10); `Esc` interrupts the turn without stopping agents it started — stop those from `/agents → Running agents`

### Managing Background Agents

```typescript
// Check status / retrieve result
get_subagent_result({
  agent_id: "agent-abc123",  // accepts a @handle too
  wait: false,  // Optional: wait for completion
  verbose: false,  // Optional: include full conversation
})

// Send steering message to running agent
steer_subagent({
  agent_id: "agent-abc123",
  message: "Focus on the authentication module specifically",
})
```

Cancelling a `wait: true` call stops only the wait; the agent keeps running and still notifies.

## Agent Mentions (@handle)

Every agent has a typeable handle (type lowercased, numbered on collision: `explore`, `explore-2`; or a `name` given at spawn). A **leading** `@handle <message>` at the prompt addresses the agent directly — nothing enters the chat:

| Agent state | `@explore fix the flaky test` does |
|-------------|-----------------------------------|
| running / queued | steers it (like `steer_subagent`) |
| finished | resumes it in the background |
| record evicted | reopens its session from disk (needs `rememberAgents`, default on) |
| never started | starts it — `model` mode (default) clones the conversation off-screen and lets it call `Agent`; `direct` mode starts immediately with your text verbatim |

`@main` escapes to the main model; `@agent-<type>` is accepted as a synonym; a bare handle or mid-sentence mention is not routed. Controlled by `agentMentions` (`model` / `direct` / `off`, default `model`) via `/agents → Settings → Agent mentions`.

## Nested Subagents

Default-off delegation: a custom agent with `allowed_subagents` gets its own ownership-scoped `Agent`, `get_subagent_result`, and `steer_subagent` tools.

```yaml
---
tools: read, grep, find
allowed_subagents: support-file-finder, support-callsite-tracer   # or "all"
---
```

- The allowlist is a **privilege boundary**: children run with their *own* tools/extensions, so the parent can do anything any listed agent can — choose the list as carefully as `tools:`
- Depth cap 2 by default (main → subagent → nested child); project-wide via `maxSubagentDepth` (0/1 disables)
- Result/resume/steer are ownership-scoped; children are hidden from top-level surfaces and events, their token spend rolls up to the parent, and they are stopped when the parent settles
- Nested children occupy no concurrency slot; an isolated agent never gets nested tools

## Workflow Orchestration (SubagentWorkflow)

A deterministic JavaScript script that orchestrates many subagents — it can loop, branch, and fan out over a list discovered at runtime, which parallel `Agent` calls cannot. The tool returns a task id immediately; the run continues in the background and notifies on completion.

```js
export const meta = {
  name: 'auth-audit',
  description: 'Find routes missing auth checks, then verify each finding',
  phases: [{ title: 'Scan' }, { title: 'Audit' }],
}

phase('Scan')
const listing = await agent('List every route file under src/routes/. One path per line.')
const files = listing.split('\n').map(s => s.trim()).filter(Boolean)
log('auditing ' + files.length + ' files')

phase('Audit')
return await pipeline(
  files,
  file => agent(`Audit ${file} for missing auth checks.`, { label: `audit:${file}` }),
  (found, file) => agent(`Try to REFUTE this finding about ${file}: ${found}`, { label: `verify:${file}` }),
)
```

Script globals: `agent(prompt, opts?)`, `parallel(...)`, `pipeline(items, ...stages)`, `phase(title)`, `log(msg)`, `args`, `budget`, `workflow(name, args?)` (compose a saved workflow, one level deep). `pipeline` has **no barrier between stages** — one item can be in stage 3 while another is still in stage 1; `parallel` is an explicit barrier.

`agent()` options: `schema` (JSON Schema — the child answers through a `StructuredOutput` tool and the call resolves to a validated object, or `null` on failure), `gate: "npm test"` (run a command after the agent; non-zero exit fails it), `effort` (per-child thinking level), `resume: "<label>"` (continue a prior child's session), `label`, `model`, `isolation`.

Hard rules:
- Opens with a pure-literal `export const meta = { name, description, phases }`
- Runs in a `node:vm` sandbox in a worker thread: `Date.now()`, `new Date()`, `Math.random()`, `eval`, and `Function(...)` all throw — pass variable values in through `args`
- Concurrency capped at `max(1, min(16, cpus - 2))`; 1000 agents per run; 4096 items per `parallel`/`pipeline`
- A workflow finishing with an un-awaited `agent()` fails rather than discarding it
- Workflow agents appear as a single `workflow` row in the fleet list and are hidden from the widget, `/agents` menus, and `@handle` — they are outside both concurrency pools (the run bounds its own fan-out)

Tool parameters: `script` (source), `scriptPath` (file path; wins over `script`), `name` (saved workflow; loses to both), `args`, `resumeFromRunId` (replay an earlier run's unchanged prefix from its journal — same session, run finished).

Saved workflows are `<name>.js` files in `.pi/workflows/`, `.agents/workflows/`, or `<agent dir>/workflows/` (project shadows global); only files carrying `export const meta` are listed/resolved. Each invocation's script is persisted to the session directory — iterate by editing that file and re-running.

Manage runs via `/agents → Workflows`: `x` stop, `p` pause (stops *starting* agents, running ones finish), `s` skip selected agent (its `agent()` returns `null`), `r` retry (running agents only), `c` open the agent's conversation. Headless: `pi -p --subagents-workflow-file=review.js` (use the `=` form).

Feature switch `workflowsEnabled` (default on; unset = auto — stands down if another extension offers a `Workflow`/`SubagentWorkflow` tool). Note: with workflows on, every session carries ~5k tokens of extra tool-spec context.

## Scheduling Agents

Run agents on cron, interval, or one-shot schedule:

```typescript
Agent({
  subagent_type: "Explore",
  prompt: "Review recent changes",
  description: "Weekly review",
  schedule: "0 0 9 * * 1",  // 9am every Monday (6-field cron)
})
```

Schedule formats:
- **Cron**: `"0 0 9 * * 1"` (second minute hour day month day-of-week)
- **Interval**: `"5m"`, `"1h"`, `"30s"`, `"2d"` (repeating)
- **One-shot relative**: `"+10m"`, `"+2h"`, `"+1d"` (fires once)
- **One-shot absolute**: `"2026-12-25T09:00:00.000Z"` (ISO timestamp)

**Restrictions**: Cannot combine `schedule` with `inherit_context` or `resume`. `run_in_background` is forced to `true`. Jobs are session-scoped; manage via `/agents → Scheduled jobs`; scheduled fires bypass the `maxConcurrent` queue.

## Tool & Extension Scoping

### Tools Field

```yaml
tools: read, grep, find  # Specific built-in tools
tools: "*"              # All 7 built-ins (alias: "all")
tools: none             # No built-ins (alias: "")
tools: "*, ext:pi-mcp-adapter/search"  # Built-ins plus specific extension tool
```
补充知识：限制subagent可见的mcp工具需要使用约束`tools: "ext:pi-mcp-adapter/[mcpServerName]_[toolName]"`

### Extensions Field

```yaml
extensions: true        # All default extensions (default)
extensions: false       # No extensions
extensions: [mcp]       # Only specific extensions
extensions: ["*", "/abs/foo.ts"]  # All defaults plus custom path
exclude_extensions: pi-notify  # Everything except listed
```

### Specialist Mode

```yaml
isolated: true  # Hermetic: built-ins only, no extensions/skills/context
```

## Settings Management

Configure via `/agents` → Settings (persisted to `<cwd>/.pi/subagents.json`; global defaults in `~/.pi/agent/subagents.json`):

- **Max concurrency**: Default 10 (background pool; raised from 4 when background became the default)
- **Max foreground concurrency**: Default 0 = unlimited; opt-in second pool for blocking `run_in_background: false` spawns (nested children and foreground resumes exempt)
- **Background by default**: `backgroundByDefault`, default true
- **Nested depth**: `maxSubagentDepth`, default 2
- **Fallback agent**: `fallbackSubagent`, default `general-purpose`; `none` = strict dispatch
- **Default max turns**: Unlimited by default
- **Grace turns**: 5 (graceful shutdown window)
- **Join mode**: `smart` (group 2+ agents), `async`, or `group`
- **Widget mode**: `all`, `background` (default), or `off`
- **Show model / Show cost / Report usage to session**: all off by default (see below)
- **Viewer markdown**: off / assistant (default) / all
- **Workflows**: `workflowsEnabled`, default on
- **Worktree isolation**: `worktreeIsolation`, default true; false removes `isolation` from the Agent tool schema entirely
- **Remember agents**: `rememberAgents`, default true (persist subagent sessions)
- **Fleet view**: Enable/disable navigable agent list
- **Model scope**: Enforce enabledModels allowlist (opt-in)
- **Output transcript**: Write agent transcripts (default: true)
- **Strict agent files**: Fail startup on a broken agent file (default: false)
- **Disable defaults**: Hide built-in agents (default: false)
- **Agent mentions**: `model` / `direct` / `off`

## Usage & Cost Reporting

Subagents run in their own sessions, so by default their spend never reaches the parent's footer/`/cost`:

- **`reportUsage`** (default off): each `Agent` / `get_subagent_result` / `steer_subagent` result carries the spend since the last one; pi folds it into session totals, attributed to `/cost`'s "Tools/summaries" bucket. `cacheRead` is included (it is genuinely re-billed per call); the context-window percentage is unaffected
- **`showCost`** (default off): an estimated `~$0.0042`-style cost beside token counts on every surface, with a batch total on grouped notifications. Only shown when pricing data exists
- Lifecycle events `subagents:completed`/`failed` carry a `usage` field (pi `Usage` shape, incl. `cacheRead` and `cost.total` in USD)

## Persistent Memory

Enable agent memory across sessions:

```yaml
---
memory: project  # project | local | user
---
```

| Scope | Location | Use case |
|-------|----------|----------|
| `project` | `.pi/agent-memory/<name>/` | Shared across team (committed) |
| `local` | `.pi/agent-memory-local/<name>/` | Machine-specific (gitignored) |
| `user` | `~/.pi/agent/agent-memory/<name>/` | Global personal memory |

Read-only agents (no write/edit tools) automatically get read-only memory.

## Worktree Isolation

Run agents in isolated git worktrees:

```typescript
Agent({
  subagent_type: "refactor",
  prompt: "Refactor the auth module",
  isolation: "worktree",
})
```

On completion:
- **No changes**: Worktree cleaned up automatically, no branch
- **Changes made**: Committed to `pi-agent-<id>` branch; the result names the branch and its `git merge` command
- **Agent committed work**: Branch created at agent's HEAD

Caveats:
- A worktree is a *copy* — the agent cannot see uncommitted/staged changes in the main checkout; never use it to review a working diff
- Declining one: `isolation: "off"` per call, `isolation: off` per agent file (frontmatter refuses the caller), or `worktreeIsolation: false` per project
- If the worktree cannot be created (not a git repo / no commits), the call fails — isolation is a strict guarantee, not a hint

## Events

Listen for lifecycle events via `pi.events`:

| Event | When |
|-------|------|
| `subagents:created` | `Agent`-tool background spawn or detached resume (not RPC/scheduler/@handle spawns) |
| `subagents:started` | Agent transitions to running |
| `subagents:completed` | Agent finished successfully — carries `tokens` and `usage` |
| `subagents:failed` | Agent errored, stopped, or aborted — carries `usage` too |
| `subagents:steered` | Steering message accepted (including queued) |
| `subagents:compacted` | Session successfully compacted |
| `subagents:scheduled` / `subagents:scheduler_ready` | Schedule lifecycle / scheduler armed |
| `subagents:settings_loaded` / `subagents:settings_changed` | Settings applied / mutated |
| `subagents:ready` | RPC handlers registered |

The four agent-lifecycle events (`started`/`completed`/`failed`/`compacted`) fire for **top-level agents only** — nested children and workflow agents emit nothing; they report through their owner.

## Cross-Extension RPC

Spawn sub-agents from other extensions:

```typescript
// Discovery
pi.events.on("subagents:ready", () => {
  // RPC handlers available
});

// Spawn
pi.events.emit("subagents:rpc:spawn", {
  requestId: crypto.randomUUID(),
  type: "general-purpose",
  prompt: "Do something useful",
  options: { description: "My task", run_in_background: true },
});

// Stop
pi.events.emit("subagents:rpc:stop", {
  requestId: crypto.randomUUID(),
  agentId: "agent-id-here",
});

// Consume: say the result has been shown, suppressing the completion notification
pi.events.emit("subagents:rpc:consume", {
  requestId: crypto.randomUUID(),
  agentId: "agent-id-here",
});
```

- A caller-supplied `options.model` is validated against `scopeModels` on this path too — out-of-scope is a hard error envelope
- `subagents:rpc:consume` is fire-and-forget and refused for running/unknown agents; full protocol in `reference/rpc.md`

## Best Practices

1. **Let agents background by default**: spawn in parallel and join via notifications; pass `run_in_background: false` only when the next step truly needs the full result inline
2. **Multiple foreground `Agent` calls in one message also run concurrently** (pi dispatches via `Promise.all`) — with local models, cap them via `maxConcurrentForeground`
3. **Set appropriate turn limits**: Use `max_turns` to prevent runaway agents
4. **Choose the right agent type**: Use `Explore` for read-only exploration, `Plan` for architecture
5. **Use `SubagentWorkflow` for deterministic fan-out**: map/reduce over a discovered list, generate-verify loops with `gate`, schema-validated results with `schema`
6. **Treat `allowed_subagents` as a privilege boundary**: list only agents whose tools you would grant directly
7. **Leverage scheduling**: Use cron/interval schedules for recurring tasks
8. **Enable worktree isolation**: Use `isolation: worktree` for experimental changes (mind the copy semantics)
9. **Preload skills**: Use `skills:` field to inject domain knowledge
10. **Monitor via `/agents` and FleetView**: steer with `Enter`, stop with `x`; use `@handle` to message/resume agents from the prompt

## Troubleshooting

### Agent Won't Start
- Check if agent type exists (case-insensitive); with `fallbackSubagent: none` an unknown type is refused
- Verify model is available/configured
- Ensure `.pi` directory has proper permissions
- With `backgroundByDefault`, the call returns an ID — the result arrives as a notification, not inline

### Model Resolution Fails
- Use exact `provider/modelId` format
- Try fuzzy names (`"haiku"`, `"sonnet"`)
- Check `enabledModels` in settings if scope enforcement is on — a caller-supplied out-of-scope model is a hard error (tool call *and* RPC); a frontmatter pin warns and runs
- Surfaces show the *effective* model/thinking, with `(asked X)` when the request was overridden or clamped

### Worktree Creation Fails
- Ensure directory is a git repo with at least one commit
- `isolation: worktree` is strict — it fails rather than running unisolated; check `worktreeIsolation` isn't off

### Transcripts Not Written
- Check `output_transcript: true` in agent config
- Verify `subagents.json` `outputTranscript` setting
- Check filesystem permissions

## Quick Reference

### Create a Custom Agent
1. Create `.pi/agents/<name>.md` (or `.agents/agents/`)
2. Define frontmatter and system prompt (`name:` is the dispatch type)
3. Spawn with `Agent({ subagent_type: "<name>", ... })` — runs in background unless told otherwise

### Manage Running Agents
- Open `/agents` menu (or `↓` at an empty prompt for FleetView)
- Select agent to open conversation viewer (`m` cycles markdown rendering; Ctrl+C/Esc/q close)
- Press `Enter` to steer, `x` to stop
- `/agents → Workflows` for run inspector (`p` pause, `s` skip, `r` retry, `c` conversation)

### Schedule Recurring Tasks
```typescript
Agent({
  subagent_type: "Explore",
  prompt: "Your task",
  description: "Task name",
  schedule: "0 */15 * * * *",  // Every 15 minutes
})
```

### Enable Persistent Memory
```yaml
---
memory: project
---
```

## Resources

- Main documentation: `reference/README.md`
- Workflow guide: `reference/workflows.md`
- Cross-extension RPC protocol: `reference/rpc.md`
- Example tool descriptions: `examples/agent-tool-description.md`

## 补充知识：

- 限制subagent可见的mcp工具需要使用约束`tools: "ext:pi-mcp-adapter/[mcpServerName]_[toolName]"`.
- 默认情况下不写model参数，继承主线模型.
