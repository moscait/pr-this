import * as vscode from 'vscode';
import type { DecisionEngineConfig } from './relevance';
import type { ProviderInfo } from '../shared/types';
import { sanitizeLanguage } from './prompts';
import {
  isInsecureRemoteUrl,
  isUserServer,
  listModels,
  PROVIDERS,
  ProviderConfig,
  ProviderError,
  ProviderId,
  ReasoningEffort,
  secretKeyForProvider,
  staysLocal,
} from './providers';

const LEGACY_OPENAI_COMPATIBLE_KEY = 'prThis.apiKey.openaiCompatible';

async function loadApiKey(secrets: vscode.SecretStorage, id: ProviderId, effectiveBaseUrl: string, allowLegacyMigration = true): Promise<string | undefined> {
  const key = secretKeyForProvider(id, effectiveBaseUrl);
  const stored = await secrets.get(key);
  if (stored) return stored;
  if (id === 'openaiCompatible' && allowLegacyMigration) {
    const legacy = await secrets.get(LEGACY_OPENAI_COMPATIBLE_KEY);
    if (legacy) {
      await secrets.store(key, legacy);
      await secrets.delete(LEGACY_OPENAI_COMPATIBLE_KEY);
      return legacy;
    }
  }
  return undefined;
}

/** Default diff character budget for local models when the user hasn't customized `prThis.maxDiffChars`. */
export const LOCAL_DEFAULT_MAX_DIFF_CHARS = 24000;

export type BackgroundPrewarmMode = 'local' | 'always' | 'off';

/** Whether background pre-warming should run for this provider configuration. */
export function shouldPrewarm(mode: BackgroundPrewarmMode, cfg: Pick<ProviderConfig, 'id' | 'baseUrl'>): boolean {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return staysLocal(cfg.id, cfg.baseUrl);
}

/** Effective diff character budget for a provider, capping unmodified defaults on local models so prefill stays fast. */
export function effectiveMaxDiffChars(configured: number, isCustom: boolean, cfg: Pick<ProviderConfig, 'id' | 'baseUrl'>): number {
  if (!isCustom && staysLocal(cfg.id, cfg.baseUrl)) {
    return Math.min(configured, LOCAL_DEFAULT_MAX_DIFF_CHARS);
  }
  return configured;
}

export function settings() {
  const c = vscode.workspace.getConfiguration('prThis');
  const maxInspect = c.inspect<number>('maxDiffChars');
  const globalMax = maxInspect?.globalValue;
  const defaultMax = maxInspect?.defaultValue ?? 60000;
  const userCap = globalMax ?? defaultMax;
  const rawMax = c.get<number>('maxDiffChars', defaultMax);
  return {
    provider: c.get<ProviderId>('provider', 'ollama'),
    model: c.get<string>('model', ''),
    baseUrl: c.get<string>('baseUrl', ''),
    temperature: c.get<number>('temperature', 0.2),
    maxDiffChars: Math.min(rawMax, userCap),
    hasCustomMaxDiffChars: globalMax !== undefined,
    exclude: c.get<string[]>('excludeFromAI', []),
    sendSecretFiles: c.get<boolean>('sendSecretFiles', false),
    language: sanitizeLanguage(c.get<string>('explanationLanguage', 'English')),
    commitCount: c.get<number>('commitCount', 50),
    ollamaContextLength: c.get<number>('ollamaContextLength', 32768),
    reasoningEffort: effortSetting(c.get<string>('reasoningEffort', 'medium')),
    backgroundPrewarm: prewarmSetting(c.get<string>('backgroundPrewarm', 'local')),
  };
}

/** The decision engine used to score file relevance for the overview, or undefined when off. */
export function decisionEngineConfig(): DecisionEngineConfig | undefined {
  const c = vscode.workspace.getConfiguration('prThis');
  if (c.get<string>('decisionEngine', 'off') !== 'local') return undefined;
  const timeout = c.get<number>('decisionEngineTimeoutMs', 15000);
  return {
    baseUrl: c.get<string>('decisionEngineUrl', 'http://127.0.0.1:8080').trim() || 'http://127.0.0.1:8080',
    model: c.get<string>('decisionEngineModel', '').trim(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 120000) : 15000,
  };
}

function prewarmSetting(v: string): BackgroundPrewarmMode {
  return v === 'always' || v === 'off' ? v : 'local';
}

function effortSetting(v: string): ReasoningEffort | undefined {
  return v === 'low' || v === 'medium' || v === 'high' ? v : undefined;
}

/** Cache of auto-detected models for local providers with no model configured. */
const autoModel = new Map<string, string>();

export async function resolveProvider(secrets: vscode.SecretStorage): Promise<ProviderConfig> {
  const s = settings();
  const meta = PROVIDERS[s.provider] ?? PROVIDERS.ollama;
  const effectiveBaseUrl = s.baseUrl || meta.defaultBaseUrl;
  const cfg: ProviderConfig = {
    id: meta.id,
    baseUrl: effectiveBaseUrl,
    model: s.model || meta.defaultModel,
    apiKey: await loadApiKey(secrets, meta.id, effectiveBaseUrl, false),
    temperature: s.temperature,
    ollamaContextLength: s.ollamaContextLength,
    reasoningEffort: s.reasoningEffort,
  };
  if (!cfg.model && meta.id === 'llmGateway') {
    cfg.model = await gatewayAutoModel(cfg);
  } else if (!cfg.model && meta.local) {
    const k = `${cfg.id}|${cfg.baseUrl}`;
    let m = autoModel.get(k);
    if (!m) {
      const models = await listModels(cfg);
      m = pickBestLocalModel(models);
      if (!m) {
        throw new ProviderError(
          cfg.id === 'ollama'
            ? 'No Ollama models installed. Try `ollama pull qwen2.5-coder:7b`, then retry.'
            : `${meta.label} has no models loaded.`,
          true,
        );
      }
      autoModel.set(k, m);
    }
    cfg.model = m;
  }
  return cfg;
}

const GATEWAY_EXPLAINER = [
  'The gateway is a router. Depending on the model you choose, your diffs go to OpenAI (gpt-*, o*), to Anthropic (claude-*), or to the models the gateway serves itself. With the "auto" model, the gateway decides.',
  "PR This can't see the gateway's routing, so it treats the gateway as a cloud provider even on localhost: the panel shows a cloud badge, and explanations aren't generated in the background unless prThis.backgroundPrewarm is \"always\".",
  'zrok is optional. Normally you enter the address the gateway listens on (default http://localhost:8080/v1). Only if the gateway is shared privately over zrok, run "zrok access private <token>" and enter the local address it prints.',
].join('\n\n');

/** The gateway's virtual `auto` model (semantic routing) when it offers one; otherwise the user must choose. */
async function gatewayAutoModel(cfg: ProviderConfig): Promise<string> {
  const k = `${cfg.id}|${cfg.baseUrl}`;
  const cached = autoModel.get(k);
  if (cached) return cached;
  const models = await listModels(cfg);
  if (!models.includes('auto')) {
    throw new ProviderError(
      `No model selected for ${PROVIDERS.llmGateway.label}, and semantic routing (the \`auto\` model) is not enabled. Choose a model in PR This settings.`,
      true,
    );
  }
  autoModel.set(k, 'auto');
  return 'auto';
}

export interface RunContext {
  cfg: ProviderConfig;
  maxChars: number;
  language: string;
  settings: ReturnType<typeof settings>;
}

/** Resolve the active provider alongside the effective diff budget and language setting. */
export async function runContext(secrets: vscode.SecretStorage): Promise<RunContext> {
  const s = settings();
  const cfg = await resolveProvider(secrets);
  const maxChars = effectiveMaxDiffChars(s.maxDiffChars, s.hasCustomMaxDiffChars, cfg);
  return { cfg, maxChars, language: s.language, settings: s };
}

/** Like `runContext`, but returns `undefined` when background pre-warming is disabled for this provider. */
export async function prewarmContext(secrets: vscode.SecretStorage): Promise<RunContext | undefined> {
  const ctx = await runContext(secrets);
  return shouldPrewarm(ctx.settings.backgroundPrewarm, ctx.cfg) ? ctx : undefined;
}

/** Prefer code-tuned, instruction models; skip embedding models. */
export function pickBestLocalModel(models: string[]): string | undefined {
  const usable = models.filter((m) => !/embed|bge|nomic|minilm|rerank|whisper|vision-only/i.test(m));
  const prefs = [/coder/i, /qwen3/i, /qwen2\.5/i, /deepseek/i, /llama3/i, /gpt-oss/i, /gemma/i, /mistral|codestral/i, /phi/i];
  for (const p of prefs) {
    const hit = usable.find((m) => p.test(m));
    if (hit) return hit;
  }
  return usable[0];
}

export async function providerInfo(secrets: vscode.SecretStorage): Promise<ProviderInfo> {
  const s = settings();
  const meta = PROVIDERS[s.provider] ?? PROVIDERS.ollama;
  let model = s.model || meta.defaultModel;
  if (!model) {
    try {
      model = (await resolveProvider(secrets)).model;
    } catch {
      model = 'auto';
    }
  }
  return { id: meta.id, label: meta.label, model, local: staysLocal(meta.id, s.baseUrl) };
}

/** Interactive provider / model / key setup. Returns true if something changed. */
export async function configureProvider(secrets: vscode.SecretStorage): Promise<boolean> {
  const current = settings();
  const pick = await vscode.window.showQuickPick(
    Object.values(PROVIDERS).map((p) => ({
      label: `${isUserServer(p.id) ? '$(server)' : p.local ? '$(vm)' : '$(cloud)'} ${p.label}`,
      description: p.id === current.provider ? 'current' : isUserServer(p.id) ? 'local or cloud' : p.local ? 'local' : 'cloud',
      detail: p.detail,
      id: p.id,
    })),
    { title: 'PR This · Choose an AI provider', placeHolder: 'Where should explanations be generated?', ignoreFocusOut: true },
  );
  if (!pick) return false;
  const meta = PROVIDERS[pick.id];
  const cfgTarget = vscode.ConfigurationTarget.Global;
  const conf = vscode.workspace.getConfiguration('prThis');

  if (pick.id === 'llmGateway' && current.provider !== 'llmGateway') {
    const ok = await vscode.window.showInformationMessage(
      'About the OpenZiti LLM Gateway',
      { modal: true, detail: GATEWAY_EXPLAINER },
      'Continue',
    );
    if (ok !== 'Continue') return false;
  }

  let baseUrl = pick.id === current.provider ? current.baseUrl : '';
  if (isUserServer(pick.id) || (meta.local && baseUrl)) {
    const v = await vscode.window.showInputBox({
      title: `${meta.label} · Base URL`,
      value: baseUrl || meta.defaultBaseUrl,
      prompt:
        pick.id === 'llmGateway'
          ? 'The address the gateway listens on, ending in /v1. zrok is optional: only for a private zrok share, use the local address `zrok access private` prints.'
          : 'The server base URL (include /v1 for OpenAI-compatible servers).',
      ignoreFocusOut: true,
    });
    if (v === undefined) return false;
    baseUrl = v.trim() === meta.defaultBaseUrl ? '' : v.trim();
  }

  const effectiveBaseUrl = baseUrl || meta.defaultBaseUrl;
  const sameBaseUrl = pick.id === current.provider && baseUrl === current.baseUrl;
  const keyId = secretKeyForProvider(meta.id, effectiveBaseUrl);
  let newKey: string | undefined;
  let hasKey = false;

  if (meta.needsKey || isUserServer(pick.id)) {
    const existing = await loadApiKey(secrets, meta.id, effectiveBaseUrl, sameBaseUrl);
    const v = await vscode.window.showInputBox({
      title: `${meta.label} · API key`,
      prompt: existing
        ? 'An API key is stored for this server. Leave empty to keep it, or paste a new one.'
        : meta.needsKey
          ? 'Paste your API key. It is stored in VS Code Secret Storage, never in settings.'
          : pick.id === 'llmGateway'
            ? 'Optional gateway virtual API key (from `llm-gateway genkey`). Leave empty if the gateway has no api_keys configured.'
            : 'Optional API key (leave empty if your server does not need one).',
      password: true,
      ignoreFocusOut: true,
    });
    if (v === undefined) return false;
    newKey = v.trim() || undefined;
    hasKey = !!(newKey || existing);
    if (!hasKey && meta.needsKey) {
      vscode.window.showWarningMessage(`${meta.label} requires an API key.`);
      return false;
    }
  }

  if (isInsecureRemoteUrl(effectiveBaseUrl)) {
    const detail = hasKey
      ? `${effectiveBaseUrl} uses unencrypted HTTP on a remote host. Your diffs and API key will be sent in cleartext over the network.`
      : `${effectiveBaseUrl} uses unencrypted HTTP on a remote host. Your diffs will be sent unencrypted over the network.`;
    const confirm = await vscode.window.showWarningMessage(detail, { modal: true }, 'Use Anyway');
    if (confirm !== 'Use Anyway') return false;
  }

  if (newKey) await secrets.store(keyId, newKey);

  const probe: ProviderConfig = {
    id: meta.id,
    baseUrl: effectiveBaseUrl,
    model: '',
    apiKey: await loadApiKey(secrets, meta.id, effectiveBaseUrl, sameBaseUrl),
    temperature: current.temperature,
    ollamaContextLength: current.ollamaContextLength,
  };
  let models: string[] = [];
  let listError: string | undefined;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fetching ${meta.label} models…` },
    async () => {
      try {
        models = await listModels(probe);
      } catch (e) {
        listError = (e as Error).message;
      }
    },
  );

  const MANUAL = '$(edit) Enter model name…';
  const AUTO = '$(sparkle) Auto-detect best installed model';
  const GATEWAY_AUTO = 'auto';
  const currentModel = pick.id === current.provider ? current.model : '';
  const items: vscode.QuickPickItem[] = [];
  if (meta.local) items.push({ label: AUTO, description: currentModel ? '' : 'current' });
  const sorted = meta.local ? models : [...models].sort();
  const best = meta.local ? pickBestLocalModel(models) : meta.defaultModel;
  for (const m of sorted) {
    const routed = pick.id === 'llmGateway' && m === GATEWAY_AUTO ? 'semantic routing' : '';
    items.push({ label: m, description: [m === currentModel ? 'current' : '', m === best ? 'recommended' : '', routed].filter(Boolean).join(' · ') });
  }
  items.push({ label: MANUAL });
  const chosen = await vscode.window.showQuickPick(items, {
    title: `${meta.label} · Choose a model`,
    placeHolder: listError ? `Couldn't list models (${listError}). Enter one manually.` : 'Pick a model',
    ignoreFocusOut: true,
  });
  if (!chosen) return false;
  let model = chosen.label === AUTO ? '' : chosen.label;
  if (chosen.label === MANUAL) {
    const v = await vscode.window.showInputBox({ title: `${meta.label} · Model name`, value: currentModel || meta.defaultModel, ignoreFocusOut: true });
    if (v === undefined) return false;
    model = v.trim();
  }

  await conf.update('provider', meta.id, cfgTarget);
  await conf.update('baseUrl', baseUrl, cfgTarget);
  await conf.update('model', model, cfgTarget);
  autoModel.clear();
  vscode.window.showInformationMessage(`PR This will use ${meta.label}${model ? ` · ${model}` : ''}.`);
  return true;
}
