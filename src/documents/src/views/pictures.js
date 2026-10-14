/**
 * Picture Format, Shape Format and Arrange: the contextual tabs for pictures and shapes, the Layout tab's
 * Arrange group, the Format pane, Selection pane and Alt Text pane, the Size and Position dialog, and
 * the menu-bar and context-menu commands for drawings. Every change is a rewrite of the drawing's
 * DrawingML through drawing-format.js (one transaction, so it undoes in one step and saves as shown).
 */
import '../styles/pictures.css';
import '../styles/drawing-handles.css';
import { el, isComposing } from '../ui/dom.js';
import { commandIconEl } from '../ui/ribbon.js';
import { openMenu, closeMenu } from '../ui/menu.js';
import { toast } from '../ui/toast.js';
import { engineApi } from '../lib/engine-api.js';
import { drawShapeThumbnail } from '../ui/shape-controls.js';
import { galleryItems } from './insert-gallery.js';
import { formatDrawing, drawingKind, drawingParts } from '../engine/drawing-format.js';
import { describeDrawing, setFill, setOutline, setEffects, set3d, setGeometry, setTransform, setBlipEffects, setCrop, setBodyProperties, setDocProperties, writeFrame, readFrame, themeColors,
  child, childrenOf, A, WP, R } from '../engine/drawing-xml.js';
import { frameOf, offsetsFor, moveDrawings, alignmentMoves, POSITION_PRESETS, presetPosition } from '../engine/drawing-arrange.js';
import { groupDrawings, ungroupDrawing, groupUnavailable } from '../engine/drawing-groups.js';
import { EMU_PER_PX, isPositionedImage } from '../engine/images.js';
import { SHAPE_PRESETS, LINE_PRESETS } from '../engine/authored-shapes.js';
import { ARTISTIC_EFFECTS } from '../engine/picture-processing.js';
import * as presets from './picture-presets.js';
import { filteredThumb, processedThumb, styleThumb, shapeStyleThumb, positionThumb, pictureSource } from './picture-thumbnails.js';
import { processedEdit, compressEdit, changePictureEdit, restoreOriginal, readBakedLayer, bakedState, partPixels } from './picture-adjustments.js';
import { setImageWrap } from '../engine/image-wrap.js';
import { rasterize } from './insert-tab.js';
import { WORDART_STYLES } from '../engine/text-designs.js';

const PT = 12700, IN = 914400;
const runImages = model => model?.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image)) || [];

export function createPictures({ editor, pkg, error, onChange = () => {}, base = {} }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly && !engine.readOnly ? engine : null; };
  const selected = () => ready()?.model.selectedImage || null;
  const described = new WeakMap();
  /** What the selected drawing looks like, read from its XML (cached per drawing object). */
  const describe = image => {
    if (!image) return null;
    if (!described.has(image)) {
      let value = null;
      try { value = image.shell ? describeDrawing(image.shell) : { kind: 'picture', name: image.name, description: image.alt, frame: image.anchor ? null : { inline: true }, blip: { luminance: null, grayscale: false, duotone: null, biLevel: null, colorChange: null, alpha: image.opacity ?? 1, layer: null }, effects: { shadow: null, glow: null, softEdge: null, reflection: null }, outline: undefined, geometry: { preset: 'rect' }, transform: { rotation: (image.rotation || 0) / 60000, flipH: !!image.flipH, flipV: !!image.flipV }, threeD: { camera: null, bevel: null }, crop: image.crop || {} }; } catch { value = null; }
      described.set(image, value);
    }
    return described.get(image);
  };
  const kind = image => drawingKind(image);
  const isPicture = image => !!image && kind(image) === 'picture';
  const isShape = image => !!image && ['shape', 'textBox'].includes(kind(image));
  const formattable = image => !!image && ['picture', 'shape', 'textBox', 'group'].includes(kind(image)) && !image.anchor?.relativeSize;
  const theme = () => themeColors(pkg()?.parts || {});
  const palette = () => ({ ...presets.FALLBACK_THEME, ...(theme() || {}) });
  /** The drawings Arrange commands act on: the multi-selection, or the selected drawing. */
  const selection = () => {
    const engine = ready(); if (!engine) return [];
    const all = runImages(engine.model);
    const set = (engine.drawingSelection || []).filter(image => all.includes(image));
    return set.length > 1 ? set : selected() ? [selected()] : [];
  };
  const fail = e => { error(e instanceof Error ? e : new Error(String(e))); editor()?.focus(); };
  const friendly = (e, label) => /could not be created|pictures with|drawing|unsupported/i.test(e?.message || '') && !/Select|changed/.test(e.message)
    ? new Error(`${label}: this formatting is not available for this object yet.`) : e;

  /**
   * Rewrite the selected drawing (or `image`) with `edit(drawing, context)`; reports failures. Edits run
   * one after another, each on the drawing as the previous one left it, so quick successive commands
   * never race each other.
   */
  let queue = Promise.resolve();
  function apply(label, edit, image = selected()) {
    const id = image?.id;
    const run = async () => {
      const engine = ready(); if (!engine || id === undefined) return false;
      const all = runImages(engine.model), target = all.includes(image) ? image : all.find(i => i.id === id);
      if (!target) return false;
      try {
        const ok = await formatDrawing(engine, target, edit, { label });
        if (ok) { onChange(); refreshPanes(); }
        return ok;
      } catch (e) { fail(friendly(e, label)); return false; }
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }
  /** An edit of the drawing's shape properties (spPr / grpSpPr). */
  const props = fn => async (drawing, context) => {
    const parts = drawingParts(drawing);
    if (!parts.properties) throw new Error('This object has no shape properties to format.');
    return fn(parts.properties, parts, context);
  };
  const blipEdit = patch => async drawing => { const { blip } = drawingParts(drawing); if (!blip) throw new Error('Select a picture to adjust it.'); setBlipEffects(blip, patch); };

  /* ---- Picture and shape formatting commands ---- */
  const commands = {
    setLuminance: (brightness, contrast) => apply('Corrections', blipEdit({ luminance: { brightness, contrast } })),
    recolor: patch => apply('Color', blipEdit(patch)),
    setTransparency: transparency => {
      const image = selected();
      if (isPicture(image)) return apply('Transparency', blipEdit({ alpha: 1 - transparency }));
      return apply('Transparency', props(sp => {
        const fill = child(sp, A, 'solidFill'), color = fill?.firstElementChild;
        if (!color) throw new Error('Give the shape a solid fill to make it transparent.');
        for (const node of childrenOf(color, A, ['alpha'])) node.remove();
        if (transparency > 0) { const alpha = sp.ownerDocument.createElementNS(A, 'a:alpha'); alpha.setAttribute('val', String(Math.round((1 - transparency) * 100000))); color.append(alpha); }
      }));
    },
    processed: (label, change) => apply(label, processedEdit(change)),
    pictureStyle: style => apply('Picture Styles', props((sp, parts) => {
      setGeometry(sp, style.geometry || 'rect');
      setOutline(sp, null);
      if (style.outline) setOutline(sp, { color: style.outline.color, width: style.outline.width, compound: style.outline.compound || 'sng', dash: 'solid' });
      setEffects(sp, { shadow: style.effects?.shadow ? { ...style.effects.shadow, color: '000000' } : null, glow: style.effects?.glow ? { ...style.effects.glow, color: themedColor(style.effects.glow.color) } : null,
        softEdge: style.effects?.softEdge || null, reflection: style.effects?.reflection || null });
      set3d(sp, { bevel: style.bevel || null, camera: style.bevel ? 'orthographicFront' : null });
      setTransform(sp, { rotation: style.rotation || 0 });
    })),
    outline: (patch, label = 'Outline') => apply(label, props(sp => setOutline(sp, patch))),
    fill: (fill, label = 'Shape Fill') => apply(label, props(sp => setFill(sp, fill))),
    effects: (patch, label = 'Effects') => apply(label, props(sp => setEffects(sp, patch))),
    threeD: (patch, label = '3-D') => apply(label, props(sp => set3d(sp, patch))),
    geometry: (preset, label = 'Change Shape') => apply(label, props(sp => setGeometry(sp, preset))),
    shapeStyle: style => apply('Shape Styles', props(sp => {
      setFill(sp, style.fill); setOutline(sp, null);
      if (style.outline) setOutline(sp, style.outline);
      setEffects(sp, { shadow: style.effects?.shadow ? { ...style.effects.shadow, color: '000000' } : null, glow: null, softEdge: null, reflection: null });
    })),
    body: (patch, label = 'Text Box') => apply(label, async drawing => { const { body } = drawingParts(drawing); if (!body) throw new Error('This shape has no text.'); setBodyProperties(body, patch); }),
    altText: ({ description, title, decorative }) => apply('Alt Text', async drawing => { const { docPr } = drawingParts(drawing); setDocProperties(docPr, { description, title, decorative }); }),
    rename: (image, name) => apply('Rename', async drawing => { setDocProperties(drawingParts(drawing).docPr, { name }); }, image),
    setHidden: (image, hidden) => apply(hidden ? 'Hide' : 'Show', async drawing => { const { docPr } = drawingParts(drawing); if (hidden) docPr.setAttribute('hidden', '1'); else docPr.removeAttribute('hidden'); }, image),
    rotate: (degrees, label = 'Rotate') => rotateBy(degrees, label),
    flip: axis => flip(axis),
    resetPicture: (size = false) => apply(size ? 'Reset Picture & Size' : 'Reset Picture', async drawing => {
      const { blip, blipFill, properties, frame } = drawingParts(drawing);
      if (!blip) throw new Error('Select a picture to reset it.');
      restoreOriginal(blip);
      setBlipEffects(blip, { luminance: null, grayscale: false, duotone: null, biLevel: null, colorChange: null, alpha: 1 });
      setGeometry(properties, 'rect'); setOutline(properties, null);
      setEffects(properties, { shadow: null, glow: null, softEdge: null, reflection: null });
      set3d(properties, { bevel: null, camera: null }); setTransform(properties, { rotation: 0, flipH: false, flipV: false });
      if (size) {
        setCrop(blipFill, {});
        const natural = naturalSize();
        if (natural) resizeFrame(frame, properties, natural.width, natural.height);
      }
    }),
  };
  const themedColor = color => typeof color === 'object' && color?.scheme ? (theme() ? color : presets.resolveColor(color, palette())) : color;
  /** The picture's pixel size at 96 pixels per inch, kept within the text column. */
  function naturalSize() {
    const engine = ready(); if (!engine) return null;
    const source = pictureSource(engine, selected());
    if (!source?.width) return null;
    const page = engine.model.pageSettings, column = Math.max(IN, (page.width - page.left - page.right) * 635);
    const scale = Math.min(1, column / (source.width * EMU_PER_PX));
    return { width: Math.round(source.width * EMU_PER_PX * scale), height: Math.round(source.height * EMU_PER_PX * scale) };
  }
  function resizeFrame(frame, properties, width, height) {
    const extent = child(frame, WP, 'extent'); extent.setAttribute('cx', String(Math.round(width))); extent.setAttribute('cy', String(Math.round(height)));
    const ext = child(child(properties, A, 'xfrm'), A, 'ext');
    if (ext) { ext.setAttribute('cx', String(Math.round(width))); ext.setAttribute('cy', String(Math.round(height))); }
  }
  async function rotateBy(degrees, label) {
    const image = selected(), engine = ready(); if (!engine || !image) return false;
    if (!image.retainedDrawing && image.kind !== 'chart' && !image.shell && formattableModel(image)) {
      engine.finishComposition();
      return engine.execute(() => engine.model.setImageProperties({ rotation: (((image.rotation || 0) + degrees * 60000) % 21600000 + 21600000) % 21600000 }));
    }
    return apply(label, props(sp => { const t = describe(image)?.transform || { rotation: 0 }; setTransform(sp, { rotation: t.rotation + degrees }); }));
  }
  const formattableModel = image => !image.anchor || isPositionedImage(image);
  async function flip(axis) {
    const image = selected(); if (!image) return false;
    const t = describe(image)?.transform || {};
    return apply(axis === 'flipH' ? 'Flip Horizontal' : 'Flip Vertical', props(sp => setTransform(sp, { [axis]: !t[axis] })));
  }

  /* ---- Size ---- */
  const sizeOf = (image, key) => image ? Math.round(image[key] / IN * 100) / 100 : null;
  async function setSize(key, inches, { keepAspect } = {}) {
    const image = selected(), engine = ready(); if (!engine || !image) return false;
    const value = Math.max(1, Math.round(inches * IN)), other = key === 'width' ? 'height' : 'width';
    const locked = keepAspect ?? (image.aspectLocked !== false && (isPicture(image) || image.aspectLocked));
    const patch = { [key]: value, [other]: locked && image[key] ? Math.max(1, Math.round(value * image[other] / image[key])) : image[other] };
    if (patch.width > 22 * IN || patch.height > 22 * IN) { fail(new Error('Sizes must be at most 22 inches.')); return false; }
    if (!image.retainedDrawing && !image.shell) { engine.finishComposition(); return engine.execute(() => engine.model.setImageProperties(patch)); }
    return apply('Size', props((sp, parts) => resizeFrame(parts.frame, sp, patch.width, patch.height)));
  }

  /* ---- Arrange: wrap, position, order, align, group, rotate ---- */
  const wrapModeOf = image => {
    if (!image) return null;
    const frame = describe(image)?.frame;
    if (!image.anchor || frame?.inline) return 'inline';
    const type = frame?.wrap?.type || image.anchor.wrap;
    if (type === 'none') return image.anchor.behind ? 'behind' : 'front';
    return type;
  };
  /** Where a drawing that leaves the line should float: its current place, in column/paragraph offsets. */
  function inlinePlace(engine, image) {
    const layout = engine.selectionLayout || engine.layout, lines = [...layout.lines, ...(layout.repeatedLines || [])];
    const [start] = engine.model.range;
    const line = lines.find(l => l.fragments.some(f => f.image === image || (f.image && f.start === start)));
    const fragment = line?.fragments.find(f => f.image === image || (f.image && f.start === start));
    if (!line || !fragment) return { x: 0, y: 0 };
    const page = layout.pages?.[line.page] || layout.page;
    const top = Math.min(...lines.filter(l => l.paragraphId === line.paragraphId && l.page === line.page).map(l => l.y));
    return { x: Math.max(0, Math.round((fragment.x - (line.columnLeft ?? page.left)) * EMU_PER_PX)), y: Math.max(0, Math.round((line.y - top) * EMU_PER_PX)) };
  }
  async function setWrap(mode) {
    const image = selected(), engine = ready(); if (!engine || !image) return false;
    if (!formattable(image)) {
      // Charts and diagrams keep their graphic; their frame changes through the model.
      engine.finishComposition();
      return engine.execute(() => setImageWrap(engine.model, mode === 'tight' || mode === 'through' ? 'square' : mode, mode !== 'inline' && !image.anchor ? inlinePlace(engine, image) : undefined));
    }
    const current = wrapModeOf(image);
    if (current === mode) return false;
    const place = !image.anchor ? inlinePlace(engine, image) : null;
    const anchor = image.anchor;
    // Wrapped drawings measure from the column and paragraph; keep the drawing where it is on the page.
    let position = null;
    if (mode !== 'inline' && anchor && ['square', 'tight', 'through', 'topAndBottom'].includes(mode) && (anchor.horizontal !== 'column' || anchor.vertical !== 'paragraph' || anchor.xAlign || anchor.yAlign || anchor.xPercentage !== undefined || anchor.yPercentage !== undefined)) {
      const f = frameOf(engine, image);
      if (f) {
        const zero = offsetsFor(engine, { ...f, image: { ...image, anchor: { ...anchor, horizontal: 'column', vertical: 'paragraph' } } }, f.x, f.y);
        position = { horizontal: { relativeFrom: 'column', offset: zero.x }, vertical: { relativeFrom: 'paragraph', offset: Math.max(0, zero.y) } };
      }
    }
    if (mode === 'topAndBottom' && anchor && !position && anchor.y < 0) position = { vertical: { relativeFrom: 'paragraph', offset: 0 } };
    const order = Math.max(0, ...runImages(engine.model).map(i => i.anchor?.order || 0)) + 1;
    return apply('Wrap Text', async drawing => {
      if (mode === 'inline') { writeFrame(drawing, { inline: true }); return; }
      const wrap = { type: mode === 'behind' || mode === 'front' ? 'none' : mode, side: 'bothSides' };
      const spec = { wrap, behind: mode === 'behind', ...(position || {}) };
      if (place) Object.assign(spec, { horizontal: { relativeFrom: 'column', offset: place.x }, vertical: { relativeFrom: 'paragraph', offset: place.y }, order });
      writeFrame(drawing, spec);
    });
  }
  async function setMoveWithText(move) {
    const image = selected(), engine = ready(); if (!engine || !image?.anchor) return false;
    const f = frameOf(engine, image); if (!f) return false;
    const target = move ? 'paragraph' : 'page';
    const at = offsetsFor(engine, { ...f, image: { ...image, anchor: { ...image.anchor, vertical: target } } }, f.x, f.y);
    return apply(move ? 'Move with Text' : 'Fix Position on Page', async drawing => writeFrame(drawing, { vertical: { relativeFrom: target, offset: at.y } }));
  }
  async function positionPreset(preset) {
    const image = selected(), engine = ready(); if (!engine || !image) return false;
    if (!formattable(image)) { fail(new Error('This object keeps its position.')); return false; }
    const page = engine.layout.pages?.[engine.caretPageIndex ?? 0] || engine.layout.page;
    const frame = image.anchor ? frameOf(engine, image) : null;
    const size = { width: image.width / EMU_PER_PX, height: image.height / EMU_PER_PX };
    const target = presetPosition(page, size, preset);
    let place;
    if (frame) {
      const at = offsetsFor(engine, { ...frame, image: { ...image, anchor: { ...image.anchor, horizontal: 'column', vertical: 'paragraph' } } }, target.x, target.y);
      place = at;
    } else {
      const layout = engine.selectionLayout || engine.layout;
      const line = layout.lines.find(l => l.fragments.some(f => f.image === image));
      const top = line ? Math.min(...layout.lines.filter(l => l.paragraphId === line.paragraphId && l.page === line.page).map(l => l.y)) : page.top;
      place = { x: Math.round((target.x - (line?.columnLeft ?? page.left)) * EMU_PER_PX), y: Math.round((target.y - top) * EMU_PER_PX) };
    }
    const order = image.anchor?.order ?? Math.max(0, ...runImages(engine.model).map(i => i.anchor?.order || 0)) + 1;
    return apply('Position', async drawing => writeFrame(drawing, { horizontal: { relativeFrom: 'column', offset: place.x }, vertical: { relativeFrom: 'paragraph', offset: place.y },
      wrap: { type: 'square', side: 'bothSides', distances: { T: 0, B: 0, L: 114300, R: 114300 } }, behind: false, order }));
  }
  function arrange(direction) {
    const engine = ready(), image = selected(); if (!engine || !image) return false;
    engine.finishComposition();
    if (!isPositionedImage(image)) {
      if (direction === 'inFront' || direction === 'behind') return setWrap(direction === 'behind' ? 'behind' : 'front');
      fail(new Error('Set the object\'s text wrapping to arrange it in layers.')); return false;
    }
    if ((direction === 'inFront' || direction === 'behind') && image.anchor.wrap !== 'none') return setWrap(direction === 'behind' ? 'behind' : 'front');
    const ok = engine.execute(() => engine.model.arrangeImage(direction));
    engine.focus(); refreshPanes(); return ok;
  }
  function align(mode, relativeTo) {
    const engine = ready(), images = selection(); if (!engine || !images.length) return false;
    try {
      const target = relativeTo || (images.length > 1 ? alignTo : alignTo === 'selected' ? 'margin' : alignTo);
      if (images.some(image => !isPositionedImage(image))) throw new Error('Only floating objects can be aligned. Set their text wrapping first.');
      const moves = alignmentMoves(engine, images, mode, target);
      engine.finishComposition();
      const ok = engine.execute(() => moveDrawings(engine.model, moves));
      engine.focus(); return ok;
    } catch (e) { fail(e); return false; }
  }
  let alignTo = 'margin';
  let lastGroup = null;
  async function group() {
    const engine = ready(), images = selection(); if (!engine) return false;
    try { const ok = await groupDrawings(engine, images); if (ok) { engine.setDrawingSelection?.([]); onChange(); refreshPanes(); } return ok; } catch (e) { fail(e); return false; }
  }
  async function ungroup() {
    const engine = ready(), image = selected(); if (!engine || !image) return false;
    try {
      const ids = await ungroupDrawing(engine, image);
      if (ids) { lastGroup = ids; const images = runImages(engine.model).filter(i => ids.includes(i.id)); engine.setDrawingSelection?.(images); onChange(); refreshPanes(); }
      return !!ids;
    } catch (e) { fail(e); return false; }
  }
  async function regroup() {
    const engine = ready(); if (!engine || !lastGroup) return false;
    const images = runImages(engine.model).filter(i => lastGroup.includes(i.id));
    try { const ok = await groupDrawings(engine, images); if (ok) { lastGroup = null; onChange(); } return ok; } catch (e) { fail(e); return false; }
  }

  /* ---- Remove Background, Compress Pictures, Change Picture, Set Transparent Color ---- */
  async function removeBackgroundCommand() {
    const engine = ready(), image = selected(); if (!engine || !isPicture(image)) return;
    try {
      const { materializeDrawing } = await import('../engine/drawing-format.js');
      const { drawing, parts } = materializeDrawing(pkg(), engine.model, image);
      const { blip } = drawingParts(drawing);
      const layer = readBakedLayer(blip), relId = layer?.relId || blip.getAttributeNS(R, 'embed');
      const part = parts.get(relId);
      if (!part?.bytes || !/^image\/(png|jpeg|gif|bmp|webp|tiff)$/.test(part.contentType)) throw new Error('Remove Background works on PNG, JPEG, GIF, BMP and TIFF pictures.');
      const pixels = await partPixels(part.bytes, part.contentType);
      const state = bakedState(layer);
      const { openRemoveBackground } = await import('./remove-background.js');
      openRemoveBackground({ image: pixels, initial: state.background ? { keep: state.background.keep, remove: state.background.remove, region: state.background.region } : {},
        onApply: ({ mask, marks }) => { if (selected() === image) commands.processed('Remove Background', { background: { ...marks, mask } }); },
        onCancel: () => editor()?.focus() });
    } catch (e) { fail(e); }
  }
  async function compressPictures() {
    const engine = ready(); if (!engine) return;
    const { openCompressDialog } = await import('./picture-dialogs.js');
    openCompressDialog({ selectedOnly: isPicture(selected()), onApply: async ({ ppi, deleteCropped, selectedOnly }) => {
      const engine = ready(); if (!engine) return;
      const targets = selectedOnly ? [selected()] : runImages(engine.model).filter(isPicture);
      let count = 0;
      for (const image of targets) {
        const current = runImages(engine.model).find(i => i.id === image.id) || image;
        try { if (await formatDrawing(engine, current, compressEdit({ ppi, deleteCropped }), { label: 'Compress' })) count++; } catch (e) { fail(friendly(e, 'Compress Pictures')); break; }
      }
      toast(count ? `Compressed ${count} ${count === 1 ? 'picture' : 'pictures'}.` : 'The pictures are already at that resolution.');
      onChange();
    } });
  }
  const pictureInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml', hidden: true, 'aria-label': 'Change picture file', onchange: async () => {
    const file = pictureInput.files?.[0]; pictureInput.value = '';
    if (!file) return;
    try {
      let bytes = new Uint8Array(await file.arrayBuffer()), mime = file.type, width, height;
      if (!/^image\/(png|jpeg)$/.test(mime)) ({ png: bytes, width, height } = await rasterize(file, 4096)), mime = 'image/png';
      else { const bitmap = await createImageBitmap(file); width = bitmap.width; height = bitmap.height; bitmap.close(); }
      await apply('Change Picture', changePictureEdit({ bytes, mime, width, height }));
    } catch (e) { fail(e); }
  } });
  let transparentPick = null;
  function setTransparentColor() {
    const engine = ready(), image = selected(); if (!engine || !isPicture(image)) return;
    const source = pictureSource(engine, image);
    if (!source) { fail(new Error('The picture is not loaded yet.')); return; }
    transparentPick?.();
    toast('Click a color in the picture to make it transparent. Press Escape to cancel.');
    const host = engine.host;
    host.classList.add('pic-picking');
    const done = () => { host.classList.remove('pic-picking'); window.removeEventListener('pointerdown', onPick, true); window.removeEventListener('keydown', onKey, true); transparentPick = null; };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } };
    const onPick = e => {
      const frame = host.querySelector('.canvas-image-frame');
      if (!frame || frame.hidden) { done(); return; }
      const box = frame.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) { done(); return; }
      e.preventDefault(); e.stopPropagation();
      const crop = image.crop || {};
      const u = (e.clientX - box.left) / box.width, v = (e.clientY - box.top) / box.height;
      const sx = ((crop.left || 0) + u * (100000 - (crop.left || 0) - (crop.right || 0))) / 100000, sy = ((crop.top || 0) + v * (100000 - (crop.top || 0) - (crop.bottom || 0))) / 100000;
      const probe = new OffscreenCanvas(1, 1).getContext('2d');
      probe.drawImage(source, Math.floor((image.flipH ? 1 - sx : sx) * source.width), Math.floor((image.flipV ? 1 - sy : sy) * source.height), 1, 1, 0, 0, 1, 1);
      const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
      const rgb = [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase();
      done();
      apply('Set Transparent Color', blipEdit({ colorChange: { from: rgb, to: { rgb, alpha: 0 } } }));
    };
    window.addEventListener('pointerdown', onPick, true); window.addEventListener('keydown', onKey, true);
    transparentPick = done;
  }

  /* ---- Crop ---- */
  async function cropToShape(preset) { return commands.geometry(preset, 'Crop to Shape'); }
  async function cropAspect(ratio) {
    const image = selected(); if (!isPicture(image)) return false;
    const engine = ready();
    if (engine?.cropAspect) { engine.cropAspect(ratio); return true; }
    const source = pictureSource(engine, image);
    const pixelRatio = source ? source.width / source.height : image.width / image.height;
    return apply('Aspect Ratio', props((sp, parts) => {
      const crop = {};
      if (pixelRatio > ratio) crop.left = crop.right = Math.round((1 - ratio / pixelRatio) / 2 * 100000);
      else crop.top = crop.bottom = Math.round((1 - pixelRatio / ratio) / 2 * 100000);
      setCrop(parts.blipFill, crop);
      resizeFrame(parts.frame, sp, image.width, Math.round(image.width / ratio));
    }));
  }
  async function cropFillFit(mode) {
    const image = selected(), engine = ready(); if (!isPicture(image) || !engine) return false;
    if (mode === 'fill' && engine.cropFill) { engine.cropFill(); return true; }
    if (mode === 'fit' && engine.cropFit) { engine.cropFit(); return true; }
    const source = pictureSource(engine, image);
    const pixelRatio = source ? source.width / source.height : 1, frameRatio = image.width / image.height;
    return apply(mode === 'fill' ? 'Fill' : 'Fit', props((sp, parts) => {
      const crop = {};
      if (mode === 'fill') {
        if (pixelRatio > frameRatio) crop.left = crop.right = Math.round((1 - frameRatio / pixelRatio) / 2 * 100000);
        else crop.top = crop.bottom = Math.round((1 - pixelRatio / frameRatio) / 2 * 100000);
      } else if (pixelRatio > frameRatio) crop.top = crop.bottom = -Math.round((pixelRatio / frameRatio - 1) / 2 * 100000);
      else crop.left = crop.right = -Math.round((frameRatio / pixelRatio - 1) / 2 * 100000);
      setCrop(parts.blipFill, crop);
    }));
  }

  /* ---- Panes and dialogs ---- */
  const paneHost = el('div.pic-pane-host');
  let pane = null;
  function closePane() { pane?.close(); pane = null; }
  function refreshPanes() { queueMicrotask(() => pane?.refresh?.()); }
  async function openPane(which, section) {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    if (pane?.kind === which) { pane.show?.(section); pane.refresh?.(); return; }
    closePane();
    const context = { editor, pkg, ready, selected, describe, kind, isPicture, isShape, commands, apply, props, palette, theme, onClose: () => { pane = null; editor()?.focus(); onLayout(); },
      selection, arrange, setSize, sizeOf, error: fail, refreshPanes, setWrap, openSizePosition: tab => openSizePosition(tab), pickColor, openAltText: () => openPane('altText'), runImages };
    const module = which === 'format' ? await import('./format-pane.js') : which === 'selection' ? await import('./selection-pane.js') : await import('./alt-text-pane.js');
    pane = module.createPane(context);
    pane.kind = which;
    paneHost.replaceChildren(pane.node);
    pane.show?.(section);
    onLayout();
  }
  async function openSizePosition(tab = 'position') {
    const engine = ready(), image = selected(); if (!engine || !image) return;
    engine.finishComposition();
    const { openLayoutDialog } = await import('./size-position.js');
    openLayoutDialog({ engine, image, describe, tab, kind: kind(image), apply: async (edit, label) => {
      // Failures are shown in the dialog, which stays open.
      const engine = ready(), current = engine?.model.selectedImage;
      if (!current) throw new Error('Select the object again.');
      const ok = await formatDrawing(engine, current, edit, { label });
      if (ok) { onChange(); refreshPanes(); }
      return ok;
    }, frameOf: () => frameOf(engine, image), offsetsFor: (f, x, y) => offsetsFor(engine, f, x, y), place: () => inlinePlace(engine, image), onClose: () => editor()?.focus() });
  }
  let onLayout = () => {};

  /* ---- Menus ---- */
  const radio = (label, checked, onSelect, extra = {}) => ({ label, radio: true, checked: !!checked, onSelect, ...extra });
  const editable = () => !!ready();
  function colorItems({ label, value, onPick, none = null, more = [] }) {
    const pal = palette(), hasTheme = !!theme();
    const swatch = (name, color, hex) => el('button.swatch', { type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': name, title: name, style: { background: `#${hex}` },
      onclick: () => { closeMenu(); onPick(color); } });
    const themeGrid = el('div.menu-custom-grid.pic-palette', { role: 'group', 'aria-label': 'Theme Colors', dataset: { columns: '10' } },
      ...['lt1', 'dk1', 'lt2', 'dk2', ...presets.ACCENTS].map(name => swatch(`${presets.THEME_NAMES[name]}`, hasTheme ? { scheme: name } : pal[name], pal[name])),
      ...presets.THEME_VARIANTS.flatMap(([variant, mod, off]) => ['lt1', 'dk1', 'lt2', 'dk2', ...presets.ACCENTS].map(name => {
        // Light 1 darkens and Dark 1 lightens, like the base colours they modify.
        const [m, o] = name === 'lt1' ? [100000 - (100000 - mod) / 3 - 5000, 0] : [mod, off];
        const color = hasTheme ? { scheme: name, lumMod: m, lumOff: o } : presets.resolveColor({ scheme: name, lumMod: m, lumOff: o }, pal);
        return swatch(`${presets.THEME_NAMES[name]}, ${variant}`, color, presets.resolveColor({ scheme: name, lumMod: m, lumOff: o }, pal));
      })));
    const standard = el('div.menu-custom-grid.pic-palette', { role: 'group', 'aria-label': 'Standard Colors', dataset: { columns: '10' } }, ...presets.STANDARD_COLORS.map(([name, hex]) => swatch(name, hex, hex)));
    const current = value && typeof value === 'object' && value.rgb ? value.rgb : typeof value === 'string' ? value : null;
    const hex = el('input.input.color-hex', { type: 'text', value: `#${current && /^[0-9A-F]{6}$/i.test(current) ? current : '000000'}`, 'aria-label': `Custom ${label.toLowerCase()} hex value`, maxLength: 7, spellcheck: false });
    const native = el('input.color-input', { type: 'color', value: hex.value, 'aria-label': `Custom ${label.toLowerCase()}`, oninput: () => { hex.value = native.value.toUpperCase(); } });
    const form = el('form.menu-custom-color', { onsubmit: e => { e.preventDefault(); const v = hex.value.trim().replace(/^#/, ''); if (/^[0-9a-f]{6}$/i.test(v)) { closeMenu(); onPick(v.toUpperCase()); } else hex.setCustomValidity('Enter a hex color, such as #123456.'); } },
      el('span.menu-label', {}, 'More Colors'), native, hex, el('button.btn.btn-outline.btn-sm', { type: 'submit', 'aria-label': `Apply custom ${label.toLowerCase()}` }, 'Apply'));
    return [{ header: 'Theme Colors' }, { custom: themeGrid }, { header: 'Standard Colors' }, { custom: standard },
      ...(none ? [{ separator: true }, { label: none, icon: 'x', onSelect: () => onPick('none') }] : []),
      { separator: true }, { custom: form }, ...more];
  }
  function pickColor(anchor, label, value, onPick, none) {
    return openMenu({ anchor, label, className: 'pic-color-menu', minWidth: 260, items: colorItems({ label, value, onPick, none }), onClose: () => editor()?.focus() });
  }
  const weightItems = (current, onPick) => presets.LINE_WEIGHTS.map(([label, width]) => ({ label, radio: true, checked: current === width, onSelect: () => onPick(width) }));
  const dashItems = (current, onPick) => presets.DASHES.map(([label, dash]) => ({ label, radio: true, checked: current === dash, onSelect: () => onPick(dash) }));
  function outlineItems(label) {
    const image = selected(), info = describe(image), line = info?.outline;
    const color = line?.color;
    return [...colorItems({ label, value: color && typeof color === 'object' ? color : null, none: 'No Outline', onPick: c => commands.outline(c === 'none' ? { color: 'none' } : { color: c, ...(line?.width ? {} : { width: PT }) }, label) }),
      { separator: true },
      { label: 'Weight', icon: 'lineWeight', items: weightItems(line?.color && line.color !== 'none' ? line.width : null, width => commands.outline({ width, ...(line?.color && line.color !== 'none' ? {} : { color: '000000' }) }, label)) },
      { label: 'Dashes', items: dashItems(line?.dash || 'solid', dash => commands.outline({ dash, ...(line?.color && line.color !== 'none' ? {} : { color: '000000', width: PT }) }, label)) },
      ...(isShape(image) || LINE_PRESETS.has(engineApi()?.selectedShape?.(ready())?.params?.preset) ? [{ label: 'Arrows', items: presets.ARROWS.map(([name, head, tail]) => ({ label: name, onSelect: () => commands.outline({ headEnd: head, tailEnd: tail, ...(line?.color && line.color !== 'none' ? {} : { color: '000000', width: PT }) }, label) })) }] : []),
      { separator: true }, { label: 'More Lines…', onSelect: () => openPane('format', 'line') }];
  }
  function shadowItems(label) {
    const current = describe(selected())?.effects?.shadow;
    return [...presets.SHADOW_PRESETS.map(([name, shadow]) => radio(name, shadow ? !!current && Math.abs(current.direction - shadow.direction) < 1 && Math.abs(current.distance - shadow.distance) < 2000 && Math.abs(current.blur - shadow.blur) < 2000 : !current, () => commands.effects({ shadow: shadow ? { ...shadow, color: '000000' } : null }, label))),
      { separator: true }, { label: 'Shadow Options…', onSelect: () => openPane('format', 'effects') }];
  }
  function reflectionItems(label) {
    const current = describe(selected())?.effects?.reflection;
    return [...presets.REFLECTION_PRESETS.map(([name, value]) => radio(name, value ? !!current && Math.abs(current.endPosition - value.endPosition) < 2000 && Math.abs(current.distance - value.distance) < 2000 : !current, () => commands.effects({ reflection: value }, label))),
      { separator: true }, { label: 'Reflection Options…', onSelect: () => openPane('format', 'effects') }];
  }
  function glowItems(label) {
    const current = describe(selected())?.effects?.glow, pal = palette(), hasTheme = !!theme();
    const grid = el('div.menu-custom-grid.pic-glow-grid', { role: 'group', 'aria-label': 'Glow variations', dataset: { columns: '6' } },
      ...presets.GLOW_SIZES.flatMap(size => presets.ACCENTS.map(name => {
        const hex = presets.resolveColor({ scheme: name }, pal);
        return el('button.swatch.pic-glow-swatch', { type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': `Glow: ${size} pt; ${presets.THEME_NAMES[name]}`, title: `Glow: ${size} pt; ${presets.THEME_NAMES[name]}`,
          style: { boxShadow: `0 0 ${Math.min(8, size / 2)}px ${Math.min(5, size / 3)}px #${hex}99` }, onclick: () => { closeMenu(); commands.effects({ glow: { radius: size * PT, color: hasTheme ? { scheme: name } : hex, alpha: 0.6 } }, label); } });
      })));
    return [radio('No Glow', !current, () => commands.effects({ glow: null }, label)), { header: 'Glow Variations' }, { custom: grid },
      { label: 'More Glow Colors', items: colorItems({ label: 'Glow Color', value: null, onPick: c => commands.effects({ glow: { radius: (current?.radius || 8 * PT), color: c, alpha: 0.6 } }, label) }) },
      { separator: true }, { label: 'Glow Options…', onSelect: () => openPane('format', 'effects') }];
  }
  function softEdgeItems(label) {
    const current = describe(selected())?.effects?.softEdge;
    return [...presets.SOFT_EDGE_PRESETS.map(([name, points]) => radio(name, points ? Math.abs((current?.radius || 0) - points * PT) < 1000 : !current, () => commands.effects({ softEdge: points ? { radius: points * PT } : null }, label))),
      { separator: true }, { label: 'Soft Edges Options…', onSelect: () => openPane('format', 'effects') }];
  }
  function bevelItems(label) {
    const current = describe(selected())?.threeD?.bevel;
    return [...presets.BEVEL_PRESETS.map(([name, bevel]) => radio(name, bevel ? current?.preset === bevel.preset && Math.abs(current.width - bevel.width) < 1000 : !current, () => commands.threeD({ bevel }, label))),
      { separator: true }, { label: '3-D Options…', onSelect: () => openPane('format', 'effects') }];
  }
  function rotation3dItems(label) {
    const current = describe(selected())?.threeD?.camera || 'orthographicFront';
    return [...presets.ROTATION_3D_PRESETS.map(([name, camera]) => radio(name, current === camera, () => commands.threeD({ camera }, label))),
      { separator: true }, { label: '3-D Rotation Options…', onSelect: () => openPane('format', 'effects') }];
  }
  function effectsItems(label, { picture = true } = {}) {
    return [
      { label: 'Shadow', icon: 'shadowEffect', items: shadowItems(label) },
      { label: 'Reflection', icon: 'reflectionEffect', items: reflectionItems(label) },
      { label: 'Glow', icon: 'glowEffect', items: glowItems(label) },
      { label: 'Soft Edges', icon: 'softEdges', items: softEdgeItems(label) },
      ...(picture ? [{ label: 'Bevel', icon: 'bevelEffect', items: bevelItems(label) }, { label: '3-D Rotation', icon: 'rotate3d', items: rotation3dItems(label) }] : []),
    ];
  }
  function correctionItems() {
    const engine = ready(), image = selected(), source = pictureSource(engine, image), info = describe(image);
    const lum = info?.blip?.luminance || { brightness: 0, contrast: 0 }, state = currentProcessed(image);
    return [...galleryItems([
      { header: 'Sharpen/Soften', columns: 5, items: presets.SHARPEN_PRESETS.map(([label, amount]) => ({ label, selected: Math.abs((state.sharpen || 0) - amount) < 0.01, preview: filteredThumb(source, amount < 0 ? `blur(${-amount * 2}px)` : amount > 0 ? `contrast(${1 + amount * 0.6})` : 'none'), onSelect: () => commands.processed('Sharpen/Soften', { sharpen: amount || null }) })) },
      { header: 'Brightness/Contrast', columns: 5, items: presets.BRIGHTNESS_CONTRAST.map(p => ({ label: p.label, selected: Math.abs(lum.brightness - p.brightness) < 0.01 && Math.abs(lum.contrast - p.contrast) < 0.01, preview: filteredThumb(source, `brightness(${1 + p.brightness}) contrast(${1 + p.contrast})`, { width: 52, height: 40 }), onSelect: () => commands.setLuminance(p.brightness, p.contrast) })) },
    ], { size: 'small', label: 'Corrections' }), { separator: true }, { label: 'Picture Corrections Options…', onSelect: () => openPane('format', 'picture') }];
  }
  const currentProcessed = image => { try { const { blip } = describe(image) || {}; return blip?.layer ? bakedStateFromLayer(blip.layer) : {}; } catch { return {}; } };
  const bakedStateFromLayer = layer => bakedState(layer);
  function colorMenuItems() {
    const engine = ready(), image = selected(), source = pictureSource(engine, image), info = describe(image), state = currentProcessed(image);
    const recolor = presets.recolorPresets(palette()), blip = info?.blip || {};
    const recolorId = blip.grayscale ? 'grayscale' : blip.biLevel !== null && blip.biLevel !== undefined ? `bw${Math.round(blip.biLevel * 100)}` : blip.duotone ? null : blip.luminance && Math.abs(blip.luminance.brightness - 0.7) < 0.01 ? 'washout' : 'none';
    const recolorPreview = p => p.grayscale ? filteredThumb(source, 'grayscale(1)', { width: 48, height: 36 }) : p.biLevel ? processedThumb(source, img => thresholdPixels(img, p.biLevel), { width: 48, height: 36 })
      : p.duotone ? processedThumb(source, img => duotonePixels(img, p.duotone), { width: 48, height: 36 }) : p.luminance ? filteredThumb(source, 'brightness(1.6) contrast(0.35)', { width: 48, height: 36 }) : filteredThumb(source, 'none', { width: 48, height: 36 });
    return [...galleryItems([
      { header: 'Color Saturation', columns: 7, items: presets.SATURATION_PRESETS.map(([label, factor]) => ({ label, selected: Math.abs((state.saturation ?? 1) - factor) < 0.01, preview: filteredThumb(source, `saturate(${factor})`, { width: 48, height: 36 }), onSelect: () => commands.processed('Color Saturation', { saturation: factor === 1 ? null : factor }) })) },
      { header: 'Color Tone', columns: 7, items: presets.TEMPERATURE_PRESETS.map(([label, kelvin]) => ({ label, selected: Math.abs((state.temperature ?? 6500) - kelvin) < 1, preview: filteredThumb(source, kelvin < 6500 ? `sepia(${(6500 - kelvin) / 6000}) saturate(1.2)` : kelvin > 6500 ? `hue-rotate(${(kelvin - 6500) / 200}deg) saturate(1.1)` : 'none', { width: 48, height: 36 }), onSelect: () => commands.processed('Color Tone', { temperature: kelvin === 6500 ? null : kelvin }) })) },
      { header: 'Recolor', columns: 7, items: [...recolor.basic, ...recolor.dark, ...recolor.light].map(p => ({ label: p.label, selected: p.id === recolorId, preview: recolorPreview(p.patch), onSelect: () => commands.recolor(p.patch) })) },
    ], { size: 'small', label: 'Color' }),
    { separator: true },
    { label: 'More Variations', items: colorItems({ label: 'Recolor', value: null, onPick: c => commands.recolor({ grayscale: false, biLevel: null, duotone: ['000000', typeof c === 'object' ? presets.resolveColor(c, palette()) : c] }) }) },
    { label: 'Set Transparent Color', icon: 'transparentColor', onSelect: setTransparentColor },
    { label: 'Picture Color Options…', onSelect: () => openPane('format', 'picture') }];
  }
  function thresholdPixels(img, threshold) {
    const out = new Uint8ClampedArray(img.data);
    for (let i = 0; i < out.length; i += 4) { const v = (0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2]) / 255 >= threshold ? 255 : 0; out[i] = out[i + 1] = out[i + 2] = v; }
    return { data: out, width: img.width, height: img.height };
  }
  function duotonePixels(img, [dark, light]) {
    const [d, l] = [dark, light].map(h => h.match(/../g).map(c => parseInt(c, 16)));
    const out = new Uint8ClampedArray(img.data);
    for (let i = 0; i < out.length; i += 4) { const y = (0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2]) / 255; for (let c = 0; c < 3; c++) out[i + c] = d[c] + (l[c] - d[c]) * y; }
    return { data: out, width: img.width, height: img.height };
  }
  function artisticItems() {
    const engine = ready(), image = selected(), source = pictureSource(engine, image), state = currentProcessed(image);
    return [...galleryItems([{ columns: 4, items: [{ label: 'None', selected: !state.artistic, preview: filteredThumb(source, 'none'), onSelect: () => commands.processed('Artistic Effects', { artistic: null }) },
      ...ARTISTIC_EFFECTS.map(effect => ({ label: effect.name, selected: state.artistic?.id === effect.id, preview: processedThumb(source, img => effect.apply(img, 0.5)), onSelect: () => commands.processed('Artistic Effects', { artistic: { id: effect.id, amount: 0.5 } }) }))] }], { size: 'small', label: 'Artistic Effects' }),
    { separator: true }, { label: 'Artistic Effects Options…', onSelect: () => openPane('format', 'picture') }];
  }
  function transparencyItems() {
    const engine = ready(), image = selected(), source = pictureSource(engine, image), current = 1 - (describe(image)?.blip?.alpha ?? 1);
    return [...galleryItems([{ columns: 7, items: presets.TRANSPARENCY_PRESETS.map(([label, t]) => ({ label, selected: Math.abs(current - t) < 0.01, preview: filteredThumb(source, 'none', { width: 48, height: 36, alpha: 1 - t }), onSelect: () => commands.setTransparency(t) })) }], { size: 'small', label: 'Transparency' }),
      { separator: true }, { label: 'Picture Transparency Options…', onSelect: () => openPane('format', 'picture') }];
  }
  function wrapItems() {
    const image = selected(), mode = wrapModeOf(image), ok = !!image && editable();
    const chartLike = !!image && !formattable(image);
    const option = (label, value, icon) => ({ label, icon, radio: true, checked: mode === value, disabled: !ok || chartLike && !['inline', 'square', 'topAndBottom', 'behind', 'front'].includes(value), onSelect: () => setWrap(value) });
    const vertical = image?.anchor && describe(image)?.frame?.vertical?.relativeFrom;
    const canFix = !!image?.anchor && image.anchor.wrap === 'none';
    return [option('In Line with Text', 'inline', 'wrapInline'), option('Square', 'square', 'wrapSquare'), option('Tight', 'tight', 'wrapTight'), option('Through', 'through', 'wrapThrough'),
      option('Top and Bottom', 'topAndBottom', 'wrapTopBottom'), option('Behind Text', 'behind', 'behindText'), option('In Front of Text', 'front', 'inFront'),
      { separator: true },
      { label: 'Move with Text', radio: true, checked: !!image?.anchor && vertical !== 'page', disabled: !canFix, hint: canFix ? undefined : 'For objects in front of or behind text', onSelect: () => setMoveWithText(true) },
      { label: 'Fix Position on Page', radio: true, checked: !!image?.anchor && vertical === 'page', disabled: !canFix, onSelect: () => setMoveWithText(false) },
      { separator: true }, { label: 'More Layout Options…', icon: 'position', disabled: !ok, onSelect: () => openSizePosition('wrapping') }];
  }
  function positionItems() {
    const image = selected(), ok = !!image && editable() && formattable(image);
    const grid = el('div.menu-custom-grid.pic-position-grid', { role: 'group', 'aria-label': 'With Text Wrapping', dataset: { columns: '3' } },
      ...POSITION_PRESETS.map(preset => el('button.swatch.pic-position-item', { type: 'button', role: 'menuitem', tabindex: -1, disabled: !ok, 'aria-label': `Position in ${preset[1]} with Square Text Wrapping`, title: `Position in ${preset[1]} with Square Text Wrapping`,
        onclick: () => { closeMenu(); positionPreset(preset); } }, positionThumb(preset[2], preset[3]))));
    return [{ label: 'In Line with Text', radio: true, checked: wrapModeOf(image) === 'inline', disabled: !ok, onSelect: () => setWrap('inline') }, { header: 'With Text Wrapping' }, { custom: grid },
      { separator: true }, { label: 'More Layout Options…', disabled: !image || !editable(), onSelect: () => openSizePosition('position') }];
  }
  const floating = () => !!selected() && isPositionedImage(selected()) && editable();
  const forwardItems = () => [{ label: 'Bring Forward', icon: 'bringForward', disabled: !floating(), onSelect: () => arrange('forward') }, { label: 'Bring to Front', icon: 'bringToFront', disabled: !floating(), onSelect: () => arrange('front') },
    { label: 'Bring in Front of Text', icon: 'inFront', disabled: !selected() || !editable(), onSelect: () => arrange('inFront') }];
  const backwardItems = () => [{ label: 'Send Backward', icon: 'sendBackward', disabled: !floating(), onSelect: () => arrange('backward') }, { label: 'Send to Back', icon: 'sendToBack', disabled: !floating(), onSelect: () => arrange('back') },
    { label: 'Send Behind Text', icon: 'behindText', disabled: !selected() || !editable(), onSelect: () => arrange('behind') }];
  function alignItems() {
    const images = selection(), ok = editable() && images.length > 0 && images.every(isPositionedImage), many = images.length > 1;
    const item = (label, mode, icon) => ({ label, icon, disabled: !ok || mode.startsWith('distribute') && !many && alignTo === 'selected', onSelect: () => align(mode) });
    const engine = ready();
    return [item('Align Left', 'left', 'objAlignLeft'), item('Align Center', 'center', 'objAlignCenter'), item('Align Right', 'right', 'objAlignRight'), { separator: true },
      item('Align Top', 'top', 'objAlignTop'), item('Align Middle', 'middle', 'objAlignMiddle'), item('Align Bottom', 'bottom', 'objAlignBottom'), { separator: true },
      item('Distribute Horizontally', 'distributeHorizontal', 'distributeH'), item('Distribute Vertically', 'distributeVertical', 'distributeV'), { separator: true },
      radio('Align to Page', alignTo === 'page', () => { alignTo = 'page'; }), radio('Align to Margin', alignTo === 'margin', () => { alignTo = 'margin'; }),
      radio('Align Selected Objects', alignTo === 'selected', () => { alignTo = 'selected'; }, { disabled: !many }), { separator: true },
      { label: 'View Gridlines', checked: !!engine?.host?.classList.contains('pic-gridlines'), disabled: !engine, onSelect: () => toggleGridlines() },
      { label: 'Grid Settings…', disabled: !engine, onSelect: () => openGridSettings() }];
  }
  let gridSize = 0.125;
  function toggleGridlines() {
    const engine = editor(); if (!engine) return;
    const on = !engine.host.classList.contains('pic-gridlines');
    engine.host.classList.toggle('pic-gridlines', on);
    engine.host.style.setProperty('--pic-grid', `${gridSize * 96 * (engine.zoom || 1)}px`);
    engine.gridSize = on ? gridSize * 96 : 0;
  }
  async function openGridSettings() {
    const { openGridDialog } = await import('./picture-dialogs.js');
    openGridDialog({ value: gridSize, snap: !!editor()?.snapToGrid, onApply: ({ size, snap }) => { gridSize = size; const engine = editor(); if (engine) { engine.snapToGrid = snap; engine.gridSize = engine.host.classList.contains('pic-gridlines') || snap ? size * 96 : 0; engine.host.style.setProperty('--pic-grid', `${size * 96 * (engine.zoom || 1)}px`); } } });
  }
  function groupItems() {
    const images = selection(), image = selected();
    const reason = groupUnavailable(images);
    return [{ label: 'Group', icon: 'groupObjects', disabled: !editable() || !!reason, hint: images.length > 1 && reason ? reason : undefined, onSelect: group },
      { label: 'Ungroup', icon: 'ungroupObjects', disabled: !editable() || kind(image) !== 'group', onSelect: ungroup },
      { label: 'Regroup', disabled: !editable() || !lastGroup, onSelect: regroup }];
  }
  function rotateItems() {
    const image = selected(), ok = editable() && !!image && image.kind !== 'chart' && (formattable(image) || !image.retainedDrawing);
    return [{ label: 'Rotate Right 90°', icon: 'rotateRight', disabled: !ok, onSelect: () => rotateBy(90, 'Rotate') }, { label: 'Rotate Left 90°', icon: 'rotateLeft', disabled: !ok, onSelect: () => rotateBy(-90, 'Rotate') },
      { label: 'Flip Vertical', icon: 'flipVertical', disabled: !ok, onSelect: () => (image.shell || image.retainedDrawing ? flip('flipV') : flipModel('flipV')) },
      { label: 'Flip Horizontal', icon: 'flipHorizontal', disabled: !ok, onSelect: () => (image.shell || image.retainedDrawing ? flip('flipH') : flipModel('flipH')) },
      { separator: true }, { label: 'More Rotation Options…', disabled: !ok, onSelect: () => openSizePosition('size') }];
  }
  function flipModel(key) { const engine = ready(); if (!engine) return; engine.finishComposition(); engine.execute(() => engine.model.setImageProperties({ [key]: !engine.model.selectedImage[key] })); engine.focus(); }
  function cropItems() {
    const image = selected(), ok = editable() && isPicture(image), engine = ready();
    const shapes = el('div.menu-custom-grid.shape-gallery', { role: 'group', 'aria-label': 'Crop to Shape', dataset: { columns: '8' } },
      ...SHAPE_PRESETS.filter(([preset, , group]) => !LINE_PRESETS.has(preset) && ['Rectangles', 'Basic Shapes', 'Block Arrows', 'Stars and Banners', 'Flowchart'].includes(group)).slice(0, 48).map(([preset, name]) => {
        const canvas = el('canvas', { 'aria-hidden': 'true' }); drawShapeThumbnail(canvas, preset);
        return el('button.shape-gallery-item', { type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': name, title: name, disabled: !ok, onclick: () => { closeMenu(); cropToShape(preset); } }, canvas);
      }));
    return [{ label: 'Crop', icon: 'crop', disabled: !ok || !engine?.startCrop, onSelect: () => engine.startCrop() },
      { label: 'Crop to Shape', icon: 'shapes', disabled: !ok, items: [{ custom: shapes }] },
      { label: 'Aspect Ratio', disabled: !ok, items: presets.ASPECT_RATIOS.map(([label, ratio]) => ({ label, onSelect: () => cropAspect(ratio) })) },
      { separator: true }, { label: 'Fill', disabled: !ok, onSelect: () => cropFillFit('fill') }, { label: 'Fit', disabled: !ok, onSelect: () => cropFillFit('fit') }];
  }
  function changeShapeItems() {
    const image = selected(), ok = editable() && isShape(image);
    const groups = [...new Set(SHAPE_PRESETS.map(([, , g]) => g))].filter(g => g !== 'Lines');
    return [{ label: 'Change Shape', icon: 'shapes', disabled: !ok, items: groups.flatMap(group => [{ header: group }, { custom: el('div.menu-custom-grid.shape-gallery', { role: 'group', 'aria-label': group, dataset: { columns: '8' } },
      ...SHAPE_PRESETS.filter(([, , g]) => g === group).map(([preset, name]) => {
        const canvas = el('canvas', { 'aria-hidden': 'true' }); drawShapeThumbnail(canvas, preset);
        return el('button.shape-gallery-item', { type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': name, title: name, onclick: () => { closeMenu(); commands.geometry(preset); } }, canvas);
      })) }]), submenuMinWidth: 300 }];
  }
  function fillItems(label = 'Shape Fill') {
    const image = selected(), info = describe(image), fill = info?.fill;
    const baseColor = fill?.type === 'solid' && fill.color ? (fill.color.scheme ? { scheme: fill.color.scheme } : { rgb: fill.color.rgb }) : theme() ? { scheme: 'accent1' } : { rgb: palette().accent1 };
    const pal = palette();
    const gradientGrid = el('div.menu-custom-grid.pic-gradient-grid', { role: 'group', 'aria-label': 'Gradients', dataset: { columns: '3' } },
      ...presets.GRADIENT_PRESETS.map(([name, make]) => { const g = make(baseColor); return el('button.swatch.pic-fill-swatch', { type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': name, title: name, onclick: () => { closeMenu(); commands.fill(g, label); } }, shapeStyleThumb({ fill: g }, pal, { width: 40, height: 30 })); }));
    const patterns = el('div.menu-custom-grid.pic-gradient-grid', { role: 'group', 'aria-label': 'Patterns', dataset: { columns: '4' } },
      ...presets.PATTERN_PRESETS.map(([name, preset]) => el('button.swatch.pic-pattern-swatch', { type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': `Pattern: ${name}`, title: name, dataset: { pattern: preset },
        onclick: () => { closeMenu(); commands.fill({ type: 'pattern', preset, foreground: baseColor.rgb ? baseColor.rgb : baseColor, background: 'FFFFFF' }, label); } })));
    return [...colorItems({ label, value: fill?.type === 'solid' ? fill.color : null, none: 'No Fill', onPick: c => commands.fill(c === 'none' ? { type: 'none' } : { type: 'solid', color: c }, label) }),
      { label: 'Picture…', icon: 'pictures', onSelect: () => fillPictureInput.click() },
      { label: 'Gradient', icon: 'gradientFill', items: [{ custom: gradientGrid }, { separator: true }, { label: 'No Gradient', onSelect: () => commands.fill({ type: 'solid', color: baseColor.rgb || baseColor }, label) }, { label: 'More Gradients…', onSelect: () => openPane('format', 'fill') }] },
      { label: 'Pattern', icon: 'patternFill', items: [{ custom: patterns }, { separator: true }, { label: 'More Patterns…', onSelect: () => openPane('format', 'fill') }] }];
  }
  const fillPictureInput = el('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true, 'aria-label': 'Shape picture fill file', onchange: async () => {
    const file = fillPictureInput.files?.[0]; fillPictureInput.value = '';
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    apply('Picture Fill', props((sp, parts, context) => { const relId = context.addPart(bytes, file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 'canvas-fill'); setFill(sp, { type: 'picture', relId }); }));
  } });
  /* WordArt styles on shape text: run properties of the text box's runs. */
  async function textEdit(label, patch) {
    return apply(label, async drawing => {
      const { shape } = drawingParts(drawing);
      const content = shape?.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'txbxContent')[0];
      if (!content) throw new Error('This shape has no text.');
      const { setTextRunEffects } = await import('../engine/drawing-text-effects.js');
      setTextRunEffects(content, patch);
    });
  }
  function textFillItems() { return colorItems({ label: 'Text Fill', value: null, none: 'No Fill', onPick: c => textEdit('Text Fill', { fill: c === 'none' ? 'none' : presets.resolveColor(c, palette()) }) }); }
  function textOutlineItems() {
    return [...colorItems({ label: 'Text Outline', value: null, none: 'No Outline', onPick: c => textEdit('Text Outline', { outline: c === 'none' ? 'none' : { color: presets.resolveColor(c, palette()), width: 9525 } }) }),
      { separator: true }, { label: 'Weight', items: presets.LINE_WEIGHTS.map(([label, width]) => ({ label, onSelect: () => textEdit('Text Outline', { outline: { width } }) })) }];
  }
  function textEffectItems() {
    return [{ label: 'Shadow', items: [{ label: 'No Shadow', onSelect: () => textEdit('Text Effects', { shadow: 'none' }) }, ...presets.SHADOW_PRESETS.slice(1, 10).map(([name, s]) => ({ label: name, onSelect: () => textEdit('Text Effects', { shadow: { distance: s.distance, direction: s.direction, blur: s.blur, alpha: s.alpha } }) }))] }];
  }
  function wordArtGallery() {
    return (galleryItems([{ columns: 4, items: WORDART_STYLES.map(style => ({ label: style.name, preview: el('span.pic-wordart-sample', { style: { color: `#${style.run.fill && style.run.fill !== 'none' ? style.run.fill : style.run.color}`, WebkitTextStroke: style.run.outline ? `1px #${style.run.outline.color}` : null, textShadow: style.run.shadow ? '1px 1px 1px rgba(0,0,0,.4)' : null } }, 'A'),
      onSelect: () => textEdit('WordArt Styles', { color: style.run.color, fill: style.run.fill || 'none-reset', outline: style.run.outline ? { color: style.run.outline.color, width: style.run.outline.width } : 'none', shadow: style.run.shadow ? { distance: style.run.shadow.distance ?? 38100, direction: 45, blur: 38100, alpha: style.run.shadow.alpha, color: style.run.shadow.color } : 'none' }) })) }], { size: 'small', label: 'WordArt Styles' }));
  }
  function alignTextItems() {
    const current = describe(selected())?.body?.anchor || 't';
    return [['Top', 't', 'alignTopLeft'], ['Middle', 'ctr', 'alignMiddleCenter'], ['Bottom', 'b', 'alignBottomRight']].map(([label, value, icon]) => ({ label, icon, radio: true, checked: current === value, disabled: !editable() || !describe(selected())?.body, onSelect: () => commands.body({ anchor: value }, 'Align Text') }));
  }
  function resetItems() {
    const ok = editable() && isPicture(selected());
    return [{ label: 'Reset Picture', icon: 'resetPicture', disabled: !ok, onSelect: () => commands.resetPicture(false) }, { label: 'Reset Picture & Size', disabled: !ok, onSelect: () => commands.resetPicture(true) }];
  }
  function changePictureItems() {
    const ok = editable() && isPicture(selected());
    return [{ label: 'From a File…', icon: 'folderOpen', disabled: !ok, onSelect: () => pictureInput.click() },
      ...(base.pictureFromCloud ? [{ label: 'From Puter…', disabled: !ok, onSelect: () => base.pictureFromCloud(async file => { pictureInput.files; const transfer = new DataTransfer(); transfer.items.add(file); pictureInput.files = transfer.files; pictureInput.dispatchEvent(new Event('change')); }) }] : [])];
  }

  /* ---- Ribbon ---- */
  function drawingTabs(kit) {
    const { command, menuButton, split, rows, when, engineReady } = kit;
    const has = () => !!selected() && editable();
    const pic = () => editable() && isPicture(selected());
    const shapeOk = () => editable() && isShape(selected());
    const formattableOk = () => editable() && formattable(selected());
    const states = [];
    const track = (control, enabled, pressed) => { when(control, enabled, pressed); states.push(control); return control; };
    const splitMenu = (main, label, items) => split(main, { label, size: 'large', open: (anchor, e) => openMenu({ anchor, label, items: kit.inDocument(items()), minWidth: 220, pointer: !!e?.detail, onClose: e?.detail ? kit.focusEditor : null }) });

    /* Arrange (shared by the three tabs: each tab gets its own controls) */
    const arrangeGroup = (id, priority) => {
      const position = menuButton('Position', 'position', positionItems);
      const wrap = menuButton('Wrap Text', 'wrapText', wrapItems);
      const forwardMain = command('Bring Forward', 'bringForward', () => arrange('forward'), { text: 'Bring Forward' });
      const backwardMain = command('Send Backward', 'sendBackward', () => arrange('backward'), { text: 'Send Backward' });
      const smallSplit = (main, label, items) => split(main, { label, size: 'small', open: (anchor, e) => openMenu({ anchor, label, items: kit.inDocument(items()), minWidth: 220, pointer: !!e?.detail, onClose: e?.detail ? kit.focusEditor : null }) });
      const forward = smallSplit(forwardMain, 'Bring Forward options', forwardItems), backward = smallSplit(backwardMain, 'Send Backward options', backwardItems);
      const pane = command('Selection Pane', 'selectionPane', () => openPane('selection'), { size: 'small', text: 'Selection Pane' });
      const alignButton = menuButton('Align', 'objAlignLeft', alignItems, { size: 'small', text: 'Align' });
      const groupButton = menuButton('Group', 'groupObjects', groupItems, { size: 'small', text: 'Group' });
      const rotate = menuButton('Rotate', 'rotate', rotateItems, { size: 'small', text: 'Rotate' });
      track(position, () => has() && formattable(selected())); track(wrap, has);
      track(forwardMain, floating); track(backwardMain, floating); track(forward.arrow, has); track(backward.arrow, has);
      track(pane, () => !!ready() && engineReady()); track(alignButton, () => selection().length > 0 && editable()); track(groupButton, () => editable() && (selection().length > 1 || kind(selected()) === 'group' || !!lastGroup));
      track(rotate, () => has() && selected()?.kind !== 'chart');
      return { id, label: 'Arrange', icon: 'wrapText', priority, items: [position, wrap, rows([forward], [backward], [pane]), rows([alignButton], [groupButton], [rotate])] };
    };
    const sizeGroup = (id, priority, { crop = false, noun = 'Picture' } = {}) => {
      const spin = (key, label) => {
        const input = el('input.canvas-spacing.ribbon-number', { type: 'number', step: 0.01, min: 0.01, max: 22, 'aria-label': `${noun} ${label.toLowerCase()} (in)`,
          onchange: () => { if (!input.checkValidity() || input.value === '') { input.reportValidity(); return; } setSize(key, Number(input.value)); },
          onkeydown: e => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); input.dispatchEvent(new Event('change')); } } });
        states.push(input);
        sizeInputs.push({ input, key });
        return el('label.ribbon-spin', { title: label }, kit.commandIconEl(key === 'height' ? 'shapeHeight' : 'shapeWidth', 16), el('span.ribbon-spin-label.visually-hidden', {}, label), input, el('span.ribbon-spin-unit', {}, 'in'));
      };
      const launcher = command('Size and Position…', 'pageSetup', () => openSizePosition('size'));
      track(launcher, has);
      const items = [];
      if (crop) {
        const cropMain = command('Crop', 'crop', () => ready()?.startCrop?.(), { size: 'large', text: 'Crop' });
        const cropSplit = splitMenu(cropMain, 'Crop options', cropItems);
        track(cropMain, () => pic() && !!ready()?.startCrop); track(cropSplit.arrow, pic);
        items.push(cropSplit);
      }
      items.push(el('div.ribbon-spin-group', {}, spin('height', 'Height'), spin('width', 'Width')), el('div.ribbon-launcher', {}, launcher));
      return { id, label: 'Size', icon: 'shapeHeight', priority, items };
    };
    const altText = () => { const b = command('Alt Text', 'altText', () => openPane('altText'), { size: 'large', text: 'Alt Text' }); track(b, has); return b; };

    /* Picture Format */
    const removeBg = command('Remove Background', 'removeBackground', removeBackgroundCommand, { size: 'large', text: 'Remove Background' });
    const corrections = menuButton('Corrections', 'corrections', correctionItems);
    const color = menuButton('Color', 'pictureColor', colorMenuItems);
    const artistic = menuButton('Artistic Effects', 'artisticEffects', artisticItems, { text: 'Artistic Effects' });
    const transparency = menuButton('Transparency', 'transparency', transparencyItems, { size: 'small', text: null });
    const compress = command('Compress Pictures', 'compressPictures', compressPictures, { text: null });
    const change = menuButton('Change Picture', 'changePicture', changePictureItems, { size: 'small', text: null });
    const reset = menuButton('Reset Picture', 'resetPicture', resetItems, { size: 'small', text: null });
    for (const control of [removeBg, corrections, color, artistic, transparency, change, reset]) track(control, pic);
    track(compress, () => editable() && runImages(ready()?.model).some(isPicture));
    const pictureGallery = el('div.ribbon-gallery.pic-style-gallery', { role: 'listbox', 'aria-label': 'Picture Styles', 'aria-orientation': 'horizontal', dataset: { shrinkMin: '2', shrinkMax: '400' } });
    const pictureStyleButtons = presets.PICTURE_STYLES.map(style => {
      const button = el('button.pic-style-item', { type: 'button', role: 'option', title: style.name, 'aria-label': style.name, 'aria-selected': 'false', onclick: () => commands.pictureStyle(style) });
      button.addEventListener('mousedown', e => e.preventDefault());
      states.push(button);
      return { style, button };
    });
    pictureGallery.append(...pictureStyleButtons.map(i => i.button));
    const pictureStylesMore = command('More Picture Styles', 'more', e => openMenu({ anchor: pictureStylesMore, label: 'Picture Styles', pointer: !!e?.detail, onClose: kit.focusEditor,
      items: kit.inDocument(galleryItems([{ columns: 5, items: presets.PICTURE_STYLES.map(style => ({ label: style.name, preview: styleThumb(pictureSource(ready(), selected()), style, palette()), onSelect: () => commands.pictureStyle(style) })) }], { size: 'small', label: 'Picture Styles' })) }));
    pictureStylesMore.classList.add('ribbon-gallery-more');
    track(pictureStylesMore, pic);
    const border = menuButton('Picture Border', 'pictureBorder', () => outlineItems('Picture Border'), { size: 'small', text: 'Picture Border' });
    const effects = menuButton('Picture Effects', 'pictureEffects', () => effectsItems('Picture Effects'), { size: 'small', text: 'Picture Effects' });
    const pictureLayout = menuButton('Picture Layout', 'smartArt', () => [{ note: 'Arrange pictures with captions in a diagram: use Insert → Diagram and place the picture beside it.' }], { size: 'small', text: 'Picture Layout' });
    for (const control of [border, effects]) track(control, pic);
    track(pictureLayout, () => false);
    const pictureLauncher = command('Format Picture', 'formattingPane', () => openPane('format'));
    track(pictureLauncher, has);
    const picture = [
      { id: 'adjust', label: 'Adjust', icon: 'corrections', priority: 7, items: [removeBg, corrections, color, artistic, rows([transparency], [compress], [change]), rows([reset])] },
      { id: 'pictureStyles', label: 'Picture Styles', icon: 'pictureBorder', priority: 6, items: [el('div.ribbon-gallery-frame', {}, pictureGallery, pictureStylesMore), rows([border], [effects], [pictureLayout]), el('div.ribbon-launcher', {}, pictureLauncher)] },
      { id: 'pictureAccessibility', label: 'Accessibility', icon: 'altText', priority: 4, items: [altText()] },
      arrangeGroup('pictureArrange', 8),
      sizeGroup('size', 7, { crop: true }),
    ];

    /* Shape Format */
    const shapesButton = command('Shapes', 'shapes', e => base.openShapes?.(shapesButton, e), { size: 'large', caret: true, attrs: { 'aria-haspopup': 'menu' } });
    track(shapesButton, () => engineReady() && !!base.openShapes);
    const editShape = menuButton('Edit Shape', 'editShape', changeShapeItems, { size: 'small', text: 'Edit Shape' });
    const textBox = command('Draw Text Box', 'textBox', () => base.insertTextBox?.(), { size: 'small', text: 'Text Box' });
    const editText = command('Edit Text', 'drawingText', () => base.editShapeText?.(), { size: 'small', text: 'Edit Text' });
    track(editShape, shapeOk); track(textBox, () => engineReady() && !!base.insertTextBox);
    track(editText, () => editable() && kind(selected()) === 'textBox' && !!base.editShapeText);
    const shapeGallery = el('div.ribbon-gallery.pic-shape-gallery', { role: 'listbox', 'aria-label': 'Shape Styles', 'aria-orientation': 'horizontal', dataset: { shrinkMin: '3', shrinkMax: '360' } });
    const quickShapeStyles = () => presets.shapeStyles(!!theme()).filter(s => s.color !== 'dk1' && ['outline', 'fill', 'light', 'intense'].includes(s.kind)).filter((s, i) => i < 7 || s.color === 'accent1' || s.color === 'accent2');
    const shapeStyleButtons = [];
    const renderShapeGallery = () => {
      const pal = palette();
      shapeStyleButtons.length = 0;
      shapeGallery.replaceChildren(...quickShapeStyles().slice(0, 12).map(style => {
        const button = el('button.pic-shape-style', { type: 'button', role: 'option', title: style.name, 'aria-label': style.name, onclick: () => commands.shapeStyle(style) }, shapeStyleThumb(style, pal, { width: 42, height: 34, text: 'Abc' }));
        button.addEventListener('mousedown', e => e.preventDefault());
        shapeStyleButtons.push(button);
        return button;
      }));
    };
    renderShapeGallery();
    const shapeStylesMore = command('More Shape Styles', 'more', e => openMenu({ anchor: shapeStylesMore, label: 'Shape Styles', pointer: !!e?.detail, onClose: kit.focusEditor,
      items: kit.inDocument(galleryItems(presets.SHAPE_STYLE_KINDS.map(k => ({ header: k.name, columns: 7, items: presets.shapeStyles(!!theme()).filter(s => s.kind === k.id).map(style => ({ label: style.name, preview: shapeStyleThumb(style, palette(), { width: 36, height: 28, text: 'Abc' }), onSelect: () => commands.shapeStyle(style) })) })), { size: 'small', label: 'Shape Styles' })) }));
    shapeStylesMore.classList.add('ribbon-gallery-more');
    track(shapeStylesMore, () => editable() && (isShape(selected())));
    const fillButton = menuButton('Shape Fill', 'shapeFill', () => fillItems('Shape Fill'), { size: 'small', text: 'Shape Fill' });
    const outlineButton = menuButton('Shape Outline', 'shapeOutline', () => outlineItems('Shape Outline'), { size: 'small', text: 'Shape Outline' });
    const shapeEffects = menuButton('Shape Effects', 'shapeEffects', () => effectsItems('Shape Effects', { picture: false }), { size: 'small', text: 'Shape Effects' });
    for (const control of [fillButton, outlineButton, shapeEffects]) track(control, shapeOk);
    const shapeLauncher = command('Format Shape', 'formattingPane', () => openPane('format'));
    track(shapeLauncher, has);
    const wordArtQuick = menuButton('Quick Styles', 'wordArt', () => wordArtGallery(), { text: 'Quick Styles' });
    const textFill = menuButton('Text Fill', 'textColor', textFillItems, { size: 'small', text: 'Text Fill' });
    const textOutline = menuButton('Text Outline', 'textOutline', textOutlineItems, { size: 'small', text: 'Text Outline' });
    const textEffects = menuButton('Text Effects', 'textEffects', textEffectItems, { size: 'small', text: 'Text Effects' });
    const hasText = () => editable() && kind(selected()) === 'textBox';
    for (const control of [wordArtQuick, textFill, textOutline, textEffects]) track(control, hasText);
    const alignText = menuButton('Align Text', 'alignMiddleCenter', alignTextItems, { size: 'small', text: 'Align Text' });
    track(alignText, () => editable() && !!describe(selected())?.body);
    const shape = [
      { id: 'insertShapes', label: 'Insert Shapes', icon: 'shapes', priority: 5, items: [shapesButton, rows([editShape], [textBox], [editText])] },
      { id: 'shapeStyles', label: 'Shape Styles', icon: 'shapeFill', priority: 8, items: [el('div.ribbon-gallery-frame', {}, shapeGallery, shapeStylesMore), rows([fillButton], [outlineButton], [shapeEffects]), el('div.ribbon-launcher', {}, shapeLauncher)] },
      { id: 'wordArtStyles', label: 'WordArt Styles', icon: 'wordArt', priority: 4, items: [wordArtQuick, rows([textFill], [textOutline], [textEffects])] },
      { id: 'shapeText', label: 'Text', icon: 'alignMiddleCenter', priority: 3, items: [rows([alignText])] },
      { id: 'shapeAccessibility', label: 'Accessibility', icon: 'altText', priority: 2, items: [altText()] },
      arrangeGroup('shapeArrange', 6),
      sizeGroup('shapeSize', 7, { noun: 'Shape' }),
    ];
    const layoutArrange = arrangeGroup('arrange', 3);
    const refresh = () => {
      const image = selected(), pic = isPicture(image) ? pictureSource(ready(), image) : null, pal = palette();
      const signature = `${image?.assetId}:${image?.id}`;
      if (signature !== drawnFor) {
        drawnFor = signature;
        for (const { style, button } of pictureStyleButtons) button.replaceChildren(styleThumb(pic, style, pal, { width: 52, height: 42 }));
      }
      for (const { input, key } of sizeInputs) if (document.activeElement !== input) { const v = sizeOf(image, key); input.value = v === null ? '' : String(v); input.disabled = !has() || !(formattableOk() || (image && !image.retainedDrawing)); }
      for (const { button } of pictureStyleButtons) button.disabled = !pic && !isPicture(image) || !editable();
      for (const button of shapeStyleButtons) button.disabled = !shapeOk();
    };
    let drawnFor = '';
    refreshRibbon = refresh;
    return { picture, shape, layoutArrange };
  }
  const sizeInputs = [];
  let refreshRibbon = () => {};

  /* ---- Menu bar and context menu ---- */
  function extendMenu(menuId) {
    if (menuId === 'format') {
      const image = selected();
      return [{ separator: true },
        { label: isPicture(image) ? 'Picture…' : isShape(image) ? 'Shape…' : 'Object…', icon: 'formattingPane', disabled: !image || !editable(), onSelect: () => openPane('format') },
        { label: 'Arrange', items: [...forwardItems(), ...backwardItems(), { separator: true }, ...alignItems().slice(0, 9)] },
        { label: 'Group', items: groupItems() },
        { label: 'Wrap Text', items: wrapItems() },
        { label: 'Selection Pane…', icon: 'selectionPane', disabled: !ready(), onSelect: () => openPane('selection') }];
    }
    if (menuId === 'view') return [{ label: 'Selection Pane', icon: 'selectionPane', disabled: !ready(), onSelect: () => openPane('selection') }];
    return [];
  }
  function contextMenuItems(context) {
    const image = selected();
    if (context !== 'image' && context !== 'shape' || !image) return [];
    const ok = editable(), picture = isPicture(image), shape = isShape(image) || kind(image) === 'group';
    return [
      ...(picture ? [{ label: 'Change Picture', items: changePictureItems() }, { label: 'Crop', disabled: !ok || !ready()?.startCrop, onSelect: () => ready().startCrop() }] : []),
      ...(shape && kind(image) !== 'group' ? [{ label: 'Edit Shape', items: changeShapeItems()[0].items, disabled: !ok }] : []),
      { label: 'Group', items: groupItems() },
      { label: 'Bring to Front', items: forwardItems() },
      { label: 'Send to Back', items: backwardItems() },
      { label: 'Wrap Text', items: wrapItems() },
      { separator: true },
      { label: 'Edit Alt Text…', disabled: !ok, onSelect: () => openPane('altText') },
      { label: 'Size and Position…', disabled: !ok, onSelect: () => openSizePosition('size') },
      { label: picture ? 'Format Picture…' : 'Format Shape…', disabled: !ok, onSelect: () => openPane('format') },
    ];
  }
  /** The contextual tab a selection shows: 'shape' for shapes, text boxes and groups, 'image' for pictures and other drawings. */
  function drawingContext(engine) {
    const image = engine?.model.selectedImage;
    if (!image) return null;
    const k = drawingKind(image);
    return ['shape', 'textBox', 'group'].includes(k) ? 'shape' : 'image';
  }

  return {
    commands: { drawingTabs, drawingContext, openFormatPane: section => openPane('format', section), openSelectionPane: () => openPane('selection'), editAltText: () => openPane('altText'), openSizePosition, drawingWrapItems: wrapItems,
      // The shared context menu and older callers use these names for wrapping and stacking.
      wrapItems, arrange, canArrange: () => floating(), canWrap: () => !!selected() && editable() },
    extendMenu, contextMenuItems, drawingContext,
    pane: paneHost, inputs: [pictureInput, fillPictureInput],
    refresh() { refreshRibbon(); pane?.refresh?.(); },
    setLayoutCallback(fn) { onLayout = fn; },
    closePane,
    destroy() { transparentPick?.(); closePane(); },
    /** Canvas gestures the engine hands over: rotation of drawings it cannot rotate itself, layout options. */
    /** Canvas gestures the engine hands over (image-interaction.js): rotation, crop and group moves of drawings, layout options. */
    attach(engine) {
      const crop = async (image, { crop, width, height, anchor }) => apply('Crop', async drawing => {
        const parts = drawingParts(drawing);
        if (!parts.blipFill) throw new Error('Only pictures can be cropped.');
        setCrop(parts.blipFill, crop);
        if (width && height) resizeFrame(parts.frame, parts.properties, width, height);
        if (anchor && image.anchor) {
          const frame = readFrame(drawing);
          writeFrame(drawing, { ...(anchor.x !== undefined ? { horizontal: { relativeFrom: frame.horizontal.relativeFrom, offset: anchor.x } } : {}), ...(anchor.y !== undefined ? { vertical: { relativeFrom: frame.vertical.relativeFrom, offset: anchor.y } } : {}) });
        }
      }, image);
      engine.onDrawingGesture = payload => {
        const { type, image } = payload;
        if (type === 'moveMany') { engine.finishComposition(); const ok = engine.execute(() => moveDrawings(engine.model, payload.moves.map(m => ({ image: m.image, x: Math.round(m.x), y: Math.round(m.y) })))); refreshPanes(); return ok || true; }
        if (!image || !pkg() || pkg().readOnly) return false;
        if (type === 'rotate' && (image.retainedDrawing || image.shell) && formattable(image)) {
          const current = describe(image)?.transform?.rotation || 0;
          return apply('Rotate', props(sp => setTransform(sp, { rotation: current + (payload.delta ?? 0) / 60000 })), image);
        }
        if (type === 'crop' && isPicture(image) && formattable(image) && (image.shell || image.aspectLocked)) return crop(image, payload);
        return false;
      };
      engine.canRotateDrawing = image => !!image && image.kind !== 'chart' && !image.flatLine && !image.flatGroup && !image.anchor?.relativeSize
        && (!image.anchor || isPositionedImage(image)) && (!image.retainedDrawing && !image.shell || formattable(image));
      engine.canCropDrawing = image => isPicture(image) && formattable(image) && engine.session.path === null && !(describe(image)?.transform?.rotation);
      engine.cropInfo = image => {
        const info = describe(image) || {};
        // The decoded picture under a styled frame: the scene's picture node.
        const find = node => !node ? null : node.type === 'picture' && node.image?.assetId ? node.image.assetId : (node.children || []).map(find).find(Boolean) || null;
        const assetId = image.retainedDrawing ? find(engine.model.assets[image.assetId]?.scene) || image.assetId : image.assetId;
        return { crop: { left: 0, top: 0, right: 0, bottom: 0, ...(info.crop || image.crop || {}) }, flipH: !!(info.transform?.flipH ?? image.flipH), flipV: !!(info.transform?.flipV ?? image.flipV), assetId };
      };
      engine.onLayoutOptions = button => layoutOptions(button);
      // Resizing on the page: simple shapes keep their own editor; every other picture, shape and group
      // drawing resizes by rewriting its frame (extent, shape transform and, from the top or left, its offsets).
      const shapes = engine.drawingEditor;
      engine.drawingEditor = {
        canResize: image => !!shapes?.canResize(image) || formattable(image) && !!image.retainedDrawing,
        resize: patch => {
          const image = selected();
          if (shapes?.canResize(image)) return shapes.resize(patch);
          return apply('Size', async drawing => {
            const parts = drawingParts(drawing);
            if (patch.width && patch.height) resizeFrame(parts.frame, parts.properties, patch.width, patch.height);
            if (patch.anchor && image?.anchor) {
              const frame = readFrame(drawing);
              writeFrame(drawing, { ...(patch.anchor.x !== undefined ? { horizontal: { relativeFrom: frame.horizontal.relativeFrom, offset: patch.anchor.x } } : {}), ...(patch.anchor.y !== undefined ? { vertical: { relativeFrom: frame.vertical.relativeFrom, offset: patch.anchor.y } } : {}) });
            }
          }, image);
        },
      };
    },
    gestures: {
      layoutOptions: anchor => layoutOptions(anchor),
    },
  };
  function layoutOptions(anchor) {
        const image = selected(); if (!image) return;
        const mode = wrapModeOf(image);
        const icons = [['In Line with Text', 'inline', 'wrapInline'], ['Square', 'square', 'wrapSquare'], ['Tight', 'tight', 'wrapTight'], ['Through', 'through', 'wrapThrough'], ['Top and Bottom', 'topAndBottom', 'wrapTopBottom'], ['Behind Text', 'behind', 'behindText'], ['In Front of Text', 'front', 'inFront']];
        const grid = el('div.menu-custom-grid.pic-layout-grid', { role: 'group', 'aria-label': 'Text wrapping', dataset: { columns: '4' } },
          ...icons.map(([label, value, icon]) => el('button.swatch.pic-layout-item', { type: 'button', role: 'menuitemradio', tabindex: -1, 'aria-checked': String(mode === value), 'aria-label': label, title: label, disabled: !editable() || (!formattable(image) && ['tight', 'through'].includes(value)),
            onclick: () => { closeMenu(); setWrap(value); } }, commandIconEl(icon, 20))));
        openMenu({ anchor, label: 'Layout Options', className: 'pic-layout-menu', minWidth: 210, items: [{ header: 'In Line with Text and With Text Wrapping' }, { custom: grid }, { separator: true },
          { label: 'Move with Text', radio: true, checked: !!image.anchor && describe(image)?.frame?.vertical?.relativeFrom !== 'page', disabled: !image.anchor || image.anchor.wrap !== 'none', onSelect: () => setMoveWithText(true) },
          { label: 'Fix Position on Page', radio: true, checked: !!image.anchor && describe(image)?.frame?.vertical?.relativeFrom === 'page', disabled: !image.anchor || image.anchor.wrap !== 'none', onSelect: () => setMoveWithText(false) },
          { separator: true }, { label: 'See more…', onSelect: () => openSizePosition('position') }], onClose: () => editor()?.focus() });
  }
}
