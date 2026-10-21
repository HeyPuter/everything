// View2D scrollers: thin scroll bars along the bottom (and right) of 2D views that show which part
// of the content is visible. Dragging a bar pans the view; dragging one of its ends zooms (the other
// end stays). They brighten while the pointer is near.
import { onAppReady } from '../app/app';
import { areaOfElement } from './screen';
import { view2dHost, type View2DHost } from './view2d';
import { scrollerGeometry } from './view2d_math';

interface Bars {
  el: HTMLElement;
  x: HTMLElement;
  y: HTMLElement;
  host: View2DHost;
}

const attached = new WeakMap<HTMLElement, Bars>();
/** End zones of a bar (pixels) that zoom instead of panning. */
const END_PX = 7;

function place(b: Bars) {
  const ext = b.host.extent?.();
  const r = b.host.el.getBoundingClientRect();
  const parent = b.el.parentElement?.getBoundingClientRect();
  if (!ext || !parent) return;
  b.el.style.left = `${r.left - parent.left}px`;
  b.el.style.top = `${r.top - parent.top}px`;
  b.el.style.width = `${r.width}px`;
  b.el.style.height = `${r.height}px`;
  const gx = ext.x ? scrollerGeometry(ext.x, r.width - 12) : null;
  b.x.style.display = gx ? '' : 'none';
  if (gx) Object.assign(b.x.style, { left: `${6 + gx.start}px`, width: `${Math.max(12, gx.size)}px` });
  const gy = ext.y ? scrollerGeometry(ext.y, r.height - 12) : null;
  b.y.style.display = gy && gy.size < r.height - 12 - 1 ? '' : 'none';
  if (gy) Object.assign(b.y.style, { top: `${6 + gy.start}px`, height: `${Math.max(12, gy.size)}px` });
}

function dragBar(b: Bars, axis: 'x' | 'y', e: PointerEvent) {
  e.preventDefault();
  e.stopPropagation();
  const bar = axis === 'x' ? b.x : b.y;
  const br = bar.getBoundingClientRect();
  const along = axis === 'x' ? e.clientX - br.left : e.clientY - br.top;
  const len = axis === 'x' ? br.width : br.height;
  const end = axis === 'x' && b.host.zoom ? (along < END_PX ? 'min' : along > len - END_PX ? 'max' : null) : null;
  let last = axis === 'x' ? e.clientX : e.clientY;
  const r = b.host.el.getBoundingClientRect();
  const move = (ev: PointerEvent) => {
    const ext = b.host.extent?.()?.[axis];
    if (!ext) return;
    const cur = axis === 'x' ? ev.clientX : ev.clientY;
    const d = cur - last;
    last = cur;
    const total = Math.max(ext[3], ext[1]) - Math.min(ext[2], ext[0]);
    const trackPx = (axis === 'x' ? r.width : r.height) - 12;
    const unitsPerPx = total / Math.max(1, trackPx);
    const viewUnits = ext[1] - ext[0];
    const contentPxPerUnit = (axis === 'x' ? r.width : r.height) / Math.max(1e-9, viewUnits);
    if (end && b.host.zoom) {
      // moving one end: the view grows or shrinks, the other end stays put
      const du = d * unitsPerPx;
      const nv = end === 'max' ? viewUnits + du : viewUnits - du;
      if (nv <= total * 0.002) return;
      const f = viewUnits / nv;
      b.host.zoom(f, 1, end === 'max' ? 0 : r.width, 0);
    } else {
      const shift = d * unitsPerPx * contentPxPerUnit;
      if (axis === 'x') b.host.pan(-shift, 0);
      else b.host.pan(0, -shift);
    }
    b.host.redraw?.();
    place(b);
  };
  const up = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    b.el.classList.remove('dragging');
  };
  b.el.classList.add('dragging');
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
}

function attach(host: View2DHost, redrawOwner: { draw?: () => void; redraw?: () => void }) {
  const parent = host.el.parentElement;
  if (!parent || attached.has(host.el)) return;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  const el = document.createElement('div');
  el.className = 'v2d-scrollers';
  const x = document.createElement('div');
  x.className = 'v2d-scroller x';
  const y = document.createElement('div');
  y.className = 'v2d-scroller y';
  el.append(x, y);
  parent.append(el);
  const b: Bars = { el, x, y, host };
  attached.set(host.el, b);
  x.addEventListener('pointerdown', (e) => e.button === 0 && dragBar(b, 'x', e));
  y.addEventListener('pointerdown', (e) => e.button === 0 && dragBar(b, 'y', e));
  // follow the editor's own redraws (pan / zoom by its handlers)
  for (const k of ['draw', 'redraw'] as const) {
    const fn = redrawOwner[k];
    if (typeof fn !== 'function') continue;
    redrawOwner[k] = function (this: unknown, ...args: unknown[]) {
      const r = (fn as (...a: unknown[]) => unknown).apply(redrawOwner, args);
      if (b.el.isConnected) place(b);
      return r;
    } as () => void;
  }
  new ResizeObserver(() => b.el.isConnected && place(b)).observe(host.el);
  place(b);
}

/** Give every 2D view on screen its scrollers. */
function ensureScrollers() {
  for (const el of document.querySelectorAll<HTMLElement>('.area')) {
    const area = areaOfElement.get(el);
    if (!area) continue;
    const host = view2dHost(area);
    if (!host || host.kind !== 'canvas' || !host.extent || !host.el.isConnected) continue;
    attach(host, area.editor as { draw?: () => void; redraw?: () => void });
  }
}

onAppReady((a) => {
  a.subscribe(() => requestAnimationFrame(ensureScrollers));
  requestAnimationFrame(ensureScrollers);
});
