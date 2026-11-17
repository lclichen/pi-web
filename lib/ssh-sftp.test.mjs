import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { withSftp } = await jiti.import("./ssh-sftp.ts");

function fakeClient({ failOpen = false } = {}) {
  let active = 0;
  let max = 0;
  let ends = 0;
  return {
    get maxActive() {
      return max;
    },
    get ends() {
      return ends;
    },
    sftp(cb) {
      if (failOpen) {
        setTimeout(() => cb(new Error("no channel")), 0);
        return;
      }
      active += 1;
      max = Math.max(max, active);
      const channel = {
        end() {
          active -= 1;
          ends += 1;
        },
      };
      setTimeout(() => cb(undefined, channel), 0);
    },
  };
}

test("the channel is ended on success and on failure", async () => {
  const client = fakeClient();
  assert.equal(await withSftp(client, async () => "ok"), "ok");
  assert.equal(client.ends, 1);

  await assert.rejects(
    withSftp(client, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(client.ends, 2);
});

test("a failed channel open releases the slot for the next caller", async () => {
  const failing = fakeClient({ failOpen: true });
  await assert.rejects(withSftp(failing, async () => "never"), /no channel/);
  // The gate was released in the finally block; a second call also reaches
  // sftp() instead of hanging behind a leaked slot.
  await assert.rejects(withSftp(failing, async () => "never"), /no channel/);
});

test("concurrent callers are capped well below OpenSSH MaxSessions", async () => {
  const client = fakeClient();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      withSftp(client, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return index;
      }),
    ),
  );
  assert.deepEqual(results, [...Array(12).keys()]);
  assert.equal(client.ends, 12);
  assert.ok(client.maxActive <= 4, `opened ${client.maxActive} channels at once`);
});
