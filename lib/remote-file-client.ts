"use client";

import { encodeFilePathForApi } from "./file-paths";

/**
 * Client helpers for mode-scoped panels: when the active session runs in a
 * remote mode (sandbox / local-machine), the file explorer, file viewer, and
 * workspace terminal switch their API base from the local /api/files and
 * /api/terminal groups to /api/remotefs and /api/remoteterminal, carrying the
 * session id as ?src=.
 */

export type RemoteMode = "host" | "sandbox" | "local-machine" | "ssh";

export function isRemoteMode(mode: RemoteMode | undefined): boolean {
  return mode === "sandbox" || mode === "local-machine";
}

export function remoteFileUrl(
  filePath: string,
  type: "list" | "read" | "download" | "meta",
  sessionId: string,
): string {
  return `/api/remotefs/${encodeFilePathForApi(filePath)}?src=${encodeURIComponent(sessionId)}&type=${type}`;
}

export function remoteFileWriteUrl(filePath: string, sessionId: string): string {
  return `/api/remotefs/${encodeFilePathForApi(filePath)}?src=${encodeURIComponent(sessionId)}`;
}

export const REMOTE_TERMINAL_BASE = "/api/remoteterminal";
