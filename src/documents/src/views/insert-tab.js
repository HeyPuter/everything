/**
 * The Insert tab: pages, pictures, shapes, icons, diagrams, charts, screenshots, headers and footers,
 * page numbers, text boxes, Quick Parts and fields, WordArt, drop caps, signature lines, date and
 * time, text from a file, equations and symbols. Ribbon controls come from insertRibbon(kit), menu-bar
 * items from extendMenu and context-menu items from contextMenuItems. Every change to the document
 * is one editor transaction, so it undoes in one step and saves to DOCX.
 */
import { el, isComposing, MOD_KEY, shortcutCode, typesCharacter } from '../ui/dom.js';
import { closeMenu, openMenu } from '../ui/menu.js';
import { toast } from '../ui/toast.js';
import { promptDialog, confirmDialog } from '../ui/modal.js';
import { drawShapeThumbnail } from '../ui/shape-controls.js';
import { small } from '../ui/ribbon.js';
import * as P from '../lib/puter.js';
import { imageFileFromSource, generationError } from '../lib/imagegen.js';
import { galleryItems, pagePreview, textPreview } from './insert-gallery.js';
import { openDateTime, openFieldDialog, openFormatPageNumbers, openSymbolDialog, openEquationDialog, openIconsDialog, openDiagramDialog, openSignatureDialog, openDropCapDialog, openGenerateDialog, recentSymbols, rememberSymbol, diagramSketch } from './insert-dialogs.js';
import { COVER_DESIGNS, insertCoverPage, removeCoverPage, coverPageRange } from '../engine/cover-pages.js';
import { HEADER_DESIGNS, PAGE_NUMBER_DESIGNS, writeStoryLines, removePageNumberParagraphs, storyPageField } from '../engine/header-footer-designs.js';
import { TEXT_BOX_DESIGNS, WORDART_STYLES, WORDART_PROMPT, textBoxParams, wordArtParams, signatureLineParams, textShapeXml } from '../engine/text-designs.js';
import { SHAPE_PRESETS, LINE_PRESETS, UNFILLED_PRESETS, DEFAULT_SHAPE_STYLE, shapeDrawingXml } from '../engine/authored-shapes.js';
import { readDrawingFragment, placeDrawing, freshDrawingAssetId, nextDrawingId, nextDrawingOrder, EMU_PER_INCH } from '../engine/inserted-drawings.js';
import { pictureFragment, fittedSize } from '../engine/picture-insert.js';
import { imageInfo, MAX_IMAGE_SIDE, MAX_IMAGE_PIXELS } from '../engine/images.js';
import { diagramDrawingXml, parseDiagramDescription, DIAGRAM_LAYOUTS } from '../engine/diagram-builder.js';
import { insertBodyField, fieldInstruction, evaluateField, documentProperties, setFieldContextProvider, DOCUMENT_PROPERTY_NAMES, formatDatePicture } from '../engine/field-results.js';
import { linearToOmml, ommlToLinear, EQUATION_GALLERY } from '../engine/math-linear.js';
import { ommlToMathml } from '../engine/omml-mathml.js';
import { dropCapState, setDropCap } from '../engine/drop-caps.js';
import { iconSvg } from '../lib/icon-library.js';
import { chartCommands } from './insert-chart.js';

const OBJECT = '\uFFFC';
const TWIP_EMU = 635;
const AUTOTEXT_KEY = 'documents.insert.autoText';

/** Draw an image file at most `max` pixels per side (and `pixels` in all) and encode it as PNG, or as `type`: its bytes and pixel size. */
export async function rasterize(blob, max = 1600, { pixels = Infinity, type = 'image/png', quality } = {}) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(); img.src = url;
    try { await img.decode(); } catch { throw new Error('The picture could not be read. Choose a PNG, JPEG, GIF, WebP, BMP, TIFF or SVG image.'); }
    let width = img.naturalWidth || 300, height = img.naturalHeight || 150;
    const scale = Math.min(1, max / Math.max(width, height), Math.sqrt(pixels / (width * height))); width = Math.max(1, Math.round(width * scale)); height = Math.max(1, Math.round(height * scale));
    if (width * height > pixels) { width = Math.max(1, Math.floor(width * scale)); height = Math.max(1, Math.floor(height * scale)); }
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    const encoded = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('The picture could not be converted.')), type, quality));
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    return { png: bytes, bytes, width, height };
  } finally { URL.revokeObjectURL(url); }
}

// Pictures larger than an editing session holds are scaled down on insertion, as photos straight
// from a camera often are: at most 4,096 pixels per side, 16 megapixels and 10 MB.
const PICTURE_SIDE = 4096, PICTURE_BYTES = 10 * 1024 * 1024;
/**
 * A picture file the editor can store: a PNG, JPEG or TIFF within the limits as it is, and any other
 * raster format, or a PNG or JPEG over the limits, redrawn to fit (JPEG stays JPEG, the rest become PNG).
 */
export async function pictureFile(file) {
  const name = file.name || 'picture', type = file.type || P.mimeFor?.(name) || '';
  const tiff = type === 'image/tiff' || !type && /\.tiff?$/i.test(name), jpeg = type === 'image/jpeg' || !type && /\.jpe?g$/i.test(name);
  if (tiff) return file;
  if (jpeg || type === 'image/png' || !type && /\.png$/i.test(name)) {
    let info;
    try { info = imageInfo(new Uint8Array(await file.arrayBuffer()), { checkSize: false }); } catch { return file; } // Inserting reports what is wrong with it.
    if (file.size <= PICTURE_BYTES && info.width <= MAX_IMAGE_SIDE && info.height <= MAX_IMAGE_SIDE && info.width * info.height <= MAX_IMAGE_PIXELS) return file;
  }
  const { bytes } = await rasterize(file, PICTURE_SIDE, { pixels: MAX_IMAGE_PIXELS, type: jpeg ? 'image/jpeg' : 'image/png', quality: jpeg ? 0.92 : undefined });
  return new File([bytes], name.replace(/\.\w+$/, '') + (jpeg ? '.jpg' : '.png'), { type: jpeg ? 'image/jpeg' : 'image/png' });
}

export function createInsert({ editor, pkg, error, base = {}, docName = () => '', user = () => '', onChange = () => {} }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly ? engine : null; };
  const fail = e => { error(e); editor()?.focus(); };
  const toBody = engine => { engine.finishComposition(); if (engine.session.path !== null) engine.editStory(null); };
  const activeKind = engine => engine?.session.path ? engine.pageStories?.stories[engine.session.path]?.kind : null;
  const textWidth = engine => { const p = engine.model.pageSettings; return Math.max(EMU_PER_INCH, (p.width - p.left - p.right - (p.gutterAtTop ? 0 : p.gutter || 0)) * TWIP_EMU); };
  const title = () => documentProperties(pkg()?.parts || {}).title || String(docName() || '').replace(/\.docx$/i, '') || 'Document Title';
  const today = () => new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date());
  /** Run an editor transaction, reporting failures; returns whether it applied. */
  const run = (engine, action) => { let failure = null; const ok = engine.execute(action, e => { failure = e; }); if (failure) fail(failure); engine.focus(); if (ok) onChange(); return ok; };
  const fieldContext = () => {
    const engine = editor();
    return { now: new Date(), properties: documentProperties(pkg()?.parts || {}), fileName: /\.\w+$/.test(docName() || '') ? docName() : `${docName() || 'Document'}.docx`, user: { name: user() || '' },
      pages: engine?.layout?.pageCount, page: (engine?.caretPageIndex ?? 0) + 1 };
  };
  setFieldContextProvider(fieldContext);

  /** Insert a drawing fragment built for the current body model; `build(engine, id, order)` returns the fragment. */
  async function insertDrawing(build, { body = true, replace = null, edit = false } = {}) {
    const engine = ready(); if (!engine) return false;
    try {
      if (body) toBody(engine); else engine.finishComposition();
      // A new drawing goes after a selected picture or shape rather than replacing it.
      if (!replace) afterSelectedDrawing(engine);
      const revision = engine.session.revision, model = engine.model;
      const fragment = await build(engine, replace?.id ?? nextDrawingId(model), nextDrawingOrder(model));
      const ok = await placeDrawing(engine, fragment, { replace, revision });
      // `edit` may say what to select in the drawing's text: the sample text a new box shows.
      if (ok) { onChange(); if (edit) base.editDrawingText?.(typeof edit === 'function' ? edit() : undefined); }
      return ok;
    } catch (e) { fail(e); return false; }
  }
  const afterSelectedDrawing = engine => { if (engine.model.selectedImage) { engine.model.select(engine.model.range[1]); engine.syncInput(); } };
  const sceneFragment = (engine, xml) => readDrawingFragment(xml, { sourceParts: pkg().parts, assetId: freshDrawingAssetId(engine.model) });
  const withDescription = (xml, text) => text ? xml.replace(/(<wp:docPr [^>]*?)(\/?>)/, (_, open, close) => `${open} descr="${String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, '&#10;')}"${close}`) : xml;
  const selectedText = engine => { const [a, b] = engine.model.range; return a === b ? '' : engine.model.text.slice(a, b).replace(/[\uFFFC\f\v\u000e]/g, '').trim(); };

  /* ---- Pages ---- */
  function coverPreview(design) {
    let y = 6; const lines = [], bands = [];
    for (const [, paragraph, runFormat] of design.lines) {
      y += (paragraph.spaceBefore || 0) / 7.2; const h = Math.max(1.2, (runFormat.fontSize || 12) / 9);
      const w = Math.min(64, (runFormat.fontSize || 12) * 1.6), color = `#${runFormat.color && runFormat.color !== 'FFFFFF' ? runFormat.color : paragraph.paragraphShading ? 'FFFFFF' : '595959'}`;
      if (paragraph.paragraphShading) bands.push({ x: 4, y: y - 2, w: 77, h: h + 4, color: `#${paragraph.paragraphShading}` });
      if (paragraph.paragraphBorders?.left) bands.push({ x: 6, y: y - 1, w: 1.5, h: h + 2, color: `#${paragraph.paragraphBorders.left.color}` });
      lines.push({ y, h, w, color, align: paragraph.alignment });
      y += h + 3 + (paragraph.spaceAfter || 0) / 7.2;
    }
    return pagePreview(lines, { bands });
  }
  function coverPageItems() {
    const engine = ready(), current = engine ? coverPageRange(engine.session.body) : null;
    return [...galleryItems([{ header: 'Built-In', items: COVER_DESIGNS.map(design => ({ label: design.name, preview: coverPreview(design), disabled: !engine, onSelect: () => insertCover(design.id) })) }], { columns: 3, label: 'Cover pages' }),
      { separator: true },
      { label: 'Remove Current Cover Page', icon: 'deletePicture', disabled: !current, onSelect: () => { const engine = ready(); if (!engine) return; toBody(engine); run(engine, () => removeCoverPage(engine.model)); } }];
  }
  function insertCover(id) {
    const engine = ready(); if (!engine) return;
    toBody(engine);
    if (run(engine, () => insertCoverPage(engine.model, id, { title: title(), subtitle: 'Document subtitle', author: user() || 'Author Name', date: today() }))) engine.revealCaret();
  }

  /* ---- Pictures ---- */
  async function insertPictureFile(file) {
    const engine = ready(); if (!engine || !file) return;
    try {
      engine.finishComposition(); afterSelectedDrawing(engine);
      const name = file.name || 'picture', type = file.type || P.mimeFor?.(name) || '';
      if (type === 'image/svg+xml' || /\.svg$/i.test(name)) {
        const svg = await file.text(), { png, width, height } = await rasterize(new Blob([svg], { type: 'image/svg+xml' }));
        const [w, h] = fittedSize(width, height, textWidth(engine) / EMU_PER_INCH);
        // The SVG goes in beside its PNG rendering when the document's reader can keep it; an SVG it cannot read
        // (editor metadata, CSS it does not support) is inserted as the PNG alone, as other readers show it anyway.
        const fragment = (engine, id, withSvg) => pictureFragment(engine.model, pkg().parts, { png, ...(withSvg ? { svg } : {}), width: w, height: h, id, name: `Picture ${id}` });
        await insertDrawing((engine, id) => fragment(engine, id, true).catch(() => fragment(engine, id, false)), { body: false });
        return;
      }
      // Other raster formats (GIF, WebP, BMP, AVIF) are stored as PNG, which every DOCX reader shows.
      await engine.insertImageFile(await pictureFile(file)); onChange();
    } catch (e) { fail(e); }
  }
  const pictureInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/tiff,image/gif,image/webp,image/bmp,image/svg+xml,.svg,.tif,.tiff', hidden: true, 'aria-label': 'Insert picture file',
    onchange: () => { const file = pictureInput.files?.[0]; pictureInput.value = ''; if (file) insertPictureFile(file); } });
  function pictureItems() {
    const engine = ready();
    return [
      { label: 'This Device…', icon: 'folderOpen', disabled: !engine, onSelect: () => pictureInput.click() },
      ...(P.canPickFiles() ? [{ label: 'From Puter…', icon: 'pictures', disabled: !engine, onSelect: async () => { try { const file = await P.pickImage(); if (file) await insertPictureFile(file); } catch (e) { fail(e); } } }] : []),
      ...(P.canMakeImages() ? [{ label: 'Generate with AI…', icon: 'pictures', disabled: !engine, onSelect: () => openGenerateDialog({ onClose: () => queueMicrotask(() => editor()?.focus()),
        generate: async prompt => {
          let image;
          try { image = await P.makeImage(prompt); } catch (e) { throw generationError(e); }
          return imageFileFromSource(image, prompt);
        }, onInsert: file => insertPictureFile(file) }) }] : []),
      ...(canCapture() ? [{ separator: true }, { label: 'Screenshot…', icon: 'screenshot', disabled: !engine, onSelect: screenshot }] : []),
    ];
  }
  const canCapture = () => !!navigator.mediaDevices?.getDisplayMedia;
  async function screenshot() {
    const engine = ready(); if (!engine || !canCapture()) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = el('video', { muted: true, playsInline: true }); video.srcObject = stream; await video.play();
      await new Promise(resolve => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => resolve()) : setTimeout(resolve, 300)));
      const canvas = Object.assign(document.createElement('canvas'), { width: video.videoWidth, height: video.videoHeight });
      canvas.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('The screen could not be captured.');
      await engine.insertImageFile(new File([blob], 'screenshot.png', { type: 'image/png' })); onChange();
    } catch (e) { if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') fail(e); else editor()?.focus(); }
    finally { for (const track of stream?.getTracks() || []) track.stop(); }
  }

  /* ---- Icons ---- */
  function insertIcons() {
    if (!ready()) return;
    openIconsDialog({ onClose: () => queueMicrotask(() => editor()?.focus()), onInsert: async (icons, color) => {
      for (const icon of icons) {
        const svg = iconSvg(icon.id, { color, size: 96 }), { png } = await rasterize(new Blob([iconSvg(icon.id, { color, size: 192 })], { type: 'image/svg+xml' }), 192);
        const ok = await insertDrawing((engine, id) => pictureFragment(engine.model, pkg().parts, { png, svg, width: EMU_PER_INCH, height: EMU_PER_INCH, id, name: `Graphic ${id}`, descr: icon.name, stem: 'canvas-icon' }), { body: false });
        if (!ok) break;
        // The next icon follows this one rather than replacing it.
        const engine = ready(); if (engine) { engine.model.select(engine.model.range[1]); engine.syncInput(); }
      }
    } });
  }

  /* ---- Shapes: pick from the gallery, then click or drag on the page ---- */
  let drawing = null;
  function cancelDrawing() { drawing?.stop(); drawing = null; }
  /** Wait for a click or a drag on a page; calls done({ page, x, y, width, height, position, dragged }) in page EMU. */
  function drawOnPage(label, done) {
    const engine = ready(); if (!engine) return;
    cancelDrawing();
    const pages = engine.pages, band = el('div.insert-draw-band', { hidden: true });
    const hint = el('div.insert-draw-hint', { role: 'status' }, `${label}: drag on the page to draw it, or click for the default size. Esc cancels.`);
    document.body.append(band, hint);
    pages.classList.add('is-drawing-shape');
    let start = null;
    const rectOf = (a, b) => ({ left: Math.min(a.clientX, b.clientX), top: Math.min(a.clientY, b.clientY), width: Math.abs(a.clientX - b.clientX), height: Math.abs(a.clientY - b.clientY) });
    const down = e => {
      if (e.button !== 0 || !e.target.closest('canvas')) return;
      e.preventDefault(); e.stopPropagation(); start = { clientX: e.clientX, clientY: e.clientY, canvas: e.target.closest('canvas'), event: e };
      pages.setPointerCapture?.(e.pointerId);
    };
    const move = e => {
      if (!start) return; e.preventDefault(); e.stopPropagation();
      const r = rectOf(start, e); Object.assign(band.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` }); band.hidden = false;
    };
    const up = e => {
      if (!start) return; e.preventDefault(); e.stopPropagation();
      const canvas = start.canvas, box = canvas.getBoundingClientRect(), zoom = engine.zoom || 1, r = rectOf(start, e), dragged = r.width > 4 || r.height > 4;
      const position = engine.point(start.event, false), page = Number(canvas.dataset.page);
      const px = v => Math.round(v / zoom * 9525);
      const result = { page, position, dragged, x: px(r.left - box.left), y: px(r.top - box.top), width: px(r.width), height: px(r.height) };
      cancelDrawing(); done(result);
    };
    const key = e => { if (e.key === 'Escape' && !isComposing(e)) { e.preventDefault(); e.stopPropagation(); cancelDrawing(); engine.focus(); } };
    pages.addEventListener('pointerdown', down, true); pages.addEventListener('pointermove', move, true); pages.addEventListener('pointerup', up, true); window.addEventListener('keydown', key, true);
    drawing = { stop() { pages.removeEventListener('pointerdown', down, true); pages.removeEventListener('pointermove', move, true); pages.removeEventListener('pointerup', up, true); window.removeEventListener('keydown', key, true); pages.classList.remove('is-drawing-shape'); band.remove(); hint.remove(); } };
  }
  /** Insert a preset: at the caret with its default size, or in the rectangle drawn on a page. */
  function insertShapeAt(preset, rect = null) {
    const entry = SHAPE_PRESETS.find(([p]) => p === preset); if (!entry) return;
    const [, name, , w, h] = entry, line = LINE_PRESETS.has(preset), open = UNFILLED_PRESETS.has(preset);
    return insertDrawing((engine, id, order) => {
      if (rect) { engine.model.select(rect.position); }
      const width = rect?.dragged ? Math.max(9525 * 4, rect.width) : Math.round(w * EMU_PER_INCH), height = line ? 0 : rect?.dragged ? Math.max(9525 * 4, rect.height) : Math.round(h * EMU_PER_INCH);
      const anchor = rect ? { horizontal: 'page', vertical: 'page', x: rect.x, y: rect.y, wrap: 'none', behind: false, order } : { horizontal: 'column', vertical: 'paragraph', x: 0, y: 0, wrap: 'none', behind: false, order };
      return sceneFragment(engine, shapeDrawingXml({ id, name: `${name} ${id}`, preset, width, height, fill: line || open ? null : DEFAULT_SHAPE_STYLE.fill, line: line || open ? DEFAULT_SHAPE_STYLE.fill : DEFAULT_SHAPE_STYLE.line, lineWidth: DEFAULT_SHAPE_STYLE.lineWidth, anchor }));
    });
  }
  function openShapes(anchor, event) {
    if (!ready()) return;
    const pointer = !!event?.detail;
    const groups = [...new Set(SHAPE_PRESETS.map(([, , group]) => group))];
    const items = groups.flatMap(group => [{ header: group }, { custom: el('div.menu-custom-grid.insert-shape-grid', { role: 'group', 'aria-label': group, dataset: { columns: '10' } },
      ...SHAPE_PRESETS.filter(([, , g]) => g === group).map(([preset, name]) => {
        const canvas = el('canvas', { 'aria-hidden': 'true' }); drawShapeThumbnail(canvas, preset);
        return el('button.swatch.shape-gallery-item.insert-shape-item', { type: 'button', role: 'menuitem', tabindex: -1, 'aria-label': name, title: name, onclick: e => {
          closeMenu();
          // The keyboard inserts at the caret; the pointer draws the shape on the page.
          if (e.detail) drawOnPage(name, rect => insertShapeAt(preset, rect)); else insertShapeAt(preset);
        } }, canvas);
      })) }]);
    return openMenu({ anchor, label: 'Shapes', className: 'insert-shapes-menu', items, pointer, onClose: pointer ? () => editor()?.focus() : null });
  }

  /* ---- Diagrams ---- */
  const selectedDiagram = () => { const image = ready()?.model.selectedImage; const parsed = image?.retainedDrawing ? parseDiagramDescription(image.alt) : null; return parsed ? { image, ...parsed } : null; };
  function insertDiagram(layout = null) {
    const engine = ready(); if (!engine) return;
    const current = layout ? null : selectedDiagram();
    openDiagramDialog({ initial: current || (layout ? { layout } : null), editing: !!current, onClose: () => queueMicrotask(() => editor()?.focus()), onInsert: ({ layout, colors, items }) => {
      insertDrawing((engine, id) => {
        const width = Math.min(textWidth(engine), 6 * EMU_PER_INCH), height = Math.round(Math.min(width * 0.56, 3.5 * EMU_PER_INCH));
        const size = current ? { width: current.image.width, height: current.image.height } : { width, height };
        return sceneFragment(engine, diagramDrawingXml({ layout, items, colors, id, ...size, anchor: current?.image.anchor || null }));
      }, { replace: current?.image || null });
    } });
  }
  function diagramItems() {
    const sample = [{ text: 'One', children: [] }, { text: 'Two', children: [] }, { text: 'Three', children: [] }];
    return [...galleryItems([{ items: DIAGRAM_LAYOUTS.map(layout => ({ label: layout.name, hint: `${layout.category}: ${layout.hint}`, preview: diagramSketch(layout.id, layout.id === 'orgChart' ? [{ text: 'Lead', children: sample }] : sample, 'blue', 96, 54), onSelect: () => insertDiagram(layout.id) })) }], { columns: 3, label: 'Diagram layouts' }),
      { separator: true }, { label: 'Edit Selected Diagram…', disabled: !selectedDiagram(), onSelect: () => insertDiagram() }];
  }

  /* ---- Headers, footers and page numbers ---- */
  async function applyStoryDesign(kind, lines, { append = false } = {}) {
    const engine = ready(); if (!engine) return;
    try {
      await base.editHeader?.(kind);
      if (activeKind(engine) !== kind) return;
      run(engine, () => writeStoryLines(engine.model, lines, { append }));
    } catch (e) { fail(e); }
  }
  const designLines = (design, kind) => design.lines({ title: title(), date: today(), width: (() => { const p = editor()?.model.pageSettings; return p ? p.width - p.left - p.right : 9360; })(), kind });
  function storyPreview(design, kind) {
    // A strip of the page: the header or footer line over (or under) a few lines of body text.
    const lines = designLines(design, kind), y = kind === 'header' ? 5 : 21, bands = [];
    const pieces = lines.flatMap(line => {
      if (line.paragraph.paragraphShading) bands.push({ x: 6, y: y - 2, w: 73, h: 6.4, color: `#${line.paragraph.paragraphShading}` });
      if (line.paragraph.paragraphBorders) bands.push({ x: 8, y: kind === 'header' ? y + 4 : y - 2.5, w: 69, h: 0.7, color: '#2F5597' });
      const color = line.paragraph.paragraphShading ? '#FFFFFF' : `#${line.run.color || '595959'}`;
      const segments = line.parts.map(p => typeof p === 'string' ? p : p.field ? '#' : p.text || '').join('').split('\t');
      const align = line.paragraph.alignment || 'left';
      if (segments.length === 1) return [{ y, h: 2.4, w: Math.min(50, Math.max(8, segments[0].length * 1.6)), color, align }];
      return segments.map((s, i) => ({ y, h: 2.4, w: Math.min(22, Math.max(6, s.length * 1.4)), color, align: ['left', 'center', 'right'][Math.min(2, i * (segments.length === 2 ? 2 : 1))] }));
    });
    const body = (kind === 'header' ? [14, 18, 22] : [4, 8, 12]).map(by => ({ y: by, h: 1.4, w: 64, color: '#D9D9D9' }));
    return pagePreview([...pieces, ...body], { bands, width: 120, viewHeight: 27 });
  }
  function headerItems(kind) {
    const engine = ready(), Kind = kind === 'header' ? 'Header' : 'Footer';
    return [...galleryItems([{ header: 'Built-In', items: HEADER_DESIGNS.filter(d => d.kinds.includes(kind)).map(design => ({ label: design.name, hint: design.hint, preview: storyPreview(design, kind), disabled: !engine,
      onSelect: () => applyStoryDesign(kind, designLines(design, kind)) })) }], { columns: 3, label: `${Kind} designs` }),
    { separator: true },
    { label: `Edit ${Kind}`, icon: kind, disabled: !engine, onSelect: () => base.editHeader?.(kind) },
    { label: `Remove ${Kind}`, disabled: !engine, onSelect: () => removeStory(kind) }];
  }
  async function removeStory(kind) {
    const engine = ready(); if (!engine) return;
    try {
      await base.editHeader?.(kind);
      if (activeKind(engine) !== kind) return;
      run(engine, () => { engine.model.select(0, engine.model.text.length); if (engine.model.text.length) engine.model.replace(''); return true; });
      engine.editStory(null); engine.focus(); onChange();
    } catch (e) { fail(e); }
  }
  async function insertPageNumber(where, design, alignment) {
    const engine = ready(); if (!engine) return;
    const line = { paragraph: { alignment }, run: design.run, parts: design.parts };
    if (where === 'top' || where === 'bottom') return applyStoryDesign(where === 'top' ? 'header' : 'footer', [line], { append: true });
    engine.finishComposition();
    if (engine.session.path !== null) {
      // In a header or footer, page numbers are page-field runs.
      run(engine, () => { for (const part of design.parts) { if (typeof part === 'object' && part.field) engine.model.insertFieldRun(storyPageField(part.field)); else engine.model.replace(typeof part === 'string' ? part : part.text); } return true; });
      return;
    }
    // In the body, PAGE and NUMPAGES are body fields showing their current values.
    const page = String((engine.caretPageIndex ?? 0) + 1), pages = String(engine.layout.pageCount);
    run(engine, () => {
      for (const part of design.parts) {
        if (typeof part === 'object' && part.field) insertBodyField(engine.model, fieldInstruction({ name: part.field, preserve: true }), part.field === 'PAGE' ? page : pages);
        else engine.model.replace(typeof part === 'string' ? part : part.text);
      }
      return true;
    });
  }
  function numberPreview(design, alignment) {
    const text = design.parts.map(p => typeof p === 'object' && p.field ? (p.field === 'PAGE' ? '1' : '3') : typeof p === 'string' ? p : p.text).join('');
    return el('span.insert-number-preview', { style: { justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[alignment] } },
      textPreview(text, { fontWeight: design.run.bold ? '700' : '', color: design.run.color ? `#${design.run.color}` : '' }));
  }
  function pageNumberGallery(where) {
    const disabled = !ready();
    const plain = PAGE_NUMBER_DESIGNS[0], others = PAGE_NUMBER_DESIGNS.slice(1);
    const items = where === 'current'
      ? PAGE_NUMBER_DESIGNS.map(design => ({ label: design.name, preview: numberPreview(design, 'center'), disabled, onSelect: () => insertPageNumber(where, design, null) }))
      : [...['left', 'center', 'right'].map((alignment, i) => ({ label: `Plain Number ${i + 1}`, hint: `${alignment[0].toUpperCase()}${alignment.slice(1)}`, preview: numberPreview(plain, alignment), disabled, onSelect: () => insertPageNumber(where, plain, alignment) })),
        ...others.map(design => ({ label: design.name, preview: numberPreview(design, design.id === 'accentBar' ? 'left' : 'center'), disabled, onSelect: () => insertPageNumber(where, design, design.id === 'accentBar' ? 'left' : design.id === 'bold' ? 'right' : 'center') }))];
    return galleryItems([{ items }], { columns: 2, size: 'wide', label: 'Page number designs' });
  }
  function pageNumberItems() {
    const engine = ready();
    return [{ label: 'Top of Page', icon: 'header', disabled: !engine, items: pageNumberGallery('top') },
      { label: 'Bottom of Page', icon: 'footer', disabled: !engine, items: pageNumberGallery('bottom') },
      { label: 'Current Position', disabled: !engine, items: pageNumberGallery('current') },
      { separator: true },
      { label: 'Format Page Numbers…', disabled: !engine, onSelect: formatPageNumbers },
      { label: 'Remove Page Numbers', disabled: !engine, onSelect: removePageNumbers }];
  }
  function formatPageNumbers() {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    const page = engine.session.path !== null ? engine.storyPage ?? 0 : engine.caretPageIndex ?? 0, section = engine.sectionOfPage(page);
    openFormatPageNumbers({ current: engine.pageStories?.sections?.[section]?.pageNumbering || {}, onClose: () => queueMicrotask(() => editor()?.focus()), onApply: ({ format, start }) => {
      const value = format === 'decimal' && start === null ? null : { format, ...(start !== null ? { start } : {}) };
      pkg().setPageNumbering(section, value);
      engine.setStoryOptions({ section, pageNumbering: value });
      engine.onChange(); onChange();
    } });
  }
  function removePageNumbers() {
    const engine = ready(); if (!engine) return;
    toBody(engine);
    const page = engine.caretPageIndex ?? 0, section = engine.pageStories?.sections?.[engine.sectionOfPage(page)];
    const paths = [...new Set(['header', 'footer'].flatMap(kind => Object.values(section?.[kind] || {})))].filter(path => engine.pageStories.stories[path]?.editable);
    let removed = 0;
    for (const path of paths) {
      if (!engine.pageStories.stories[path].paragraphs.some(p => p.runs.some(r => r.field?.type === 'PAGE'))) continue;
      engine.editStory(path, page);
      if (engine.execute(() => removePageNumberParagraphs(engine.model))) removed++;
    }
    engine.editStory(null); engine.focus();
    if (removed) onChange(); else toast('No page numbers were found in this section’s headers and footers.', { icon: 'info' });
  }

  /* ---- Text boxes, WordArt, signature lines ---- */
  function textBoxPreview(design) {
    const fill = design.shape.fill ? `#${design.shape.fill}` : 'none', stroke = design.shape.line ? `#${design.shape.line}` : 'none';
    const w = Math.min(70, design.width * 11), h = Math.min(90, design.height * 11), x = design.align === 'right' ? 80 - w : design.align === 'center' ? (85 - w) / 2 : 6, y = 26;
    const body = [10, 14, 18, ...[...Array(12)].map((_, i) => 22 + i * 6)].map(by => ({ y: by, h: 1.4, w: 70, color: '#E0E0E0' }));
    const lines = [0, 1, 2].map(i => ({ x: x + 4, y: y + 5 + i * 6, h: 2, w: Math.max(6, w - 10 - i * 6), color: design.shape.fill && design.shape.fill !== 'FFFFFF' && !design.shape.fill.startsWith('F') && !design.shape.fill.startsWith('D') ? '#FFFFFF' : '#2F5597' }));
    return pagePreview([...body, ...lines], { bands: [{ x, y, w, h, color: fill === 'none' ? '#FFFFFF' : fill, stroke: stroke === 'none' ? (fill === 'none' ? '#2F5597' : undefined) : stroke }], width: 56 });
  }
  // A new box opens for editing with its sample text selected, so typing replaces it; text it was made from stays.
  function insertTextBoxDesign(design, rect = null) {
    let prompt = null;
    insertDrawing((engine, id, order) => {
      const text = rect ? '' : selectedText(engine);
      prompt = text ? null : design.prompt;
      if (rect) engine.model.select(rect.position);
      const placement = rect ? { width: rect.dragged ? Math.max(EMU_PER_INCH / 4, rect.width) : null, height: rect.dragged ? Math.max(EMU_PER_INCH / 8, rect.height) : null, anchor: { horizontal: 'page', vertical: 'page', x: rect.x, y: rect.y, wrap: 'square', behind: false, order } } : {};
      return sceneFragment(engine, textShapeXml(textBoxParams(design, { id, order, text, textWidth: textWidth(engine), ...placement })));
    }, { edit: () => ({ select: prompt }) });
  }
  function textBoxItems() {
    const engine = ready();
    return [...galleryItems([{ header: 'Built-In', items: TEXT_BOX_DESIGNS.map(design => ({ label: design.name, hint: design.hint, preview: textBoxPreview(design), disabled: !engine, onSelect: () => insertTextBoxDesign(design) })) }], { columns: 3, label: 'Text box designs' }),
      { separator: true }, { label: 'Draw Text Box', icon: 'textBox', disabled: !engine, onSelect: () => drawOnPage('Text box', rect => insertTextBoxDesign(TEXT_BOX_DESIGNS[0], rect)) }];
  }
  const wordArtCss = style => ({ color: style.run.fill && style.run.fill !== 'none' ? `#${style.run.fill}` : style.run.fill === 'none' ? 'transparent' : `#${style.run.color}`,
    WebkitTextStroke: style.run.outline ? `${Math.max(0.6, style.run.outline.width / 12700)}px #${style.run.outline.color}` : '', textShadow: style.run.shadow ? `1px 1px 2px rgba(0,0,0,${style.run.shadow.alpha ?? 0.5})` : '',
    fontWeight: '700', fontSize: '26px', letterSpacing: style.run.spacing ? '2px' : '', textTransform: style.run.caps ? 'uppercase' : '' });
  function wordArtItems() {
    const engine = ready();
    return galleryItems([{ items: WORDART_STYLES.map(style => ({ label: style.name, preview: textPreview('A', wordArtCss(style)), disabled: !engine, onSelect: () => insertWordArt(style) })) }], { columns: 4, size: 'small', label: 'WordArt styles' });
  }
  function insertWordArt(style) {
    let prompt = null;
    insertDrawing((engine, id, order) => {
      const text = selectedText(engine);
      prompt = text ? null : WORDART_PROMPT;
      return sceneFragment(engine, textShapeXml(wordArtParams(style, { id, order, text: text || WORDART_PROMPT, textWidth: textWidth(engine) })));
    }, { edit: () => ({ select: prompt }) });
  }
  function insertSignatureLine() {
    if (!ready()) return;
    openSignatureDialog({ onClose: () => queueMicrotask(() => editor()?.focus()), onInsert: options => insertDrawing((engine, id, order) =>
      sceneFragment(engine, withDescription(textShapeXml(signatureLineParams({ ...options, id, order })), `Signature line${options.signer ? ` for ${options.signer}` : ''}${options.instructions ? `. ${options.instructions}` : ''}`))) });
  }

  /* ---- Drop cap ---- */
  function applyDropCap(options) {
    const engine = ready(); if (!engine) return;
    toBody(engine);
    run(engine, () => setDropCap(engine.model, options));
  }
  function dropCapItems() {
    const engine = ready(), state = engine && engine.session.path === null ? safe(() => dropCapState(engine.model)) : null;
    return [['None', 'none'], ['Dropped', 'drop'], ['In Margin', 'margin']].map(([label, mode]) => ({ label, icon: mode === 'none' ? null : 'dropCap', radio: true, checked: (state?.mode || 'none') === mode, disabled: !engine,
      onSelect: () => applyDropCap({ mode, lines: state?.lines || 3, distance: state?.distance || 0, fontFamily: state?.fontFamily || null }) }))
      .concat([{ separator: true }, { label: 'Drop Cap Options…', disabled: !engine, onSelect: dropCapOptions }]);
  }
  function dropCapOptions() {
    const engine = ready(); if (!engine) return;
    toBody(engine);
    const state = safe(() => dropCapState(engine.model)) || { mode: 'none', lines: 3, distance: 0 };
    const fonts = [...new Set(Object.values(engine.model.styles.definitions || {}).map(s => s.run?.fontAscii || s.properties?.run?.fontAscii).filter(Boolean).concat(['Noto Serif', 'Noto Sans', 'Georgia', 'Times New Roman', 'Arial']))];
    openDropCapDialog({ state, fonts, onClose: () => queueMicrotask(() => editor()?.focus()), onApply: options => applyDropCap(options) });
  }
  const safe = fn => { try { return fn(); } catch { return null; } };

  /* ---- Date & Time, fields, Quick Parts ---- */
  function insertDateTime() {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    openDateTime({ onClose: () => queueMicrotask(() => editor()?.focus()), onInsert: ({ picture, text, field }) => {
      const engine = ready(); if (!engine) return;
      // Fields live in the body; a header or footer gets the date as text.
      if (field && engine.session.path === null) run(engine, () => insertBodyField(engine.model, fieldInstruction({ name: /[Mdy]/.test(picture) ? 'DATE' : 'TIME', picture }), text));
      else run(engine, () => engine.model.replace(text));
    } });
  }
  function insertFieldInstruction(instruction, cached = null) {
    const engine = ready(); if (!engine) return false;
    toBody(engine);
    const value = cached ?? evaluateField(instruction, { ...fieldContext(), text: engine.model.text }) ?? '';
    return run(engine, () => insertBodyField(engine.model, instruction, value));
  }
  function insertField() {
    const engine = ready(); if (!engine) return;
    toBody(engine);
    openFieldDialog({ context: { ...fieldContext(), text: engine.model.text }, bookmarks: (engine.bookmarks || []).map(b => b.name).filter(n => !n.startsWith('_')), onClose: () => queueMicrotask(() => editor()?.focus()),
      onInsert: ({ name, instruction }) => {
        const engine = ready(); if (!engine) return;
        const cached = name === 'PAGE' ? String((engine.caretPageIndex ?? 0) + 1) : name === 'SEQ' ? '1' : name === 'REF' ? (() => { const target = /REF\s+"?([^"\s]+)/.exec(instruction)?.[1], mark = engine.bookmarks.find(b => b.name === target); return mark ? engine.model.text.slice(mark.start, mark.end) : ''; })() : null;
        insertFieldInstruction(instruction, cached);
        // A new sequence or reference number settles when fields update, as captions do.
        if (name === 'SEQ' || name === 'REF') base.updateFields?.();
      } });
  }
  const propertyField = (label, key) => {
    const value = documentProperties(pkg()?.parts || {})[key];
    insertFieldInstruction(fieldInstruction({ name: 'DOCPROPERTY', argument: label }), value || `[${label}]`);
  };
  const autoTextKey = () => `${AUTOTEXT_KEY}.${user() || 'local'}`;
  const autoTexts = () => { try { const list = JSON.parse(localStorage.getItem(autoTextKey()) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } };
  const saveAutoTexts = list => { try { localStorage.setItem(autoTextKey(), JSON.stringify(list)); return true; } catch { fail(new Error('AutoText could not be saved in this browser.')); return false; } };
  async function saveAutoText() {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    const [a, b] = engine.model.range;
    if (a === b) { toast('Select the text to save as AutoText first.', { icon: 'info' }); return; }
    const { copyFragment } = await import('../engine/clipboard-fragment.js');
    const fragment = copyFragment(engine.model), text = engine.model.text.slice(a, b).replace(/\uFFFC/g, '');
    const name = await promptDialog({ title: 'Create New Building Block', label: 'Name', value: text.trim().split(/\s+/).slice(0, 4).join(' ').slice(0, 40), confirmLabel: 'Save',
      hint: fragment ? 'Saved with its formatting, for you in this browser.' : 'Pictures, fields and tables are saved as their text.', validate: v => v.trim() ? null : 'Enter a name.' });
    if (!name) return;
    const list = autoTexts().filter(entry => entry.name !== name.trim());
    if (saveAutoTexts([{ name: name.trim(), text, fragment, created: new Date().toISOString() }, ...list].slice(0, 100))) toast(`Saved “${name.trim()}” to AutoText`, { icon: 'check' });
    engine.focus();
  }
  async function insertAutoText(entry) {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    const { pasteFragment, carriesFormatting } = await import('../engine/clipboard-fragment.js');
    run(engine, () => entry.fragment && carriesFormatting(engine.model) && !engine.model.tableContext ? pasteFragment(engine.model, entry.fragment) : engine.model.replace(entry.text));
  }
  function quickPartsItems() {
    const engine = ready(), entries = autoTexts();
    return [
      { label: 'AutoText', icon: 'textBox', disabled: !engine, items: [
        ...(entries.length ? entries.map(entry => ({ label: entry.name, hint: entry.text.slice(0, 60), onSelect: () => insertAutoText(entry) })) : [{ label: 'No AutoText entries yet', disabled: true }]),
        { separator: true }, { label: 'Save Selection to AutoText Gallery…', disabled: !engine || engine.model.range[0] === engine.model.range[1], onSelect: saveAutoText },
        ...(entries.length ? [{ label: 'Delete Entry', items: entries.map(entry => ({ label: entry.name, onSelect: async () => {
          if (await confirmDialog({ title: 'Delete AutoText?', message: `Delete “${entry.name}” from your AutoText gallery?`, confirmLabel: 'Delete' })) saveAutoTexts(autoTexts().filter(e => e.name !== entry.name));
        } })) }] : [])] },
      { label: 'Document Property', disabled: !engine, items: DOCUMENT_PROPERTY_NAMES.map(([label, key]) => ({ label: label === 'LastSavedBy' ? 'Last Saved By' : label, hint: documentProperties(pkg()?.parts || {})[key] || 'Empty', onSelect: () => propertyField(label, key) })) },
      { label: 'Field…', icon: 'field', disabled: !engine, onSelect: insertField },
    ];
  }

  /* ---- Text from file ---- */
  async function insertTextFromFile(file) {
    const engine = ready(); if (!engine || !file) return;
    try {
      engine.finishComposition();
      const { htmlFragment, pasteFragment, copyFragment, carriesFormatting } = await import('../engine/clipboard-fragment.js');
      const formatted = carriesFormatting(engine.model) && !engine.model.tableContext;
      let fragment = null, text = '';
      if (/\.(docx|dotx|docm)$/i.test(file.name)) {
        const [{ DocxPackage }, { TextDocument }] = await Promise.all([import('../engine/docx.js'), import('../engine/model.js')]);
        const opened = await DocxPackage.open(new Uint8Array(await file.arrayBuffer()), { bestEffort: true });
        const source = new TextDocument(opened.paragraphs, opened.pageSettings, opened.numbering, opened.styles, opened.tables, opened.assets, { displayOnly: !!opened.readOnly });
        source.select(0, source.text.length);
        fragment = formatted ? copyFragment(source) : null;
        text = source.text.replace(/[\uFFFC]/g, '').replace(/[\f\u000e]/g, '\n');
        if (!fragment) toast('Pictures, tables and fields in that file were inserted as text.', { icon: 'info' });
      } else {
        // Decoded as opening the file decodes it: a byte order mark names UTF-16 (Notepad's "Unicode"), and a
        // file that is not UTF-8 is read in the code page it was written in rather than as replacement characters.
        const { decodeTextFile } = await import('../lib/importers.js');
        const raw = decodeTextFile(await file.arrayBuffer(), /\.html?$/i.test(file.name) ? 'html' : null);
        if (/\.(md|markdown)$/i.test(file.name)) { const { markdownHtml } = await import('../lib/markdown-html.js'); fragment = formatted ? htmlFragment(markdownHtml(raw)) : null; text = raw; }
        else if (/\.html?$/i.test(file.name)) {
          // Without formatting (in a table cell, say) the page's text goes in as its paragraphs, not as the markup's
          // raw text content, which runs paragraphs together and includes the text of scripts and styles.
          const converted = htmlFragment(raw);
          fragment = formatted ? converted : null;
          text = converted ? converted.paragraphs.map(p => p.text).join('\n') : '';
        }
        else text = raw.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
      }
      run(engine, () => fragment ? pasteFragment(engine.model, fragment) : engine.model.replace(text));
    } catch (e) { fail(e); }
  }
  const textFileInput = el('input', { type: 'file', accept: '.docx,.dotx,.docm,.md,.markdown,.txt,.html,.htm', hidden: true, 'aria-label': 'Insert text from file',
    onchange: () => { const file = textFileInput.files?.[0]; textFileInput.value = ''; if (file) insertTextFromFile(file); } });
  const objectItems = () => [{ label: 'Text from File…', icon: 'object', disabled: !ready(), onSelect: () => textFileInput.click() }];

  /* ---- Equations ---- */
  const selectedMath = () => {
    const engine = ready(); if (!engine) return null;
    const [a, b] = engine.model.range; if (b - a !== 1 || engine.model.text[a] !== OBJECT) return null;
    let at = 0;
    for (const p of engine.model.paragraphs) {
      for (const r of p.runs) { if (at <= a && a < at + r.text.length) return r.math ? r : null; at += r.text.length; }
      at += 1;
    }
    return null;
  };
  function placeEquation({ linear, display }) {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    const xml = linearToOmml(linear, { display }), text = (ommlToLinear(xml) || linear).replace(/\s+/g, ' ').trim() || 'Equation';
    run(engine, () => {
      const model = engine.model;
      if (display) {
        // A displayed equation is the only content of its paragraph.
        const [start] = model.range, before = model.text.lastIndexOf('\n', start - 1) + 1, after = model.text.indexOf('\n', start);
        const end = after < 0 ? model.text.length : after;
        if (model.text.slice(before, start).trim()) model.replace('\n');
        model.insertMathRun({ xml, text });
        if (model.text.slice(model.range[0], end + (model.text.length - end > 0 ? 1 : 0)).replace(/\n$/, '').trim() && model.range[0] < model.text.length && model.text[model.range[0]] !== '\n') { model.replace('\n'); }
        return true;
      }
      return model.insertMathRun({ xml, text });
    });
  }
  function insertEquation(initial = null) {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    const current = initial ? null : selectedMath();
    openEquationDialog({ initial: initial?.linear ?? (current ? ommlToLinear(current.math.xml) : ''), display: initial?.display ?? /oMathPara/.test(current?.math.xml || ''), editing: !!current,
      onClose: () => queueMicrotask(() => editor()?.focus()), onInsert: placeEquation });
  }
  function equationItems() {
    const engine = ready();
    const preview = linear => { const node = el('span.insert-equation-thumb'); try { node.innerHTML = ommlToMathml(linearToOmml(linear)); } catch { node.textContent = linear; } return node; };
    return [...galleryItems([{ header: 'Built-In', items: EQUATION_GALLERY.map(entry => ({ label: entry.name, preview: preview(entry.linear), disabled: !engine, onSelect: () => placeEquation({ linear: entry.linear, display: true }) })) }], { columns: 2, size: 'wide', label: 'Equations' }),
      { separator: true }, { label: 'Insert New Equation', icon: 'equation', shortcut: equationShortcut, disabled: !engine, onSelect: () => insertEquation() },
      ...(selectedMath() ? [{ label: 'Edit Equation…', onSelect: () => insertEquation() }] : [])];
  }
  const equationShortcut = MOD_KEY === 'Cmd' ? 'Ctrl+=' : 'Alt+=';

  /* ---- Symbols ---- */
  function placeSymbol(ch, font = null) {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    run(engine, () => {
      const start = engine.model.range[0];
      engine.model.replace(ch);
      if (font) { engine.model.select(start, start + ch.length); engine.model.setRunFormat({ fontAscii: font, fontHAnsi: font }); engine.model.select(start + ch.length); }
      return true;
    });
    rememberSymbol(ch);
  }
  function symbolItems() {
    const engine = ready();
    return [...galleryItems([{ header: 'Recently Used', items: recentSymbols().map(ch => ({ label: ch, hint: `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`, preview: textPreview(ch), disabled: !engine, onSelect: () => placeSymbol(ch) })) }], { columns: 5, size: 'symbol', label: 'Symbols' }),
      { separator: true }, { label: 'More Symbols…', icon: 'symbol', disabled: !engine, onSelect: moreSymbols }];
  }
  function moreSymbols() {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    openSymbolDialog({ onClose: () => queueMicrotask(() => editor()?.focus()), onInsert: (ch, font) => placeSymbol(ch, font) });
  }

  /* ---- Ribbon ---- */
  const asSmall = (control, icon, label) => { control.classList.remove('ribbon-large'); control.replaceChildren(); return small(control, { icon, label }); };
  function insertRibbon(kit) {
    const { command, menuButton, rows, when, engineReady } = kit;
    const can = () => engineReady() && !!ready();
    const noSteal = (...buttons) => { for (const b of buttons) b.addEventListener('mousedown', e => e.preventDefault()); };
    // Pages stack as small commands, leaving room for the larger galleries.
    const coverPage = menuButton('Cover Page', 'coverPage', coverPageItems, { size: 'small', text: 'Cover Page' });
    const blankPage = command('Blank Page', 'blankPage', () => { const engine = ready(); if (engine) { base.insertBlankPage?.(); onChange(); } }, { text: 'Blank Page' });
    // The editor's own page break control keeps its state and shortcut; here it is a small row command.
    const pageBreak = kit.pageBreak ? asSmall(kit.pageBreak, 'pageBreak', 'Page Break')
      : command('Page Break', 'pageBreak', () => { const engine = ready(); if (engine) { engine.insertPageBreak(); onChange(); } }, { text: 'Page Break', shortcut: `${MOD_KEY}+Enter` });
    const pictures = menuButton('Pictures', 'pictures', pictureItems, { text: 'Pictures' });
    const shapes = command('Shapes', 'shapes', e => openShapes(shapes, e), { size: 'large', caret: true, attrs: { 'aria-haspopup': 'menu' } });
    const icons = command('Icons', 'icons', () => insertIcons(), { text: 'Icons' });
    const diagram = menuButton('Diagram', 'smartArt', diagramItems, { size: 'small', text: 'Diagram' });
    const chart = command('Chart', 'chart', () => commands.insertChart?.(), { text: 'Chart' });
    // Screenshot is in the Pictures menu (only where the browser can capture the screen).
    const screenshotButton = null;
    const header = menuButton('Header', 'header', () => headerItems('header'));
    const footer = menuButton('Footer', 'footer', () => headerItems('footer'));
    const pageNumber = menuButton('Page Number', 'pageNumber', pageNumberItems, { text: 'Page Number' });
    const textBox = menuButton('Text Box', 'textBox', textBoxItems, { text: 'Text Box' });
    const quickParts = menuButton('Quick Parts', 'quickParts', quickPartsItems, { size: 'small', text: 'Quick Parts' });
    const wordArt = menuButton('WordArt', 'wordArt', wordArtItems, { size: 'small', text: 'WordArt' });
    const dropCap = menuButton('Drop Cap', 'dropCap', dropCapItems, { size: 'small', text: 'Drop Cap' });
    const signature = command('Signature Line', 'signatureLine', () => insertSignatureLine(), { text: 'Signature Line' });
    const dateTime = command('Date & Time', 'dateTime', () => insertDateTime(), { text: 'Date & Time' });
    const object = menuButton('Object', 'object', objectItems, { size: 'small', text: 'Object' });
    const equationMain = command('Equation', 'equation', () => insertEquation(), { size: 'large', shortcut: equationShortcut });
    const equation = kit.split(equationMain, { label: 'Equation gallery', size: 'large', open: (anchor, e) => openMenu({ anchor, label: 'Equations', minWidth: 300, pointer: !!e?.detail, onClose: e?.detail ? () => editor()?.focus() : null, items: equationItems() }) });
    const symbol = menuButton('Symbol', 'symbol', symbolItems, { size: 'small', text: 'Symbol' });
    noSteal(blankPage, shapes, icons, chart, signature, dateTime, equationMain, ...(screenshotButton ? [screenshotButton] : []));
    when(coverPage, can); when(blankPage, () => can() && !ready()?.model.selectedParagraphs[0]?.cellId); if (!kit.pageBreak) when(pageBreak, () => can() && !ready()?.model.selectedParagraphs[0]?.cellId);
    for (const control of [pictures, shapes, icons, diagram, chart, header, footer, pageNumber, textBox, quickParts, wordArt, dropCap, signature, dateTime, object, equationMain, equation.arrow, symbol, ...(screenshotButton ? [screenshotButton] : [])]) when(control, can);
    return {
      pages: [rows([coverPage], [blankPage], [pageBreak])],
      illustrations: [pictures, shapes, rows([icons], [diagram], [chart])],
      headerFooter: [header, footer, pageNumber],
      text: [textBox, rows([quickParts], [wordArt], [dropCap]), rows([signature], [dateTime], [object])],
      symbols: [equation, rows([symbol])],
    };
  }

  /* ---- Menu bar and context menu ---- */
  function extendMenu(menuId) {
    const engine = ready(), disabled = !engine;
    if (menuId === 'insert') return [
      { label: 'Pictures', icon: 'pictures', disabled, items: pictureItems() },
      { label: 'Shapes…', icon: 'shapes', disabled, onSelect: () => openShapes(document.querySelector('#ribbon-panel-insert [aria-label="Shapes"]') || document.activeElement) },
      { label: 'Diagram…', icon: 'smartArt', disabled, onSelect: () => insertDiagram() },
      { label: 'Chart…', icon: 'chart', disabled: disabled || !commands.insertChart, onSelect: () => commands.insertChart?.() },
      { label: 'Icons…', icon: 'icons', disabled, onSelect: insertIcons },
      ...(canCapture() ? [{ label: 'Screenshot…', icon: 'screenshot', disabled, onSelect: screenshot }] : []),
      { separator: true },
      { label: 'Cover Page', icon: 'coverPage', disabled, items: coverPageItems() },
      { label: 'Header', icon: 'header', disabled, items: headerItems('header') },
      { label: 'Footer', icon: 'footer', disabled, items: headerItems('footer') },
      { label: 'Page Numbers', icon: 'pageNumber', disabled, items: pageNumberItems() },
      { separator: true },
      { label: 'Text Box', icon: 'textBox', disabled, items: textBoxItems() },
      { label: 'AutoText', disabled, items: quickPartsItems()[0].items },
      { label: 'Date and Time…', icon: 'dateTime', disabled, onSelect: insertDateTime },
      { label: 'Field…', icon: 'field', disabled, onSelect: insertField },
      { label: 'WordArt', icon: 'wordArt', disabled, items: wordArtItems() },
      { label: 'Signature Line…', icon: 'signatureLine', disabled, onSelect: insertSignatureLine },
      { label: 'Text from File…', icon: 'object', disabled, onSelect: () => textFileInput.click() },
      { separator: true },
      { label: 'Link…', icon: 'link', shortcut: `${MOD_KEY}+K`, disabled, onSelect: () => base.link?.() },
      { label: 'Bookmark…', icon: 'bookmark', disabled, onSelect: () => base.bookmark?.() },
      { label: 'Comment', icon: 'newComment', disabled: disabled || !base.comment, onSelect: () => base.comment?.() },
      { separator: true },
      { label: 'Equation', icon: 'equation', shortcut: equationShortcut, disabled, onSelect: () => insertEquation() },
      { label: 'Symbol…', icon: 'symbol', disabled, onSelect: moreSymbols },
    ];
    if (menuId === 'format') return [{ label: 'Drop Cap…', icon: 'dropCap', disabled, onSelect: dropCapOptions }];
    return [];
  }
  function contextMenuItems(context) {
    if (!ready()) return [];
    if (context === 'image' || context === 'shape') {
      const items = [];
      if (selectedDiagram()) items.push({ label: 'Edit Diagram…', icon: 'smartArt', onSelect: () => insertDiagram() });
      if (ready()?.model.selectedImage?.kind === 'chart' && commands.editChart) items.push({ label: 'Edit Chart Data…', icon: 'chart', onSelect: () => commands.editChart() });
      return items;
    }
    if (context === 'text' && selectedMath()) return [{ label: 'Edit Equation…', icon: 'equation', onSelect: () => insertEquation() }];
    return [];
  }

  /* ---- Keyboard: equation, date, time and page fields ---- */
  const keyAbort = new AbortController();
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e) || typesCharacter(e) || !e.target?.matches?.('.canvas-input') || !ready()) return;
    const equationChord = MOD_KEY === 'Cmd' ? e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey : e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (equationChord && e.code === 'Equal') { e.preventDefault(); insertEquation(); return; }
    const code = shortcutCode(e);
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && ['KeyD', 'KeyT', 'KeyP'].includes(code)) {
      e.preventDefault();
      if (code === 'KeyP') { insertPageNumber('current', PAGE_NUMBER_DESIGNS[0], null); return; }
      const picture = code === 'KeyD' ? 'M/d/yyyy' : 'h:mm am/pm', engine = ready();
      if (engine.session.path !== null) run(engine, () => engine.model.replace(formatDatePicture(new Date(), picture)));
      else insertFieldInstruction(fieldInstruction({ name: code === 'KeyD' ? 'DATE' : 'TIME', picture }));
    }
  }, { signal: keyAbort.signal, capture: true });

  const commands = {
    insertRibbon, coverPageItems, pictureItems, insertPictureFile, openShapes, insertShapeAt, insertIcons, insertDiagram, diagramItems, screenshot,
    headerItems, pageNumberItems, formatPageNumbers, removePageNumbers,
    insertPageNumber: (event, button) => openMenu({ anchor: button || document.activeElement, label: 'Page Number', minWidth: 220, items: pageNumberItems(), pointer: !!event?.detail, onClose: event?.detail ? () => editor()?.focus() : null }),
    textBoxItems, insertTextBox: () => insertTextBoxDesign(TEXT_BOX_DESIGNS[0]), wordArtItems, insertWordArt, insertSignatureLine,
    dropCapItems, dropCapOptions, insertDateTime, insertField, quickPartsItems, saveAutoText, objectItems, insertTextFromFile,
    equationItems, insertEquation, symbolItems, insertSymbol: moreSymbols, moreSymbols,
    extendMenu, contextMenuItems,
  };
  Object.assign(commands, chartCommands({ hub: { ready, fail, insertDrawing, textWidth }, pkg, editor }));
  // The editor places these file inputs in its own element, not on the page body.
  return { commands, insertDrawing, sceneFragment, textWidth, fail, ready, run, inputs: [pictureInput, textFileInput], destroy() { keyAbort.abort(); cancelDrawing(); pictureInput.remove(); textFileInput.remove(); setFieldContextProvider(null); } };
}
