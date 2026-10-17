/**
 * The Draw tab: write and sketch on the page with pens, pencils and highlighters; erase whole strokes
 * or parts of them; select ink with a lasso to move, delete or convert it; draw against an on-page
 * ruler; turn ink into shapes or (with Puter's AI) into an equation; replay ink in the order it was
 * drawn; hide it; and add a drawing canvas. Ribbon controls come from extraTabs(kit), menu-bar items
 * from extendMenu and right-click items from contextMenuItems.
 *
 * Every change to the document goes through draw-commit.js as one editor transaction: each stroke is
 * one undo step, as is each eraser sweep, lasso move or conversion.
 */
import { el, isComposing, MOD_KEY, shortcutCode, typesCharacter } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { toast } from '../ui/toast.js';
import * as P from '../lib/puter.js';
import { responseText, cleanAnswer } from '../lib/ai.js';
import { sweepHits, eraseFromStroke, lassoContains, translateStroke, pathLength } from '../engine/ink-geometry.js';
import { recognizeStroke, recognizeStrokes } from '../engine/ink-recognizer.js';
import { recognizedShapeXml } from '../engine/ink-shapes.js';
import { createInkCommitter, inkFrames, inkOf } from './draw-commit.js';
import { createDrawSurface } from './draw-surface.js';
import { loadPens, savePens, penLabel, penIconSvg, penWidthPx, openPenSettings, newPen, TOOL_LABELS } from './draw-pens.js';

const PREFS_KEY = 'documents.draw.prefs.v1';
const ERASER_SIZES = { small: 3, medium: 7, large: 14 };
const stored = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; } };
const store = prefs => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage is a convenience */ } };

export function createDraw({ editor, pkg, error, onChange = () => {}, commands = () => ({}) }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly && !engine.viewOnly ? engine : null; };
  const fail = e => { error(e); };
  const prefs = { touch: true, eraser: 'stroke', eraserSize: 'medium', ...stored() };
  const pens = loadPens();
  let tool = 'select', lastPen = pens.pens.find(p => p.id === pens.active) ? pens.active : pens.pens[0].id;
  let inkToShape = false, inkHidden = false, replaying = null, sessionAssets = new Set();
  const hidden = new Set();
  const activePen = () => pens.pens.find(p => p.id === lastPen) || pens.pens[0];
  const refresh = () => { onChange(); };

  /* ---- Hiding ink: the engine skips these drawings when it paints ---- */
  function installHiding(engine) {
    if (!engine || engine.hiddenDrawing === hiddenDrawing) return;
    engine.hiddenDrawing = hiddenDrawing;
  }
  function hiddenDrawing(image) { return hidden.has(image) || (inkHidden || replaying) && !!inkOf(image); }
  const repaint = () => { const engine = editor(); if (engine) { installHiding(engine); engine.paint(); } };

  const committer = createInkCommitter({ editor, pkg, onError: fail, onApplied: () => refresh() });

  /* ---- Surface handlers ---- */
  const surface = createDrawSurface({ editor, handlers: {
    strokeStyle: () => { const pen = activePen(); return { tool: pen.tool, color: pen.color, width: penWidthPx(pen) }; },
    strokeStart: () => { if (inkHidden) toggleInk(false); },
    strokeEnd: (page, stroke) => commitStroke(page, stroke),
    eraseStart: (page, point) => { erasing = { page, frames: inkFrames(editor(), page).filter(f => !hidden.has(f.image)), edited: new Map() }; eraseAlong(point, point); },
    eraseMove: (page, a, b) => eraseAlong(a, b),
    eraseEnd: () => finishErase(),
    lassoStart: () => setSelection(null),
    lassoEnd: (page, polygon) => selectByLasso(page, polygon),
    selectionDrag: (dx, dy) => dragSelection(dx, dy),
    selectionDrop: (dx, dy) => dropSelection(dx, dy),
  } });

  /* ---- Tools ---- */
  function setTool(next, penId = null) {
    const engine = ready();
    if (!engine && next !== 'select') return;
    if (penId) { lastPen = penId; pens.active = penId; savePens(pens); }
    const leavingPen = tool === 'pen' && (next !== 'pen');
    if (next !== 'lasso') setSelection(null);
    tool = next;
    installHiding(engine);
    surface.setMode(next === 'pen' ? 'pen' : next === 'eraser' ? 'eraser' : next === 'lasso' ? 'lasso' : null);
    surface.setEraserRadius(ERASER_SIZES[prefs.eraserSize] || 7);
    hint.update();
    if (leavingPen || next === 'select') endSession();
    refresh();
  }
  /** Toggle Drawing: between the last pen and text editing. */
  function toggleDrawing() {
    if (!ready()) return;
    if (tool === 'select') { setTool('pen'); document.getElementById('ribbon-tab-draw')?.click(); }
    else setTool('select');
    editor()?.focus();
  }

  /* ---- Pen strokes ---- */
  async function commitStroke(page, stroke) {
    const engine = ready();
    if (!engine) { surface.settle(page, stroke); return; }
    try {
      // Ink started inside a drawing canvas stays inside it.
      const canvas = inkFrames(engine, page).find(f => f.ink.canvas && inBox(f, stroke.points[0]));
      if (canvas) stroke = { ...stroke, points: stroke.points.map(p => ({ ...p, x: Math.max(canvas.x, Math.min(canvas.x + canvas.width, p.x)), y: Math.max(canvas.y, Math.min(canvas.y + canvas.height, p.y)) })) };
      if (inkToShape && stroke.tool !== 'highlighter' && !canvas) {
        const shape = recognizeStroke(stroke.points);
        if (shape) { await committer.commit([shapeOp(page, shape, stroke)]); return; }
      }
      const built = await committer.commit([{ add: [stroke], page, behind: stroke.tool === 'highlighter' }]);
      if (built) for (const b of built) if (b.fragment) sessionAssets.add(b.fragment.image.assetId);
    } finally { surface.settle(page, stroke); }
  }
  const inBox = (f, p) => p.x >= f.x && p.x <= f.x + f.width && p.y >= f.y && p.y <= f.y + f.height;
  const shapeOp = (page, shape, style) => {
    const preview = recognizedShapeXml(shape, { id: 1, anchor: null });
    return { page, bounds: preview.bounds, addXml: (id, anchor) => recognizedShapeXml(shape, { id, anchor, color: style.color, widthPx: Math.max(1, style.width) }).xml };
  };

  /**
   * End the inking session: gather the session's strokes on each page into one group per layer, and
   * strokes drawn in a drawing canvas into that canvas. This adds no undo step.
   */
  async function endSession() {
    const assets = sessionAssets; sessionAssets = new Set();
    if (!assets.size) return;
    await committer.commit(() => {
      const engine = editor(); if (!engine) return [];
      const all = inkFrames(engine), session = all.filter(f => assets.has(f.image.assetId) && !f.inline);
      const canvases = all.filter(f => f.ink.canvas), ops = [], groups = new Map(), intoCanvas = new Map();
      for (const f of session) {
        const centre = { x: f.x + f.width / 2, y: f.y + f.height / 2 }, canvas = canvases.find(c => c.page === f.page && inBox(c, centre));
        const key = canvas ? canvas.image : `${f.page}:${!!f.image.anchor?.behind}`, map = canvas ? intoCanvas : groups;
        if (!map.has(key)) map.set(key, []); map.get(key).push(f);
      }
      for (const [image, list] of intoCanvas) {
        const canvas = canvases.find(c => c.image === image);
        ops.push({ replace: image, strokes: [...canvas.strokes, ...list.flatMap(f => f.strokes)] }, ...list.map(f => ({ remove: f.image })));
      }
      for (const list of groups.values()) if (list.length > 1) ops.push({ add: list.flatMap(f => f.strokes), page: list[0].page, behind: !!list[0].image.anchor?.behind }, ...list.map(f => ({ remove: f.image })));
      return ops;
    }, { record: false });
  }

  /* ---- Eraser ---- */
  let erasing = null;
  function eraseAlong(a, b) {
    if (!erasing) return;
    const r = ERASER_SIZES[prefs.eraserSize] || 7;
    let changed = false;
    for (const f of erasing.frames) {
      const before = erasing.edited.get(f.image) || f.strokes;
      let after;
      if (prefs.eraser === 'stroke') after = before.filter(s => !sweepHits(s, a, b, r));
      else {
        after = before;
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (r / 2)));
        for (let i = 0; i <= steps; i++) { const p = { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }; after = after.flatMap(s => eraseFromStroke(s, p, r)); }
      }
      if (after.length !== before.length || after.some((s, i) => s !== before[i])) { erasing.edited.set(f.image, after); hidden.add(f.image); changed = true; }
    }
    if (changed) { surface.setScene(erasing.page, [...erasing.edited.values()].flat()); repaint(); }
  }
  async function finishErase() {
    const job = erasing; erasing = null;
    if (!job?.edited.size) return;
    const ops = [...job.edited].map(([image, strokes]) => (strokes.length ? { replace: image, strokes } : { remove: image }));
    await committer.commit(ops);
    for (const image of job.edited.keys()) hidden.delete(image);
    surface.setScene(job.page, null); repaint();
  }
  /** Erase all ink on the current page or everywhere. */
  async function eraseAll(scope = 'document') {
    const engine = ready(); if (!engine) return;
    await endSession();
    const page = engine.caretPageIndex ?? 0;
    const frames = inkFrames(engine).filter(f => scope === 'document' || f.page === page);
    if (!frames.length) { toast('There is no ink to erase.', { icon: 'info' }); return; }
    await committer.commit(frames.map(f => ({ remove: f.image })));
  }

  /* ---- Lasso selection ---- */
  let selected = null; // { page, items: [{ image, index, stroke }] }
  function setSelection(next) {
    selected = next?.items.length ? next : null;
    surface.setSelection(selected ? { page: selected.page, strokes: selected.items.map(i => i.stroke) } : null);
    refresh();
  }
  function selectByLasso(page, polygon) {
    const engine = editor(); if (!engine) return;
    const items = [];
    for (const f of inkFrames(engine, page)) f.strokes.forEach((stroke, index) => { if (lassoContains(polygon, stroke)) items.push({ image: f.image, index, stroke }); });
    setSelection({ page, items });
    if (!items.length && polygon.length > 4) toast('No ink inside the loop.', { icon: 'info', duration: 1800 });
  }
  /** The strokes of each drawing touched by the selection, with the selected ones changed by `edit`. */
  function selectionEdit(edit) {
    const engine = editor(), frames = inkFrames(engine, selected.page), result = new Map();
    for (const item of selected.items) {
      const frame = frames.find(f => f.image === item.image); if (!frame) continue;
      if (!result.has(item.image)) result.set(item.image, frame.strokes.map(s => ({ stroke: s, selected: false })));
      result.get(item.image)[item.index].selected = true;
    }
    for (const list of result.values()) for (const entry of list) if (entry.selected) entry.stroke = edit(entry.stroke);
    return result;
  }
  function dragSelection(dx, dy) {
    if (!selected) return;
    const edited = selectionEdit(s => translateStroke(s, dx, dy));
    for (const image of edited.keys()) hidden.add(image);
    surface.setScene(selected.page, [...edited.values()].flat().map(e => e.stroke));
    surface.setSelection({ page: selected.page, strokes: selected.items.map(i => translateStroke(i.stroke, dx, dy)) });
    repaint();
  }
  async function dropSelection(dx, dy) {
    if (!selected) return;
    const page = selected.page, edited = selectionEdit(s => translateStroke(s, dx, dy));
    const moved = selected.items.map(i => translateStroke(i.stroke, dx, dy));
    if (Math.hypot(dx, dy) >= 1) await committer.commit([...edited].map(([image, list]) => ({ replace: image, strokes: list.map(e => e.stroke) })));
    for (const image of edited.keys()) hidden.delete(image);
    surface.setScene(page, null); repaint();
    reselect(page, moved);
  }
  /** Select, in the drawings now on the page, the strokes matching these. */
  function reselect(page, strokes) {
    const engine = editor(); if (!engine) return setSelection(null);
    const same = (a, b) => a.tool === b.tool && a.color === b.color && Math.abs(a.points[0].x - b.points[0].x) < 0.6 && Math.abs(a.points[0].y - b.points[0].y) < 0.6 && a.points.length === b.points.length;
    const items = [];
    for (const f of inkFrames(engine, page)) f.strokes.forEach((stroke, index) => { if (strokes.some(s => same(s, stroke))) items.push({ image: f.image, index, stroke }); });
    setSelection({ page, items });
  }
  async function deleteSelection() {
    if (!selected) return;
    const edited = selectionEdit(s => s), ops = [...edited].map(([image, list]) => { const keep = list.filter(e => !e.selected).map(e => e.stroke); return keep.length ? { replace: image, strokes: keep } : { remove: image }; });
    setSelection(null);
    await committer.commit(ops);
  }
  /** Ink to Shape on chosen strokes: recognised strokes become shapes; the rest stay ink. */
  async function convertStrokes(page, groups) {
    // groups: Map(image → [{ stroke, selected }]) for the drawings involved.
    const chosen = [...groups.values()].flat().filter(e => e.selected).map(e => e.stroke);
    const shapes = [];
    const together = chosen.length <= 2 ? recognizeStrokes(chosen) : null;
    if (together) shapes.push({ shape: together, from: chosen });
    else for (const stroke of chosen) { const shape = recognizeStroke(stroke.points); if (shape) shapes.push({ shape, from: [stroke] }); }
    if (!shapes.length) { toast('No shapes were recognised in this ink.', { icon: 'info' }); return false; }
    const converted = new Set(shapes.flatMap(s => s.from));
    const ops = [];
    for (const [image, list] of groups) {
      const keep = list.filter(e => !converted.has(e.stroke)).map(e => e.stroke);
      if (keep.length === list.length) continue;
      ops.push(keep.length ? { replace: image, strokes: keep } : { remove: image });
    }
    for (const { shape, from } of shapes) ops.push(shapeOp(page, shape, { color: from[0].tool === 'highlighter' ? '000000' : from[0].color, width: from[0].width }));
    await committer.commit(ops);
    return true;
  }
  async function convertSelection() {
    if (!selected) return;
    const page = selected.page, groups = selectionEdit(s => s);
    setSelection(null);
    await convertStrokes(page, groups);
  }
  /** Convert the selected ink drawing (right-click on ink while editing text). */
  async function convertDrawing(image = editor()?.model.selectedImage) {
    const engine = ready(); if (!engine || !inkOf(image)) return;
    const frame = inkFrames(engine).find(f => f.image === image); if (!frame) return;
    await convertStrokes(frame.page, new Map([[image, frame.strokes.map(stroke => ({ stroke, selected: true }))]]));
  }

  /* ---- Hide ink, replay ---- */
  function toggleInk(force) {
    inkHidden = typeof force === 'boolean' ? force : !inkHidden;
    repaint(); refresh();
    return inkHidden;
  }
  function stopReplay() {
    if (!replaying) return;
    cancelAnimationFrame(replaying.frame); clearTimeout(replaying.timer);
    replaying.chip.remove(); replaying = null;
    surface.clearScenes(); repaint(); refresh();
  }
  async function inkReplay() {
    if (replaying) { stopReplay(); return; }
    const engine = editor(); if (!engine) return;
    await endSession();
    const frames = inkFrames(engine).sort((a, b) => a.image.id - b.image.id);
    const queue = frames.flatMap(f => f.strokes.map(stroke => ({ page: f.page, stroke })));
    if (!queue.length) { toast('There is no ink to replay.', { icon: 'info' }); return; }
    const chip = el('div.draw-replay-chip', { role: 'status' }, el('span', {}, 'Replaying ink'), el('button.btn.btn-sm', { type: 'button', onclick: stopReplay }, 'Stop'));
    document.body.append(chip);
    replaying = { frame: 0, timer: 0, chip };
    repaint(); refresh();
    const shown = new Map(); let index = 0, started = performance.now();
    const step = now => {
      if (!replaying) return;
      const { page, stroke } = queue[index], duration = Math.max(180, Math.min(1200, pathLength(stroke.points) * 3));
      const t = Math.min(1, (now - started) / duration), count = Math.max(1, Math.ceil(stroke.points.length * t));
      const done = shown.get(page) || [];
      surface.setScene(page, [...done, { ...stroke, points: stroke.points.slice(0, count) }]);
      if (index === 0 || t === 0) engine.canvases?.[page]?.scrollIntoView?.({ block: 'nearest' });
      if (t >= 1) {
        shown.set(page, [...done, stroke]); index++; started = now;
        if (index >= queue.length) { replaying.timer = setTimeout(stopReplay, 600); return; }
      }
      replaying.frame = requestAnimationFrame(step);
    };
    replaying.frame = requestAnimationFrame(step);
  }

  /* ---- Insert: drawing canvas ---- */
  async function insertCanvas() {
    const engine = ready(); if (!engine) return;
    const p = engine.model.pageSettings, textWidth = Math.max(240, (p.width - p.left - p.right) / 15);
    await committer.commit([{ add: [], canvas: true, width: Math.min(textWidth, 576), height: 288 }]);
    setTool('pen');
  }

  /* ---- Ink to Math ---- */
  const canMath = () => P.canUseAi() && typeof commands().insertEquation === 'function';
  async function inkToMath() {
    const engine = ready(); if (!engine || !canMath()) return;
    const strokes = selected ? selected.items.map(i => i.stroke) : [];
    const { openInkMath } = await import('./draw-math.js');
    openInkMath({ strokes, recognize: recognizeMath, onClose: () => queueMicrotask(() => editor()?.focus()),
      // The equation dialog opens once this one has closed and handed focus back.
      onInsert: linear => { setTimeout(() => commands().insertEquation?.({ linear, display: true }), 0); } });
  }
  /** Send a picture of the handwriting to the assistant and get back an equation in linear format. */
  async function recognizeMath(dataUrl) {
    const prompt = 'The image shows handwritten mathematics. Transcribe it as one equation in the linear format a word processor equation editor accepts: '
      + 'a/b for fractions with parentheses around multi-term parts, x^2 for superscripts, x_i for subscripts, √(x) for roots, ∑_(i=1)^n for sums, ∫_a^b for integrals, and Unicode for Greek letters and operators (π, θ, ±, ×, ≤). '
      + 'Reply with the equation only, without explanations, quotes, LaTeX or code fences.';
    let answer;
    try { answer = cleanAnswer(responseText(await P.aiChat(prompt, dataUrl))); }
    catch (e) { throw new Error('The handwriting could not be read right now. Try again in a moment.', { cause: e }); }
    answer = answer.replace(/^\$+|\$+$/g, '').replace(/^`+|`+$/g, '').split('\n')[0].trim();
    if (!answer) throw new Error('No equation was recognised. Try writing more clearly.');
    return answer;
  }

  /* ---- Ribbon ---- */
  const hint = (() => {
    const node = el('div.draw-hint', { role: 'status', hidden: true });
    let timer = 0;
    // A reminder of the tool shows when it changes, then gets out of the way of the page.
    return { node, update() {
      const pen = activePen(), text = tool === 'pen' ? `${penLabel(pen)} · Esc returns to typing` : tool === 'eraser' ? `${prefs.eraser === 'stroke' ? 'Stroke' : 'Point'} eraser · Esc returns to typing` : tool === 'lasso' ? 'Draw a loop around ink to select it · Esc returns to typing' : '';
      clearTimeout(timer);
      node.hidden = !text || !editor();
      node.textContent = text;
      if (!node.isConnected && !node.hidden) document.body.append(node);
      if (!node.hidden) timer = setTimeout(() => { node.hidden = true; }, 3500);
    } };
  })();
  let gallery = null;
  function renderGallery() {
    if (!gallery) return;
    gallery.replaceChildren(...pens.pens.map(pen => {
      const active = tool === 'pen' && pen.id === lastPen;
      const button = el('button.draw-pen', { type: 'button', 'aria-label': penLabel(pen), title: `${penLabel(pen)}${active ? ' — click again for settings' : ''}`, 'aria-pressed': String(active), 'aria-haspopup': 'menu', dataset: { pen: pen.id, tool: pen.tool },
        html: penIconSvg(pen, 30),
        onclick: e => { if (tool === 'pen' && pen.id === lastPen) penSettings(button, pen, e); else { setTool('pen', pen.id); editor()?.focus(); } },
        onkeydown: e => { if (!isComposing(e) && (e.key === 'ArrowDown' && e.altKey || e.key === 'F4')) { e.preventDefault(); penSettings(button, pen, e); } } });
      button.disabled = !ready();
      button.addEventListener('mousedown', e => e.preventDefault());
      return button;
    }));
  }
  function penSettings(anchor, pen, event) {
    openPenSettings({ anchor, pen, pointer: !!event?.detail, canRemove: pens.pens.length > 1,
      onChange: patch => { Object.assign(pen, patch); savePens(pens); renderGallery(); hint.update(); setTool('pen', pen.id); },
      onRemove: () => { pens.pens = pens.pens.filter(p => p !== pen); if (lastPen === pen.id) lastPen = pens.pens[0].id; pens.active = lastPen; savePens(pens); renderGallery(); setTool(tool === 'pen' ? 'pen' : tool); } });
  }
  function addPen(kind) {
    if (pens.pens.length >= 12) { toast('The pen gallery holds up to 12 pens. Remove one first.', { icon: 'info' }); return; }
    const pen = newPen(kind); pens.pens.push(pen); savePens(pens); renderGallery(); setTool('pen', pen.id);
  }

  function extraTabs(kit) {
    const { command, menuButton, rows, when, split } = kit;
    const noSteal = (...buttons) => { for (const b of buttons) b.addEventListener('mousedown', e => e.preventDefault()); };
    const can = () => !!ready();
    const select = command('Select', 'drawSelect', () => { setTool('select'); editor()?.focus(); }, { size: 'large', text: 'Select' });
    const lasso = command('Lasso Select', 'lassoSelect', () => setTool(tool === 'lasso' ? 'select' : 'lasso'), { size: 'large', text: 'Lasso Select' });
    const eraserMain = command('Eraser', 'inkEraser', () => setTool(tool === 'eraser' ? 'select' : 'eraser'), { size: 'large', text: 'Eraser' });
    const eraser = split(eraserMain, { label: 'Eraser options', size: 'large', open: (anchor, e) => openMenu({ anchor, label: 'Eraser', pointer: !!e?.detail, items: eraserItems() }) });
    gallery = el('div.draw-pen-gallery', { role: 'group', 'aria-label': 'Pens' });
    renderGallery();
    const add = menuButton('Add Pen', 'addPen', () => ['pen', 'pencil', 'highlighter'].map(kind => ({ label: `Add ${TOOL_LABELS[kind]}`, onSelect: () => addPen(kind) })), { size: 'large', text: 'Add Pen' });
    const touchToggle = command('Draw with Touch', 'drawTouch', () => { prefs.touch = !prefs.touch; store(prefs); surface.setTouch(prefs.touch); refresh(); }, { size: 'large', text: 'Draw with Touch', attrs: { 'aria-pressed': 'false' } });
    const ruler = command('Ruler', 'inkRuler', () => { surface.showRuler(!surface.rulerVisible()); refresh(); }, { size: 'large', text: 'Ruler', attrs: { 'aria-pressed': 'false' } });
    const toShape = command('Ink to Shape', 'inkToShape', () => {
      if (selected) { convertSelection(); return; }
      inkToShape = !inkToShape; if (inkToShape && tool !== 'pen') setTool('pen'); refresh();
    }, { size: 'large', text: 'Ink to Shape', attrs: { 'aria-pressed': 'false' } });
    const toMath = command('Ink to Math', 'inkToMath', () => inkToMath(), { size: 'large', text: 'Ink to Math' });
    const replay = command('Ink Replay', 'inkReplay', () => inkReplay(), { size: 'large', text: 'Ink Replay', attrs: { 'aria-pressed': 'false' } });
    const canvas = command('Drawing Canvas', 'drawingCanvas', () => insertCanvas(), { size: 'large', text: 'Drawing Canvas' });
    const hide = command('Hide Ink', 'hideInk', () => toggleInk(), { size: 'large', text: 'Hide Ink', attrs: { 'aria-pressed': 'false' } });
    for (const b of [lasso, eraserMain, add, toShape, replay, canvas]) b.classList.add('ribbon-wide');
    noSteal(select, lasso, eraserMain, touchToggle, ruler, toShape, toMath, replay, canvas, hide);
    when(select, can, () => String(tool === 'select'));
    when(lasso, can, () => String(tool === 'lasso'));
    when(eraserMain, can, () => String(tool === 'eraser')); when(eraser.arrow, can);
    when(add, can);
    when(touchToggle, can, () => String(!!prefs.touch));
    when(ruler, can, () => String(surface.rulerVisible()));
    when(toShape, can, () => String(inkToShape));
    when(toMath, () => can() && canMath());
    toMath.hidden = !canMath();
    when(replay, () => !!editor(), () => String(!!replaying));
    when(canvas, can);
    when(hide, () => !!editor(), () => String(inkHidden));
    // The gallery follows the tool and the document's state on every refresh.
    when(gallery, () => { for (const b of gallery.querySelectorAll('.draw-pen')) { const active = tool === 'pen' && b.dataset.pen === lastPen; b.setAttribute('aria-pressed', String(active)); b.disabled = !ready(); } toMath.hidden = !canMath(); return true; });
    return [{ id: 'draw', label: 'Draw', after: 'insert', groups: [
      { id: 'drawTools', label: 'Drawing Tools', icon: 'inkPen', priority: 9, items: [select, lasso, eraser, gallery, add] },
      { id: 'drawInput', label: 'Input', icon: 'drawTouch', priority: 4, items: [touchToggle, ruler] },
      { id: 'drawConvert', label: 'Convert', icon: 'inkToShape', priority: 6, items: [toShape, toMath] },
      { id: 'drawInsert', label: 'Insert', icon: 'drawingCanvas', priority: 5, items: [canvas] },
      { id: 'drawReplay', label: 'Replay', icon: 'inkReplay', priority: 3, items: [replay, hide] },
    ] }];
  }
  function eraserItems() {
    const pick = patch => { Object.assign(prefs, patch); store(prefs); setTool('eraser'); };
    return [
      { label: 'Stroke Eraser', checked: prefs.eraser === 'stroke', radio: true, onSelect: () => pick({ eraser: 'stroke' }) },
      { label: 'Point Eraser', checked: prefs.eraser === 'point', radio: true, onSelect: () => pick({ eraser: 'point' }) },
      { separator: true }, { header: 'Eraser Size' },
      ...Object.keys(ERASER_SIZES).map(size => ({ label: size[0].toUpperCase() + size.slice(1), checked: prefs.eraserSize === size, radio: true, onSelect: () => pick({ eraserSize: size }) })),
      { separator: true },
      { label: 'Erase All Ink on This Page', disabled: !ready(), onSelect: () => eraseAll('page') },
      { label: 'Erase All Ink in Document', disabled: !ready(), onSelect: () => eraseAll('document') },
    ];
  }

  /* ---- Menus ---- */
  const toggleShortcut = MOD_KEY === 'Cmd' ? 'Cmd+Ctrl+Z' : 'Ctrl+Alt+Z';
  function extendMenu(menuId) {
    const disabled = !ready();
    if (menuId === 'edit') return [{ separator: true }, { label: 'Toggle Drawing', icon: 'inkPen', shortcut: toggleShortcut, checked: tool !== 'select', disabled, onSelect: toggleDrawing }];
    if (menuId === 'insert') return [{ label: 'Drawing Canvas', icon: 'drawingCanvas', disabled, onSelect: insertCanvas }];
    if (menuId === 'view') return [{ label: 'Hide Ink', icon: 'hideInk', checked: inkHidden, disabled: !editor(), onSelect: () => toggleInk() }];
    return [];
  }
  function contextMenuItems(context) {
    const engine = ready(), image = engine?.model.selectedImage;
    if (!engine || context !== 'image' || !inkOf(image)) return [];
    const arrange = direction => { engine.execute(() => engine.model.arrangeImage(direction)); engine.focus(); };
    const floating = !!image.anchor;
    return [
      { label: 'Convert to Shape', icon: 'inkToShape', onSelect: () => convertDrawing(image) },
      { label: 'Bring to Front', icon: 'bringForward', disabled: !floating, onSelect: () => arrange('front') },
      { label: 'Send to Back', icon: 'sendBackward', disabled: !floating, onSelect: () => arrange('back') },
      { label: 'Delete Ink', icon: 'deleteShape', onSelect: () => committer.commit([{ remove: image }]) },
    ];
  }

  /* ---- Keyboard ---- */
  const keyAbort = new AbortController();
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e) || !editor()) return;
    const chord = MOD_KEY === 'Cmd' ? e.metaKey && e.ctrlKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey;
    if (chord && !e.shiftKey && !typesCharacter(e) && shortcutCode(e) === 'KeyZ') { e.preventDefault(); e.stopPropagation(); toggleDrawing(); return; }
    if (replaying && e.key === 'Escape') { e.preventDefault(); stopReplay(); return; }
    if (tool === 'select' || !e.target?.matches?.('.canvas-input, body, .draw-pen, .ribbon-card button')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (selected) setSelection(null); else { setTool('select'); editor()?.focus(); } }
    else if (selected && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); e.stopPropagation(); deleteSelection(); }
  }, { capture: true, signal: keyAbort.signal });

  /** Called on every editor update. */
  function update() {
    const engine = editor();
    if (engine) { installHiding(engine); surface.attach(); }
    // Text edits move ink with its paragraphs: drop a lasso selection that no longer matches the page.
    if (selected && engine) {
      const frames = inkFrames(engine, selected.page);
      if (selected.items.some(i => !frames.some(f => f.image === i.image))) setSelection(null);
    }
    surface.reposition();
  }

  return {
    commands: {
      toggleInk, inkHidden: () => inkHidden, toggleDrawing, inkReplay, insertDrawingCanvas: insertCanvas, inkToMath, convertInkToShape: convertDrawing,
      drawTool: setTool, eraseAllInk: eraseAll,
      /** For tests and other modules: the current tool, pen and session state. */
      drawState: () => ({ tool, pen: { ...activePen() }, inkHidden, inkToShape, touch: !!prefs.touch, selected: selected?.items.length || 0, ruler: surface.rulerVisible(), replaying: !!replaying }),
      inkIdle: () => committer.idle(),
    },
    extraTabs, extendMenu, contextMenuItems, update, surface,
    destroy() { keyAbort.abort(); stopReplay(); surface.destroy(); hint.node.remove(); },
  };
}

