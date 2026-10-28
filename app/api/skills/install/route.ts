import { NextResponse } from "next/server";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runNpx } from "@/lib/npx";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { downloadSkillhubZip, normalizeSkillhubBase } from "@/lib/skillhub";
import { getServerSettings } from "@/lib/server-settings";
import { importSkillsZip } from "@/lib/project-config-bundle";

export const dynamic = "force-dynamic";

const ANSI_RE = /\x1B\[[0-9;]*m/g;

// POST /api/skills/install  body 二选一：
//   { package, scope: "global" | "project", cwd? }                      — skills.sh（npx skills add）
//   { skillhub: { baseUrl?, namespace, slug, version? }, scope, cwd? } — 内网 SkillHub（zip 下载落盘）
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = (await req.json()) as {
      package?: string;
      scope?: string;
      cwd?: string;
      skillhub?: { baseUrl?: string; namespace?: string; slug?: string; version?: string };
    };
    const { scope, cwd } = body;

    const isGlobal = scope !== "project";
    if (!isGlobal) {
      if (!cwd) return NextResponse.json({ error: "cwd required for project install" }, { status: 400 });
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      if (!getProjectTrustStatus(cwd, getAgentDir()).trusted) {
        return NextResponse.json(
          { error: "Project resources must be trusted before installing project skills" },
          { status: 403 },
        );
      }
    }

    // ── SkillHub 分支：从内网 hub 拉 zip，复用离线导入的解包/校验/落盘。 ──
    if (body.skillhub) {
      const { namespace, slug, version, baseUrl } = body.skillhub;
      if (!namespace?.trim() || !slug?.trim()) {
        return NextResponse.json({ error: "skillhub install requires namespace and slug" }, { status: 400 });
      }
      let hubBase = baseUrl?.trim() ? baseUrl.trim() : getServerSettings().skillhubUrl;
      if (!hubBase) {
        return NextResponse.json(
          { error: "SkillHub 地址未配置（skillhub.baseUrl 或 server-settings.skillhubUrl）" },
          { status: 400 },
        );
      }
      hubBase = normalizeSkillhubBase(hubBase);
      const { data, filename } = await downloadSkillhubZip(
        hubBase,
        namespace.trim(),
        slug.trim(),
        version?.trim() || undefined,
      );
      const stats = await importSkillsZip(
        isGlobal ? process.cwd() : cwd!,
        data,
        filename,
        isGlobal ? { skillsRoot: join(getAgentDir(), "skills") } : {},
      );
      console.log(
        `[skills/install] skillhub ${namespace}/${slug}${version ? `@${version}` : ""} -> ${isGlobal ? "global" : "project"}: ${stats.skill ?? "?"}`,
      );
      return NextResponse.json({ success: true, source: "skillhub", ...stats });
    }

    const pkg = body.package;
    if (!pkg?.trim()) return NextResponse.json({ error: "package required" }, { status: 400 });
    const args = ["skills", "add", pkg.trim(), "-y", "--agent", "pi"];
    if (isGlobal) args.push("-g");

    console.log(`[skills/install] running: npx ${args.join(" ")}`);
    const { stdout, stderr } = await runNpx(args, {
      timeout: 60000,
      cwd: !isGlobal && cwd ? cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const output = (stdout + stderr).replace(ANSI_RE, "");
    const success = /Installation complete|Installed \d+ skill/.test(output);
    if (!success) {
      return NextResponse.json({ error: output.slice(-300) || "Install failed" }, { status: 500 });
    }
    return NextResponse.json({ success: true, output });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = ((err.stdout ?? "") + (err.stderr ?? "")).replace(ANSI_RE, "");
    return NextResponse.json({ error: output || (err.message ?? String(e)) }, { status: 500 });
  }
}
