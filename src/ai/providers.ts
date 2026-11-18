// Provider-agnostic streaming chat client. Uses global fetch (Node 18+/Electron).

export type ProviderId = 'ollama' | 'lmstudio' | 'openaiCompatible' | 'llmGateway' | 'openai' | 'anthropic' | 'gemini';

export interface ProviderConfig {
  id: ProviderId;
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature: number;
  ollamaContextLength: number;
  /** How much reasoning models think before answering; undefined leaves the provider default. */
  reasoningEffort?: ReasoningEffort;
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  json?: boolean;
  /** Optional JSON Schema for grammar-constrained generation (used by Ollama `format`). */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: (delta: string, total: string) => void;
  maxTokens?: number;
}

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  local: boolean;
  needsKey: boolean;
  defaultBaseUrl: string;
  defaultModel: string;
  detail: string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    local: true,
    needsKey: false,
    defaultBaseUrl: 'http://localhost:11434',
    defaultModel: '',
    detail: 'Local models via Ollama — private, free, offline',
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    local: true,
    needsKey: false,
    defaultBaseUrl: 'http://localhost:1234/v1',
    defaultModel: '',
    detail: 'Local models via the LM Studio server',
  },
  openaiCompatible: {
    id: 'openaiCompatible',
    label: 'OpenAI-compatible',
    local: true,
    needsKey: false,
    defaultBaseUrl: 'http://localhost:8000/v1',
    defaultModel: '',
    detail: 'vLLM, llama.cpp server, LiteLLM, OpenRouter, Groq, Together, …',
  },
  llmGateway: {
    id: 'llmGateway',
    label: 'OpenZiti LLM Gateway',
    // Even on localhost the gateway may route requests to cloud providers, so it is never treated as local.
    local: false,
    needsKey: false,
    defaultBaseUrl: 'http://localhost:8080/v1',
    defaultModel: '',
    detail: 'openziti/llm-gateway — routes to OpenAI, Anthropic, or local models; reachable over zrok/OpenZiti',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    local: false,
    needsKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    detail: 'GPT models via the OpenAI API',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    local: false,
    needsKey: true,
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5-5',
    detail: 'Claude models via the Anthropic API',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    local: false,
    needsKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    // Google's alias for its current stable Flash model, so the default does not go stale.
    defaultModel: 'gemini-flash-latest',
    detail: 'Gemini models via Google AI Studio',
  },
};

/** True when a base URL points at this machine, so requests to it stay local. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** Whether a configured provider keeps code on this machine (local servers may point at a remote host). */
export function staysLocal(id: ProviderId, baseUrl: string): boolean {
  return PROVIDERS[id].local && isLoopbackUrl(baseUrl || PROVIDERS[id].defaultBaseUrl);
}

/** Providers whose base URL is user-chosen, so keys are scoped to the server origin. */
export function isUserServer(id: ProviderId): boolean {
  return id === 'openaiCompatible' || id === 'llmGateway';
}

/** SecretStorage key for a provider's API key; scoped to the base URL origin for user-chosen servers. */
export function secretKeyForProvider(id: ProviderId, baseUrl?: string): string {
  if (isUserServer(id)) {
    const raw = baseUrl || PROVIDERS[id].defaultBaseUrl;
    try {
      return `prThis.apiKey.${id}.${new URL(raw).origin.toLowerCase()}`;
    } catch {
      return `prThis.apiKey.${id}.${raw.trim().toLowerCase()}`;
    }
  }
  return `prThis.apiKey.${id}`;
}

/** True when sending an API key to `baseUrl` would transmit it over cleartext HTTP to a non-loopback host. */
export function isInsecureRemoteUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === 'http:' && !isLoopbackUrl(baseUrl);
  } catch {
    return false;
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly needsConfig = false,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Reasoning models (o-series, GPT-5) reject `temperature`, and current Claude models
 * (Opus 4.7 and later, Sonnet 5 and later, Haiku 5.5, Fable) reject sampling parameters.
 * Leaving `temperature` out is always valid, so it is sent only to model families known to accept it.
 */
export function acceptsTemperature(id: ProviderId, model: string): boolean {
  // The LLM gateway routes by model prefix (claude-* → Anthropic, gpt-*/o* → OpenAI), so apply that provider's rule.
  if (id === 'llmGateway') {
    if (/^claude-/i.test(model)) return acceptsTemperature('anthropic', model);
    if (/^(gpt|o\d)/i.test(model)) return acceptsTemperature('openai', model);
    return true;
  }
  if (id === 'openai') return !/^(o\d|gpt-5)/i.test(model);
  if (id === 'anthropic') return /^claude-(3|(opus|sonnet|haiku)-4-[0-6](?!\d))/i.test(model);
  return true;
}

/** Claude models that take the server-side refusal fallback (`fallbacks: "default"`). */
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5-2']);
const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const ANTHROPIC_MAX_TOKENS = 32000;
const ANTHROPIC_LEGACY_MAX_TOKENS = 8192;

/** Changes a request after a 400 that names one of its parameters; returns false when nothing applies. */
type Adjust = (body: Record<string, unknown>, headers: Record<string, string>, message: string) => boolean;

const adjustOpenAI: Adjust = (body, _headers, message) => {
  if (/reasoning_effort/i.test(message) && 'reasoning_effort' in body) {
    delete body.reasoning_effort;
    return true;
  }
  if (/temperature/i.test(message) && 'temperature' in body) {
    delete body.temperature;
    return true;
  }
  if (/max_tokens/i.test(message) && 'max_tokens' in body) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    return true;
  }
  if (/response_format/i.test(message) && 'response_format' in body) {
    delete body.response_format;
    return true;
  }
  return false;
};

const adjustAnthropic: Adjust = (body, headers, message) => {
  if (/effort|output_config/i.test(message) && 'output_config' in body) {
    delete body.output_config;
    return true;
  }
  if (/temperature/i.test(message) && 'temperature' in body) {
    delete body.temperature;
    return true;
  }
  if (/fallback/i.test(message) && 'fallbacks' in body) {
    delete body.fallbacks;
    delete headers['anthropic-beta'];
    return true;
  }
  if (/max_tokens/i.test(message) && Number(body.max_tokens) > ANTHROPIC_LEGACY_MAX_TOKENS) {
    body.max_tokens = ANTHROPIC_LEGACY_MAX_TOKENS;
    return true;
  }
  return false;
};

const adjustOllama: Adjust = (body, _headers, message) => {
  if (/think/i.test(message) && 'think' in body) {
    delete body.think;
    return true;
  }
  if (/format|schema/i.test(message) && typeof body.format === 'object') {
    body.format = 'json';
    return true;
  }
  return false;
};

const noAdjust: Adjust = () => false;

/**
 * POST a JSON body; when the provider rejects one of its parameters with a 400 (an older
 * model, a reasoning model, a compatible server that lacks a feature), adjust and retry.
 */
async function postAdapting(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  cfg: ProviderConfig,
  adjust: Adjust,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(url, { method: 'POST', signal, headers, body: JSON.stringify(body) }, cfg);
    } catch (e) {
      if (attempt >= 3 || !(e instanceof ProviderError) || e.status !== 400 || !adjust(body, headers, e.message)) throw e;
    }
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

async function request(url: string, init: RequestInit, cfg: ProviderConfig): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'error' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    const meta = PROVIDERS[cfg.id];
    if (cfg.id === 'llmGateway') {
      throw new ProviderError(
        `Couldn't reach ${meta.label} at ${cfg.baseUrl}. Is \`llm-gateway run\` (or \`zrok access private <token>\` for a zrok share) running?`,
        true,
      );
    }
    throw new ProviderError(
      meta.local
        ? `Couldn't reach ${meta.label} at ${cfg.baseUrl}. Is it running?`
        : `Network error contacting ${meta.label}: ${(e as Error).message}`,
      true,
    );
  }
  if (!res.ok) {
    let body = await res.text().catch(() => '');
    try {
      const j = JSON.parse(body);
      body = j.error?.message ?? j.error ?? j.message ?? body;
    } catch {
      /* not json */
    }
    const auth = res.status === 401 || res.status === 403;
    throw new ProviderError(
      `${PROVIDERS[cfg.id].label} returned ${res.status}${auth ? ' (check your API key)' : ''}: ${String(body).slice(0, 400)}`,
      auth || res.status === 404,
      res.status,
    );
  }
  return res;
}

/** Iterate over lines of a streaming response body. */
async function* lines(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) yield buf;
}

async function* sse(res: Response): AsyncGenerator<unknown> {
  for await (const line of lines(res)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      yield JSON.parse(data);
    } catch {
      /* skip keep-alive / malformed */
    }
  }
}

/**
 * Pick an Ollama context window (`num_ctx`) from fixed tiers so it fits the prompt + output
 * without over-allocating KV cache on small diffs (or reloading the model on every request).
 */
export function selectOllamaNumCtx(messages: ChatMessage[], configuredMax: number, maxOutputTokens = 4096): number {
  const promptChars = messages.reduce((sum, m) => sum + m.content.length + 16, 0);
  const needed = Math.ceil(promptChars / 3) + maxOutputTokens;
  const tiers = [8192, 16384, 32768, 65536, 131072];
  for (const t of tiers) {
    if (t >= needed && t <= configuredMax) return t;
  }
  return configuredMax;
}

export interface ProviderAdapter {
  buildRequest(cfg: ProviderConfig, messages: ChatMessage[], opts: ChatOptions): {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
  adjust: Adjust;
  parse(res: Response, emit: (delta: string | undefined) => void): Promise<void>;
}

const ollamaAdapter: ProviderAdapter = {
  buildRequest(cfg, messages, opts) {
    const numPredict = opts.maxTokens ?? (opts.json ? 4096 : undefined);
    const numCtx = selectOllamaNumCtx(messages, cfg.ollamaContextLength, numPredict ?? 4096);
    const options: Record<string, unknown> = { temperature: cfg.temperature, num_ctx: numCtx };
    if (numPredict) options.num_predict = numPredict;
    return {
      url: `${ollamaBase(cfg.baseUrl)}/api/chat`,
      headers: { 'content-type': 'application/json' },
      body: {
        model: cfg.model,
        messages,
        stream: true,
        think: cfg.reasoningEffort === 'high' ? true : false,
        keep_alive: '30m',
        format: opts.jsonSchema ?? (opts.json ? 'json' : undefined),
        options,
      },
    };
  },
  adjust: adjustOllama,
  async parse(res, emit) {
    for await (const line of lines(res)) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.error) throw new ProviderError(`Ollama: ${j.error}`);
        emit(j.message?.content);
      } catch (e) {
        if (e instanceof ProviderError) throw e;
      }
    }
  },
};

const openAIAdapter: ProviderAdapter = {
  buildRequest(cfg, messages, opts) {
    const body: Record<string, unknown> = { model: cfg.model, messages, stream: true };
    if (acceptsTemperature(cfg.id, cfg.model)) body.temperature = cfg.temperature;
    if (opts.json && cfg.id === 'openai') body.response_format = { type: 'json_object' };
    // Reasoning models are exactly the OpenAI models that reject temperature.
    if (cfg.id === 'openai' && cfg.reasoningEffort && !acceptsTemperature(cfg.id, cfg.model)) body.reasoning_effort = cfg.reasoningEffort;
    if (opts.maxTokens) body[cfg.id === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = opts.maxTokens;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    return {
      url: `${trimSlash(cfg.baseUrl)}/chat/completions`,
      headers,
      body,
    };
  },
  adjust: adjustOpenAI,
  async parse(res, emit) {
    for await (const ev of sse(res)) {
      const j = ev as { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
      if (j.error) throw new ProviderError(j.error.message ?? 'Unknown provider error');
      emit(j.choices?.[0]?.delta?.content);
    }
  },
};

const anthropicAdapter: ProviderAdapter = {
  buildRequest(cfg, messages, opts) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey!,
      'anthropic-version': '2023-06-01',
    };
    const body: Record<string, unknown> = {
      model: cfg.model,
      // Room for adaptive thinking on current models, which counts against max_tokens.
      max_tokens: opts.maxTokens ?? ANTHROPIC_MAX_TOKENS,
      system,
      stream: true,
      messages: messages.filter((m) => m.role !== 'system'),
    };
    if (acceptsTemperature(cfg.id, cfg.model)) body.temperature = cfg.temperature;
    // The current models (those without sampling parameters) all take an effort level; it sets how long they think.
    else if (cfg.reasoningEffort) body.output_config = { effort: cfg.reasoningEffort };
    if (ANTHROPIC_FALLBACK_MODELS.has(cfg.model)) {
      // A safety refusal (e.g. on security-related diffs) is retried server-side on a fallback model.
      body.fallbacks = 'default';
      headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
    }
    return {
      url: `${trimSlash(cfg.baseUrl)}/v1/messages`,
      headers,
      body,
    };
  },
  adjust: adjustAnthropic,
  async parse(res, emit) {
    let stopReason: string | undefined;
    let stopDetail: string | undefined;
    for await (const ev of sse(res)) {
      const j = ev as {
        type?: string;
        delta?: { type?: string; text?: string; stop_reason?: string; stop_details?: { category?: string | null; explanation?: string } | null };
        error?: { message?: string };
      };
      if (j.type === 'error') throw new ProviderError(j.error?.message ?? 'Anthropic error');
      if (j.type === 'content_block_delta' && j.delta?.type !== 'thinking_delta') emit(j.delta?.text);
      if (j.type === 'message_delta' && j.delta?.stop_reason) {
        stopReason = j.delta.stop_reason;
        stopDetail = j.delta.stop_details?.explanation ?? j.delta.stop_details?.category ?? undefined;
      }
    }
    if (stopReason === 'refusal') {
      throw new ProviderError(`Anthropic declined to explain this change${stopDetail ? ` (${stopDetail})` : ''}. Try another model or provider.`);
    }
  },
};

const geminiAdapter: ProviderAdapter = {
  buildRequest(cfg, messages, opts) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const model = cfg.model.replace(/^models\//, '');
    return {
      url: `${trimSlash(cfg.baseUrl)}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey! },
      body: {
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: {
          temperature: cfg.temperature,
          responseMimeType: opts.json ? 'application/json' : undefined,
          maxOutputTokens: opts.maxTokens,
        },
      },
    };
  },
  adjust: noAdjust,
  async parse(res, emit) {
    for await (const ev of sse(res)) {
      const j = ev as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
      for (const p of j.candidates?.[0]?.content?.parts ?? []) if (!p.thought) emit(p.text);
    }
  },
};

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  ollama: ollamaAdapter,
  lmstudio: openAIAdapter,
  openaiCompatible: openAIAdapter,
  llmGateway: openAIAdapter,
  openai: openAIAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
};

export async function chat(cfg: ProviderConfig, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const meta = PROVIDERS[cfg.id];
  if (meta.needsKey && !cfg.apiKey) {
    throw new ProviderError(`No API key configured for ${meta.label}.`, true);
  }
  if (!cfg.model) throw new ProviderError(`No model selected for ${meta.label}.`, true);

  let total = '';
  const emit = (d: string | undefined) => {
    if (!d) return;
    total += d;
    opts.onDelta?.(d, total);
  };

  const adapter = ADAPTERS[cfg.id];
  const { url, headers, body } = adapter.buildRequest(cfg, messages, opts);
  const res = await postAdapting(url, body, headers, opts.signal, cfg, adapter.adjust);
  await adapter.parse(res, emit);

  if (!total.trim()) throw new ProviderError(`${meta.label} returned an empty response.`);
  return total;
}

function ollamaBase(url: string): string {
  return trimSlash(url).replace(/\/v1$/, '').replace(/\/api$/, '');
}

export async function listModels(cfg: ProviderConfig, signal?: AbortSignal): Promise<string[]> {
  const base = trimSlash(cfg.baseUrl);
  switch (cfg.id) {
    case 'ollama': {
      const res = await request(`${ollamaBase(base)}/api/tags`, { signal }, cfg);
      const j = (await res.json()) as { models?: { name: string }[] };
      return (j.models ?? []).map((m) => m.name);
    }
    case 'anthropic': {
      const res = await request(
        `${base}/v1/models?limit=100`,
        { signal, headers: { 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' } },
        cfg,
      );
      const j = (await res.json()) as { data?: { id: string }[] };
      return (j.data ?? []).map((m) => m.id);
    }
    case 'gemini': {
      const res = await request(`${base}/models?pageSize=200`, { signal, headers: { 'x-goog-api-key': cfg.apiKey ?? '' } }, cfg);
      const j = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return (j.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''));
    }
    default: {
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
      const res = await request(`${base}/models`, { signal, headers }, cfg);
      const j = (await res.json()) as { data?: { id: string }[] };
      const ids = (j.data ?? []).map((m) => m.id);
      if (cfg.id === 'openai') {
        return ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search)/.test(id)).sort();
      }
      return ids;
    }
  }
}
