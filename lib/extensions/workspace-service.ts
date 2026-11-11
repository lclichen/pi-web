/**
 * pi-web re-export of the shared workspace event bridge. The source of truth
 * lives with the sandbox module so every runner (CLI/WebUI) uses the same
 * protocol.
 */
export * from "../../pi-config/agent/extensions/amedac-core/src/sandbox/workspace-service.ts";
