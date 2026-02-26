# chatjimmy.ai OpenAI Proxy

This project wraps `https://chatjimmy.ai` as an OpenAI-compatible API:
- `/v1/models`
- `/v1/chat/completions`

## 1. Run

```bash
node -v
# requires >= 18.17

./start.sh
```

Default listen address: `http://0.0.0.0:3000`

## 2. Supported API

- `GET /v1/models`
- `GET /v1/models/:id`
- `POST /v1/chat/completions`
  - supports `stream: false`
  - supports `stream: true` (SSE, OpenAI chunks + `[DONE]`)

## 3. Quick tests

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

## 4. Optional authentication

If you set `PROXY_API_KEY`, the proxy requires:

```http
Authorization: Bearer <PROXY_API_KEY>
```

This lets you use the proxy as a keyed OpenAI-compatible endpoint in SDKs and clients.

## 5. Upstream protocol mapping

- Upstream endpoint: `POST /api/chat`, requires `chatOptions.selectedModel`.
- Upstream stream format: `text/event-stream`, but body chunks are plain text with a trailing sentinel:
  - `<|stats|>{...json...}<|/stats|>`
- This proxy:
  - strips the stats sentinel
  - maps output to OpenAI response schemas
  - emits standard stream frames: `data: {...}` and `data: [DONE]`

## 6. Observed rate limits and quota behavior

Observed on **2026-02-26** during controlled tests from one IP:

- `POST /api/chat` burst tests:
  - 30 requests (concurrency 10): `30/30` returned `200`
  - 100 requests (concurrency 20): `100/100` returned `200`
- `GET /api/models` burst tests:
  - 120 requests (concurrency 20, client timeout 8s): `103` returned `200`, `17` client-side timeouts (`000`)
  - 60 requests (concurrency 20, client timeout 30s): `60/60` returned `200`
- No explicit `429` or `insufficient_quota` response was observed in these runs.

Important: this is an observation, not a guarantee. Rate limits and quota policies may change by time window, IP, or account rules.

## 7. Observed performance benchmark

Observed on **2026-02-26** with `Node v24.0.2` and `hey` from a local machine.

Proxy benchmark results:

- `GET /healthz` (`n=1000`, `c=50`)
  - ~`17,698` requests/sec
  - average latency ~`2.3ms`
- `GET /v1/models` (`n=100`, `c=10`)
  - ~`13.35` requests/sec
  - average latency ~`709ms`
- `POST /v1/chat/completions` non-stream (`n=20`, `c=4`)
  - ~`5.37` requests/sec
  - average latency ~`733ms`

Direct upstream comparison (same session, for context only):

- `GET https://chatjimmy.ai/api/models` (`n=100`, `c=10`)
  - ~`19.20` requests/sec
  - average latency ~`435ms`
- `POST https://chatjimmy.ai/api/chat` non-stream (`n=20`, `c=4`)
  - ~`2.78` requests/sec
  - average latency ~`1.37s`

Interpretation:

- The Node proxy itself is fast (very high local throughput on `/healthz`).
- Most real-world latency comes from upstream model/service behavior and network variance.

Important: these are sample measurements, not fixed guarantees or SLA values.

## 8. Known limitations

- OpenAI `tools` / function calling is not supported yet (`tools` currently returns `400`).
- Image content in multimodal messages is ignored; only text is forwarded.
- `temperature`, `top_p`, and `max_tokens` are not strictly mapped to upstream controls.
