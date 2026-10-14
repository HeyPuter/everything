// Reading handwriting: the selected ink is drawn into a picture, black on
// white, and Puter's AI is asked what it says, as text or as math (LaTeX).
// The call goes through `chat`, so tests can answer in place of the model.
import { strokeSamples, strokeStyle } from "./ink-model.js";

const PROMPTS = {
  text: "The picture shows handwriting drawn with a pen. Transcribe exactly what is written, keeping its line breaks, spelling and capitalisation. Reply with the transcription only: no quotes, labels or commentary. If nothing in it is legible, reply with nothing.",
  math: "The picture shows a handwritten mathematical expression. Reply with the LaTeX for it only: no $ signs, \\[ \\] delimiters, code fences or commentary. If it is not legible math, reply with nothing.",
};

/** The prompt sent for `mode` ("text" or "math"). */
export const inkPrompt = (mode) => PROMPTS[mode] || PROMPTS.text;

/** Where the strokes lie on the slide, their width included. */
export function inkBounds(P, shapes) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of shapes) {
    const b = P.getShapeBounds(s);
    if (!b) continue;
    const pad = (strokeStyle(P, s).width || 0) / 2;
    x0 = Math.min(x0, b.x - pad);
    y0 = Math.min(y0, b.y - pad);
    x1 = Math.max(x1, b.x + b.w + pad);
    y1 = Math.max(y1, b.y + b.h + pad);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * The strokes drawn into a PNG data URL, black on white with a margin, no
 * larger than `maxSize` pixels on a side. Lines are at least 2px wide so
 * thin pens still read.
 */
export function inkToPng(
  P,
  shapes,
  { maxSize = 1024, margin = 24, document = globalThis.document } = {},
) {
  const box = inkBounds(P, shapes);
  if (!box) return null;
  const scale = Math.min(
    (maxSize - margin * 2) / Math.max(box.w, 1),
    (maxSize - margin * 2) / Math.max(box.h, 1),
    // Small writing is not blown up past what the model needs.
    800 / Math.max(box.w, box.h, 1),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(64, Math.ceil(box.w * scale + margin * 2));
  canvas.height = Math.max(64, Math.ceil(box.h * scale + margin * 2));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#000000";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of shapes) {
    const pts = strokeSamples(P, s, 6);
    if (!pts.length) continue;
    ctx.lineWidth = Math.max(2, strokeStyle(P, s).width * scale);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (p.x - box.x) * scale + margin,
        y = (p.y - box.y) * scale + margin;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    if (pts.length === 1)
      ctx.lineTo(
        (pts[0].x - box.x) * scale + margin + 0.5,
        (pts[0].y - box.y) * scale + margin,
      );
    ctx.stroke();
  }
  return { dataUrl: canvas.toDataURL("image/png"), bounds: box };
}

/** The words of a model's answer, whatever shape the SDK gave it in. */
export function replyText(res) {
  if (typeof res === "string") return res;
  const content = res?.message?.content ?? res?.text ?? res?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) => (typeof c === "string" ? c : c?.text || ""))
      .join("");
  return "";
}

/** An answer cut down to the text or LaTeX it carries. */
export function cleanRecognized(text, mode = "text") {
  let s = String(text ?? "").trim();
  const fence = s.match(/^```[a-z]*\n?([\s\S]*?)\n?```$/i);
  if (fence) s = fence[1].trim();
  s = s.replace(/^(transcription|text|latex|answer)\s*:\s*/i, "");
  if (mode === "math") {
    s = s
      .replace(/^\$\$([\s\S]*)\$\$$/, "$1")
      .replace(/^\$([\s\S]*)\$$/, "$1")
      .replace(/^\\\[([\s\S]*)\\\]$/, "$1")
      .replace(/^\\\(([\s\S]*)\\\)$/, "$1")
      .trim();
  } else if (/^"[\s\S]*"$|^“[\s\S]*”$/.test(s)) s = s.slice(1, -1).trim();
  return s;
}

/**
 * Asks the AI what the picture of ink says. `chat` is puter.ai.chat (or a
 * stand-in taking the same arguments: prompt, image, test mode, options).
 * Resolves to the cleaned answer, empty when it read nothing.
 */
export async function readInk(dataUrl, mode, { chat, model } = {}) {
  if (!chat) throw new Error("AI is not available here.");
  let res;
  try {
    res = await chat(inkPrompt(mode), dataUrl, false, model ? { model } : {});
  } catch (e) {
    const inner = e?.error && typeof e.error === "object" ? e.error : e;
    throw new Error(
      inner?.message || String(e?.message || e || "The AI did not answer."),
    );
  }
  if (res?.success === false)
    throw new Error(
      res.error?.message || res.error || "The AI did not answer.",
    );
  return cleanRecognized(replyText(res), mode);
}

/**
 * A font size (points) that sets `lines` lines of text about as tall as the
 * handwriting they replace.
 */
export function fittingFontSize(heightEmu, lines = 1) {
  const pt = heightEmu / 12700 / Math.max(1, lines) / 1.25;
  return Math.max(10, Math.min(96, Math.round(pt)));
}
