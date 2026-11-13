/**
 * 工作区下行投影真实通道 E2E（在 VM 本机执行，SSH 回环）。
 *
 * 覆盖：真实 SFTP 字节写/删除 + Host→workspace reconcile 全规则
 *   - 首次推送 skills/agents/attachments（含二进制附件）
 *   - 第二次幂等 adopt，不重写
 *   - 本地编辑保留为 dirty；repair 强制回灌
 *   - Host 删除传播（clean 副本）；附件以 Host 为准
 *
 * 前置：VM 上 llmx 用户已配置 QA 回环公钥（同 e2e/ssh-real.mjs）。
 * 运行（VM）：cd ~/amedac/pi-web && node --experimental-strip-types e2e/projection-real.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// Must be set before projection modules resolve the data dir.
const dataRoot = mkdtempSync(join(tmpdir(), "projection-e2e-data-"));
process.env.PI_WEB_DATA_DIR = dataRoot;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getSshClient, sshExec } = await jiti.import("../lib/ssh.ts");
const { createSshWorkspaceOperations } = await jiti.import("../lib/workspace-providers/ssh.ts");
const { reconcileProjection } = await jiti.import("../lib/projection/reconcile.ts");

const home = process.env.HOME ?? "/home/llmx";
const keyPath = process.env.QA_SSH_KEY ?? join(home, ".ssh", "qa_loopback");
const sshConfig = {
  host: process.env.QA_SSH_HOST ?? "127.0.0.1",
  port: Number(process.env.QA_SSH_PORT ?? 22),
  username: process.env.QA_SSH_USER ?? process.env.USER ?? "llmx",
  authType: "key",
  privateKey: readFileSync(keyPath, "utf8"),
};

const projectId = `e2e-projection-${Date.now()}`;
const hostHome = mkdtempSync(join(tmpdir(), "projection-e2e-home-"));
const remoteRoot = `/tmp/pi-web-projection-e2e-${Date.now()}`;
const meta = {
  mode: "ssh",
  root: remoteRoot,
  backend: `${sshConfig.host}:${sshConfig.port}`,
  key: "abcdef0123456789abcdef0123456789",
};

const writeHost = (rel, content) => {
  const abs = join(hostHome, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
};

const client = await getSshClient(projectId, sshConfig);
const workspace = createSshWorkspaceOperations({
  getClient: () => getSshClient(projectId, sshConfig),
  workdir: remoteRoot,
});

const remoteText = async (rel) => {
  const result = await sshExec(client, `cat ${JSON.stringify(`${remoteRoot}/${rel}`)}`, "/", 15_000);
  return result.stdout;
};
const remoteSha = async (rel) => {
  const result = await sshExec(
    client,
    `sha256sum ${JSON.stringify(`${remoteRoot}/${rel}`)} | cut -d' ' -f1`,
    "/",
    15_000,
  );
  return result.stdout.trim();
};

const reconcile = (extra = {}) =>
  reconcileProjection({
    projectId,
    hostHome,
    workspace,
    workspaceMeta: meta,
    ...extra,
  });

try {
  await sshExec(client, `mkdir -p ${JSON.stringify(remoteRoot)}`, "/", 15_000);

  writeHost(".pi/skills/demo/SKILL.md", "# Demo skill v1\n");
  writeHost(".pi/agents/helper.md", "helper v1\n");
  writeHost(".pi/attachments/pic.bin", Buffer.from([1, 2, 3, 4]));

  // 1) First reconcile pushes everything over SFTP.
  const first = await reconcile();
  assert.deepEqual(first.errors, []);
  assert.deepEqual([...first.status.pushed].sort(), [
    ".pi/agents/helper.md",
    ".pi/attachments/pic.bin",
    ".pi/skills/demo/SKILL.md",
  ]);
  assert.equal(await remoteText(".pi/skills/demo/SKILL.md"), "# Demo skill v1\n");
  assert.equal(await remoteSha(".pi/attachments/pic.bin"), await remoteShaOfHost(".pi/attachments/pic.bin"));

  // 2) Second reconcile adopts (no write).
  const second = await reconcile();
  assert.deepEqual(second.status.pushed, []);
  assert.equal(second.status.adopted.length, 3);

  // 3) Local edit is kept as dirty, then repair forces Host content.
  await sshExec(
    client,
    `printf 'local edit\\n' > ${JSON.stringify(`${remoteRoot}/.pi/skills/demo/SKILL.md`)}`,
    "/",
    15_000,
  );
  const kept = await reconcile();
  assert.deepEqual(kept.dirty, [".pi/skills/demo/SKILL.md"]);
  assert.equal(await remoteText(".pi/skills/demo/SKILL.md"), "local edit\n");

  const repaired = await reconcile({ forcePaths: [".pi/skills/demo/SKILL.md"] });
  assert.deepEqual(repaired.status.pushed, [".pi/skills/demo/SKILL.md"]);
  assert.equal(await remoteText(".pi/skills/demo/SKILL.md"), "# Demo skill v1\n");

  // 4) Host deletion propagates to a clean copy (uses provider.remove).
  unlinkSync(join(hostHome, ".pi/skills/demo/SKILL.md"));
  const deleted = await reconcile();
  assert.deepEqual(deleted.status.deleted, [".pi/skills/demo/SKILL.md"]);
  const exists = await sshExec(
    client,
    `test -e ${JSON.stringify(`${remoteRoot}/.pi/skills/demo/SKILL.md`)} && echo yes || echo no`,
    "/",
    15_000,
  );
  assert.equal(exists.stdout.trim(), "no");

  // 5) Attachments follow the Host copy even when the remote copy drifted.
  await sshExec(
    client,
    `printf '\\x09\\x09' > ${JSON.stringify(`${remoteRoot}/.pi/attachments/pic.bin`)}`,
    "/",
    15_000,
  );
  writeHost(".pi/attachments/pic.bin", Buffer.from([7, 7, 7]));
  const attachment = await reconcile({ forceFullVerify: true });
  assert.deepEqual(attachment.status.pushed, [".pi/attachments/pic.bin"]);
  assert.equal(await remoteSha(".pi/attachments/pic.bin"), await remoteShaOfHost(".pi/attachments/pic.bin"));

  // 6) Host attachment cleanup propagates (attachment deletions are unconditional).
  unlinkSync(join(hostHome, ".pi/attachments/pic.bin"));
  const cleaned = await reconcile();
  assert.deepEqual(cleaned.status.deleted, [".pi/attachments/pic.bin"]);

  console.log("PASS: projection over real SSH (push/adopt/dirty/repair/delete/attachment)");
} finally {
  await sshExec(client, `rm -rf ${JSON.stringify(remoteRoot)}`, "/", 15_000).catch(() => {});
  client.end();
  rmSync(hostHome, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
}

async function remoteShaOfHost(rel) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(readFileSync(join(hostHome, rel))).digest("hex");
}
