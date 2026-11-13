/**
 * SSH 真实通道 E2E（在 VM 本机执行，ssh 到 127.0.0.1）。
 *
 * 目的：用真实 ssh2 连接验证 ssh-tools 的 exec/SFTP 行为（不是 mock）。
 * 前置：VM 上 llmx 用户已把 QA 回环公钥写入 ~/.ssh/authorized_keys。
 *
 * 运行（VM）：cd ~/amedac/pi-web && node --experimental-strip-types e2e/ssh-real.mjs
 * 断言：bash/read/write/edit/ls/grep/find/user_bash 全部通过真实 SSH 通道。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getSshClient, sshExec } = await jiti.import("../lib/ssh.ts");
const { makeSshToolsExtension } = await jiti.import("../lib/extensions/ssh-tools.ts");

const home = process.env.HOME ?? "/home/llmx";
const keyPath = process.env.QA_SSH_KEY ?? join(home, ".ssh", "qa_loopback");
const sshConfig = {
  host: process.env.QA_SSH_HOST ?? "127.0.0.1",
  port: Number(process.env.QA_SSH_PORT ?? 22),
  username: process.env.QA_SSH_USER ?? process.env.USER ?? "llmx",
  authType: "key",
  privateKey: readFileSync(keyPath, "utf8"),
};

const workdir = `/tmp/pi-web-ssh-e2e-${Date.now()}`;
const client = await getSshClient("e2e-ssh-real", sshConfig);

const tools = new Map();
const handlers = new Map();
makeSshToolsExtension({ projectId: "e2e-ssh-real", sshConfig, workdir })(
  { registerTool: (tool) => tools.set(tool.name, tool), on: (event, handler) => handlers.set(event, handler) },
);

const execute = (name, params) => tools.get(name).execute("call-1", params, undefined, undefined, { cwd: workdir });

try {
  await sshExec(client, `mkdir -p ${workdir}/sub`, "/", 10_000);

  // bash（真实 exec）
  const bash = await execute("bash", { command: "printf 'hello-ssh'", timeout: 10 });
  assert.equal(bash.isError, undefined, bash.content[0].text);
  assert.match(bash.content[0].text, /hello-ssh/);

  // write + read（真实 SFTP）
  const marker = `ssh-marker-${Date.now()}`;
  const write = await execute("write", { path: "sub/a.txt", content: `${marker}\nsecond\n` });
  assert.equal(write.isError, undefined, write.content[0].text);
  const read = await execute("read", { path: "sub/a.txt" });
  assert.equal(read.isError, undefined, read.content[0].text);
  assert.match(read.content[0].text, new RegExp(`1→${marker}`));

  // edit（SFTP 读改写）
  const edit = await execute("edit", { path: "sub/a.txt", oldText: "second", newText: "edited" });
  assert.equal(edit.isError, undefined, edit.content[0].text);
  const after = await execute("read", { path: "sub/a.txt" });
  assert.match(after.content[0].text, /2→edited/);

  // ls（SFTP readdir）
  const ls = await execute("ls", { path: "sub" });
  assert.match(ls.content[0].text, /- a\.txt/);

  // grep / find（真实 exec）
  const grep = await execute("grep", { pattern: marker, path: "sub" });
  assert.match(grep.content[0].text, /a\.txt:1:/);
  const find = await execute("find", { pattern: "a.txt", path: "sub" });
  assert.match(find.content[0].text, /sub\/a\.txt/);

  // user_bash（Client.exec 通道 + exit 结算）
  const userBash = handlers.get("user_bash");
  assert.ok(userBash, "user_bash registered");
  const { operations } = await userBash();
  const chunks = [];
  const result = await operations.exec("printf 'user-bash-ok'", "/server/home", {
    onData: (buf) => chunks.push(buf.toString("utf8")),
    timeout: 10_000,
  });
  assert.equal(result.exitCode, 0);
  assert.match(chunks.join(""), /user-bash-ok/);

  // 服务端确认文件确实落在远端路径（而不是本地内存）
  const cat = await sshExec(client, `cat ${workdir}/sub/a.txt`, "/", 10_000);
  assert.match(cat.stdout, /edited/);

  console.log("PASS: real SSH channel (exec/SFTP/edit/ls/grep/find/user_bash)");
} finally {
  await sshExec(client, `rm -rf ${workdir}`, "/", 10_000).catch(() => {});
  client.end();
}
