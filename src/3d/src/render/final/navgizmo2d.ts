// Navigation buttons of the 2D media views (Image / UV / Movie Clip editors, sequencer preview):
// drag the magnifier to zoom, the hand to pan — handy without a middle mouse button.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { prefs } from '../../app/prefs';

/** What the buttons drive, in editor-local pixels. */
export interface Nav2DHost {
  el: HTMLElement;
  /** zoom by a factor around a local point (the view centre when omitted) */
  zoomAt(factor: number, x?: number, y?: number): void;
  panBy(dx: number, dy: number): void;
}

const css = `
.nav2d { position: absolute; top: 8px; display: flex; flex-direction: column; gap: 4px; z-index: 3; pointer-events: auto; }
.nav2d .nav-btn { background: rgba(30, 31, 33, 0.35); cursor: grab; }
.nav2d .nav-btn:active { cursor: grabbing; }
`;
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.append(el);
}

/** Drag on a button: zoom (up / right zooms in) or pan, until the button is released. */
function drag(host: Nav2DHost, e: PointerEvent, kind: 'zoom' | 'pan') {
  e.preventDefault();
  e.stopPropagation();
  let lx = e.clientX,
    ly = e.clientY;
  const r = host.el.getBoundingClientRect();
  const cx = r.width / 2,
    cy = r.height / 2;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - lx,
      dy = ev.clientY - ly;
    lx = ev.clientX;
    ly = ev.clientY;
    if (kind === 'zoom') host.zoomAt(Math.exp((dx - dy) * 0.01), cx, cy);
    else host.panBy(dx, dy);
  };
  const up = () => (removeEventListener('pointermove', move, true), removeEventListener('pointerup', up, true));
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
}

/** The zoom and pan buttons at the top right of a view (`right`: space taken by a sidebar). */
export function navGizmo2D(host: Nav2DHost, right = 0, show = true, top = 8): Child {
  if (!show || prefs.show_navigate_ui === false) return null;
  style();
  return h(
    'div',
    { key: 'nav2d', class: 'nav2d', style: `right: ${right + 8}px; top: ${top}px` },
    h('button', { class: 'nav-btn nav2d-zoom', 'data-tip': 'Zoom\nDrag up or right to zoom in, down or left to zoom out', onpointerdown: (e: PointerEvent) => drag(host, e, 'zoom') }, icon('view_zoom')),
    h('button', { class: 'nav-btn nav2d-pan', 'data-tip': 'Move\nDrag to pan the view', onpointerdown: (e: PointerEvent) => drag(host, e, 'pan') }, icon('view_pan')),
  );
}
