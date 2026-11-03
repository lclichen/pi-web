/**
 * 管理员"支持视图"的接管状态（2026-11-03）。
 *
 * 默认：管理员打开普通用户的**运行中**会话是只读的（可看事件/状态，不能
 * prompt/steer/abort/set_*）。点击"接管"后，本进程内为该 (sessionId, adminId)
 * 记录 1 小时写入许可；页面刷新/进程重启自动失效（安全默认）。
 *
 * 只存内存：这是支持操作的临时授权，不应该跨重启或跨管理员共享。
 */

const TAKEOVER_TTL_MS = 60 * 60 * 1000;

declare global {
  var __piAdminTakeovers: Map<string, number> | undefined;
}

function store(): Map<string, number> {
  globalThis.__piAdminTakeovers ??= new Map();
  return globalThis.__piAdminTakeovers;
}

function key(sessionId: string, userId: number): string {
  return `${sessionId}\u0000${userId}`;
}

export function setAdminTakeover(sessionId: string, userId: number, active: boolean): void {
  const map = store();
  const k = key(sessionId, userId);
  if (active) map.set(k, Date.now() + TAKEOVER_TTL_MS);
  else map.delete(k);
}

export function hasAdminTakeover(sessionId: string, userId: number): boolean {
  const map = store();
  const k = key(sessionId, userId);
  const expiresAt = map.get(k);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    map.delete(k);
    return false;
  }
  return true;
}

/** 会话结束/删除时清理该会话的全部接管记录。 */
export function clearAdminTakeovers(sessionId: string): void {
  const map = store();
  const prefix = `${sessionId}\u0000`;
  for (const k of map.keys()) {
    if (k.startsWith(prefix)) map.delete(k);
  }
}

/** 支持视图的只读命令：查看类命令一律以 get_ 开头；其余都算写入。 */
export function isReadOnlyAgentCommand(type: string): boolean {
  return type.startsWith("get_");
}
