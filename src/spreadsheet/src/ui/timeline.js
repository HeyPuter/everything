/**
 * A live timeline view: a caption with Clear Filter, the selection label and the time level
 * (YEARS, QUARTERS, MONTHS, DAYS), and a scrolling strip of periods grouped under their year.
 * Click a period to filter to it, Shift-click or drag to take a range; arrow keys move, Shift
 * with an arrow extends. `change(start, end, level)` receives day serials (null clears) or a new
 * level; the caller filters and hands back fresh state with update().
 */
import { TIMELINE_LEVELS, timelinePeriods, timelineSelectionLabel } from '../core/timeline.js';
import { t } from '../i18n/index.js';

const TILE = 44, GAP = 2;

export function createTimelineControl(doc, change) {
  const make = (tag, className, css = '') => { const n = doc.createElement(tag); if (className) n.className = className; if (css) n.style.cssText = css; return n; };
  const node = make('div', 'timeline-control', 'display:flex;flex-direction:column;width:100%;height:100%;box-sizing:border-box;overflow:hidden;font:inherit;font-size:12px;'
    + 'background:var(--surface,#fff);color:var(--ink,#222);border:1px solid var(--hairline,#c8c8c8)');
  node.setAttribute('role', 'group'); node.tabIndex = -1;
  const header = make('div', 'timeline-header', 'display:flex;align-items:center;gap:4px;padding:4px 6px;flex:none;border-bottom:1px solid var(--hairline,#e1e1e1)');
  const caption = make('span', '', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600');
  const clear = make('button', 'timeline-clear', 'font:inherit;color:inherit;background:transparent;border:0;padding:2px 4px;cursor:pointer');
  clear.type = 'button'; clear.textContent = '×'; clear.title = t('timeline.clearFilter'); clear.setAttribute('aria-label', t('timeline.clearFilter'));
  header.append(caption, clear);
  const bar = make('div', 'timeline-bar', 'display:flex;align-items:center;gap:6px;padding:4px 6px 0;flex:none');
  const label = make('span', 'timeline-label', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
  const level = make('select', 'timeline-level', 'font:inherit;font-size:11px;color:var(--accent,#2b579a);background:transparent;border:0;cursor:pointer');
  level.setAttribute('aria-label', t('timeline.timeLevel'));
  for (const [key, name] of TIMELINE_LEVELS) { const o = doc.createElement('option'); o.value = key; o.textContent = t(name); level.append(o); }
  bar.append(label, level);
  const strip = make('div', 'timeline-strip', 'flex:1;min-height:0;overflow-x:auto;overflow-y:hidden;padding:2px 6px 4px;box-sizing:border-box');
  strip.setAttribute('role', 'listbox'); strip.setAttribute('aria-multiselectable', 'true'); strip.setAttribute('aria-label', t('timeline.periods'));
  const groups = make('div', 'timeline-groups', 'display:flex;height:16px;white-space:nowrap');
  const tiles = make('div', 'timeline-tiles', 'position:relative;height:calc(100% - 16px);min-height:28px');
  strip.append(groups, tiles);
  const status = make('div', 'timeline-status', 'padding:4px 6px'); status.setAttribute('role', 'status'); status.hidden = true;
  node.append(header, bar, strip, status);

  let control = null, state = null, periods = [], disabled = false, anchor = null, focusIndex = 0, drag = null;
  const selectedRange = () => state?.start == null ? null : [state.start, state.end];
  const submit = (start, end) => {
    try { return change?.(start, end, control.level); } catch (error) { status.textContent = error.message || t('timeline.couldNotFilter'); status.hidden = false; return false; }
  };
  const choose = (a, b) => {
    const first = periods[Math.min(a, b)], last = periods[Math.max(a, b)];
    if (first && last) submit(first.start, last.end);
  };
  const tileAt = event => event.target.closest?.('.timeline-tile');
  tiles.addEventListener('pointerdown', event => {
    const tile = tileAt(event);
    if (!tile || disabled) return;
    event.stopPropagation(); event.preventDefault();
    const index = Number(tile.dataset.index);
    if (event.shiftKey && anchor != null) { choose(anchor, index); return; }
    anchor = index; focusIndex = index; drag = { from: index, to: index };
    paintDrag();
    tile.setPointerCapture?.(event.pointerId);
  });
  tiles.addEventListener('pointermove', event => {
    if (!drag) return;
    const hit = doc.elementFromPoint?.(event.clientX, event.clientY)?.closest?.('.timeline-tile');
    if (hit && tiles.contains(hit)) { drag.to = Number(hit.dataset.index); paintDrag(); }
  });
  const finish = () => { if (!drag) return; const { from, to } = drag; drag = null; choose(from, to); };
  tiles.addEventListener('pointerup', finish);
  tiles.addEventListener('pointercancel', () => { drag = null; render(); });
  node.addEventListener('pointerdown', event => { if (strip.contains(event.target) || event.target === level || event.target === clear) event.stopPropagation(); });
  node.addEventListener('dblclick', event => { if (strip.contains(event.target) || bar.contains(event.target)) event.stopPropagation(); });
  clear.addEventListener('click', event => { event.stopPropagation(); if (!disabled) { anchor = null; submit(null, null); } });
  level.addEventListener('change', () => { if (!disabled) change?.(state?.start ?? null, state?.end ?? null, level.value, true); });
  strip.addEventListener('keydown', event => {
    if (!periods.length || disabled) return;
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (Object.hasOwn(moves, event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = Math.max(0, Math.min(periods.length - 1, moves[event.key] === -Infinity ? 0 : moves[event.key] === Infinity ? periods.length - 1 : focusIndex + moves[event.key]));
      if (event.shiftKey) { if (anchor == null) anchor = focusIndex; focusIndex = next; choose(anchor, next); }
      else { focusIndex = next; render(); }
      tiles.children[focusIndex]?.focus({ preventScroll: false });
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); anchor = focusIndex; choose(focusIndex, focusIndex);
    }
  });
  function paintDrag() {
    const lo = Math.min(drag.from, drag.to), hi = Math.max(drag.from, drag.to);
    for (const tile of tiles.children) paintTile(tile, Number(tile.dataset.index) >= lo && Number(tile.dataset.index) <= hi);
  }
  function paintTile(tile, on) {
    const period = periods[Number(tile.dataset.index)];
    const data = !state?.days?.size || [...Array(Math.min(400, period.end - period.start + 1)).keys()].some(i => state.days.has(period.start + i));
    tile.setAttribute('aria-selected', String(on));
    tile.style.background = on ? 'var(--timeline-on,#5b9bd5)' : data ? 'var(--timeline-off,#d9e5f3)' : 'var(--timeline-empty,#f0f0f0)';
    tile.style.color = on ? '#fff' : 'inherit';
  }
  function render() {
    if (!control) return;
    const range = selectedRange();
    groups.replaceChildren(); tiles.replaceChildren();
    // Each group (a year, or a month of days) spans its periods; its name sticks to the left edge while it scrolls.
    let current = null;
    periods.forEach((period, i) => {
      const left = i * (TILE + GAP);
      if (period.group && period.group !== current?.name) {
        const g = make('div', 'timeline-group', 'flex:none;overflow:visible');
        const name = make('span', '', 'position:sticky;left:0;display:inline-block;font-size:11px;font-weight:600;padding-right:4px');
        name.textContent = period.group; g.append(name); groups.append(g);
        current = { name: period.group, node: g, count: 0 };
      }
      if (current) current.node.style.width = `${++current.count * (TILE + GAP)}px`;
      const tile = make('div', 'timeline-tile', `position:absolute;left:${left}px;top:0;width:${TILE}px;height:100%;box-sizing:border-box;display:flex;align-items:flex-end;justify-content:center;padding-bottom:2px;font-size:10px;cursor:pointer;user-select:none`);
      tile.dataset.index = String(i); tile.setAttribute('role', 'option'); tile.tabIndex = i === focusIndex ? 0 : -1;
      tile.textContent = period.label; tile.title = timelineSelectionLabel(period.start, period.end, control.level);
      paintTile(tile, !!range && period.start <= range[1] && period.end >= range[0]);
      tiles.append(tile);
    });
    const width = `${periods.length * (TILE + GAP)}px`;
    groups.style.width = width; tiles.style.width = width;
  }
  return { node, update(nextControl, nextState, options = {}) {
    const levelChanged = control?.level !== nextControl.level;
    const rangeChanged = state?.start !== nextState?.start || state?.end !== nextState?.end;
    control = nextControl; state = nextState; disabled = !!options.disabled || !nextState || !change;
    node.setAttribute('aria-label', control.title || t('timeline.timeline'));
    caption.textContent = control.title || ''; header.style.display = control.showHeader === false ? 'none' : 'flex';
    label.textContent = timelineSelectionLabel(state?.start, state?.end, control.level);
    label.style.display = control.showSelectionLabel === false ? 'none' : '';
    level.value = control.level; level.style.display = control.showTimeLevel === false ? 'none' : '';
    bar.style.display = control.showSelectionLabel === false && control.showTimeLevel === false ? 'none' : 'flex';
    strip.style.overflowX = control.showHorizontalScrollbar === false ? 'hidden' : 'auto';
    level.disabled = clear.disabled = disabled;
    clear.disabled = disabled || state?.start == null;
    periods = state ? timelinePeriods(state.min, state.max, control.level) : [];
    if (focusIndex >= periods.length) focusIndex = Math.max(0, periods.length - 1);
    status.hidden = !!periods.length;
    if (!periods.length) status.textContent = nextState == null ? t('timeline.unavailable') : t('timeline.noDates');
    render();
    // Bring the chosen range into view when the level or the range changes (from the first period when none is chosen).
    if (levelChanged || rangeChanged) {
      const first = state?.start != null ? Math.max(0, periods.findIndex(p => p.end >= state.start)) : 0;
      const last = state?.end != null ? Math.max(first, periods.findLastIndex(p => p.start <= state.end)) : first;
      const left = first * (TILE + GAP), right = (last + 1) * (TILE + GAP);
      const view = strip.clientWidth || control.w;
      if (levelChanged || left < strip.scrollLeft || right > strip.scrollLeft + view) strip.scrollLeft = Math.max(0, right - left > view ? left : left - 8);
    }
  } };
}
