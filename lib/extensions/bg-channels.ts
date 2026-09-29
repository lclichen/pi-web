/**
 * Server-side BgExecChannel implementations for pi-web's remote modes
 * (harness-research/09 方案). The bg-shell extension in amedac-core talks to
 * these via registerBgChannel(sessionId, channel) — one-shot `run` per mode:
 *
 *   ssh           → sshExec over the project's pooled ssh2 client
 *   sandbox       → platform POST /containers/:id/tools/bash
 *   local-machine → relay RPC exec.run
 *
 * Host mode (and the pi CLI) need no registration: the extension falls back
 * to its local spawn executor.
 */
import { getSshClient, sshExec, type SshConfig } from "../ssh";
import { relayRpc } from "../relay/forward";
import { platformPost } from "../platform/client";
import type { BgExecChannel } from "./bg-shell";

interface UnifiedResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function makeSshBgChannel(projectId: string, sshConfig: SshConfig, workdir: string): BgExecChannel {
  return {
    label: "ssh",
    kind: "remote",
    run: async (command, timeoutMs = 30_000) => {
      const client = await getSshClient(projectId, sshConfig);
      const r = await sshExec(client, command, workdir || ".", timeoutMs);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code };
    },
  };
}

export function makeSandboxBgChannel(apiKey: string, containerId: number): BgExecChannel {
  return {
    label: "sandbox",
    kind: "remote",
    run: async (command, _timeoutMs) => {
      // Platform tools/bash runs inside the container; its own timeout policy
      // applies server-side.
      const r = await platformPost<{ stdout?: string; stderr?: string; exitCode?: number | null; exit_code?: number | null }>(
        `/api/v1/containers/${containerId}/tools/bash`,
        apiKey,
        { command },
      );
      return {
        stdout: r?.stdout ?? "",
        stderr: r?.stderr ?? "",
        exitCode: r?.exitCode ?? r?.exit_code ?? null,
      };
    },
  };
}

export function makeRelayBgChannel(userId: number, machineId?: string): BgExecChannel {
  return {
    label: "local-machine",
    kind: "remote",
    run: async (command, timeoutMs = 30_000) => {
      const r = (await relayRpc("exec.run", { command, timeout: timeoutMs }, { userId, machineId })) as
        | { stdout?: string; stderr?: string; exitCode?: number | null; code?: number | null }
        | undefined;
      return {
        stdout: r?.stdout ?? "",
        stderr: r?.stderr ?? "",
        exitCode: r?.exitCode ?? r?.code ?? null,
      };
    },
  };
}
