// The pens on the Draw tab: a collection the user adds to, changes, puts in
// order and removes from, kept on this device between sessions.
//
// A pen is { id, type, color, width, texture }:
//   type     "pen" | "pencil" | "highlighter"
//   width    the tip in millimetres
//   texture  "solid" | "graphite" (a pencil's grain) | "dotted"

const KEY = "presentation.drawPens.v1";
export const MAX_PENS = 12;
export const PEN_TYPES = {
  pen: {
    label: "Pen",
    widths: [0.25, 0.5, 1, 2, 3.5],
    textures: ["solid", "dotted"],
    defaults: { color: "#000000", width: 1, texture: "solid" },
  },
  pencil: {
    label: "Pencil",
    widths: [0.5, 1, 2, 3.5, 5],
    textures: ["graphite", "solid"],
    defaults: { color: "#595959", width: 1, texture: "graphite" },
  },
  highlighter: {
    label: "Highlighter",
    widths: [2, 4, 6, 8, 10],
    textures: ["solid"],
    defaults: { color: "#FFFF00", width: 6, texture: "solid" },
  },
};
export const TEXTURE_LABELS = {
  solid: "Solid",
  graphite: "Graphite",
  dotted: "Dotted",
};
// Defaults the Draw tab starts with. Their ids stay fixed so a saved set
// and the tab's commands keep pointing at the same pens.
export const DEFAULT_PENS = [
  { id: "pen1", type: "pen", color: "#000000", width: 1, texture: "solid" },
  { id: "pen2", type: "pen", color: "#E81224", width: 1, texture: "solid" },
  {
    id: "pen3",
    type: "pencil",
    color: "#595959",
    width: 1,
    texture: "graphite",
  },
  {
    id: "highlighter",
    type: "highlighter",
    color: "#FFFF00",
    width: 6,
    texture: "solid",
  },
];
const COLOR_NAMES = {
  "#000000": "Black",
  "#FFFFFF": "White",
  "#E81224": "Red",
  "#0063B1": "Blue",
  "#595959": "Graphite",
  "#FFFF00": "Yellow",
  "#00B050": "Green",
  "#FF8C00": "Orange",
  "#8E44AD": "Purple",
  "#FF66CC": "Pink",
};
const HEX = /^#[0-9A-F]{6}$/;

/** A pen as stored, made whole and safe: unknown types, colours or sizes
 * fall back to the type's defaults. */
export function normalizePen(raw, id = null) {
  const type = PEN_TYPES[raw?.type] ? raw.type : "pen";
  const spec = PEN_TYPES[type];
  const color = String(raw?.color || "").toUpperCase();
  const width = Number(raw?.width);
  return {
    id: String(
      raw?.id || id || `pen-${Math.random().toString(36).slice(2, 8)}`,
    ),
    type,
    color: HEX.test(color) ? color : spec.defaults.color,
    width:
      Number.isFinite(width) && width > 0 && width <= 20
        ? width
        : spec.defaults.width,
    texture: spec.textures.includes(raw?.texture)
      ? raw.texture
      : spec.defaults.texture,
  };
}

/** What a pen is called: "Pen: Red, 1 mm". */
export function penLabel(pen) {
  const name = COLOR_NAMES[pen.color] || pen.color;
  const texture =
    pen.texture !== PEN_TYPES[pen.type].defaults.texture
      ? `, ${TEXTURE_LABELS[pen.texture].toLowerCase()}`
      : "";
  return `${PEN_TYPES[pen.type].label}: ${name}, ${pen.width} mm${texture}`;
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** The saved pens, or the defaults. */
export function loadPens(store = storage()) {
  try {
    const saved = JSON.parse(store?.getItem(KEY) || "null");
    if (Array.isArray(saved) && saved.length) {
      const seen = new Set();
      const pens = [];
      for (const raw of saved.slice(0, MAX_PENS)) {
        const pen = normalizePen(raw);
        if (seen.has(pen.id)) continue;
        seen.add(pen.id);
        pens.push(pen);
      }
      if (pens.length) return pens;
    }
  } catch {}
  return DEFAULT_PENS.map((p) => ({ ...p }));
}
export function savePens(pens, store = storage()) {
  try {
    store?.setItem(KEY, JSON.stringify(pens));
  } catch {}
}
export function resetPens(store = storage()) {
  try {
    store?.removeItem(KEY);
  } catch {}
  return DEFAULT_PENS.map((p) => ({ ...p }));
}

/** A new pen of `type` added at the end; null when the set is full. */
export function addPen(pens, type, overrides = {}) {
  if (pens.length >= MAX_PENS) return null;
  let n = pens.length + 1;
  while (pens.some((p) => p.id === `pen-${n}`)) n++;
  const pen = normalizePen({
    ...PEN_TYPES[type]?.defaults,
    ...overrides,
    type,
    id: `pen-${n}`,
  });
  pens.push(pen);
  return pen;
}
export function removePen(pens, id) {
  const i = pens.findIndex((p) => p.id === id);
  if (i < 0 || pens.length <= 1) return false;
  pens.splice(i, 1);
  return true;
}
/** Moves a pen `delta` places along the row; false when it cannot go. */
export function movePen(pens, id, delta) {
  const i = pens.findIndex((p) => p.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= pens.length) return false;
  const [pen] = pens.splice(i, 1);
  pens.splice(j, 0, pen);
  return true;
}
