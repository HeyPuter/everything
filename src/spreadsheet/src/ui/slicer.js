import { normalizeSlicer, slicerPivotCache } from '../core/slicer.js';
import { applySlicerPaint, slicerStatePaint } from './slicer-paint.js';
import { t } from '../i18n/index.js';

// Table slicers use their filter text; native pivots can supply a cache-member
// key independently of a formatted caption. Numeric zero is a valid identity.
const itemKey = item => item?.key ?? item?.value;

/** A live slicer view. change receives item keys (or legacy table values);
 * the caller owns filtering and returns fresh item state via update(). */
export function createSlicerControl(doc, change) {
  const node = doc.createElement('div'); node.className = 'slicer-control'; node.setAttribute('role', 'group'); node.tabIndex = -1;
  node.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;min-height:0;box-sizing:border-box;overflow:hidden;font:inherit';
  const header = doc.createElement('div'); header.className = 'slicer-header';
  header.style.cssText = 'display:flex;align-items:center;gap:4px;flex:none;min-width:0;padding:4px;box-sizing:border-box';
  const caption = doc.createElement('span'); caption.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  const action = (name, text) => {
    const button = doc.createElement('button'); button.type = 'button'; button.textContent = text;
    button.setAttribute('aria-label', name); button.title = name;
    button.style.cssText = 'font:inherit;color:inherit;flex:none;background:transparent;border:0;padding:2px;cursor:pointer'; return button;
  };
  const multi = action(t('slicer.multiSelect'), '☷'), clear = action(t('slicer.clearFilter'), '×');
  multi.setAttribute('aria-pressed', 'false'); header.append(caption, multi, clear);
  const list = doc.createElement('div'); list.className = 'slicer-items'; list.setAttribute('role', 'group'); list.setAttribute('aria-label', t('slicer.filterValues'));
  list.style.cssText = 'display:block;flex:1;min-height:0;overflow:auto;padding:4px;box-sizing:border-box;overflow-anchor:none';
  const surface = doc.createElement('div'); surface.style.cssText = 'position:relative;width:100%;overflow:clip'; list.append(surface);
  const status = doc.createElement('div'); status.className = 'slicer-status'; status.setAttribute('role', 'status'); status.style.padding = '4px'; status.hidden = true;
  node.append(header, list, status);
  let control = null, items = [], allItems = [], paints = {}, disabled = false, multiple = false, focusedKey = null, rangeStart = null, lastStart = null;
  const buttons = new Map(), hovered = new Set();
  let indexes = new Map(), scrollAdjustment = 0, lastScroll = 0;
  // Keep the scroll track below browser layout limits. At extreme native row
  // heights only the scrollbar is compressed; visible buttons retain their size.
  // Gecko's fixed-point ceiling: https://bugzilla.mozilla.org/show_bug.cgi?id=1398675
  const maxTrack = 16000000, gap = 2, padding = 8;
  const metrics = () => {
    const stride = control.rowHeight / 9525 + gap, columns = control.columnCount;
    const height = Math.max(0, Math.ceil(items.length / columns) * stride - gap);
    const viewport = Math.max(1, (list.clientHeight || control.h) - padding);
    const viewportWidth = Math.max(1, (list.clientWidth || control.w) - padding);
    const width = Math.max(viewportWidth, gap * (columns - 1));
    const columnWidth = (width - gap * (columns - 1)) / columns, columnStride = columnWidth + gap;
    const track = Math.min(maxTrack, height);
    const scale = Math.max(1, (height - viewport) / Math.max(1, track - viewport));
    return { stride, columns, height, viewport, viewportWidth, columnWidth, columnStride, track, scale, top: Math.max(0, Math.min(Math.max(0, height - viewport), list.scrollTop * scale + scrollAdjustment)) };
  };
  const scrollTo = top => {
    const m = metrics();
    top = Math.max(0, Math.min(Math.max(0, m.height - m.viewport), top));
    list.scrollTop = top / m.scale;
    // Large physical offsets are rounded by the browser. Retain the logical
    // residual so keyboard focus aligns an item's label, not hundreds of pixels below it.
    scrollAdjustment = top - list.scrollTop * m.scale;
    lastScroll = list.scrollTop;
  };
  const label = value => value === '' ? t('slicer.blank') : value;
  const paint = (key, button) => {
    const item = button.slicerItem;
    const state = slicerStatePaint(paints, { ...item, hovered: hovered.has(key) });
    applySlicerPaint(button, state,
      button.clientWidth || Math.max(1, (control.w - 8 - 2 * (control.columnCount - 1)) / control.columnCount), Math.max(1, control.rowHeight / 9525));
    for (const [key, css] of [['font', 'fontFamily'], ['size', 'fontSize'], ['bold', 'fontWeight'], ['italic', 'fontStyle'], ['color', 'color']]) {
      if (state[key] == null) button.style[css] = 'inherit';
    }
  };
  const focus = index => {
    if (!items.length) return;
    index = Math.max(0, Math.min(items.length - 1, index));
    focusedKey = itemKey(items[index]);
    const m = metrics(), top = Math.floor(index / m.columns) * m.stride;
    const bottom = top + control.rowHeight / 9525, left = index % m.columns * m.columnStride;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (left + m.columnWidth > list.scrollLeft + m.viewportWidth) list.scrollLeft = left + m.columnWidth - m.viewportWidth;
    if (top < m.top || control.rowHeight / 9525 >= m.viewport) scrollTo(top);
    else if (bottom > m.top + m.viewport) scrollTo(bottom - m.viewport);
    render();
    buttons.get(focusedKey)?.focus({ preventScroll: true });
  };
  const submit = values => {
    try { return change?.(values); }
    catch (error) { status.textContent = error.message || t('slicer.couldNotUpdate'); status.hidden = false; return false; }
  };
  const select = (key, event) => {
    if (disabled || !change) return;
    const index = indexes.get(key);
    if (index == null) return;
    let next;
    const additive = multiple || event.ctrlKey || event.metaKey;
    if (event.shiftKey && rangeStart != null && indexes.has(rangeStart)) {
      const start = indexes.get(rangeStart);
      const range = items.slice(Math.min(start, index), Math.max(start, index) + 1).map(itemKey);
      next = additive ? [...new Set([...allItems.filter(item => item.selected).map(itemKey), ...range])] : range;
    } else if (additive) {
      next = allItems.filter(item => itemKey(item) === key ? !item.selected : item.selected).map(itemKey);
    } else next = [key];
    // Toggling off the last selected item selects all items.
    // https://learn.microsoft.com/en-us/javascript/api/office-scripts/excelscript/excelscript.sliceritem
    // Changes are committed by the workbook. A rejected edit leaves the display untouched.
    if (submit(!next.length || next.length === allItems.length ? null : next) !== false) rangeStart = key;
  };
  multi.addEventListener('click', event => {
    event.stopPropagation(); if (disabled) return;
    multiple = !multiple; multi.setAttribute('aria-pressed', String(multiple));
  });
  clear.addEventListener('click', event => { event.stopPropagation(); if (!disabled) submit(null); });
  node.addEventListener('pointerdown', event => {
    // Item interaction must not start the surrounding drawing's drag gesture.
    if (event.target.closest('button') || list.contains(event.target)) event.stopPropagation();
  });
  node.addEventListener('dblclick', event => event.stopPropagation());
  node.addEventListener('keydown', event => {
    if (event.target === clear || event.target === multi) {
      if ([' ', 'Enter'].includes(event.key)) event.stopPropagation();
      return;
    }
    const button = event.target.closest('.slicer-item');
    if (!button) return;
    const index = indexes.get(itemKey(button.slicerItem));
    const columns = control.columnCount;
    const moves = { ArrowLeft: index - 1, ArrowRight: index + 1, ArrowUp: index - columns, ArrowDown: index + columns, Home: 0, End: items.length - 1 };
    if (Object.hasOwn(moves, event.key)) { event.preventDefault(); event.stopPropagation(); focus(moves[event.key]); }
    else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); select(itemKey(button.slicerItem), event);
    }
  });
  function render() {
    if (!control) return;
    const m = metrics();
    surface.style.height = `${m.track}px`;
    surface.style.minWidth = `${gap * (m.columns - 1)}px`;
    const first = Math.max(0, Math.floor(m.top / m.stride) - 1) * m.columns;
    const last = Math.min(items.length, (Math.ceil((m.top + m.viewport) / m.stride) + 1) * m.columns);
    const visible = [];
    const firstColumn = Math.max(0, Math.floor(list.scrollLeft / m.columnStride) - 1);
    const lastColumn = Math.min(m.columns, Math.ceil((list.scrollLeft + m.viewportWidth) / m.columnStride) + 1);
    for (let row = first; row < last; row += m.columns) for (let col = firstColumn; col < lastColumn; col++) {
      if (row + col < items.length) visible.push(row + col);
    }
    const mounted = new Set(visible);
    // Keep an actively focused item alive while the user scrolls with a wheel.
    // A stored roving-tab target outside the viewport instead follows its first row.
    const active = node.contains(doc.activeElement) ? indexes.get(itemKey(doc.activeElement?.slicerItem)) : null;
    if (active != null && !mounted.has(active)) { visible.push(active); visible.sort((a, b) => a - b); }
    if (active == null && !mounted.has(indexes.get(focusedKey))) focusedKey = itemKey(items[visible[0]]) ?? null;
    const keep = new Set(visible.map(i => itemKey(items[i])));
    for (const [key, button] of buttons) if (!keep.has(key)) { button.remove(); buttons.delete(key); hovered.delete(key); }
    let previous = null;
    for (const index of visible) {
      const item = items[index];
      let button = buttons.get(itemKey(item));
      if (!button) {
        button = doc.createElement('button'); button.type = 'button'; button.className = 'slicer-item';
        button.style.cssText = 'min-width:0;box-sizing:border-box;font:inherit;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 4px;cursor:pointer';
        button.addEventListener('click', event => { event.stopPropagation(); select(itemKey(button.slicerItem), event); });
        button.addEventListener('focus', () => {
          focusedKey = itemKey(button.slicerItem);
          for (const [key, b] of buttons) b.tabIndex = key === focusedKey ? 0 : -1;
          const m = metrics(), index = indexes.get(focusedKey), top = Math.floor(index / m.columns) * m.stride;
          // Tab can re-enter a retained offscreen item after visiting the header.
          const left = index % m.columns * m.columnStride;
          if (top + control.rowHeight / 9525 <= m.top || top >= m.top + m.viewport
            || left + m.columnWidth < list.scrollLeft || left > list.scrollLeft + m.viewportWidth) focus(index);
        });
        button.addEventListener('pointerenter', () => { hovered.add(itemKey(button.slicerItem)); paint(itemKey(button.slicerItem), button); });
        button.addEventListener('pointerleave', () => { hovered.delete(itemKey(button.slicerItem)); paint(itemKey(button.slicerItem), button); });
        buttons.set(itemKey(item), button);
      }
      button.slicerItem = item; button.textContent = label(item.value); button.title = label(item.value);
      button.disabled = disabled; button.tabIndex = itemKey(item) === focusedKey ? 0 : -1;
      button.setAttribute('aria-pressed', String(item.selected));
      button.setAttribute('aria-description', item.available ? t('slicer.itemOf', { n: index + 1, total: items.length }) : t('slicer.itemOfNoData', { n: index + 1, total: items.length }));
      button.style.position = 'absolute';
      const top = !mounted.has(index) ? -m.stride : Math.floor(index / m.columns) * m.stride - m.top + list.scrollTop;
      button.style.top = `${top}px`;
      button.style.left = `calc(${index % m.columns * 100 / m.columns}% + ${index % m.columns * gap / m.columns}px)`;
      button.style.width = `calc(${100 / m.columns}% - ${gap * (m.columns - 1) / m.columns}px)`;
      button.style.height = `${control.rowHeight / 9525}px`;
      paint(itemKey(item), button);
      // Avoid moving an unchanged focused node: appendChild would lose focus in some browsers.
      const expected = previous ? previous.nextSibling : surface.firstChild;
      if (expected !== button) surface.insertBefore(button, expected);
      previous = button;
    }
  }
  list.addEventListener('scroll', () => {
    if (list.scrollTop !== lastScroll) scrollAdjustment = 0;
    lastScroll = list.scrollTop; render();
  }, { passive: true });
  return { node, update(nextControl, nextItems, nextPaints = {}, options = {}) {
    const activeKey = node.contains(doc.activeElement) ? itemKey(doc.activeElement?.slicerItem) : null;
    control = nextControl; paints = nextPaints; allItems = nextItems || [];
    // Explicit item visibility also covers retained unused pivot members.
    // The control option is a fallback for callers supplying availability only.
    items = allItems.filter(item => !(item.hidden ?? (control.hideItemsWithNoData && !item.available)));
    disabled = !!options.disabled || nextItems == null || !change;
    node.hidden = !!control.hidden; node.style.display = node.hidden ? 'none' : 'flex'; node.setAttribute('aria-label', control.title || t('slicer.slicer')); node.setAttribute('aria-disabled', String(disabled));
    if (control.description) node.setAttribute('aria-description', control.description); else node.removeAttribute('aria-description');
    caption.textContent = control.title || ''; caption.title = control.title || ''; header.hidden = control.showCaption === false;
    // Inline display styles otherwise override the browser's hidden rule.
    header.style.display = header.hidden ? 'none' : 'flex';
    applySlicerPaint(node, paints.frame?.wholeTable || {}, control.w, control.h);
    applySlicerPaint(header, paints.frame?.headerRow || {}, control.w, header.clientHeight || 28);
    multi.disabled = disabled; clear.disabled = disabled || !allItems.length || allItems.every(item => item.selected);
    list.setAttribute('aria-busy', 'false');
    status.hidden = nextItems != null && !!items.length;
    status.textContent = nextItems == null ? control.pivotCache != null ? t('slicer.cacheUnavailable') : t('slicer.columnUnavailable') : items.length ? '' : t('slicer.noItems');
    indexes = new Map(items.map((item, i) => [itemKey(item), i]));
    if (!indexes.has(focusedKey)) focusedKey = itemKey(items.find(item => item.selected)) ?? itemKey(items[0]) ?? null;
    // Size the surface before setting scrollTop; browsers clamp against its extent.
    surface.style.height = `${metrics().track}px`;
    surface.style.minWidth = `${gap * (control.columnCount - 1)}px`;
    if (lastStart !== control.startItem) {
      lastStart = control.startItem;
      const m = metrics();
      scrollTo(Math.floor(Math.min(control.startItem || 0, Math.max(0, items.length - 1)) / control.columnCount) * m.stride);
    }
    render();
    if (activeKey != null) {
      if (disabled || !items.length) node.focus({ preventScroll: true });
      else if (indexes.has(activeKey)) {
        const target = buttons.get(activeKey);
        if (doc.activeElement !== target) target?.focus({ preventScroll: true });
      } else focus(indexes.get(focusedKey) ?? 0);
    }
  } };
}

/** Internal rich clipboard data plus a plain-value fallback for other spreadsheet applications. */
const clipboardBooks = new WeakMap();
function clipboardBook(wb) {
  if (!wb) return null;
  if (!clipboardBooks.has(wb)) clipboardBooks.set(wb, crypto.randomUUID());
  return clipboardBooks.get(wb);
}
export function slicerClipboard(doc, control, items, wb) {
  const node = doc.createElement('div'); node.setAttribute('data-sheet-slicer', JSON.stringify({ ...control, id: undefined,
    ...(control.pivotCache != null ? { sourceWorkbook: clipboardBook(wb) } : {}) }));
  const values = (items || []).filter(item => item.selected).map(item => item.value);
  for (const value of values) { const row = doc.createElement('div'); row.textContent = value; node.append(row); }
  return { text: values.join('\n'), html: node.outerHTML };
}

export function readSlicerClipboard(doc, html, wb) {
  if (typeof html !== 'string' || html.length > 1000000 || !html.includes('data-sheet-slicer')) return null;
  const template = doc.createElement('template'); template.innerHTML = html;
  try {
    const raw = JSON.parse(template.content.querySelector('[data-sheet-slicer]')?.getAttribute('data-sheet-slicer'));
    // A cache name in another workbook does not identify this source. Retain
    // the plain selected-value fallback until native cache transfer is supported.
    if (raw?.pivotCache != null && (!wb || raw.sourceWorkbook !== clipboardBook(wb) || !slicerPivotCache(wb, raw))) return null;
    return raw?.type === 'slicer' ? normalizeSlicer({ ...raw, id: undefined, nativeName: undefined, nativeCacheName: undefined }) : null;
  } catch { return null; }
}
