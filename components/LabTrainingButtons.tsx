"use client";

interface WidgetAction {
  id: string;
  label: string;
  command: string;
  variant: "primary" | "default" | "danger";
}

interface WidgetState {
  mode: "training" | "qa" | "idle";
  labTitle: string | null;
  sectionTitle: string | null;
  blockTitle: string | null;
  stepIndex: number;
  stepTotal: number;
  progressPercent: number;
  pendingManualConfirm: boolean;
  actions: WidgetAction[];
}

const WIDGET_KEY = "lab-training";

interface LabTrainingButtonsProps {
  extensionWidgets: Array<{ key: string; lines: string[]; placement?: string; metadata?: unknown }>;
  onSendCommand: (command: string) => void;
  disabled?: boolean;
}

export function LabTrainingButtons({
  extensionWidgets,
  onSendCommand,
  disabled,
}: LabTrainingButtonsProps) {
  const widget = extensionWidgets.find((w) => w.key === WIDGET_KEY);
  const state = (widget?.metadata as WidgetState | undefined) ?? null;

  if (!state || state.actions.length === 0) return null;

  const variantClass = {
    primary: "bg-blue-600 text-white hover:bg-blue-700",
    default: "bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200",
    danger: "bg-red-600 text-white hover:bg-red-700",
  };

  const showProgress = state.mode === "training" && state.stepTotal > 0;
  const showLocation = state.mode === "training" || state.mode === "qa";

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 px-4 py-2">
      <div className="flex items-center gap-2 mb-2">
        {state.mode === "qa" && (
          <span className="px-2 py-0.5 text-xs font-bold rounded bg-purple-600 text-white animate-pulse">
            QA MODE
          </span>
        )}
        {state.labTitle && (
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {state.labTitle}
          </span>
        )}
        {showLocation && state.sectionTitle && (
          <span className="text-xs text-gray-500">
            {state.sectionTitle}
            {state.blockTitle ? ` > ${state.blockTitle}` : ""}
          </span>
        )}
        {showProgress && (
          <span className="text-xs text-gray-400 ml-auto">
            {state.stepIndex}/{state.stepTotal} ({state.progressPercent}%)
          </span>
        )}
      </div>

      {showProgress && (
        <div className="w-full bg-gray-200 rounded-full h-1.5 dark:bg-gray-700 mb-2">
          <div
            className="bg-blue-600 h-1.5 rounded-full transition-all"
            style={{ width: `${state.progressPercent}%` }}
          />
        </div>
      )}

      {state.pendingManualConfirm && (
        <p className="text-xs text-amber-600 dark:text-amber-400 mb-2">
          Complete the step above, then click &quot;Confirm Done&quot;
        </p>
      )}

      <div className="flex gap-2 flex-wrap">
        {state.actions.map((action) => (
          <button
            key={action.id}
            onClick={() => onSendCommand(action.command)}
            disabled={disabled}
            className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${variantClass[action.variant]}`}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
