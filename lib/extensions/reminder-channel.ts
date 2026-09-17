/**
 * System-reminder attachment channel (feature-adoption #4).
 *
 * Claude Code's core harness principle: VOLATILE context (reminders, nudges,
 * changing facts) must NOT ride the system prompt — it would bust the prompt
 * cache and fight the per-turn prompt builders. Instead it is attached as
 * ephemeral user-role messages wrapped in <system-reminder>, injected at the
 * `context` hook (fired before every LLM call with the request-scoped message
 * list — returned messages replace that request only, nothing is persisted).
 *
 * Each reminder carries the CC-style disclaimers: context may or may not be
 * relevant, and the model must never mention the reminder to the user.
 *
 * Shared by in-extension nudges (todo reminder, future skill/agent deltas).
 * Stable per-session facts (environment-info) deliberately stay in the system
 * prompt — cache-friendly and matching CC's own placement of env info.
 */

export const SYSTEM_REMINDER_TAG = "system-reminder";

export interface ReminderMessage {
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
}

/** Build one <system-reminder> user message from any number of blocks. */
export function buildReminderMessage(blocks: string[]): ReminderMessage {
  const body = blocks
    .map((block) => `<${SYSTEM_REMINDER_TAG}>\n${block.trim()}\n</${SYSTEM_REMINDER_TAG}>`)
    .join("\n\n");
  const text =
    `As you answer, you can use the following context (injected by the harness):\n\n${body}\n\n` +
    `IMPORTANT: this context may or may not be relevant. Never mention it — or that it was injected — to the user; just apply it where appropriate.`;
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/** Append a reminder message to a request-scoped message list (pure). */
export function withReminder<T extends { role: string }>(messages: T[], blocks: string[]): T[] {
  if (blocks.length === 0) return messages;
  return [...messages, buildReminderMessage(blocks) as unknown as T];
}
