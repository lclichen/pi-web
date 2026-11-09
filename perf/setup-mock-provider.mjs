#!/usr/bin/env node
/**
 * Register the load-test mock provider in a pi agent models.json (dev 批次5).
 *
 *   node perf/setup-mock-provider.mjs [--agent-dir ~/.pi/agent] \
 *     [--base-url http://127.0.0.1:3099/v1] [--provider mock-load] [--model mock-load-default]
 *
 * Writes providers.<name> = { baseUrl, api: "openai-completions", apiKey: "mock",
 * models: [...] } with a .bak backup beside the file. Sessions pick the
 * provider up at their next startRpcSession (credential runtime re-reads the
 * file per session).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "agent-dir": { type: "string" },
    "base-url": { type: "string", default: "http://127.0.0.1:3099/v1" },
    provider: { type: "string", default: "mock-load" },
    model: { type: "string", default: "mock-load-default" },
  },
});

const agentDir = args["agent-dir"] ?? path.join(os.homedir(), ".pi", "agent");
const modelsPath = path.join(agentDir, "models.json");

let doc = { providers: {} };
if (fs.existsSync(modelsPath)) {
  try {
    doc = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
    if (!doc.providers || typeof doc.providers !== "object") doc.providers = {};
    fs.copyFileSync(modelsPath, `${modelsPath}.bak`);
  } catch (error) {
    console.error(`[setup-mock-provider] ${modelsPath} unreadable (${error.message}); refusing to overwrite.`);
    process.exit(1);
  }
} else {
  fs.mkdirSync(agentDir, { recursive: true });
}

doc.providers[args.provider] = {
  baseUrl: args["base-url"],
  api: "openai-completions",
  apiKey: "mock",
  models: [
    { id: args.model, contextWindow: 128000, maxTokens: 16384 },
    { id: "mock-load-small", contextWindow: 32000, maxTokens: 8192 },
  ],
};

fs.writeFileSync(modelsPath, JSON.stringify(doc, null, 2));
console.log(`[setup-mock-provider] ${args.provider} -> ${args["base-url"]} written to ${modelsPath}`);
console.log(`[setup-mock-provider] create sessions with { "provider": "${args.provider}", "model": "${args.model}" }`);
