import { el } from './dom.js';
import { t } from '../lib/i18n/index.js';

/** Fixed-height rows; renderer owns row content. Call destroy when leaving a view. */
export function virtualList({ items = [], rowHeight = 48, height = 240, overscan = 4, renderItem, label = t('ui.list') }) {
  if (!(rowHeight > 0) || !(height > 0) || !Number.isFinite(rowHeight) || !Number.isFinite(height) || !Number.isFinite(overscan) || overscan < 0) throw new RangeError('Invalid list dimensions');
  overscan = Math.floor(overscan);
  const element = el('div.vlist', { role: 'list', 'aria-label': label, tabIndex: 0, style: { height: `${height}px` } });
  const spacer = el('div.vlist-spacer', { role: 'presentation' }); element.append(spacer);
  const rows = new Map();
  let frame;
  let destroyed = false;
  function render() {
    if (destroyed) return;
    spacer.style.height = `${items.length * rowHeight}px`;
    const first = Math.max(0, Math.floor(element.scrollTop / rowHeight) - overscan);
    const last = Math.min(items.length, Math.ceil((element.scrollTop + (element.clientHeight || height)) / rowHeight) + overscan);
    const wanted = new Set(Array.from({ length: Math.max(0, last - first) }, (_, index) => index + first));
    for (const [index, row] of rows) {
      if (row.contains(document.activeElement)) wanted.add(index);
      else if (!wanted.has(index)) { row.remove(); rows.delete(index); }
    }
    for (const index of [...wanted].sort((a, b) => a - b)) {
      if (rows.has(index)) continue;
      const row = el('div.vlist-row', { role: 'listitem', 'aria-posinset': index + 1, 'aria-setsize': items.length,
        style: { height: `${rowHeight}px`, top: `${index * rowHeight}px` } }, renderItem(items[index], index));
      rows.set(index, row);
      const next = [...spacer.children].find((child) => Number(child.getAttribute('aria-posinset')) > index + 1);
      spacer.insertBefore(row, next ?? null);
    }
  }
  function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); }
  function keydown(event) {
    if (event.target !== element) return;
    const offsets = { ArrowDown: rowHeight, ArrowUp: -rowHeight, PageDown: height, PageUp: -height };
    if (Object.hasOwn(offsets, event.key)) { event.preventDefault(); element.scrollTop = Math.max(0, element.scrollTop + offsets[event.key]); render(); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); element.scrollTop = event.key === 'Home' ? 0 : Math.max(0, items.length * rowHeight - height); render(); }
  }
  element.addEventListener('scroll', schedule); element.addEventListener('keydown', keydown); element.addEventListener('focusout', schedule);
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null; observer?.observe(element);
  render();
  return { element,
    setItems(next) { items = next; rows.clear(); spacer.replaceChildren(); element.scrollTop = Math.min(element.scrollTop, Math.max(0, items.length * rowHeight - height)); render(); },
    scrollToIndex(index) { element.scrollTop = Math.max(0, Math.min(items.length - 1, index)) * rowHeight; render(); },
    destroy() { destroyed = true; cancelAnimationFrame(frame); observer?.disconnect(); element.removeEventListener('scroll', schedule); element.removeEventListener('keydown', keydown); element.removeEventListener('focusout', schedule); rows.clear(); element.remove(); },
  };
}
