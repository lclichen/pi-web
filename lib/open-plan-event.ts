/**
 * Window event that opens the right-panel 计划 tab. Tool cards deep inside
 * MessageView (exit_plan_mode plan preview) dispatch it instead of threading
 * a callback through the memoized message tree — same pattern as
 * THINKING_EXPANDED_EVENT.
 */
export const OPEN_PLAN_PANEL_EVENT = "amedac:open-plan-panel";

export function openPlanPanel(): void {
  window.dispatchEvent(new CustomEvent(OPEN_PLAN_PANEL_EVENT));
}
