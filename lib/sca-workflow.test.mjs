import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

async function readYaml(rel) {
  return yaml.load(await readFile(new URL(rel, import.meta.url), "utf8"));
}

test("the SCA workflow scans lockfiles and publishes SARIF", async () => {
  const workflow = await readYaml("../.github/workflows/sca.yml");

  assert.ok("pull_request" in workflow.on);
  assert.ok(workflow.on.push.branches.includes("dev-0.85.1"));
  assert.ok(Array.isArray(workflow.on.schedule) && workflow.on.schedule[0]?.cron);
  assert.equal(workflow.permissions["security-events"], "write");

  const job = workflow.jobs.osv;
  assert.match(job.uses, /google\/osv-scanner-action/);
  assert.match(job.with["scan-args"], /--include-git-root/);
  // PRs report; the scheduled run is the gate.
  assert.match(job.with["fail-on-vuln"], /github\.event_name == 'schedule'/);
});

test("Dependabot covers npm, the Go agent and actions, and pins pi packages", async () => {
  const config = await readYaml("../.github/dependabot.yml");
  const ecosystems = config.updates.map((update) => `${update["package-ecosystem"]}:${update.directory}`);

  assert.ok(ecosystems.includes("npm:/"));
  assert.ok(ecosystems.includes("gomod:/agent"));
  assert.ok(ecosystems.includes("github-actions:/"));

  const npm = config.updates.find((update) => update["package-ecosystem"] === "npm");
  const piIgnore = npm.ignore.find((entry) => entry["dependency-name"] === "@earendil-works/*");
  assert.deepEqual(piIgnore["update-types"], [
    "version-update:semver-major",
    "version-update:semver-minor",
  ]);
});
