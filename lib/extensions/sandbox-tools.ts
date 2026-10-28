/**
 * Re-export shim for the amedac-core sandbox tools extension (single source
 * of truth in pi-config/agent/extensions/amedac-core/src/sandbox — the same
 * package the pi CLI ships; merged from the retired standalone
 * pi-sandbox-extension package). pi-web injects this factory inline per
 * sandbox session (agent/new, session-restore-options, subagent-bridge);
 * non-sandbox sessions never load it.
 */
export {
  makeSandboxToolsExtension,
  sandboxConfigPresent,
} from "../../pi-config/agent/extensions/amedac-core/src/sandbox/index.ts";
export { matchRuntimeConfigFile } from "../../pi-config/agent/extensions/amedac-core/src/sandbox/config-bridge.ts";
