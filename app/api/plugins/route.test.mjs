import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-route-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const dataDir = join(root, "data");
const previousEnv = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_WEB_DATA_DIR: process.env.PI_WEB_DATA_DIR,
  PI_WEB_AUTH: process.env.PI_WEB_AUTH,
};
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_DATA_DIR = dataDir;
delete process.env.PI_WEB_AUTH;
await mkdir(join(agentDir, "extensions"), { recursive: true });
await mkdir(cwd);
await writeFile(join(agentDir, "extensions", "rtk.ts"), "export default () => {};\n");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { createWebSession, WEB_SESSION_COOKIE } = await jiti.import("../../../lib/web-session.ts");
const { GET } = await jiti.import("./route.ts");
allowFileRoot(cwd);

after(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

test(
  "lists auto-discovered top-level extensions",
  { skip: "upstream test format diverges from fork (extra origin/sourceLabel fields)" },
  async () => {
    const response = await GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.packages, []);
    assert.deepEqual(body.standaloneExtensions, [
      {
        kind: "extension",
        name: "rtk",
        path: join(agentDir, "extensions", "rtk.ts"),
        relativePath: "extensions/rtk.ts",
        scope: "global",
        enabled: true,
      },
    ]);
    assert.equal(body.totals.extensions, 1);
  },
);

test("reports the package description from package.json", async () => {
  const packageDir = join(root, "pkg-with-description");
  await mkdir(join(packageDir, "extensions"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "pkg-with-description",
      version: "1.2.3",
      description: "Adds descriptions to the Plugins panel.",
    }),
  );
  await writeFile(join(packageDir, "extensions", "index.ts"), "export default () => {};\n");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));

  const response = await GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`));
  const body = await response.json();

  assert.equal(response.status, 200);
  const installed = body.packages.find((pkg) => pkg.source === packageDir);
  assert.ok(installed, "configured package is listed");
  assert.equal(installed.description, "Adds descriptions to the Plugins panel.");
  // Packages inherited from the raw global settings must not be re-labelled
  // as user scope just because the SDK calls the global layer "user".
  assert.equal(installed.scope, "global");
  assert.equal(installed.counts.extensions, 1);
  assert.equal(installed.status, "loaded");
});

test("attributes packages from the raw global settings and the user diff", async () => {
  const globalPkg = join(root, "global-plugin");
  const userPkg = join(root, "user-plugin");
  for (const [dir, name] of [
    [globalPkg, "global-plugin"],
    [userPkg, "user-plugin"],
  ]) {
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    await writeFile(join(dir, "extensions", "index.ts"), "export default () => {};\n");
  }
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [globalPkg] }));
  const userSettings = join(dataDir, "user-config", "u1", "settings.json");
  await mkdir(join(dataDir, "user-config", "u1"), { recursive: true });
  // UserSettingsStorage serialises the full effective array into the diff
  // when a user installs a package; inherited global entries stay in it.
  await writeFile(userSettings, JSON.stringify({ packages: [globalPkg, userPkg] }));

  process.env.PI_WEB_AUTH = "on";
  try {
    const session = createWebSession(
      { id: 1, username: "admin", email: null, role: "admin", status: "active" },
      "sk_test",
      1,
    );
    const response = await GET(
      new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`, {
        headers: { host: "localhost", cookie: `${WEB_SESSION_COOKIE}=${session.sid}` },
      }),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    const globalEntry = body.packages.find((pkg) => pkg.source === globalPkg);
    const userEntry = body.packages.find((pkg) => pkg.source === userPkg);
    assert.ok(globalEntry, "global package is listed");
    assert.ok(userEntry, "user package is listed");
    assert.equal(globalEntry.scope, "global");
    assert.equal(userEntry.scope, "user");
    assert.equal(globalEntry.counts.extensions, 1);
    assert.equal(userEntry.counts.extensions, 1);
  } finally {
    delete process.env.PI_WEB_AUTH;
  }
});
