import { NextResponse } from "next/server";
import { requireUserIdentity } from "@/lib/web-session";
import { isApiRequestAllowed } from "@/lib/request-security";
import { sshListDirectory, type SshConfigInput } from "@/lib/ssh";

export const dynamic = "force-dynamic";

// POST /api/host/ssh-list — browse remote directories with ad-hoc SSH
// credentials during the wizard's step-4 directory pick. Same trust level as
// /api/host/ssh-test (logged-in users may connect to their own hosts); the
// connection is one-shot and never pooled. No state is stored.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const identity = requireUserIdentity(req);
  if (!identity.ok) return NextResponse.json({ error: "登录已失效" }, { status: identity.status });

  let body: SshConfigInput & { path?: unknown };
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
  const path = typeof body.path === "string" && body.path.trim() ? body.path.trim() : undefined;

  try {
    const result = await sshListDirectory(fullConfig, path);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
