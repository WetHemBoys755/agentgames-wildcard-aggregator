// The real provider catalog for the Wildcard aggregator.
//
// Unlike the make.fun entry (which read a simulated brief and probed catalog
// routes), this server talks to REAL free providers:
//
//   - gemini: Google Gemini, gemini-3-flash-preview, via the public
//     generativelanguage.googleapis.com API. Needs GEMINI_API_KEY (free tier,
//     Google AI Studio). Tools, vision, JSON mode, 1M-token context.
//   - pollinations: Pollinations text API, keyless, OpenAI-compatible
//     endpoint at text.pollinations.ai/openai. Serves gpt-oss-20b under the
//     "openai" alias (verified live 2026-11-15). Tools per its model listing,
//     no vision, JSON mode unverified (treated as unsupported). Anonymous
//     tier: rate-limited and slow under load — it is the fallback, not the
//     primary.
//
// A provider whose key is missing is disabled (logged, left out of the
// catalog and the model list) — the server still runs on whatever remains.
// No secrets live in this file or anywhere in the repo: keys come from the
// environment only.

export type Wire = 'openai' | 'gemini';
export type AuthScheme = 'x-goog-api-key' | 'none';

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One real model a provider serves, with what it can do and its priority. */
export interface RealModel {
  id: string;
  display_name: string;
  tools: boolean;
  vision: boolean;
  json: boolean;
  context_length: number;
  /** Lower is tried first. */
  priority: number;
}

/** One real provider: its wire, base URL, auth, and models. */
export interface RealProvider {
  id: string;
  name: string;
  wire: Wire;
  auth: AuthScheme;
  base: string;
  /** Environment variable holding the key; '' when the provider needs none. */
  key_env: string;
  /** Per-call timeout: Pollinations' anonymous tier is slow (10–45 s). */
  timeout_ms: number;
  models: RealModel[];
}

/** What one request needs: a model without it cannot serve the request. */
export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

export interface Capabilities {
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

export function capabilitiesOf(model: RealModel): Capabilities {
  return {
    context_length: model.context_length,
    tools: model.tools,
    vision: model.vision,
    json: model.json,
  };
}

/** Whether a model's capabilities meet one request's requirements. */
export function meetsRequirements(requires: Requirement, caps: Capabilities): boolean {
  if (requires.tools === true && caps.tools !== true) return false;
  if (requires.vision === true && caps.vision !== true) return false;
  if (requires.json === true && caps.json !== true) return false;
  if (requires.min_context !== undefined && (caps.context_length === null || caps.context_length < requires.min_context)) return false;
  return true;
}

const GEMINI_BASE = process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com';
const POLLINATIONS_BASE = process.env.POLLINATIONS_BASE_URL ?? 'https://text.pollinations.ai/openai';

function geminiProvider(): RealProvider {
  return {
    id: 'gemini',
    name: 'Google Gemini (free tier)',
    wire: 'gemini',
    auth: 'x-goog-api-key',
    base: GEMINI_BASE,
    key_env: 'GEMINI_API_KEY',
    timeout_ms: 25000,
    models: [
      {
        id: 'gemini-3-flash-preview',
        display_name: 'Gemini 3 Flash Preview',
        tools: true,
        vision: true,
        json: true,
        context_length: 1048576,
        priority: 1,
      },
    ],
  };
}

function pollinationsProvider(): RealProvider {
  return {
    id: 'pollinations',
    name: 'Pollinations (keyless)',
    wire: 'openai',
    auth: 'none',
    base: POLLINATIONS_BASE,
    key_env: '',
    timeout_ms: 60000,
    models: [
      {
        id: 'openai',
        display_name: 'Pollinations openai (gpt-oss-20b)',
        tools: true,
        vision: false,
        json: false,
        context_length: 131072,
        priority: 2,
      },
    ],
  };
}

/** Every provider the server knows, in definition order. */
export function allProviders(): RealProvider[] {
  return [geminiProvider(), pollinationsProvider()];
}

export interface ProviderStatus {
  provider: RealProvider;
  enabled: boolean;
  reason: string;
}

/** Which providers are live, given the environment. A missing key disables one. */
export function providerStatuses(): ProviderStatus[] {
  return allProviders().map((provider) => {
    if (provider.key_env !== '') {
      const key = process.env[provider.key_env] ?? '';
      if (key === '') {
        return { provider, enabled: false, reason: `${provider.key_env} is not set` };
      }
    }
    return { provider, enabled: true, reason: 'ok' };
  });
}

/** The key for a provider, from the environment ('' when none is needed). */
export function keyOf(provider: RealProvider): string {
  if (provider.key_env === '') return '';
  return process.env[provider.key_env] ?? '';
}

/** The headers a provider wants its key in. */
export function authHeaders(auth: AuthScheme, key: string): Record<string, string> {
  if (key === '') return {};
  if (auth === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return {};
}
