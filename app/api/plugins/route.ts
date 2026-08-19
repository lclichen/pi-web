import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type PackageSource,
  type ResolvedPaths,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { getAllowedFileRootsForRequest, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginResourceKind,
  PluginScope,
  PluginsResponse,
} from "@/lib/api-types";

export const dynamic = "force-dynamic";

type PluginAction = "install" | "remove" | "update" | "disable" | "enable";

/** Starter file for the "新建扩展目录" action — registers a no-op extension. */
const EXTENSION_TEMPLATE = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Register tools, commands, and lifecycle handlers here.
  // Docs: https://github.com/badlogic/pi-mono packages/plugin-api
}
`;

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function toPluginScope(scope: string): PluginScope {
  return scope === "project" ? "project" : "global";
}

function keyFor(source: string, scope: PluginScope): string {
  return `${scope}\0${source}`;
}

function getPackageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function isDisabledPackage(entry: PackageSource): boolean {
  if (typeof entry === "string") return false;
  return (
    Array.isArray(entry.extensions) && entry.extensions.length === 0 &&
    Array.isArray(entry.skills) && entry.skills.length === 0 &&
    Array.isArray(entry.prompts) && entry.prompts.length === 0 &&
    Array.isArray(entry.themes) && entry.themes.length === 0
  );
}

function getDisabledPackages(settingsManager: SettingsManager): Map<string, boolean> {
  const disabled = new Map<string, boolean>();
  for (const entry of settingsManager.getGlobalSettings().packages ?? []) {
    disabled.set(keyFor(getPackageSource(entry), "global"), isDisabledPackage(entry));
  }
  for (const entry of settingsManager.getProjectSettings().packages ?? []) {
    disabled.set(keyFor(getPackageSource(entry), "project"), isDisabledPackage(entry));
  }
  return disabled;
}

function setPackageDisabled(
  settingsManager: SettingsManager,
  source: string,
  scope: PluginScope,
  disabled: boolean,
): boolean {
  const current = scope === "project"
    ? settingsManager.getProjectSettings().packages ?? []
    : settingsManager.getGlobalSettings().packages ?? [];
  let changed = false;
  const next = current.map((entry): PackageSource => {
    if (getPackageSource(entry) !== source) return entry;
    changed = true;
    if (disabled) {
      return {
        ...(typeof entry === "string" ? { source: entry } : entry),
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      };
    }
    return getPackageSource(entry);
  });
  if (!changed) return false;
  if (scope === "project") settingsManager.setProjectPackages(next);
  else settingsManager.setPackages(next);
  return true;
}

function addCount(counts: PluginResourceCounts, kind: keyof PluginResourceCounts): void {
  counts[kind] += 1;
}

function getResourceName(path: string, kind: PluginResourceKind): string {
  const file = basename(path);
  const ext = extname(file);
  if (kind === "skill" && file.toLowerCase() === "skill.md") return basename(dirname(path));
  if ((kind === "extension" || kind === "theme" || kind === "prompt") && ext) {
    if (kind === "extension" && /^index\.(ts|js)$/.test(file)) return basename(dirname(path));
    return file.slice(0, -ext.length);
  }
  return file;
}

function getRelativePath(resource: ResolvedResource): string {
  const baseDir = resource.metadata.baseDir;
  if (!baseDir) return resource.path;
  const rel = relative(baseDir, resource.path);
  return rel && !rel.startsWith("..") ? rel : resource.path;
}

function getConfiguredVersion(source: string): string | undefined {
  const npmSpec = source.startsWith("npm:") ? source.slice(4) : undefined;
  if (npmSpec) {
    const lastAt = npmSpec.lastIndexOf("@");
    const packageNameEnd = npmSpec.startsWith("@") ? npmSpec.indexOf("/", 1) : 0;
    if (lastAt > packageNameEnd) return npmSpec.slice(lastAt + 1) || undefined;
    return undefined;
  }

  if (source.startsWith("git:") || /^[a-z]+:\/\//.test(source)) {
    const lastAt = source.lastIndexOf("@");
    const lastSlash = source.lastIndexOf("/");
    const lastColon = source.lastIndexOf(":");
    if (lastAt > Math.max(lastSlash, lastColon)) return source.slice(lastAt + 1) || undefined;
  }
  return undefined;
}

function readPackageMetadata(installedPath?: string): { packageName?: string; version?: string } {
  if (!installedPath) return {};
  try {
    const stats = statSync(installedPath);
    const packageJsonPath = stats.isDirectory()
      ? join(installedPath, "package.json")
      : join(dirname(installedPath), "package.json");
    if (!existsSync(packageJsonPath)) return {};
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      packageName: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
    };
  } catch {
    return {};
  }
}

function collectResource(
  resource: ResolvedResource,
  kind: keyof PluginResourceCounts,
  countsByPackage: Map<string, PluginResourceCounts>,
  resourcesByPackage: Map<string, PluginResourceInfo[]>,
  totals: PluginResourceCounts,
  topLevel: Map<string, PluginPackageInfo>,
  classify: (resource: ResolvedResource) => { origin: "settings" | "directory"; source: string; sourceLabel: string; installedPath?: string } | null,
): void {
  if (!resource.enabled) return;
  const resourceKind = kind === "extensions"
    ? "extension"
    : kind === "skills"
      ? "skill"
      : kind === "prompts"
        ? "prompt"
        : "theme";
  const info: PluginResourceInfo = {
    kind: resourceKind,
    name: getResourceName(resource.path, resourceKind),
    path: resource.path,
    relativePath: getRelativePath(resource),
  };

  if (resource.metadata.origin !== "package") {
    // Settings-array entries and auto-discovered directories: group into
    // synthetic top-level entries instead of dropping them.
    const classified = classify(resource);
    if (!classified) return;
    const scope = toPluginScope(resource.metadata.scope);
    const key = `top\0${classified.origin}\0${scope}\0${normalizeForMatch(classified.source)}`;
    let entry = topLevel.get(key);
    if (!entry) {
      entry = {
        source: classified.source,
        scope,
        filtered: false,
        disabled: false,
        ...(classified.installedPath ? { installedPath: classified.installedPath } : {}),
        counts: emptyCounts(),
        resources: [],
        status: "loaded",
        origin: classified.origin,
        sourceLabel: classified.sourceLabel,
      };
      topLevel.set(key, entry);
    }
    entry.counts[kind] += 1;
    entry.resources.push(info);
    addCount(totals, kind);
    return;
  }

  const source = resource.metadata.source;
  const scope = toPluginScope(resource.metadata.scope);
  const key = keyFor(source, scope);
  const counts = countsByPackage.get(key) ?? emptyCounts();
  addCount(counts, kind);
  addCount(totals, kind);
  countsByPackage.set(key, counts);
  const resources = resourcesByPackage.get(key) ?? [];
  resources.push(info);
  resourcesByPackage.set(key, resources);
}

function collectResources(
  paths: ResolvedPaths,
  classify: (resource: ResolvedResource) => { origin: "settings" | "directory"; source: string; sourceLabel: string; installedPath?: string } | null,
): {
  countsByPackage: Map<string, PluginResourceCounts>;
  resourcesByPackage: Map<string, PluginResourceInfo[]>;
  totals: PluginResourceCounts;
  topLevel: Map<string, PluginPackageInfo>;
} {
  const countsByPackage = new Map<string, PluginResourceCounts>();
  const resourcesByPackage = new Map<string, PluginResourceInfo[]>();
  const totals = emptyCounts();
  const topLevel = new Map<string, PluginPackageInfo>();
  for (const resource of paths.extensions) collectResource(resource, "extensions", countsByPackage, resourcesByPackage, totals, topLevel, classify);
  for (const resource of paths.skills) collectResource(resource, "skills", countsByPackage, resourcesByPackage, totals, topLevel, classify);
  for (const resource of paths.prompts) collectResource(resource, "prompts", countsByPackage, resourcesByPackage, totals, topLevel, classify);
  for (const resource of paths.themes) collectResource(resource, "themes", countsByPackage, resourcesByPackage, totals, topLevel, classify);
  return { countsByPackage, resourcesByPackage, totals, topLevel };
}

function normalizeForMatch(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Classify a non-package (top-level) resource into a synthetic entry:
 * settings-array origin when its path belongs to one of the configured
 * extensions/skills/prompts/themes arrays, directory origin when it lives
 * under an auto-discovered resource directory (e.g. .pi/extensions/<name>).
 */
function makeClassifier(
  settingsManager: SettingsManager,
  cwd: string,
  agentDir: string,
): (resource: ResolvedResource) => { origin: "settings" | "directory"; source: string; sourceLabel: string; installedPath?: string } | null {
  const configured: Array<{ source: string }> = [];
  const globalSettings = settingsManager.getGlobalSettings();
  const projectSettings = settingsManager.getProjectSettings();
  for (const settings of [globalSettings, projectSettings]) {
    for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
      for (const entry of settings[key] ?? []) {
        if (typeof entry === "string" && entry) configured.push({ source: entry });
      }
    }
  }
  const autoRoots = [
    join(cwd, ".pi", "extensions"), join(cwd, ".pi", "skills"),
    join(cwd, ".pi", "prompts"), join(cwd, ".pi", "themes"),
    join(agentDir, "extensions"), join(agentDir, "skills"),
    join(agentDir, "prompts"), join(agentDir, "themes"),
  ].map((root) => ({ root, norm: normalizeForMatch(root) }));

  const statPath = (p: string): string | undefined => {
    try {
      return statSync(p).isDirectory() ? p : dirname(p);
    } catch {
      return undefined;
    }
  };

  return (resource) => {
    const norm = normalizeForMatch(resource.path);
    for (const c of configured) {
      const cNorm = normalizeForMatch(c.source);
      if (norm === cNorm || norm.startsWith(cNorm + "/")) {
        return {
          origin: "settings",
          source: c.source,
          sourceLabel: "settings.json",
          installedPath: statPath(c.source),
        };
      }
    }
    for (const { root, norm: rootNorm } of autoRoots) {
      if (norm === rootNorm || !norm.startsWith(rootNorm + "/")) continue;
      const rel = norm.slice(rootNorm.length + 1);
      const firstSeg = rel.split("/")[0];
      if (!firstSeg) continue;
      // Entry = the directory directly under the discovered root.
      const entryDir = join(root, firstSeg);
      if (normalizeForMatch(entryDir) === norm) continue; // file directly in root: fall through
      const labelBase = normalizeForMatch(root).startsWith(normalizeForMatch(cwd)) ? cwd : agentDir;
      const label = relative(labelBase, entryDir).replace(/\\/g, "/");
      return {
        origin: "directory",
        source: entryDir,
        sourceLabel: label,
        installedPath: entryDir,
      };
    }
    // Unmatched top-level resource (e.g. a file placed directly in an auto
    // root): group per file so it still shows up.
    return {
      origin: "directory",
      source: resource.path,
      sourceLabel: normalizeForMatch(resource.path),
      installedPath: statPath(resource.path),
    };
  };
}

async function readPlugins(cwd: string): Promise<PluginsResponse> {
  const agentDir = getAgentDir();
  const projectTrust = getProjectTrustStatus(cwd, agentDir);
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: projectTrust.trusted,
  });
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });

  const diagnostics: PluginDiagnostic[] = [];
  let countsByPackage = new Map<string, PluginResourceCounts>();
  let resourcesByPackage = new Map<string, PluginResourceInfo[]>();
  let totals = emptyCounts();
  let topLevel = new Map<string, PluginPackageInfo>();
  const disabledByPackage = getDisabledPackages(settingsManager);

  try {
    const resolved = await packageManager.resolve(async (source) => {
      diagnostics.push({
        type: "warning",
        source,
        message: "Package is configured but not installed yet.",
      });
      return "skip";
    });
    ({ countsByPackage, resourcesByPackage, totals, topLevel } = collectResources(
      resolved,
      makeClassifier(settingsManager, cwd, agentDir),
    ));
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const packages: PluginPackageInfo[] = packageManager.listConfiguredPackages().map((pkg) => {
    const scope = toPluginScope(pkg.scope);
    const key = keyFor(pkg.source, scope);
    const disabled = disabledByPackage.get(key) ?? false;
    const counts = countsByPackage.get(key) ?? emptyCounts();
    const resources = resourcesByPackage.get(key) ?? [];
    const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes;
    const packageMetadata = readPackageMetadata(pkg.installedPath);
    if (!pkg.installedPath) {
      diagnostics.push({
        type: "warning",
        source: pkg.source,
        message: "Configured package path was not found.",
      });
    }
    return {
      source: pkg.source,
      scope,
      filtered: pkg.filtered,
      disabled,
      installedPath: pkg.installedPath,
      packageName: packageMetadata.packageName,
      version: packageMetadata.version,
      configuredVersion: getConfiguredVersion(pkg.source),
      counts,
      resources,
      status: disabled ? "disabled" : resourceCount > 0 ? "loaded" : pkg.installedPath ? "installed" : "missing",
      origin: "package",
      sourceLabel: "packages",
    } satisfies PluginPackageInfo;
  });

  // Settings-array and discovered-directory entries ride along after the
  // managed packages; the UI groups them into the same project/global lists.
  for (const entry of topLevel.values()) {
    packages.push(entry);
  }

  return {
    packages,
    totals,
    diagnostics,
    projectResourcesLoaded: projectTrust.trusted,
  };
}

function readScope(scope: unknown): PluginScope {
  return scope === "project" ? "project" : "global";
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRootsForRequest(req);
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    return NextResponse.json(await readPlugins(cwd));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/plugins body: { action, source?, scope?, cwd }
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      action?: PluginAction;
      source?: string;
      scope?: PluginScope;
      cwd?: string;
      origin?: "package" | "settings" | "directory";
      kind?: "extension-path" | "directory";
      name?: string;
    };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!body.action) return NextResponse.json({ error: "action required" }, { status: 400 });
    const allowedRoots = await getAllowedFileRootsForRequest(req);
    if (!isExistingFilePathAllowed(body.cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const agentDir = getAgentDir();
    const projectTrust = getProjectTrustStatus(body.cwd, agentDir);
    const settingsManager = SettingsManager.create(body.cwd, agentDir, {
      projectTrusted: projectTrust.trusted,
    });
    const scope = readScope(body.scope);
    if (scope === "project" && !projectTrust.trusted) {
      return NextResponse.json(
        { error: "Project resources must be trusted before modifying project plugins" },
        { status: 403 },
      );
    }
    const packageManager = new DefaultPackageManager({
      cwd: body.cwd,
      agentDir,
      settingsManager,
    });
    const source = body.source?.trim();
    const local = scope === "project";
    const bodyKind = body.kind;
    const bodyOrigin = body.origin;

    // ---- Top-level (non-package) sources: settings arrays + discovered dirs ----
    if (bodyOrigin === "settings" || bodyKind === "extension-path") {
      if (body.action === "install" && bodyKind === "extension-path") {
        if (!source || !isAbsolute(resolve(source))) {
          return NextResponse.json({ error: "source must be an absolute file path" }, { status: 400 });
        }
        if (!existsSync(source) || !statSync(source).isFile()) {
          return NextResponse.json({ error: `扩展文件不存在：${source}` }, { status: 400 });
        }
        const current = (local
          ? settingsManager.getProjectSettings().extensions
          : settingsManager.getGlobalSettings().extensions) ?? [];
        if (!current.includes(source)) {
          if (local) settingsManager.setProjectExtensionPaths([...current, source]);
          else settingsManager.setExtensionPaths([...current, source]);
          await settingsManager.flush();
        }
        return NextResponse.json(await readPlugins(body.cwd));
      }
      if (body.action === "remove" && bodyOrigin === "settings") {
        if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
        const strip = (paths: string[]): string[] => paths.filter((p) => p !== source);
        if (local) {
          settingsManager.setProjectExtensionPaths(strip(settingsManager.getProjectSettings().extensions ?? []));
        } else {
          settingsManager.setExtensionPaths(strip(settingsManager.getGlobalSettings().extensions ?? []));
        }
        await settingsManager.flush();
        return NextResponse.json(await readPlugins(body.cwd));
      }
      return NextResponse.json({ error: `Unsupported action for origin=settings: ${body.action}` }, { status: 400 });
    }

    if (bodyOrigin === "directory" || bodyKind === "directory") {
      const projectExtensionsRoot = resolve(body.cwd, ".pi", "extensions");
      const globalExtensionsRoot = resolve(agentDir, "extensions");
      const isManagedDir = (dir: string): boolean => {
        const r = resolve(dir);
        for (const root of [projectExtensionsRoot, globalExtensionsRoot]) {
          if (!r.startsWith(root + sep)) continue;
          const rest = r.slice(root.length + sep.length);
          return rest.length > 0 && !rest.includes(sep); // exactly one level deep
        }
        return false;
      };
      if (body.action === "remove") {
        if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
        if (!isManagedDir(source)) {
          return NextResponse.json({ error: "只能删除 .pi/extensions 或全局 extensions 目录下的扩展目录" }, { status: 400 });
        }
        rmSync(resolve(source), { recursive: true, force: true });
        return NextResponse.json(await readPlugins(body.cwd));
      }
      if (body.action === "install") {
        const name = (body.name ?? "").trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
          return NextResponse.json({ error: "name must be a safe directory name" }, { status: 400 });
        }
        const dir = join(projectExtensionsRoot, name);
        if (existsSync(dir)) {
          return NextResponse.json({ error: `目录已存在：${dir}` }, { status: 400 });
        }
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "index.ts"), EXTENSION_TEMPLATE, "utf8");
        return NextResponse.json(await readPlugins(body.cwd));
      }
      return NextResponse.json({ error: `Unsupported action for origin=directory: ${body.action}` }, { status: 400 });
    }

    if (body.action === "install") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      await packageManager.installAndPersist(source, { local });
    } else if (body.action === "remove") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      await packageManager.removeAndPersist(source, { local });
    } else if (body.action === "update") {
      await packageManager.update(source);
    } else if (body.action === "disable") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      setPackageDisabled(settingsManager, source, scope, true);
      await settingsManager.flush();
    } else if (body.action === "enable") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      setPackageDisabled(settingsManager, source, scope, false);
      await settingsManager.flush();
    } else {
      return NextResponse.json({ error: `Unsupported action: ${body.action}` }, { status: 400 });
    }

    return NextResponse.json(await readPlugins(body.cwd));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
