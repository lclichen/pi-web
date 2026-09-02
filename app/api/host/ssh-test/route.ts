import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { sshTestConnection, type SshConfigInput } from "@/lib/ssh";

export const dynamic = "force-dynamic";

// POST /api/host/ssh-test — attempt an SSH connection with the given config
// and report success/failure. No state is stored; used by the wizard's
// 「测试连接」 button so users get feedback before creating a project.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

  let body: SshConfigInput & { passphrase?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const config: SshConfigInput = {
    host: typeof body.host === "string" ? body.host : "",
    port: typeof body.port === "number" ? body.port : 22,
    username: typeof body.username === "string" ? body.username : "",
    authType: body.authType === "password" ? "password" : "key",
    password: typeof body.password === "string" ? body.password : undefined,
    privateKey: typeof body.privateKey === "string" ? body.privateKey : undefined,
    passphrase: typeof body.passphrase === "string" ? body.passphrase : undefined,
  };
  const fullConfig = { ...config, port: config.port ?? 22 };
  if (!fullConfig.host || !fullConfig.username) {
    return NextResponse.json({ error: "需要主机地址与用户名" }, { status: 400 });
  }

  try {
    // One-shot connection: pooling this would reuse a previously
    // authenticated client and accept credentials that were never tried.
    const { whoami } = await sshTestConnection(fullConfig as import("@/lib/ssh").SshConfig);
    return NextResponse.json({ ok: true, whoami });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
