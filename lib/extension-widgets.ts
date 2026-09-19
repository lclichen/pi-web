import type { ExtensionWidgetItem } from "@/lib/types";

/**
 * Update the extension widget list preserving insertion order: an existing
 * widget is updated in place rather than removed and re-appended (upstream
 * #839). The metadata field is our extension for the lab-training panel and
 * other rich-widget consumers.
 */
export function updateExtensionWidgets(
  widgets: ExtensionWidgetItem[],
  key: string,
  lines: string[] | undefined,
  placement: ExtensionWidgetItem["placement"] = "aboveEditor",
  metadata?: unknown,
): ExtensionWidgetItem[] {
  if (lines === undefined) return widgets.filter((widget) => widget.key !== key);

  const updatedWidget: ExtensionWidgetItem = { key, lines, placement, ...(metadata !== undefined ? { metadata } : {}) };
  const existingIndex = widgets.findIndex((widget) => widget.key === key);
  if (existingIndex === -1) return [...widgets, updatedWidget];

  return widgets.map((widget, index) => index === existingIndex ? updatedWidget : widget);
}
