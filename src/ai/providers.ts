// One OpenAI-compatible chat-completions adapter covering every vision
// provider pdf2takeoff talks to: OpenRouter (one key, any model), OpenAI,
// Gemini's compatible endpoint, Z.ai and local servers (Ollama, LM Studio,
// vLLM) all speak the same request shape. Keys ride in from the caller (the
// CLI reads them from the environment) and never reach an error message or
// log — errors carry the status, the host and a body excerpt only.

export type StructuredMode = 'json_schema' | 'json_object' | 'none';

export interface VisionImage {
  base64: string;
  mime: 'image/png' | 'image/jpeg';
}

export interface VisionRequest {
  prompt: string;
  schema: Record<string, unknown>;
  schemaName: string;
  image: VisionImage;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface VisionUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface VisionResult {
  text: string;
  model: string;
  structured: StructuredMode;
  usage: VisionUsage;
  latencyMs: number;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  structured?: 'auto' | StructuredMode; // default 'auto'
  timeoutMs?: number; // default 300000
  retries?: number; // default 2 (for 429, 5xx and network errors)
  retryBaseMs?: number; // default 1000; tests pass 1
}

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  /** Environment variable holding the key; null for local servers. */
  keyEnv: string | null;
  /** Shown in help only — any model id the provider serves works. */
  exampleModel: string;
  local: boolean;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openrouter: {
    label: 'OpenRouter (one key, any model)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    exampleModel: 'google/gemini-3.5-flash',
    local: false,
    headers: { 'HTTP-Referer': 'https://pdf2takeoff.com', 'X-Title': 'pdf2takeoff' },
    extraBody: { provider: { require_parameters: true } },
  },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', exampleModel: 'gpt-5.5', local: false },
  gemini: {
    label: 'Google Gemini (OpenAI-compatible endpoint)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    exampleModel: 'gemini-3.5-flash',
    local: false,
  },
  zai: { label: 'Z.ai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', keyEnv: 'ZAI_API_KEY', exampleModel: 'glm-4.6v', local: false },
  ollama: { label: 'Ollama (local, nothing leaves the machine)', baseUrl: 'http://localhost:11434/v1', keyEnv: null, exampleModel: 'qwen3-vl:8b', local: true },
  lmstudio: { label: 'LM Studio (local, nothing leaves the machine)', baseUrl: 'http://localhost:1234/v1', keyEnv: null, exampleModel: 'qwen3-vl-8b', local: true },
};

export class ProviderError extends Error {
  /** HTTP status when the provider answered, null for timeouts. */
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 1000;
const MAX_RETRY_WAIT_MS = 30000;
const ERROR_BODY_CHARS = 300;
// statuses that, in auto mode, usually mean "this endpoint does not know
// json_schema": step down to json_object, then to no response_format at all
const FALLBACK_STATUSES: readonly number[] = [400, 404, 422];

interface Completion {
  text: string;
  model: string;
  usage: VisionUsage;
}

type ChatResponse = {
  model?: unknown;
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
};

/** A preset's config with the caller's model, key and overrides merged in. */
export function presetConfig(
  name: string,
  overrides: { model: string; apiKey?: string; baseUrl?: string; structured?: ProviderConfig['structured']; timeoutMs?: number },
): ProviderConfig {
  const preset = PROVIDER_PRESETS[name];
  if (!preset) throw new Error(`unknown provider "${name}" — available: ${Object.keys(PROVIDER_PRESETS).join(', ')}`);
  return {
    baseUrl: overrides.baseUrl ?? preset.baseUrl,
    apiKey: overrides.apiKey,
    model: overrides.model,
    ...(preset.headers ? { headers: { ...preset.headers } } : {}),
    ...(preset.extraBody ? { extraBody: { ...preset.extraBody } } : {}),
    structured: overrides.structured,
    timeoutMs: overrides.timeoutMs,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The one model turn: text as a string, or the parts list some providers
 *  return, joined. An empty text is a failure and says why via finish_reason. */
function completionFrom(text: string, host: string, fallbackModel: string): Completion {
  let data: ChatResponse;
  try {
    data = JSON.parse(text) as ChatResponse;
  } catch {
    throw new ProviderError(`invalid response from ${host}: ${text.slice(0, ERROR_BODY_CHARS)}`);
  }
  const choice = data.choices?.[0];
  const raw = choice?.message?.content;
  const out =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw
            .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
            .join('')
        : '';
  if (!out) throw new ProviderError(`empty completion from ${host} (finish_reason: ${String(choice?.finish_reason ?? 'unknown')})`);
  const usage = data.usage ?? {};
  return {
    text: out,
    model: typeof data.model === 'string' && data.model ? data.model : fallbackModel,
    usage: {
      ...(typeof usage.prompt_tokens === 'number' ? { inputTokens: usage.prompt_tokens } : {}),
      ...(typeof usage.completion_tokens === 'number' ? { outputTokens: usage.completion_tokens } : {}),
      ...(typeof usage.cost === 'number' ? { costUsd: usage.cost } : {}),
    },
  };
}

/**
 * One vision request through an OpenAI-compatible chat-completions endpoint.
 * In structured 'auto' mode the request walks json_schema → json_object →
 * none, stepping down whenever the endpoint rejects the format with 400/404/
 * 422; an explicit mode sends only that mode. 429, 5xx and network errors
 * retry (retry-after honoured, else exponential backoff); other statuses
 * throw at once. The key is sent as a bearer header and never logged.
 */
export async function completeVision(cfg: ProviderConfig, req: VisionRequest, fetchImpl: typeof fetch = globalThis.fetch): Promise<VisionResult> {
  const retries = cfg.retries ?? DEFAULT_RETRIES;
  const retryBaseMs = cfg.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const want = cfg.structured ?? 'auto';
  const modes: StructuredMode[] = want === 'auto' ? ['json_schema', 'json_object', 'none'] : [want];
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const host = new URL(url).host;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...cfg.headers };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const started = Date.now();

  // one POST for one structured mode, with the retry loop inlined
  const send = async (mode: StructuredMode): Promise<Completion> => {
    const body: Record<string, unknown> = {
      ...cfg.extraBody,
      model: cfg.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: req.prompt },
            { type: 'image_url', image_url: { url: `data:${req.image.mime};base64,${req.image.base64}` } },
          ],
        },
      ],
    };
    if (mode === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } };
    else if (mode === 'json_object') body.response_format = { type: 'json_object' };
    const payload = JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      // each attempt gets the full timeout, combined with the caller's signal
      let timedOut = false;
      const timer = new AbortController();
      const t = setTimeout(() => {
        timedOut = true;
        timer.abort();
      }, timeoutMs);
      const signal = req.signal ? AbortSignal.any([timer.signal, req.signal]) : timer.signal;
      try {
        const res = await fetchImpl(url, { method: 'POST', headers, body: payload, signal });
        const text = await res.text();
        if (!res.ok) {
          const err = new ProviderError(`${res.status} from ${host}: ${text.slice(0, ERROR_BODY_CHARS)}`, res.status);
          if ((res.status === 429 || res.status >= 500) && attempt < retries) {
            // honour the server's retry-after (seconds), else exponential backoff
            const retryAfter = res.headers.get('retry-after');
            const afterS = retryAfter ? Number(retryAfter) : NaN;
            await sleep(Number.isFinite(afterS) && afterS >= 0 ? Math.min(MAX_RETRY_WAIT_MS, afterS * 1000) : retryBaseMs * 3 ** attempt);
            continue;
          }
          throw err;
        }
        return completionFrom(text, host, cfg.model);
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (timedOut) throw new ProviderError(`timed out after ${Math.round(timeoutMs / 1000)} s`);
        if (req.signal?.aborted) throw err; // the caller cancelled: not ours to retry
        if (attempt >= retries) throw err; // a network error that never recovered
        await sleep(retryBaseMs * 3 ** attempt);
      } finally {
        clearTimeout(t);
      }
    }
  };

  let last: ProviderError | undefined;
  for (const mode of modes) {
    try {
      const completion = await send(mode);
      return { ...completion, structured: mode, latencyMs: Date.now() - started };
    } catch (err) {
      // a structured-output rejection: step down while auto mode has rungs left
      if (err instanceof ProviderError && err.status !== null && FALLBACK_STATUSES.includes(err.status)) {
        last = err;
        continue;
      }
      throw err;
    }
  }
  throw last;
}
