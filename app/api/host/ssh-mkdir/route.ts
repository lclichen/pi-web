import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { sshCreateDirectory, type SshConfigInput } from "@/lib/ssh";

export const dynamic = "force-dynamic";

// POST /api/host/ssh-mkdir — create one directory on the remote host with the
// wizard's ad-hoc SSH credentials (same trust level as ssh-list / ssh-test;
// the connection is one-shot and never pooled).
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

  let body: SshConfigInput & { path?: unknown; name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const config = {
    host: typeof body.host === "string" ? body.host : "",
    port: typeof body.port === "number" ? body.port : 22,
    username: typeof body.username === "string" ? body.username : "",
    authType: body.authType === "password" ? ("password" as const) : ("key" as const),
    password: typeof body.password === "string" ? body.password : undefined,
    privateKey: typeof body.privateKey === "string" ? body.privateKey : undefined,
    passphrase: typeof body.passphrase === "string" ? body.passphrase : undefined,
  };
  if (!config.host || !config.username) {
    return NextResponse.json({ error: "需要主机地址与用户名" }, { status: 400 });
  }
  const parent = typeof body.path === "string" ? body.path.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!parent) return NextResponse.json({ error: "缺少父目录" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "文件夹名不能为空" }, { status: 400 });

  try {
    const created = await sshCreateDirectory(config, parent, name);
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
