---
title: Free Model Aggregator
sdk: docker
app_port: 7860
license: mit
short_description: One OpenAI/Anthropic-compatible endpoint routing chat across free models (Gemini + Pollinations), with failover.
---

# Free Model Aggregator

One OpenAI/Anthropic-compatible endpoint that routes chat requests across **free** models and fails over when a provider refuses. Built for the [Agent Games](https://agentgames.zkverify.io/events/wildcard) Wildcard track (event 03).

## The problem

Every free AI model lives behind a different API, key, and wire format — and every one of them fails sometimes (rate limits, outages, empty quotas). If you hard-code one provider, your agent dies with it. This server is a thin, honest gateway: send one OpenAI or Anthropic request, and it picks a free model that can actually serve it, then falls over to the next one when the first refuses.

## Providers (live, verified 2026-11-15)

| Provider | Model | Key | Tools | Vision | JSON | Context |
|---|---|---|---|---|---|---|
| Google Gemini (free tier) | `gemini-3-flash-preview` | `GEMINI_API_KEY` | yes | yes | yes | 1M |
| Pollinations (keyless) | `openai` (gpt-oss-20b) | none | yes | no | no | 128k |

Gemini is the primary route; Pollinations is the fallback. A provider whose key is missing is disabled, not fatal — the server runs on whatever remains and says so on `/health`.

## Endpoints

- `GET /` — landing page with live provider status and curl examples
- `GET /health` — provider status (no upstream calls, no quota spent)
- `GET /v1/models` — OpenAI list shape; Anthropic shape with an `x-api-key` header
- `POST /v1/chat/completions` — OpenAI wire, JSON or SSE (`stream: true`)
- `POST /v1/messages` — Anthropic wire, JSON or SSE (`stream: true`)

## Try it

```bash
ENDPOINT=https://<your-deployment>

# Health (no quota spent)
curl $ENDPOINT/health

# List models
curl $ENDPOINT/v1/models

# Plain chat (routes to Gemini first)
curl -X POST $ENDPOINT/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-3-flash-preview","messages":[{"role":"user","content":"Say hello in one word."}]}'

# JSON mode (Gemini only — Pollinations does not do JSON)
curl -X POST $ENDPOINT/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-3-flash-preview","messages":[{"role":"user","content":"Return {\"color\":\"blue\"} as JSON."}],"response_format":{"type":"json_object"}}'

# Anthropic wire
curl -X POST $ENDPOINT/v1/messages \
  -H 'Content-Type: application/json' -H 'x-api-key: any' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"gemini-3-flash-preview","max_tokens":50,"messages":[{"role":"user","content":"Say hello in one word."}]}'

# Streaming
curl -N -X POST $ENDPOINT/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-3-flash-preview","messages":[{"role":"user","content":"Count to three."}],"stream":true}'
```

## How routing works

1. The request's requirements are read from its body: tools present, image present (vision), `response_format` JSON, `min_context`.
2. Candidates are the enabled models whose capabilities meet those requirements, ordered by priority, then by fewest calls made to that provider, then by provider/model id (deterministic).
3. One attempt per provider per request. A 402/429/5xx, a fetch error, or a timeout (25 s Gemini, 60 s Pollinations) moves to the next candidate. After 2 consecutive failures a provider is demoted to last (a success clears it).
4. If no provider can serve the request, the server answers **503** — it never invents an answer.

## What it can and cannot do

Can: plain chat, tool calls, vision input, JSON mode (Gemini), streaming, both OpenAI and Anthropic wires. Cannot: paid models, image generation, long-running jobs, or anything that needs a key this deployment does not have. If a provider is down, requests still work through the other one — slower, but working.

## Run it locally

```bash
# Node >= 22.6, no dependencies (stdlib only)
GEMINI_API_KEY=... PORT=3000 npm start
# or: node --experimental-strip-types main.ts
```

No key, no problem: without `GEMINI_API_KEY` the server still runs on Pollinations alone (check `/health`).

## Deploy

**Vercel (recommended)** — free Hobby plan, no sleep, GitHub-native:

1. Import this repo at [vercel.com/new](https://vercel.com/new) (sign in with GitHub as WetHemBoys755).
2. Add environment variable `GEMINI_API_KEY` (your free-tier Google AI Studio key) in Project Settings → Environment Variables.
3. Deploy. The endpoint is `https://<project>.vercel.app`.

Note: Hobby functions time out at 10 s. A normal Gemini call takes ~2 s; a full failover chain (Gemini down → slow Pollinations) can exceed that. If that bites, use Hugging Face Spaces instead.

**Hugging Face Spaces (Docker)** — free, no execution timeout, sleeps after 48 h idle (wakes on request):

1. Create a free account at [huggingface.co](https://huggingface.co) and a new Space with SDK **Docker**.
2. Push this repo to the Space (or connect the GitHub repo).
3. Add secret `GEMINI_API_KEY` in Space Settings → Variables and secrets.
4. The endpoint is `https://<username>-<space>.hf.space`.

## Origin

This server descends from a [make.fun](https://make.fun) agent/v1 entry (`free-model-aggregator-01`, scored 99/99/99 on practice trials) that routed across *simulated* providers. The Wildcard version is the same routing core talking to *real* free models. The make.fun entry itself is untouched.

## License

MIT.
