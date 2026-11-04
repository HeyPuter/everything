import { el } from './dom.js';
import { recallUnit, rememberUnit, onUnitChange } from '../lib/units.js';
import { localStore } from '../lib/storage.js';

// View > Ruler is the window's setting, kept on this device as the status bar's is: hidden stays hidden after a reload.
const RULER_STORE = 'documents:ruler';
const storedRuler = () => { try { const value = localStore()?.getItem(RULER_STORE); return value === 'shown' ? true : value === 'hidden' ? false : null; } catch { return null; } };

const SYMBOLS = { left: '└', center: '┴', right: '┘', decimal: '⊥', bar: '│' };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function marginSource(page, settings, side) {
  const key = page.bookFoldSwapped && ['left', 'right'].includes(side) ? (side === 'left' ? 'right' : 'left') : side;
  const gutterSide = settings.gutterAtTop ? 'top' : page.bookFoldReferenceMargins ? 'right' : 'left';
  return { key, gutter: key === gutterSide ? settings.gutter : 0 };
}
export function rulerStep(unit) { return unit === 'cm' ? 1440 / 25.4 : 90; }
export function rulerSnap(value, unit, precise = false) {
  return Math.round(precise ? value : Math.round(value / rulerStep(unit)) * rulerStep(unit));
}
/** UI only: all edits pass through the editor's atomic layout-validated commands. */
export function createCanvasRulers({ host, surface, editor, openParagraph, openPage }) {
  // Phones show no rulers until View > Ruler asks for them.
  const phone = globalThis.matchMedia?.('(max-width: 700px)');
  // A phone starts without rulers whatever a wider window chose.
  let unit = recallUnit(), visible = phone?.matches ? false : storedRuler() ?? true, chosen = false, drag = null, frame = 0, signature = '', tabType = 'left';
  const abort = new AbortController();
  const listen = (node, event, fn) => node.addEventListener(event, fn, { signal: abort.signal });
  const horizontal = el('div.canvas-ruler.canvas-ruler-horizontal', { role: 'group', 'aria-label': 'Horizontal ruler' });
  const vertical = el('div.canvas-ruler.canvas-ruler-vertical', { role: 'group', 'aria-label': 'Vertical ruler' });
  const top = el('div.canvas-ruler-top', {}, horizontal);
  const side = el('div.canvas-ruler-side', {}, vertical);
  const selector = el('button.canvas-tab-selector', { type: 'button', onclick: () => {
    const types = Object.keys(SYMBOLS); tabType = types[(types.indexOf(tabType) + 1) % types.length]; updateSelector();
  } });
  const guide = el('div.canvas-ruler-guide', { hidden: true });
  const value = el('output.canvas-ruler-value', { 'aria-live': 'polite', hidden: true });
  surface.prepend(top, side, selector); surface.append(guide, value);
  function updateSelector() {
    selector.textContent = SYMBOLS[tabType];
    selector.title = `${tabType[0].toUpperCase() + tabType.slice(1)} tab stop · Click to change type; click the ruler to add`;
    selector.setAttribute('aria-label', selector.title);
  }
  updateSelector();
  const unsubscribe = onUnitChange(next => { unit = next; cancel(); update(); });
  function context() {
    const e = editor(); if (!e?.layout || !e.canvases.length) return null;
    const bounds = host.getBoundingClientRect();
    // The first page in view. Side to Side and Multiple Pages put pages beside one another: one
    // scrolled off to the left is not in view, though its bottom is below the window's top.
    let index = e.canvases.findIndex(c => { const r = c.getBoundingClientRect(); return r.bottom > bounds.top + 1 && r.right > bounds.left + 1; });
    if (index < 0) index = e.canvases.length - 1;
    return { e, bounds, rect: e.canvases[index].getBoundingClientRect(), page: e.layout.pages[index] || e.layout.page,
      settings: e.model.pageSettings, format: e.model.paragraphFormatting };
  }
  function measurement(twips) { return `${+(twips / 1440 * (unit === 'cm' ? 2.54 : 1)).toFixed(2)} ${unit}`; }
  function ticks(node, length, origin, end, scale, axis) {
    const band = el('span.canvas-ruler-writing');
    band.style[axis === 'x' ? 'left' : 'top'] = `${origin * scale}px`;
    band.style[axis === 'x' ? 'width' : 'height'] = `${(end - origin) * scale}px`; node.append(band);
    const step = unit === 'cm' ? 96 / 2.54 / 10 : 12, major = unit === 'cm' ? 10 : 8;
    // At small zooms a unit is a few pixels long: keep the ticks apart and number every second,
    // fifth or tenth unit, so the marks stay distinct and the numbers do not run into each other.
    const every = [...(unit === 'cm' ? [1, 2, 5] : [1, 2, 4]), major].find(n => n * step * scale >= 3.5) ?? major;
    const widest = String(Math.ceil(Math.max(origin, length - origin) / step / major)).length;
    const labelEvery = [1, 2, 5, 10, 20].find(n => n * major * step * scale >= (axis === 'x' ? widest * 6 + 6 : 14)) ?? 20;
    for (let i = Math.ceil(-origin / step); (origin + i * step) <= length; i++) {
      if (i % every) continue;
      const tick = el('span.canvas-ruler-tick');
      tick.style[axis === 'x' ? 'left' : 'top'] = `${(origin + i * step) * scale}px`;
      const full = i % major === 0, numbered = full && (i / major) % labelEvery === 0;
      tick.classList.toggle('major', numbered); tick.classList.toggle('half', !numbered && (full || i % (major / 2) === 0));
      if (numbered && i !== 0) tick.append(el('span', {}, String(Math.abs(i / major))));
      node.append(tick);
    }
  }
  function handle(node, kind, label, position, axis, amount, disabled, tab) {
    const h = el('button.canvas-ruler-handle', { type: 'button', role: 'slider', 'aria-label': label,
      'aria-valuenow': amount, 'aria-valuemin': -31680, 'aria-valuemax': 31680,
      'aria-valuetext': measurement(amount), 'aria-orientation': axis === 'x' ? 'horizontal' : 'vertical',
      title: `${label}: ${measurement(amount)} · Drag or use arrow keys${tab ? '; Delete removes' : ''}`,
      disabled, dataset: { kind, axis, ...(tab ? { position: tab.position, alignment: tab.alignment } : {}) } });
    h.style[axis === 'x' ? 'left' : 'top'] = `${position}px`;
    if (tab) h.textContent = SYMBOLS[tab.alignment];
    node.append(h);
  }
  function update() {
    const c = context(); if (!c) return;
    const { e, rect, bounds, page: p, settings: s, format: f } = c;
    const shown = visible && !e.accessible;
    surface.classList.toggle('has-rulers', shown);
    top.hidden = side.hidden = selector.hidden = !shown;
    if (!shown) return;
    horizontal.style.left = `${rect.left - bounds.left}px`;
    horizontal.style.width = `${rect.width}px`;
    vertical.style.top = `${rect.top - bounds.top}px`;
    vertical.style.height = `${rect.height}px`;
    const key = JSON.stringify([p, s, f, e.zoom, e.readOnly, e.model.selectedParagraphs.some(p => p.cellId), unit]);
    if (key === signature || drag) return;
    signature = key;
    const focused = document.activeElement?.closest('.canvas-ruler-handle');
    const focusKey = focused && [focused.dataset.kind, focused.dataset.position];
    horizontal.replaceChildren(); vertical.replaceChildren();
    ticks(horizontal, p.width, p.left, p.width - p.right, e.zoom, 'x');
    ticks(vertical, p.height, p.top, p.height - p.bottom, e.zoom, 'y');
    const readonly = e.readOnly;
    const multipleSections = e.model.paragraphs.some(p => p.sectionEnd);
    selector.disabled = readonly || e.model.selectedParagraphs.some(p => p.cellId) || f.tabs === null;
    for (const [kind, pos, axis] of [['left', p.left, 'x'], ['right', p.width - p.right, 'x'], ['top', p.top, 'y'], ['bottom', p.height - p.bottom, 'y']]) {
      handle(axis === 'x' ? horizontal : vertical, kind, `${kind[0].toUpperCase() + kind.slice(1)} margin`, pos * e.zoom, axis, multipleSections ? Math.round(p[kind] * 15) : s[marginSource(p, s, kind).key], readonly || multipleSections);
    }
    // Cell boundaries/column resizing have their own geometry; do not show body indents there.
    if (!e.model.selectedParagraphs.some(p => p.cellId)) {
      if (f.indentLeft !== null) {
        handle(horizontal, 'indentLeft', 'Left indent', (p.left + f.indentLeft / 15) * e.zoom, 'x', f.indentLeft, readonly);
        if (f.firstLine !== null) {
          handle(horizontal, 'hanging', 'Hanging indent', (p.left + f.indentLeft / 15) * e.zoom, 'x', f.indentLeft, readonly);
          handle(horizontal, 'firstLine', 'First line indent', (p.left + (f.indentLeft + f.firstLine) / 15) * e.zoom, 'x', f.firstLine, readonly);
        }
      }
      if (f.indentRight !== null) handle(horizontal, 'indentRight', 'Right indent', (p.width - p.right - f.indentRight / 15) * e.zoom, 'x', f.indentRight, readonly);
      for (const tab of f.tabs || []) if (!tab.numberingOnly) handle(horizontal, 'tab', `${tab.alignment} tab stop`, (p.left + tab.position / 15) * e.zoom, 'x', tab.position, readonly, tab);
    }
    if (focusKey) [...surface.querySelectorAll('.canvas-ruler-handle')].find(h => h.dataset.kind === focusKey[0] && h.dataset.position === focusKey[1])?.focus({ preventScroll: true });
  }
  function commit(kind, position, c, tabPosition, remove = false) {
    const { e, page: p, settings: s, format: f } = c;
    if (e.readOnly) return;
    const refocusTab = kind === 'tab' && document.activeElement?.dataset?.kind === 'tab';
    let patch;
    if (['left', 'right', 'top', 'bottom'].includes(kind)) {
      const source = marginSource(p, s, kind);
      let amount = kind === 'right' ? s.width - position : kind === 'bottom' ? s.height - position : position;
      amount -= source.gutter;
      const horizontal = kind === 'left' || kind === 'right';
      const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }[source.key];
      const gutter = horizontal !== s.gutterAtTop ? s.gutter : 0;
      amount = clamp(amount, 0, (horizontal ? s.width : s.height) - Math.abs(s[opposite]) - gutter - 360);
      if (s[source.key] < 0) amount = -amount;
      e.setPageSettings({ [source.key]: amount });
    } else {
      const relative = position - Math.round(p.left * 15);
      if (kind === 'indentLeft') patch = { indentLeft: relative };
      if (kind === 'firstLine') patch = { firstLine: relative - f.indentLeft };
      if (kind === 'hanging') patch = { indentLeft: relative, firstLine: f.firstLine + f.indentLeft - relative };
      if (kind === 'indentRight') patch = { indentRight: Math.round((p.width - p.right) * 15) - position };
      if (kind === 'tab') {
        const previous = f.tabs.find(t => t.position === tabPosition);
        const tabs = f.tabs.filter(t => t.position !== tabPosition && (remove || t.position !== relative));
        if (!remove) tabs.push({ ...(previous || { alignment: tabType }), position: relative });
        patch = { tabs };
      }
      if (patch) e.setParagraphGeometry(patch);
    }
    signature = ''; update();
    if (refocusTab) {
      const tabKey = remove ? null : String(position - Math.round(p.left * 15));
      const target = [...horizontal.querySelectorAll('[data-kind="tab"]')].find(h => h.dataset.position === tabKey);
      (target || selector).focus({ preventScroll: true });
    }
  }
  function cancel() { drag = null; guide.hidden = value.hidden = true; signature = ''; }
  function point(event, d) {
    const rect = (d.axis === 'x' ? horizontal : vertical).getBoundingClientRect();
    const raw = ((d.axis === 'x' ? event.clientX - rect.left : event.clientY - rect.top) - d.offset) / d.c.e.zoom * 15;
    const origin = d.axis === 'x' && !['left', 'right'].includes(d.kind) ? Math.round(d.c.page.left * 15) : 0;
    return rulerSnap(raw - origin, unit, event.altKey) + origin;
  }
  // A fingertip covers the small markers (a first-line indent is a 12 by 8 pixel triangle) and lands a little off
  // them: a touch takes the nearest marker within reach on its ruler, rather than setting a tab stop beside it.
  const TOUCH_REACH = 16;
  function touchedHandle(event) {
    if (event.pointerType !== 'touch') return null;
    const ruler = event.target.closest?.('.canvas-ruler'); if (!ruler) return null;
    let best = null, distance = TOUCH_REACH;
    for (const node of ruler.querySelectorAll('.canvas-ruler-handle')) {
      if (node.disabled || node.hidden) continue;
      const r = node.getBoundingClientRect(); if (!r.width && !r.height) continue;
      const d = Math.hypot(Math.max(r.left - event.clientX, 0, event.clientX - r.right), Math.max(r.top - event.clientY, 0, event.clientY - r.bottom));
      if (d <= distance) { best = node; distance = d; }
    }
    return best;
  }
  listen(surface, 'pointerdown', event => {
    let h = event.target.closest('.canvas-ruler-handle') || touchedHandle(event);
    if (!h || h.disabled || event.button !== 0) return;
    event.preventDefault(); const c = context();
    const kind = h.dataset.kind, tabPosition = h.dataset.position;
    c.e.finishComposition();
    if (!h.isConnected) h = [...surface.querySelectorAll('.canvas-ruler-handle')].find(node => node.dataset.kind === kind && node.dataset.position === tabPosition);
    if (!h || h.disabled) return;
    const axis = h.dataset.axis, rect = (axis === 'x' ? horizontal : vertical).getBoundingClientRect();
    drag = { c: context(), h, axis, kind: h.dataset.kind, tabPosition: Number(h.dataset.position), pointer: event.pointerId, revision: c.e.model.revision, selection: JSON.stringify(c.e.model.selection),
      offset: (axis === 'x' ? event.clientX - rect.left - parseFloat(h.style.left) : event.clientY - rect.top - parseFloat(h.style.top)), moved: false };
    drag.zoom = c.e.zoom; drag.position = point(event, drag); drag.start = drag.position; drag.startY = event.clientY; h.setPointerCapture(event.pointerId);
  });
  listen(surface, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag.position = point(event, drag);
    if (Math.abs(drag.position - drag.start) < 15 && !drag.moved && !(drag.kind === 'tab' && Math.abs(event.clientY - drag.startY) > 20)) return;
    drag.moved = true;
    const { axis, position, c, h } = drag;
    h.style[axis === 'x' ? 'left' : 'top'] = `${position / 15 * c.e.zoom}px`;
    if (drag.kind === 'indentLeft' || drag.kind === 'hanging') {
      const linked = horizontal.querySelector(`[data-kind="${drag.kind === 'indentLeft' ? 'hanging' : 'indentLeft'}"]`);
      if (linked) linked.style.left = h.style.left;
      if (drag.kind === 'indentLeft') {
        const first = horizontal.querySelector('[data-kind="firstLine"]');
        if (first) first.style.left = `${(position + c.format.firstLine) / 15 * c.e.zoom}px`;
      }
    }
    const box = surface.getBoundingClientRect();
    guide.hidden = value.hidden = false; guide.dataset.axis = axis;
    guide.style.left = axis === 'x' ? `${c.rect.left - box.left + position / 15 * c.e.zoom}px` : '30px';
    guide.style.top = axis === 'y' ? `${c.rect.top - box.top + position / 15 * c.e.zoom}px` : '30px';
    let amount = position - (axis === 'x' ? c.page.left : c.page.top) * 15;
    if (drag.kind === 'firstLine') amount -= c.format.indentLeft;
    if (drag.kind === 'indentRight') amount = (c.page.width - c.page.right) * 15 - position;
    if (['left', 'right', 'top', 'bottom'].includes(drag.kind)) {
      const source = marginSource(c.page, c.settings, drag.kind);
      amount = drag.kind === 'right' ? c.settings.width - position : drag.kind === 'bottom' ? c.settings.height - position : position;
      amount -= source.gutter;
      if (c.settings[source.key] < 0) amount = -amount;
    }
    value.textContent = `${h.getAttribute('aria-label')}: ${measurement(amount)}`;
  });
  listen(surface, 'pointerup', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const d = drag;
    if (!d.moved) { drag = null; return; }
    cancel();
    if (d.moved && d.revision === d.c.e.model.revision && d.selection === JSON.stringify(d.c.e.model.selection) && d.c.e.zoom === d.zoom) {
      const rect = horizontal.getBoundingClientRect();
      commit(d.kind, point(event, d), d.c, d.tabPosition, d.kind === 'tab' && (event.clientY > rect.bottom + 20 || event.clientY < rect.top - 20));
    }
    update();
  });
  for (const event of ['pointercancel', 'lostpointercapture']) listen(surface, event, () => { if (drag) { cancel(); update(); } });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); cancel(); update(); }
  }, { capture: true, signal: abort.signal });
  listen(surface, 'keydown', event => {
    const h = event.target.closest('.canvas-ruler-handle'); if (!h || h.disabled) return;
    if (event.key === 'Escape') { event.preventDefault(); editor().focus(); return; }
    const remove = h.dataset.kind === 'tab' && ['Delete', 'Backspace'].includes(event.key);
    const delta = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : 0;
    if (!delta && !remove) return;
    event.preventDefault(); const c = context(); c.e.finishComposition();
    const position = parseFloat(h.style[h.dataset.axis === 'x' ? 'left' : 'top']) / c.e.zoom * 15;
    commit(h.dataset.kind, Math.round(position + delta * (event.altKey ? 1 : rulerStep(unit))), c, Number(h.dataset.position), remove);
  });
  listen(horizontal, 'pointerdown', event => {
    if (event.target.closest('button') || event.button !== 0 || selector.disabled || touchedHandle(event)) return;
    event.preventDefault(); const c = context(); c.e.finishComposition();
    const position = rulerSnap((event.clientX - horizontal.getBoundingClientRect().left) / c.e.zoom * 15 - c.page.left * 15, unit, event.altKey);
    if (position >= 0 && position < (c.page.width - c.page.left - c.page.right) * 15) commit('tab', position + Math.round(c.page.left * 15), context(), NaN);
  });
  listen(surface, 'dblclick', event => {
    const handle = event.target.closest('.canvas-ruler-handle');
    if (!handle || handle.disabled) return;
    if (['left', 'right', 'top', 'bottom'].includes(handle.dataset.kind)) openPage?.();
    else openParagraph();
  });
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; update(); }); };
  listen(host, 'scroll', () => { if (drag) cancel(); schedule(); });
  const observer = new ResizeObserver(schedule); observer.observe(host);
  phone?.addEventListener?.('change', () => { if (!chosen) { visible = phone.matches ? false : storedRuler() ?? true; cancel(); update(); } }, { signal: abort.signal });
  return { update, get visible() { return visible; }, toggle() {
    visible = !visible; chosen = true; cancel(); update();
    if (!phone?.matches) try { localStore()?.setItem(RULER_STORE, visible ? 'shown' : 'hidden'); } catch { /* storage unavailable: the choice lasts for this visit */ }
  },
    setUnit(next) { rememberUnit(next); }, get unit() { return unit; },
    destroy() { abort.abort(); unsubscribe(); observer.disconnect(); cancelAnimationFrame(frame); top.remove(); side.remove(); selector.remove(); guide.remove(); value.remove(); } };
}
