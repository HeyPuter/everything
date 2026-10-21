// Interactive Stitch (V in the UV menu / Alt V): a live preview of where the selected UVs end up,
// with keys to change the options before confirming. Confirming runs uv.stitch with the chosen
// options, so they can still be adjusted afterwards.
import { app, type OpContext } from '../../app/app';
import { UVTopo, selReader } from './uvcore';
import { stitch, type StitchOptions } from './uvalgo';
import { uvLayers, ctxUVEditor } from './uvcontext';

/** Faces (UV polygons) moved by a stitch preview, per edited mesh. */
export interface StitchPreview {
  polys: number[][];
  groups: number;
}

/** Run the stitch on copies of the UVs and collect the faces it moves. */
export function stitchPreview(o: StitchOptions): StitchPreview {
  const polys: number[][] = [];
  let groups = 0;
  for (const layer of uvLayers()) {
    const t = new UVTopo(layer);
    const before = layer.me.uvs as Float32Array;
    const uvs = new Float32Array(before);
    const r = stitch(t, uvs, selReader(layer), o);
    groups += r.groups;
    if (!r.groups) continue;
    const me = layer.me;
    for (const f of layer.faces) {
      let moved = false;
      for (let c = me.offsets[f]; c < me.offsets[f + 1] && !moved; c++) moved = uvs[c * 2] !== before[c * 2] || uvs[c * 2 + 1] !== before[c * 2 + 1];
      if (!moved) continue;
      const poly: number[] = [];
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) poly.push(uvs[c * 2], uvs[c * 2 + 1]);
      polys.push(poly);
    }
  }
  return { polys, groups };
}

interface StitchView {
  stitchPreview: StitchPreview | null;
  draw(): void;
}

/** Modal stitch with a preview: S snap islands, M midpoint, L limit, I static island, Tab vertex / edge. */
export function startStitch(ctx: OpContext, p: Record<string, unknown>): 'RUNNING_MODAL' | 'CANCELLED' {
  const view = ctxUVEditor(ctx) as unknown as StitchView | null;
  if (!view) return 'CANCELLED';
  const o: StitchOptions = {
    mode: (p.mode as 'VERTEX') ?? 'VERTEX',
    snap_islands: p.snap_islands !== false,
    midpoint_snap: !!p.midpoint_snap,
    use_limit: !!p.use_limit,
    limit: Number(p.limit) || 0.01,
    static_island: Number(p.static_island) || 0,
    clear_seams: p.clear_seams !== false,
  };
  const area = ctx.area;
  const refresh = () => {
    view.stitchPreview = stitchPreview(o);
    view.draw();
  };
  refresh();
  const end = () => {
    view.stitchPreview = null;
    view.draw();
  };
  let confirmed = false;
  app.startModal({
    label: 'Stitch',
    header: () =>
      `Stitch: ${view.stitchPreview?.groups ?? 0} group(s) · Snap Islands (S): ${o.snap_islands ? 'On' : 'Off'} · Midpoint (M): ${o.midpoint_snap ? 'On' : 'Off'} · Limit (L): ${o.use_limit ? o.limit.toFixed(3) : 'Off'} · Static Island (I): ${o.static_island} · Mode (Tab): ${o.mode === 'EDGE' ? 'Edge' : 'Vertex'}`,
    status: () => [
      ['LMB / Enter', 'Confirm'],
      ['RMB / Esc', 'Cancel'],
      ['S M L I Tab', 'Options'],
      ['Wheel', 'Limit'],
    ],
    onPointerDown: (e) => (e.button === 0 ? ((confirmed = true), 'CANCELLED') : e.button === 2 ? 'CANCELLED' : undefined),
    onWheel(e) {
      if (!o.use_limit) return;
      o.limit = Math.max(0.0001, o.limit * (e.deltaY > 0 ? 1 / 1.2 : 1.2));
      refresh();
    },
    onKey(e) {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter' || e.key === ' ') {
        confirmed = true;
        return 'CANCELLED';
      }
      if (k === 's') o.snap_islands = !o.snap_islands;
      else if (k === 'm') o.midpoint_snap = !o.midpoint_snap;
      else if (k === 'l') o.use_limit = !o.use_limit;
      else if (k === 'i') o.static_island = (o.static_island + 1) % 8;
      else if (e.key === 'Tab') o.mode = o.mode === 'EDGE' ? 'VERTEX' : 'EDGE';
      else if ((e.key === '+' || e.key === '=') && o.use_limit) o.limit *= 1.2;
      else if (e.key === '-' && o.use_limit) o.limit /= 1.2;
      else return true;
      refresh();
      return true;
    },
    cancel() {
      end();
      // confirming runs the operator itself, so the result has an undo step and an adjust panel
      if (confirmed) queueMicrotask(() => app.run('uv.stitch', { ...o }, { invoke: false, area }));
    },
  });
  return 'RUNNING_MODAL';
}
