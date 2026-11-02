/**
 * share_file — the Agent-side entry point for share links
 * (docs/dev/mcp-file-sharing.md §3.4).
 *
 * Registered as an inline extension per session (same pattern as bg_run /
 * plan_save): the tool runs INSIDE the pi-web server process and calls the
 * share store directly — no HTTP, no cookie. The model gets a bearer URL and
 * hands it to an MCP tool as a file_url-style argument instead of pasting
 * file contents (which would have to travel through the model's own output).
 *
 * Modes:
 *   · host          — live share fenced to the session cwd; GET re-reads.
 *   · sandbox /
 *     local-machine /
 *     ssh           — SNAPSHOT share: bytes captured through the same remote
 *                      bridge remotefs uses (remoteReadBinary) at call time.
 *                      The link keeps working after the container/agent stops.
 */
import { defineTool, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { join, resolve, sep } from "node:path";
import { statSync } from "node:fs";
import { createShare, SHARE_MAX_BYTES, ShareLimitError } from "../share-store.ts";
import { remoteReadBinary, type RemoteSessionContext } from "../remote-session.ts";
import { getPreviewMime } from "../file-types.ts";
import { getPublicBaseUrl } from "../server-settings.ts";

export interface ShareFileExtensionOptions {
  ownerId: number;
  ownerName: string;
  mode: "host" | "sandbox" | "local-machine" | "ssh";
  /** Session cwd — host-mode fence root. */
  cwd: string;
  /** Remote backend context; required for the three remote modes. */
  remote?: RemoteSessionContext;
}

function baseUrl(): string {
  // 管理员在「全局配置」里设置的对外地址（PI_WEB_PUBLIC_URL 播种）；没有则
  // 回落到本机地址（本机开发/单机部署下 MCP 服务同样能访问）。
  return getPublicBaseUrl() ?? "http://127.0.0.1:30141";
}

/** Uniform details shape for every return path (TS otherwise infers a union
 *  of `{}`-vs-populated object types that does not unify). */
interface ShareDetails {
  url?: string;
  expiresAt?: number;
  kind?: "host" | "snapshot";
}

function isAbsoluteLike(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(p);
}

function withinRoot(child: string, root: string): boolean {
  const c = resolve(child);
  const r = resolve(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

export function makeShareFileExtension(opts: ShareFileExtensionOptions): InlineExtension {
  return (pi: ExtensionAPI): void => {
    let sessionId = "";
    pi.on("session_start", async (_event, ctx) => {
      // Optional-chained on purpose: trimmed contexts must not throw here.
      sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
    });

    pi.registerTool(
      defineTool({
        name: "share_file",
        label: "Share File",
        description:
          "Create a time-limited download link for ONE file so an external service (e.g. an MCP server) " +
          "can fetch it over HTTP. Use this instead of pasting file contents into tool arguments. " +
          "Returns the URL, expiry time and download quota — pass the URL as the tool's file/url parameter.",
        promptSnippet: "share_file — create a shareable HTTP link for a file (for MCP services to fetch)",
        promptGuidelines: [
          "When a tool or MCP service needs a file, call share_file and pass the returned URL instead of pasting the file's content into arguments.",
          "Links are short-lived (default 30 minutes, 10 downloads) — create one when needed, do not cache old links; re-run share_file for a fresh one.",
        ],
        parameters: Type.Object({
          path: Type.String({
            description: "File to share — workspace-relative (e.g. report.pdf) or absolute.",
          }),
          ttl_minutes: Type.Optional(Type.Number({ description: "Link lifetime in minutes (default 30, max 1440)." })),
          max_downloads: Type.Optional(Type.Number({ description: "Maximum fetches allowed (default 10, max 100)." })),
        }),
        execute: async (_toolCallId, params) => {
          const raw = (params.path ?? "").trim();
          if (!raw) {
            return {
              content: [{ type: "text", text: "Error: path is required" }],
              details: {} as ShareDetails,
              isError: true,
            };
          }
          const fileName = raw.replace(/\\/g, "/").split("/").pop() || "file";
          try {
            if (opts.mode === "host") {
              // Live share fenced to the session workspace.
              const abs = isAbsoluteLike(raw) ? resolve(raw) : resolve(join(opts.cwd, raw));
              if (!withinRoot(abs, opts.cwd)) {
                return {
                  content: [{ type: "text", text: `Error: 路径超出会话工作区（${opts.cwd}）：${raw}` }],
                  details: {} as ShareDetails,
                  isError: true,
                };
              }
              let stat;
              try {
                stat = statSync(abs);
              } catch {
                return {
                  content: [{ type: "text", text: `Error: 文件不存在：${raw}` }],
                  details: {} as ShareDetails,
                  isError: true,
                };
              }
              if (!stat.isFile()) {
                return {
                  content: [{ type: "text", text: `Error: 只能分享文件：${raw}` }],
                  details: {} as ShareDetails,
                  isError: true,
                };
              }
              if (stat.size > SHARE_MAX_BYTES) {
                return {
                  content: [{ type: "text", text: `Error: 文件过大（> ${SHARE_MAX_BYTES} 字节）` }],
                  details: {} as ShareDetails,
                  isError: true,
                };
              }
              const { token, entry } = createShare({
                path: raw,
                fileName,
                ownerId: opts.ownerId,
                ownerName: opts.ownerName,
                ...(sessionId ? { sessionId } : {}),
                ...(params.ttl_minutes !== undefined ? { ttlMinutes: params.ttl_minutes } : {}),
                ...(params.max_downloads !== undefined ? { maxDownloads: params.max_downloads } : {}),
                host: { hostPath: abs, hostRoot: opts.cwd, size: stat.size },
              });
              const url = `${baseUrl()}/api/share/${token}`;
              return {
                content: [
                  {
                    type: "text",
                    text:
                      `Share link created (kind=host, expires ${new Date(entry.expiresAt).toISOString()}, ` +
                      `max ${entry.maxDownloads} downloads):\n${url}\n` +
                      `Pass this URL to the MCP tool's file/url parameter. Do NOT paste the file contents.`,
                  },
                ],
                details: { url, expiresAt: entry.expiresAt, kind: "host" } as ShareDetails,
              };
            }

            // Remote modes: snapshot through the remotefs bridge now.
            if (!opts.remote) {
              return {
                content: [{ type: "text", text: `Error: ${opts.mode} 会话未配置远程读取通道` }],
                details: {} as ShareDetails,
                isError: true,
              };
            }
            let bytes: Buffer;
            try {
              bytes = (await remoteReadBinary(opts.remote, raw)).bytes;
            } catch (e) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: 读取远程文件失败（${e instanceof Error ? e.message : String(e)}）——容器/Agent 可能离线`,
                  },
                ],
                details: {} as ShareDetails,
                isError: true,
              };
            }
            if (bytes.length === 0) {
              return {
                content: [{ type: "text", text: `Error: 文件为空：${raw}` }],
                details: {} as ShareDetails,
                isError: true,
              };
            }
            if (bytes.length > SHARE_MAX_BYTES) {
              return {
                content: [{ type: "text", text: `Error: 文件过大（> ${SHARE_MAX_BYTES} 字节）` }],
                details: {} as ShareDetails,
                isError: true,
              };
            }
            const { token, entry } = createShare({
              path: raw,
              fileName,
              ownerId: opts.ownerId,
              ownerName: opts.ownerName,
              ...(sessionId ? { sessionId } : {}),
              ...(opts.remote.mode !== "host" ? { srcSession: sessionId } : {}),
              ...(params.ttl_minutes !== undefined ? { ttlMinutes: params.ttl_minutes } : {}),
              ...(params.max_downloads !== undefined ? { maxDownloads: params.max_downloads } : {}),
              snapshot: { bytes, mime: getPreviewMime(raw) ?? "application/octet-stream" },
            });
            const url = `${baseUrl()}/api/share/${token}`;
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Share link created (kind=snapshot — 内容为当前快照, expires ` +
                    `${new Date(entry.expiresAt).toISOString()}, max ${entry.maxDownloads} downloads):\n${url}\n` +
                    `Pass this URL to the MCP tool's file/url parameter. Do NOT paste the file contents.`,
                },
              ],
              details: { url, expiresAt: entry.expiresAt, kind: "snapshot" } as ShareDetails,
            };
          } catch (err) {
            if (err instanceof ShareLimitError) {
              return {
                content: [{ type: "text", text: `Error: ${err.message}` }],
                details: {} as ShareDetails,
                isError: true,
              };
            }
            return {
              content: [
                { type: "text", text: `Error creating share: ${err instanceof Error ? err.message : String(err)}` },
              ],
              details: {} as ShareDetails,
              isError: true,
            };
          }
        },
      }),
    );
  };
}
