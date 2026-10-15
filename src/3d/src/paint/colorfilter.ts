// Sculpt ▸ Color Filter: adjust the color attribute of the whole (unmasked, visible) mesh —
// fill, hue, saturation, value, brightness, contrast, smooth or a single channel — with the
// strength set by dragging (tool and menu) or applied at once (Ctrl X fills with the brush color).
import { app, registerOperators } from '../app/app';
import { cow } from '../data/cow';
import type { ColorAttribute, MeshData } from '../data/types';
import { h, type Child } from '../ui/h';
import { colorSwatch, enumMenu, numberField } from '../ui/widgets';
import { toolSettingsRenderers } from '../editors/view3d/toolbar';
import { activeView3D } from '../editors/view3d/view3d';
import { activeMeshData, beginGeometryStroke, meshSession, reevaluate, type MeshSession } from './session';
import { ensureColorAttribute, gpuColors, vertexColors, writeVertex } from './vpaint';
import { hsvToRgb, rgbToHsv } from './paintmath';
import { sculptPoll } from './facesetops';
import { sculptToolHooks } from './sculpttools';

export const COLOR_FILTERS: [string, string, string][] = [
  ['FILL', 'Fill', 'Fill with a color'],
  ['HUE', 'Hue', 'Shift the hue'],
  ['SATURATION', 'Saturation', 'Change the saturation'],
  ['VALUE', 'Value', 'Change the value'],
  ['BRIGHTNESS', 'Brightness', 'Change the brightness'],
  ['CONTRAST', 'Contrast', 'Change the contrast'],
  ['SMOOTH', 'Smooth', 'Smooth the colors'],
  ['RED', 'Red', 'Change the red channel'],
  ['GREEN', 'Green', 'Change the green channel'],
  ['BLUE', 'Blue', 'Change the blue channel'],
];

/** New per-vertex RGBA colors for a filter (pure; `factor` already includes mask / visibility). */
export function colorFilter(orig: Float32Array, type: string, strength: number, factor: Float32Array, fill: number[], nb?: { offsets: Uint32Array; neighbors: Uint32Array }): Float32Array {
  const out = orig.slice();
  const nv = orig.length / 4;
  const cl = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  if (type === 'SMOOTH' && nb) {
    let cur = orig;
    const steps = Math.max(1, Math.ceil(Math.abs(strength) * 4));
    const k = Math.max(-1, Math.min(1, strength / steps));
    for (let it = 0; it < steps; it++) {
      const next = cur.slice();
      for (let v = 0; v < nv; v++) {
        const f = factor[v] * k;
        if (!f) continue;
        const a = nb.offsets[v],
          b = nb.offsets[v + 1];
        if (a === b) continue;
        for (let c = 0; c < 4; c++) {
          let s = 0;
          for (let j = a; j < b; j++) s += cur[nb.neighbors[j] * 4 + c];
          next[v * 4 + c] = cl(cur[v * 4 + c] + (s / (b - a) - cur[v * 4 + c]) * f);
        }
      }
      cur = next;
    }
    return cur;
  }
  for (let v = 0; v < nv; v++) {
    const f = factor[v] * strength;
    if (!f) continue;
    const i = v * 4;
    let r = orig[i],
      g = orig[i + 1],
      b = orig[i + 2];
    switch (type) {
      case 'FILL': {
        const t = cl(f);
        r += (fill[0] - r) * t;
        g += (fill[1] - g) * t;
        b += (fill[2] - b) * t;
        break;
      }
      case 'HUE':
      case 'SATURATION':
      case 'VALUE': {
        let [hh, s, vv] = rgbToHsv(cl(r), cl(g), cl(b));
        if (type === 'HUE') hh = (((hh + f * 0.5) % 1) + 1) % 1;
        else if (type === 'SATURATION') s = cl(s * (1 + f));
        else vv = cl(vv * (1 + f));
        [r, g, b] = hsvToRgb(hh, s, vv);
        break;
      }
      case 'BRIGHTNESS':
        r += f * 0.5;
        g += f * 0.5;
        b += f * 0.5;
        break;
      case 'CONTRAST': {
        const k = 1 + f;
        r = (r - 0.5) * k + 0.5;
        g = (g - 0.5) * k + 0.5;
        b = (b - 0.5) * k + 0.5;
        break;
      }
      case 'RED':
        r += f * 0.5;
        break;
      case 'GREEN':
        g += f * 0.5;
        break;
      case 'BLUE':
        b += f * 0.5;
        break;
    }
    out[i] = cl(r);
    out[i + 1] = cl(g);
    out[i + 2] = cl(b);
  }
  return out;
}

interface FilterCtx {
  s: MeshSession;
  me: MeshData;
  a: ColorAttribute;
  orig: Float32Array;
  factor: Float32Array;
}

function prepare(): FilterCtx | null {
  const am = activeMeshData();
  const s = meshSession();
  if (!am || !s) return null;
  const { me } = am;
  const a0 = ensureColorAttribute(me);
  const idx = me.color_attributes.indexOf(a0);
  beginGeometryStroke(s, me, () => cow(me.color_attributes[idx], 'data'));
  const a = me.color_attributes[idx];
  const orig = vertexColors(me, a).slice();
  const mask = me.sculpt_mask && me.sculpt_mask.length === s.nv ? me.sculpt_mask : null;
  const factor = new Float32Array(s.nv);
  for (let v = 0; v < s.nv; v++) factor[v] = s.hiddenV?.[v] ? 0 : 1 - (mask ? mask[v] : 0);
  return { s, me, a, orig, factor };
}

function write(c: FilterCtx, cols: Float32Array) {
  const gpu = gpuColors(c.s);
  for (let v = 0; v < c.s.nv; v++) writeVertex(c.s, c.a, v, cols.subarray(v * 4, v * 4 + 4), gpu);
  if (c.s.direct && gpu) c.s.flush();
  else reevaluate(c.s);
}

const run = (c: FilterCtx, p: Record<string, unknown>) => colorFilter(c.orig, p.type as string, p.strength as number, c.factor, p.fill_color as number[], p.type === 'SMOOTH' ? c.s.neighbors : undefined);

function startFilter(p: Record<string, unknown>, start?: PointerEvent): 'RUNNING_MODAL' | 'CANCELLED' {
  const c = prepare();
  if (!c || app.modal) return 'CANCELLED';
  const x0 = start ? start.clientX : app.pointer.x;
  const scale = (p.strength as number) || 1;
  app.startModal({
    label: 'Filter Color',
    cursor: 'ew-resize',
    onPointerMove: (e) => {
      p.strength = Math.round(((e.clientX - x0) / 200) * scale * 1000) / 1000;
      write(c, run(c, p));
    },
    onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : start ? undefined : 'FINISHED'),
    onPointerUp: (e) => (start && e.button === 0 ? 'FINISHED' : undefined),
    onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' ? 'FINISHED' : true),
    cancel: () => write(c, c.orig),
    finish: () => c.s.finishGeometry(),
    header: () => `Color Filter (${COLOR_FILTERS.find((f) => f[0] === p.type)?.[1]}): move left / right for the strength ${(p.strength as number).toFixed(3)}, click to apply`,
    redoOp: { idname: 'sculpt.color_filter', props: p },
  });
  return 'RUNNING_MODAL';
}

registerOperators([
  {
    idname: 'sculpt.color_filter',
    label: 'Filter Color',
    description: 'Adjust the colors of the whole unmasked mesh',
    props: [
      { id: 'type', label: 'Filter Type', type: 'enum', default: 'FILL', items: COLOR_FILTERS },
      { id: 'strength', label: 'Strength', type: 'float', default: 1, min: -10, max: 10, softMin: -1, softMax: 1 },
      { id: 'fill_color', label: 'Fill Color', type: 'color', default: [1, 1, 1], showIf: (p) => p.type === 'FILL' },
      { id: 'use_immediate', label: 'Immediate', type: 'bool', default: false, hidden: true },
    ],
    poll: sculptPoll,
    invoke: (_c, p) => {
      if (p.type === 'FILL') p.fill_color = [...app.doc.scene.tool_settings.unified_paint.color];
      if (p.use_immediate) {
        const c = prepare();
        if (!c) return 'CANCELLED';
        write(c, run(c, p));
        c.s.finishGeometry();
        return 'FINISHED';
      }
      return startFilter(p);
    },
    exec: (_c, p) => {
      const c = prepare();
      if (!c) return 'CANCELLED';
      write(c, run(c, p));
      c.s.finishGeometry();
    },
  },
]);

// ---------------------------------------------------------------------------
// tool

export const colorFilterTool = { id: 'builtin.color_filter', label: 'Color Filter', icon: 'color_filter', description: 'Adjust the colors of the mesh: drag left / right to set the strength (Ctrl: secondary fill color)' };
const settings = { type: 'FILL', strength: 1 };

sculptToolHooks.pointer.push((v, e, tool) => {
  if (tool !== colorFilterTool.id) return false;
  if (v.shading.type === 'SOLID' && v.shading.color_type !== 'VERTEX') v.shading.color_type = 'VERTEX';
  const up = app.doc.scene.tool_settings.unified_paint;
  startFilter({ type: settings.type, strength: settings.strength, fill_color: [...(e.ctrlKey || e.metaKey ? up.secondary_color : up.color)], use_immediate: false }, e);
  return true;
});

toolSettingsRenderers[colorFilterTool.id] = (): Child => {
  const up = app.doc.scene.tool_settings.unified_paint;
  const box = (w: number, c: Child) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c);
  return [
    box(130, enumMenu('th-cf-type', COLOR_FILTERS.map(([value, label]) => ({ value, label })), settings.type, (x) => ((settings.type = x), app.changed('ui')), { tip: 'Filter type' })),
    settings.type === 'FILL' ? box(44, colorSwatch('th-cf-col', up.color, (c) => ((up.color = [c[0], c[1], c[2]]), app.changed('ui')))) : null,
    box(140, numberField({ id: 'th-cf-str', label: 'Strength', value: settings.strength, min: -10, max: 10, softMin: -2, softMax: 2, tip: 'Multiplier for the drag distance', set: (x) => ((settings.strength = x), app.changed('ui')) })),
    h('span', { class: 'th-label' }, 'Drag left / right'),
  ];
};
void activeView3D;
