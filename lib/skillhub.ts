/**
 * 内网 SkillHub 客户端（搜索 / 下载）——接口契约见 docs/skillhub-api.md。
 *
 * 搜索走 `/api/web/skills`（与 v1 路由同构）：web 版列表项带 `namespace`
 * 字段且为 offset 分页——v1 列表项没有 namespace，而下载/详情端点的
 * namespace 必填，故搜索取 web 版。下载走 `/api/v1/.../download` 返回 zip。
 *
 * PUBLIC skill 的搜索与下载免认证；私有 skill 需认证（当前不支持，命中时
 * 服务端返回 401，错误原样上抛给前端展示）。
 */

import type { SkillSearchResult } from "./api-types";

/** 归一化 hub 基址：去尾斜杠；仅 http(s)；非法输入抛错（配置错误要显式暴露）。 */
export function normalizeSkillhubBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`SkillHub 地址无效: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`SkillHub 地址必须是 http(s): ${raw}`);
  }
  return trimmed;
}

export interface SkillhubSearchParams {
  q?: string;
  /** 限定命名空间（不带 @ 前缀）。 */
  namespace?: string;
  sort?: string;
  page?: number;
  size?: number;
}

export interface SkillhubItem {
  namespace: string;
  slug: string;
  displayName: string;
  summary: string;
  downloads: number;
  stars: number;
  latestVersion: string;
  updatedAt: string;
}

interface WebListEnvelope {
  code?: number;
  msg?: string;
  data?: {
    items?: Array<{
      slug?: string;
      namespace?: string;
      displayName?: string;
      summary?: string;
      downloadCount?: number;
      starCount?: number;
      updatedAt?: string;
      publishedVersion?: { version?: string } | null;
    }>;
    total?: number;
  };
}

/** 搜索并映射为统一的 hub 条目（无结果返回空数组）。 */
export async function searchSkillhub(baseUrl: string, params: SkillhubSearchParams): Promise<SkillhubItem[]> {
  const base = normalizeSkillhubBase(baseUrl);
  const url = new URL(`${base}/api/web/skills`);
  if (params.q) url.searchParams.set("q", params.q);
  if (params.namespace) url.searchParams.set("namespace", params.namespace);
  if (params.sort) url.searchParams.set("sort", params.sort);
  url.searchParams.set("page", String(params.page ?? 0));
  url.searchParams.set("size", String(params.size ?? 20));

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`SkillHub 搜索失败: HTTP ${res.status}${msg ? ` ${msg.slice(0, 120)}` : ""}`);
  }
  const body = (await res.json()) as WebListEnvelope;
  if (body.code !== undefined && body.code !== 0) {
    throw new Error(`SkillHub 搜索失败: ${body.msg ?? `code ${body.code}`}`);
  }
  return (body.data?.items ?? [])
    .filter((item) => item.slug && item.namespace)
    .map((item) => ({
      namespace: item.namespace!,
      slug: item.slug!,
      displayName: item.displayName?.trim() || item.slug!,
      summary: item.summary?.trim() ?? "",
      downloads: item.downloadCount ?? 0,
      stars: item.starCount ?? 0,
      latestVersion: item.publishedVersion?.version ?? "",
      updatedAt: item.updatedAt ?? "",
    }));
}

/** hub 条目 → 前端搜索结果形状（package=ns/slug，url=hub 详情页）。 */
export function skillhubItemToSearchResult(
  baseUrl: string,
  item: SkillhubItem,
): SkillSearchResult & { source: "skillhub"; namespace: string; slug: string; version: string; summary: string } {
  return {
    package: `${item.namespace}/${item.slug}`,
    installs: item.downloads > 0 ? formatDownloads(item.downloads) : "",
    url: `${normalizeSkillhubBase(baseUrl)}/space/${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.slug)}`,
    source: "skillhub",
    namespace: item.namespace,
    slug: item.slug,
    version: item.latestVersion,
    summary: item.summary,
  };
}

function formatDownloads(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M downloads`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K downloads`;
  return `${count} download${count === 1 ? "" : "s"}`;
}

export interface SkillhubDownload {
  data: Buffer;
  filename: string;
}

/** 下载指定 skill 的 zip（最新已发布版本或指定版本）。 */
export async function downloadSkillhubZip(
  baseUrl: string,
  namespace: string,
  slug: string,
  version?: string,
): Promise<SkillhubDownload> {
  const base = normalizeSkillhubBase(baseUrl);
  const path = version
    ? `/api/v1/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download`
    : `/api/v1/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/download`;
  const res = await fetch(`${base}${path}`, { cache: "no-store" });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`SkillHub 下载失败: HTTP ${res.status}${msg ? ` ${msg.slice(0, 120)}` : ""}`);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const filename = match?.[1] ?? `${slug}${version ? `-${version}` : ""}.zip`;
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length === 0) throw new Error("SkillHub 下载返回空内容");
  return { data, filename };
}
