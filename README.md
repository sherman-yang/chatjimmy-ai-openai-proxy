# chatjimmy.ai OpenAI Proxy

This project is an OpenAI API proxy that wraps the Taalas web chat at `https://chatjimmy.ai`.

It exposes OpenAI-compatible endpoints:
- `/v1/models`
- `/v1/chat/completions`

## 1. Pros and Cons

### Pros

- Extremely fast, with a "world's fastest" positioning.
- No explicit rate limit observed in current tests.
- No explicit quota cap observed in current tests.

### Cons

- No formal SLA is provided by this project.
- Upstream latency can still fluctuate based on network and service load.
- Depends on upstream web-chat behavior and endpoints, which may change.
- Tool calling/function calling is not implemented yet in this proxy.
- Terms/compliance requirements should be reviewed before wider usage.

## 2. Run

```bash
node -v
# requires >= 18.17

./start.sh
```

Default listen address: `http://0.0.0.0:3000`

### Speed tuning knobs

- `CHATJIMMY_TOP_K`
  - lower is usually faster (for example `1`)
  - if unset, upstream default behavior is used
- `MODELS_CACHE_TTL_MS`
  - caches `/v1/models` responses in memory (default `30000` ms)
  - reduces repeated upstream calls for model list traffic
- Use `stream: true` for better perceived latency (first token arrives earlier).

## 3. Supported API

- `GET /v1/models`
- `GET /v1/models/:id`
- `POST /v1/chat/completions`
  - supports `stream: false`
  - supports `stream: true` (SSE, OpenAI chunks + `[DONE]`)

## 4. Quick tests

### List models

```bash
curl -s http://localhost:3000/v1/models | jq
```

### Non-stream chat

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "llama3.1-8B",
    "messages": [
      {"role": "system", "content": "You are concise."},
      {"role": "user", "content": "Introduce yourself in one sentence."}
    ],
    "stream": false
  }' | jq
```

### Stream chat

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "llama3.1-8B",
    "messages": [
      {"role": "user", "content": "Write a short 4-line poem."}
    ],
    "stream": true
  }'
```

## 5. Optional authentication

If you set `PROXY_API_KEY`, the proxy requires:

```http
Authorization: Bearer <PROXY_API_KEY>
```

This lets you use the proxy as a keyed OpenAI-compatible endpoint in SDKs and clients.

## 6. Upstream protocol mapping

- Upstream endpoint: `POST /api/chat`, requires `chatOptions.selectedModel`.
- Upstream stream format: `text/event-stream`, but body chunks are plain text with a trailing sentinel:
  - `<|stats|>{...json...}<|/stats|>`
- This proxy:
  - strips the stats sentinel
  - maps output to OpenAI response schemas
  - emits standard stream frames: `data: {...}` and `data: [DONE]`

## 7. Observed rate limits and quota behavior

Observed on **2026-02-26** during controlled tests from one IP:

- `POST /api/chat` burst tests:
  - 30 requests (concurrency 10): `30/30` returned `200`
  - 100 requests (concurrency 20): `100/100` returned `200`
- `GET /api/models` burst tests:
  - 120 requests (concurrency 20, client timeout 8s): `103` returned `200`, `17` client-side timeouts (`000`)
  - 60 requests (concurrency 20, client timeout 30s): `60/60` returned `200`
- No explicit `429` or `insufficient_quota` response was observed in these runs.

Important: this is an observation, not a guarantee. Rate limits and quota policies may change by time window, IP, or account rules.

## 8. Observed performance benchmark

Latest observed results on **2026-02-26** (`Node v24.0.2`, local machine), using A/B alternating requests in the same time window to reduce timing bias.

### A/B alternating test: non-stream chat latency

- Proxy endpoint: `POST /v1/chat/completions` (`stream=false`)
  - `n=20`, mean `0.836s`, p50 `1.039s`, p90 `1.647s`, p95 `1.681s`
- Direct endpoint: `POST https://chatjimmy.ai/api/chat`
  - `n=20`, mean `0.857s`, p50 `1.150s`, p90 `1.520s`, p95 `1.526s`
- Difference (`proxy - direct`)
  - mean `-0.021s`, median `-0.114s`
  - proxy faster in `13/20` rounds

### A/B alternating test: models endpoint latency

- Proxy endpoint: `GET /v1/models`
  - `n=50`, mean `0.466s`, p50 `0.610s`, p90 `0.858s`, p95 `1.058s`
- Direct endpoint: `GET https://chatjimmy.ai/api/models`
  - `n=50`, mean `0.601s`, p50 `0.693s`, p90 `1.115s`, p95 `1.176s`
- Difference (`proxy - direct`)
  - mean `-0.135s`, median `-0.117s`
  - proxy faster in `42/50` rounds

### A/B alternating test: stream first-token latency (TTFB)

- Proxy endpoint (stream): `POST /v1/chat/completions` with `stream=true`
  - `n=20`, mean `0.181s`, p50 `0.067s`, p90 `0.217s`, p95 `0.992s`
- Direct endpoint (stream-like upstream): `POST https://chatjimmy.ai/api/chat`
  - `n=20`, mean `0.419s`, p50 `0.183s`, p90 `1.305s`, p95 `1.429s`
- Difference (`proxy - direct`)
  - mean `-0.238s`, median `-0.115s`
  - proxy faster in `20/20` rounds

### Local Node overhead baseline

- `GET /healthz` (`n=1000`, `c=50`): ~`17,698` req/sec, average ~`2.3ms`

Interpretation:

- In these samples, the proxy was not consistently slower than direct calls.
- Tail latency still fluctuates due to upstream/network variability.
- The Node layer itself is not the main bottleneck.

Important: these are observational samples, not SLA guarantees.

## 9. Known limitations

- OpenAI `tools` / function calling is not supported yet (`tools` currently returns `400`).
- Image content in multimodal messages is ignored; only text is forwarded.
- `temperature`, `top_p`, and `max_tokens` are not strictly mapped to upstream controls.

## 10. Observed input length limits

Observed on **2026-02-26** with model `llama3.1-8B`.

### Context/token behavior (practical limit)

- With a single long user prompt (minimal history), requests around:
  - `6000` repeated words still returned normal output.
  - `6050` repeated words still returned output.
  - `6080+` repeated words started returning `HTTP 200` with an empty body.
- In successful samples near the edge, upstream stats reported:
  - `prefill_tokens` around `~6011`
  - `total_tokens` around `~6104`

Practical takeaway:

- This path behaves like an effective context ceiling around `~6.1k tokens`.
- For reliability, keep new prompts under about `~5.5k tokens` when history is present.

### Body size limits (bytes)

- Proxy-side limit:
  - `MAX_BODY_BYTES` defaults to `2,000,000` bytes.
  - Exceeding this returns `413` with: `Request body exceeds 2000000 bytes`.
- Upstream gateway may also reject large payloads with `413 Request Entity Too Large` before the proxy limit is reached, depending on request shape.

Recommendation:

- Use token budgeting on the client:
  - `available_input_tokens ≈ context_limit - history_tokens - reserved_output_tokens`
- Reserve at least `300-800` tokens for output to avoid empty/unstable responses near the limit.
