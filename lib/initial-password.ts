/**
 * 初始管理员密码的首启发现（无终端日志场景）。
 *
 * 打包部署由启动器生成随机初始密码并落盘 admin-password.txt（属主可读），
 * 正常引导靠启动日志里的打印——但桌面图标 Terminal=false 双击时日志不可见，
 * 非程序员用户找不到密码。本模块把「文件仍在且密码仍有效」暴露给登录页：
 *
 * - 只有 Host 为回环（127.0.0.1/localhost/[::1]）的请求才能拿到密码明文：
 *   本机浏览器（自动打开或手动访问 127.0.0.1）可见；局域网其他机器用
 *   10.x/域名访问时只看到提示，不泄露。
 * - 有效性经平台 /auth/login 实测（文件可能残留于已改密之后——删除文件
 *   是引导语里的手动步骤，不能信任其存在性）。
 * - 首次用初始密码成功登录后由 login 路由删除文件，窗口自动关闭。
 */
import { readFileSync, unlinkSync } from "node:fs";

/** 部署启动器注入的密码文件路径（packaging/start-all.sh）。 */
export function initialPasswordFile(): string | null {
  return process.env.PI_WEB_INITIAL_PASSWORD_FILE?.trim() || null;
}

export function readInitialPassword(): string | null {
  const file = initialPasswordFile();
  if (!file) return null;
  try {
    const value = readFileSync(file, "utf8").trim().split(/\r?\n/)[0] ?? "";
    return value || null;
  } catch {
    return null;
  }
}

/** 登录成功且用的是初始密码 → 删文件（首启窗口自动关闭；幂等）。 */
export function consumeInitialPasswordIfMatch(usedPassword: string): boolean {
  const file = initialPasswordFile();
  const initial = readInitialPassword();
  if (!file || !initial) return false;
  if (usedPassword !== initial) return false;
  try {
    unlinkSync(file);
  } catch { /* 已被并发删除/权限问题——banner 最多多显示一轮 */ }
  return true;
}

/** Host 头的主机名是否回环（本机浏览器直连 127.0.0.1 / localhost）。
 *  IPv6 形如 [::1]:30141——先取 ] 前的整段，再比较带括号形式。 */
export function isLoopbackHost(req: Request): boolean {
  const raw = req.headers.get("host")?.toLowerCase() ?? "";
  const hostname = raw.startsWith("[")
    ? raw.slice(0, raw.indexOf("]") + 1)
    : raw.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}
