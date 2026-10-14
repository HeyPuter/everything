/**
 * The View tab's document views and window tools.
 *
 * Views (setDocumentView): Print Layout (the authored pages), Read Mode (read-mode.js), Web Layout
 * (text reflowed to the window), Outline (outline-view.js, with the Outlining tab) and Draft (continuous
 * text with labelled breaks and an optional style area). Only the display changes; the document is the
 * same in every view, and the view is recorded in the document's settings (w:view) when it is saved.
 *
 * Also here: Page Movement (pages one under another, or side by side with a thumbnail strip), Gridlines,
 * the Zoom dialog and Ctrl/Cmd + wheel (or pinch) zoom, New Window (a live read-only copy in another
 * browser window, kept in step over a BroadcastChannel) and Split (a second, independently scrolling
 * pane of the same document).
 */
import { el, isComposing, MOD_KEY } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { paintFormattingMarks, formattingMarks } from '../engine/formatting-marks.js';
import { isContinuousView, usesScreenGeometry } from '../engine/document-views.js';
import { BODY_LEVEL, moveOutlineSection, setOutlineLevels, promotedLevel, demotedLevel, deleteOutlineSection, insertOutlineHeading, outlineUnits, subtreeEnd } from '../engine/outline-editing.js';
import { createOutlineView } from './outline-view.js';
import { createReadMode } from './read-mode.js';
import '../styles/document-views.css';

const VIEW_LABELS = { print: 'Print Layout', read: 'Read Mode', web: 'Web Layout', outline: 'Outline', draft: 'Draft' };
const GRID_SPACINGS = [[12, '⅛ inch'], [24, '¼ inch'], [48, '½ inch'], [96 / 2.54 * 0.5, '0.5 cm'], [96 / 2.54, '1 cm']];
const STYLE_AREAS = [[0, 'None'], [48, '0.5 inch'], [96, '1 inch'], [144, '1.5 inch']];

export function createDocumentViews({ editor, pkg, host, surface, root, error, commands: w, toggleNavigation, navigationVisible, rulers, layoutChanged = () => {}, exportDocument, documentTitle, onState = () => {} }) {
  let mode = 'print', attached = null, sideToSide = false, thumbnails = false, gridlines = false, gridSpacing = 24, styleArea = 0, split = null;
  let beforeRead = 'print';
  const ready = () => { const engine = editor(); return engine && pkg() ? engine : null; };

  /* ---- Outline view and Read Mode ---- */
  const outline = createOutlineView({ editor, readOnly: () => !!pkg()?.readOnly, error, onState: () => onState() });
  surface.append(outline.node);
  // The editor builds its root after the commands, so Read Mode reaches it through a getter.
  const read = createReadMode({ editor, host, root, exit: () => setDocumentView(beforeRead === 'read' ? 'print' : beforeRead),
    toggleNavigation, readAloud: () => w.readAloud?.(), readAloudActive: () => !!w.readAloudActive?.(), documentTitle });

  /* ---- Screen views ---- */
  /** The width (and height) the screen views lay out to, in layout pixels at the current zoom. */
  function screenView(kind) {
    const engine = ready(); if (!engine) return null;
    const style = getComputedStyle(engine.pages);
    const inner = host.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0) - 2 - (kind === 'draft' ? styleArea : 0);
    return { kind, width: Math.max(240, Math.floor(inner / engine.zoom)) };
  }
  function relayoutScreen() {
    const engine = ready(); if (!engine || !isContinuousView(mode)) return;
    const view = screenView(mode);
    if (view && engine.setView(view)) { layoutChanged(); paintStyleArea(); }
  }
  const resize = new ResizeObserver(() => { if (isContinuousView(mode)) requestAnimationFrame(relayoutScreen); });
  resize.observe(host);

  /** Draft view: labelled dotted rules for page and section breaks, painted on screen only. */
  const breakOverlay = (ctx, index, geometry) => {
    const engine = editor();
    if (mode !== 'draft' || !engine) return;
    if (breakOverlay.cache?.layout !== engine.layout) breakOverlay.cache = { layout: engine.layout, pages: new Map() };
    const cache = breakOverlay.cache;
    if (!cache.pages.has(index)) {
      const body = engine.session.body, lines = engine.layout.lines.filter(l => l.page === index && !l.pageStory);
      cache.pages.set(index, formattingMarks(lines, body.text, body.paragraphs, body.pageSettings, geometry).filter(m => m.kind === 'break' || m.kind === 'section'));
    }
    const marks = cache.pages.get(index);
    // The formatting marks already draw these when shown.
    if (marks.length && !engine.overlays.some(o => o.formattingMarks)) paintFormattingMarks(ctx, marks, geometry);
  };
  /** View → Gridlines: a light grid over the text area of every page, on screen only. */
  const gridOverlay = (ctx, index, geometry) => {
    if (!gridlines || mode === 'outline') return;
    const step = gridSpacing, left = geometry.left ?? 0, top = geometry.screenView ? 0 : geometry.top ?? 0;
    const right = geometry.width - (geometry.right ?? 0), bottom = geometry.height - (geometry.screenView ? 0 : geometry.bottom ?? 0);
    ctx.save();
    ctx.strokeStyle = 'rgba(80, 120, 170, 0.32)'; ctx.lineWidth = 0.6; ctx.setLineDash([1.5, 2.5]);
    ctx.beginPath();
    for (let x = left; x <= right + 0.01; x += step) { ctx.moveTo(x, top); ctx.lineTo(x, bottom); }
    for (let y = top; y <= bottom + 0.01; y += step) { ctx.moveTo(left, y); ctx.lineTo(right, y); }
    ctx.stroke();
    ctx.restore();
  };
  /** Split: the second pane copies the pages after every paint. */
  const mirrorOverlay = () => { if (split && !mirrorOverlay.queued) { mirrorOverlay.queued = true; queueMicrotask(() => { mirrorOverlay.queued = false; paintMirror(); }); } };
  /** Side to side: the thumbnails follow the pages. */
  const thumbOverlay = () => { if (sideToSide && thumbnails && !thumbOverlay.queued) { thumbOverlay.queued = true; setTimeout(() => { thumbOverlay.queued = false; paintThumbnails(); }, 120); } };
  const overlays = [breakOverlay, gridOverlay, mirrorOverlay, thumbOverlay];

  /* ---- Draft style area: each paragraph's style name in a column at the left ---- */
  const styleColumn = el('div.view-style-area', { 'aria-hidden': 'true', hidden: true });
  function paintStyleArea() {
    const engine = editor();
    const show = mode === 'draft' && styleArea > 0 && !!engine;
    styleColumn.hidden = !show;
    host.style.setProperty('--style-area', `${show ? styleArea : 0}px`);
    if (!show) return;
    // Beside the pages, not among them: the editor treats every child of its pages box as a page canvas.
    if (styleColumn.parentNode !== host) host.append(styleColumn);
    styleColumn.style.height = `${engine.pages.scrollHeight}px`;
    const styles = engine.model.styles.definitions, seen = new Set(), labels = [];
    for (const line of engine.layout.lines) {
      if (line.pageStory || line.virtual || seen.has(line.paragraphId) || line.cellId) continue;
      seen.add(line.paragraphId);
      const p = engine.model.paragraphs.find(q => q.id === line.paragraphId);
      const canvas = engine.canvases[line.page];
      if (!p || !canvas) continue;
      const name = styles[p.styleId || engine.model.styles.defaultParagraph]?.name || 'Normal';
      labels.push(el('span.view-style-name', { style: { top: `${canvas.offsetTop + line.y * engine.zoom}px`, width: `${styleArea - 8}px` }, title: name }, name.replace(/^heading (\d)$/i, 'Heading $1')));
    }
    styleColumn.style.width = `${styleArea}px`;
    styleColumn.replaceChildren(...labels);
  }

  /* ---- Switching views ---- */
  function setDocumentView(next, { remember = true } = {}) {
    const engine = ready();
    if (!VIEW_LABELS[next]) return;
    if (!engine) { mode = next; return; }
    if (next === mode) { if (next !== 'outline') engine.focus(); else outline.focus(); return; }
    engine.finishComposition();
    const previous = mode;
    // Leave the current view.
    let zoomBack = null;
    if (previous === 'read') zoomBack = read.leave();
    if (previous === 'outline') { outline.close(); host.hidden = false; }
    if (previous === 'draft') { styleColumn.hidden = true; host.style.removeProperty('--style-area'); }
    root()?.classList.remove(`ed-view-${previous}`);
    host.classList.remove(`view-${previous}`);
    mode = next;
    root()?.classList.add(`ed-view-${next}`);
    host.classList.add(`view-${next}`);
    if (usesScreenGeometry(next) || next === 'outline') { setSideToSide(false, { silent: true }); engine.pages.classList.remove('is-multipage'); }
    try {
      if (next === 'read') {
        beforeRead = previous;
        const zoom = engine.zoom;
        w.setZoom?.(1);
        read.enter({ zoom });
      } else if (isContinuousView(next)) {
        // Screen views reflow at a readable size; a phone's fit-to-width zoom would make text tiny.
        if (engine.zoom < 0.75 || zoomBack) w.setZoom?.(zoomBack && zoomBack >= 0.75 ? zoomBack : 1);
        engine.setView(screenView(next));
        paintStyleArea();
      } else {
        engine.setView(null);
        if (zoomBack) w.setZoom?.(zoomBack);
      }
      if (next === 'outline') { host.hidden = true; outline.open(); } else if (next !== 'read') engine.focus();
    } catch (e) {
      error(e);
    }
    if (remember && pkg() && next !== 'read') pkg().documentView = next;
    layoutChanged();
    rulers?.update?.();
    engine.paint();
    onState();
  }

  /* ---- Page Movement ---- */
  const thumbStrip = el('div.view-thumbnails', { role: 'list', 'aria-label': 'Page thumbnails', hidden: true });
  surface.append(thumbStrip);
  function setSideToSide(on, { silent = false } = {}) {
    const engine = ready(); if (!engine) return;
    if (on && mode !== 'print') setDocumentView('print');
    sideToSide = on;
    engine.pages.classList.toggle('is-side-to-side', on);
    host.classList.toggle('is-side-to-side', on);
    if (on) {
      engine.pages.classList.remove('is-multipage');
      // Whole pages, side by side: fit a page's height to the window.
      const tallest = Math.max(...engine.layout.pages.map(p => p.height));
      w.setZoom?.(Math.max(0.1, Math.min(2, Math.floor((host.clientHeight - 40) / tallest * 100) / 100)));
      engine.pages.classList.add('is-side-to-side');
    } else if (!silent) w.setZoom?.(1);
    thumbStrip.hidden = !(on && thumbnails);
    if (on && thumbnails) paintThumbnails();
    revealCaretHorizontally();
    if (!silent) { layoutChanged(); onState(); }
  }
  function paintThumbnails() {
    const engine = editor();
    if (!engine || thumbStrip.hidden) return;
    const pages = engine.canvases, current = engine.caretPageIndex ?? 0;
    while (thumbStrip.children.length > pages.length) thumbStrip.lastChild.remove();
    pages.forEach((source, index) => {
      let item = thumbStrip.children[index];
      if (!item) {
        item = el('button.view-thumb', { type: 'button', role: 'listitem', onclick: () => goToPage(Number(item.dataset.index)) }, el('canvas'), el('span'));
        item.addEventListener('mousedown', e => e.preventDefault());
        thumbStrip.append(item);
      }
      item.dataset.index = index; item.setAttribute('aria-label', `Page ${index + 1}`); item.lastChild.textContent = String(index + 1);
      if (index === current) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
      const thumb = item.firstChild, height = 84, ratio = source.width / source.height || 0.77, scale = window.devicePixelRatio || 1;
      thumb.width = Math.round(height * ratio * scale); thumb.height = Math.round(height * scale);
      thumb.style.width = `${Math.round(height * ratio)}px`; thumb.style.height = `${height}px`;
      const ctx = thumb.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, thumb.width, thumb.height);
      if (source.width) ctx.drawImage(source, 0, 0, thumb.width, thumb.height);
    });
  }
  function goToPage(index) {
    const engine = editor(), canvas = engine?.canvases[index]; if (!canvas) return;
    host.scrollTo({ left: canvas.offsetLeft - 24, behavior: 'smooth' });
  }
  function revealCaretHorizontally() {
    const engine = editor(); if (!engine || !sideToSide) return;
    const canvas = engine.canvases[engine.caretPageIndex ?? 0]; if (!canvas) return;
    if (canvas.offsetLeft < host.scrollLeft || canvas.offsetLeft + canvas.offsetWidth > host.scrollLeft + host.clientWidth) host.scrollLeft = Math.max(0, canvas.offsetLeft - 24);
  }

  /* ---- Zoom: Ctrl/Cmd + wheel and trackpad pinch (which arrives as a Ctrl + wheel) ---- */
  host.addEventListener('wheel', e => {
    const engine = editor(); if (!engine) return;
    if (e.ctrlKey || e.metaKey) {
      if (mode === 'read' || mode === 'outline') return;
      e.preventDefault();
      const from = engine.zoom, to = Math.max(0.1, Math.min(2, Math.round(from * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)) * 100) / 100));
      if (to === from) return;
      // Keep the point under the pointer where it is.
      const box = host.getBoundingClientRect(), x = e.clientX - box.left + host.scrollLeft, y = e.clientY - box.top + host.scrollTop;
      w.setZoom?.(to);
      host.scrollLeft = x * to / from - (e.clientX - box.left); host.scrollTop = y * to / from - (e.clientY - box.top);
    } else if (sideToSide && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      // Side to side: the wheel turns pages across.
      e.preventDefault(); host.scrollLeft += e.deltaY;
    }
  }, { passive: false });
  // Safari's pinch gesture.
  let gestureZoom = null;
  host.addEventListener('gesturestart', e => { e.preventDefault(); gestureZoom = editor()?.zoom ?? 1; });
  host.addEventListener('gesturechange', e => { e.preventDefault(); if (gestureZoom && mode !== 'read' && mode !== 'outline') w.setZoom?.(Math.max(0.1, Math.min(2, Math.round(gestureZoom * e.scale * 100) / 100))); });

  /** View → Zoom: presets, fit choices, many pages and a percentage, previewed live. */
  function zoomDialog() {
    const engine = ready(); if (!engine) return;
    const start = engine.zoom, startMulti = engine.pages.classList.contains('is-multipage');
    let choice = null, modal = null, many = [2, 1];
    const percent = el('input.input', { type: 'number', min: 10, max: 200, step: 1, value: Math.round(start * 100), 'aria-label': 'Percent' });
    const preview = () => { if (!percent.checkValidity()) return; apply(Number(percent.value) / 100, true); };
    percent.addEventListener('input', () => { choice = null; for (const r of radios) r.checked = false; preview(); });
    const option = (label, value) => {
      const input = el('input', { type: 'radio', name: 'zoom-choice', value: String(value), onchange: () => { choice = value; if (typeof value === 'number') percent.value = String(Math.round(value * 100)); apply(value, true); } });
      return el('label.view-zoom-option', {}, input, label);
    };
    const options = [option('200%', 2), option('100%', 1), option('75%', 0.75), option('Page width', 'width'), option('Text width', 'text'), option('Whole page', 'page')];
    const radios = options.map(o => o.querySelector('input'));
    const manyLabel = el('span', {}, '2 × 1 pages');
    const grid = el('div.view-many-grid', { role: 'grid', 'aria-label': 'Many pages' }, ...Array.from({ length: 3 }, (_, row) => el('div', { role: 'row' }, ...Array.from({ length: 4 }, (_, col) => {
      const cell = el('button.view-many-cell', { type: 'button', role: 'gridcell', 'aria-label': `${col + 1} by ${row + 1} pages`,
        onmouseenter: () => mark(col + 1, row + 1), onfocus: () => mark(col + 1, row + 1),
        onclick: () => { many = [col + 1, row + 1]; choice = 'many'; for (const r of radios) r.checked = false; apply('many', true); } });
      cell.dataset.col = col + 1; cell.dataset.row = row + 1;
      return cell;
    }))));
    const mark = (cols, rowsCount) => { manyLabel.textContent = `${cols} × ${rowsCount} pages`; for (const cell of grid.querySelectorAll('.view-many-cell')) cell.classList.toggle('is-on', cell.dataset.col <= cols && cell.dataset.row <= rowsCount); };
    grid.addEventListener('mouseleave', () => mark(...many));
    mark(...many);
    const disabledFit = mode !== 'print';
    if (disabledFit) for (const r of radios.slice(3)) { r.disabled = true; r.parentElement.title = 'Available in Print Layout'; }
    function apply(value, live) {
      if (value === 'width') w.zoomTo?.('width');
      else if (value === 'page') w.zoomTo?.('page');
      else if (value === 'text') textWidth();
      else if (value === 'many') manyPages(...many);
      else w.setZoom?.(value);
      if (live) percent.value = String(Math.round((editor()?.zoom ?? 1) * 100));
    }
    let applied = false;
    modal = openModal({ title: 'Zoom', onClose: () => {
      // Cancel puts the zoom back as it was.
      if (!applied && editor()) { w.setZoom?.(start); if (startMulti) w.multiplePages?.(); }
      queueMicrotask(() => editor()?.focus());
    }, content: el('form.ed-dialog-body.view-zoom-dialog', { onsubmit: e => {
      e.preventDefault();
      if (choice === null) { if (!percent.checkValidity()) { percent.reportValidity(); return; } apply(Number(percent.value) / 100); }
      else apply(choice);
      applied = true; modal.close();
    } },
    el('fieldset.view-zoom-set', {}, el('legend', {}, 'Zoom to'), el('div.view-zoom-options', {}, ...options),
      el('div.view-many', {}, el('span.field-label', {}, 'Many pages'), grid, manyLabel)),
    el('label.field', {}, el('span.field-label', {}, 'Percent'), percent),
    el('p.field-hint', {}, 'Changes preview as you choose. Hold Ctrl (⌘ on a Mac) and scroll, or pinch, to zoom at any time.'),
    el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK'))) });
    percent.focus(); percent.select();
  }
  /** Zoom so the text area (the page less its margins) fills the window. */
  function textWidth() {
    const engine = ready(); if (!engine) return;
    const page = engine.layout.pages[engine.caretPageIndex ?? 0] || engine.layout.page;
    const text = page.width - (page.left ?? 0) - (page.right ?? 0);
    const scale = Math.max(0.1, Math.min(2, Math.floor((host.clientWidth - 48) / text * 100) / 100));
    w.setZoom?.(scale);
    const canvas = engine.canvases[engine.caretPageIndex ?? 0];
    if (canvas) host.scrollLeft = canvas.offsetLeft + (page.left ?? 0) * scale - 24;
  }
  /** Zoom so `cols` × `rowsCount` pages fit in the window, laid out side by side. */
  function manyPages(cols, rowsCount) {
    const engine = ready(); if (!engine) return;
    if (mode !== 'print') setDocumentView('print');
    const widest = Math.max(...engine.layout.pages.map(p => p.width)), tallest = Math.max(...engine.layout.pages.map(p => p.height)), gap = 16;
    const scale = Math.min((host.clientWidth - 64 - gap * (cols - 1)) / (widest * cols), (host.clientHeight - 32 - gap * (rowsCount - 1)) / (tallest * rowsCount));
    const zoom = Math.max(0.1, Math.min(2, Math.floor(scale * 100) / 100));
    w.setZoom?.(zoom);
    engine.pages.classList.add('is-multipage');
    // Exactly `cols` pages across: the side padding takes up the rest of the row.
    engine.pages.style.setProperty('--many-columns', String(cols));
    const needed = cols * widest * zoom + (cols - 1) * engine.layout.page.gap * zoom + 4;
    engine.pages.style.setProperty('--many-inset', `${Math.max(12, Math.floor((host.clientWidth - needed) / 2) - 4)}px`);
    engine.resizeCanvases(); engine.revealCaret();
  }

  /* ---- Window: New Window ---- */
  const channels = new Set();
  let sentRevision = null, sendTimer = null;
  async function postDocument(channel) {
    const engine = ready(); if (!engine) return;
    try {
      const blob = await exportDocument();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      channel.postMessage({ type: 'document', name: documentTitle?.() || 'Document', bytes, view: mode });
    } catch (e) { channel.postMessage({ type: 'error', message: e?.message || String(e) }); }
  }
  function newWindow() {
    if (!ready()) return;
    if (typeof BroadcastChannel === 'undefined') { error(new Error('This browser cannot keep a second window in step.')); return; }
    const id = (crypto.randomUUID?.() || String(Math.random()).slice(2));
    const channel = new BroadcastChannel(`documents-window:${id}`);
    channel.onmessage = e => {
      if (e.data?.type === 'ready') postDocument(channel);
      else if (e.data?.type === 'closed') { channel.close(); channels.delete(channel); }
    };
    channels.add(channel);
    const opened = window.open(new URL(`mirror.html#${id}`, location.href).href, '_blank');
    if (!opened) { channel.close(); channels.delete(channel); toast('Allow pop-ups for this site to open a new window.', { icon: 'alert' }); return; }
    sentRevision = editor()?.session.revision ?? null;
  }
  function broadcastChanges() {
    const engine = editor();
    if (!channels.size || !engine || engine.session.revision === sentRevision) return;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => { sentRevision = editor()?.session.revision; for (const channel of channels) postDocument(channel); }, 500);
  }

  /* ---- Window: Split ---- */
  function toggleSplit(on = !split) {
    const engine = ready(); if (!engine) return;
    if (!on) {
      split?.pane.remove(); split?.divider.remove(); split = null;
      surface.classList.remove('is-split'); host.style.removeProperty('flex-basis');
      onState(); layoutChanged(); return;
    }
    if (split) return;
    const pages = el('div.view-split-pages');
    const pane = el('div.view-split-pane', { 'aria-label': 'Second pane of this document', tabindex: 0 }, pages);
    const divider = el('div.view-split-divider', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Split position', tabindex: 0, 'aria-valuemin': 15, 'aria-valuemax': 85, 'aria-valuenow': 50 });
    split = { pane, pages, divider, ratio: 0.5 };
    surface.classList.add('is-split');
    host.after(divider, pane);
    const place = ratio => {
      split.ratio = Math.max(0.15, Math.min(0.85, ratio));
      host.style.flexBasis = `${split.ratio * 100}%`;
      divider.setAttribute('aria-valuenow', String(Math.round(split.ratio * 100)));
    };
    place(0.5);
    divider.addEventListener('pointerdown', e => {
      e.preventDefault(); divider.setPointerCapture(e.pointerId);
      const box = surface.getBoundingClientRect();
      const move = ev => place((ev.clientY - box.top) / box.height);
      const up = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); layoutChanged(); };
      divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', up);
    });
    divider.addEventListener('keydown', e => {
      const step = { ArrowUp: -0.05, ArrowDown: 0.05 }[e.key];
      if (step) { e.preventDefault(); place(split.ratio + step); }
      else if (e.key === 'Escape') { e.preventDefault(); toggleSplit(false); editor()?.focus(); }
    });
    // A click in the second pane places the caret in the document there; the first pane stays where it is.
    pages.addEventListener('pointerdown', e => {
      const engine = editor(); if (!engine || e.button !== 0) return;
      const mirror = e.target.closest?.('canvas'); if (!mirror) return;
      e.preventDefault();
      const index = Number(mirror.dataset.page), source = engine.canvases[index]; if (!source) return;
      const from = mirror.getBoundingClientRect(), to = source.getBoundingClientRect();
      const point = { clientX: to.left + (e.clientX - from.left) * to.width / from.width, clientY: to.top + (e.clientY - from.top) * to.height / from.height };
      const position = engine.point(point);
      engine.model.select(e.shiftKey ? engine.model.selection.anchor : position, position);
      engine.focus(); engine.onSelection();
    });
    paintMirror();
    onState(); layoutChanged();
  }
  function paintMirror() {
    const engine = editor(); if (!split || !engine) return;
    const { pages } = split, sources = engine.canvases;
    pages.className = `view-split-pages ${engine.pages.className.replace('canvas-pages', '')}`;
    pages.style.gap = engine.pages.style.gap;
    while (pages.children.length > sources.length) pages.lastChild.remove();
    sources.forEach((source, index) => {
      let copy = pages.children[index];
      if (!copy) { copy = el('canvas.canvas-page'); pages.append(copy); }
      copy.dataset.page = index;
      if (copy.width !== source.width) copy.width = source.width;
      if (copy.height !== source.height) copy.height = source.height;
      copy.style.width = source.style.width; copy.style.height = source.style.height;
      copy.getContext('2d').drawImage(source, 0, 0);
    });
  }

  /* ---- Navigation pane heading commands (drag to reorder, promote, demote, add, delete) ---- */
  function runOutline(action) {
    const engine = ready(); if (!engine || pkg()?.readOnly) return false;
    engine.finishComposition();
    if (engine.session.path !== null) engine.editStory(null);
    const ok = engine.execute(() => action(engine.model));
    engine.focus(); engine.revealCaret();
    return ok;
  }
  const headingActions = {
    canEdit: () => !!ready() && !pkg()?.readOnly,
    move: (id, target, placement) => runOutline(model => moveOutlineSection(model, id, target, placement)),
    promote: id => runOutline(model => setOutlineLevels(model, [id], promotedLevel, { withSubtree: true })),
    demote: id => runOutline(model => setOutlineLevels(model, [id], demotedLevel, { withSubtree: true })),
    remove: id => runOutline(model => deleteOutlineSection(model, id)),
    insert: (id, placement) => runOutline(model => {
      const unit = outlineUnits(model.paragraphs).find(u => u.id === id);
      return placement === 'sub' ? insertOutlineHeading(model, id, 'after', Math.min(9, (unit?.level ?? 1) + 1)) : insertOutlineHeading(model, id, placement);
    }),
    select: id => {
      const engine = ready(); if (!engine) return;
      const units = outlineUnits(engine.model.paragraphs), index = units.findIndex(u => u.id === id); if (index < 0) return;
      const last = units[subtreeEnd(units, index) - 1];
      const end = engine.model.paragraphOffset(last.to - 1) + engine.model.paragraphs[last.to - 1].runs.reduce((n, r) => n + r.text.length, 0);
      engine.model.select(engine.model.paragraphOffset(units[index].from), end);
      engine.focus(); engine.revealCaret(); engine.onSelection();
    },
  };

  /* ---- Gridlines ---- */
  function setGridlines(on) { gridlines = on; editor()?.paint(); onState(); }

  /* ---- Ribbon ---- */
  function extendTab(id, kit) {
    if (id !== 'view') return [];
    const { command, menuButton, rows, when } = kit;
    const has = () => !!ready();
    const vertical = command('Vertical', 'verticalMovement', () => setSideToSide(false), { size: 'large', attrs: { 'aria-pressed': 'true' } });
    const across = command('Side to Side', 'sideToSide', () => setSideToSide(true), { size: 'large', text: 'Side to Side', attrs: { 'aria-pressed': 'false' } });
    const thumbs = command('Thumbnails', 'thumbnails', () => { thumbnails = !thumbnails; thumbStrip.hidden = !(sideToSide && thumbnails); paintThumbnails(); onState(); }, { text: 'Thumbnails', attrs: { 'aria-pressed': 'false' } });
    when(vertical, has, () => String(!sideToSide)); when(across, () => has() && mode !== 'outline', () => String(sideToSide));
    when(thumbs, () => has() && sideToSide, () => String(sideToSide && thumbnails));
    const newWin = command('New Window', 'newWindow', newWindow, { size: 'large', text: 'New Window' });
    const splitButton = command('Split', 'split', () => toggleSplit(), { size: 'large', attrs: { 'aria-pressed': 'false' } });
    when(newWin, has); when(splitButton, () => has() && mode !== 'outline' && mode !== 'read', () => String(!!split));
    const properties = command('Properties', 'info', () => w.documentProperties?.(), { size: 'large' });
    when(properties, () => has() && !!w.documentProperties);
    const gridMenu = menuButton('Grid Spacing', 'gridlines', () => GRID_SPACINGS.map(([value, label]) => ({ label, radio: true, checked: Math.abs(gridSpacing - value) < 0.01, onSelect: () => { gridSpacing = value; setGridlines(true); } })), { size: 'small', text: 'Grid Spacing' });
    const styleMenu = menuButton('Style Area', 'styleArea', () => STYLE_AREAS.map(([value, label]) => ({ label, radio: true, checked: styleArea === value, onSelect: () => setStyleArea(value) })), { size: 'small', text: 'Style Area' });
    when(styleMenu, () => has() && mode === 'draft');
    return [
      { id: 'pageMovement', label: 'Page Movement', icon: 'sideToSide', priority: 4, after: 'immersive', items: [vertical, across, rows([thumbs], [gridMenu], [styleMenu])] },
      { id: 'window', label: 'Window', icon: 'newWindow', priority: 5, after: 'zoom', items: [newWin, splitButton] },
      // Document properties live in the File backstage; the View tab offers them when it exists.
      ...(w.documentProperties ? [{ id: 'properties', label: 'Properties', icon: 'info', priority: 2, after: 'window', items: [properties] }] : []),
    ];
  }
  function setStyleArea(value) {
    styleArea = value;
    relayoutScreen(); paintStyleArea(); onState();
  }

  /** The Outlining tab, shown while the Outline view is on. */
  function contextTabs(kit) {
    const { command, menuButton, rows, when, check, divider } = kit;
    const on = () => mode === 'outline' && !!ready() && !pkg()?.readOnly;
    const level = () => outline.currentLevel();
    const toHeading1 = command('Promote to Heading 1', 'promoteHeading1', () => outline.promoteToHeading1(), { shortcut: `${MOD_KEY === 'Cmd' ? 'Option' : 'Alt'}+Shift+1` });
    const promote = command('Promote', 'promote', () => outline.promote(), { shortcut: `${outline.shortcutHint}+Left` });
    const levelMenu = menuButton('Outline Level', 'outlineView', () => outline.levelNames.map((label, i) => ({ label, radio: true, checked: level() === i + 1, onSelect: () => outline.setLevel(i + 1) })), { size: 'small', text: 'Outline Level' });
    const demote = command('Demote', 'demote', () => outline.demote(), { shortcut: `${outline.shortcutHint}+Right` });
    const toBody = command('Demote to Body Text', 'demoteBody', () => outline.demoteToBody(), { shortcut: `${MOD_KEY}+Shift+N` });
    const up = command('Move Up', 'moveUp', () => outline.moveUp(), { shortcut: `${outline.shortcutHint}+Up` });
    const down = command('Move Down', 'moveDown', () => outline.moveDown(), { shortcut: `${outline.shortcutHint}+Down` });
    const expand = command('Expand', 'expand', () => outline.expand(), { shortcut: `${outline.shortcutHint}+Plus` });
    const collapse = command('Collapse', 'collapse', () => outline.collapse(), { shortcut: `${outline.shortcutHint}+Minus` });
    const showLevel = menuButton('Show Level', 'showLevel', () => [...Array.from({ length: 9 }, (_, i) => ({ label: `Level ${i + 1}`, radio: true, checked: outline.showLevel === i + 1, onSelect: () => outline.setShowLevel(i + 1) })),
      { label: 'All Levels', radio: true, checked: outline.showLevel === BODY_LEVEL, onSelect: () => outline.setShowLevel(BODY_LEVEL) }], { size: 'small', text: 'Show Level' });
    const formatting = check('Show Text Formatting', () => outline.formatting, value => outline.setFormatting(value));
    const firstLine = check('Show First Line Only', () => outline.firstLineOnly, value => outline.setFirstLineOnly(value));
    const close = command('Close Outline View', 'closeView', () => setDocumentView(pkg()?.documentView && pkg().documentView !== 'outline' ? pkg().documentView : 'print'), { size: 'large', text: 'Close Outline View' });
    const noSteal = (...controls) => { for (const c of controls) c.addEventListener('mousedown', e => e.preventDefault()); };
    close.classList.add('ribbon-wide');
    noSteal(toHeading1, promote, demote, toBody, up, down, expand, collapse, close);
    for (const control of [toHeading1, promote, demote, toBody, levelMenu]) when(control, () => on() && level() !== null);
    when(up, () => on() && outline.canMove()); when(down, () => on() && outline.canMove());
    when(expand, () => mode === 'outline' && outline.isCollapsed()); when(collapse, () => mode === 'outline' && outline.canCollapse());
    when(showLevel, () => mode === 'outline'); when(close, () => mode === 'outline');
    return [{ id: 'outlining', label: 'Outlining', contextual: 'outlining', selectOnAppear: true, groups: [
      { id: 'outlineTools', label: 'Outline Tools', icon: 'outlineView', priority: 9, items: [
        rows([toHeading1, promote, levelMenu, demote, toBody], [up, down, divider(), expand, collapse, divider(), showLevel]),
        rows([formatting], [firstLine])] },
      { id: 'outlineClose', label: 'Close', icon: 'closeView', priority: 8, items: [close] },
    ] }];
  }

  /** Classic menu bar: the View and Window menus. */
  function extendMenu(id) {
    const has = !!ready();
    // The menu bar's View menu already lists the views, Focus, Ruler, the sidebars and Zoom; these add to it.
    if (id === 'view') return [
      { label: 'Gridlines', icon: 'gridlines', checked: gridlines, disabled: !has, onSelect: () => setGridlines(!gridlines) },
      { label: 'Page Movement', icon: 'sideToSide', items: [
        { label: 'Vertical', radio: true, checked: !sideToSide, disabled: !has, onSelect: () => setSideToSide(false) },
        { label: 'Side to Side', radio: true, checked: sideToSide, disabled: !has, onSelect: () => setSideToSide(true) }] },
      { label: 'Style Area', icon: 'styleArea', items: STYLE_AREAS.map(([value, label]) => ({ label, radio: true, checked: styleArea === value, disabled: !has || mode !== 'draft', onSelect: () => setStyleArea(value) })) },
    ];
    if (id === 'window') return [
      { label: 'New Window', icon: 'newWindow', disabled: !has, onSelect: newWindow },
      { label: split ? 'Remove Split' : 'Split', icon: 'split', checked: !!split, disabled: !has || mode === 'outline' || mode === 'read', onSelect: () => toggleSplit() },
    ];
    return [];
  }

  // The view chords of desktop word processors: Ctrl+Alt+P Print Layout and Ctrl+Alt+N Draft (Cmd+Option
  // on a Mac). Ctrl+Alt+O stays with the Navigation pane here.
  const keyAbort = new AbortController();
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e) || !e.altKey || e.shiftKey || !(MOD_KEY === 'Cmd' ? e.metaKey : e.ctrlKey)) return;
    if (!e.target?.closest?.('.canvas-input, .outline-view')) return;
    const kind = { KeyP: 'print', KeyN: 'draft' }[e.code];
    if (kind && ready()) { e.preventDefault(); setDocumentView(kind); }
  }, { signal: keyAbort.signal });

  /** Called on every editor update. */
  function refresh() {
    const engine = editor();
    if (engine && engine !== attached) {
      attached = engine;
      for (const overlay of overlays) if (!engine.overlays.includes(overlay)) engine.overlays.push(overlay);
      // Open in the view the document was saved in.
      const saved = pkg()?.documentView;
      const wanted = saved && saved !== 'print' ? saved : mode !== 'print' ? mode : null;
      if (wanted) { mode = 'print'; queueMicrotask(() => { if (editor() === engine) setDocumentView(wanted); }); }
    }
    if (!engine) return;
    if (!engine.pages.classList.contains('is-multipage') && engine.pages.style.getPropertyValue('--many-columns')) { engine.pages.style.removeProperty('--many-columns'); engine.pages.style.removeProperty('--many-inset'); }
    if (isContinuousView(mode)) {
      const view = screenView(mode);
      if (view && engine.view && view.width !== engine.view.width) relayoutScreen();
      paintStyleArea();
    }
    outline.refresh();
    read.refresh();
    revealCaretHorizontally();
    broadcastChanges();
  }

  return {
    commands: {
      setDocumentView, documentView: () => mode, documentViewLabel: () => VIEW_LABELS[mode], documentViewModes: () => Object.keys(VIEW_LABELS),
      gridlinesVisible: () => gridlines, setGridlines, toggleGridlines: () => setGridlines(!gridlines),
      pageMovement: () => (sideToSide ? 'sideToSide' : 'vertical'), setPageMovement: kind => setSideToSide(kind === 'sideToSide'),
      newWindow, toggleSplit, splitActive: () => !!split,
      zoomDialog, zoomTextWidth: textWidth, manyPages, headingActions,
    },
    extendTab, contextTabs, extendMenu, refresh,
    /** Contextual tabs this module shows: the Outlining tab in Outline view. */
    extraContexts: () => (mode === 'outline' ? ['outlining'] : []),
    get mode() { return mode; },
    outline, read,
    destroy() {
      resize.disconnect(); keyAbort.abort();
      if (read.active) read.leave();
      clearTimeout(sendTimer);
      for (const channel of channels) { channel.postMessage({ type: 'closed' }); channel.close(); }
      channels.clear();
    },
  };
}

