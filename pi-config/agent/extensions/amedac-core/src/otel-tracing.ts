/**
 * amedac-core OTLP tracing (zero-dependency, OTLP/HTTP JSON).
 *
 * Targets self-hosted MLflow (default `http://localhost:8087`) and follows the
 * GenAI semantic conventions where they exist:
 *   invoke_agent  (root, one per user prompt)
 *   ├─ turn
 *   ├─ chat <model>       (one per assistant message / provider request)
 *   └─ execute_tool <tool (one per tool call)
 *
 * MLflow translation:
 *   gen_ai.operation.name  → AGENT / CHAT_MODEL / TOOL span types
 *   gen_ai.conversation.id  → session grouping (required by the product)
 *   gen_ai.input.messages / gen_ai.output.messages → chat content
 *   gen_ai.tool.call.arguments / result            → tool input/output
 *
 * Config precedence:
 *   1. PI_OTEL_DISABLED=1 disables.
 *   2. PI_OTEL_ENABLED=1 + endpoint env forces env config.
 *   3. pi-web's <dataDir>/server-settings.json `otel*` fields (global config UI).
 *   4. OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT / PI_OTEL_ENDPOINT env (CLI).
 *   5. ~/.pi/agent/settings.json `otel` block (CLI).
 *
 * Only Node built-ins are used so the extension works in offline deployments.
 * Content (prompt / assistant text / tool args+results) is sent to the
 * configured OTLP endpoint; point it at a trusted collector.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_ENDPOINT = "http://localhost:8087";
const DEFAULT_SERVICE_NAME = "amedac-pi-web";
const MAX_ATTR_CHARS = 60 * 1024;
const MAX_QUEUE = 2048;
const FLUSH_INTERVAL_MS = 2_000;
const POST_TIMEOUT_MS = 15_000;
const ACTIVE_AGENT_TAG = /^<active_agent name="([^"]+)"\/>$/gmu;
const IDENTITY_REGISTRY_KEY = "@agegr/pi-web/session-identity/v1";

export interface OTelTracingConfig {
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
}

type AttributeValue = string | number | boolean | readonly string[] | { double: number };
type Attributes = Record<string, AttributeValue>;

interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1 | 3;
  startNs: bigint;
  endNs?: bigint;
  attributes: Attributes;
  status?: { code: 1 | 2; message?: string };
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseHeaderList(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key && !/[\r\n]/.test(value)) out[key] = value;
  }
  return out;
}

function sanitizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (!name || name.length > 128 || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;
    if (typeof value !== "string" || /[\r\n]/.test(value) || value.length > 4096) continue;
    out[name] = value;
  }
  return out;
}

function normalizeEndpoint(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) return null;
  return value;
}

/** Accept a base URL or a full `/v1/traces` endpoint. */
export function otelTracesUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  return /\/v1\/traces$/i.test(trimmed) ? trimmed : `${trimmed}/v1/traces`;
}

function envConfig(): OTelTracingConfig | null {
  const endpoint =
    normalizeEndpoint(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) ??
    normalizeEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) ??
    normalizeEndpoint(process.env.PI_OTEL_ENDPOINT);
  if (!endpoint) return null;
  const headers = {
    ...parseHeaderList(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseHeaderList(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
  };
  return {
    endpoint,
    headers,
    serviceName: (process.env.OTEL_SERVICE_NAME ?? "").trim() || DEFAULT_SERVICE_NAME,
  };
}

function cliSettingsConfig(): OTelTracingConfig | null {
  const settings = readJson(join(homedir(), ".pi", "agent", "settings.json"));
  const otel = settings?.otel as Record<string, unknown> | undefined;
  if (!otel || typeof otel !== "object") return null;
  if (otel.enabled === false) return null;
  const endpoint = normalizeEndpoint(otel.endpoint);
  if (!endpoint) return null;
  const headers = sanitizeHeaders(otel.headers);
  return {
    endpoint,
    headers,
    serviceName:
      (typeof otel.serviceName === "string" && otel.serviceName.trim()) || DEFAULT_SERVICE_NAME,
  };
}

/**
 * Resolve the effective tracing config. Returns null when tracing is disabled
 * or no endpoint is configured anywhere.
 */
export function resolveOTelTracingConfig(): OTelTracingConfig | null {
  if (truthy(process.env.PI_OTEL_DISABLED)) return null;

  // pi-web global config: settings are deployment-wide and read on every new
  // prompt, so an admin toggle applies without a server restart.
  const dataDir = process.env.PI_WEB_DATA_DIR?.trim() || join(process.cwd(), "data");
  const web = readJson(join(dataDir, "server-settings.json"));
  if (web && typeof web.otelEnabled === "boolean") {
    if (!truthy(process.env.PI_OTEL_ENABLED) && web.otelEnabled === false) return null;
    const endpoint = normalizeEndpoint(web.otelEndpoint) ?? DEFAULT_ENDPOINT;
    return {
      endpoint,
      headers: {
        ...sanitizeHeaders(web.otelHeaders),
        ...parseHeaderList(process.env.OTEL_EXPORTER_OTLP_HEADERS),
        ...parseHeaderList(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
      },
      serviceName:
        (typeof web.otelServiceName === "string" && web.otelServiceName.trim()) || DEFAULT_SERVICE_NAME,
    };
  }

  if (truthy(process.env.PI_OTEL_ENABLED)) return envConfig();
  return envConfig() ?? cliSettingsConfig();
}

// ---------------------------------------------------------------------------
// OTLP/HTTP JSON exporter
// ---------------------------------------------------------------------------

interface ExporterState {
  queue: SpanRecord[];
  timer?: ReturnType<typeof setInterval>;
  sending: boolean;
  pending?: boolean;
  active?: Promise<void>;
  config?: OTelTracingConfig;
}

const EXPORTER_KEY = Symbol.for("amedac-otel-exporter/v1");
function exporterState(): ExporterState {
  const store = globalThis as Record<PropertyKey, unknown>;
  const existing = store[EXPORTER_KEY] as ExporterState | undefined;
  if (existing) return existing;
  const created: ExporterState = { queue: [], sending: false };
  store[EXPORTER_KEY] = created;
  return created;
}

function anyValue(value: AttributeValue): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => ({ stringValue: item })) } };
  }
  return { doubleValue: (value as { double: number }).double };
}

function encodeAttributes(attributes: Attributes): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

function spanJson(span: SpanRecord): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: span.startNs.toString(),
    endTimeUnixNano: (span.endNs ?? span.startNs).toString(),
    attributes: encodeAttributes(span.attributes),
    ...(span.status ? { status: span.status } : {}),
  };
}

function tracePayload(spans: SpanRecord[], config: OTelTracingConfig): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: encodeAttributes({
            "service.name": config.serviceName,
            "service.version": "1.0.0",
            "telemetry.sdk.name": "amedac-otel",
            "telemetry.sdk.language": "typescript",
          }),
        },
        scopeSpans: [
          {
            scope: { name: "amedac-otel", version: "1.0.0" },
            spans: spans.map(spanJson),
          },
        ],
      },
    ],
  };
}

async function postBatch(spans: SpanRecord[], config: OTelTracingConfig): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(otelTracesUrl(config.endpoint), {
      method: "POST",
      headers: {
        ...config.headers,
        "content-type": "application/json",
        // MLflow's WSGI bridge can leave gzip/deflate responses dangling for
        // Node's fetch (the body never settles); identity keeps ingestion fast.
        "accept-encoding": "identity",
      },
      body: JSON.stringify(tracePayload(spans, config)),
      signal: controller.signal,
    });
  } catch {
    // Tracing must never affect the agent loop; failed batches are dropped.
  } finally {
    clearTimeout(timer);
  }
}

async function flushOTel(): Promise<void> {
  const state = exporterState();
  if (state.sending) {
    // A flush is already in flight; make it drain spans queued after it
    // started instead of dropping the request (important on shutdown).
    state.pending = true;
    await state.active;
    return;
  }
  if (!state.config || state.queue.length === 0) return;
  state.sending = true;
  const task = (async () => {
    do {
      state.pending = false;
      while (state.config && state.queue.length > 0) {
        const config = state.config;
        const batch = state.queue.splice(0, state.queue.length);
        await postBatch(batch, config);
      }
    } while (state.pending);
  })();
  state.active = task;
  try {
    await task;
  } finally {
    state.sending = false;
    state.active = undefined;
  }
}

function enqueueSpan(span: SpanRecord, config: OTelTracingConfig): void {
  const state = exporterState();
  state.config = config;
  state.queue.push(span);
  if (state.queue.length > MAX_QUEUE) state.queue.splice(0, state.queue.length - MAX_QUEUE);
  if (!state.timer) {
    state.timer = setInterval(() => void flushOTel(), FLUSH_INTERVAL_MS);
    state.timer.unref?.();
  }
}

// ---------------------------------------------------------------------------
// span tree
// ---------------------------------------------------------------------------

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function nowNs(): bigint {
  return BigInt(Date.now()) * BigInt(1_000_000);
}

function clamp(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_ATTR_CHARS ? `${text.slice(0, MAX_ATTR_CHARS)}…[truncated]` : text;
}

function messageParts(content: unknown): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (!Array.isArray(content)) return parts;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string" && item.text) {
      parts.push({ type: "text", content: item.text });
    } else if (
      item.type === "toolCall" ||
      item.type === "tool_call" ||
      item.type === "tool_use"
    ) {
      const name = item.name ?? item.toolName ?? item.tool_name;
      if (typeof name === "string") {
        parts.push({
          type: "tool_call",
          id: item.id ?? item.toolCallId ?? item.tool_call_id,
          name,
          arguments: item.arguments ?? item.input ?? item.args ?? {},
        });
      }
    }
  }
  return parts;
}

function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return Boolean(part) && typeof part === "object" && part.type === "text" && typeof part.text === "string";
    })
    .map((part) => part.text)
    .join("\n");
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const item = part as Record<string, unknown>;
        return typeof item.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function usageAttributes(usage: unknown, attrs: Attributes): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const num = (key: string): number | undefined => (typeof u[key] === "number" ? (u[key] as number) : undefined);
  const input = num("input");
  const output = num("output");
  const cacheRead = num("cacheRead") ?? 0;
  const cacheWrite = num("cacheWrite") ?? 0;
  if (input !== undefined) attrs["gen_ai.usage.input_tokens"] = input + cacheRead + cacheWrite;
  if (output !== undefined) attrs["gen_ai.usage.output_tokens"] = output;
  if (cacheRead) attrs["gen_ai.usage.cache_read.input_tokens"] = cacheRead;
  if (cacheWrite) attrs["gen_ai.usage.cache_creation.input_tokens"] = cacheWrite;
  const reasoning = num("reasoning");
  if (reasoning !== undefined) attrs["gen_ai.usage.reasoning_tokens"] = reasoning;
}

interface SessionIdentity {
  userId: number | string;
  userName?: string;
}

function identityFor(sessionId: string, parentSessionId?: string): SessionIdentity | undefined {
  const store = globalThis as Record<PropertyKey, unknown>;
  const registry = store[Symbol.for(IDENTITY_REGISTRY_KEY)] as
    | { get?: (id: string) => SessionIdentity | undefined }
    | undefined;
  if (!registry?.get) return undefined;
  return registry.get(sessionId) ?? (parentSessionId ? registry.get(parentSessionId) : undefined);
}

function detectAgentName(systemPrompt: string | undefined): string | undefined {
  if (!systemPrompt) return undefined;
  return [...systemPrompt.matchAll(ACTIVE_AGENT_TAG)].at(-1)?.[1];
}

class SessionTracer {
  private readonly sessionId: string;
  private readonly parentSessionId: string | undefined;
  private readonly identity: SessionIdentity | undefined;
  private readonly sessionKind: "main" | "subagent";
  private config: OTelTracingConfig;
  private traceId = "";
  private root: SpanRecord | undefined;
  private turn: SpanRecord | undefined;
  private chat: SpanRecord | undefined;
  private readonly tools = new Map<string, SpanRecord>();
  private prompt = "";
  private agentName = DEFAULT_SERVICE_NAME;
  private hadError = false;
  private lastOutput = "";
  private lastAssistantText = "";
  private lastModel = "";
  private lastResponseModel = "";
  private lastProvider = "";

  constructor(config: OTelTracingConfig, ctx: ExtensionContext) {
    this.config = config;
    this.sessionId = ctx.sessionManager.getSessionId();
    const header = ctx.sessionManager.getHeader() as { parentSession?: string } | undefined;
    const parentPath = header?.parentSession;
    this.parentSessionId = parentPath ? basename(parentPath, ".jsonl") : undefined;
    this.sessionKind = this.parentSessionId ? "subagent" : "main";
    this.identity = identityFor(this.sessionId, this.parentSessionId);
  }

  updateConfig(config: OTelTracingConfig): void {
    this.config = config;
  }

  sessionKey(): string {
    return this.sessionId;
  }

  private common(): Attributes {
    return {
      "gen_ai.conversation.id": this.sessionId,
      "pi.session.id": this.sessionId,
      // MLflow's OTLP ingestion checks session.id before gen_ai.conversation.id.
      "session.id": this.sessionId,
      "pi.session.kind": this.sessionKind,
      ...(this.parentSessionId ? { "pi.parent.session.id": this.parentSessionId } : {}),
      ...(this.identity ? { "user.id": this.identity.userId } : {}),
      ...(this.identity?.userName ? { "user.name": this.identity.userName } : {}),
    };
  }

  private start(
    name: string,
    kind: 1 | 3,
    parent: SpanRecord | undefined,
    attributes: Attributes = {},
    startTimeMs?: number,
  ): SpanRecord {
    const span: SpanRecord = {
      traceId: this.traceId,
      spanId: randomHex(8),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name,
      kind,
      startNs: startTimeMs !== undefined ? BigInt(startTimeMs) * BigInt(1_000_000) : nowNs(),
      attributes: { ...this.common(), ...attributes },
    };
    return span;
  }

  private finish(span: SpanRecord, status?: { code: 1 | 2; message?: string }): void {
    span.endNs = nowNs();
    if (status) span.status = status;
    enqueueSpan(span, this.config);
  }

  startPrompt(prompt: string, systemPrompt: string | undefined): void {
    if (this.root) this.endPrompt();
    this.traceId = randomHex(16);
    this.prompt = typeof prompt === "string" ? prompt : "";
    this.hadError = false;
    this.lastOutput = "";
    this.lastAssistantText = "";
    this.lastModel = "";
    this.lastResponseModel = "";
    this.lastProvider = "";
    this.agentName = detectAgentName(systemPrompt) ?? DEFAULT_SERVICE_NAME;
    const inputMessages = JSON.stringify([
      { role: "user", parts: [{ type: "text", content: this.prompt }] },
    ]);
    this.root = this.start(`invoke_agent ${this.agentName}`, 1, undefined, {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": this.agentName,
      "gen_ai.system": "pi",
      "gen_ai.input.messages": clamp(inputMessages),
      "pi.user_prompt": clamp(this.prompt),
    });
  }

  startTurn(turnIndex: number, timestamp?: number): void {
    if (!this.root) return;
    if (this.turn) this.finish(this.turn);
    this.turn = this.start("turn", 1, this.root, { "pi.turn.index": turnIndex }, timestamp);
  }

  endTurn(): void {
    if (!this.turn) return;
    this.finish(this.turn);
    this.turn = undefined;
  }

  startChat(message: Record<string, unknown>): void {
    if (!this.root) return;
    if (this.chat) this.finish(this.chat);
    const model = typeof message.model === "string" ? message.model : undefined;
    const provider = typeof message.provider === "string" ? message.provider : undefined;
    this.chat = this.start(`chat ${model ?? "model"}`, 3, this.turn ?? this.root, {
      "gen_ai.operation.name": "chat",
      "gen_ai.system": "pi",
      ...(provider ? { "gen_ai.provider.name": provider } : {}),
      ...(model ? { "gen_ai.request.model": model } : {}),
      "gen_ai.input.messages": clamp(
        JSON.stringify([{ role: "user", parts: [{ type: "text", content: this.prompt }] }]),
      ),
    });
  }

  endChat(message: Record<string, unknown>): void {
    if (!this.root) return;
    if (!this.chat) {
      this.startChat(message);
    }
    if (!this.chat) return;
    const attrs: Attributes = {};
    const provider = typeof message.provider === "string" ? message.provider : undefined;
    const model = typeof message.model === "string" ? message.model : undefined;
    const responseModel = typeof message.responseModel === "string" ? message.responseModel : model;
    if (provider) attrs["gen_ai.provider.name"] = provider;
    if (model) attrs["gen_ai.request.model"] = model;
    if (responseModel) attrs["gen_ai.response.model"] = responseModel;
    if (provider) this.lastProvider = provider;
    if (model) this.lastModel = model;
    if (responseModel) this.lastResponseModel = responseModel;
    if (typeof message.responseId === "string") attrs["gen_ai.response.id"] = message.responseId;
    if (typeof message.stopReason === "string") attrs["gen_ai.response.finish_reasons"] = [message.stopReason];
    usageAttributes(message.usage, attrs);
    const parts = messageParts(message.content);
    const outputMessages = JSON.stringify([{ role: "assistant", parts }]);
    this.lastOutput = outputMessages;
    attrs["gen_ai.output.messages"] = clamp(outputMessages);
    const text = assistantText(message.content);
    if (text) {
      this.lastAssistantText = text;
      attrs["pi.assistant_response"] = clamp(text);
    }

    const status =
      message.stopReason === "error" || message.stopReason === "aborted"
        ? {
            code: 2 as const,
            ...(typeof message.errorMessage === "string" && message.errorMessage
              ? { message: clamp(message.errorMessage) }
              : {}),
          }
        : { code: 1 as const };
    if (status.code === 2) this.hadError = true;
    this.chat.attributes = { ...this.chat.attributes, ...attrs };
    this.chat.endNs = nowNs();
    this.chat.status = status;
    enqueueSpan(this.chat, this.config);
    this.chat = undefined;
  }

  startTool(event: Record<string, unknown>): void {
    if (!this.root) return;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const span = this.start(`execute_tool ${toolName}`, 1, this.turn ?? this.root, {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": toolName,
      ...(toolCallId ? { "gen_ai.tool.call.id": toolCallId } : {}),
      ...(event.args !== undefined ? { "gen_ai.tool.call.arguments": clamp(event.args) } : {}),
    });
    if (toolCallId) this.tools.set(toolCallId, span);
    else this.finish(span);
  }

  endTool(event: Record<string, unknown>): void {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (!toolCallId) return;
    const span = this.tools.get(toolCallId);
    if (!span) return;
    this.tools.delete(toolCallId);
    if (event.result !== undefined) {
      span.attributes["gen_ai.tool.call.result"] = clamp(toolResultText(event.result));
    }
    if (event.isError) this.hadError = true;
    this.finish(
      span,
      event.isError ? { code: 2, message: "tool_error" } : { code: 1 },
    );
  }

  endPrompt(): void {
    if (this.chat) this.finish(this.chat);
    this.chat = undefined;
    if (this.turn) this.finish(this.turn);
    this.turn = undefined;
    for (const span of this.tools.values()) this.finish(span, { code: 1 });
    this.tools.clear();
    if (this.root) {
      // The MLflow traces table's Response column reads the root span outputs.
      // Mirror the final assistant message onto the agent span as well.
      if (this.lastOutput) this.root.attributes["gen_ai.output.messages"] = clamp(this.lastOutput);
      if (this.lastAssistantText) {
        this.root.attributes["pi.assistant_response"] = clamp(this.lastAssistantText);
      }
      if (this.lastModel) this.root.attributes["gen_ai.request.model"] = this.lastModel;
      if (this.lastResponseModel) this.root.attributes["gen_ai.response.model"] = this.lastResponseModel;
      if (this.lastProvider) this.root.attributes["gen_ai.provider.name"] = this.lastProvider;
      this.finish(this.root, this.hadError ? { code: 2 } : { code: 1 });
    }
    this.root = undefined;
  }

  interrupt(): void {
    if (this.chat) this.finish(this.chat, { code: 2, message: "interrupted" });
    this.chat = undefined;
    if (this.turn) this.finish(this.turn, { code: 2, message: "interrupted" });
    this.turn = undefined;
    for (const span of this.tools.values()) this.finish(span, { code: 2, message: "interrupted" });
    this.tools.clear();
    if (this.root) this.finish(this.root, { code: 2, message: "interrupted" });
    this.root = undefined;
  }
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export function makeOtelTracingExtension(): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    let tracer: SessionTracer | null = null;

    const active = (ctx: ExtensionContext): SessionTracer | null => {
      const config = resolveOTelTracingConfig();
      if (!config) {
        tracer?.endPrompt();
        tracer = null;
        return null;
      }
      if (!tracer || tracer.sessionKey() !== ctx.sessionManager.getSessionId()) {
        tracer?.endPrompt();
        tracer = new SessionTracer(config, ctx);
      } else {
        tracer.updateConfig(config);
      }
      return tracer;
    };

    pi.on("session_start", async (_event, ctx) => {
      active(ctx);
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const current = active(ctx);
      current?.startPrompt(event.prompt, event.systemPrompt);
    });

    pi.on("turn_start", async (event) => {
      tracer?.startTurn(event.turnIndex, event.timestamp);
    });
    pi.on("turn_end", async () => {
      tracer?.endTurn();
    });

    pi.on("message_start", async (event) => {
      const message = event.message as unknown as Record<string, unknown>;
      if (message?.role === "assistant") tracer?.startChat(message);
    });
    pi.on("message_end", async (event) => {
      const message = event.message as unknown as Record<string, unknown>;
      if (message?.role === "assistant") tracer?.endChat(message);
    });

    pi.on("tool_execution_start", async (event) => {
      tracer?.startTool(event as unknown as Record<string, unknown>);
    });
    pi.on("tool_execution_end", async (event) => {
      tracer?.endTool(event as unknown as Record<string, unknown>);
    });

    pi.on("agent_settled", async () => {
      tracer?.endPrompt();
      void flushOTel();
    });

    pi.on("session_shutdown", async () => {
      tracer?.endPrompt();
      await flushOTel();
    });
  };
}

/** Test/ops hook: flush queued spans without waiting for the timer. */
export async function flushOtelTracing(): Promise<void> {
  await flushOTel();
}
