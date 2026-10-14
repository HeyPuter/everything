/**
 * Ink in the document: where ink drawings are laid out, where new ink is anchored, and the editor
 * transactions that add, replace and remove ink drawings. Strokes here are in page pixels; the
 * DrawingML is written by engine/docx-ink.js and read back through the same reader opened files use.
 *
 * Each stroke drawn is committed on its own (one undo step per stroke) as a small ink group. When the
 * inking session ends, the session's strokes on each page are gathered into one group per layer
 * (in front of or behind the text) without adding an undo step, so undo still removes one stroke at a
 * time and every saved session is one object other word processors show and move as a unit.
 */
import { readDrawingFragment, nextDrawingOrder, nextDrawingId } from '../engine/inserted-drawings.js';
import { decodeImages, inlineImagePaintFrame, isPositionedImage } from '../engine/images.js';
import { inkDrawingXml, readInkDrawingCached, EMU_PER_PX } from '../engine/docx-ink.js';
import { strokeBounds, unionBounds } from '../engine/ink-geometry.js';

const OBJECT = '￼';
const MAX_OFFSET = 20116800;
const INK_ASSET = 'drawing:ink-';
let assetCounter = 0;

/** The ink data of an image, or null for anything that is not editable ink. */
export const inkOf = image => (image?.retainedDrawing && typeof image.shell === 'string' ? readInkDrawingCached(image.shell) : null);

/**
 * Every ink drawing laid out on the body's pages, with its frame in page pixels and its strokes
 * mapped onto the page: [{ image, page, x, y, width, height, ink, strokes, inline }].
 */
export function inkFrames(engine, page = null) {
  const layout = engine?.layout, out = [];
  if (!layout) return out;
  const add = (image, frame, inline) => {
    const ink = inkOf(image);
    if (!ink || page !== null && frame.page !== page) return;
    const sx = frame.width / ink.width, sy = frame.height / ink.height;
    out.push({ image, page: frame.page, x: frame.x, y: frame.y, width: frame.width, height: frame.height, ink, inline,
      strokes: ink.strokes.map(s => ({ ...s, width: s.width * Math.min(sx, sy), points: s.points.map(p => ({ x: frame.x + p.x * sx, y: frame.y + p.y * sy, p: p.p })) })) });
  };
  for (const f of layout.floatingObjects || []) if (!f.pageStory) add(f.image, f, false);
  for (const line of layout.lines || []) for (const f of line.fragments || []) if (f.image && !isPositionedImage(f.image) && !line.pageStory)
    add(f.image, { page: line.page, ...inlineImagePaintFrame(f.image, f.uprightImage?.x ?? f.x, f.uprightImage?.y ?? line.baseline - f.ascent) }, true);
  return out;
}

/** Text offset of the run holding `image` in the model, or -1. */
export function imageOffset(model, image) {
  let at = 0;
  for (const p of model.paragraphs) {
    for (const run of p.runs) { if (run.image === image) return at; at += run.text.length; }
    at++;
  }
  return -1;
}

/**
 * Where ink at `bounds` on `page` is anchored: the last body paragraph that starts on that page at or
 * above the ink (else the page's first), with a paragraph-relative vertical offset so the ink moves
 * with its text. Returns { paragraphId, anchor } or null when no paragraph starts on the page.
 */
export function inkAnchor(engine, page, bounds, { behind = false, order = 1 } = {}) {
  const lines = engine.layout.lines || [], first = new Map();
  for (const line of lines) if (line.paragraphId != null && !first.has(line.paragraphId)) first.set(line.paragraphId, line);
  const starts = [...first.values()].filter(line => line.page === page && !line.cellId && !line.pageStory && !line.header);
  if (!starts.length) return null;
  const top = line => line.y - (line.anchorBefore || 0);
  const above = starts.filter(line => top(line) <= bounds.top + 0.5);
  const line = above.length ? above.reduce((a, b) => (top(b) >= top(a) ? b : a)) : starts.reduce((a, b) => (top(b) < top(a) ? b : a));
  const clampOffset = v => Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(v)));
  return { paragraphId: line.paragraphId, anchor: { horizontal: 'page', vertical: 'paragraph', x: clampOffset(bounds.left * EMU_PER_PX), y: clampOffset((bounds.top - top(line)) * EMU_PER_PX), wrap: 'none', behind, order } };
}

/** A frame around strokes (page pixels), with a pixel of room, and the strokes moved into it. */
export function frameStrokes(strokes) {
  const b = unionBounds(strokes.map(strokeBounds));
  const left = Math.floor(b.left) - 1, top = Math.floor(b.top) - 1;
  const width = Math.max(2, Math.ceil(b.right) + 1 - left), height = Math.max(2, Math.ceil(b.bottom) + 1 - top);
  return { left, top, width, height, right: left + width, bottom: top + height, strokes: strokes.map(s => ({ ...s, points: s.points.map(p => ({ x: p.x - left, y: p.y - top, p: p.p })) })) };
}

const clampTo = (frame, strokes) => strokes.map(s => ({ ...s, points: s.points.map(p => ({ x: Math.max(0, Math.min(frame.width, p.x)), y: Math.max(0, Math.min(frame.height, p.y)), p: p.p })) }));

/**
 * Applies ink changes to the document in one editor transaction. Operations:
 *   { add: strokes, page, behind }             new floating ink from page-pixel strokes
 *   { add: strokes, canvas: true, width, height } a new inline drawing canvas at the caret
 *   { replace: image, strokes }                 the drawing's strokes become these (page pixels)
 *   { remove: image }
 *   { addXml(id, anchor), page, bounds }       another drawing anchored like ink (recognised shapes)
 * `record: false` folds the change into the current undo step. Returns whether it applied.
 */
export function createInkCommitter({ editor, pkg, onApplied = () => {}, onError = () => {} }) {
  let queue = Promise.resolve();
  const ownAssets = new Set();

  async function build(engine, op, index) {
    const model = engine.model;
    // Drawing ids are written into the saved frame, so each new drawing takes the next unused one.
    const id = op.replace ? op.replace.id : nextDrawingId(model) + index;
    const assetId = `${INK_ASSET}${Date.now().toString(36)}-${++assetCounter}`;
    let xml, paragraphId = null;
    if (op.addXml) {
      // Another drawing (a recognised shape) placed like ink: anchored to the paragraph under it.
      const placed = inkAnchor(engine, op.page, op.bounds, { behind: false, order: nextDrawingOrder(model) + index });
      if (!placed) throw new Error('Shapes need a paragraph that starts on this page. Add a paragraph here first.');
      paragraphId = placed.paragraphId;
      xml = op.addXml(id, placed.anchor);
    } else if (op.add && op.canvas) {
      xml = inkDrawingXml({ id, strokes: [], width: op.width, height: op.height, canvas: true });
    } else if (op.add) {
      const frame = frameStrokes(op.add);
      const placed = inkAnchor(engine, op.page, frame, { behind: !!op.behind, order: nextDrawingOrder(model) + index });
      if (!placed) throw new Error('Ink needs a paragraph that starts on this page. Add a paragraph here first.');
      paragraphId = placed.paragraphId;
      xml = inkDrawingXml({ id, strokes: frame.strokes, width: frame.width, height: frame.height, anchor: placed.anchor });
    } else if (op.replace) {
      const current = inkFrames(engine).find(f => f.image === op.replace);
      if (!current) throw new Error('The ink changed before it could be edited. Try again.');
      if (current.inline || current.ink.canvas) {
        // A canvas keeps its frame; its strokes are clipped to it.
        const sx = current.ink.width / current.width, sy = current.ink.height / current.height;
        const local = op.strokes.map(s => ({ ...s, width: s.width * Math.max(sx, sy), points: s.points.map(p => ({ x: (p.x - current.x) * sx, y: (p.y - current.y) * sy, p: p.p })) }));
        const frame = { width: current.ink.width, height: current.ink.height };
        xml = inkDrawingXml({ id, name: op.replace.name, strokes: clampTo(frame, local), width: frame.width, height: frame.height, canvas: current.ink.canvas, anchor: current.inline ? null : op.replace.anchor });
      } else {
        const frame = frameStrokes(op.strokes), a = op.replace.anchor;
        const dx = (frame.left - current.x) * EMU_PER_PX, dy = (frame.top - current.y) * EMU_PER_PX;
        const anchor = { ...a };
        delete anchor.xAlign; delete anchor.yAlign; delete anchor.xPercentage; delete anchor.yPercentage;
        if (a.xAlign || a.xPercentage !== undefined) Object.assign(anchor, { horizontal: 'page', x: frame.left * EMU_PER_PX }); else anchor.x = (a.x || 0) + dx;
        if (a.yAlign || a.yPercentage !== undefined) Object.assign(anchor, { vertical: 'page', y: frame.top * EMU_PER_PX }); else anchor.y = (a.y || 0) + dy;
        anchor.x = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(anchor.x))); anchor.y = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(anchor.y)));
        xml = inkDrawingXml({ id, name: op.replace.name, strokes: frame.strokes, width: frame.width, height: frame.height, anchor });
      }
    } else return { op };
    const fragment = await readDrawingFragment(xml, { sourceParts: pkg()?.parts || {}, assetId });
    const bitmaps = await decodeImages(fragment.assets, model.styles.fontAlternatives, () => {});
    return { op, fragment, bitmaps, paragraphId };
  }

  /** The text offset of a paragraph's start, by id, in the current model. */
  const paragraphStart = (model, id) => { const index = model.paragraphs.findIndex(p => p.id === id); return index < 0 ? -1 : model.paragraphOffset(index); };

  async function run(ops, { record = true } = {}) {
    const engine = editor(); if (!engine || pkg()?.readOnly) return false;
    if (engine.session.path !== null) engine.editStory(null);
    engine.finishComposition();
    const revision = engine.session.revision, model = engine.model;
    const built = [];
    try { for (const [i, op] of ops.entries()) built.push(await build(engine, op, i)); }
    catch (e) { for (const b of built) for (const bitmap of b.bitmaps?.values() || []) bitmap.close?.(); throw e; }
    const release = () => { for (const b of built) for (const bitmap of b.bitmaps?.values() || []) bitmap.close?.(); };
    if (engine.destroyed || engine !== editor() || engine.model !== model || revision !== engine.session.revision) { release(); return 'stale'; }
    for (const b of built) if (b.fragment) for (const [id, asset] of Object.entries(b.fragment.assets)) { model.assets[id] = asset; engine.images.set(id, b.bitmaps.get(id)); ownAssets.add(id); }
    const { scrollTop, scrollLeft } = engine.host;
    let failure = null;
    const ok = engine.execute(() => {
      let caret = model.selection.focus, anchorCaret = model.selection.anchor;
      const shift = (at, delta) => { if (at < caret || at === caret && delta > 0) caret += delta; if (at < anchorCaret || at === anchorCaret && delta > 0) anchorCaret += delta; };
      // Removals first, from the end of the text, then replacements, then insertions.
      const removals = built.filter(b => b.op.remove).map(b => ({ b, at: imageOffset(model, b.op.remove) })).filter(r => r.at >= 0).sort((a, b) => b.at - a.at);
      for (const { at } of removals) { model.select(at, at + 1); model.replace('', { checkpoint: false }); shift(at, -1); }
      let changed = removals.length > 0;
      for (const b of built.filter(b => b.op.replace)) {
        const { assetId, id: _id, ...props } = b.fragment.image, old = b.op.replace;
        const next = { ...props, assetId, id: old.id };
        let found = false;
        for (const p of model.paragraphs) for (const r of p.runs) if (r.image === old) { r.image = next; found = true; }
        if (found) changed = true;
      }
      for (const b of built.filter(b => b.op.add || b.op.addXml)) {
        const at = b.paragraphId != null ? paragraphStart(model, b.paragraphId) : caret;
        if (at < 0) throw new Error('The paragraph under the ink is gone. Try again.');
        const { assetId, id: _id, ...props } = b.fragment.image;
        model.select(at, at); model.insertImage(assetId, props); shift(at, 1); changed = true;
        b.inserted = at;
      }
      if (!changed) return false;
      model.didChange();
      const length = model.text.length;
      model.select(Math.max(0, Math.min(length, anchorCaret)), Math.max(0, Math.min(length, caret)));
      return true;
    }, e => { failure = e; }, { record }, true);
    engine.host.scrollTop = scrollTop; engine.host.scrollLeft = scrollLeft;
    if (!ok) {
      for (const b of built) if (b.fragment) for (const id of Object.keys(b.fragment.assets)) { delete model.assets[id]; engine.images.get(id)?.close?.(); engine.images.delete(id); ownAssets.delete(id); }
      if (failure) throw failure;
      return false;
    }
    engine.syncInput(); engine.paint();
    prune(engine);
    onApplied(built);
    return built;
  }

  /** Forget ink assets no story, undo step or redo step refers to any more (their pixels are freed too). */
  function prune(engine) {
    const used = new Set();
    const collect = paragraphs => { for (const p of paragraphs || []) for (const r of p.runs || []) if (r.image?.assetId) used.add(r.image.assetId); };
    for (const m of engine.session.models.values()) collect(m.paragraphs);
    for (const entry of [...engine.session.history, ...engine.session.future]) collect(entry.state?.paragraphs);
    for (const id of [...ownAssets]) if (!used.has(id)) {
      delete engine.model.assets[id]; engine.images.get(id)?.close?.(); engine.images.delete(id); ownAssets.delete(id);
    }
  }

  /** Queue a change after any in flight; a change made stale by typing is rebuilt once. */
  function commit(ops, options) {
    const next = queue.then(async () => {
      let result = await run(typeof ops === 'function' ? ops() : ops, options);
      if (result === 'stale') result = await run(typeof ops === 'function' ? ops() : ops, options);
      return result === 'stale' ? false : result;
    }).catch(e => { onError(e); return false; });
    queue = next.then(() => {}, () => {});
    return next;
  }
  return { commit, idle: () => queue, ownAssets };
}
