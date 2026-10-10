import { getServerSettings } from "./server-settings";

/**
 * Teaching mode (lab-training integration) — single server-side source.
 *
 * Scope decision (2026-10-09): "teaching" means the Lab Training panel and
 * everything that exists only to serve the pi-lab-training extension — the
 * side panel, the remote-verify bridge, the toolbar's verify preference, the
 * turn-marker folding. Quick sessions (快速会话) are a GENERAL feature and are
 * deliberately NOT gated by this flag; neither is the widget pipeline, which
 * the lab panel only consumes.
 *
 * Everything teaching-specific that a session or route touches must consult
 * `isTeachingEnabled()` first, so a deployment with the flag off (the packaged
 * default for general-purpose installs) carries no reachable teaching surface.
 * The extension itself is installed into the agent dir by teaching
 * deployments; a general install simply has none, and the checks below keep
 * the leftover wiring inert.
 */

/** Widget key the lab-training extension publishes its panel state under. */
export const LAB_WIDGET_KEY = "lab-training";

/** Custom-message type the extension emits for panel state updates. */
export const LAB_CUSTOM_TYPE = "lab-training";

/**
 * Marker the teaching turn protocol prefixes its informational messages with;
 * the message renderer folds any custom message that carries it.
 */
export const LAB_TURN_MARKER = "【本轮教学信息】";

/** Whether teaching-mode surfaces (panel, bridge, preferences) are enabled. */
export function isTeachingEnabled(): boolean {
  return getServerSettings().labTraining;
}
