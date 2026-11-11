# Remote workspace operations (draft v1)

Status: **draft**. The SDK-level tool-factory path below works today. The
pi-web event bridge and the four mode adapters are **not wired yet**; this
document fixes the contract so adapter work and third-party extensions can
target one shape.

## What already works today

The pi SDK exposes the mode-neutral building blocks:

```ts
createReadTool(cwd, { operations })
createWriteTool(cwd, { operations })
createEditTool(cwd, { operations })
createBashTool(cwd, { operations })
createLsTool(cwd, { operations })
```

with public operation interfaces `ReadOperations`, `WriteOperations`,
`EditOperations`, `BashOperations`, `LsOperations`, `GrepOperations` and
`FindOperations`. An extension can already implement those interfaces over
its own transport and override a built-in tool by registering the same name.
Sandbox mode in this repository uses exactly that path.

`GrepOperations`/`FindOperations` are not enough to move the whole search
remote: the built-in `grep`/`find` tools still use the host's ripgrep/fd. A
remote workspace provider therefore also needs `grep`/`find` methods (below);
the sandbox mode already routes those through platform APIs.

## Proposed provider contract

All paths are either workspace-relative POSIX or absolute inside the
provider's namespace. `canonicalize` must resolve both and reject escapes.

```ts
const WORKSPACE_API_VERSION = 1 as const;

type WorkspaceErrorCode =
  | "OUT_OF_SCOPE" | "NOT_FOUND" | "READ_ONLY"
  | "UNSUPPORTED" | "CANCELLED" | "EXEC_FAILED";

interface WorkspaceStat { isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number }
interface WorkspaceDirEntry { name: string; isDirectory: boolean; size: number }

interface WorkspaceExecOptions {
  cwd?: string;
  timeout?: number;            // seconds, same as the built-in bash tool
  signal?: AbortSignal;
  env?: Record<string, string>;
  onData?: (chunk: Buffer) => void;
}
interface WorkspaceExecResult { exitCode: number | null; stdout: string; stderr: string }

interface WorkspaceOperations {
  version: 1;
  root: string;                // display/diagnostic only
  capabilities: { read: boolean; write: boolean; exec: boolean; grep?: boolean; find?: boolean };

  canonicalize(path: string): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<WorkspaceStat>;
  readdir(path: string): Promise<WorkspaceDirEntry[]>;
  exec(command: string, options?: WorkspaceExecOptions): Promise<WorkspaceExecResult>;
  grep?(options: { pattern: string; path?: string; glob?: string; literal?: boolean; ignoreCase?: boolean; context?: number; limit?: number }): Promise<string>;
  find?(options: { pattern: string; path?: string; limit?: number }): Promise<string[]>;
}
```

Rules:

- `root` is never a host credential or a path the extension may read
  directly. The provider enforces containment; extensions must not bypass it
  with local `node:fs`.
- Write methods throw `READ_ONLY` when `capabilities.write` is false; exec
  throws `READ_ONLY` when `capabilities.exec` is false.
- `exec` streams through `onData` and also returns the full captured
  output. A non-streaming adapter may call `onData` once before resolving.
- `grep`/`find` are optional. If unavailable, set the capability false and
  return `UNSUPPORTED` from the method.
- Unknown methods/fields must be rejected or ignored per the bridge version;
  additive changes keep `version: 1`.

`pi-web` has a reference adapter module (`lib/workspace-operations.ts`) that
converts this provider to the SDK's `Read/Write/Edit/Ls/BashOperations`.

## Event bridge protocol (proposed)

Extensions reach the host-owned provider over the shared extension event bus,
so they never receive SSH passwords, relay tokens or platform API keys.

Request event: `pi-web:workspace:request`

```ts
{ v: 1, id: string, method: string, params?: unknown }
```

Reply event: `pi-web:workspace:reply:<id>`

```ts
{ v: 1, id: string, ok: true, result: unknown }
| { v: 1, id: string, ok: false, error: { code: WorkspaceErrorCode; message: string } }
```

Methods and params:

| Method | Params | Result |
|---|---|---|
| `capabilities` | — | `{ read, write, exec, grep?, find? }` |
| `canonicalize` | `{ path }` | canonical path string |
| `readFile` | `{ path }` | base64 string |
| `writeFile` | `{ path, dataBase64 }` | `null` |
| `mkdir` | `{ path }` | `null` |
| `stat` | `{ path }` | `WorkspaceStat` |
| `readdir` | `{ path }` | `WorkspaceDirEntry[]` |
| `exec` | `{ command, cwd?, timeout?, env? }` | `{ exitCode, stdout, stderr }` (no streaming over the bus) |
| `grep` | `WorkspaceGrepOptions` | string |
| `find` | `WorkspaceFindOptions` | string[] |

The host must cap request/response sizes, apply a per-request timeout, and
enforce the same path guard as the built-in tools. Streaming exec is only
available through the in-process SDK adapter; the event bridge returns the
final result.

## Mode semantics

| Mode | `root` namespace | Transport behind the provider |
|---|---|---|
| host | server project cwd | local fs + pi local shell operations |
| sandbox | `/workspace` in the container | platform REST (`tools.*`) |
| local-machine | project `workdir` on the paired machine | relay RPC (`fs.*`, `exec.run`) |
| ssh | remote `workdir` | SSH exec + SFTP |

Runtime-config files (`skills/`, `agents/`, `AGENTS.md`) may live on the pi-web
server rather than in the remote workspace. The provider must implement the
same config bridge the mode extensions use; an extension must not assume a
skill file is in the remote root.

## How an extension uses it (once wired)

```ts
// Ask the host for the current session's workspace (event bridge).
async function workspaceRequest(pi: ExtensionAPI, method: string, params?: unknown) {
  const id = crypto.randomUUID();
  const reply = new Promise<any>((resolve, reject) => {
    const event = `pi-web:workspace:reply:${id}`;
    const off = pi.events.on(event, (msg: any) => {
      off();
      if (msg.ok) resolve(msg.result);
      else reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    });
  });
  pi.events.emit("pi-web:workspace:request", { v: 1, id, method, params });
  return reply;
}
```

To override a built-in tool, obtain the provider from the host adapter and
pass the SDK operation wrappers; do not re-implement path containment in the
extension.

## Implementation checklist

- [ ] `lib/workspace-operations.ts` — provider contract + SDK adapters (done)
- [ ] host / sandbox / relay / ssh adapters behind the contract
- [ ] host event bridge extension (`pi-web:workspace:request`)
- [ ] wire the bridge into agent-new, restore, subagent bridge and batch
- [ ] add `WORKSPACE_API_VERSION` negotiation and capability tests
- [ ] document the bridge as stable only after the adapters ship

Until the checklist is complete, use the SDK `*Operations` path for your own
transport, and do not depend on `pi-web:workspace:*` events in production.
