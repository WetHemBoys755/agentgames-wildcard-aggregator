// Free-model aggregator — Agent Games Wildcard entry.
//
// One OpenAI/Anthropic-compatible endpoint that routes chat requests across
// REAL free models and fails over when a provider refuses:
//
//   gemini        gemini-3-flash-preview   (GEMINI_API_KEY, free tier)
//   pollinations  openai / gpt-oss-20b     (keyless)
//
// Capability-based routing (tools / vision / JSON mode / context length):
// a request only goes to a model that can actually serve it, in priority
// order, with failover on 402/429/5xx/fetch errors and demotion after two
// consecutive failures. Per-call timeouts: 25 s (Gemini), 60 s (Pollinations,
// whose anonymous tier is slow). No secrets anywhere in this repo: keys come
// from the environment only (GEMINI_API_KEY).
//
//   GET  /                      landing page + curl examples
//   GET  /health                provider status, no upstream calls
//   GET  /v1/models             OpenAI list shape (Anthropic shape with x-api-key)
//   POST /v1/chat/completions   OpenAI wire (JSON or SSE)
//   POST /v1/messages           Anthropic wire (JSON or SSE)
//
// Run:  PORT=3000 GEMINI_API_KEY=... node --experimental-strip-types main.ts
// (Node >= 22.6; Node 24 runs .ts natively.)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  authHeaders, capabilitiesOf, isRecord, keyOf, meetsRequirements,
  providerStatuses, type Json, type RealModel, type RealProvider, type Requirement,
} from './lib/providers.ts';
import {
  anthropicError, anthropicModelList, anthropicToGemini, anthropicToOpenAI,
  openAIError, openAIModelList, openAIToAnthropic, openAIToGemini,
  parseGeminiAnswer, parseOpenAIAnswer,
  renderAnthropic, renderOpenAI, type Answer, type ServedModel,
} from './lib/wire.ts';

const PORT = Number(process.env.PORT ?? '3000') || 3000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const STARTED_AT = Date.now();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

const statuses = providerStatuses();
const enabledProviders = statuses.filter((s) => s.enabled).map((s) => s.provider);
for (const s of statuses) {
  log(s.enabled
    ? `provider ${s.provider.id} enabled (${s.provider.models.map((m) => m.id).join(', ')})`
    : `provider ${s.provider.id} disabled: ${s.reason}`);
}

const providerCalls = new Map<string, number>();
const consecutiveFailures = new Map<string, number>();

interface Route {
  provider: RealProvider;
  model: RealModel;
}

function servedModels(): ServedModel[] {
  const out: ServedModel[] = [];
  for (const provider of enabledProviders) {
    for (const model of provider.models) {
      out.push({ id: model.id, provider: provider.id, display_name: model.display_name });
    }
  }
  return out;
}

function routeFor(requires: Requirement, jsonMode: boolean): Route[] {
  const routes: Route[] = [];
  for (const provider of enabledProviders) {
    for (const model of provider.models) {
      if (!meetsRequirements(requires, capabilitiesOf(model))) continue;
      // JSON-mode OpenAI requests never go to an anthropic-wire provider
      // (its parser reports json_mode false). Neither live provider uses
      // that wire, but the rule stays so a future one is safe.
      if (jsonMode && provider.wire === 'anthropic') continue;
      routes.push({ provider, model });
    }
  }
  routes.sort((a, b) => {
    const aFailed = (consecutiveFailures.get(a.provider.id) ?? 0) >= 2;
    const bFailed = (consecutiveFailures.get(b.provider.id) ?? 0) >= 2;
    if (aFailed !== bFailed) return aFailed ? 1 : -1;
    if (a.model.priority !== b.model.priority) return a.model.priority - b.model.priority;
    const aCalls = providerCalls.get(a.provider.id) ?? 0;
    const bCalls = providerCalls.get(b.provider.id) ?? 0;
    if (aCalls !== bCalls) return aCalls - bCalls;
    if (a.provider.id !== b.provider.id) return a.provider.id < b.provider.id ? -1 : 1;
    return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
  });
  return routes;
}

function requirementsFromBody(body: Json): Requirement {
  let vision = false;
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(message)) continue;
    const content = Array.isArray(message.content) ? message.content : [message.content];
    for (const block of content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  const output = isRecord(body.output_config) ? body.output_config.format : undefined;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: format === 'json_object' || format === 'json_schema' ||
      (isRecord(output) && output.type === 'json'),
  };
}

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(
  res: ServerResponse,
  wire: 'openai' | 'anthropic',
  status: number,
  type: string,
  message: string,
): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

function upstreamBody(route: Route, body: Json, client: 'openai' | 'anthropic'): Json {
  const model = route.model.id;
  const stream = body.stream === true;
  const wire = route.provider.wire;
  if (client === 'openai') {
    if (wire === 'gemini') return openAIToGemini(body, model, stream);
    const out: Json = { ...body, model };
    if (stream) out.stream_options = { include_usage: true };
    return out;
  }
  if (wire === 'openai') return anthropicToOpenAI(body, model);
  if (wire === 'gemini') return anthropicToGemini(body, model, stream);
  return { ...body, model };
}

function upstreamUrl(route: Route, stream: boolean): string {
  const provider = route.provider;
  if (provider.wire === 'gemini') {
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return `${provider.base}/v1beta/models/${encodeURIComponent(route.model.id)}:${action}`;
  }
  // OpenAI wire: Pollinations' base IS the chat-completions endpoint
  // (POST https://text.pollinations.ai/openai), so there is no suffix.
  return provider.base;
}

async function callProvider(route: Route, body: Json, client: 'openai' | 'anthropic'): Promise<Response> {
  const provider = route.provider;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...authHeaders(provider.auth, keyOf(provider)),
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  if (provider.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  return fetch(upstreamUrl(route, body.stream === true), {
    method: 'POST',
    headers,
    body: JSON.stringify(upstreamBody(route, body, client)),
    signal: AbortSignal.timeout(route.provider.timeout_ms),
  });
}

function markFailure(providerId: string): void {
  providerCalls.set(providerId, (providerCalls.get(providerId) ?? 0) + 1);
  consecutiveFailures.set(providerId, (consecutiveFailures.get(providerId) ?? 0) + 1);
}

function markSuccess(providerId: string): void {
  providerCalls.set(providerId, (providerCalls.get(providerId) ?? 0) + 1);
  consecutiveFailures.set(providerId, 0);
}

async function parseAnswer(route: Route, response: Response): Promise<Answer | null> {
  switch (route.provider.wire) {
    case 'openai': return parseOpenAIAnswer(response);
    case 'gemini': return parseGeminiAnswer(response);
  }
}

function renderResult(
  res: ServerResponse,
  wire: 'openai' | 'anthropic',
  answer: Answer,
  model: string,
  stream: boolean,
): void {
  const result = wire === 'openai'
    ? renderOpenAI(answer, model, stream)
    : renderAnthropic(answer, model, stream);
  res.writeHead(result.status, result.headers);
  if (typeof result.body === 'string') res.end(result.body);
  else res.end(JSON.stringify(result.body));
}

async function serve(
  body: Json,
  client: 'openai' | 'anthropic',
  res: ServerResponse,
): Promise<void> {
  const requires = requirementsFromBody(body);
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  const jsonMode = client === 'openai' &&
    (format === 'json_object' || format === 'json_schema');
  const candidates = routeFor(requires, jsonMode);
  if (candidates.length === 0) {
    const hint = enabledProviders.length === 0
      ? 'no provider is enabled (set GEMINI_API_KEY to enable Gemini)'
      : 'no enabled model meets this request (tools/vision/json/context)';
    sendError(res, client, 503, 'upstream_unavailable', hint);
    return;
  }
  const attempted = new Set<string>();
  for (const route of candidates) {
    const providerId = route.provider.id;
    if (attempted.has(providerId)) continue;
    attempted.add(providerId);
    let response: Response;
    try {
      response = await callProvider(route, body, client);
    } catch (err) {
      markFailure(providerId);
      log(`provider ${providerId} fetch failed: ${(err as Error).message}`);
      continue;
    }
    if (!response.ok) {
      markFailure(providerId);
      const detail = (await response.text()).slice(0, 300);
      log(`provider ${providerId} answered HTTP ${response.status}: ${detail}`);
      continue;
    }
    const answer = await parseAnswer(route, response);
    if (answer === null) {
      markFailure(providerId);
      log(`provider ${providerId} returned an unreadable answer`);
      continue;
    }
    markSuccess(providerId);
    log(`served by ${providerId}/${route.model.id} (${answer.inputTokens} in, ${answer.outputTokens} out)`);
    renderResult(res, client, answer, route.model.id, body.stream === true);
    return;
  }
  sendError(res, client, 503, 'upstream_unavailable', 'no provider could serve this request');
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
    return;
  }
  await serve(body, 'openai', res);
}

async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
    return;
  }
  await serve(body, 'anthropic', res);
}

function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') {
    sendJson(res, 200, anthropicModelList(list));
  } else {
    sendJson(res, 200, openAIModelList(list));
  }
}

function health(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    service: 'agentgames-wildcard-aggregator',
    uptime_seconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    providers: statuses.map((s) => ({
      id: s.provider.id,
      name: s.provider.name,
      enabled: s.enabled,
      reason: s.reason,
      models: s.provider.models.map((m) => ({
        id: m.id,
        tools: m.tools,
        vision: m.vision,
        json: m.json,
        context_length: m.context_length,
      })),
    })),
  });
}

function landing(_req: IncomingMessage, res: ServerResponse): void {
  const rows = statuses.map((s) => `<tr><td>${s.provider.id}</td><td>${s.provider.name}</td><td>${s.enabled ? 'enabled' : `disabled — ${s.reason}`}</td><td>${s.provider.models.map((m) => m.id).join(', ')}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Free Model Aggregator</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.5}code{background:#f0f0f0;padding:2px 5px;border-radius:4px}pre{background:#f0f0f0;padding:12px;border-radius:8px;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}</style></head><body>
<h1>Free Model Aggregator</h1>
<p>One OpenAI/Anthropic-compatible endpoint that routes chat requests across <strong>free</strong> models and fails over when a provider refuses. Agent Games Wildcard entry — <a href="https://github.com/WetHemBoys755/agentgames-wildcard-aggregator">repo</a>.</p>
<h2>Providers right now</h2>
<table><tr><th>id</th><th>name</th><th>status</th><th>models</th></tr>${rows}</table>
<h2>Try it</h2>
<pre>curl -X POST $ENDPOINT/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"gemini-3-flash-preview","messages":[{"role":"user","content":"Say hello in one word."}]}'</pre>
<p>Also: <code>GET /health</code>, <code>GET /v1/models</code>, <code>POST /v1/messages</code> (Anthropic wire).</p>
<h2>What it can and cannot do</h2>
<p>Can: plain chat, tool calls, vision input, JSON mode (Gemini), streaming. Cannot: paid models, image generation, long-running jobs. If every provider fails it answers 503 — it never invents an answer.</p>
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/') {
    landing(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    health(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai',
    404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

/** The request handler: shared by the standalone server and the Vercel adapter. */
export function createHandler(): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        sendError(res, req.url?.startsWith('/v1/messages') ? 'anthropic' : 'openai',
          500, 'internal_error', 'the server failed to answer');
      }
    });
  };
}

async function start(): Promise<void> {
  const server = createServer(createHandler());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => resolve());
  });
  log(`listening on 0.0.0.0:${PORT} with ${enabledProviders.length} enabled provider(s), ${servedModels().length} model(s)`);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

// Start the standalone server only when this file is run directly
// (node --experimental-strip-types main.ts). In a serverless bundle
// (e.g. Vercel) argv[1] is the launcher, so the server never starts there.
// Note: no top-level await and no import.meta here — Vercel compiles
// functions to CommonJS, where both are unavailable (top-level await
// fails the build and import.meta breaks at runtime).
const isMain = process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/main.ts') || process.argv[1].endsWith('/main.js'));
if (isMain) {
  start().catch((err: unknown) => {
    log((err as Error).stack ?? String(err));
    process.exit(1);
  });
}
