import { join, resolve, sep } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { WebSession }  from "./web-session";

/**
 * Session spaces (design doc §4.1): the platform CLI keeps writing to the
 * global sessions directory (= the Host space); each logged-in web user gets
 * a sharded directory. Isolation is a path fence — a resolved session file
 * must live inside the requesting space or the answer is 404.
 */

export type SessionSpace =
  | { kind: "host" }
  | { kind: "user"; userId: number };

export function sessionsRoot(): string {
  return join(getAgentDir(), "sessions");
}

export function spaceDir(space: SessionSpace): string {
  return space.kind === "host"
    ? sessionsRoot()
    : join(sessionsRoot(), "users", `u${space.userId}`);
}

export function spaceKey(space: SessionSpace): string {
  return space.kind === "host" ? "host" : `u${space.userId}`;
}

/** Path fence: does this session file belong to the space? */
export function isPathInSpace(filePath: string, space: SessionSpace): boolean {
  const dir = resolve(spaceDir(space));
  const p = resolve(filePath);
  if (space.kind === "host") {
    // Host space is the sessions root MINUS the users/ shard directory.
    const usersDir = resolve(join(sessionsRoot(), "users"));
    return (p === dir || p.startsWith(dir + sep)) && !(p === usersDir || p.startsWith(usersDir + sep));
  }
  return p === dir || p.startsWith(dir + sep);
}

/**
 * The space serving this request: with auth off everything is the host
 * space (single-user status quo, CLI sessions visible); with auth on the
 * caller's user shard, unless an admin explicitly asks for the host space.
 */
export function spaceForRequest(session: WebSession, searchParams?: URLSearchParams): SessionSpace {
  if (session.user.id === 0) return { kind: "host" }; // implicit host identity (auth off)
  if (searchParams?.get("space") === "host" && session.user.role === "admin") {
    return { kind: "host" };
  }
  return { kind: "user", userId: session.user.id };
}
