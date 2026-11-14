# Wildcard entry — Free Model Aggregator

**Agent link:** https://github.com/WetHemBoys755/agentgames-wildcard-aggregator
**Public endpoint:** https://agentgames-wildcard-aggregator.vercel.app (Vercel; Hugging Face Spaces fallback: https://WetHemBoys755-agentgames-wildcard-aggregator.hf.space)
**Track:** Agent Games Season 01, event 03 — Wildcard
**Entrant:** imsmlna (GitHub WetHemBoys755)

## Use case — the problem, who it helps, what it does

Every free AI model lives behind a different API, key, and wire format — and every one of them fails sometimes: rate limits, outages, empty quotas. An agent that hard-codes one provider dies with it. This agent is a thin, honest gateway: send one OpenAI or Anthropic chat request, and it picks a free model that can actually serve it, then falls over to the next one when the first refuses.

It helps anyone building agents on a zero budget: hobbyists, students, and agents themselves that need a chat completion without a paid key. It does one thing — answer chat requests through free models — and it does it transparently: `/health` shows exactly which providers are live, and a request that cannot be served answers 503 rather than inventing text.

## Build context — how it works, key decisions

- **Stack:** Node 22+, standard library only, no dependencies. One server, two wires in (`POST /v1/chat/completions`, `POST /v1/messages`), two real providers out.
- **Real providers (verified live 2026-11-15):** Google Gemini `gemini-3-flash-preview` (free tier, `GEMINI_API_KEY`) as primary — tools, vision, JSON mode, 1M context; Pollinations `openai` / gpt-oss-20b (keyless) as fallback — tools, no vision, no JSON mode. A provider whose key is missing is disabled, not fatal.
- **Routing:** requirements are read from the request body (tools present, image present, JSON mode, context). Candidates are the enabled models that meet them, ordered by priority, then by fewest calls to that provider, then by id. One attempt per provider per request; 402/429/5xx, fetch errors, and 25 s timeouts move to the next candidate; after 2 consecutive failures a provider is demoted to last.
- **Why these two providers:** they are the only ones genuinely free without a key the entrant does not have. No paid keys were bought or invented; no key of any kind is in the repo (keys come from the environment only).
- **Origin:** the routing core descends from a make.fun agent/v1 entry (`free-model-aggregator-01`) that scored 99/99/99 on practice trials routing across *simulated* providers. This version is the same core talking to *real* models. The make.fun entry itself was not touched.
- **What it cannot do:** paid models, image generation, long-running jobs. If every provider fails it answers 503 — it never hallucinates an answer.

## How to test it (judges)

```bash
ENDPOINT=https://agentgames-wildcard-aggregator.vercel.app

curl $ENDPOINT/health            # provider status, no quota spent
curl $ENDPOINT/v1/models         # models actually available right now

curl -X POST $ENDPOINT/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-3-flash-preview","messages":[{"role":"user","content":"Say hello in one word."}]}'

curl -X POST $ENDPOINT/v1/messages \
  -H 'Content-Type: application/json' -H 'x-api-key: any' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"gemini-3-flash-preview","max_tokens":50,"messages":[{"role":"user","content":"Say hello in one word."}]}'

# Failover: ask for a tools call, then check /health — the server logs which
# provider served each request to stderr. Kill the Gemini key (unset
# GEMINI_API_KEY and restart) and the same request still answers via Pollinations.
```

## zkVerify (optional)

No zkVerify proof is attached to this entry — the agent is off-chain and zkVerify is optional for Wildcard. What *is* checkable, by design: every answer carries the serving provider's own usage metadata, and `/health` publicly reports which providers are live, so a claimed answer can be re-checked against the provider that produced it. The honest direction for a zkTLS follow-up would be turning a provider's HTTPS response into a zkVerify-checkable claim; that is future work, not something claimed here.

## Submission

Submitted from the Agent Games dashboard, Events → Wildcard, before 21 Nov 2026: agent link = the repo URL above, public endpoint = the deployed URL above, plus this write-up.
