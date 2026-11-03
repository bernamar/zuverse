/**
 * What a run costs, in US dollars.
 *
 * Zurelay (the default, when GEMINI_API_KEY and KIE_API_KEY are not both set):
 * prices as listed on https://zurelay.com/models on 2026-10-15. Failed videos
 * are free on Zurelay.
 *
 * Own keys (Gemini + Kie), checked 2026-10-28:
 * - Seedance 2.5 on Kie, per second. Without a reference video the rate applies
 *   to the output only. With a reference video the lower rate applies to
 *   (uploaded seconds + output seconds). Reference images are not billed.
 *   https://kie.ai/pricing
 *   https://kie.ai/blog/seedance-2-5-pricing
 * - GPT Image 2.5 Sunburst on Kie: $0.03 at 1K, $0.05 at 2K, $0.08 at 4K.
 *   Zuverse asks for 1K. https://kie.ai/gpt-image-2-5
 * - Gemini 3.1 Pro Preview, standard tier: $2 / 1M input tokens and $12 / 1M
 *   output tokens (prompts up to 200k). A 30s watch is roughly 300 tokens a
 *   second at high media resolution plus a few thousand output tokens, about
 *   $0.07. https://ai.google.dev/gemini-api/docs/pricing
 *   https://ai.google.dev/gemini-api/docs/video-understanding
 * Failed Kie tasks are not charged (https://kie.ai/pricing).
 */

import { useOwnKeys } from "./providers.mjs";

export const PRICES_AS_OF = "2026-10-15";
export const OWN_PRICES_AS_OF = "2026-10-28";

/** Seedance 2.5 on Zurelay, per second of output. */
export const SEEDANCE_25_PER_SECOND = { "480p": 0.135, "720p": 0.305, "1080p": 0.75 };
/** Seedance 2.5 on Zurelay, per second of reference video. */
export const SEEDANCE_25_REFERENCE_PER_SECOND = { "480p": 0.081, "720p": 0.183 };
/** GPT Image 2.5 Sunburst on Zurelay at the size Zuverse draws (864x1536 bills as 2K). */
export const IMAGE_PRICE = 0.034;
/** Gemini 3.1 Pro on Zurelay watching a 30 s clip (plus the shot-by-shot read), roughly. */
export const READ_PRICE = 0.05;

/** Seedance 2.5 on Kie, per second of output when no reference video is sent. */
export const KIE_SEEDANCE_25_PER_SECOND = { "480p": 0.14, "720p": 0.315, "1080p": 0.79 };
/**
 * Seedance 2.5 on Kie, per second when a reference video is sent. Charged on
 * the uploaded seconds and the output seconds.
 */
export const KIE_SEEDANCE_25_WITH_VIDEO_PER_SECOND = { "480p": 0.085, "720p": 0.19, "1080p": 0.475 };
/** GPT Image 2.5 Sunburst on Kie at 1K, the size Zuverse requests. */
export const KIE_IMAGE_PRICE = 0.03;
/** Rough Gemini 3.1 Pro Preview cost of watching one 30 s ad. */
export const GEMINI_READ_PRICE = 0.07;

/**
 * Seedance 2.5 takes a reference video at 480p and 720p only, so a "Replace
 * the person" render asked for at 1080p is made at 720p.
 */
export function renderResolution(resolution, sendsVideo) {
  if (sendsVideo && resolution === "1080p") return "720p";
  return resolution === "480p" || resolution === "1080p" ? resolution : "720p";
}

export function pricesAsOf() {
  return useOwnKeys() ? OWN_PRICES_AS_OF : PRICES_AS_OF;
}

export function imagePrice() {
  return useOwnKeys() ? KIE_IMAGE_PRICE : IMAGE_PRICE;
}

export function readPrice() {
  return useOwnKeys() ? GEMINI_READ_PRICE : READ_PRICE;
}

export function priceLinks() {
  return useOwnKeys()
    ? "https://kie.ai/pricing and https://ai.google.dev/gemini-api/docs/pricing"
    : "https://zurelay.com/models";
}

/** The video's price: output seconds, plus the reference clip's seconds when it is sent. */
export function videoCost({ seconds, resolution, referenceSeconds = 0 }) {
  const own = useOwnKeys();
  const outputTable = own ? KIE_SEEDANCE_25_PER_SECOND : SEEDANCE_25_PER_SECOND;
  const referenceTable = own ? KIE_SEEDANCE_25_WITH_VIDEO_PER_SECOND : SEEDANCE_25_REFERENCE_PER_SECOND;
  const hasReference = referenceSeconds > 0;
  // On Kie the with-video rate replaces the output rate and also covers the clip.
  const outputRate = own && hasReference ? referenceTable[resolution] ?? referenceTable["720p"] : outputTable[resolution] ?? outputTable["720p"];
  const referenceRate = referenceTable[resolution] ?? referenceTable["720p"];
  const out = outputRate * seconds;
  const ref = hasReference ? referenceRate * referenceSeconds : 0;
  return { output: round2(out), reference: round2(ref), total: round2(out + ref) };
}

export const round2 = (n) => Math.round(n * 100) / 100;
export const usd = (n) => `$${round2(n).toFixed(2)}`;
