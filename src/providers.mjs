/**
 * Own-account providers, used when both GEMINI_API_KEY and KIE_API_KEY are set.
 * Otherwise Zuverse stays on Zurelay (see src/zurelay.mjs).
 *
 * Gemini (generateContent): video reading, tool calls, and short text.
 *   https://ai.google.dev/gemini-api/docs/generate-content
 * Kie (createTask, then recordInfo, then download): images and video.
 *   https://docs.kie.ai/market/quickstart
 *   https://docs.kie.ai/market/common/get-task-detail
 * Kie needs a public URL for every input file. Local files and data URLs are
 * uploaded with the file stream API (kept 24 hours):
 *   https://docs.kie.ai/file-upload-api/quickstart
 */

import https from "node:https";
import { URL } from "node:url";
import { ZurelayError } from "./errors.mjs";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const KIE_API_BASE = "https://api.kie.ai";
export const KIE_UPLOAD_BASE = "https://kieai.redpandaai.co";
export const GEMINI_KEY_URL = "https://aistudio.google.com/apikey";
export const KIE_KEY_URL = "https://kie.ai";

/** Zurelay model ids. Callers keep using MODELS.*; these are the fallback. */
export const ZURELAY_MODELS = {
  read: "gemini-3.1-pro",
  text: "gemini-3.8-flash",
  image: "gpt-image-2.5-sunburst",
  video: "seedance-2.5",
};

/**
 * Newest Gemini Pro on the Gemini API is Gemini 3.1 Pro Preview
 * (`gemini-3.1-pro-preview`). Gemini 4's flagship is `gemini-4-argon`, a
 * different line, so analysis stays on Pro.
 * Images: GPT Image 2.5 Sunburst on Kie (text-to-image or image-to-image).
 * Video: Seedance 2.5, which accepts reference video (Replace mode).
 * https://ai.google.dev/gemini-api/docs/models
 * https://docs.kie.ai/market/gpt/gpt-image-2-5-sunburst-text-to-image
 * https://docs.kie.ai/market/bytedance/seedance-2-5
 */
export const OWN_MODELS = {
  read: "gemini-3.1-pro-preview",
  text: "gemini-3.8-flash",
  image: "gpt-image-2-5-sunburst",
  video: "bytedance/seedance-2-5",
};

const GEMINI_ALIAS = {
  "gemini-3.1-pro": OWN_MODELS.read,
  "gemini-3.8-flash": OWN_MODELS.text,
};

const KIE_VIDEO_ALIAS = {
  "seedance-2.5": OWN_MODELS.video,
  "seedance-2": "bytedance/seedance-2",
};

/** Models whose Kie docs accept reference_video_urls (Replace mode). */
const KIE_REFERENCE_VIDEO = new Set([
  "bytedance/seedance-2",
  "bytedance/seedance-2-fast",
  "bytedance/seedance-2-mini",
  "bytedance/seedance-2-5",
  "bytedance/seedance-2-5-draft",
]);

const nativeFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function useOwnKeys() {
  return !!(String(process.env.GEMINI_API_KEY ?? "").trim() && String(process.env.KIE_API_KEY ?? "").trim());
}

export function activeProvider() {
  return useOwnKeys() ? "own" : "zurelay";
}

export function modelMap() {
  return useOwnKeys() ? OWN_MODELS : ZURELAY_MODELS;
}

export function topUpUrl() {
  return useOwnKeys() ? KIE_KEY_URL : "https://zurelay.com/app/billing";
}

function geminiKey() {
  const key = String(process.env.GEMINI_API_KEY ?? "").trim();
  if (!key) throw new ZurelayError(`No Gemini API key. Create one at ${GEMINI_KEY_URL} and set GEMINI_API_KEY in .env.`, { code: "missing_api_key" });
  return key;
}

function kieKey() {
  const key = String(process.env.KIE_API_KEY ?? "").trim();
  if (!key) throw new ZurelayError(`No Kie API key. Create one at ${KIE_KEY_URL} and set KIE_API_KEY in .env.`, { code: "missing_api_key" });
  return key;
}

function redact(message) {
  let out = String(message ?? "");
  for (const key of [process.env.GEMINI_API_KEY, process.env.KIE_API_KEY, process.env.ZURELAY_API_KEY]) {
    const trimmed = String(key ?? "").trim();
    if (trimmed.length > 6) out = out.split(trimmed).join("…");
  }
  return out.slice(0, 500);
}

function retryWaitMs(attempt, retryAfterSec) {
  const override = Number(process.env.ZUVERSE_RETRY_MS);
  if (Number.isFinite(override) && override >= 0) return override;
  return Math.min(60_000, Math.max((Number(retryAfterSec) || 0) * 1000, 5_000 * (attempt + 1)));
}

export function kiePollMs() {
  const n = Number(process.env.ZUVERSE_KIE_POLL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2_000;
}

function headerMap(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  return out;
}

function httpsRequest(urlString, { method, headers, body, timeoutMs, redirects = 0 }) {
  const url = new URL(urlString);
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: {
          ...headers,
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects < 5 && method === "GET") {
          res.resume();
          const next = new URL(Array.isArray(location) ? location[0] : location, url);
          const nextHeaders = { ...headers };
          if (next.host !== url.host) {
            delete nextHeaders.Authorization;
            delete nextHeaders.authorization;
          }
          resolve(httpsRequest(next.toString(), { method, headers: nextHeaders, body: null, timeoutMs, redirects: redirects + 1 }));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status, headers: headerMap(res.headers), buffer: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`No answer within ${Math.round(timeoutMs / 1000)} s.`), { code: "timeout" })));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * JSON and downloads go through node:https in production (a video read can sit
 * longer than fetch's header wait). Tests replace global fetch and every call
 * goes there instead. Multipart uploads use fetch either way.
 */
export async function httpRequest(url, { method = "GET", headers = {}, body = null, timeoutMs = 120_000 } = {}) {
  const viaFetch = globalThis.fetch !== nativeFetch || (typeof FormData !== "undefined" && body instanceof FormData);
  if (viaFetch) {
    const res = await globalThis.fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, headers: headerMap(res.headers), buffer: Buffer.from(await res.arrayBuffer()) };
  }
  return httpsRequest(url, { method, headers, body, timeoutMs });
}

async function httpJson(url, { method = "GET", headers = {}, json, timeoutMs } = {}) {
  const payload = json === undefined ? null : JSON.stringify(json);
  const res = await httpRequest(url, {
    method,
    timeoutMs,
    body: payload,
    headers: {
      Accept: "application/json",
      "User-Agent": "zuverse/1.0 (+https://github.com/zutrue/zuverse)",
      ...(payload ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.buffer.toString("utf8"));
  } catch {
    parsed = null;
  }
  return { ...res, json: parsed };
}

function parseRetryAfter(headers) {
  const raw = headers?.["retry-after"];
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : 0;
}

async function withRetry(label, fn, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error?.status ?? 0;
      const retryable = error?.retryable === true || status === 429 || status === 503 || status === 500;
      if (!retryable || error?.code === "timeout" || attempt >= retries) throw error;
      const wait = retryWaitMs(attempt, error.retryAfter);
      process.stderr.write(`  ${label}: busy (${status || error.code || "error"}), trying again in ${Math.round(wait / 1000)} s...\n`);
      await sleep(wait);
    }
  }
}

/* ─────────────────────────────── Gemini ─────────────────────────────── */

export function geminiModel(requested, fallback) {
  const name = String(requested || fallback || OWN_MODELS.read);
  return GEMINI_ALIAS[name] || name;
}

/** OpenAI-style message content (string or parts) as Gemini parts. Data URLs stay inline. */
export function toGeminiParts(content) {
  const items = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
  const parts = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (item) parts.push({ text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" || typeof item.text === "string") {
      if (item.text) parts.push({ text: String(item.text) });
      continue;
    }
    const url = item.image_url?.url || item.video_url?.url || item.file_url?.url || "";
    if (!url) continue;
    const inline = decodeDataUrl(url);
    if (inline) {
      parts.push({ inlineData: { mimeType: inline.mimeType, data: inline.base64 } });
      continue;
    }
    const mimeType = item.type === "video_url" ? "video/mp4" : "image/jpeg";
    parts.push({ fileData: { fileUri: url, mimeType } });
  }
  return parts.length ? parts : [{ text: "" }];
}

export function decodeDataUrl(url) {
  const match = String(url ?? "").match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  return { mimeType: match[1] || "application/octet-stream", base64: match[2].replace(/\s/g, ""), bytes: Buffer.from(match[2], "base64") };
}

function geminiBlocked(json) {
  const reason = json?.promptFeedback?.blockReason;
  if (reason) return String(reason);
  const finish = json?.candidates?.[0]?.finishReason;
  if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST") return String(finish);
  return "";
}

/** Function-call arguments, or the text answer when the model wrote JSON instead. */
export function geminiArgumentsText(json, name) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const call = parts.map((part) => part?.functionCall).find((fn) => fn && (!name || fn.name === name))
    ?? parts.map((part) => part?.functionCall).find(Boolean);
  if (call) {
    const args = call.args;
    if (typeof args === "string" && args.trim()) return args;
    if (args && typeof args === "object") return JSON.stringify(args);
  }
  const text = parts.filter((part) => part?.text && !part.thought).map((part) => part.text).join("");
  return text.includes("{") ? text : text.trim() ? text : null;
}

export function geminiText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.filter((part) => typeof part?.text === "string" && !part.thought).map((part) => part.text).join("").trim();
}

function geminiError(status, json, headers) {
  const blocked = geminiBlocked(json);
  if (blocked) {
    return new ZurelayError(`Gemini declined this request (${blocked}).`, { status, code: "content_policy" });
  }
  const message = redact(json?.error?.message || json?.error?.status || "");
  let text = `Gemini ${status}${message ? `: ${message}` : ": request failed"}`;
  if (status === 401 || status === 403 || /api key not valid|invalid api key|API_KEY_INVALID/i.test(message)) {
    text = "Gemini refused the API key. Check GEMINI_API_KEY in your .env file.";
  }
  if (status === 429) text = "Gemini rate limit reached. Wait and run it again.";
  const error = new ZurelayError(text, { status, code: String(json?.error?.status ?? ""), retryAfter: parseRetryAfter(headers) });
  error.retryable = status === 429 || status === 500 || status === 503;
  return error;
}

async function geminiGenerate({ model, system, contents, tools, toolConfig, generationConfig, timeoutMs, label }) {
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools) body.tools = tools;
  if (toolConfig) body.toolConfig = toolConfig;
  if (generationConfig) body.generationConfig = generationConfig;
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const res = await withRetry(label || model, async () => {
    const out = await httpJson(url, {
      method: "POST",
      timeoutMs,
      json: body,
      headers: { "x-goog-api-key": geminiKey() },
    });
    if (out.status < 200 || out.status >= 300 || geminiBlocked(out.json)) throw geminiError(out.status, out.json, out.headers);
    return out;
  });
  return res.json;
}

function thinkingLevel(kind) {
  return kind === "text" ? "low" : "medium";
}

function generationConfig({ maxTokens, temperature, responseFormat, kind }) {
  const config = { thinkingConfig: { thinkingLevel: thinkingLevel(kind) } };
  if (maxTokens) config.maxOutputTokens = maxTokens;
  if (typeof temperature === "number") config.temperature = temperature;
  if (responseFormat?.type === "json_object") config.responseMimeType = "application/json";
  return config;
}

/** One Gemini tool-call completion. Returns the arguments as text, or null. */
export async function geminiToolRaw({ model, system, user, tool, maxTokens, temperature, timeoutMs = 900_000, label }) {
  const json = await geminiGenerate({
    model: geminiModel(model, OWN_MODELS.read),
    system,
    contents: [{ role: "user", parts: toGeminiParts(user) }],
    tools: [{ functionDeclarations: [{ name: tool.name, description: tool.description || tool.name, parameters: tool.parameters }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tool.name] } },
    generationConfig: generationConfig({ maxTokens, temperature, kind: "tool" }),
    timeoutMs,
    label,
  });
  return geminiArgumentsText(json, tool.name);
}

/** A short Gemini text answer. Throws on failure; chatText turns that into "". */
export async function geminiChatText({ model = OWN_MODELS.text, messages = [], maxTokens = 2048, temperature, responseFormat, timeoutMs = 120_000, label }) {
  const system = messages.filter((message) => message?.role === "system").map((message) => (typeof message.content === "string" ? message.content : "")).filter(Boolean).join("\n\n");
  const contents = messages.filter((message) => message?.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: toGeminiParts(message.content),
  }));
  const json = await geminiGenerate({
    model: geminiModel(model, OWN_MODELS.text),
    system,
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: "" }] }],
    generationConfig: generationConfig({ maxTokens, temperature, responseFormat, kind: "text" }),
    timeoutMs,
    label,
  });
  return geminiText(json).replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
}

export async function checkGeminiKey() {
  const model = OWN_MODELS.read;
  const res = await httpJson(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}`, {
    timeoutMs: 20_000,
    headers: { "x-goog-api-key": geminiKey() },
  });
  if (res.status === 401 || res.status === 403) throw new ZurelayError("Gemini refused the API key. Check GEMINI_API_KEY in your .env file.", { status: res.status });
  if (res.status < 200 || res.status >= 300) throw geminiError(res.status, res.json, res.headers);
  return model;
}

/* ──────────────────────────────── Kie ──────────────────────────────── */

export function kieVideoModel(requested) {
  const name = String(requested || OWN_MODELS.video);
  return KIE_VIDEO_ALIAS[name] || name;
}

export function kieVideoSupportsReference(model) {
  return KIE_REFERENCE_VIDEO.has(kieVideoModel(model));
}

export function kieImageModel(hasImages) {
  return hasImages ? "gpt-image-2-5-sunburst-image-to-image" : "gpt-image-2-5-sunburst-text-to-image";
}

/** Nearest Kie aspect ratio for a Zurelay size such as 864x1536. */
export function kieAspectRatio(size) {
  const match = String(size ?? "").match(/(\d+)\s*x\s*(\d+)/i);
  if (!match) return "9:16";
  const ratio = Number(match[1]) / Number(match[2]);
  if (!Number.isFinite(ratio) || ratio <= 0) return "9:16";
  const choices = [["1:1", 1], ["3:2", 3 / 2], ["2:3", 2 / 3], ["4:3", 4 / 3], ["3:4", 3 / 4], ["16:9", 16 / 9], ["9:16", 9 / 16], ["21:9", 21 / 9]];
  let best = "9:16";
  let bestDelta = Infinity;
  for (const [name, value] of choices) {
    const delta = Math.abs(Math.log(ratio / value));
    if (delta < bestDelta) {
      bestDelta = delta;
      best = name;
    }
  }
  return best;
}

/**
 * Zuverse draws the phone-photo look at 1K (see src/photo.mjs). Kie bills
 * 1K / 2K / 4K separately; medium and low stay at 1K.
 */
export function kieImageResolution(quality) {
  const name = String(quality ?? "medium").toLowerCase();
  if (name === "high" || name === "hd" || name === "4k") return "4K";
  if (name === "2k") return "2K";
  return "1K";
}

export function classifyKieFailure(failCode, failMsg) {
  const text = `${failCode ?? ""} ${failMsg ?? ""}`.toLowerCase();
  if (/content[_\s-]*policy|safety|nsfw|moderation|prohibited|sensitive|declined/.test(text)) return "content_policy";
  if (/invalid[_\s-]*image|image (format|type|size)|resolution too|aspect ratio/.test(text)) return "invalid_image";
  if (/timeout|timed out|took too long/.test(text)) return "generation_timeout";
  const code = String(failCode ?? "").trim();
  return code || "failed";
}

function kieFailure(res, label) {
  const code = Number(res.json?.code ?? res.status ?? 0);
  const message = redact(res.json?.msg || res.json?.message || "");
  let text = `${label}: Kie ${code}${message ? `: ${message}` : ": request failed"}`;
  let errorCode = String(res.json?.code ?? "");
  if (code === 401 || res.status === 401) {
    text = "Kie refused the API key. Check KIE_API_KEY in your .env file.";
    errorCode = "invalid_api_key";
  } else if (code === 402 || res.status === 402) {
    text = `Your Kie balance doesn't cover this request. Add credit at ${KIE_KEY_URL} and run it again.`;
    errorCode = "insufficient_credits";
  }
  const error = new ZurelayError(text, { status: code || res.status, code: errorCode, retryAfter: parseRetryAfter(res.headers) });
  error.retryable = code === 429 || code === 500 || code === 503 || res.status === 429 || res.status === 500 || res.status === 503;
  return error;
}

function kieSucceeded(res) {
  const code = res.json?.code;
  if (typeof code === "number") return code === 200;
  return res.status >= 200 && res.status < 300;
}

async function kieApi(path, { method = "GET", json, timeoutMs, label }) {
  const res = await httpJson(`${KIE_API_BASE}${path}`, {
    method,
    json,
    timeoutMs,
    headers: { Authorization: `Bearer ${kieKey()}` },
  });
  if (!kieSucceeded(res)) throw kieFailure(res, label);
  return res.json;
}

function extensionFor(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("video")) return "mp4";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "bin";
}

/** A public URL Kie can fetch. https URLs pass through; data URLs are uploaded. */
export async function kiePublicUrl(source, { label = "upload" } = {}) {
  const value = String(source ?? "");
  if (/^https:\/\//i.test(value)) return value;
  const inline = decodeDataUrl(value);
  if (!inline) {
    throw new ZurelayError(`${label}: Kie needs a public https URL or a data URL it can upload. Received something else.`, { code: "upload_required" });
  }
  const video = inline.mimeType.startsWith("video/");
  const res = await withRetry(label, async () => {
    const fileName = `zuverse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${extensionFor(inline.mimeType)}`;
    const form = new FormData();
    form.append("file", new Blob([inline.bytes], { type: inline.mimeType }), fileName);
    form.append("uploadPath", video ? "videos/zuverse" : "images/zuverse");
    form.append("fileName", fileName);
    const out = await httpRequest(`${KIE_UPLOAD_BASE}/api/file-stream-upload`, {
      method: "POST",
      timeoutMs: 180_000,
      body: form,
      headers: { Authorization: `Bearer ${kieKey()}` },
    });
    let json = null;
    try {
      json = JSON.parse(out.buffer.toString("utf8"));
    } catch {
      json = null;
    }
    const wrapped = { ...out, json };
    if (!kieSucceeded(wrapped) || json?.success === false) throw kieFailure(wrapped, label);
    return wrapped;
  });
  const url = res.json?.data?.downloadUrl || res.json?.data?.fileUrl;
  if (!url) throw new ZurelayError(`${label}: Kie uploaded the file but returned no URL.`, { code: "upload_failed" });
  return url;
}

function taskState(info) {
  return String(info?.state ?? info?.status ?? "").toLowerCase();
}

export function kieStatus(state) {
  if (state === "success") return "completed";
  if (state === "fail" || state === "failed") return "failed";
  if (state === "generating") return "processing";
  return "queued";
}

export function kieResultUrls(info) {
  let raw = info?.resultJson;
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const urls = raw.resultUrls ?? raw.result_urls ?? [];
  return (Array.isArray(urls) ? urls : [urls]).map((item) => (typeof item === "string" ? item : item?.url)).filter(Boolean);
}

function kieTaskError(info) {
  const message = redact(info?.failMsg || "Kie couldn't finish this task.");
  return {
    code: classifyKieFailure(info?.failCode, info?.failMsg),
    message,
  };
}

async function kieRecord(taskId, label) {
  const json = await withRetry(label, () => kieApi(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { timeoutMs: 60_000, label }));
  return json?.data ?? json;
}

async function kieCreate(model, input, label) {
  const json = await withRetry(label, () => kieApi("/api/v1/jobs/createTask", {
    method: "POST",
    timeoutMs: 300_000,
    label,
    json: { model, input },
  }));
  const taskId = json?.data?.taskId;
  if (!taskId) throw new ZurelayError(`${label}: Kie didn't return a task id.`, { code: "missing_task" });
  return taskId;
}

async function kieWait(taskId, { timeoutMs, label }) {
  const started = Date.now();
  let last = "";
  for (;;) {
    const info = await kieRecord(taskId, label);
    const state = taskState(info);
    if (state && state !== last) process.stderr.write(`  ${label}: Kie ${state}\n`);
    last = state;
    if (state === "success") return info;
    if (state === "fail" || state === "failed") {
      const error = kieTaskError(info);
      throw new ZurelayError(`${label}: ${error.message}`, { code: error.code });
    }
    if (Date.now() - started > timeoutMs) {
      throw new ZurelayError(`${label}: Kie didn't finish within ${Math.round(timeoutMs / 1000)} s.`, { code: "timeout" });
    }
    await sleep(kiePollMs());
  }
}

async function downloadUrl(url, label) {
  const res = await httpRequest(url, { timeoutMs: 600_000 });
  if (res.status < 200 || res.status >= 300 || !res.buffer?.length) {
    throw new ZurelayError(`${label}: couldn't download the result (${res.status}).`);
  }
  return res.buffer;
}

export async function kieMakeImage({ prompt, images = [], size, quality = "medium", label = "image" }) {
  const urls = [];
  for (const image of images) urls.push(await kiePublicUrl(image, { label }));
  const input = {
    prompt: String(prompt ?? ""),
    aspect_ratio: kieAspectRatio(size),
    resolution: kieImageResolution(quality),
  };
  if (urls.length) input.input_urls = urls;
  const taskId = await kieCreate(kieImageModel(urls.length > 0), input, label);
  const info = await kieWait(taskId, { timeoutMs: 600_000, label });
  const result = kieResultUrls(info)[0];
  if (!result) throw new ZurelayError(`${label}: no image came back.`, { code: "image_not_generated" });
  return downloadUrl(result, label);
}

export function assertReferenceVideoSupported(model, hasVideo) {
  const resolved = kieVideoModel(model);
  if (hasVideo && !kieVideoSupportsReference(resolved)) {
    throw new ZurelayError(
      `Replace mode sends the original clip as a reference video, and ${resolved} on Kie does not accept one. Set mode=new (Make a new version), then build the prompt again and render: zuverse set <project> mode=new`,
      { code: "reference_video_unsupported" },
    );
  }
  return resolved;
}

export async function kieCreateVideo(body) {
  const hasVideo = Array.isArray(body?.reference_videos) && body.reference_videos.length > 0;
  const model = assertReferenceVideoSupported(body?.model, hasVideo);
  const input = {
    prompt: String(body?.prompt ?? ""),
    duration: Number(body?.seconds) || 5,
    resolution: body?.resolution || "720p",
    aspect_ratio: body?.aspect_ratio || "9:16",
    generate_audio: body?.generate_audio !== false,
  };
  if (Array.isArray(body?.reference_images) && body.reference_images.length) {
    input.reference_image_urls = [];
    for (const image of body.reference_images) input.reference_image_urls.push(await kiePublicUrl(image, { label: "video image" }));
  }
  if (hasVideo) {
    input.reference_video_urls = [];
    for (const video of body.reference_videos) input.reference_video_urls.push(await kiePublicUrl(video, { label: "reference video" }));
  }
  const taskId = await kieCreate(model, input, "video");
  return { id: taskId, status: "queued" };
}

export async function kieGetVideo(id) {
  const info = await kieRecord(id, "video status");
  const state = taskState(info);
  const status = kieStatus(state);
  const credits = Number(info?.creditsConsumed);
  return {
    id,
    status,
    progress: typeof info?.progress === "number" ? info.progress : null,
    cost: Number.isFinite(credits) ? { credits, usd: Math.round(credits * 0.5) / 100 } : null,
    error: status === "failed" ? kieTaskError(info) : null,
    resultUrls: kieResultUrls(info),
  };
}

export async function kieDownloadVideo(id) {
  const video = await kieGetVideo(id);
  if (video.status !== "completed") {
    throw new ZurelayError(`video download: the Kie task is ${video.status}.`, { code: video.error?.code || "not_ready" });
  }
  const url = video.resultUrls[0];
  if (!url) throw new ZurelayError("video download: Kie finished without a video URL.", { code: "missing_result" });
  return downloadUrl(url, "video download");
}

export async function checkKieKey() {
  const res = await httpJson(`${KIE_API_BASE}/api/v1/chat/credit`, {
    timeoutMs: 20_000,
    headers: { Authorization: `Bearer ${kieKey()}` },
  });
  if (!kieSucceeded(res)) throw kieFailure(res, "key check");
  const credits = res.json?.data?.credits ?? res.json?.data?.balance ?? res.json?.data;
  return credits;
}
