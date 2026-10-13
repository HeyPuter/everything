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

export {
  encodeWav,
  synthesizeSound,
  SOUND_NAMES,
  formatTime,
  parseTime,
} from "./audio-data.js";

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
