// UV packing targets: the user region (uv.custom_region_set, Ctrl B) that Pack Islands can fill,
// the UDIM tile under a point (uv.select_tile), and the pack target rectangle of each source.
import { app, registerOperators, type OpContext } from '../../app/app';
import { addKeys } from '../../app/keymap';
import type { ImageData } from '../../data/types';
import { normRegion } from './uvpackregion';
import { UVTopo, selReader } from './uvcore';
import { selBounds } from './uvalgo';
import { ctxUVEditor, uvCursor, uvEditPoll, type EditLayer } from './uvcontext';
import { selectByTest } from './uvops-select';

export { packRegion, tileNumber, type PackSource } from './uvpackregion';

/** Tool settings fields of the user region (kept on the scene's tool settings). */
interface RegionSettings {
  use_uv_custom_region?: boolean;
  /** [xmin, ymin, xmax, ymax] in UV units */
  uv_custom_region?: number[];
}
export const regionSettings = () => app.doc.scene.tool_settings as unknown as RegionSettings;

/** The user region as [x, y, width, height] (the 0–1 square when unset). */
export const customRegion = () => normRegion(regionSettings().uv_custom_region);

/** Bounds [u0, v0, u1, v1] of the selected UVs of the given layers, or null. */
export function selectionBounds(layers: EditLayer[]): [number, number, number, number] | null {
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity;
  for (const layer of layers) {
    const bb = selBounds(new UVTopo(layer), layer.me.uvs as Float32Array, selReader(layer));
    if (!bb) continue;
    a = Math.min(a, bb[0]);
    b = Math.min(b, bb[1]);
    c = Math.max(c, bb[2]);
    d = Math.max(d, bb[3]);
  }
  return a > c ? null : [a, b, c, d];
}

interface RegionView {
  el: HTMLElement;
  toUV(x: number, y: number): { u: number; v: number };
  draw(): void;
  image(): ImageData | null;
  regionDrag?: { x0: number; y0: number; x1: number; y1: number } | null;
}
const regionView = (ctx: OpContext) => ctxUVEditor(ctx) as unknown as RegionView | null;

registerOperators([
  {
    idname: 'uv.custom_region_set',
    label: 'Set User Region',
    description: 'Drag a rectangle that Pack Islands fills when packing into the custom region',
    props: [
      { id: 'xmin', label: 'X Min', type: 'int', default: 0, hidden: true },
      { id: 'xmax', label: 'X Max', type: 'int', default: 0, hidden: true },
      { id: 'ymin', label: 'Y Min', type: 'int', default: 0, hidden: true },
      { id: 'ymax', label: 'Y Max', type: 'int', default: 0, hidden: true },
      { id: 'wait_for_input', label: 'Wait for Input', type: 'bool', default: true, hidden: true },
    ],
    poll: (ctx) => !!regionView(ctx),
    invoke: (ctx) => {
      const view = regionView(ctx)!;
      const r = view.el.getBoundingClientRect();
      let start: { x: number; y: number } | null = null;
      const finish = (a: { x: number; y: number }, b: { x: number; y: number }) => {
        app.run('uv.custom_region_set', { xmin: Math.round(Math.min(a.x, b.x)), xmax: Math.round(Math.max(a.x, b.x)), ymin: Math.round(Math.min(a.y, b.y)), ymax: Math.round(Math.max(a.y, b.y)) }, { invoke: false, area: ctx.area });
      };
      app.startModal({
        label: 'Set User Region',
        cursor: 'crosshair',
        header: () => 'Set User Region: drag a rectangle, Esc / right click to cancel',
        onPointerDown(e) {
          if (e.button === 2) return 'CANCELLED';
          if (e.button !== 0) return undefined;
          start = { x: e.clientX - r.left, y: e.clientY - r.top };
          view.regionDrag = { x0: start.x, y0: start.y, x1: start.x, y1: start.y };
          view.draw();
          return undefined;
        },
        onPointerMove(e) {
          if (!start) return;
          view.regionDrag = { x0: start.x, y0: start.y, x1: e.clientX - r.left, y1: e.clientY - r.top };
          view.draw();
        },
        onPointerUp(e) {
          if (!start || e.button !== 0) return undefined;
          const end = { x: e.clientX - r.left, y: e.clientY - r.top };
          if (Math.abs(end.x - start.x) < 2 || Math.abs(end.y - start.y) < 2) return 'CANCELLED';
          view.regionDrag = null;
          queueMicrotask(() => finish(start!, end));
          return 'CANCELLED';
        },
        onKey(e) {
          if (e.type === 'keydown' && e.key === 'Escape') return 'CANCELLED';
          return true;
        },
        cancel() {
          view.regionDrag = null;
          view.draw();
        },
      });
      return 'RUNNING_MODAL';
    },
    exec: (ctx, p) => {
      const view = regionView(ctx);
      if (!view) return 'CANCELLED';
      const a = view.toUV(Number(p.xmin), Number(p.ymax)),
        b = view.toUV(Number(p.xmax), Number(p.ymin));
      if (Math.abs(b.u - a.u) < 1e-6 || Math.abs(b.v - a.v) < 1e-6) return 'CANCELLED';
      const ts = regionSettings();
      ts.uv_custom_region = [Math.min(a.u, b.u), Math.min(a.v, b.v), Math.max(a.u, b.u), Math.max(a.v, b.v)];
      ts.use_uv_custom_region = true;
      app.changed('ui');
      view.draw();
    },
  },
  {
    idname: 'uv.select_tile',
    label: 'Select Tile',
    description: 'Select the UVs inside one UDIM tile (the tile under the pointer, or the one with the 2D cursor)',
    props: [
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'tile', label: 'Tile', type: 'vec2', default: [0, 0] },
    ],
    poll: (ctx) => !!regionView(ctx) && uvEditPoll(),
    invoke: (ctx, p) => {
      const view = regionView(ctx)!;
      const ev = ctx.event ?? app.pointer;
      const r = view.el.getBoundingClientRect();
      const inside = ev.x >= r.left && ev.x <= r.right && ev.y >= r.top && ev.y <= r.bottom;
      const uv = inside ? view.toUV(ev.x - r.left, ev.y - r.top) : { u: uvCursor.u, v: uvCursor.v };
      return app.run('uv.select_tile', { ...p, tile: [Math.floor(uv.u), Math.floor(uv.v)] }, { invoke: false, area: ctx.area });
    },
    exec: (_ctx, p) => {
      const [u, v] = (p.tile as number[]).map((x) => Math.floor(Number(x) || 0));
      selectByTest((x, y) => x >= u && x < u + 1 && y >= v && y < v + 1, p.extend ? 'ADD' : 'SET');
    },
  },
]);

addKeys('UV Editor', [
  { key: 'B', ctrl: true, op: 'uv.custom_region_set' },
  {
    key: 'B',
    ctrl: true,
    alt: true,
    action: () => {
      const ts = regionSettings();
      ts.use_uv_custom_region = !ts.use_uv_custom_region;
      app.report('INFO', `Custom Region ${ts.use_uv_custom_region ? 'on' : 'off'}`);
      app.changed('ui');
    },
  },
]);

/** The user region outline (UV editor overlay) while Custom Region is on. */
export function drawCustomRegion(g: CanvasRenderingContext2D, toPx: (u: number, v: number) => { x: number; y: number }, drag: RegionView['regionDrag']) {
  g.save();
  g.setLineDash([6, 4]);
  g.lineWidth = 1.5;
  if (drag) {
    g.strokeStyle = '#ffffff';
    g.strokeRect(Math.min(drag.x0, drag.x1) + 0.5, Math.min(drag.y0, drag.y1) + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
  } else if (regionSettings().use_uv_custom_region) {
    const [x, y, w, h] = customRegion();
    const a = toPx(x, y + h),
      b = toPx(x + w, y);
    g.strokeStyle = 'rgba(255, 214, 102, 0.9)';
    g.fillStyle = 'rgba(255, 214, 102, 0.06)';
    g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
  }
  g.restore();
}

