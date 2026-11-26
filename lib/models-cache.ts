export interface ModelsData {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string; providerName: string; input?: string[] }[];
  defaultModel: { provider: string; modelId: string } | null;
  /** Resolved thinking level a new session starts with when the user has not picked one. */
  defaultThinkingLevel: string | null;
  /** `defaultThinkingLevel` as saved in settings, which the reasoning selector's star marks. */
  savedDefaultThinkingLevel: string | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  /** `provider/modelId` → thinking level pinned by an `enabledModels` `:level` suffix. */
  thinkingLevelPins: Record<string, string>;
  modelError?: string;
  /** Warnings from resolving the `enabledModels` scope (e.g. a pattern matched nothing). */
  modelScopeWarnings?: string[];
  /** True when enabledModels is active and restricting the model list. */
  isScoped?: boolean;
}

interface ModelsCacheState {
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  generation: number;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;
/**
 * Cap the first uncached load. The SDK's package loader can run an unbounded
 * `npm install` for a configured-but-missing package; without this guard
 * /api/models never answers on a machine that cannot reach the registry.
 */
export const MODELS_LOAD_TIMEOUT_MS = 15_000;
// Never interpolate the caught error here; SDK errors can contain paths and provider details.
const SAFE_MODEL_LOAD_FAILURE_MESSAGE = "Model list is temporarily unavailable. Check your configuration and try again.";

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__piModelsCacheState;
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
}

export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

export function withSafeModelLoadFailure(data: ModelsData): ModelsData {
  return { ...data, modelError: SAFE_MODEL_LOAD_FAILURE_MESSAGE };
}

export interface LoadModelsWithCacheOptions {
  /** Cap the first uncached load; no timeout when omitted/0. */
  timeoutMs?: number;
  /** Data returned when the cap fires. Timeout results are never cached. */
  onTimeout?: () => ModelsData;
}

export function loadModelsWithCache(
  cwd: string,
  loader: () => Promise<ModelsData>,
  options: LoadModelsWithCacheOptions = {},
): Promise<ModelsData> {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (cached) {
    if (cached.expiresAt > Date.now()) return Promise.resolve(cached.data);
    state.entries.delete(cwd);
  }

  const existingLoad = state.inFlight.get(cwd);
  if (existingLoad) return existingLoad;

  const generation = state.generation;
  let loadPromise: Promise<ModelsData>;
  const work = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && state.inFlight.get(cwd) === loadPromise) {
        const now = Date.now();
        for (const [key, entry] of state.entries) {
          if (entry.expiresAt <= now) state.entries.delete(key);
        }
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(cwd, { data, expiresAt: now + MODELS_CACHE_TTL_MS });
      }
      return data;
    });

  const timeoutMs = options.timeoutMs ?? 0;
  if (timeoutMs > 0 && options.onTimeout) {
    let settled = false;
    loadPromise = new Promise<ModelsData>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // A timed-out load is forgotten, so the next call retries; its late
        // result must not land in the cache either (the generation check above
        // uses this promise's identity, which is no longer in flight).
        if (state.inFlight.get(cwd) === loadPromise) state.inFlight.delete(cwd);
        resolve(options.onTimeout!());
      }, timeoutMs);
      work.then(
        (data) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(data);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  } else {
    loadPromise = work;
  }

  state.inFlight.set(cwd, loadPromise);
  void loadPromise
    .finally(() => {
      if (state.inFlight.get(cwd) === loadPromise) state.inFlight.delete(cwd);
    })
    .catch(() => {});
  return loadPromise;
}
