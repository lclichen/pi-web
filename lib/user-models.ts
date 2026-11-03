/**
 * Per-user model configuration (多用户部署).
 *
 * 语义（用户 2026-11-03 定策）：
 *   · 管理员改的是**全局层**（`~/.pi/agent/models.json` / `auth.json`），所有普通
 *     用户默认使用；
 *   · 普通用户改的是**自己的层**（`<dataDir>/user-models/u<id>/`），只影响自己，
 *     不碰全局文件，也不会把全局密钥抄进自己的文件；
 *   · 运行时按「全局 → 用户 → 项目」合并：项目 home 的 `.pi/` 仍是最高优先
 *     （projectCredentialDir），其次是用户层，最后回全局。
 *
 * 存储：
 *   <dataDir>/user-models/u<id>/models.json   用户模型目录（只存与全局不同的
 *                                             provider；等于全局的条目会被省略，
 *                                             避免快照化全局配置）
 *   <dataDir>/user-models/u<id>/auth.json     用户 provider 凭据（0600）
 *   <dataDir>/user-runtime/u<id>/{models,auth}.json
 *                                             合并后的运行时副本（0600，派生文件；
 *                                             每次会话启动/配置变更时重算）
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dataDir } from "./mode-homes";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { readModelsConfig } from "./models-config-store";

export interface ModelCredentialPaths {
  modelsPath: string;
  authPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** 稳定序列化（键排序）用于"是否等于全局条目"的比较。 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function globalModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

export function globalAuthPath(): string {
  return join(getAgentDir(), "auth.json");
}

export function userModelDir(userId: number): string {
  return join(dataDir(), "user-models", `u${userId}`);
}

export function userModelsPath(userId: number): string {
  return join(userModelDir(userId), "models.json");
}

export function userAuthPath(userId: number): string {
  return join(userModelDir(userId), "auth.json");
}

/** 凭据写入位置：管理员=全局；普通用户=自己的 auth.json。 */
export function credentialAuthPath(userId: number, isAdmin: boolean): string {
  return isAdmin ? globalAuthPath() : userAuthPath(userId);
}

export function readUserModels(userId: number): Record<string, unknown> | null {
  return readJson(userModelsPath(userId));
}

export function readUserAuth(userId: number): Record<string, unknown> | null {
  return readJson(userAuthPath(userId));
}

export function hasUserModelOverride(userId: number): boolean {
  return existsSync(userModelsPath(userId)) || existsSync(userAuthPath(userId));
}

/** 合并全局 + 用户（provider 级浅合并：用户没写的字段保留全局值，如 apiKey）。 */
export function effectiveModelsConfig(userId: number): Record<string, unknown> {
  const global = readModelsConfig(globalModelsPath());
  const user = readUserModels(userId);
  if (!user) return global;
  const globalProviders = isRecord(global.providers) ? global.providers : {};
  const userProviders = isRecord(user.providers) ? user.providers : {};
  const providers: Record<string, unknown> = { ...globalProviders };
  for (const [name, entry] of Object.entries(userProviders)) {
    const base = isRecord(providers[name]) ? providers[name] : {};
    providers[name] = isRecord(entry) ? { ...base, ...entry } : entry;
  }
  return { ...global, ...user, providers };
}

/** 合并全局 + 用户凭据（用户同名 provider 覆盖全局）。 */
export function effectiveAuthConfig(userId: number): Record<string, unknown> {
  const global = readJson(globalAuthPath()) ?? {};
  const user = readUserAuth(userId) ?? {};
  return { ...global, ...user };
}

/**
 * 写入用户模型配置：只保存与全局不同的 provider。
 *
 * - 与全局完全相同的 provider 被省略（这样管理员以后改全局仍会生效）；
 * - 空字符串的 apiKey 视为"未修改"，不落盘（避免把全局密钥抄进用户文件，
 *   也避免用户清空表单时误删自己的凭据）；
 * - 全部省略且没有其它顶层字段时删除用户文件（回到纯全局）。
 */
export function writeUserModels(userId: number, payload: Record<string, unknown>): void {
  const global = readModelsConfig(globalModelsPath());
  const globalProviders = isRecord(global.providers) ? global.providers : {};
  const payloadProviders = isRecord(payload.providers) ? payload.providers : {};
  const changed: Record<string, unknown> = {};
  const withoutKey = (value: unknown): unknown => {
    if (!isRecord(value)) return value;
    const { apiKey: _drop, ...rest } = value;
    return rest;
  };
  for (const [name, entry] of Object.entries(payloadProviders)) {
    if (!isRecord(entry)) continue;
    const globalEntry = globalProviders[name];
    if (stable(entry) === stable(globalEntry)) continue;
    const hasKey = typeof entry.apiKey === "string" && entry.apiKey.trim().length > 0;
    // 读取时全局 apiKey 被剥除；"只差一个被脱敏的密钥"不算用户改动，否则
    // 用户打开设置页点保存就会把全局配置快照成自己的覆盖。
    if (!hasKey && stable(withoutKey(entry)) === stable(withoutKey(globalEntry))) continue;
    const copy: Record<string, unknown> = { ...entry };
    if (copy.apiKey === "" || copy.apiKey === undefined || copy.apiKey === null) delete copy.apiKey;
    changed[name] = copy;
  }
  // 用户层只存 providers：顶层 settings 等属于全局层，若原样抄进来会在
  // 以后管理员改全局时形成陈旧快照。
  if (Object.keys(changed).length === 0) {
    clearUserModelConfig(userId);
    return;
  }
  writeJson(userModelsPath(userId), { version: 1, providers: changed });
}

export function clearUserModelConfig(userId: number): void {
  rmSync(userModelsPath(userId), { force: true });
  rmSync(userAuthPath(userId), { force: true });
  rmSync(join(dataDir(), "user-runtime", `u${userId}`), { recursive: true, force: true });
}

/**
 * 生成用户运行时副本（全局 + 用户合并）并返回路径；用户没有任何覆盖时返回
 * null（调用方继续使用 SDK 默认的全局 agentDir，避免无谓的 ModelRuntime）。
 */
export function ensureUserModelRuntime(userId: number): ModelCredentialPaths | null {
  const hasModels = existsSync(userModelsPath(userId));
  const hasAuth = existsSync(userAuthPath(userId));
  if (!hasModels && !hasAuth) return null;
  const runtimeDir = join(dataDir(), "user-runtime", `u${userId}`);
  // 用户没覆盖的那一层直接用全局文件——避免把全局密钥复制一份到用户目录。
  const modelsPath = hasModels ? join(runtimeDir, "models.json") : globalModelsPath();
  if (hasModels) writeJson(modelsPath, effectiveModelsConfig(userId));
  const authPath = hasAuth ? join(runtimeDir, "auth.json") : globalAuthPath();
  if (hasAuth) writeJson(authPath, effectiveAuthConfig(userId));
  return { modelsPath, authPath };
}

/**
 * 会话启动时的凭据路径：用户层 → 项目层优先级由调用方叠加。
 * 返回 null 表示用 SDK 默认（全局 agentDir）。
 */
export function userRuntimeForSession(ownerId: number | undefined): ModelCredentialPaths | null {
  if (!ownerId || ownerId <= 0) return null;
  try {
    return ensureUserModelRuntime(ownerId);
  } catch {
    return null;
  }
}
