// Particle Edit mode UI: toolbar brushes and tool settings, select mode buttons (1 / 2 / 3),
// Select and Particle menus, context menu, options (preserve, deflect, display), the edit
// overlay (paths and keys, weights) and the "Particle" keymap.
import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, LineSegments, Points, ShaderMaterial } from 'three';
import { app } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { editModeHooks } from '../../editors/view3d/hooks';
import type { View3D } from '../../editors/view3d/view3d';
import { modeMenus } from '../../editors/view3d/modemenus';
import { extraToolLists, toolSettingsRenderers, type ToolDef } from '../../editors/view3d/toolbar';
import { toolOptionSections } from '../../editors/view3d/tooloptions';
import { drawHooks } from '../../editors/view3d/draw';
import { sceneSyncHooks, type SyncedObject } from '../../render/scene';
import { particleDrawFilter } from '../../physics/draw';
import { resampleKeys } from '../../physics/particles';
import type { EditedHair, ParticleSystemX } from '../../physics/types';
import { h, type Child, type VNode } from '../../ui/h';
import { icon } from '../../ui/icons';
import { checkbox, enumMenu, numberField } from '../../ui/widgets';
import { objectProp } from '../../ui/props';
import './shapecut';
import type { MenuItem } from '../../ui/menu';
import { hairBrushAccess, type HairBrushAccess } from '../sculptui';
import { PE_TOOLS, activePE, activePETool, inPE, peBrush, peSettings, type PESelectMode } from './mode';
import { startParticleStroke } from './brush';
import { strandCount } from './keys';

const refresh = () => app.changed('ui');
const field = (w: number, c: Child) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c);

// ---------------------------------------------------------------------------
// toolbar, tool settings, brush access

const SELECT: ToolDef[] = [
  { id: 'builtin.select_box', label: 'Select Box', icon: 'select_box', group: 'select', description: 'Select keys using box selection' },
  { id: 'builtin.select_circle', label: 'Select Circle', icon: 'select_circle', group: 'select', description: 'Select keys using circle selection' },
  { id: 'builtin.select_lasso', label: 'Select Lasso', icon: 'select_lasso', group: 'select', description: 'Select keys using lasso selection' },
];

extraToolLists.PARTICLE_EDIT = () => [{ ...SELECT[0], alternates: SELECT }, null, ...PE_TOOLS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, description: t.description }))];

hairBrushAccess.push((): HairBrushAccess | null => {
  if (!inPE() || !activePETool().startsWith('builtin.particle_')) return null;
  const b = peBrush(app.doc, activePETool());
  return { size: b.size, strength: b.strength, setSize: (v) => (b.size = v), setStrength: (v) => (b.strength = v) };
});

function settingsFor(tool: string): Child {
  if (!inPE()) return null;
  const b = peBrush(app.doc, tool);
  const set = (k: keyof typeof b) => (x: number) => {
    (b as unknown as Record<string, number>)[k] = k === 'size' || k === 'count' ? Math.round(x) : x;
    refresh();
  };
  const out: Child[] = [
    field(110, numberField({ id: 'pe-size', label: 'Radius', value: b.size, min: 1, max: 2000, softMax: 500, int: true, tip: 'Brush radius in pixels (F)', set: set('size') })),
    tool === 'builtin.particle_add' ? null : field(120, numberField({ id: 'pe-str', label: tool === 'builtin.particle_weight' ? 'Weight' : 'Strength', value: b.strength, min: 0, max: 1, slider: true, precision: 3, tip: tool === 'builtin.particle_weight' ? 'Weight painted onto the keys (Shift F)' : 'Brush strength (Shift F)', set: set('strength') })),
  ];
  const pe = peSettings(app.doc);
  if (tool === 'builtin.particle_add')
    out.push(
      field(100, numberField({ id: 'pe-count', label: 'Count', value: b.count ?? 10, min: 1, max: 1000, int: true, tip: 'Hairs added per step of the stroke', set: set('count') })),
      checkbox('pe-interp', 'Interpolate', pe.use_default_interpolate, (v) => ((pe.use_default_interpolate = v), refresh()), { tip: 'Shape new hair like the hair around it' }),
      field(100, numberField({ id: 'pe-keys', label: 'Steps', value: pe.default_key_count, min: 2, max: 50, int: true, tip: 'Keys of new hair (when not interpolated)', set: (x) => ((pe.default_key_count = Math.round(x)), refresh()) })),
    );
  if (tool === 'builtin.particle_length')
    out.push(
      field(
        110,
        enumMenu(
          'pe-lmode',
          [
            { value: 'GROW', label: 'Grow', description: 'Make hair longer' },
            { value: 'SHRINK', label: 'Shrink', description: 'Make hair shorter' },
          ],
          b.length_mode ?? 'GROW',
          (v) => ((b.length_mode = v as 'GROW' | 'SHRINK'), refresh()),
          { tip: 'Length mode (Ctrl inverts)' },
        ),
      ),
    );
  if (tool === 'builtin.particle_puff')
    out.push(
      field(
        110,
        enumMenu(
          'pe-pmode',
          [
            { value: 'ADD', label: 'Add', description: 'Make hair stand up' },
            { value: 'SUB', label: 'Sub', description: 'Make hair lie down' },
          ],
          b.puff_mode ?? 'ADD',
          (v) => ((b.puff_mode = v as 'ADD' | 'SUB'), refresh()),
          { tip: 'Puff mode (Ctrl inverts)' },
        ),
      ),
    );
  return out;
}

for (const t of PE_TOOLS) toolSettingsRenderers[t.id] = () => settingsFor(t.id);

// ---------------------------------------------------------------------------
// options (Options popover / sidebar)

toolOptionSections.push((idp) => {
  if (!inPE()) return null;
  const pe = peSettings(app.doc);
  const a = activePE();
  const tog = (key: 'use_preserve_length' | 'use_preserve_root' | 'use_emitter_deflect' | 'show_children', label: string, tip: string) =>
    checkbox(`${idp}-pe-${key}`, label, pe[key], (v) => {
      pe[key] = v;
      app.changed('ui', 'doc');
    }, { tip });
  return h(
    'div',
    { key: 'pe-opts' },
    h('div', { class: 'opt-head' }, 'Options'),
    tog('use_emitter_deflect', 'Deflect Emitter', 'Keep combed hair out of the emitter surface'),
    pe.use_emitter_deflect ? numberField({ id: `${idp}-pe-dist`, label: 'Distance', value: pe.emitter_distance, min: 0, unit: 'distance', set: (x) => ((pe.emitter_distance = x), refresh()) }) : null,
    h('div', { class: 'sub-label' }, 'Preserve'),
    tog('use_preserve_length', 'Strand Lengths', 'Combing keeps the length of the hair'),
    tog('use_preserve_root', 'Root Positions', 'Hair roots cannot be moved'),
    h('div', { class: 'sub-label' }, 'Cut Particles to Shape'),
    objectProp(pe as unknown as { shape_object: string | null }, 'shape_object', 'Shape Object', { filter: (o) => o.type === 'MESH' && o.id !== a?.ob.id, none: 'None' }),
    pe.shape_object ? h('button', { key: `${idp}-pe-cut`, class: 'btn', onclick: () => app.run('particle.shape_cut') }, 'Cut') : null,
    h('div', { class: 'opt-head' }, 'Viewport Display'),
    numberField({ id: `${idp}-pe-steps`, label: 'Path Steps', value: pe.display_step, min: 0, max: 10, int: true, tip: 'Smoothness of the drawn hair paths (powers of two)', set: (x) => ((pe.display_step = Math.round(x)), app.changed('ui', 'doc')) }),
    tog('show_children', 'Children', 'Also draw the child hair while editing'),
    a ? h('div', { class: 'prop-note' }, `${strandCount(a.ed)} hairs`) : null,
  );
});

// ---------------------------------------------------------------------------
// header

function selectModeButtons(): Child {
  if (!inPE()) return null;
  const mode = peSettings(app.doc).select_mode;
  const btn = (m: PESelectMode, ic: string, tip: string, key: string) =>
    h(
      'button',
      {
        key: m,
        class: { 'hdr-toggle': true, on: mode === m },
        'data-tip': `${tip} (${key})`,
        'data-pe-mode': m,
        onclick: () => setSelectMode(m),
      },
      icon(ic),
    );
  return h('div', { key: 'pe-modes', class: 'hdr-group select-modes', style: { flex: 'none' } }, btn('PATH', 'pe_path', 'Path\nEdit whole hairs', '1'), btn('POINT', 'pe_point', 'Point\nEdit every key', '2'), btn('TIP', 'pe_tip', 'Tip\nEdit hair tips only', '3'));
}

function setSelectMode(m: PESelectMode) {
  peSettings(app.doc).select_mode = m;
  app.changed('ui', 'doc');
}

function showHide(): MenuItem {
  return {
    label: 'Show/Hide',
    submenu: () => [
      { label: 'Reveal Hidden', op: 'particle.reveal', shortcut: 'Alt H' },
      { label: 'Hide Selected', op: 'particle.hide', props: { unselected: false }, shortcut: 'H' },
      { label: 'Hide Unselected', op: 'particle.hide', props: { unselected: true }, shortcut: 'Shift H' },
    ],
  };
}

function deleteMenu(): MenuItem[] {
  return [
    { label: 'Particles', op: 'particle.delete', props: { type: 'PARTICLE' } },
    { label: 'Keys', op: 'particle.delete', props: { type: 'KEY' } },
  ];
}

function particleMenu(): MenuItem[] {
  return [
    { label: 'Mirror', op: 'particle.mirror' },
    { label: 'Remove Doubles', op: 'particle.remove_doubles' },
    { separator: true },
    { label: 'Unify Length', op: 'particle.unify_length' },
    { label: 'Rekey', op: 'particle.rekey' },
    { label: 'Weight Set', op: 'particle.weight_set', shortcut: 'Shift K' },
    { separator: true },
    showHide(),
    { separator: true },
    { label: 'Delete', submenu: deleteMenu, shortcut: 'X' },
  ];
}

function contextMenu(): MenuItem[] {
  const mode = peSettings(app.doc).select_mode;
  return [
    { heading: 'Particle' },
    { label: 'Rekey', op: 'particle.rekey' },
    ...(mode === 'POINT' ? [{ label: 'Subdivide', op: 'particle.subdivide' } as MenuItem] : []),
    { separator: true },
    { label: 'Delete', submenu: deleteMenu },
    { separator: true },
    { label: 'Remove Doubles', op: 'particle.remove_doubles' },
    { label: 'Unify Length', op: 'particle.unify_length' },
    { label: 'Weight Set', op: 'particle.weight_set' },
    { separator: true },
    { label: 'Mirror', op: 'particle.mirror' },
    ...(mode !== 'PATH' ? [{ separator: true } as MenuItem, { label: 'Select Roots', op: 'particle.select_roots' } as MenuItem, { label: 'Select Tips', op: 'particle.select_tips' } as MenuItem] : []),
  ];
}

function selectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'particle.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'particle.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'particle.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
    { label: 'Circle Select', op: 'view3d.select_circle_tool', shortcut: 'C' },
    { separator: true },
    { label: 'Random', op: 'particle.select_random' },
    { separator: true },
    { label: 'More', op: 'particle.select_more', shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: 'particle.select_less', shortcut: 'Ctrl Numpad -' },
    { separator: true },
    { label: 'Select Linked', op: 'particle.select_linked', shortcut: 'Ctrl L' },
    { separator: true },
    { label: 'Roots', op: 'particle.select_roots' },
    { label: 'Tips', op: 'particle.select_tips' },
  ];
}

modeMenus.PARTICLE_EDIT = {
  headerLead: selectModeButtons,
  select: selectMenu,
  header: () => [['Particle', particleMenu]],
  context: contextMenu,
};

// ---------------------------------------------------------------------------
// pointer: brush strokes and cursor

const cursor = { x: 0, y: 0, view: null as View3D | null };

editModeHooks.pointer.unshift((v, e) => {
  if (!inPE() || e.button !== 0 || e.altKey) return false;
  const tool = activePETool();
  if (!tool.startsWith('builtin.particle_')) return false;
  startParticleStroke(v, e, tool, e.ctrlKey || e.metaKey);
  return true;
});

editModeHooks.hover.push((v, e) => {
  if (!inPE()) return;
  const p = v.local(e);
  Object.assign(cursor, { x: p.x, y: p.y, view: v });
  v.drawSvg();
});

editModeHooks.svg.push((v) => {
  if (!inPE() || cursor.view !== v || !activePETool().startsWith('builtin.particle_')) return null;
  const b = peBrush(app.doc, activePETool());
  return h(
    'g',
    { class: 'pe-cursor', 'pointer-events': 'none' },
    h('circle', { cx: cursor.x, cy: cursor.y, r: b.size, fill: 'none', stroke: 'rgba(0, 0, 0,0.35)', 'stroke-width': 3 }),
    h('circle', { cx: cursor.x, cy: cursor.y, r: b.size, fill: 'none', stroke: 'rgba(255, 255, 255,0.9)', 'stroke-width': 1.3 }),
  ) as VNode;
});

// ---------------------------------------------------------------------------
// edit overlay: paths and keys of the edited hair

const VS = /* glsl */ `
varying vec3 vColor;
uniform float uSize;
void main() { vColor = color; gl_PointSize = uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z -= 0.0005 * gl_Position.w; }`;
const FS_LINE = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;
const FS_POINT = /* glsl */ `
varying vec3 vColor;
void main() { vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard; gl_FragColor = vec4(vColor, 1.0); }`;

interface Overlay {
  lines: LineSegments;
  points: Points;
  key: string;
  so: SyncedObject;
}
const overlays = new Map<string, Overlay>();

const PATH = new Color(0.82, 0.82, 0.82).convertSRGBToLinear(),
  PATH_SEL = new Color(1, 0.62, 0.25).convertSRGBToLinear(),
  KEY_SEL = new Color(0.96, 0.554, 0.015).convertSRGBToLinear(),
  KEY = new Color(0.12, 0.12, 0.12);

/** Blue (0) → green → red (1) weight colours. */
export function weightColor(w: number, out = new Color()): Color {
  const t = Math.max(0, Math.min(1, w));
  return out.setHSL(((1 - t) * 240) / 360, 1, 0.5).convertSRGBToLinear();
}

const idOf = (() => {
  const ids = new WeakMap<object, number>();
  let n = 1;
  return (a: object) => {
    let i = ids.get(a);
    if (!i) ids.set(a, (i = n++));
    return i;
  };
})();

function buildOverlay(o: Overlay, ed: EditedHair) {
  const pe = peSettings(app.doc);
  const weightMode = activePETool() === 'builtin.particle_weight';
  const key = `${idOf(ed.co)}:${idOf(ed.select)}:${idOf(ed.weight)}:${idOf(ed.hide)}:${pe.select_mode}:${pe.display_step}:${weightMode}`;
  if (key === o.key) return;
  o.key = key;
  const steps = 1 << Math.max(0, Math.min(10, pe.display_step));
  const pos: number[] = [],
    col: number[] = [],
    idx: number[] = [];
  const kp: number[] = [],
    kc: number[] = [];
  const c = new Color();
  for (let s = 0; s < strandCount(ed); s++) {
    if (ed.hide[s]) continue;
    const a = ed.key_offsets[s],
      b = ed.key_offsets[s + 1];
    const keys = b - a;
    if (keys < 1) continue;
    const n = Math.max(2, (keys - 1) * steps + 1);
    const pts = new Float32Array(n * 3);
    resampleKeys(ed.co, a, b, n, pts, 0);
    let anySel = false;
    for (let k = a; k < b; k++) if (ed.select[k]) anySel = true;
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      pos.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      if (weightMode) {
        const t = (i / (n - 1)) * (keys - 1);
        const k0 = Math.floor(t),
          k1 = Math.min(keys - 1, k0 + 1);
        weightColor(ed.weight[a + k0] * (1 - (t - k0)) + ed.weight[a + k1] * (t - k0), c);
      } else c.copy(anySel && pe.select_mode !== 'PATH' ? PATH_SEL : anySel ? KEY_SEL : PATH);
      col.push(c.r, c.g, c.b);
      if (i + 1 < n) idx.push(base + i, base + i + 1);
    }
    if (pe.select_mode === 'PATH') continue;
    for (let k = pe.select_mode === 'TIP' ? b - 1 : a; k < b; k++) {
      kp.push(ed.co[k * 3], ed.co[k * 3 + 1], ed.co[k * 3 + 2]);
      if (weightMode) weightColor(ed.weight[k], c);
      else c.copy(ed.select[k] ? KEY_SEL : KEY);
      kc.push(c.r, c.g, c.b);
    }
  }
  const lg = new BufferGeometry();
  lg.setAttribute('position', new Float32BufferAttribute(pos, 3));
  lg.setAttribute('color', new Float32BufferAttribute(col, 3));
  lg.setIndex(idx);
  o.lines.geometry.dispose();
  o.lines.geometry = lg;
  const pg = new BufferGeometry();
  pg.setAttribute('position', new BufferAttribute(new Float32Array(kp), 3));
  pg.setAttribute('color', new BufferAttribute(new Float32Array(kc), 3));
  o.points.geometry.dispose();
  o.points.geometry = pg;
}

sceneSyncHooks.push((_doc, ev, so) => {
  const a = activePE();
  const mine = !!a && a.ob.id === ev.id;
  let o = overlays.get(ev.id);
  if (!mine) {
    if (o) {
      o.lines.removeFromParent();
      o.points.removeFromParent();
      overlays.delete(ev.id);
    }
    return;
  }
  if (!o) {
    const lines = new LineSegments(new BufferGeometry(), new ShaderMaterial({ vertexColors: true, vertexShader: VS, fragmentShader: FS_LINE, uniforms: { uSize: { value: 1 } } }));
    const points = new Points(new BufferGeometry(), new ShaderMaterial({ vertexColors: true, vertexShader: VS, fragmentShader: FS_POINT, uniforms: { uSize: { value: 4 * (globalThis.devicePixelRatio || 1) } } }));
    lines.matrixAutoUpdate = points.matrixAutoUpdate = false;
    lines.frustumCulled = points.frustumCulled = false;
    overlays.set(ev.id, (o = { lines, points, key: '', so }));
  }
  o.so = so;
  if (o.lines.parent !== so.root) so.root.add(o.lines);
  if (o.points.parent !== so.root) so.root.add(o.points);
  buildOverlay(o, a!.ed);
});

drawHooks.passes.push((pass) => {
  if (!overlays.size) return;
  const restore: (() => void)[] = [];
  for (const o of overlays.values()) {
    const v = [o.lines.visible, o.points.visible];
    restore.push(() => {
      o.lines.visible = v[0];
      o.points.visible = v[1];
    });
    o.lines.visible = o.points.visible = pass === 'OVERLAY';
  }
  return () => restore.forEach((f) => f());
});

// the regular strand drawing of the edited system is hidden unless children are shown
particleDrawFilter.push((key) => {
  const a = activePE();
  if (!a || peSettings(app.doc).show_children) return true;
  const m = a.ob.modifiers.find((x) => x.type === 'PARTICLE_SYSTEM' && x.particle_system === (a.psys as ParticleSystemX & { id?: string }).id);
  return !m || key !== `${a.ob.id}:${m.id}`;
});

// ---------------------------------------------------------------------------
// keymap

const p = inPE;
addKeys('Particle', [
  { key: 'A', op: 'particle.select_all', props: { action: 'SELECT' }, when: p },
  { key: 'A', alt: true, op: 'particle.select_all', props: { action: 'DESELECT' }, when: p },
  { key: 'I', ctrl: true, op: 'particle.select_all', props: { action: 'INVERT' }, when: p },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'particle.select_more', when: p },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'particle.select_less', when: p },
  { key: 'L', op: 'particle.select_linked_pick', props: { deselect: false }, when: p },
  { key: 'L', shift: true, op: 'particle.select_linked_pick', props: { deselect: true }, when: p },
  { key: 'L', ctrl: true, op: 'particle.select_linked', when: p },
  { key: 'X', menu: deleteMenu, menuTitle: 'Delete', when: p },
  { key: 'DEL', menu: deleteMenu, menuTitle: 'Delete', when: p },
  { key: 'H', alt: true, op: 'particle.reveal', when: p },
  { key: 'H', op: 'particle.hide', props: { unselected: false }, when: p },
  { key: 'H', shift: true, op: 'particle.hide', props: { unselected: true }, when: p },
  { key: 'F', op: 'wm.radial_control', props: { data: 'size' }, when: p },
  { key: 'F', shift: true, op: 'wm.radial_control', props: { data: 'strength' }, when: p },
  { key: 'K', shift: true, op: 'particle.weight_set', when: p },
  { key: 'ONE', action: () => setSelectMode('PATH'), when: p },
  { key: 'TWO', action: () => setSelectMode('POINT'), when: p },
  { key: 'THREE', action: () => setSelectMode('TIP'), when: p },
  { key: 'W', menu: contextMenu, when: p },
]);

// the emitter being edited shows no selection outline
drawHooks.skipOutline.push((ob) => app.doc.mode === 'PARTICLE_EDIT' && app.activeObject?.id === ob.id);
