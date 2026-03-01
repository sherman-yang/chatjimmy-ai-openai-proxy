import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_BODY_BYTES = Number.parseInt(process.env.MAX_BODY_BYTES ?? "2000000", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS ?? "120000", 10);

const UPSTREAM_BASE_URL = (process.env.UPSTREAM_BASE_URL ?? "https://chatjimmy.ai").replace(/\/+$/, "");
const UPSTREAM_MODELS_PATH = process.env.UPSTREAM_MODELS_PATH ?? "/api/models";
const UPSTREAM_CHAT_PATH = process.env.UPSTREAM_CHAT_PATH ?? "/api/chat";

const PROXY_API_KEY = process.env.PROXY_API_KEY ?? "";
const DEFAULT_SYSTEM_PROMPT = process.env.CHATJIMMY_SYSTEM_PROMPT ?? "";
const DEFAULT_TOP_K = (() => {
  const raw = process.env.CHATJIMMY_TOP_K;
  if (raw == null || raw.trim() === "") {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : null;
})();
const MODELS_CACHE_TTL_MS = (() => {
  const parsed = Number.parseInt(process.env.MODELS_CACHE_TTL_MS ?? "30000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30000;
})();

const STATS_START = "<|stats|>";
const STATS_END = "<|/stats|>";

const modelsCache = {
  payload: null,
  fetchedAt: 0,
  inflight: null,
};

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function openAiError(res, statusCode, message, type = "invalid_request_error", code = null, param = null) {
  json(res, statusCode, {
    error: {
      message,
      type,
      param,
      code,
    },
  });
}

function setCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type");
}

function getBearerToken(req) {
  const value = req.headers.authorization;
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function requireAuth(req, res) {
  if (!PROXY_API_KEY) {
    return true;
  }
  const token = getBearerToken(req);
  if (token !== PROXY_API_KEY) {
    openAiError(res, 401, "Invalid API key", "authentication_error", "invalid_api_key");
    return false;
  }
  return true;
}

function makeId(prefix) {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (!part || typeof part !== "object") {
          return "";
        }
        if (typeof part.text === "string") {
          return part.text;
        }
        if (part.text && typeof part.text === "object" && typeof part.text.value === "string") {
          return part.text.value;
        }
        if (typeof part.input_text === "string") {
          return part.input_text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      return content.text;
    }
    if (typeof content.value === "string") {
      return content.value;
    }
  }

  return "";
}

function normalizeMessages(messages) {
  const systemPrompts = [];
  const normalized = [];

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const role = typeof raw.role === "string" ? raw.role : "user";
    const content = extractTextContent(raw.content);

    if (!content) {
      continue;
    }

    if (role === "system") {
      systemPrompts.push(content);
      continue;
    }

    if (role === "user" || role === "assistant") {
      normalized.push({
        id: typeof raw.id === "string" ? raw.id : makeId("msg"),
        role,
        content,
      });
      continue;
    }

    normalized.push({
      id: typeof raw.id === "string" ? raw.id : makeId("msg"),
      role: "user",
      content: `[${role}] ${content}`,
    });
  }

  return {
    systemPrompt: systemPrompts.join("\n\n"),
    messages: normalized,
  };
}

function parseStatsSentinel(text) {
  const start = text.lastIndexOf(STATS_START);
  const end = text.lastIndexOf(STATS_END);

  if (start === -1 || end === -1 || end < start) {
    return { text, stats: null };
  }

  const before = text.slice(0, start);
  const statsRaw = text.slice(start + STATS_START.length, end);
  const after = text.slice(end + STATS_END.length);

  let stats = null;
  try {
    stats = JSON.parse(statsRaw);
  } catch {
    stats = null;
  }

  return {
    text: before + after,
    stats,
  };
}

function mapFinishReason(stats) {
  const reason =
    (typeof stats?.done_reason === "string" && stats.done_reason) ||
    (typeof stats?.reason === "string" && stats.reason) ||
    "stop";

  const normalized = reason.toLowerCase();
  if (normalized.includes("length") || normalized.includes("max")) {
    return "length";
  }
  if (normalized.includes("content_filter")) {
    return "content_filter";
  }
  return "stop";
}

function usageFromStats(stats) {
  const promptTokens = Number(stats?.prefill_tokens);
  const completionTokens = Number(stats?.decode_tokens);
  const totalTokens = Number(stats?.total_tokens);

  if (
    Number.isFinite(promptTokens) &&
    Number.isFinite(completionTokens) &&
    Number.isFinite(totalTokens)
  ) {
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    };
  }

  return undefined;
}

function parseTopK(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }
  return Math.floor(parsed);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

async function fetchUpstream(path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(`${UPSTREAM_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildUpstreamPayload(openAiBody, model) {
  const { messages, systemPrompt } = normalizeMessages(openAiBody.messages);
  const passthroughChatOptions =
    openAiBody.chatOptions && typeof openAiBody.chatOptions === "object"
      ? openAiBody.chatOptions
      : {};

  const mergedPrompt = [DEFAULT_SYSTEM_PROMPT, passthroughChatOptions.systemPrompt, systemPrompt]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");

  const topKFromRequest = parseTopK(passthroughChatOptions.topK);
  const topK = topKFromRequest ?? DEFAULT_TOP_K;
  const chatOptions = {
    ...passthroughChatOptions,
    selectedModel: model,
    systemPrompt: mergedPrompt,
  };
  if (topK != null) {
    chatOptions.topK = topK;
  } else {
    delete chatOptions.topK;
  }

  return {
    messages,
    chatOptions,
    attachment:
      openAiBody.attachment && typeof openAiBody.attachment === "object"
        ? openAiBody.attachment
        : null,
  };
}

function sendSseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamToOpenAi(res, upstreamResponse, options) {
  const { completionId, model, created, includeUsage } = options;

  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    throw new Error("Upstream response has no readable body");
  }

  const decoder = new TextDecoder();
  const markerLookbehind = STATS_START.length - 1;
  let roleSent = false;
  let pending = "";
  let stats = null;

  const emitText = (text) => {
    if (!text) {
      return;
    }
    const delta = roleSent ? { content: text } : { role: "assistant", content: text };
    roleSent = true;
    sendSseChunk(res, {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: null,
        },
      ],
    });
  };

  const parseStatsFromPending = () => {
    const start = pending.indexOf(STATS_START);
    if (start === -1) {
      return "none";
    }

    const before = pending.slice(0, start);
    if (before) {
      emitText(before);
    }

    const end = pending.indexOf(STATS_END, start + STATS_START.length);
    if (end === -1) {
      pending = pending.slice(start);
      return "need-more";
    }

    const statsRaw = pending.slice(start + STATS_START.length, end);
    try {
      stats = JSON.parse(statsRaw);
    } catch {
      stats = null;
    }

    pending = pending.slice(end + STATS_END.length);
    return "consumed";
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    pending += decoder.decode(value, { stream: true });

    // Extract stats if marker appears.
    while (true) {
      const parseState = parseStatsFromPending();
      if (parseState !== "consumed") {
        break;
      }
    }

    // Emit everything except a short suffix kept for marker boundary detection.
    if (pending.length > markerLookbehind && pending.indexOf(STATS_START) === -1) {
      const emit = pending.slice(0, pending.length - markerLookbehind);
      pending = pending.slice(pending.length - markerLookbehind);
      emitText(emit);
    }
  }

  pending += decoder.decode();

  while (true) {
    const parseState = parseStatsFromPending();
    if (parseState !== "consumed") {
      break;
    }
  }

  if (pending) {
    emitText(pending);
    pending = "";
  }

  sendSseChunk(res, {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: mapFinishReason(stats),
      },
    ],
  });

  if (includeUsage) {
    sendSseChunk(res, {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: usageFromStats(stats),
    });
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

async function fetchModelsPayloadFromUpstream() {
  const upstream = await fetchUpstream(UPSTREAM_MODELS_PATH, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  });

  const raw = await upstream.text();
  if (!upstream.ok) {
    let message = raw || `Upstream returned ${upstream.status}`;
    try {
      const parsed = JSON.parse(raw);
      message = parsed.error || parsed.message || message;
    } catch {
      // Keep raw message.
    }
    const error = new Error(message);
    error.statusCode = upstream.status;
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Upstream models response is not valid JSON");
    error.statusCode = 502;
    throw error;
  }
}

async function getModelsPayload() {
  const now = Date.now();
  if (
    modelsCache.payload &&
    MODELS_CACHE_TTL_MS > 0 &&
    now - modelsCache.fetchedAt <= MODELS_CACHE_TTL_MS
  ) {
    return modelsCache.payload;
  }

  if (modelsCache.inflight) {
    return modelsCache.inflight;
  }

  modelsCache.inflight = (async () => {
    const payload = await fetchModelsPayloadFromUpstream();
    modelsCache.payload = payload;
    modelsCache.fetchedAt = Date.now();
    return payload;
  })().finally(() => {
    modelsCache.inflight = null;
  });

  return modelsCache.inflight;
}

async function handleModelsList(req, res) {
  if (!requireAuth(req, res)) {
    return;
  }
  let payload;
  try {
    payload = await getModelsPayload();
  } catch (error) {
    openAiError(res, error?.statusCode ?? 502, error?.message ?? "Failed to fetch models", "api_error");
    return;
  }

  json(res, 200, payload);
}

async function handleModelById(req, res, modelId) {
  if (!requireAuth(req, res)) {
    return;
  }
  let payload;
  try {
    payload = await getModelsPayload();
  } catch (error) {
    openAiError(res, error?.statusCode ?? 502, error?.message ?? "Failed to fetch models", "api_error");
    return;
  }
  const model = payload?.data?.find((item) => item?.id === modelId);
  if (!model) {
    openAiError(res, 404, `Model '${modelId}' not found`, "invalid_request_error", "model_not_found");
    return;
  }

  json(res, 200, model);
}

async function handleChatCompletions(req, res) {
  if (!requireAuth(req, res)) {
    return;
  }

  if (req.method !== "POST") {
    openAiError(res, 405, "Method not allowed");
    return;
  }

  const body = await readJsonBody(req);

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    openAiError(res, 400, "`messages` must be a non-empty array");
    return;
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    openAiError(
      res,
      400,
      "This proxy does not support tool calling yet. Remove `tools` and retry."
    );
    return;
  }

  const model = typeof body.model === "string" && body.model.trim() ? body.model : "llama3.1-8B";
  const upstreamPayload = buildUpstreamPayload(body, model);

  if (!Array.isArray(upstreamPayload.messages) || upstreamPayload.messages.length === 0) {
    openAiError(res, 400, "No usable non-system messages found in request");
    return;
  }

  const upstream = await fetchUpstream(UPSTREAM_CHAT_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(upstreamPayload),
  });

  if (!upstream.ok) {
    const raw = await upstream.text();
    let message = raw || `Upstream returned ${upstream.status}`;
    try {
      const parsed = JSON.parse(raw);
      message = parsed.error || parsed.message || message;
    } catch {
      // Keep raw message.
    }
    openAiError(res, upstream.status, message);
    return;
  }

  const completionId = makeId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const stream = body.stream === true;
  const includeUsage = Boolean(body.stream_options?.include_usage);

  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    await streamToOpenAi(res, upstream, {
      completionId,
      model,
      created,
      includeUsage,
    });
    return;
  }

  const upstreamText = await upstream.text();
  const { text, stats } = parseStatsSentinel(upstreamText);
  const usage = usageFromStats(stats);

  json(res, 200, {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: mapFinishReason(stats),
      },
    ],
    usage,
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (!req.url || !req.method) {
    openAiError(res, 400, "Invalid request");
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/healthz") {
      json(res, 200, { ok: true, upstream: UPSTREAM_BASE_URL });
      return;
    }

    if (req.method === "GET" && pathname === "/v1/models") {
      await handleModelsList(req, res);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/v1/models/")) {
      const modelId = decodeURIComponent(pathname.slice("/v1/models/".length));
      if (!modelId) {
        openAiError(res, 400, "Model id is required");
        return;
      }
      await handleModelById(req, res, modelId);
      return;
    }

    if (pathname === "/v1/chat/completions") {
      await handleChatCompletions(req, res);
      return;
    }

    openAiError(res, 404, `Unknown route: ${pathname}`, "invalid_request_error", "not_found");
  } catch (error) {
    if (error?.name === "AbortError") {
      openAiError(res, 504, "Upstream request timed out", "api_error", "upstream_timeout");
      return;
    }

    if (typeof error?.statusCode === "number") {
      openAiError(res, error.statusCode, error.message);
      return;
    }

    console.error("Unhandled proxy error:", error);
    openAiError(res, 500, "Internal proxy error", "api_error", "internal_error");
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Error: address ${HOST}:${PORT} is already in use.`);
    console.error("How to fix:");
    console.error(`  1) Stop the process listening on port ${PORT}.`);
    console.error("  2) Or change PORT in .env and restart the proxy.");
    process.exit(1);
    return;
  }

  if (error?.code === "EACCES") {
    console.error(`Error: no permission to bind ${HOST}:${PORT}.`);
    console.error("Try a higher port (for example 3000 or 3011).");
    process.exit(1);
    return;
  }

  console.error("Server failed to start:", error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(
    `chatjimmy OpenAI proxy listening on http://${HOST}:${PORT} -> ${UPSTREAM_BASE_URL}`
  );
});
