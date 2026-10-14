import { el, isComposing } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { changeCase, captureFormat, applyFormat, sortParagraphs } from '../engine/home-editing.js';
import { prepareCanvasFont, documentFontAvailable } from '../engine/font-availability.js';
import { openFontDialog } from './font-dialog.js';
import { insertCoverPage, COVER_DESIGNS } from '../engine/cover-pages.js';
import { setImageWrap, imageWrapMode, wrapUnavailable } from '../engine/image-wrap.js';
import { applyListLibrary, libraryIndex, applyMultilevelList, MULTILEVEL_LIBRARY } from '../engine/list-library.js';
import { levelFor, listKind } from '../engine/numbering.js';
import { engineApi } from '../lib/engine-api.js';
import { openColorPalette } from '../ui/color-palette.js';
import { TEXT_COLORS } from './text-color.js';
const EMU_PER_INCH = 914400;
const LINE_WEIGHTS = [['¼ pt', 3175], ['½ pt', 6350], ['¾ pt', 9525], ['1 pt', 12700], ['1½ pt', 19050], ['2¼ pt', 28575], ['3 pt', 38100], ['4½ pt', 57150], ['6 pt', 76200]];

/**
 * Home-tab editing commands: Format Painter, Change Case, Sort and Show/Hide ¶. Each change goes through
 * the engine's transaction, so it is one undo step and marks the document changed.
 */
/** Paragraph Spacing presets: name, space before and after (pt), line spacing (lines). */
export const PARAGRAPH_SPACING = [
  ['No Paragraph Space', 0, 0, 1], ['Compact', 0, 4, 1], ['Tight', 0, 6, 1.15], ['Open', 0, 10, 1.15], ['Relaxed', 0, 6, 1.5], ['Double', 0, 8, 2],
];

// Formatting marks stay on for the next document opened in this tab: the setting is per window, not per document.
let marks = false;

export function createEditingCommands({ editor, pkg, host, refresh, zoomControl, error = () => {}, editDrawingText = () => {}, documentTitle = () => '' }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly ? engine : null; };
  let painter = null;

  function stopPainting() {
    painter = null;
    host()?.classList.remove('is-format-painting');
    refresh();
  }
  // The painter applies when a mouse selection in the document finishes, after the engine has placed it.
  const onPointerUp = e => {
    const engine = ready();
    if (!painter || !engine || e.button !== 0 || !engine.pages.contains(e.target)) return;
    const captured = painter.captured, sticky = painter.sticky;
    engine.execute(() => applyFormat(engine.model, captured));
    if (!sticky) stopPainting();
    engine.focus();
  };
  const onKey = e => { if (painter && e.key === 'Escape' && !isComposing(e)) { e.preventDefault(); stopPainting(); } };
  let listening = null;
  function listen() {
    const node = host();
    if (!node || listening === node) return;
    listening?.removeEventListener('pointerup', onPointerUp);
    listening?.removeEventListener('keydown', onKey, true);
    node.addEventListener('pointerup', onPointerUp);
    node.addEventListener('keydown', onKey, true);
    listening = node;
  }

  return {
    /** One click paints once; a double click keeps painting until Escape or another click on the button. */
    formatPainter(event) {
      const engine = ready(); if (!engine) return;
      if (painter && !(event?.detail === 2)) { stopPainting(); engine.focus(); return; }
      engine.finishComposition();
      painter = { captured: painter?.captured || captureFormat(engine.model), sticky: event?.detail === 2 };
      listen();
      host()?.classList.add('is-format-painting');
      refresh(); engine.focus();
    },
    formatPainterActive: () => !!painter,
    /** Wrap Text for pictures and shapes; a picture leaving the line keeps its place. */
    wrapItems() {
      const engine = ready(), image = engine?.model.selectedImage, mode = imageWrapMode(image);
      const place = () => {
        const layout = engine.layout, line = layout.lines.find(l => l.fragments.some(f => f.image === image));
        const fragment = line?.fragments.find(f => f.image === image);
        if (!line || !fragment) return { x: 0, y: 0 };
        const page = layout.pages[line.page] || layout.page, top = Math.min(...layout.lines.filter(l => l.paragraphId === line.paragraphId && l.page === line.page).map(l => l.y));
        return { x: Math.round((fragment.x - page.left) * 9525), y: Math.max(0, Math.round((line.y - top) * 9525)) };
      };
      const choose = value => { const engine = ready(); if (!engine) return; engine.finishComposition(); engine.execute(() => setImageWrap(engine.model, value, value !== 'inline' && mode === 'inline' ? place() : undefined)); engine.focus(); };
      const option = (label, value, icon) => ({ label, icon, radio: true, checked: mode === value, disabled: !image || !!wrapUnavailable(image, value), hint: image && wrapUnavailable(image, value) || undefined, onSelect: () => choose(value) });
      const floating = !!image?.anchor && mode !== 'other';
      return [option('In Line with Text', 'inline', 'wrapInline'), option('Square', 'square', 'wrapSquare'), option('Top and Bottom', 'topAndBottom', 'wrapTopBottom'),
        option('Behind Text', 'behind', 'behindText'), option('In Front of Text', 'front', 'inFront'), { separator: true },
        { label: 'Bring to Front', icon: 'bringForward', disabled: !floating, onSelect: () => { const engine = ready(); if (engine) { engine.execute(() => engine.model.arrangeImage('front')); engine.focus(); } } },
        { label: 'Send to Back', icon: 'sendBackward', disabled: !floating, onSelect: () => { const engine = ready(); if (engine) { engine.execute(() => engine.model.arrangeImage('back')); engine.focus(); } } }];
    },
    canWrap: () => !!ready()?.model.selectedImage,
    /** Picture Format → Rotate and Size, for pictures (drawings keep their own geometry). */
    pictureSelected: () => { const image = ready()?.model.selectedImage; return !!image && !image.retainedDrawing && image.kind !== 'chart'; },
    rotateItems() {
      const engine = ready(), image = engine?.model.selectedImage, ok = !!image && !image.retainedDrawing && image.kind !== 'chart';
      const turn = degrees => { const engine = ready(); if (!engine) return; engine.finishComposition(); const current = engine.model.selectedImage.rotation || 0;
        engine.execute(() => engine.model.setImageProperties({ rotation: ((current + degrees * 60000) % 21600000 + 21600000) % 21600000 })); engine.focus(); };
      const flip = key => { const engine = ready(); if (!engine) return; engine.finishComposition(); engine.execute(() => engine.model.setImageProperties({ [key]: !engine.model.selectedImage[key] })); engine.focus(); };
      return [{ label: 'Rotate Right 90°', disabled: !ok, onSelect: () => turn(90) }, { label: 'Rotate Left 90°', disabled: !ok, onSelect: () => turn(-90) },
        { label: 'Flip Vertical', disabled: !ok, onSelect: () => flip('flipV') }, { label: 'Flip Horizontal', disabled: !ok, onSelect: () => flip('flipH') }];
    },
    pictureSize(key) { const image = ready()?.model.selectedImage; return image && !image.retainedDrawing ? Math.round(image[key] / EMU_PER_INCH * 100) / 100 : null; },
    setPictureSize(key, inches) {
      const engine = ready(), image = engine?.model.selectedImage; if (!image) return;
      engine.finishComposition();
      // Pictures keep their proportions by default (aspect ratio locked).
      const value = Math.round(inches * EMU_PER_INCH), other = key === 'width' ? 'height' : 'width';
      const patch = { [key]: value, [other]: Math.max(1, Math.round(value * image[other] / image[key])) };
      engine.execute(() => engine.model.setImageProperties(patch)); engine.focus();
    },
    /** Insert → Cover Page: original designs filled with the document's name and today's date, ready to edit. */
    coverPageItems() {
      const descriptions = { simple: 'Centered title, subtitle, author and date', banded: 'Title on a dark band', lined: 'Ruled title with author and date at the right' };
      return [{ header: 'Built-In' }, ...COVER_DESIGNS.map(design => ({ label: design.name, hint: descriptions[design.id], disabled: !ready(), onSelect: () => {
        const engine = ready(); if (!engine) return;
        engine.finishComposition();
        if (engine.session.path !== null) engine.editStory(null);
        const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date());
        engine.execute(() => insertCoverPage(engine.model, design.id, { title: documentTitle() || 'Document Title', subtitle: 'Document subtitle', author: 'Author Name', date }));
        engine.revealCaret(); engine.focus();
      } }))];
    },
    /** Insert → Shapes and the Shape Format tab. */
    openShapes(anchor, event) {
      const engine = ready(); if (!engine) return;
      engineApi().openShapeGallery({ anchor, pointer: !!event?.detail, onClose: event?.detail ? () => editor()?.focus() : null, onPick: preset => { const engine = ready(); if (engine) engineApi().insertShape(engine, preset).catch(error); } });
    },
    shapeSelected: () => !!engineApi()?.selectedShape(ready()),
    /** Insert → Text Box: insert one, then edit its text. */
    insertTextBox() {
      const engine = ready(); if (!engine) return;
      engineApi().insertTextBox(engine).then(ok => { if (ok) editDrawingText(); }).catch(error);
    },
    editShapeText: () => editDrawingText(),
    shapeColorMenu(anchor, key) {
      const shape = engineApi()?.selectedShape(ready()); if (!shape) return;
      const value = shape.params[key];
      openColorPalette({ anchor, label: key === 'fill' ? 'Shape Fill' : 'Shape Outline', value: value ?? 'none', choices: TEXT_COLORS, custom: true, customLabel: key === 'fill' ? 'fill color' : 'outline color',
        reset: { value: 'none', label: key === 'fill' ? 'No Fill' : 'No Outline', indicator: '∅' },
        onPick: color => { const engine = ready(); if (engine) engineApi().updateShape(engine, { [key]: color === 'none' ? null : color }).catch(error); } });
    },
    shapeWeightItems() {
      const shape = engineApi()?.selectedShape(ready());
      return LINE_WEIGHTS.map(([label, width]) => ({ label, radio: true, checked: !!shape?.params.line && shape.params.lineWidth === width, disabled: !shape,
        onSelect: () => { const engine = ready(); if (engine) engineApi().updateShape(engine, { lineWidth: width, ...(shape.params.line ? {} : { line: '000000' }) }).catch(error); } }));
    },
    shapeSize(key) { const shape = engineApi()?.selectedShape(ready()); return shape ? Math.round(shape.image[key] / EMU_PER_INCH * 100) / 100 : null; },
    setShapeSize(key, inches) { const engine = ready(); if (engine && engineApi().selectedShape(engine)) engineApi().updateShape(engine, { [key]: Math.round(inches * EMU_PER_INCH) }).catch(error); },
    /** Home → Bullets ▾ / Numbering ▾. */
    applyListLibrary(kind, index) { const engine = ready(); if (!engine) return; engine.finishComposition(); engine.execute(() => applyListLibrary(engine.model, kind, index)); engine.focus(); },
    multilevelItems() {
      return MULTILEVEL_LIBRARY.map(([label], index) => ({ label, disabled: !ready(), onSelect: () => { const engine = ready(); if (!engine) return; engine.finishComposition(); engine.execute(() => applyMultilevelList(engine.model, index)); engine.focus(); } }));
    },
    removeList(kind) { const engine = ready(); if (!engine) return; if (engine.model.listFormatting === kind) engine.toggleList(kind); else engine.focus(); },
    listLibraryIndex(kind) {
      const model = editor()?.model, lists = model?.selectedParagraphs.map(p => p.list) || [];
      if (!lists.length || !lists.every(Boolean)) return lists.some(Boolean) ? -1 : -2;
      try { return lists.every(l => l.numId === lists[0].numId && l.level === lists[0].level) && listKind(model.numbering, lists[0]) === kind ? libraryIndex(levelFor(model.numbering, lists[0]), kind) : -1; } catch { return -1; }
    },
    /** Design → Paragraph Spacing: the presets, set on the Normal style so every style based on it follows. */
    paragraphSpacingItems() {
      const engine = editor(), id = engine?.model.styles.defaultParagraph;
      const style = id ? engine.model.styles.definitions[id] : null;
      const spacing = style?.properties?.spacing || {};
      const current = style && { before: (spacing.before ?? 0) / 20, after: spacing.after === undefined ? null : spacing.after / 20, line: spacing.line === undefined ? null : spacing.line / 240, rule: spacing.lineRule ?? 'auto' };
      const apply = paragraph => {
        const engine = ready(); if (!engine || !id) return;
        engine.finishComposition();
        engine.editParagraphStyle(id, { paragraph });
        engine.focus();
      };
      const same = (a, b) => a !== null && Math.abs(a - b) < 0.01;
      return [{ header: 'Built-In' },
        { label: 'Style Set Default', hint: 'Inherit from the document defaults', disabled: !id || !engine || !!pkg()?.readOnly,
          onSelect: () => apply({ spaceBefore: null, spaceAfter: null, lineSpacing: null, lineRule: null }) },
        ...PARAGRAPH_SPACING.map(([label, before, after, line]) => ({
          label, hint: `Before ${before} pt · After ${after} pt · Line ${line}`, radio: true, disabled: !id || !engine || !!pkg()?.readOnly,
          checked: !!current && current.rule === 'auto' && same(current.before, before) && same(current.after, after) && same(current.line, line),
          onSelect: () => apply({ spaceBefore: before, spaceAfter: after, lineSpacing: line, lineRule: 'auto' }),
        }))];
    },
    insertColumnBreak() { const engine = ready(); if (!engine) return; engine.finishComposition(); engine.execute(() => engine.model.insertColumnBreak()); engine.focus(); },
    changeCase(mode) {
      const engine = ready(); if (!engine) return;
      engine.finishComposition();
      engine.execute(() => changeCase(engine.model, mode));
      engine.focus();
    },
    sortParagraphs() {
      const engine = ready(); if (!engine) return;
      engine.finishComposition();
      const type = el('select.input', { 'aria-label': 'Type' }, el('option', { value: 'text' }, 'Text'), el('option', { value: 'number' }, 'Number'), el('option', { value: 'date' }, 'Date'));
      const order = name => el('input', { type: 'radio', name: 'sort-order', value: name, checked: name === 'ascending' });
      const ascending = order('ascending'), descending = order('descending');
      const caseSensitive = el('input', { type: 'checkbox' });
      const message = el('p.field-error', { role: 'alert', hidden: true });
      let modal;
      const content = el('form.ed-dialog-body.ed-sort', { onsubmit: e => {
        e.preventDefault();
        let failure = null;
        const ok = engine.execute(() => sortParagraphs(engine.model, { type: type.value, descending: descending.checked, caseSensitive: caseSensitive.checked }), e => { failure = e; }, undefined, true);
        if (!ok && failure) { message.textContent = failure.message; message.hidden = false; return; }
        modal.close(); engine.focus();
      } },
      el('div.ed-sort-row', {}, el('span.field-label', {}, 'Sort by'), el('span.ed-sort-value', {}, 'Paragraphs')),
      el('label.ed-sort-row', {}, el('span.field-label', {}, 'Type'), type),
      el('fieldset.ed-sort-order', {}, el('legend.visually-hidden', {}, 'Order'),
        el('label', {}, ascending, 'Ascending'), el('label', {}, descending, 'Descending')),
      el('label.ed-check', {}, caseSensitive, 'Case sensitive'),
      message,
      el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
      modal = openModal({ title: 'Sort Text', content, onClose: () => queueMicrotask(() => editor()?.focus()) });
      type.focus();
    },
    toggleMarks() {
      const engine = editor(); if (!engine) return;
      marks = engineApi().setFormattingMarks(engine, !engineApi().formattingMarksVisible(engine));
      refresh(); engine.focus();
    },
    marksVisible: () => engineApi()?.formattingMarksVisible(editor()),
    /** View → Multiple Pages: pages side by side, zoomed so two fit across the window, until another zoom is chosen. */
    multiplePages() {
      const engine = editor(); if (!engine) return;
      const host = engine.host, widest = Math.max(...engine.layout.pages.map(p => p.width)), tallest = Math.max(...engine.layout.pages.map(p => p.height));
      const across = Math.min(2, engine.layout.pageCount), gap = engine.layout.page.gap;
      const scale = Math.min((host.clientWidth - 64 - gap * (across - 1)) / (widest * across), (host.clientHeight - 48) / tallest);
      zoomControl.set(Math.max(0.1, Math.min(2, Math.floor(scale * 100) / 100)));
      engine.pages.classList.add('is-multipage');
      engine.resizeCanvases(); engine.revealCaret(); engine.focus();
    },
    multiplePagesActive: () => !!editor()?.pages.classList.contains('is-multipage'),
    /** Home → Text Effects: outline and shadow presets, written as w14 text effects. */
    textEffectItems() {
      const engine = editor(), format = engine?.model.runFormatting || {}, disabled = !ready();
      const ink = format.color && format.color !== 'auto' ? format.color : '000000';
      const apply = patch => { const engine = ready(); if (!engine) return; engine.finishComposition(); engine.setRunFormat(patch); };
      const shadow = (label, distance, direction) => ({ label, radio: true, disabled,
        checked: !!format.textShadow && format.textShadow.distance === distance && format.textShadow.direction === direction,
        onSelect: () => apply({ textShadow: { blurRadius: 38100, distance, direction, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, alignment: 'tl', color: '000000', alpha: 0.6 } }) });
      const outline = (label, width) => ({ label, radio: true, disabled, checked: !!format.textOutline && format.textOutline.width === width,
        onSelect: () => apply({ textOutline: { width, color: ink, join: 'round', cap: 'flat', miter: 8 } }) });
      return [
        { header: 'Outline' },
        { label: 'No Outline', radio: true, disabled, checked: !format.textOutline, onSelect: () => apply({ textOutline: null }) },
        outline('Thin Outline (¾ pt)', 9525), outline('Medium Outline (1½ pt)', 19050),
        { separator: true }, { header: 'Shadow' },
        { label: 'No Shadow', radio: true, disabled, checked: !format.textShadow, onSelect: () => apply({ textShadow: null }) },
        shadow('Offset: Bottom Right', 38100, 2700000), shadow('Offset: Bottom', 38100, 5400000), shadow('Offset: Right', 38100, 0),
      ];
    },
    /** Home → Font launcher and Ctrl/Cmd+D. */
    fontDialog() {
      const engine = ready(); if (!engine) return;
      engine.finishComposition();
      const [start, end] = engine.model.range;
      openFontDialog({ format: engine.model.runCommandFormatting, sample: engine.model.text.slice(start, end),
        onClose: () => queueMicrotask(() => editor()?.focus()),
        apply: async (patch, fail) => {
          if (patch.fontAscii) {
            await prepareCanvasFont(patch.fontAscii);
            if (documentFontAvailable(patch.fontAscii, engine.model.styles.fontAlternatives) !== true) { fail(new Error(`${patch.fontAscii} could not be loaded on this device. Choose another font.`)); return false; }
          }
          if (editor() !== engine) return false;
          return engine.execute(() => engine.model.setRunFormat(patch), fail, undefined, true);
        } });
    },
    /** A newly opened document keeps the marks setting, as the word processor keeps it per window. */
    restoreMarks(engine) { if (marks && engine) engineApi().setFormattingMarks(engine, true); },
    destroy() {
      listening?.removeEventListener('pointerup', onPointerUp);
      listening?.removeEventListener('keydown', onKey, true);
      listening = null; painter = null;
    },
  };
}
