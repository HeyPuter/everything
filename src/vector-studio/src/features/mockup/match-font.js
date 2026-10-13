/**
 * Match Font: identify the lettering in a placed image or in outlined
 * type with Puter AI vision, suggest the closest fonts the app has, and
 * turn the lettering back into editable type (or restyle selected type).
 *
 * The chosen region of the selection is rendered to a picture (on white,
 * at up to MAX_SIDE pixels) and sent with the question; the answer is
 * JSON describing the text, the typefaces it looks like, its
 * classification, weight, slant and colors (font-match.js ranks the
 * fonts). Nothing is sent until the user asks for a match.
 */
import { UserError } from '../../lib/errors.js';
import { createText, createPath } from '../../model/nodes.js';
import { rectangle } from '../../model/shapes.js';
import { nodeBounds } from '../../model/geometry.js';
import { wholeStylePatch } from '../../model/text-runs.js';
import { drawNode } from '../../render/draw.js';
import { requireAI, askChat, parseJsonReply } from '../generative/ai.js';
import { allFamilies } from '../type/fonts.js';
import { normalizeAnswer, rankFonts } from './font-match.js';

export const MAX_SIDE = 1024;

/** Test and embedding hooks: capture(doc, nodes, rect) -> PNG data URL (or null). */
export const matchFontHooks = { capture: null };

const isShape = (n) => n && (n.type === 'path' || n.type === 'compound');

/** True for objects that can hold lettering to match: placed images and outlined type (paths, compound paths, groups of them). */
export function isMatchSource(doc, n) {
  if (!n || n.hidden) return false;
  if (n.type === 'image' || isShape(n)) return true;
  if (n.type === 'group') return n.children.length > 0 && n.children.every((c) => isMatchSource(doc, doc.get(c)));
  return false;
}

/** The selected objects to read lettering from. */
export function matchSources(editor) {
  if (!editor) return [];
  return editor
    .topSelection()
    .map((id) => editor.doc.get(id))
    .filter((n) => isMatchSource(editor.doc, n));
}

/** Selected type objects a matched font can be applied to. */
export function matchTextTargets(editor) {
  if (!editor) return [];
  return editor
    .topSelection()
    .map((id) => editor.doc.get(id))
    .filter((n) => n?.type === 'text' && !editor.doc.isLocked(n.id));
}

/** Bounds of objects. */
export function boundsOf(doc, nodes) {
  let r = null;
  for (const n of nodes) {
    const b = nodeBounds(doc, n);
    if (!b) continue;
    if (!r) r = { ...b };
    else {
      const x = Math.min(r.x, b.x);
      const y = Math.min(r.y, b.y);
      r = { x, y, w: Math.max(r.x + r.w, b.x + b.w) - x, h: Math.max(r.y + r.h, b.y + b.h) - y };
    }
  }
  return r;
}

/** A rectangle clipped to another, or null when they do not overlap. */
export function clipRect(r, to) {
  if (!r || !to) return r || to || null;
  const x = Math.max(r.x, to.x);
  const y = Math.max(r.y, to.y);
  const x1 = Math.min(r.x + r.w, to.x + to.w);
  const y1 = Math.min(r.y + r.h, to.y + to.h);
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
}

/** Scale (pixels per point) a region is captured at. */
export function captureScale(rect, maxSide = MAX_SIDE) {
  return Math.max(0.25, Math.min(8, maxSide / Math.max(rect.w, rect.h)));
}

/** The region of the objects as a PNG data URL on white, or null. */
export function captureRegion(doc, nodes, rect) {
  if (matchFontHooks.capture) return matchFontHooks.capture(doc, nodes, rect);
  if (typeof document === 'undefined' || !rect) return null;
  const k = captureScale(rect);
  const W = Math.max(1, Math.round(rect.w * k));
  const H = Math.max(1, Math.round(rect.h * k));
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.setTransform(k, 0, 0, k, -rect.x * k, -rect.y * k);
  for (const n of doc.sortByPaintOrder(nodes.map((x) => x.id))) drawNode(ctx, doc, doc.get(n), { viewRect: rect, outline: false, hairline: 1 / k, scale: k });
  try {
    const url = canvas.toDataURL('image/png');
    return typeof url === 'string' && url.startsWith('data:image/png') ? url : null;
  } catch {
    return null;
  }
}

/** The question sent with the picture. */
export function matchPrompt(families) {
  return [
    'Look at the lettering in this image and identify its typeface.',
    'Answer with one JSON object only, no other text, with these keys:',
    '"text": the text exactly as written (use \\n between lines),',
    '"fonts": up to 5 typefaces it is most likely set in, best first, as [{"name": string, "confidence": 0 to 1}],',
    `"closest": up to 3 names from this list that look most like it: ${families.join(', ')},`,
    '"category": one of "serif", "sans-serif", "display", "handwriting", "monospace",',
    '"traits": design traits such as "geometric", "humanist", "grotesque", "condensed", "wide", "slab", "didone", "oldstyle", "transitional", "rounded", "script", "brush", "marker", "caps",',
    '"weight": 100 to 900, "italic": true or false,',
    '"color": the text color as "#rrggbb", "background": the color around the text as "#rrggbb".',
    'If there is no readable lettering, answer {"text": "", "fonts": []}.',
  ].join('\n');
}

/**
 * Identify the lettering in `rect` of `nodes`. Resolves to { answer,
 * suggestions } (see font-match.js), or null when sign-in was declined.
 */
export async function identifyFont(app, { nodes, rect, signal = null }) {
  if (!nodes?.length || !rect) throw new UserError('Select a placed image or outlined type with lettering.');
  const client = await requireAI(app);
  if (!client) return null;
  const image = captureRegion(app.editor.doc, nodes, rect);
  if (!image) throw new UserError('The selection could not be captured as a picture.');
  const families = allFamilies();
  const reply = await askChat(client, matchPrompt(families.map((f) => f.family)), { signal, image });
  const answer = normalizeAnswer(parseJsonReply(reply, 'object'));
  if (!answer.text && !answer.fonts.length) throw new UserError('No readable lettering was found there. Draw the region closer around the text and try again.');
  return { answer, suggestions: rankFonts(answer, families) };
}

/**
 * Replace the lettering with editable type in `font` ({ family, weight,
 * style }), fitted to `rect` (inside a transaction). Outlined sources the
 * region covers are removed; for images, `cover` puts a rectangle of the
 * background color over the old lettering. Returns the new text's id.
 */
export function placeMatchedText(doc, { sources, rect, text, font, answer = {}, cover = true, parentId, index = Infinity }) {
  const value = String(text || '').trim();
  if (!value) throw new UserError('Enter the text to set.');
  const lines = value.split('\n').length;
  const color = answer.color || outlinedColor(doc, sources) || '#000000';
  let at = index;
  const inside = (n) => {
    const b = nodeBounds(doc, n);
    return b && b.x >= rect.x - 0.5 && b.y >= rect.y - 0.5 && b.x + b.w <= rect.x + rect.w + 0.5 && b.y + b.h <= rect.y + rect.h + 0.5;
  };
  for (const n of sources) {
    if (n.type === 'image') {
      if (!cover) continue;
      const r = createPath(rectangle(rect.x, rect.y, rect.w, rect.h), true, { fill: { type: 'solid', color: answer.background || '#ffffff' }, stroke: null, strokeWidth: 0 }, { name: 'Cover' });
      doc.insert(r, parentId, at++);
    } else if (inside(n)) {
      const p = doc.get(n.parent)?.children.indexOf(n.id) ?? -1;
      if (n.parent === parentId && p >= 0 && p < at) at--;
      doc.remove(n.id);
    }
  }
  const size0 = Math.max(1, (rect.h / lines) * 0.8);
  const t = createText(value, rect.x, rect.y + size0, {
    name: 'Matched Text',
    fill: { type: 'solid', color },
  });
  t.char = { ...t.char, fontFamily: font.family, fontWeight: font.weight || 400, fontStyle: font.style || 'normal', fontSize: size0 };
  doc.insert(t, parentId, at);
  // Fit the type's height to the region, then line its bounds up with it.
  let b = nodeBounds(doc, doc.get(t.id));
  if (b && b.h > 0) {
    const size = Math.max(1, Math.min(2000, size0 * (rect.h / b.h)));
    const n = doc.get(t.id);
    doc.update(t.id, { char: { ...n.char, fontSize: size }, y: rect.y + size * 0.8 });
    b = nodeBounds(doc, doc.get(t.id));
  }
  if (b) {
    const n = doc.get(t.id);
    doc.update(t.id, { x: n.x + (rect.x - b.x), y: n.y + (rect.y - b.y) });
  }
  return t.id;
}

/** The fill color of outlined type, or null. */
function outlinedColor(doc, sources) {
  for (const n of sources) {
    let k = n;
    while (k?.type === 'group') k = doc.get(k.children[0]);
    if (k?.fill?.type === 'solid') return k.fill.color;
    if (k?.type === 'compound') {
      const c = doc.get(k.children[0]);
      if (k.fill?.type === 'solid') return k.fill.color;
      if (c?.fill?.type === 'solid') return c.fill.color;
    }
  }
  return null;
}

/** Set every character of type objects in `font` (inside a transaction). */
export function applyFontTo(doc, ids, font) {
  const patch = { fontFamily: font.family, fontWeight: font.weight || 400, fontStyle: font.style || 'normal' };
  for (const id of ids) {
    const n = doc.get(id);
    if (n?.type === 'text') doc.update(id, wholeStylePatch(n, patch));
  }
}
