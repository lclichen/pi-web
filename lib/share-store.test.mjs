import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "share-store-"));

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false, interopDefault: true });
const store = await jiti.import("./share-store.ts");

let clock = 1_000_000;
store.setShareClockForTesting(() => clock);

/**
 * 分享令牌存储（docs/dev/mcp-file-sharing.md）：token 只存 sha256、期限+
 * 次数双限、host=活引用（GET 时重验栅栏）、snapshot=创建时快照文件、
 * 限流（30/小时、50 活跃）、持久化 + 过期清扫。
 */

test("host share: create → lookup → consume → revoke lifecycle", () => {
  const { token, entry } = store.createShare({
    path: "/tmp/report.pdf",
    fileName: "report.pdf",
    ownerId: 7,
    ownerName: "alice",
    host: { hostPath: "/srv/ws/report.pdf", hostRoot: "/srv/ws", size: 1024 },
  });
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(entry.kind, "host");
  assert.equal(entry.maxDownloads, 10);

  assert.equal(store.lookupShare(token).status, "ok");
  assert.ok(store.consumeShareDownload(token, "10.0.0.1"));
  const again = store.lookupShare(token);
  assert.equal(again.status, "ok");
  assert.equal(again.entry.downloads, 1);
  assert.equal(again.entry.lastIp, "10.0.0.1");

  assert.equal(store.revokeShare(token, { ownerId: 8, isAdmin: false }), "forbidden");
  assert.equal(store.revokeShare(token, { ownerId: 7, isAdmin: false }), "ok");
  assert.equal(store.lookupShare(token).status, "missing");
});

test("expiry: expired entries answer 410-style once, then are swept", () => {
  const { token } = store.createShare({
    path: "a.txt",
    fileName: "a.txt",
    ownerId: 7,
    ownerName: "alice",
    ttlMinutes: 5,
    host: { hostPath: "/srv/ws/a.txt", hostRoot: "/srv/ws", size: 10 },
  });
  clock += 5 * 60_000 + 1;
  assert.equal(store.lookupShare(token).status, "expired");
  // Swept on the next pass — subsequent lookups say missing.
  assert.equal(store.lookupShare(token).status, "missing");
});

test("download quota: exhausted entries are refused before serving", () => {
  const { token } = store.createShare({
    path: "once.txt",
    fileName: "once.txt",
    ownerId: 7,
    ownerName: "alice",
    oneTime: true,
    host: { hostPath: "/srv/ws/once.txt", hostRoot: "/srv/ws", size: 3 },
  });
  assert.ok(store.consumeShareDownload(token));
  assert.equal(store.consumeShareDownload(token), false);
  assert.equal(store.lookupShare(token).status, "exhausted");
});

test("snapshot share: bytes land in a 0600 file and vanish on revoke", () => {
  const bytes = Buffer.from("hello share", "utf8");
  const { token, entry } = store.createShare({
    path: "snapshot.bin",
    fileName: "snapshot.bin",
    ownerId: 9,
    ownerName: "bob",
    srcSession: "sess-1",
    snapshot: { bytes, mime: "application/octet-stream" },
  });
  assert.equal(entry.kind, "snapshot");
  assert.equal(entry.size, bytes.length);
  const p = store.shareSnapshotPath(entry);
  assert.ok(existsSync(p), "snapshot file written");
  assert.deepEqual(readFileSync(p), bytes);
  assert.equal(store.revokeShare(token, { ownerId: 9, isAdmin: false }), "ok");
  assert.ok(!existsSync(p), "snapshot file removed on revoke");
});

test("rate + active limits", () => {
  // 30/hour for ownerId 42; this loop shares the window with nothing else.
  for (let i = 0; i < 30; i += 1) {
    store.createShare({
      path: `f${i}`,
      fileName: `f${i}`,
      ownerId: 42,
      ownerName: "carol",
      host: { hostPath: `/srv/ws/f${i}`, hostRoot: "/srv/ws", size: 1 },
    });
  }
  assert.throws(
    () =>
      store.createShare({
        path: "over",
        fileName: "over",
        ownerId: 42,
        ownerName: "carol",
        host: { hostPath: "/srv/ws/over", hostRoot: "/srv/ws", size: 1 },
      }),
    /过于频繁/,
  );
  // A different user is unaffected.
  store.createShare({
    path: "other",
    fileName: "other",
    ownerId: 43,
    ownerName: "dave",
    host: { hostPath: "/srv/ws/other", hostRoot: "/srv/ws", size: 1 },
  });
});

test("persistence: entries survive a store reload; expired ones do not", async () => {
  const keep = store.createShare({
    path: "keep.txt",
    fileName: "keep.txt",
    ownerId: 50,
    ownerName: "erin",
    ttlMinutes: 60,
    host: { hostPath: "/srv/ws/keep.txt", hostRoot: "/srv/ws", size: 1 },
  });
  const drop = store.createShare({
    path: "drop.txt",
    fileName: "drop.txt",
    ownerId: 50,
    ownerName: "erin",
    ttlMinutes: 1,
    host: { hostPath: "/srv/ws/drop.txt", hostRoot: "/srv/ws", size: 1 },
  });
  clock += 2 * 60_000;
  store.resetShareStoreForTesting();
  // New store instance loads from disk: keep survives, drop was expired.
  const again = await jiti.import("./share-store.ts");
  again.setShareClockForTesting(() => clock);
  assert.equal(again.lookupShare(keep.token).status, "ok");
  assert.equal(again.lookupShare(drop.token).status, "missing");
});

test("host fence: symlink/escape failures are detected", () => {
  const root = mkdtempSync(join(tmpdir(), "share-fence-"));
  const inner = join(root, "inner");
  mkdirSync(inner);
  writeFileSync(join(inner, "f.txt"), "x");
  const outside = mkdtempSync(join(tmpdir(), "share-out-"));
  writeFileSync(join(outside, "secret.txt"), "s");
  const entry = {
    tokenHash: "x".repeat(64),
    path: "f.txt",
    fileName: "f.txt",
    kind: "host",
    hostPath: join(inner, "f.txt"),
    hostRoot: root,
    size: 1,
    ownerId: 1,
    ownerName: "a",
    createdAt: 0,
    expiresAt: 1e18,
    maxDownloads: 1,
    downloads: 0,
  };
  assert.equal(store.hostShareStillFenced(entry), true);
  assert.equal(store.hostShareStillFenced({ ...entry, hostPath: join(outside, "secret.txt") }), false);
  assert.equal(store.hostShareStillFenced({ ...entry, hostPath: join(root, "missing") }), false);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
