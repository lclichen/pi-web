import { NextResponse } from "next/server";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { resolveSessionAccess } from "@/lib/session-access";

export const dynamic = "force-dynamic";

export interface PlanVersion {
  toolCallId: string;
  savedAt: number | null;
  chars: number;
  /** First meaningful line as the version label. */
  preview: string;
  content: string;
}

// GET /api/sessions/[id]/plan-versions — every plan_save call in the session
// file (toolCall input carries the full markdown), newest last. Powers the
// PlanPanel version switcher (ZCode parity: multiple plans per session).
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await resolveSessionAccess(req, (await ctx.params).id);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  if (!access.path) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const versions: PlanVersion[] = [];
  try {
    const rl = createInterface({
      input: createReadStream(access.path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.includes("plan_save")) continue; // cheap pre-filter
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const message = (entry as { message?: unknown }).message as
        | { role?: string; content?: Array<{ type?: string; name?: string; toolCallId?: string; input?: { content?: unknown } }>; timestamp?: number }
        | undefined;
      if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type !== "toolCall" || block.name !== "plan_save") continue;
        const content = block.input?.content;
        if (typeof content !== "string" || content.trim().length === 0) continue;
        const preview = content
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("#") && !l.startsWith("---"))
          ?.slice(0, 60) ?? content.slice(0, 60);
        versions.push({
          toolCallId: block.toolCallId ?? `plan-${versions.length}`,
          savedAt: message.timestamp ?? null,
          chars: content.length,
          preview,
          content,
        });
      }
    }
  } catch {
    // unreadable session file — fall through with whatever was collected
  }
  return NextResponse.json({ versions });
}
