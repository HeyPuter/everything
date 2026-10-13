/**
 * Expand Image: extend a placed image past its edges.
 *
 *  - Object > Generative > Expand Image > Make Frame puts a dashed frame
 *    around the selected image; resize it, then Fill Frame extends the
 *    image to it (Expand By... takes margins in a dialog instead)
 *  - Fill Bleed extends an image that reaches the artboard edges out to
 *    the document bleed, so it prints to the trimmed edge
 *
 * With Puter AI (signed in, online) the new areas are generated: the
 * padded image and a mask of the new areas go to puter.ai.txt2img as
 * input images and only the masked margins of the answer are kept. Without
 * it, or when chosen, the image is extended on this device (outpaint.js:
 * a mirror fill refined by patch search). The image object keeps its
 * place and transform; the asset is replaced in one undo step.
 */
import { UserError } from '../../lib/errors.js';
import { uid } from '../../lib/ids.js';
import { multiply, translate, invert, apply } from '../../lib/matrix.js';
import { createPath } from '../../model/nodes.js';
import { rectangle } from '../../model/shapes.js';
import { nodeBounds } from '../../model/geometry.js';
import { assetPixels, resample } from '../trace/trace-runner.js';
import { encodePixels } from '../trace/image-ops.js';
import { selectedImages, withTraceProgress } from '../trace/trace-commands.js';
import { aiStatus, requireAI, abortable, isAbort, aiErrorMessage, AIError } from '../generative/ai.js';
import { decodeImage } from '../generative/vectorize.js';
import { localFill, composeExpansion, blendExpansion, cleanMargins } from './outpaint.js';

/** Largest side of an expanded image, in pixels. */
export const MAX_SIDE = 8192;
/** Largest side sent to the AI. */
const AI_SIDE = 1024;

/** Test hooks: decode(result) -> pixels for what txt2img returned. */
export const expandHooks = { decode: null };

const isFrame = (n) => Boolean(n?.expandFrame);

/**
 * Margins that grow an image object to cover a document rectangle:
 * { local: { left, top, right, bottom } (image units), pixels: margins in
 * natural pixels } or null when the image already covers it.
 */
export function marginsFor(node, natural, rect) {
  const inv = invert(node.transform || [1, 0, 0, 1, 0, 0]);
  const pts = [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x + rect.w, rect.y + rect.h],
    [rect.x, rect.y + rect.h],
  ].map(([x, y]) => apply(inv, x, y));
  const minX = Math.min(0, ...pts.map((p) => p.x));
  const minY = Math.min(0, ...pts.map((p) => p.y));
  const maxX = Math.max(node.width, ...pts.map((p) => p.x));
  const maxY = Math.max(node.height, ...pts.map((p) => p.y));
  return localMargins(node, natural, { left: -minX, top: -minY, right: maxX - node.width, bottom: maxY - node.height });
}

/** Margins in image units ({ left, top, right, bottom }) as whole natural pixels, or null when empty. */
export function localMargins(node, natural, m) {
  const sx = natural.width / node.width;
  const sy = natural.height / node.height;
  const pixels = cleanMargins({ left: m.left * sx, top: m.top * sy, right: m.right * sx, bottom: m.bottom * sy });
  if (!pixels.left && !pixels.top && !pixels.right && !pixels.bottom) return null;
  // Local margins follow the whole pixels, so the image keeps its pixel density.
  return { pixels, local: { left: pixels.left / sx, top: pixels.top / sy, right: pixels.right / sx, bottom: pixels.bottom / sy } };
}

/**
 * The bleed rectangle an image should reach: the sides of the image that
 * touch (or cross) its artboard's edges move out to the bleed. Throws a
 * readable error when there is nothing to fill.
 */
export function bleedTarget(doc, node) {
  const b = nodeBounds(doc, node);
  const boards = doc.artboards || [];
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const ab = boards.find((a) => cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h) || boards[0];
  if (!ab) throw new UserError('The document has no artboard.');
  const bl = doc.root.bleed || {};
  const bleed = { top: bl.top || 0, right: bl.right || 0, bottom: bl.bottom || 0, left: bl.left || 0 };
  if (!bleed.top && !bleed.right && !bleed.bottom && !bleed.left) throw new UserError('The document has no bleed. Set one in File > Document Setup, then try again.');
  const eps = 0.5;
  const r = { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
  if (b.x <= ab.x + eps) r.x0 = Math.min(r.x0, ab.x - bleed.left);
  if (b.y <= ab.y + eps) r.y0 = Math.min(r.y0, ab.y - bleed.top);
  if (b.x + b.w >= ab.x + ab.w - eps) r.x1 = Math.max(r.x1, ab.x + ab.w + bleed.right);
  if (b.y + b.h >= ab.y + ab.h - eps) r.y1 = Math.max(r.y1, ab.y + ab.h + bleed.bottom);
  const out = { x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 };
  if (Math.abs(out.x - b.x) < 1e-6 && Math.abs(out.y - b.y) < 1e-6 && Math.abs(out.w - b.w) < 1e-6 && Math.abs(out.h - b.h) < 1e-6) {
    throw new UserError('The image does not reach an artboard edge (or already covers the bleed), so there is no bleed to fill.');
  }
  return out;
}

/** The text that goes with the padded image and mask. */
export function expandPrompt(prompt) {
  const what = String(prompt || '').trim() || 'a natural continuation of the picture';
  return (
    'The first input image is a picture on a larger canvas with gray margins; the second input image marks those margins in white. ' +
    `Paint the white areas to extend the picture outward with ${what}. ` +
    'Leave the area that is black in the mask unchanged. Continue lines, horizon, perspective, lighting, colors, focus and grain seamlessly. ' +
    'Return the whole picture at the same aspect ratio and framing.'
  );
}

/** Generated margins from Puter AI, blended over a local fill. */
async function aiExpansion(client, px, by, prompt, { signal, onProgress }) {
  const { image, mask } = composeExpansion(px, by);
  const s = Math.min(1, AI_SIDE / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * s));
  const h = Math.max(1, Math.round(image.height * s));
  const [imgUri, maskUri] = await Promise.all([encodePixels(s < 1 ? resample(image, w, h) : image, 'image/png'), encodePixels(s < 1 ? resample(mask, w, h) : mask, 'image/png')]);
  onProgress?.(0.15);
  let result;
  try {
    result = await abortable(Promise.resolve().then(() => client.txt2img(expandPrompt(prompt), { input_images: [imgUri, maskUri], ratio: { w, h } })), signal);
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new AIError(aiErrorMessage(err));
  }
  onProgress?.(0.7);
  const gen = expandHooks.decode ? await expandHooks.decode(result) : await decodeImage(result);
  // Under the fade at the seam the image's own continuation shows.
  const base = await localFill(px, by, { signal });
  if (!base) return null;
  onProgress?.(0.95);
  return blendExpansion(base, gen, px, by);
}

/**
 * Extend an image object: `target` is { rect } (a document rectangle to
 * cover) or { margins } (image units along its own sides). method: 'ai' |
 * 'local'. Resolves to the image id, or null when cancelled or when the
 * image changed meanwhile.
 */
export async function expandImageTo(app, imageId, target, { method = 'local', prompt = '', signal = null, onProgress = null, client = null, label = 'Expand Image' } = {}) {
  const doc = app.editor.doc;
  const node0 = doc.get(imageId);
  if (!node0 || node0.type !== 'image') throw new UserError('Select a placed image.');
  const full = await assetPixels(doc, node0.asset, null);
  const natural = { width: full.width, height: full.height };
  const mg = target.margins ? localMargins(node0, natural, target.margins) : marginsFor(node0, natural, target.rect);
  if (!mg) throw new UserError('The image already covers that area.');
  const W = full.width + mg.pixels.left + mg.pixels.right;
  const H = full.height + mg.pixels.top + mg.pixels.bottom;
  if (W > MAX_SIDE || H > MAX_SIDE) throw new UserError(`The expanded image would be ${W} x ${H} pixels; the limit is ${MAX_SIDE} on each side. Expand by less.`);
  const px = { width: full.width, height: full.height, data: full.data };
  const big = method === 'ai' ? await aiExpansion(client, px, mg.pixels, prompt, { signal, onProgress }) : await localFill(px, mg.pixels, { signal, onProgress });
  if (!big || signal?.aborted) return null;
  const data = await encodePixels(big, 'image/png');
  const node = doc.get(imageId);
  if (!node || node.asset !== node0.asset) return null;
  const old = doc.assets.get(node0.asset);
  const id = uid('img');
  doc.assets.set(id, { mime: 'image/png', data, name: old?.name || '' });
  doc.transact(label, () => {
    doc.update(imageId, {
      asset: id,
      width: node.width + mg.local.left + mg.local.right,
      height: node.height + mg.local.top + mg.local.bottom,
      transform: multiply(node.transform || [1, 0, 0, 1, 0, 0], translate(-mg.local.left, -mg.local.top)),
    });
  });
  return imageId;
}

// ---- UI ----

/** Options for an expansion: { method, prompt, by? } from a dialog, or null when cancelled. */
export async function expandDialog(app, { title, margins = false } = {}) {
  const prev = app.prefs?.get?.('expandImage') || {};
  const st = aiStatus(app);
  const aiOk = st.ok || st.reason === 'signedOut';
  const fields = [];
  if (margins) {
    const m = prev.by || {};
    fields.push(
      { key: 'top', type: 'length', label: 'Top', value: m.top ?? 36, min: 0 },
      { key: 'bottom', type: 'length', label: 'Bottom', value: m.bottom ?? 36, min: 0 },
      { key: 'left', type: 'length', label: 'Left', value: m.left ?? 36, min: 0 },
      { key: 'right', type: 'length', label: 'Right', value: m.right ?? 36, min: 0 },
    );
  }
  if (aiOk) {
    fields.push(
      {
        key: 'method',
        type: 'radio',
        label: 'Fill new areas',
        value: prev.method === 'local' ? 'local' : 'ai',
        options: [
          { value: 'ai', label: 'Generate with Puter AI' },
          { value: 'local', label: 'Continue the edges on this device' },
        ],
      },
      { key: 'prompt', type: 'text', label: 'Describe what to add (optional)', value: '' },
    );
  }
  const description = aiOk
    ? 'Puter AI paints the new areas to continue the picture; the original pixels stay as they are. On this device the edges are mirrored and refined with matching patches of the image.'
    : `${st.message} The image is extended on this device instead: its edges are mirrored and refined with matching patches of the image.`;
  const v = await app.dialogs.form({ title, description, okLabel: 'Expand', fields });
  if (!v) return null;
  const out = { method: aiOk ? v.method || 'ai' : 'local', prompt: v.prompt || '' };
  if (margins) out.by = { top: v.top || 0, bottom: v.bottom || 0, left: v.left || 0, right: v.right || 0 };
  app.prefs?.set?.('expandImage', { method: out.method, by: out.by || prev.by });
  return out;
}

/** Run an expansion with progress, Puter AI first when chosen (offering the local fill if it fails). */
async function runExpansion(app, imageId, target, opts, label) {
  let client = null;
  if (opts.method === 'ai') {
    client = await requireAI(app);
    if (!client) return null;
  }
  const run = (method) =>
    withTraceProgress(app, method === 'ai' ? 'Generating the new areas' : 'Extending the image', (onProgress, signal) => expandImageTo(app, imageId, target, { ...opts, method, client, onProgress, signal, label }), { delay: 0 });
  try {
    return await run(opts.method);
  } catch (err) {
    if (opts.method !== 'ai' || !(err instanceof AIError)) throw err;
    const ok = await app.dialogs.confirm({ title: 'Expand Image', message: `${err.message} Extend the image on this device instead?`, okLabel: 'Extend Here' });
    return ok ? run('local') : null;
  }
}

function singleImage(editor) {
  const imgs = selectedImages(editor);
  return imgs.length === 1 && !editor.doc.isLocked(imgs[0].id) ? imgs[0] : null;
}

/** The image and frame Fill Frame works with: { image, frame, rect } or null. */
export function frameTargets(editor) {
  if (!editor) return null;
  const doc = editor.doc;
  const top = editor.topSelection().map((id) => doc.get(id)).filter(Boolean);
  const frame = top.find((n) => isFrame(n)) || top.find((n) => n.type === 'path' && n.closed && top.some((k) => k.type === 'image'));
  if (!frame) return null;
  const image = top.find((n) => n.type === 'image') || (isFrame(frame) ? doc.get(frame.expandFrame) : null);
  if (!image || image.type !== 'image' || doc.isLocked(image.id)) return null;
  const a = nodeBounds(doc, frame);
  const b = nodeBounds(doc, image);
  if (!a || !b) return null;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { image, frame, rect: { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y } };
}

/** Make Frame: a dashed frame a little larger than the selected image, selected for resizing. */
export function makeFrame(app) {
  const ed = app.editor;
  const img = singleImage(ed);
  if (!img) throw new UserError('Select one placed image.');
  const doc = ed.doc;
  const b = nodeBounds(doc, img);
  const pad = Math.max(b.w, b.h) * 0.1;
  const frame = createPath(rectangle(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad), true, { fill: null, stroke: { type: 'solid', color: '#2563eb' }, strokeWidth: 1, dash: [4, 3] }, { name: 'Expand Frame', expandFrame: img.id });
  doc.transact('Make Expand Frame', () => {
    const parent = doc.get(img.parent);
    doc.insert(frame, parent.id, parent.children.indexOf(img.id) + 1);
  });
  ed.select([frame.id]);
  app.notify('Resize the frame to the area to fill, then choose Expand Image > Fill Frame.', { polite: true });
  return frame.id;
}

/** Fill Frame: extend the image to the frame (the frame is removed afterwards). */
export async function fillFrame(app) {
  const ed = app.editor;
  const t = frameTargets(ed);
  if (!t) throw new UserError('Select an expand frame (or a placed image and a rectangle around it).');
  const opts = await expandDialog(app, { title: 'Fill Frame' });
  if (!opts) return null;
  const id = await runExpansion(app, t.image.id, { rect: t.rect }, opts, 'Expand Image');
  if (!id) return null;
  if (isFrame(t.frame) && ed.doc.has(t.frame.id)) ed.doc.transact('Remove Expand Frame', () => ed.doc.remove(t.frame.id));
  ed.select([id]);
  return id;
}

/** Expand By: margins from the dialog. */
export async function expandBy(app) {
  const ed = app.editor;
  const img = singleImage(ed);
  if (!img) throw new UserError('Select one placed image.');
  const opts = await expandDialog(app, { title: 'Expand Image', margins: true });
  if (!opts) return null;
  const { by } = opts;
  if (!(by.top > 0 || by.bottom > 0 || by.left > 0 || by.right > 0)) return null;
  // Margins are measured along the image's own sides (in points).
  const T = img.transform || [1, 0, 0, 1, 0, 0];
  const sx = Math.hypot(T[0], T[1]) || 1;
  const sy = Math.hypot(T[2], T[3]) || 1;
  const margins = { left: by.left / sx, top: by.top / sy, right: by.right / sx, bottom: by.bottom / sy };
  const id = await runExpansion(app, img.id, { margins }, opts, 'Expand Image');
  if (id) ed.select([id]);
  return id;
}

/** Fill Bleed: extend the image to the document bleed where it reaches the artboard edges. */
export async function fillBleed(app) {
  const ed = app.editor;
  const img = singleImage(ed);
  if (!img) throw new UserError('Select one placed image.');
  const rect = bleedTarget(ed.doc, img);
  const opts = await expandDialog(app, { title: 'Fill Bleed' });
  if (!opts) return null;
  const id = await runExpansion(app, img.id, { rect }, opts, 'Fill Bleed');
  if (id) ed.select([id]);
  return id;
}

export { singleImage };
