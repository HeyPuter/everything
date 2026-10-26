/**
 * Read Mode: the document laid out as screen pages that fit the window, side by side like an open
 * book, without the ribbon. Pages turn with the arrow keys, Page Up/Down, Space, the side arrows, a
 * click on either half of the page or the scroll wheel (a click on a link follows it); Escape returns to editing. The reading tools
 * change the column width, the page colour (none, sepia, inverse), text spacing and Line Focus, which
 * dims all but the lines being read, and start Read Aloud. The document itself is never changed:
 * reading is a screen geometry (engine/document-views.js) and a few screen-only overlays.
 */
import { el, isComposing } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { commandIconEl } from '../ui/ribbon.js';
import { readingColumns, lineFocusBand } from '../engine/document-views.js';

const WIDTHS = [['narrow', 'Narrow'], ['default', 'Default'], ['wide', 'Wide']];
const COLORS = [['none', 'None'], ['sepia', 'Sepia'], ['inverse', 'Inverse']];
const FOCUS = [[0, 'Off'], [1, 'One Line'], [3, 'Three Lines'], [5, 'Five Lines']];
const letterSpacing = () => typeof CanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in CanvasRenderingContext2D.prototype;

export function createReadMode({ editor, host, root: rootOf, exit, toggleNavigation, readAloud, readAloudActive, documentTitle }) {
  let active = false, width = 'default', color = 'none', textSpacing = false, focusLines = 0, focusLine = null, screen = 0, perScreen = 1, columnGap = 32;
  let restoreZoom = null, wheelAt = 0, wheelTotal = 0, textInput = null, textInputTabIndex = null;
  const title = el('span.read-title');
  const counter = el('span.read-counter', { role: 'status', 'aria-live': 'polite' });
  const menuButton = (label, items) => {
    const button = el('button.read-tool', { type: 'button', 'aria-haspopup': 'menu', onclick: e => openMenu({ anchor: button, label, items: items(), pointer: !!e.detail, onClose: () => focusSurface() }) }, label, el('span.ribbon-caret', { 'aria-hidden': 'true' }));
    return button;
  };
  const tools = menuButton('Tools', () => [
    { label: 'Navigation Pane', icon: 'navigationPane', onSelect: () => toggleNavigation?.() },
    { label: readAloudActive?.() ? 'Stop Reading Aloud' : 'Read Aloud', icon: 'readAloud', disabled: !readAloud, onSelect: () => readAloud?.() },
  ]);
  const viewMenu = menuButton('View', () => [
    { label: 'Column Width', icon: 'columnWidth', items: WIDTHS.map(([id, label]) => ({ label, radio: true, checked: width === id, onSelect: () => set({ width: id }) })) },
    { label: 'Page Color', icon: 'pageColor', items: COLORS.map(([id, label]) => ({ label, radio: true, checked: color === id, onSelect: () => set({ color: id }) })) },
    { label: 'Text Spacing', icon: 'textSpacing', checked: textSpacing, onSelect: () => set({ textSpacing: !textSpacing }) },
    { label: 'Line Focus', icon: 'lineFocus', items: FOCUS.map(([n, label]) => ({ label, radio: true, checked: focusLines === n, onSelect: () => set({ focusLines: n }) })) },
    { separator: true },
    { label: 'Edit Document', icon: 'printLayout', onSelect: () => exit() },
  ]);
  const edit = el('button.btn.btn-outline.read-edit', { type: 'button', title: 'Back to editing (Esc)', onclick: () => exit() }, 'Edit Document');
  const toolbar = el('div.read-toolbar', { role: 'toolbar', 'aria-label': 'Read Mode' }, el('div.read-toolbar-start', {}, tools, viewMenu), title, el('div.read-toolbar-end', {}, edit));
  const arrow = (label, icon, delta) => el(`button.read-turn.read-turn-${delta < 0 ? 'back' : 'next'}`, { type: 'button', 'aria-label': label, title: label, onclick: () => turn(delta) }, commandIconEl(icon, 20));
  const back = arrow('Previous screen', 'previousArrow', -1), next = arrow('Next screen', 'nextArrow', 1);
  const footer = el('div.read-footer', {}, counter);
  for (const b of [tools, viewMenu, edit, back, next]) b.addEventListener('mousedown', e => e.preventDefault());

  const engine = () => editor();
  const root = { get classList() { return (typeof rootOf === 'function' ? rootOf() : rootOf)?.classList || { add() {}, remove() {}, toggle() {} }; } };
  const canvases = () => engine()?.canvases || [];
  const screens = () => Math.max(1, Math.ceil(canvases().length / perScreen));

  function apply({ keepPosition = true } = {}) {
    const ed = engine(); if (!ed) return;
    const anchor = keepPosition ? screen * perScreen : 0;
    const columns = readingColumns(host.clientWidth, host.clientHeight - 8, width, ed.zoom);
    perScreen = columns.count; columnGap = columns.gap;
    ed.setView({ kind: 'read', width: Math.floor(columns.width), height: Math.floor(columns.height), color, textSpacing: textSpacing ? { character: letterSpacing() ? 0.6 : 0 } : false });
    host.style.setProperty('--read-gap', `${columnGap}px`);
    const pageWidth = Math.floor(columns.width) * ed.zoom;
    host.style.setProperty('--read-inset', `${Math.max(0, Math.floor((host.clientWidth - (perScreen * pageWidth + (perScreen - 1) * columnGap)) / 2))}px`);
    host.classList.toggle('read-inverse', color === 'inverse');
    host.classList.toggle('read-sepia', color === 'sepia');
    screen = Math.min(screens() - 1, Math.floor(anchor / perScreen));
    show(false);
  }
  function show(smooth = true) {
    const list = canvases(), first = list[screen * perScreen];
    if (first) host.scrollTo({ left: Math.max(0, first.offsetLeft - parseFloat(getComputedStyle(engine().pages).paddingLeft || '0')), top: 0, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
    updateCounter();
  }
  function updateCounter() {
    const list = canvases();
    const from = screen * perScreen + 1, to = Math.min(list.length, from + perScreen - 1);
    counter.textContent = list.length ? `${from === to ? `Page ${from}` : `Pages ${from}–${to}`} of ${list.length}` : '';
    back.disabled = screen === 0; next.disabled = screen >= screens() - 1;
  }
  function turn(delta) {
    const target = Math.max(0, Math.min(screens() - 1, screen + delta));
    if (target === screen) return;
    screen = target;
    if (focusLines) { const lines = screenLines(); focusLine = delta > 0 ? lines[0] : lines.at(-1); engine()?.paint(); }
    show();
  }
  /** Go to the screen that holds the document caret (Read Aloud, search and the Navigation pane move it). */
  let lastCaret = null;
  function follow() {
    const ed = engine(); if (!ed) return;
    const at = ed.model.selection.focus;
    if (at === lastCaret) return;
    lastCaret = at;
    const page = ed.caretPageIndex ?? 0, target = Math.floor(page / perScreen);
    if (target !== screen && target < screens()) { screen = target; show(); }
  }

  /* ---- Line Focus: a screen-only overlay that dims every line but the ones in focus ---- */
  const bodyLines = () => (engine()?.layout.lines || []).filter(l => !l.virtual && !l.pageStory && !l.cellText);
  const screenLines = () => bodyLines().filter(l => Math.floor(l.page / perScreen) === screen).sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const overlay = (ctx, index, geometry) => {
    if (!active || !focusLines) return;
    const lines = bodyLines();
    if (!focusLine || !lines.includes(focusLine)) focusLine = screenLines()[0] || lines[0];
    const band = lineFocusBand(lines, focusLine, focusLines);
    ctx.save();
    ctx.fillStyle = color === 'inverse' ? 'rgba(255, 255, 255, 0.82)' : 'rgba(20, 20, 20, 0.78)';
    if (!band || band.page !== index) ctx.fillRect(0, 0, geometry.width, geometry.height);
    else { ctx.fillRect(0, 0, geometry.width, Math.max(0, band.top - 2)); ctx.fillRect(0, band.bottom + 2, geometry.width, geometry.height - band.bottom - 2); }
    ctx.restore();
  };
  overlay.readMode = true;
  function moveFocusLine(direction) {
    const lines = bodyLines().sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    const at = Math.max(0, lines.indexOf(focusLine));
    const target = lines[Math.max(0, Math.min(lines.length - 1, at + direction * focusLines))];
    if (!target) return;
    focusLine = target;
    const page = Math.floor(target.page / perScreen);
    if (page !== screen) { screen = page; show(); }
    engine()?.paint();
  }

  function set(patch) {
    ({ width = width, color = color, textSpacing = textSpacing, focusLines = focusLines } = { width, color, textSpacing, focusLines, ...patch });
    root.classList.toggle('read-line-focus', !!focusLines);
    apply();
    engine()?.paint();
    focusSurface();
  }
  function focusSurface() { if (active) host.focus({ preventScroll: true }); }

  /* ---- Input ---- */
  const keyAbort = { current: null };
  function onKey(e) {
    if (!active || e.defaultPrevented || isComposing(e) || e.target?.closest?.('.menu, .modal-root, .nav-pane, .read-aloud-bar, input, textarea:not(.canvas-input), select, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape' && !document.querySelector('.modal-root, .menu')) { e.preventDefault(); exit(); return; }
    if (mod || e.altKey) return;
    if (focusLines && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); moveFocusLine(e.key === 'ArrowDown' ? 1 : -1); return; }
    const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key] ?? (e.key === ' ' ? (e.shiftKey ? -1 : 1) : null);
    if (step) { e.preventDefault(); turn(step); return; }
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); screen = e.key === 'Home' ? 0 : screens() - 1; show(); return; }
    // Typing does not reach the document while reading.
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter' || e.key === 'Tab' && e.target?.matches?.('.canvas-input')) e.preventDefault();
  }
  function onPointer(e) {
    if (!active || e.button !== 0 || !e.target.closest?.('.canvas-pages')) return;
    // Reading is not editing: a click turns the page instead of placing the caret, and a click on a link follows it.
    e.preventDefault(); e.stopPropagation();
    const ed = engine(), link = ed?.linkAtPointer(e);
    if (link) { ed.openHyperlink(link.link); return; }
    const box = host.getBoundingClientRect();
    turn(e.clientX - box.left < box.width / 3 ? -1 : 1);
    focusSurface();
  }
  function onWheel(e) {
    if (!active || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const now = performance.now();
    if (now - wheelAt > 400) wheelTotal = 0;
    wheelAt = now; wheelTotal += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(wheelTotal) > 60) { turn(Math.sign(wheelTotal)); wheelTotal = 0; wheelAt = now + 250; }
  }
  const resize = typeof ResizeObserver === 'undefined' ? { observe() {}, disconnect() {} } : new ResizeObserver(() => { if (active) apply(); });

  return {
    get active() { return active; },
    get settings() { return { width, color, textSpacing, focusLines }; },
    enter({ zoom } = {}) {
      const ed = engine(); if (!ed || active) return;
      active = true; screen = Math.floor((ed.caretPageIndex ?? 0) / Math.max(1, perScreen));
      restoreZoom = zoom ?? null;
      title.textContent = documentTitle?.() || '';
      root.classList.add('ed-read-mode');
      host.classList.add('is-reading');
      host.tabIndex = 0; host.setAttribute('aria-label', 'Document pages. Use the arrow keys to turn pages; Escape returns to editing.');
      // The text input inside the pages would take the next Tab and hand focus straight back to the pages
      // (see focusin below), so Tab never reached the reading tools: it is out of the Tab order while reading.
      textInput = host.querySelector('.canvas-input');
      textInputTabIndex = textInput?.getAttribute('tabindex') ?? null;
      textInput?.setAttribute('tabindex', '-1');
      host.parentElement.append(toolbar, back, next, footer);
      if (!ed.overlays.includes(overlay)) ed.overlays.push(overlay);
      keyAbort.current = new AbortController();
      window.addEventListener('keydown', onKey, { signal: keyAbort.current.signal });
      host.addEventListener('pointerdown', onPointer, { capture: true, signal: keyAbort.current.signal });
      host.addEventListener('wheel', onWheel, { passive: false, signal: keyAbort.current.signal });
      // Going to a heading or a search result puts focus in the document's text input, whose own key
      // handling would edit (Backspace, Alt+Shift+Arrow, Ctrl+V). Reading keeps focus on the pages.
      host.addEventListener('focusin', e => { if (e.target.matches?.('.canvas-input')) focusSurface(); }, { signal: keyAbort.current.signal });
      resize.observe(host);
      apply();
      // The screen holding the caret, once the reading pages exist.
      screen = Math.min(screens() - 1, Math.floor((ed.caretPageIndex ?? 0) / perScreen)); show(false);
      lastCaret = ed.model.selection.focus;
      focusSurface();
    },
    leave() {
      if (!active) return null;
      active = false;
      const ed = engine();
      keyAbort.current?.abort(); resize.disconnect();
      root.classList.remove('ed-read-mode', 'read-line-focus');
      host.classList.remove('is-reading', 'read-inverse', 'read-sepia');
      host.removeAttribute('tabindex'); host.setAttribute('aria-label', 'Document pages');
      if (textInput) { if (textInputTabIndex === null) textInput.removeAttribute('tabindex'); else textInput.setAttribute('tabindex', textInputTabIndex); textInput = null; }
      for (const node of [toolbar, back, next, footer]) node.remove();
      if (ed) { const at = ed.overlays.indexOf(overlay); if (at >= 0) ed.overlays.splice(at, 1); }
      return restoreZoom;
    },
    refresh() { if (active) { follow(); updateCounter(); } },
    turn, set,
    get screen() { return screen; },
  };
}
