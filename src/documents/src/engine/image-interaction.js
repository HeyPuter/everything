import { EMU_PER_PX, inlineImagePaintFrame, normalizedRotation, ANGLE_PER_DEGREE, rotationOutsets, imageExtents, CROP_SIDES, isPositionedImage } from './images.js';
import { positionedImageBounds, positionedImageFrame } from './positioned-images.js';
import { resizeImageFrame } from './image-resize.js';
import { boundaries } from './model.js';
import { caretRect } from './layout.js';
import { HANDLES, isCorner, resizeFromHandle, pointerAngle, rotationUnits, snapBox, pageGuideTargets, uncroppedRect, cropFromRects, dragCropRect, aspectRect, coverRect } from './drawing-handles.js';

/**
 * Direct manipulation of pictures and shapes. Gestures preview a frame over the page; one validated
 * transaction is committed on release. A selected drawing shows eight resize handles, a rotation
 * handle, a Move button, a Layout Options button and an anchor mark; floating drawings snap to the
 * page, its margins and other drawings while dragged; Shift+click adds drawings to a selection that
 * moves together; and crop mode trims a picture with its own handles.
 *
 * Editor hooks (all optional): onDrawingGesture({ type: 'rotate' | 'crop' | 'moveMany', ... })
 * returns truthy when it applied the change itself; canRotateDrawing(image) and canCropDrawing(image)
 * widen which drawings rotate and crop; onLayoutOptions(button) opens quick wrap choices.
 */
const NAMES = { nw: 'nw', n: 'n', ne: 'ne', e: 'e', se: 'se', s: 's', sw: 'sw', w: 'w' };
const SNAP_PX = 6;
const EDGE_PLACES = { n: { left: 'calc(50% - 6px)', top: '-6px' }, s: { left: 'calc(50% - 6px)', bottom: '-6px' }, e: { right: '-6px', top: 'calc(50% - 6px)' }, w: { left: '-6px', top: 'calc(50% - 6px)' } };
const ROTATE_STEP = 15;
const ANCHOR_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><circle cx="8" cy="3" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.6V14M4.5 7.5h7M2.8 10.2c.6 2.3 2.7 3.8 5.2 3.8s4.6-1.5 5.2-3.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

export function createImageInteraction(editor) {
  const make = (tag, className, attrs = {}) => { const node = document.createElement(tag); node.className = className; for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; };
  const overlay = make('div', 'canvas-image-frame'); overlay.hidden = true;
  // Guides, extra selection frames, the anchor mark, the drop caret and the crop preview share one layer.
  const layer = make('div', 'canvas-drawing-layer', { 'aria-hidden': 'true' });
  const anchorMark = make('div', 'canvas-anchor-mark'); anchorMark.innerHTML = ANCHOR_SVG; anchorMark.hidden = true;
  const dropCaret = make('div', 'canvas-drop-caret'); dropCaret.hidden = true;
  const cropPreview = make('canvas', 'canvas-crop-preview'); cropPreview.hidden = true;
  const cropFrame = make('div', 'canvas-crop-frame'); cropFrame.hidden = true;
  const optionsButton = make('button', 'canvas-layout-options', { type: 'button', 'aria-label': 'Layout Options', title: 'Layout Options' });
  optionsButton.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><rect x="5.5" y="5" width="5" height="5" rx="1" fill="currentColor" opacity=".55"/><path d="M2 3h12M2 6.5h2M12 6.5h2M2 9.5h2M12 9.5h2M2 13h12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  optionsButton.hidden = true;
  // Positioning that must hold even before the stylesheet loads: nothing here may take part in the page flow.
  Object.assign(layer.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0', pointerEvents: 'none' });
  for (const node of [cropPreview, anchorMark, dropCaret, cropFrame]) node.style.position = 'absolute';
  layer.append(cropPreview, anchorMark, dropCaret);
  editor.host.append(layer, overlay, cropFrame, optionsButton);
  const listen = (node, type, fn, options) => node.addEventListener(type, fn, { signal: editor.abort.signal, ...options });
  let gesture, crop = null, extras = [], primaryId = null;
  const guideNodes = [], extraNodes = [];

  /* ---- What can be done to a drawing ---- */
  // Drawings resize only through an editor that can rewrite them (simple preset shapes); pictures resize directly.
  const scenePicture = image => !!editor.pictureEditor?.canResize(image);
  const shapeDrawing = image => !scenePicture(image) && !!editor.drawingEditor?.canResize(image);
  const resizableDrawing = image => scenePicture(image) || shapeDrawing(image);
  const resizable = image => !image.anchor?.relativeSize && (!image.retainedDrawing || resizableDrawing(image));
  const flat = image => !!(image.flatLine || image.flatGroup);
  const resizeImage = (image, patch) => scenePicture(image) ? editor.pictureEditor.resize(patch) : image.retainedDrawing ? editor.drawingEditor.resize(patch) : editor.setImageProperties(patch);
  const inTable = f => !!lineOf(f)?.cellId;
  function canRotate(f) {
    const image = f.image;
    if (editor.readOnly || image.kind === 'chart' || image.anchor?.relativeSize || flat(image) || !f.floating && inTable(f)) return false;
    if (typeof editor.canRotateDrawing === 'function') return !!editor.canRotateDrawing(image);
    // Plain pictures rotate in place; text-wrapped ones keep their wrapping rectangle upright.
    return !image.retainedDrawing && (!image.anchor || image.anchor.wrap === 'none');
  }
  function canCrop(image) {
    if (!image || editor.readOnly || image.kind === 'chart' || normalizedRotation(image.rotation) || editor.session.path !== null) return false;
    if (typeof editor.canCropDrawing === 'function') return !!editor.canCropDrawing(image);
    return !image.retainedDrawing;
  }
  // A gesture hook may apply the change itself (returning truthy, or a promise); otherwise the plain path runs.
  const viaHook = payload => { try { return !!editor.onDrawingGesture?.(payload); } catch (error) { editor.onError(error); return true; } };

  /* ---- Frames on the page ---- */
  const allLines = () => { const layout = editor.selectionLayout; return [...layout.lines, ...(layout.repeatedLines || [])]; };
  const lineOf = f => allLines().find(l => l.fragments.some(p => p.image && p.start === f.start && p.end === f.end));
  function frameAt(start, end) {
    const layout = editor.selectionLayout;
    const floating = (layout.floatingObjects || []).find(f => f.start === start && f.end === end);
    if (floating) return { ...floating, floating: true };
    for (const line of allLines()) {
      const f = line.fragments.find(f => f.image && f.start === start && f.end === end);
      if (f) return { ...inlineImagePaintFrame(f.image, f.uprightImage?.x ?? f.x, f.uprightImage?.y ?? line.baseline - f.ascent), image: f.image, page: line.page, start, end };
    }
    return null;
  }
  const frame = () => {
    const image = editor.model.selectedImage, [start, end] = editor.model.range;
    if (!image || editor.readOnly || editor.accessible) return null;
    return frameAt(start, end);
  };
  const placement = f => {
    const anchor = f.image.anchor, lines = allLines();
    const line = lines.find(l => l.fragments.some(p => p.image && p.start === f.start && p.end === f.end));
    const first = anchor.vertical === 'line' ? line : lines.find(l => l.paragraphId === line?.paragraphId && l.page === f.page);
    const geometry = editor.layout.pageRegions[f.page]?.[f.region]?.geometry || editor.layout.pages[f.page];
    const cell = line?.cellId ? editor.selectionLayout.cells.find(c => c.id === line.cellId && c.page === f.page) : null;
    return positionedImageFrame(f, first, { ...geometry, drawingBounds: editor.layout.pageRegions[f.page]?.[f.region]?.drawingBounds }, cell);
  };
  const offsets = f => {
    const anchor = { ...f.image.anchor, x: 0, y: 0 };
    for (const axis of ['x', 'y']) { delete anchor[axis + 'Align']; delete anchor[axis + 'Percentage']; }
    const zero = placement({ ...f, image: { ...f.image, anchor } });
    return { x: Math.round((f.x - zero.x) * EMU_PER_PX), y: Math.round((f.y - zero.y) * EMU_PER_PX) };
  };
  const resizePatch = (f, resized) => {
    const { width, height, frame: desired } = resized, patch = { width, height };
    if (!f.floating) return patch;
    const next = { ...f.image, width, height }, oldRequired = rotationOutsets(f.image), nextRequired = rotationOutsets(next), oldExtent = imageExtents(f.image);
    // Use the same geometric outsets as the model's validated size transaction.
    next.effectExtent = Object.fromEntries(CROP_SIDES.map(side => [side, nextRequired[side] + Math.max(0, oldExtent[side] - oldRequired[side])]));
    const projected = placement({ ...f, image: next }), numeric = offsets({ ...desired, image: next });
    for (const axis of ['x', 'y']) if (Math.abs(projected[axis] - desired[axis]) > 1e-7) (patch.anchor ||= {})[axis] = numeric[axis];
    return patch;
  };
  const pageGeometry = index => editor.layout.pages[index] || editor.layout.page;
  const canvasOf = index => editor.canvases[index];
  const place = (node, page, box) => {
    const canvas = canvasOf(page); if (!canvas) { node.hidden = true; return false; }
    Object.assign(node.style, { left: `${canvas.offsetLeft + box.x * editor.zoom}px`, top: `${canvas.offsetTop + box.y * editor.zoom}px`,
      width: `${Math.max(0, box.width) * editor.zoom}px`, height: `${Math.max(0, box.height) * editor.zoom}px` });
    return true;
  };
  const show = (box, rotation = normalizedRotation(box.image?.rotation) / ANGLE_PER_DEGREE) => {
    if (!place(overlay, box.page, box)) return;
    overlay.style.transform = `rotate(${rotation}deg)`;
  };
  // The frame drawn around a drawing: retained drawings paint their own rotation inside their bounds.
  const boxOf = f => f.image.retainedDrawing ? { ...positionedImageBounds(f), page: f.page } : f;
  const rotationOf = f => f.image.retainedDrawing ? 0 : normalizedRotation(f.image.rotation) / ANGLE_PER_DEGREE;

  /* ---- The extra selection (Shift+click) ---- */
  const floatingById = id => (editor.selectionLayout.floatingObjects || []).find(f => f.image.id === id && isPositionedImage(f.image));
  const extraFrames = () => extras.map(floatingById).filter(Boolean).map(f => ({ ...f, floating: true }));
  function setExtras(ids) {
    const before = extras.join();
    extras = [...new Set(ids)].filter(id => id !== primaryId && floatingById(id));
    if (extras.join() !== before) { update(); editor.onSelection?.(); }
  }
  Object.defineProperty(editor, 'drawingSelection', { configurable: true, get() {
    const image = editor.model.selectedImage;
    return image ? [image, ...extraFrames().map(f => f.image)] : [];
  } });
  editor.setDrawingSelection = images => {
    const list = (images || []).filter(Boolean);
    const located = list.map(image => (editor.selectionLayout.floatingObjects || []).find(f => f.image === image || f.image.id === image.id)
      || allLines().flatMap(l => l.fragments).find(f => f.image === image));
    const first = located[0];
    if (!first) return false;
    if (crop) endCrop(false);
    editor.model.select(first.start, first.end); primaryId = first.image.id;
    extras = located.slice(1).filter(f => f && isPositionedImage(f.image) && isPositionedImage(first.image)).map(f => f.image.id).filter(id => id !== primaryId);
    editor.syncInput?.(); editor.paint?.(); editor.focus?.(); editor.onSelection?.();
    return true;
  };

  /* ---- Painting the controls ---- */
  function showGuides(page, guides) {
    const geometry = pageGeometry(page);
    while (guideNodes.length < guides.length) { const node = make('div', 'canvas-drawing-guide'); node.style.position = 'absolute'; layer.append(node); guideNodes.push(node); }
    guideNodes.forEach((node, i) => {
      const guide = guides[i]; node.hidden = !guide; if (!guide) return;
      node.dataset.axis = guide.axis; node.dataset.kind = guide.kind || '';
      place(node, page, guide.axis === 'x' ? { x: guide.value, y: 0, width: 0, height: geometry.height } : { x: 0, y: guide.value, width: geometry.width, height: 0 });
    });
  }
  function showExtras(dx = 0, dy = 0) {
    const frames = extraFrames();
    while (extraNodes.length < frames.length) { const node = make('div', 'canvas-image-frame is-secondary'); node.style.position = 'absolute'; layer.append(node); extraNodes.push(node); }
    extraNodes.forEach((node, i) => {
      const f = frames[i]; node.hidden = !f; if (!f) return;
      const box = boxOf(f);
      place(node, f.page, { ...box, x: box.x + dx, y: box.y + dy });
      node.style.transform = `rotate(${rotationOf(f)}deg)`;
    });
  }
  function showAnchor(f) {
    const line = f?.floating ? lineOf(f) : null;
    if (!line || editor.session.path !== null) { anchorMark.hidden = true; return; }
    const first = allLines().find(l => l.paragraphId === line.paragraphId && l.page === line.page) || line, geometry = pageGeometry(first.page);
    anchorMark.hidden = !place(anchorMark, first.page, { x: Math.max(2, (geometry.left ?? 72) - 20), y: first.y, width: 16, height: 16 });
    anchorMark.style.width = anchorMark.style.height = '';
  }
  function showOptions(f) {
    const visible = !!f && !!editor.onLayoutOptions && !gesture && !crop && editor.session.path === null;
    optionsButton.hidden = !visible;
    if (!visible) return;
    const box = positionedImageBounds({ ...boxOf(f), image: { ...f.image, rotation: rotationOf(f) * ANGLE_PER_DEGREE } });
    const canvas = canvasOf(f.page); if (!canvas) { optionsButton.hidden = true; return; }
    Object.assign(optionsButton.style, { left: `${canvas.offsetLeft + (box.x + box.width) * editor.zoom + 8}px`, top: `${canvas.offsetTop + box.y * editor.zoom}px` });
  }
  function hideTransient() { showGuides(0, []); dropCaret.hidden = true; }

  function update() {
    if (gesture) return;
    const f = frame();
    const selected = editor.model.selectedImage;
    if (!selected || selected.id !== primaryId) { if (extras.length) extras = []; primaryId = selected?.id ?? null; }
    // A picture rewritten or deselected while cropping (undo, another command) ends crop mode.
    if (crop && f?.image !== crop.image) crop = null;
    overlay.hidden = !f || !!crop; cropFrame.hidden = !crop; cropPreview.hidden = !crop;
    showExtras(); showAnchor(f); showOptions(f); hideTransient();
    if (crop) { showCrop(); return; }
    if (!f) return;
    show(boxOf(f), rotationOf(f));
    overlay.classList.toggle('is-multi', extras.length > 0);
    const canResize = resizable(f.image), rotate = canRotate(f);
    for (const button of overlay.querySelectorAll('[data-handle]')) {
      const handle = button.dataset.handle;
      button.hidden = !canResize || !isCorner(handle) && (flat(f.image) || shapeDrawing(f.image) && !!f.image.flatLine);
      const angle = rotationOf(f) + { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }[handle];
      button.style.cursor = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'][Math.round(angle / 45) % 4];
    }
    rotateButton.hidden = !rotate;
  }

  /* ---- Gestures ---- */
  const begin = (e, mode = 'move') => {
    const f = frame(); if (!f || e.button !== 0) return false;
    if (mode.startsWith('crop')) { if (!crop) return false; }
    else if (mode === 'rotate') { if (!canRotate(f)) return false; }
    else if (mode !== 'move' && !resizable(f.image)) return false;
    const box = boxOf(f), others = mode === 'move' && f.floating ? extraFrames() : [];
    gesture = { mode, frame: f, box, others, start: { x: e.clientX, y: e.clientY }, range: [...editor.model.range], model: editor.model, revision: editor.session.revision, dx: 0, dy: 0, scale: 1 };
    if (f.floating && (mode === 'move' || mode === 'rotate' || HANDLES.includes(mode))) gesture.offsets = offsets(f);
    if (mode === 'move' && f.floating) {
      const ids = new Set([f.image.id, ...others.map(o => o.image.id)]);
      const neighbours = (editor.selectionLayout.floatingObjects || []).filter(o => o.page === f.page && !ids.has(o.image.id)).map(o => positionedImageBounds(o));
      gesture.targets = pageGuideTargets(pageGeometry(f.page), neighbours);
      gesture.bounds = positionedImageBounds({ ...box, image: { ...f.image, rotation: rotationOf(f) * ANGLE_PER_DEGREE } });
    }
    if (mode === 'rotate') {
      const canvas = canvasOf(f.page), rect = canvas.getBoundingClientRect(), scale = rect.width / canvas.offsetWidth || 1;
      gesture.center = { x: rect.left + (box.x + box.width / 2) * editor.zoom * scale, y: rect.top + (box.y + box.height / 2) * editor.zoom * scale };
      gesture.baseRotation = normalizedRotation(f.image.rotation) / ANGLE_PER_DEGREE;
      gesture.startAngle = pointerAngle(gesture.center, gesture.start);
      gesture.rotation = normalizedRotation(f.image.rotation);
    }
    if (mode.startsWith('crop')) gesture.crop = { full: { ...crop.full }, rect: { ...crop.rect } };
    overlay.hidden = !!crop; optionsButton.hidden = true;
    if (!crop) show(box, rotationOf(f));
    e.preventDefault(); editor.pages.setPointerCapture?.(e.pointerId); editor.focus(); return true;
  };
  function move(e) {
    if (!gesture) return false;
    const g = gesture; g.dx = (e.clientX - g.start.x) / editor.zoom; g.dy = (e.clientY - g.start.y) / editor.zoom;
    if (g.mode === 'move') {
      if (!g.frame.floating) {
        g.target = editor.point(e, false);
        try {
          const caret = caretRect(editor.selectionLayout, g.target, 'forward');
          dropCaret.hidden = !place(dropCaret, caret.page, { x: caret.x, y: caret.y, width: 2 / editor.zoom, height: caret.height });
        } catch { dropCaret.hidden = true; }
      } else {
        // Snap the moving bounds to the page, its margins and other drawings; Alt (Cmd on a Mac) moves freely.
        const free = e.altKey || e.metaKey;
        const snapped = free ? { dx: 0, dy: 0, guides: [] } : snapBox({ ...g.bounds, x: g.bounds.x + g.dx, y: g.bounds.y + g.dy }, g.targets, SNAP_PX / editor.zoom);
        g.dx += snapped.dx; g.dy += snapped.dy;
        // With the drawing grid on, an axis no guide caught lands on the grid (measured from the page's margins).
        const grid = !free && editor.snapToGrid && editor.gridSize > 0 ? editor.gridSize : 0;
        if (grid) {
          const geometry = pageGeometry(g.frame.page);
          if (!snapped.guides.some(guide => guide.axis === 'x')) { const left = g.bounds.x + g.dx, origin = geometry.left || 0; g.dx += origin + Math.round((left - origin) / grid) * grid - left; }
          if (!snapped.guides.some(guide => guide.axis === 'y')) { const top = g.bounds.y + g.dy, origin = geometry.top || 0; g.dy += origin + Math.round((top - origin) / grid) * grid - top; }
        }
        showGuides(g.frame.page, snapped.guides);
        showExtras(g.dx, g.dy);
      }
      show({ ...g.box, page: g.frame.page, x: g.box.x + g.dx, y: g.box.y + g.dy }, rotationOf(g.frame));
    } else if (g.mode === 'rotate') {
      const angle = g.baseRotation + pointerAngle(g.center, { x: e.clientX, y: e.clientY }) - g.startAngle;
      g.rotation = rotationUnits(angle, e.shiftKey ? ROTATE_STEP : 0);
      g.moved = true;
      const preview = g.rotation / ANGLE_PER_DEGREE - (g.frame.image.retainedDrawing ? normalizedRotation(g.frame.image.rotation) / ANGLE_PER_DEGREE : 0);
      show({ ...g.box, page: g.frame.page }, preview);
      overlay.dataset.angle = `${Math.round(g.rotation / ANGLE_PER_DEGREE)}°`;
    } else if (g.mode.startsWith('crop')) {
      if (g.mode === 'crop-pan') crop.full = { ...g.crop.full, x: g.crop.full.x + g.dx, y: g.crop.full.y + g.dy };
      else crop.rect = dragCropRect(g.crop.rect, g.mode.slice(5), g.dx, g.dy, { keepAspect: e.shiftKey });
      showCrop();
    } else {
      const image = g.frame.image, corner = isCorner(g.mode), fromCenter = e.ctrlKey || e.altKey;
      if (!image.retainedDrawing || scenePicture(image)) {
        const preserveAspect = corner ? image.aspectLocked !== false || e.shiftKey : !!image.aspectLocked;
        g.resized = corner ? resizeImageFrame(g.frame, g.mode, g.dx, g.dy, { preserveAspect, fromCenter }) : resizeFromHandle(g.frame, g.mode, g.dx, g.dy, { preserveAspect, fromCenter });
        show(g.resized.frame);
      } else if (!g.box.width || !g.box.height || corner && e.shiftKey) {
        // Lines and proportional shape resizing scale the whole drawing.
        const sx = g.mode.includes('w') ? -1 : 1, sy = g.mode.includes('n') ? -1 : 1;
        g.scale = Math.max(.01, 1 + (g.dx * sx * g.box.width + g.dy * sy * g.box.height) / (g.box.width * g.box.width + g.box.height * g.box.height));
        g.shape = null;
        const width = g.box.width * g.scale, height = g.box.height * g.scale;
        show({ ...g.box, page: g.frame.page, width, height, x: g.box.x + (sx < 0 ? g.box.width - width : 0), y: g.box.y + (sy < 0 ? g.box.height - height : 0) }, 0);
      } else {
        const unrotated = { ...g.box, image: { width: image.width, height: image.height, rotation: 0 } };
        g.shape = resizeFromHandle(unrotated, g.mode, g.dx, g.dy, { fromCenter });
        show({ ...g.shape.frame, page: g.frame.page }, 0);
      }
    }
    return true;
  }
  const cancel = () => { if (!gesture) return false; if (gesture.crop) { crop.full = gesture.crop.full; crop.rect = gesture.crop.rect; } gesture = null; overlay.removeAttribute('data-angle'); update(); return true; };
  function end(e) {
    if (!gesture) return false; move(e); const g = gesture; gesture = null; overlay.removeAttribute('data-angle');
    hideTransient();
    if (g.mode.startsWith('crop')) { update(); return true; }
    if (g.model !== editor.model || g.revision !== editor.session.revision || g.mode !== 'rotate' && Math.hypot(g.dx, g.dy) < 3 / editor.zoom || g.mode === 'rotate' && !g.moved) { update(); return true; }
    editor.model.select(...g.range);
    if (g.mode === 'move') {
      if (g.frame.floating && g.others.length) moveMany([g.frame, ...g.others], Math.round(g.dx * EMU_PER_PX), Math.round(g.dy * EMU_PER_PX));
      else if (g.frame.floating) editor.setImageProperties({ anchor: { x: g.offsets.x + Math.round(g.dx * EMU_PER_PX), y: g.offsets.y + Math.round(g.dy * EMU_PER_PX) } });
      else editor.execute(() => editor.model.moveImage(g.target));
    } else if (g.mode === 'rotate') {
      const image = editor.model.selectedImage;
      const delta = g.rotation - normalizedRotation(image.rotation);
      if (delta && !viaHook({ type: 'rotate', image, rotation: g.rotation, delta })) editor.setImageProperties({ rotation: g.rotation });
    } else if (g.resized) {
      resizeImage(editor.model.selectedImage, resizePatch(g.frame, g.resized));
    } else if (g.shape) {
      const image = editor.model.selectedImage, patch = { width: g.shape.width, height: g.shape.height };
      if (g.frame.floating) {
        const dx = g.shape.frame.x - g.box.x, dy = g.shape.frame.y - g.box.y;
        if (Math.abs(dx) > 1e-7 || Math.abs(dy) > 1e-7) patch.anchor = { x: g.offsets.x + Math.round(dx * EMU_PER_PX), y: g.offsets.y + Math.round(dy * EMU_PER_PX) };
      }
      resizeImage(image, patch);
    } else {
      const image = editor.model.selectedImage, width = Math.max(1, Math.round(image.width * g.scale)), height = Math.max(1, Math.round(width * image.height / image.width));
      const patch = { width, height };
      if (g.frame.floating && (g.mode.includes('w') || g.mode.includes('n'))) patch.anchor = { x: g.offsets.x + Math.round((g.mode.includes('w') ? g.frame.width * (1 - g.scale) : 0) * EMU_PER_PX), y: g.offsets.y + Math.round((g.mode.includes('n') ? g.frame.height * (1 - g.scale) : 0) * EMU_PER_PX) };
      resizeImage(image, patch);
    }
    update(); return true;
  }
  /** Move several floating drawings by the same EMU offset in one undo step. */
  function moveMany(frames, dx, dy) {
    const moves = frames.map(f => { const at = offsets(f); return { image: f.image, start: f.start, end: f.end, x: at.x + dx, y: at.y + dy }; });
    if (viaHook({ type: 'moveMany', moves: moves.map(({ image, x, y }) => ({ image, x, y })) })) return true;
    const range = [...editor.model.range];
    return editor.execute(() => {
      for (const m of moves) { editor.model.select(m.start, m.end); editor.model.setImageProperties({ anchor: { x: m.x, y: m.y } }); }
      editor.model.select(...range);
    });
  }

  /* ---- Crop mode ---- */
  const cropHandles = HANDLES.map(handle => {
    const b = make('button', 'canvas-crop-handle', { type: 'button', 'aria-label': `Crop ${handle}`, 'data-crop': handle });
    listen(b, 'pointerdown', e => { e.stopPropagation(); begin(e, `crop-${handle}`); });
    listen(b, 'mousedown', e => e.preventDefault());
    cropFrame.append(b); return b;
  });
  void cropHandles;
  function startCrop() {
    if (crop) return true;
    const f = frame(); if (!f || !canCrop(f.image)) return false;
    const image = f.image, info = image.retainedDrawing ? editor.cropInfo?.(image) : null;
    const source = info || { crop: image.crop, flipH: !!image.flipH, flipV: !!image.flipV, assetId: image.assetId };
    const rect = { x: f.x, y: f.y, width: f.width, height: f.height };
    crop = { image, frame: f, flips: { flipH: !!source.flipH, flipV: !!source.flipV }, assetId: source.assetId, range: [...editor.model.range],
      offsets: f.floating ? offsets(f) : null, rect, full: uncroppedRect(rect, source.crop || {}, source), original: { ...rect }, originalCrop: { ...(source.crop || {}) } };
    crop.initialFull = { ...crop.full };
    update(); editor.focus(); editor.onSelection?.();
    return true;
  }
  function endCrop(commit = true) {
    if (!crop) return false;
    const state = crop; crop = null;
    if (gesture?.crop) gesture = null;
    const unchanged = ['x', 'y', 'width', 'height'].every(k => Math.abs(state.rect[k] - state.original[k]) < 1e-6 && Math.abs(state.full[k] - state.initialFull[k]) < 1e-6);
    if (commit && !unchanged && editor.model.selectedImage === state.image) {
      const next = cropFromRects(state.full, state.rect, state.flips);
      const patch = { crop: next, width: Math.max(1, Math.round(state.rect.width * EMU_PER_PX)), height: Math.max(1, Math.round(state.rect.height * EMU_PER_PX)) };
      if (state.offsets && (Math.abs(state.rect.x - state.original.x) > 1e-7 || Math.abs(state.rect.y - state.original.y) > 1e-7))
        patch.anchor = { x: state.offsets.x + Math.round((state.rect.x - state.original.x) * EMU_PER_PX), y: state.offsets.y + Math.round((state.rect.y - state.original.y) * EMU_PER_PX) };
      if (!viaHook({ type: 'crop', image: state.image, ...patch })) { editor.model.select(...state.range); editor.setImageProperties(patch); }
    }
    update(); editor.onSelection?.();
    return true;
  }
  function showCrop() {
    if (!crop) return;
    const { full, rect, frame: f } = crop, page = f.page;
    place(cropFrame, page, rect);
    // The whole picture shows dimmed around the part that is kept.
    const left = Math.min(full.x, rect.x), top = Math.min(full.y, rect.y);
    const union = { x: left, y: top, width: Math.max(full.x + full.width, rect.x + rect.width) - left, height: Math.max(full.y + full.height, rect.y + rect.height) - top };
    if (!place(cropPreview, page, union)) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1), scale = Math.min(ratio * editor.zoom, 2048 / Math.max(union.width, union.height));
    const width = Math.max(1, Math.round(union.width * scale)), height = Math.max(1, Math.round(union.height * scale));
    if (cropPreview.width !== width) cropPreview.width = width;
    if (cropPreview.height !== height) cropPreview.height = height;
    const ctx = cropPreview.getContext('2d'); if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.setTransform(scale, 0, 0, scale, -union.x * scale, -union.y * scale);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(full.x, full.y, full.width, full.height); ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    const bitmap = editor.images.get(crop.assetId), source = bitmap?.bitmap || bitmap;
    const paint = alpha => {
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.translate(full.x + (crop.flips.flipH ? full.width : 0), full.y + (crop.flips.flipV ? full.height : 0));
      ctx.scale(crop.flips.flipH ? -1 : 1, crop.flips.flipV ? -1 : 1);
      try { ctx.drawImage(source, 0, 0, full.width, full.height); } catch { ctx.fillStyle = '#c8ccd4'; ctx.fillRect(0, 0, full.width, full.height); }
      ctx.restore();
    };
    paint(.38);
    ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.width, rect.height); ctx.clip(); paint(1); ctx.restore();
  }
  const cropReady = () => crop && !gesture;
  editor.startCrop = startCrop;
  editor.endCrop = (commit = true) => endCrop(commit);
  Object.defineProperty(editor, 'cropActive', { configurable: true, get: () => !!crop });
  editor.cropAspect = ratio => {
    if (!(ratio > 0) || !crop && !startCrop()) return false;
    crop.rect = aspectRect(crop.full, ratio); update(); return true;
  };
  const fill = fit => {
    if (!crop && !startCrop()) return false;
    const natural = crop.full;
    crop.full = coverRect(crop.rect, { width: natural.width, height: natural.height }, fit);
    update(); return true;
  };
  editor.cropFill = () => fill(false);
  editor.cropFit = () => fill(true);

  /* ---- Buttons on the frame ---- */
  const button = (label, handle) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'canvas-image-handle'; b.setAttribute('aria-label', label);
    if (handle) b.dataset.handle = handle; else { b.className = 'canvas-image-move'; b.textContent = 'Move'; }
    // Edge handles carry their own placement, so they never cover a corner whatever the stylesheet.
    if (handle && !isCorner(handle)) Object.assign(b.style, EDGE_PLACES[handle]);
    listen(b, 'pointerdown', e => { e.stopPropagation(); begin(e, handle || 'move'); });
    listen(b, 'keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation(); const f = frame(); if (!f) return;
      const step = e.shiftKey ? 10 : 1, dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (handle) {
        if (!resizable(f.image)) return;
        if (f.image.aspectLocked === false && (!f.image.retainedDrawing || scenePicture(f.image))) {
          resizeImage(f.image, resizePatch(f, isCorner(handle) ? resizeImageFrame(f, handle, dx, dy) : resizeFromHandle(f, handle, dx, dy)));
        } else { const scale = Math.max(.01, 1 + (dx || dy) / Math.max(f.width, f.height)), width = Math.max(1, Math.round(f.image.width * scale)); resizeImage(f.image, { width, height: Math.max(1, Math.round(width * f.image.height / f.image.width)) }); }
      }
      else nudge(f, dx, dy);
    });
    overlay.append(b);
    return b;
  };
  button('Move selected image');
  for (const handle of HANDLES) button(`Resize image ${NAMES[handle]}`, handle);
  const rotateButton = make('button', 'canvas-image-rotate', { type: 'button', 'aria-label': 'Rotate image', title: 'Rotate (Shift snaps to 15°)' });
  Object.assign(rotateButton.style, { position: 'absolute', left: 'calc(50% - 9px)', top: '-34px', width: '18px', height: '18px' });
  Object.assign(optionsButton.style, { position: 'absolute', width: '24px', height: '24px' });
  rotateButton.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M11.8 2.2v2.9H8.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  listen(rotateButton, 'pointerdown', e => { e.stopPropagation(); begin(e, 'rotate'); });
  listen(rotateButton, 'keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const f = frame(); if (!f || !canRotate(f)) return;
    const step = e.shiftKey ? ROTATE_STEP : 1, rotation = rotationUnits(normalizedRotation(f.image.rotation) / ANGLE_PER_DEGREE + (e.key === 'ArrowLeft' ? -step : step));
    if (!viaHook({ type: 'rotate', image: f.image, rotation, delta: rotation - normalizedRotation(f.image.rotation) })) editor.setImageProperties({ rotation });
  });
  overlay.append(rotateButton);
  listen(optionsButton, 'mousedown', e => e.preventDefault());
  listen(optionsButton, 'pointerdown', e => e.stopPropagation());
  listen(optionsButton, 'click', () => editor.onLayoutOptions?.(optionsButton));

  /** Nudge the selection (and any drawings selected with it) by page pixels. */
  function nudge(f, dx, dy) {
    if (!f.floating) {
      const [start, end] = editor.model.range, stops = boundaries(editor.model.text);
      const target = dx < 0 || dy < 0 ? stops.findLast(p => p < start) : stops.find(p => p > end);
      if (target !== undefined) editor.execute(() => editor.model.moveImage(target));
      return;
    }
    const ex = Math.round(dx * EMU_PER_PX), ey = Math.round(dy * EMU_PER_PX), others = extraFrames();
    if (others.length) { moveMany([f, ...others], ex, ey); return; }
    const at = offsets(f); editor.setImageProperties({ anchor: { x: at.x + ex, y: at.y + ey } });
  }

  /** Keys in the document: arrows nudge a selected floating drawing; Enter and Escape finish cropping. */
  function keydown(e) {
    if (crop) {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); endCrop(e.key === 'Enter'); return true; }
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return false;
      endCrop(true);
      return false;
    }
    if (e.key === 'Escape' && extras.length) { setExtras([]); return false; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || e.metaKey || editor.readOnly || editor.session.path !== null) return false;
    const f = frame(); if (!f?.floating) return false;
    e.preventDefault();
    const step = e.shiftKey ? 10 : e.ctrlKey || e.altKey ? .1 : 1;
    nudge(f, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
    return true;
  }

  /** A press on the pages before ordinary selection: crop panning, ending a crop, and Shift+click selection. */
  function pointerDown(e) {
    if (e.button !== 0) return false;
    if (cropReady()) {
      const canvas = canvasOf(crop.frame.page), rect = canvas?.getBoundingClientRect();
      const x = rect ? (e.clientX - rect.left) / editor.zoom : NaN, y = rect ? (e.clientY - rect.top) / editor.zoom : NaN;
      const { full, rect: kept } = crop, inside = r => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
      if (inside(full) || inside(kept)) return begin(e, 'crop-pan');
      endCrop(true);
      return false;
    }
    if (!(e.shiftKey || e.ctrlKey || e.metaKey) || editor.readOnly || editor.session.path !== null) return false;
    const selected = frame(); if (!selected?.floating) return false;
    editor.point(e, false);
    const target = editor.pointImage;
    if (!target || !(editor.selectionLayout.floatingObjects || []).includes(target) || !isPositionedImage(target.image)) return false;
    e.preventDefault();
    if (target.image.id === selected.image.id) return true;
    primaryId = selected.image.id;
    setExtras(extras.includes(target.image.id) ? extras.filter(id => id !== target.image.id) : [...extras, target.image.id]);
    editor.focus();
    return true;
  }

  listen(window, 'keydown', e => { if (e.key === 'Escape' && cancel()) { e.preventDefault(); e.stopPropagation(); } });
  return { update, begin, move, end, cancel, keydown, pointerDown, startCrop, endCrop, get active() { return !!gesture; } };
}
