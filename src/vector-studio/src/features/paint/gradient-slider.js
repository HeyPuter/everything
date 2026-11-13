/**
 * Gradient slider: the gradient bar with color stops below it and midpoint
 * diamonds above it. Click under the bar to add a stop, drag stops to move
 * them (Option/Alt-drag duplicates), drag a stop down off the slider to
 * remove it, drag midpoints to skew the blend. Every stop and midpoint is a
 * focusable slider: arrows step (Shift 10x), Home/End set the limits. For
 * stops, Delete removes and Enter edits the color.
 */
import { h } from '../../lib/dom.js';
import { paintCss } from '../../ui/widgets.js';
import { insertStop, moveStop, removeStop, setMidpoint } from './gradient-model.js';
import { expandStops } from '../../model/gradients.js';

const REMOVE_DISTANCE = 36;
const VALUE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'];

function keyboardValue(event, value, min, max) {
  const step = event.shiftKey ? 0.1 : 0.01;
  if (event.key === 'Home') return min;
  if (event.key === 'End') return max;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') return Math.max(min, value - step);
  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') return Math.min(max, value + step);
  return null;
}

/** CSS for a horizontal preview of a gradient's stops (midpoints included). */
export function gradientBarCss(paint) {
  return paintCss({ type: 'linear', angle: 0, stops: expandStops(paint.stops) });
}

export function createGradientSlider({ label = 'Gradient', onChange, onSelect, onEditStop, onGestureStart, onDragStart }) {
  let paint = null;
  let selected = 0;
  let gesture = null;
  const bar = h('div.gs-bar', { 'aria-hidden': 'true' }, h('div.gs-fill'));
  const mids = h('div.gs-mids', { role: 'group', 'aria-label': `${label} midpoints` });
  const stopsEl = h('div.gs-stops', { role: 'group', 'aria-label': `${label} stops` });
  const el = h('div.gs', mids, bar, stopsEl);
  const fill = bar.firstChild;

  const fraction = (clientX) => {
    const r = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
  };

  const emit = (next, live) => {
    paint = next;
    render();
    onChange?.(next, { live });
  };

  const select = (i, focus = false) => {
    selected = i;
    onSelect?.(i);
    render();
    if (focus) stopsEl.children[i]?.focus();
  };

  const addStop = (offset) => {
    if (!paint) return;
    gesture?.end();
    if (offset == null) {
      // Insert beside the selected stop; the last stop uses its left interval.
      const index = Math.max(0, Math.min(selected, paint.stops.length - 2));
      offset = (paint.stops[index].offset + paint.stops[index + 1].offset) / 2;
    }
    onGestureStart?.();
    const r = insertStop(paint, offset);
    selected = r.index;
    emit(r.paint, false);
    onSelect?.(r.index);
    stopsEl.children[r.index]?.focus();
  };

  stopsEl.addEventListener('pointerdown', (e) => {
    if (!paint || gesture || e.button !== 0 || e.target !== stopsEl) return;
    // Click in the empty area under the bar adds a stop.
    addStop(fraction(e.clientX));
  });

  // Capture on the persistent container: duplicating/removing stops rebuilds
  // the handles, which must not detach the active capture target.
  const startDrag = (e, move, finish) => {
    if (!paint || gesture || e.button !== 0) return false;
    e.preventDefault();
    e.stopPropagation();
    const pointerId = e.pointerId;
    try { el.setPointerCapture?.(pointerId); } catch { return false; }
    const active = {};
    let dispose;
    gesture = active;
    const owns = (ev) => gesture === active && ev.pointerId === pointerId;
    const onMove = (ev) => { if (owns(ev)) move(ev); };
    const end = (ev) => {
      if (gesture !== active || (ev && !owns(ev))) return;
      gesture = null;
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      el.removeEventListener('lostpointercapture', end);
      try { el.releasePointerCapture?.(pointerId); } catch { /* Capture already ended. */ }
      dispose?.();
      finish(ev?.type === 'pointerup');
    };
    active.end = end;
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    dispose = onDragStart?.(() => end());
    if (gesture !== active) { dispose?.(); return false; }
    onGestureStart?.();
    return true;
  };

  const startStopDrag = (e, index) => {
    let idx = index;
    let cur = paint;
    const startY = e.clientY;
    let removing = false;
    let pendingDuplicate = e.altKey;
    const move = (ev) => {
      removing = Math.abs(ev.clientY - startY) > REMOVE_DISTANCE && cur.stops.length > 2;
      stopsEl.children[idx]?.classList.toggle('removing', removing);
      if (removing) return;
      const r = moveStop(cur, idx, fraction(ev.clientX));
      cur = r.paint;
      idx = r.index;
      selected = idx;
      pendingDuplicate = false;
      emit(cur, true);
      // The stop stays selected (and its fields follow it) when it passes another stop.
      onSelect?.(idx);
    };
    const finish = (released) => {
      if (!released) {
        // Keep completed live edits; cancellation must not perform the pending
        // off-bar deletion or commit an unplaced Alt-drag duplicate.
        select(Math.max(0, Math.min(selected, paint.stops.length - 1)));
        return;
      }
      if (removing) {
        const next = removeStop(cur, idx);
        selected = Math.max(0, Math.min(idx, next.stops.length - 1));
        onSelect?.(selected);
        emit(next, false);
      } else {
        if (pendingDuplicate) {
          // An Alt-click may release without a move event. Place the copy in
          // sorted order just as the first drag movement would.
          const r = moveStop(cur, idx, cur.stops[idx].offset);
          cur = r.paint;
          idx = r.index;
        }
        selected = idx;
        emit(cur, false);
        // Model feedback can clamp selection while the copy is still pending.
        onSelect?.(idx);
      }
    };
    if (!startDrag(e, move, finish)) return;
    if (e.altKey) {
      // Duplicate the stop and drag the copy.
      const s = cur.stops[idx];
      cur = { ...cur, stops: [...cur.stops, { ...s }] };
      idx = cur.stops.length - 1;
    }
    select(idx);
  };

  const startMidDrag = (e, index) => {
    if (!paint) return;
    const a = paint.stops[index];
    const b = paint.stops[index + 1];
    const move = (ev) => {
      const f = fraction(ev.clientX);
      const span = b.offset - a.offset;
      if (span <= 1e-6) return;
      emit(setMidpoint(paint, index, (f - a.offset) / span), true);
    };
    startDrag(e, move, (released) => { if (released) emit(paint, false); });
  };

  const render = () => {
    if (!paint) return;
    fill.style.background = gradientBarCss(paint);
    const stops = paint.stops;
    if (stopsEl.children.length !== stops.length) {
      stopsEl.replaceChildren(
        ...stops.map((_, i) => {
          const b = h('button.gs-stop', { type: 'button', role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span.gs-stop-chip'));
          b.addEventListener('pointerdown', (e) => startStopDrag(e, Number(b.dataset.index)));
          b.addEventListener('dblclick', () => onEditStop?.(Number(b.dataset.index), b));
          b.addEventListener('keydown', (e) => {
            // A discrete keyboard action supersedes the held pointer gesture;
            // its stale paint must not restore a deleted or moved stop.
            if (VALUE_KEYS.includes(e.key) || ['Delete', 'Backspace', 'Enter'].includes(e.key)) gesture?.end();
            const i2 = Number(b.dataset.index);
            const offset = keyboardValue(e, paint.stops[i2].offset, 0, 1);
            if (offset !== null) {
              onGestureStart?.();
              const r = moveStop(paint, i2, offset);
              selected = r.index;
              onSelect?.(r.index);
              emit(r.paint, false);
              stopsEl.children[r.index]?.focus();
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
              if (paint.stops.length <= 2) return;
              onGestureStart?.();
              const next = removeStop(paint, i2);
              selected = Math.max(0, Math.min(i2, next.stops.length - 1));
              onSelect?.(selected);
              emit(next, false);
              stopsEl.children[selected]?.focus();
            } else if (e.key === 'Enter') {
              onEditStop?.(i2, b);
            } else return;
            e.preventDefault();
            e.stopPropagation();
          });
          b.addEventListener('focus', () => {
            const i2 = Number(b.dataset.index);
            if (i2 !== selected) select(i2);
          });
          return b;
        }),
      );
    }
    stops.forEach((s, i) => {
      const b = stopsEl.children[i];
      b.dataset.index = String(i);
      b.style.left = `${s.offset * 100}%`;
      b.firstChild.style.background = s.color;
      b.firstChild.style.opacity = String(0.35 + 0.65 * (s.opacity ?? 1));
      b.classList.toggle('selected', i === selected);
      b.classList.remove('removing');
      b.setAttribute('aria-valuenow', String(Math.round(s.offset * 100)));
      b.setAttribute('aria-valuetext', `${Math.round(s.offset * 100)}%, ${s.color.toUpperCase()}${(s.opacity ?? 1) < 1 ? `, opacity ${Math.round((s.opacity ?? 1) * 100)}%` : ''}`);
      b.setAttribute('aria-label', `Stop ${i + 1}`);
      b.tabIndex = 0;
    });
    const midCount = Math.max(0, stops.length - 1);
    if (mids.children.length !== midCount) {
      mids.replaceChildren(
        ...Array.from({ length: midCount }, () => {
          const m = h('span.gs-mid', { role: 'slider', tabindex: 0, 'aria-valuemin': '5', 'aria-valuemax': '95' });
          m.addEventListener('pointerdown', (e) => startMidDrag(e, Number(m.dataset.index)));
          m.addEventListener('keydown', (e) => {
            if (!VALUE_KEYS.includes(e.key)) return;
            gesture?.end();
            const index = Number(m.dataset.index);
            const value = keyboardValue(e, paint.stops[index].midpoint ?? 0.5, 0.05, 0.95);
            e.preventDefault();
            e.stopPropagation();
            onGestureStart?.();
            emit(setMidpoint(paint, index, value), false);
          });
          return m;
        }),
      );
    }
    for (let i = 0; i < midCount; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      const m = mids.children[i];
      m.dataset.index = String(i);
      const percent = Math.round((a.midpoint ?? 0.5) * 10000) / 100;
      m.setAttribute('aria-label', `Midpoint between stops ${i + 1} and ${i + 2}`);
      m.setAttribute('aria-valuenow', String(percent));
      m.setAttribute('aria-valuetext', `${percent}%`);
      m.style.left = `${(a.offset + (b.offset - a.offset) * (a.midpoint ?? 0.5)) * 100}%`;
      m.hidden = b.offset - a.offset < 0.02;
      m.classList.toggle('active', i === selected || i + 1 === selected);
    }
  };

  return {
    el,
    addStop,
    cancel() { gesture?.end(); },
    set(p, sel = selected) {
      paint = p;
      selected = Math.max(0, Math.min(sel, p.stops.length - 1));
      render();
    },
    get selected() {
      return selected;
    },
  };
}
