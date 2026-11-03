import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS, chatText, createVideo, downloadVideo, getVideo, makeImage, toolCall } from "../src/zurelay.mjs";
import { activeProvider, kieAspectRatio, useOwnKeys } from "../src/providers.mjs";
import { imagePrice, readPrice, videoCost } from "../src/pricing.mjs";

const GEMINI = "gemini-test-key-do-not-leak";
const KIE = "kie-test-key-do-not-leak";
const saved = {
  fetch: globalThis.fetch,
  gemini: process.env.GEMINI_API_KEY,
  kie: process.env.KIE_API_KEY,
  poll: process.env.ZUVERSE_KIE_POLL_MS,
  retry: process.env.ZUVERSE_RETRY_MS,
};

function restore() {
  globalThis.fetch = saved.fetch;
  if (saved.gemini === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = saved.gemini;
  if (saved.kie === undefined) delete process.env.KIE_API_KEY;
  else process.env.KIE_API_KEY = saved.kie;
  if (saved.poll === undefined) delete process.env.ZUVERSE_KIE_POLL_MS;
  else process.env.ZUVERSE_KIE_POLL_MS = saved.poll;
  if (saved.retry === undefined) delete process.env.ZUVERSE_RETRY_MS;
  else process.env.ZUVERSE_RETRY_MS = saved.retry;
}

function ownKeys() {
  process.env.GEMINI_API_KEY = GEMINI;
  process.env.KIE_API_KEY = KIE;
  process.env.ZUVERSE_KIE_POLL_MS = "0";
  process.env.ZUVERSE_RETRY_MS = "0";
}

function responseFor(body, status = 200) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {
    status,
    headers: { forEach() {} },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: opts.method || "GET",
      headers: opts.headers || {},
      body: opts.body,
    };
    if (typeof opts.body === "string") call.json = JSON.parse(opts.body);
    calls.push(call);
    return responseFor(...(await handler(call, calls)));
  };
  return calls;
}

const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`;
const mp4 = `data:video/mp4;base64,${Buffer.from("fake-mp4").toString("base64")}`;

test("own keys are selected only when Gemini and Kie are both set", () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.KIE_API_KEY;
  assert.equal(useOwnKeys(), false);
  assert.equal(activeProvider(), "zurelay");
  assert.equal(MODELS.video, "seedance-2.5");
  assert.equal(MODELS.read, "gemini-3.1-pro");
  process.env.GEMINI_API_KEY = GEMINI;
  assert.equal(useOwnKeys(), false);
  assert.equal(MODELS.image, "gpt-image-2.5-sunburst");
  ownKeys();
  assert.equal(activeProvider(), "own");
  assert.equal(MODELS.read, "gemini-3.1-pro-preview");
  assert.equal(MODELS.text, "gemini-3.8-flash");
  assert.equal(MODELS.image, "gpt-image-2-5-sunburst");
  assert.equal(MODELS.video, "bytedance/seedance-2-5");
  assert.equal(kieAspectRatio("864x1536"), "9:16");
  assert.equal(kieAspectRatio("1024x1024"), "1:1");
  restore();
});

test("Gemini toolCall sends inline video and a forced function call", async () => {
  ownKeys();
  let hits = 0;
  const calls = installFetch(async (call) => {
    hits += 1;
    if (hits === 1) return [{ candidates: [{ content: { parts: [{ text: "not json" }] } }] }];
    return [{
      candidates: [{
        content: { parts: [{ functionCall: { name: "submit_video_analysis", args: { ok: true, shots: 3 } } }] },
      }],
    }];
  });
  try {
    const value = await toolCall({
      model: "gemini-3.1-pro",
      system: "watch carefully",
      user: [
        { type: "video_url", video_url: { url: mp4 } },
        { type: "text", text: "Describe the ad." },
      ],
      tool: { name: "submit_video_analysis", description: "Submit the analysis.", parameters: { type: "object" } },
      parse: (raw) => {
        const parsed = JSON.parse(raw);
        return parsed.ok ? parsed : null;
      },
      maxTokens: 1000,
      temperature: 0.2,
      label: "reading the ad",
    });
    assert.deepEqual(value, { ok: true, shots: 3 });
    assert.equal(calls.length, 2);
    const request = calls[1];
    assert.equal(request.method, "POST");
    assert.match(request.url, /\/models\/gemini-3\.1-pro-preview:generateContent$/);
    assert.equal(request.headers["x-goog-api-key"], GEMINI);
    assert.equal(request.json.systemInstruction.parts[0].text, "watch carefully");
    assert.equal(request.json.contents[0].parts[0].inlineData.mimeType, "video/mp4");
    assert.equal(request.json.contents[0].parts[1].text, "Describe the ad.");
    assert.equal(request.json.tools[0].functionDeclarations[0].name, "submit_video_analysis");
    assert.equal(request.json.toolConfig.functionCallingConfig.mode, "ANY");
    assert.deepEqual(request.json.toolConfig.functionCallingConfig.allowedFunctionNames, ["submit_video_analysis"]);
    assert.equal(request.json.generationConfig.thinkingConfig.thinkingLevel, "medium");
    assert.equal(request.json.generationConfig.maxOutputTokens, 1000);
    assert.equal(request.json.generationConfig.temperature, 0.2);
  } finally {
    restore();
  }
});

test("Gemini declines a blocked prompt and hides the API key", async () => {
  ownKeys();
  installFetch(async () => [{
    promptFeedback: { blockReason: "SAFETY" },
    error: { message: `refused ${GEMINI}` },
  }]);
  try {
    await assert.rejects(
      () => toolCall({
        model: MODELS.read,
        system: "s",
        user: "hello",
        tool: { name: "submit", description: "s", parameters: { type: "object" } },
        parse: () => ({ ok: true }),
        label: "reading the ad",
      }),
      (error) => {
        assert.equal(error.code, "content_policy");
        assert.match(error.message, /declined/i);
        assert.equal(error.message.includes(GEMINI), false);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("Gemini chatText sends an inline image, skips thoughts, and asks for JSON", async () => {
  ownKeys();
  const calls = installFetch(async (call) => {
    if (calls.length === 1) return [JSON.stringify({ error: { message: `bad ${GEMINI}` } }), 429];
    return [{
      candidates: [{
        content: { parts: [{ thought: true, text: "thinking out loud" }, { text: "a woman in her 30s with a warm voice" }] },
      }],
    }];
  });
  try {
    const text = await chatText({
      model: MODELS.text,
      messages: [
        { role: "system", content: "Describe the voice." },
        { role: "user", content: [{ type: "image_url", image_url: { url: png } }, { type: "text", text: "The person:" }] },
      ],
      responseFormat: { type: "json_object" },
      label: "reading the new voice",
    });
    assert.equal(text, "a woman in her 30s with a warm voice");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].json.generationConfig.responseMimeType, "application/json");
    assert.equal(calls[1].json.generationConfig.thinkingConfig.thinkingLevel, "low");
    assert.equal(calls[1].json.contents[0].parts[0].inlineData.mimeType, "image/png");
    assert.equal(calls[1].json.systemInstruction.parts[0].text, "Describe the voice.");
  } finally {
    restore();
  }
});

test("Gemini chatText returns an empty string when the request is rejected", async () => {
  ownKeys();
  installFetch(async () => [JSON.stringify({ error: { message: `nope ${GEMINI}` } }), 400]);
  try {
    const text = await chatText({ messages: [{ role: "user", content: "Tighten this." }], label: "tighten script" });
    assert.equal(text, "");
  } finally {
    restore();
  }
});

test("Kie text-to-image polls recordInfo and downloads the file", async () => {
  ownKeys();
  let polls = 0;
  const calls = installFetch(async (call) => {
    if (call.url.includes("/createTask")) {
      return [{ code: 200, msg: "success", data: { taskId: "task_img_1" } }];
    }
    if (call.url.includes("/recordInfo")) {
      polls += 1;
      if (polls === 1) return [{ code: 200, data: { taskId: "task_img_1", state: "generating" } }];
      return [{ code: 200, data: { taskId: "task_img_1", state: "success", resultJson: JSON.stringify({ resultUrls: ["https://cdn.example/out.png"] }) } }];
    }
    assert.equal(call.url, "https://cdn.example/out.png");
    return [Buffer.from([0x89, 0x50, 0x4e, 0x47])];
  });
  try {
    const bytes = await makeImage({ prompt: "a person", size: "864x1536", quality: "medium", label: "casting" });
    assert.equal(bytes[0], 0x89);
    const created = calls.find((call) => call.url.includes("/createTask"));
    assert.equal(created.json.model, "gpt-image-2-5-sunburst-text-to-image");
    assert.equal(created.json.input.prompt, "a person");
    assert.equal(created.json.input.aspect_ratio, "9:16");
    assert.equal(created.json.input.resolution, "1K");
    assert.equal(created.json.input.input_urls, undefined);
    assert.equal(created.headers.Authorization, `Bearer ${KIE}`);
    assert.ok(calls.some((call) => call.url.includes("taskId=task_img_1")));
  } finally {
    restore();
  }
});

test("Kie image-to-image uploads a data URL and passes the public URL", async () => {
  ownKeys();
  const calls = installFetch(async (call) => {
    if (call.url.includes("/file-stream-upload")) {
      assert.equal(call.body instanceof FormData, true);
      assert.equal(call.body.get("uploadPath"), "images/zuverse");
      return [{ success: true, code: 200, data: { downloadUrl: "https://tempfile.redpandaai.co/zuverse/face.png" } }];
    }
    if (call.url.includes("/createTask")) return [{ code: 200, data: { taskId: "task_edit" } }];
    if (call.url.includes("/recordInfo")) {
      return [{ code: 200, data: { state: "success", resultJson: "{\"resultUrls\":[\"https://cdn.example/edit.png\"]}" } }];
    }
    return [Buffer.from("png")];
  });
  try {
    const bytes = await makeImage({
      prompt: "redraw",
      images: [png, "https://example.com/already.png"],
      size: "1536x864",
      label: "shot 1",
    });
    assert.equal(bytes.toString(), "png");
    const created = calls.find((call) => call.url.includes("/createTask"));
    assert.equal(created.json.model, "gpt-image-2-5-sunburst-image-to-image");
    assert.deepEqual(created.json.input.input_urls, [
      "https://tempfile.redpandaai.co/zuverse/face.png",
      "https://example.com/already.png",
    ]);
    assert.equal(created.json.input.aspect_ratio, "16:9");
    assert.equal(calls.filter((call) => call.url.includes("/file-stream-upload")).length, 1);
  } finally {
    restore();
  }
});

test("Kie image errors: insufficient credit hides the key, a decline stops polling", async () => {
  ownKeys();
  try {
    installFetch(async () => [{ code: 402, msg: `balance empty for ${KIE}` }]);
    await assert.rejects(() => makeImage({ prompt: "x", label: "casting" }), (error) => {
      assert.match(error.message, /balance/i);
      assert.equal(error.message.includes(KIE), false);
      assert.equal(error.status, 402);
      return true;
    });

    let polls = 0;
    installFetch(async (call) => {
      if (call.url.includes("/createTask")) return [{ code: 200, data: { taskId: "task_no" } }];
      polls += 1;
      return [{ code: 200, data: { state: "fail", failCode: "400", failMsg: "Content policy: the image was declined" } }];
    });
    await assert.rejects(() => makeImage({ prompt: "x", label: "casting" }), (error) => {
      assert.equal(error.code, "content_policy");
      assert.match(error.message, /declined/);
      return true;
    });
    assert.equal(polls, 1);
  } finally {
    restore();
  }
});

test("Kie video uploads the reference clip and reports a content-policy failure", async () => {
  ownKeys();
  const calls = installFetch(async (call) => {
    if (call.url.includes("/file-stream-upload")) {
      const path = call.body.get("uploadPath");
      const url = path.startsWith("videos/") ? "https://tempfile.redpandaai.co/zuverse/clip.mp4" : "https://tempfile.redpandaai.co/zuverse/face.png";
      return [{ code: 200, success: true, data: { downloadUrl: url } }];
    }
    if (call.url.includes("/createTask")) return [{ code: 200, data: { taskId: "task_vid" } }];
    return [{ code: 200, data: { state: "fail", failCode: "422", failMsg: "safety system declined this video", creditsConsumed: 0 } }];
  });
  try {
    const job = await createVideo({
      model: "seedance-2.5",
      prompt: "same shots, new person",
      seconds: 8,
      resolution: "720p",
      aspect_ratio: "9:16",
      generate_audio: true,
      reference_images: [png],
      reference_videos: [mp4],
    });
    assert.deepEqual(job, { id: "task_vid", status: "queued" });
    const created = calls.find((call) => call.url.includes("/createTask"));
    assert.equal(created.json.model, "bytedance/seedance-2-5");
    assert.equal(created.json.input.duration, 8);
    assert.equal(created.json.input.resolution, "720p");
    assert.equal(created.json.input.aspect_ratio, "9:16");
    assert.equal(created.json.input.generate_audio, true);
    assert.deepEqual(created.json.input.reference_image_urls, ["https://tempfile.redpandaai.co/zuverse/face.png"]);
    assert.deepEqual(created.json.input.reference_video_urls, ["https://tempfile.redpandaai.co/zuverse/clip.mp4"]);
    assert.equal(created.json.input.prompt, "same shots, new person");

    const video = await getVideo("task_vid");
    assert.equal(video.status, "failed");
    assert.equal(video.error.code, "content_policy");
    assert.equal(video.cost.credits, 0);
    assert.equal(calls.some((call) => call.url.includes("generated.mp4")), false);
  } finally {
    restore();
  }
});

test("Kie video download follows a successful task", async () => {
  ownKeys();
  installFetch(async (call) => {
    if (call.url.includes("/recordInfo")) {
      return [{ code: 200, data: { state: "success", resultJson: { resultUrls: ["https://cdn.example/generated.mp4"] }, creditsConsumed: 38 } }];
    }
    assert.equal(call.url, "https://cdn.example/generated.mp4");
    return [Buffer.from("mp4-bytes")];
  });
  try {
    const bytes = await downloadVideo("task_ok");
    assert.equal(bytes.toString(), "mp4-bytes");
  } finally {
    restore();
  }
});

test("a Kie model without reference video points at mode=new", async () => {
  ownKeys();
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return responseFor({ code: 200 });
  };
  try {
    await assert.rejects(
      () => createVideo({ model: "some-other-video", prompt: "x", seconds: 5, reference_videos: [mp4] }),
      (error) => {
        assert.equal(error.code, "reference_video_unsupported");
        assert.match(error.message, /mode=new/);
        return true;
      },
    );
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test("prices follow Kie and Gemini when own keys are set, and Zurelay otherwise", () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.KIE_API_KEY;
  assert.deepEqual(videoCost({ seconds: 10, resolution: "720p" }), { output: 3.05, reference: 0, total: 3.05 });
  assert.equal(imagePrice(), 0.034);
  assert.equal(readPrice(), 0.05);
  ownKeys();
  assert.deepEqual(videoCost({ seconds: 10, resolution: "720p" }), { output: 3.15, reference: 0, total: 3.15 });
  assert.deepEqual(videoCost({ seconds: 15, resolution: "720p", referenceSeconds: 10 }), { output: 2.85, reference: 1.9, total: 4.75 });
  assert.deepEqual(videoCost({ seconds: 10, resolution: "480p", referenceSeconds: 10 }), { output: 0.85, reference: 0.85, total: 1.7 });
  assert.equal(imagePrice(), 0.03);
  assert.equal(readPrice(), 0.07);
  restore();
});
