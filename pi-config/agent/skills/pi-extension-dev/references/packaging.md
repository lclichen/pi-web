# Packaging, loading & SDK embedding

## Auto-discovery locations

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/*.ts` | Global (all projects) |
| `~/.pi/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.pi/extensions/*.ts` | Project-local |
| `.pi/extensions/*/index.ts` | Project-local (subdirectory) |

- Project-local entries load ONLY after the project is trusted.
- Auto-discovered extensions hot-reload with `/reload`.

Three supported shapes:
1. **Single file** — `my-ext.ts`.
2. **Directory** — `my-ext/index.ts` (+ relative imports).
3. **Package** — `package.json` + deps (next section).

## `settings.json` arrays

```json
{
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ],
  "extensions": [
    "/path/to/local/extension.ts",
    "/path/to/local/extension/dir"
  ]
}
```

Package sources: `npm:@scope/pkg@1.2.3`, `npm:pkg`, `git:github.com/user/repo@v1`,
`git:git@github.com:user/repo@v1`, `https://...`, `ssh://...`, `/absolute/path`,
`./relative/path`.

## `-e` / `--extension` flag (one-off test; also accepts npm/git sources)
```bash
pi -e ./my-extension.ts
pi -e npm:@foo/bar
pi -e git:github.com/user/repo
```
Loads for the current run only (temporary directory).

## Package filtering (object form in settings)
```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```
- Omit key → load all of that type. `[]` → load none.
- `!pattern` excludes. `+path` force-includes exact path. `-path` force-excludes.
- Filters narrow what the manifest already allows.

Scope/dedup identity: npm by package name; git by repo URL (without ref); local by resolved absolute path. Project entry wins unless it has `autoload: false` (then applied as a delta over global).

## The `package.json` `pi` manifest

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```
- Paths relative to package root. Arrays support glob patterns + `!exclusions`.
- Tag `pi-package` to appear in the [gallery](https://pi.dev/packages).

### Convention directories (if no `pi` manifest)
- `extensions/` loads `.ts`/`.js`.
- `skills/` recursively finds `SKILL.md` folders; top-level `.md` files load as skills.
- `prompts/` loads `.md`.
- `themes/` loads `.json`.

### Gallery fields (optional)
```json
{
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```
- `video`: MP4 only; desktop autoplays on hover, click opens fullscreen.
- `image`: PNG/JPEG/GIF/WebP; static preview.
- Both set → video takes precedence.

## Dependency rules (critical)

| Dep type | Where to declare | Bundle? |
|----------|------------------|---------|
| Third-party runtime deps | `dependencies` | Yes (normal npm). |
| **Core pi packages** (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) | `peerDependencies` with `"*"` | **NO** — never bundle; the host provides them. |
| **Other pi packages** (resource deps) | `dependencies` AND `bundledDependencies` | Yes — reference through `node_modules/` paths. |
| Dev-only tools (`typescript`, `vitest`, type-only `@types/*`) | `devDependencies` | No — `pi install` uses `npm install --omit=dev`, so they're NOT at runtime. |

```json
{
  "dependencies": { "some-pi-pkg": "^1.0.0" },
  "bundledDependencies": ["some-pi-pkg"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  },
  "pi": {
    "extensions": ["extensions", "node_modules/some-pi-pkg/extensions"],
    "skills": ["skills", "node_modules/some-pi-pkg/skills"]
  }
}
```

For TS type-only imports of the host SDK in a dev setting (so `tsc` works
without the host installed), you can declare a local ambient `.d.ts` shim and
point your build config at it — keep the runtime import names intact so jiti
resolves them against the host at load time. (This is how the `pi-flowflow`
project does it.)

## Install
```
pi install npm:@scope/pkg@1.0.0
pi install git:github.com/user/repo@v1
pi install /abs/path/to/local/package
```
Uses `npm install --omit=dev` by default (so `devDependencies` are unavailable).
With `npmCommand` configured, git packages use plain `install`.

## SDK embedding (`createAgentSession`)

When you want to run pi inside another Node app rather than as a loaded extension:

```typescript
import { createAgentSession, DefaultResourceLoader, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd: "/path/to/project",
  // systemPromptOverride?: string,
  extensionFactories: [
    (pi) => { pi.on("agent_start", () => console.log("starting")); },
    { name: "my-inline", factory: (pi) => { /* ... */ } },  // named inline
  ],
  // extensionsOverride / skillsOverride / promptsOverride / themesOverride
});
await loader.reload();

const { session } = await createAgentSession({
  model,                          // optional
  thinkingLevel,                  // optional
  tools: ["read","bash","my_tool"],
  customTools: [myTool],          // ToolDefinition[]
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),  // or SessionManager.create(cwd) / .open(sessionFile)
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("What files are here?");
console.log(session.state.messages);
session.dispose();
```

Key types/exports: `ModelRuntime`, `ModelRegistry`, `createEventBus`, run modes
(`InteractiveMode`, `runPrintMode`, `runRpcMode`), `resolveCliModel`,
`resolveModelScopeWithDiagnotics`, `getAgentDir`, `getPackageDir`, `defineTool`,
`createReadTool`/`createBashTool`/..., `withFileMutationQueue`, truncation
helpers, `InlineExtension = { name: string; factory: ExtensionFactory }`,
`ExtensionFactory`, `ToolDefinition`, `Skill`, `PromptTemplate`, plus (0.84)
the services split `createAgentSessionServices` + `createAgentSessionFromServices`
and `SessionManager.create/open/inMemory`.

`createAgentSession(options?) → { session }`:
- `session.subscribe(event => ...)` — events: `message_update` (with `assistantMessageEvent`), `tool_execution_start`/`_end`, `agent_end`, etc.
- `session.prompt(text)` — run a turn.
- `session.state.messages` — the conversation.
- `session.dispose()` — clean up.
- No options → auto-discovers skills/extensions/tools/context from `cwd` and `~/.pi/agent`.
- `noTools?: "all" | "builtin"` — default tool suppression when no allowlist:
  `"all"` starts with nothing, `"builtin"` disables the default built-ins
  (read/bash/edit/write) but keeps extension/custom tools.
- `tools` allowlist: when provided, only the listed names are active; otherwise
  the `defaultTools` setting selects the initial built-ins and
  extension/custom tools stay enabled.

### Services split (0.84): `createAgentSessionServices` + `createAgentSessionFromServices`

When you need control over settings/trust/resource loading (e.g. hosts that
build the session from a web request), build the services first and create the
session from them:

```typescript
import {
  createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, SettingsManager, ModelRuntime,
} from "@earendil-works/pi-coding-agent";

const services = await createAgentSessionServices({
  cwd, agentDir,
  settingsManager: SettingsManager.create(cwd, agentDir),
  // modelRuntime?: ModelRuntime — per-project auth.json/models.json override
  resourceLoaderOptions: {
    // same fields as DefaultResourceLoaderOptions minus cwd/agentDir/settingsManager:
    extensionFactories: [{ name: "my-inline", factory: (pi) => { /* ... */ } }],
    additionalExtensionPaths: ["/extra/ext/dir"],
    appendSystemPrompt: ["extra guidance"],
    extensionsOverride: (base) => base, // filter/replace loaded extensions
    // noExtensions / noSkills / noPromptTemplates / noThemes / noContextFiles
  },
  resourceLoaderReloadOptions, // e.g. project-trust gating for reloads
});

const { session } = await createAgentSessionFromServices({
  services,
  sessionManager: SessionManager.create(cwd),
  model, thinkingLevel,          // optional
  scopedModels,                  // optional [{ model, thinkingLevel? }]
  tools: ["read", "bash", "my_tool"],  // optional allowlist
  excludeTools: [...],           // optional denylist
});
```
Why split: extension-registered providers must be available before the saved
model is restored, and cwd-bound options (trust, project credentials) resolve
against the built services — one `createAgentSession` call cannot order these
correctly. `createAgentSession` remains the one-shot convenience form.

## Where to find concrete examples
~60 example extensions live in `pi/packages/coding-agent/examples/extensions/`
(minimal tool, stateful tool, dynamic tools, truncation, override, permission
gate, system-prompt mod, plan-mode, subagent, custom providers, event bus, send
message, sandbox, games, editors). SDK examples in
`pi/packages/coding-agent/examples/sdk/01-minimal.ts` … `13-session-runtime.ts`.
These are the best source of verbatim patterns when implementing.
