// Vertex Paint mode for grease pencil: paint the color attribute of stroke points and fills with
// the Draw, Blur, Average, Smear and Replace brushes, and the Paint menu color operators
// (set, reset, invert, levels, hue / saturation / value, brightness / contrast).
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators, type PropDef } from '../app/app';
import { activeTools } from '../app/prefs';
import { addKeys } from '../app/keymap';
import { editModeHooks } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import { extraToolLists, toolSettingsRenderers, type ToolDef } from '../editors/view3d/toolbar';
import { modeMenus } from '../editors/view3d/modemenus';
import { runStroke } from '../paint/stroke';
import { h } from '../ui/h';
import { colorSwatch, enumMenu, numberField } from '../ui/widgets';
import type { MenuItem } from '../ui/menu';
import { gpOf, gpBrush, frameAt, normalizeDrawing } from './data';
import { editableDrawing } from './paint';
import { layerMatrix } from './render';
import { brushFalloff } from './sculpt';
import { activeLayerMenu, animationMenu, showHideMenu } from './menus';
import { placementControls, sizeField, strengthField } from './ui';
import type { GPBrush, GPDrawing, GPLayer } from './types';

export const inVertexPaint = () => app.doc.mode === 'VERTEX_GREASE_PENCIL' && !!gpOf(app.doc, app.activeObject);

export const VERTEX_TOOLS: ToolDef[] = [
  { id: 'builtin.brush.VertexDraw', label: 'Draw', icon: 'gp_vertex_draw', description: 'Paint the brush color onto points and fills (Ctrl: remove color)' },
  { id: 'builtin.brush.VertexBlur', label: 'Blur', icon: 'gp_vertex_blur', description: 'Soften the colors under the brush' },
  { id: 'builtin.brush.VertexAverage', label: 'Average', icon: 'gp_vertex_average', description: 'Pull the colors under the brush toward their average' },
  { id: 'builtin.brush.VertexSmear', label: 'Smear', icon: 'gp_vertex_smear', description: 'Drag the colors along the brush stroke' },
  { id: 'builtin.brush.VertexReplace', label: 'Replace', icon: 'gp_vertex_replace', description: 'Replace the color of already painted points' },
];
extraToolLists.VERTEX_GREASE_PENCIL = () => VERTEX_TOOLS;

const DEFAULTS: Record<string, Partial<GPBrush>> = {
  'builtin.brush.VertexDraw': { size: 40, strength: 0.6, use_pressure_strength: true, vertex_mode: 'BOTH', color: [1, 0.25, 0.1], secondary_color: [1, 1, 1] },
  'builtin.brush.VertexBlur': { size: 40, strength: 0.6, use_pressure_strength: true, vertex_mode: 'BOTH' },
  'builtin.brush.VertexAverage': { size: 40, strength: 0.6, use_pressure_strength: true, vertex_mode: 'BOTH' },
  'builtin.brush.VertexSmear': { size: 40, strength: 0.6, use_pressure_strength: true, vertex_mode: 'BOTH' },
  'builtin.brush.VertexReplace': { size: 40, strength: 1, use_pressure_strength: false, vertex_mode: 'BOTH', color: [1, 0.25, 0.1], secondary_color: [1, 1, 1] },
};
function brush(tool: string): GPBrush {
  const b = gpBrush(app.doc, tool);
  for (const [k, v] of Object.entries(DEFAULTS[tool] ?? {})) (b as unknown as Record<string, unknown>)[k] ??= structuredClone(v);
  return b;
}

// ---------------------------------------------------------------------------
// painting

interface Target {
  layer: GPLayer;
  idx: number | null;
  world: Matrix4;
}

function startVertexPaint(v: View3D, e: PointerEvent) {
  const ob = app.activeObject!;
  const gp = gpOf(app.doc, ob)!;
  const tool = activeTools[app.doc.mode] ?? 'builtin.brush.VertexDraw';
  const b = brush(tool);
  const R = b.size / 2;
  const frame = app.doc.scene.frame_current;
  const obWorld = app.graph.get(ob.id)?.world ?? new Matrix4();
  const erase = e.ctrlKey && tool === 'builtin.brush.VertexDraw';
  const targets: Target[] = gp.layers.filter((l) => !l.lock && !l.hide && frameAt(l, frame)).map((l) => ({ layer: l, idx: null, world: obWorld.clone().multiply(layerMatrix(l)) }));
  const p = new Vector3();
  let changed = false;
  let last = v.local(e);
  // smear: colors picked up at the previous dab
  const drawingOf = (t: Target): GPDrawing => normalizeDrawing(gp.drawings[t.idx ?? frameAt(t.layer, frame)!.drawing]);
  const own = (t: Target): GPDrawing => {
    if (t.idx === null) {
      t.idx = editableDrawing(gp, t.layer, frame, true);
      const d = normalizeDrawing(gp.drawings[t.idx]);
      gp.drawings[t.idx] = { ...d, vertex_color: d.vertex_color.slice(), fill_color: d.fill_color.slice() };
    }
    return gp.drawings[t.idx];
  };
  const mode = b.vertex_mode ?? 'BOTH';
  const col = b.color ?? [1, 1, 1];
  runStroke(v, e, {
    spacing: () => 15,
    radiusPx: () => R,
    dab: (dab) => {
      const s0 = b.strength * (b.use_pressure_strength ? dab.pressure : 1);
      const dx = dab.x - last.x,
        dy = dab.y - last.y;
      for (const t of targets) {
        const src = drawingOf(t);
        const n = src.position.length / 3;
        const hits: { i: number; f: number; sx: number; sy: number }[] = [];
        for (let i = 0; i < n; i++) {
          p.set(src.position[i * 3], src.position[i * 3 + 1], src.position[i * 3 + 2]).applyMatrix4(t.world);
          const s = v.project(p);
          const f = brushFalloff(Math.hypot(s.x - dab.x, s.y - dab.y) / R);
          if (f > 0) hits.push({ i, f, sx: s.x, sy: s.y });
        }
        if (!hits.length) continue;
        const d = own(t);
        changed = true;
        const vc = d.vertex_color;
        const strokeOf = (i: number) => {
          let lo = 0,
            hi = d.offsets.length - 2;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (d.offsets[mid] <= i) lo = mid;
            else hi = mid - 1;
          }
          return lo;
        };
        // reference colors for blur / average
        const avg = [0, 0, 0, 0];
        let wsum = 0;
        for (const { i, f } of hits) {
          for (let k = 0; k < 4; k++) avg[k] += vc[i * 4 + k] * f;
          wsum += f;
        }
        if (wsum > 0) for (let k = 0; k < 4; k++) avg[k] /= wsum;
        const before = vc.slice();
        const strokes = new Set<number>();
        for (const { i, f, sx, sy } of hits) {
          strokes.add(strokeOf(i));
          if (mode === 'FILL') continue;
          const k = Math.min(1, s0 * f * 0.35);
          switch (tool) {
            case 'builtin.brush.VertexDraw':
              if (erase) vc[i * 4 + 3] = Math.max(0, vc[i * 4 + 3] - k);
              else {
                for (let c = 0; c < 3; c++) vc[i * 4 + c] += (col[c] - vc[i * 4 + c]) * k;
                vc[i * 4 + 3] += (1 - vc[i * 4 + 3]) * k;
              }
              break;
            case 'builtin.brush.VertexReplace':
              if (vc[i * 4 + 3] > 0) for (let c = 0; c < 3; c++) vc[i * 4 + c] = col[c];
              break;
            case 'builtin.brush.VertexAverage':
              for (let c = 0; c < 4; c++) vc[i * 4 + c] += (avg[c] - vc[i * 4 + c]) * k;
              break;
            case 'builtin.brush.VertexBlur': {
              // neighbours along the stroke
              const s = strokeOf(i);
              const a = Math.max(d.offsets[s], i - 1),
                z = Math.min(d.offsets[s + 1] - 1, i + 1);
              for (let c = 0; c < 4; c++) vc[i * 4 + c] += ((before[a * 4 + c] + before[z * 4 + c] + before[i * 4 + c]) / 3 - vc[i * 4 + c]) * k * 2;
              break;
            }
            case 'builtin.brush.VertexSmear': {
              // take the color from the point behind in the drag direction
              let best = -1,
                bd = Infinity;
              for (const o of hits) {
                const dd = Math.hypot(o.sx - (sx - dx), o.sy - (sy - dy));
                if (dd < bd) [bd, best] = [dd, o.i];
              }
              if (best >= 0) for (let c = 0; c < 4; c++) vc[i * 4 + c] += (before[best * 4 + c] - vc[i * 4 + c]) * k * 2;
              break;
            }
          }
        }
        if (mode !== 'STROKE')
          for (const s of strokes) {
            const fc = d.fill_color;
            const k = Math.min(1, s0 * 0.2);
            if (tool === 'builtin.brush.VertexDraw') {
              if (erase) fc[s * 4 + 3] = Math.max(0, fc[s * 4 + 3] - k);
              else {
                for (let c = 0; c < 3; c++) fc[s * 4 + c] += (col[c] - fc[s * 4 + c]) * k;
                fc[s * 4 + 3] += (1 - fc[s * 4 + 3]) * k;
              }
            } else if (tool === 'builtin.brush.VertexReplace' && fc[s * 4 + 3] > 0) for (let c = 0; c < 3; c++) fc[s * 4 + c] = col[c];
            else if (tool === 'builtin.brush.VertexAverage') for (let c = 0; c < 4; c++) fc[s * 4 + c] += (avg[c] - fc[s * 4 + c]) * k;
          }
      }
      last = { x: dab.x, y: dab.y };
    },
    update: () => {
      // new array identities so the GPU cache rebuilds
      for (const t of targets)
        if (t.idx !== null) {
          const d = gp.drawings[t.idx];
          gp.drawings[t.idx] = { ...d, vertex_color: d.vertex_color.slice(), fill_color: d.fill_color.slice() };
        }
      if (changed) app.changed('doc');
    },
    end: () => {
      if (changed) app.pushUndo('Grease Pencil Paint Vertex');
    },
  });
}

editModeHooks.pointer.unshift((v, e) => {
  if (!inVertexPaint() || e.button !== 0) return false;
  startVertexPaint(v, e);
  return true;
});

// ---------------------------------------------------------------------------
// color operators (all editable strokes at the current frame)

type RGBA = [number, number, number, number];

/** Apply `fn` to every shown color (stroke points and / or fills) of the editable drawings. */
function eachColor(mode: string, fn: (c: RGBA) => RGBA): boolean {
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  if (!ob || !gp) return false;
  const frame = app.doc.scene.frame_current;
  let any = false;
  for (const l of gp.layers) {
    if (l.lock || l.hide || !frameAt(l, frame)) continue;
    const idx = editableDrawing(gp, l, frame, true);
    const d = normalizeDrawing(gp.drawings[idx]);
    const vc = d.vertex_color.slice(),
      fc = d.fill_color.slice();
    const map = (arr: Float32Array, i: number) => {
      const r = fn([arr[i * 4], arr[i * 4 + 1], arr[i * 4 + 2], arr[i * 4 + 3]]);
      arr.set(r, i * 4);
    };
    if (mode !== 'FILL') for (let i = 0; i < vc.length / 4; i++) map(vc, i);
    if (mode !== 'STROKE') for (let i = 0; i < fc.length / 4; i++) map(fc, i);
    gp.drawings[idx] = { ...d, vertex_color: vc, fill_color: fc };
    any = true;
  }
  return any;
}

const modeProp: PropDef = {
  id: 'mode',
  label: 'Mode',
  type: 'enum',
  default: 'BOTH',
  items: [
    ['STROKE', 'Stroke', 'Change the stroke colors'],
    ['FILL', 'Fill', 'Change the fill colors'],
    ['BOTH', 'Stroke & Fill', 'Change both'],
  ],
};
const pollPaintable = () => !!gpOf(app.doc, app.activeObject) && (app.doc.mode === 'VERTEX_GREASE_PENCIL' || app.doc.mode === 'PAINT_GREASE_PENCIL' || app.doc.mode === 'EDIT');
const clamp = (x: number) => Math.max(0, Math.min(1, x));
/** only colors that are painted (alpha > 0) are adjusted */
const painted = (fn: (c: RGBA) => RGBA) => (c: RGBA): RGBA => (c[3] > 0 ? fn(c) : c);

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  let hh = 0;
  if (d > 1e-9) hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((hh / 6) % 1 + 1) % 1, mx > 0 ? d / mx : 0, mx];
}
function hsvToRgb(hh: number, s: number, v: number): [number, number, number] {
  const k = (n: number) => (n + hh * 6) % 6;
  const f = (n: number) => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [f(5), f(3), f(1)];
}

registerOperators([
  {
    idname: 'grease_pencil.vertex_color_set',
    label: 'Vertex Paint Set Color',
    description: 'Paint every point / fill with the brush color',
    props: [modeProp, { id: 'factor', label: 'Factor', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' }],
    poll: pollPaintable,
    exec: (_c, p) => {
      const col = brush('builtin.brush.VertexDraw').color ?? [1, 1, 1];
      const f = p.factor as number;
      if (!eachColor(p.mode as string, (c) => [c[0] + (col[0] - c[0]) * f, c[1] + (col[1] - c[1]) * f, c[2] + (col[2] - c[2]) * f, c[3] + (1 - c[3]) * f])) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.stroke_reset_vertex_color',
    label: 'Reset Vertex Color',
    description: 'Remove the painted colors so the material colors show again',
    props: [modeProp],
    poll: pollPaintable,
    exec: (_c, p) => {
      if (!eachColor(p.mode as string, () => [0, 0, 0, 0])) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.vertex_color_invert',
    label: 'Vertex Paint Invert',
    description: 'Invert the painted colors',
    props: [modeProp],
    poll: pollPaintable,
    exec: (_c, p) => {
      if (!eachColor(p.mode as string, painted((c) => [1 - c[0], 1 - c[1], 1 - c[2], c[3]]))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.vertex_color_levels',
    label: 'Vertex Paint Levels',
    description: 'Scale and offset the painted colors',
    props: [modeProp, { id: 'offset', label: 'Offset', type: 'float', default: 0, min: -1, max: 1 }, { id: 'gain', label: 'Gain', type: 'float', default: 1, min: 0, max: 10 }],
    poll: pollPaintable,
    exec: (_c, p) => {
      const o = p.offset as number,
        g = p.gain as number;
      if (!eachColor(p.mode as string, painted((c) => [clamp(c[0] * g + o), clamp(c[1] * g + o), clamp(c[2] * g + o), c[3]]))) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.vertex_color_hsv',
    label: 'Vertex Paint Hue/Saturation/Value',
    description: 'Shift the hue and scale the saturation and value of the painted colors',
    props: [
      modeProp,
      { id: 'h', label: 'Hue', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 's', label: 'Saturation', type: 'float', default: 1, min: 0, max: 2 },
      { id: 'v', label: 'Value', type: 'float', default: 1, min: 0, max: 2 },
    ],
    poll: pollPaintable,
    exec: (_c, p) => {
      if (
        !eachColor(
          p.mode as string,
          painted((c) => {
            const [hh, s, v] = rgbToHsv(c[0], c[1], c[2]);
            const rgb = hsvToRgb((((hh + (p.h as number) - 0.5) % 1) + 1) % 1, clamp(s * (p.s as number)), clamp(v * (p.v as number)));
            return [rgb[0], rgb[1], rgb[2], c[3]];
          }),
        )
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.vertex_color_brightness_contrast',
    label: 'Vertex Paint Brightness/Contrast',
    description: 'Change the brightness and contrast of the painted colors',
    props: [modeProp, { id: 'brightness', label: 'Brightness', type: 'float', default: 0, min: -1, max: 1 }, { id: 'contrast', label: 'Contrast', type: 'float', default: 0, min: -1, max: 1 }],
    poll: pollPaintable,
    exec: (_c, p) => {
      const b = p.brightness as number,
        k = Math.tan(((p.contrast as number) + 1) * (Math.PI / 4));
      if (!eachColor(p.mode as string, painted((c) => [clamp((c[0] - 0.5) * k + 0.5 + b), clamp((c[1] - 0.5) * k + 0.5 + b), clamp((c[2] - 0.5) * k + 0.5 + b), c[3]]))) return 'CANCELLED';
    },
  },
]);

// ---------------------------------------------------------------------------
// UI

function paintMenu(): MenuItem[] {
  return [
    { label: 'Set Color Attribute', op: 'grease_pencil.vertex_color_set' },
    { label: 'Reset Color Attribute', op: 'grease_pencil.stroke_reset_vertex_color' },
    { separator: true },
    { label: 'Invert', op: 'grease_pencil.vertex_color_invert' },
    { label: 'Levels', op: 'grease_pencil.vertex_color_levels' },
    { label: 'Hue/Saturation/Value', op: 'grease_pencil.vertex_color_hsv' },
    { label: 'Brightness/Contrast', op: 'grease_pencil.vertex_color_brightness_contrast' },
    { separator: true },
    { label: 'Sample Color', op: 'paint.sample_color', shortcut: 'Shift X' },
    { separator: true },
    { label: 'Active Layer', submenu: activeLayerMenu, shortcut: 'Y' },
    { label: 'Animation', submenu: animationMenu, shortcut: 'I' },
    { label: 'Show/Hide', submenu: showHideMenu },
  ];
}

modeMenus.VERTEX_GREASE_PENCIL = {
  header: () => [['Paint', paintMenu]],
  select: () => [],
  headerExtra: placementControls,
};

const refresh = () => app.changed('ui');
for (const t of VERTEX_TOOLS)
  toolSettingsRenderers[t.id] = () => {
    const b = brush(t.id);
    const colored = t.id === 'builtin.brush.VertexDraw' || t.id === 'builtin.brush.VertexReplace';
    return [
      colored ? h('div', { style: { width: '44px', flex: 'none' } }, colorSwatch(`gpv-col-${t.id}`, b.color ?? [1, 1, 1], (c) => ((b.color = [c[0], c[1], c[2]]), refresh()))) : null,
      colored
        ? h(
            'button',
            { class: 'hdr-toggle', 'data-tip': 'Swap Colors (X)\nSwap the brush color with the secondary color', onclick: () => app.run('paint.brush_colors_flip') },
            h('span', { style: { display: 'inline-block', width: '10px', height: '10px', border: '1px solid #000', background: `rgb(${(b.secondary_color ?? [1, 1, 1]).map((x) => Math.round(Math.pow(clamp(x), 1 / 2.2) * 255)).join(',')})` } }),
          )
        : null,
      h('div', { style: { width: '120px', flex: 'none' } }, sizeField(b, `gpv-size-${t.id}`, 'Radius')),
      h('div', { style: { width: '120px', flex: 'none' } }, strengthField(b, `gpv-str-${t.id}`)),
      h(
        'div',
        { style: { width: '100px', flex: 'none' } },
        enumMenu(
          `gpv-mode-${t.id}`,
          [
            { value: 'STROKE', label: 'Stroke' },
            { value: 'FILL', label: 'Fill' },
            { value: 'BOTH', label: 'Stroke & Fill' },
          ],
          b.vertex_mode ?? 'BOTH',
          (x) => ((b.vertex_mode = x as GPBrush['vertex_mode']), refresh()),
          { tip: 'Mode\nPaint strokes, fills or both' },
        ),
      ),
    ];
  };
void numberField;

const vp = () => inVertexPaint();
addKeys('Grease Pencil', [
  { key: 'F', op: 'grease_pencil.radial_control', props: { data: 'size' }, when: vp },
  { key: 'F', shift: true, op: 'grease_pencil.radial_control', props: { data: 'strength' }, when: vp },
  { key: 'X', op: 'paint.brush_colors_flip', when: vp },
  { key: 'X', shift: true, op: 'paint.sample_color', when: vp },
  { key: 'H', alt: true, op: 'grease_pencil.layer_reveal', when: vp },
  { key: 'H', op: 'grease_pencil.layer_hide', props: { unselected: false }, when: vp },
  { key: 'H', shift: true, op: 'grease_pencil.layer_hide', props: { unselected: true }, when: vp },
]);
