// Shared helpers for the Insert features: choosing files, turning drawings
// into PNG bytes, encoding sound, and a few small UI pieces.
import { el } from "../ui.js";

export const EMU_PER_INCH = 914400;
export const EMU_PER_PX = 9525;

/** Opens the file chooser; resolves to the chosen files (maybe none). */
export function pickFiles(accept, { multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = el("input", {
      type: "file",
      accept,
      hidden: true,
      multiple,
    });
    const done = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done([...(input.files || [])]), {
      once: true,
    });
    input.addEventListener("cancel", () => done([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

export const fileBytes = async (file) =>
  new Uint8Array(await file.arrayBuffer());

export function canvasPng(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error("The picture could not be drawn."));
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png"),
  );
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The picture could not be read."));
    image.src = src;
  });
}

export const svgDataUrl = (svg) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** Draws an SVG document to a PNG of the given pixel size. */
export async function svgToPng(svg, width, height) {
  const image = await loadImage(svgDataUrl(svg));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvasPng(canvas);
}

/** A data: URL slide preview (SVG) drawn to a PNG `width` pixels wide. */
export async function previewToPng(src, width, aspect) {
  const image = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width);
  canvas.height = Math.round(width / aspect);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvasPng(canvas);
}

export function bytesUrl(bytes, type) {
  return URL.createObjectURL(new Blob([bytes], { type }));
}

export function downloadBytes(bytes, name, type = "application/octet-stream") {
  const url = bytesUrl(bytes, type);
  const a = el("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** 16-bit PCM WAV from channel data (Float32Arrays). */
export function encodeWav(channels, sampleRate) {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(44 + frames * count * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, s) =>
    [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * count * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * count * 2, true);
  let at = 44;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < count; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      at += 2;
    }
  return bytes;
}

// Short sounds made here for action settings, so nothing is copied from
// another product: each is a few tones with an envelope.
const SOUND_RECIPES = {
  Chime: [
    [880, 0, 0.6],
    [1320, 0.05, 0.6],
  ],
  Click: [[2000, 0, 0.03]],
  Pop: [[600, 0, 0.08]],
  Rise: [[440, 0, 0.35, 880]],
  Fall: [[880, 0, 0.35, 440]],
  Bell: [
    [660, 0, 0.9],
    [990, 0, 0.7],
    [1650, 0, 0.4],
  ],
  Applause: "noise",
};
export const SOUND_NAMES = Object.keys(SOUND_RECIPES);

export function synthesizeSound(name) {
  const rate = 22050;
  const recipe = SOUND_RECIPES[name] ?? SOUND_RECIPES.Chime;
  if (recipe === "noise") {
    const data = new Float32Array(rate * 1.2);
    let seed = 7;
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 16807) % 2147483647;
      const envelope = Math.min(1, i / 2000) * Math.max(0, 1 - i / data.length);
      // Bursts of noise sound like many hands.
      const burst = 0.5 + 0.5 * Math.sin(i / 90) * Math.sin(i / 37);
      data[i] = ((seed / 2147483647) * 2 - 1) * 0.4 * envelope * burst;
    }
    return encodeWav([data], rate);
  }
  const length = Math.max(...recipe.map(([, start, dur]) => start + dur));
  const data = new Float32Array(Math.ceil(rate * length));
  for (const [freq, start, dur, to = freq] of recipe) {
    const from = Math.floor(start * rate);
    const n = Math.floor(dur * rate);
    let phase = 0;
    for (let i = 0; i < n && from + i < data.length; i++) {
      const t = i / n;
      phase += (2 * Math.PI * (freq + (to - freq) * t)) / rate;
      const envelope = Math.min(1, i / 200) * (1 - t) ** 2;
      data[from + i] += Math.sin(phase) * 0.35 * envelope;
    }
  }
  return encodeWav([data], rate);
}

export function formatTime(ms) {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

export function parseTime(text) {
  const parts = String(text).trim().split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  const seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
  return Math.round(seconds * 1000);
}

/** A labelled form row. */
export const fieldRow = (label, control, attrs = {}) =>
  el(
    "label",
    { class: "insert-field", ...attrs },
    el("span", {}, label),
    control,
  );

/** A radio group: options [[value, label]]. */
export function radioGroup(name, options, value, onchange, label) {
  return el(
    "div",
    { class: "insert-radios", role: "radiogroup", "aria-label": label },
    ...options.map(([v, text]) =>
      el(
        "label",
        { class: "insert-radio" },
        el("input", {
          type: "radio",
          name,
          value: v,
          checked: v === value,
          onchange: () => onchange(v),
        }),
        el("span", {}, text),
      ),
    ),
  );
}

export function checkbox(label, checked, onchange, attrs = {}) {
  return el(
    "label",
    { class: "insert-check", ...attrs },
    el("input", {
      type: "checkbox",
      checked,
      onchange: (e) => onchange(e.target.checked),
    }),
    el("span", {}, label),
  );
}
