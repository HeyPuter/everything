// Selection masking in Vertex / Weight / Texture Paint: paint only selected faces (face mask) or
// selected vertices (vertex mask). Selection operators, select tools, header toggles, keys and
// the wire / vertex overlay.
import { BufferGeometry, Color, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, Points, Scene, ShaderMaterial, type Camera } from 'three';
import { app, registerOperators } from '../app/app';
import { addKeys, type KeyItem } from '../app/keymap';
import type { MeshData } from '../data/types';
import { h } from '../ui/h';
import { icon } from '../ui/icons';
import { edgeTopology, triangulatePoly, vertexNeighbors } from '../mesh/mesh';
import { renderContext } from '../render/context';
import { editModeHooks, viewportExtensions, type SelectRegion } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { modeMenus } from '../editors/view3d/modemenus';
import type { MenuItem } from '../ui/menu';
import { activeMeshData, meshSession } from './session';
import { projectVertices } from './vgather';
import { invalidatePaintAttributes } from './display';

const PAINT_MODES = new Set(['VERTEX_PAINT', 'WEIGHT_PAINT', 'TEXTURE_PAINT']);
const paintMode = () => PAINT_MODES.has(app.doc.mode);
/** Face mask is available in all paint modes, the vertex mask in vertex and weight paint. */
const vertMaskMode = () => app.doc.mode === 'VERTEX_PAINT' || app.doc.mode === 'WEIGHT_PAINT';

function meshOf(): MeshData | null {
  return paintMode() ? (activeMeshData()?.me ?? null) : null;
}
export const faceMaskOn = () => !!meshOf()?.use_paint_mask;
export const vertMaskOn = () => vertMaskMode() && !!meshOf()?.use_paint_mask_vertex && !meshOf()?.use_paint_mask;
const anyMask = () => faceMaskOn() || vertMaskOn();

// ---------------------------------------------------------------------------
// selection helpers (vertex flags shared with Edit Mode; a face is selected when all its vertices are)

function nv(me: MeshData) {
  return me.positions.length / 3;
}
function selection(me: MeshData): Uint8Array {
  return me.select_vert && me.select_vert.length === nv(me) ? me.select_vert.slice() : new Uint8Array(nv(me));
}
function hidden(me: MeshData): Uint8Array | null {
  return me.hide_vert && me.hide_vert.length === nv(me) ? me.hide_vert : null;
}
function faceSelected(me: MeshData, sel: Uint8Array, f: number) {
  for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (!sel[me.indices[c]]) return false;
  return true;
}
function faceHidden(me: MeshData, f: number) {
  const hv = hidden(me);
  if (!hv) return false;
  for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (hv[me.indices[c]]) return true;
  return false;
}
function setFace(me: MeshData, sel: Uint8Array, f: number, on: boolean) {
  for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) sel[me.indices[c]] = on ? 1 : 0;
}
/** Re-derive vertex flags from face flags (deselecting a face must not leave neighbours half selected). */
function fromFaces(me: MeshData, faceSel: Uint8Array): Uint8Array {
  const sel = new Uint8Array(nv(me));
  for (let f = 0; f < faceSel.length; f++) if (faceSel[f]) setFace(me, sel, f, true);
  return sel;
}
function faceFlags(me: MeshData, sel: Uint8Array): Uint8Array {
  const nf = me.offsets.length - 1;
  const out = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) out[f] = faceSelected(me, sel, f) && !faceHidden(me, f) ? 1 : 0;
  return out;
}
function commitSelection(me: MeshData, sel: Uint8Array) {
  me.select_vert = sel;
  invalidatePaintAttributes();
  app.changed('select');
}

/** Faces (face mask) or vertices (vertex mask) of the active mesh that are linked to the given ones. */
function linkedFaces(me: MeshData, seed: Uint8Array): Uint8Array {
  const et = edgeTopology(me);
  const nf = me.offsets.length - 1;
  const out = seed.slice();
  const stack: number[] = [];
  for (let f = 0; f < nf; f++) if (seed[f]) stack.push(f);
  while (stack.length) {
    const f = stack.pop()!;
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
      const e = et.cornerEdge[c];
      for (let k = et.faceOffsets[e]; k < et.faceOffsets[e + 1]; k++) {
        const g = et.faces[k];
        if (out[g] || faceHidden(me, g)) continue;
        out[g] = 1;
        stack.push(g);
      }
    }
  }
  return out;
}
function linkedVerts(me: MeshData, seed: Uint8Array): Uint8Array {
  const nb = vertexNeighbors(me);
  const hv = hidden(me);
  const out = seed.slice();
  const stack: number[] = [];
  for (let v = 0; v < out.length; v++) if (out[v]) stack.push(v);
  while (stack.length) {
    const v = stack.pop()!;
    for (let k = nb.offsets[v]; k < nb.offsets[v + 1]; k++) {
      const u = nb.neighbors[k];
      if (out[u] || hv?.[u]) continue;
      out[u] = 1;
      stack.push(u);
    }
  }
  return out;
}

/** Face or vertex under a viewport pixel. */
function pickElement(v: View3D, x: number, y: number): { face: number; vert: number } | null {
  const s = meshSession();
  if (!s) return null;
  const hit = s.raycast(v, x, y);
  if (!hit) return null;
  let best = -1,
    bd = Infinity;
  for (let c = s.offsets[hit.face]; c < s.offsets[hit.face + 1]; c++) {
    const vi = s.indices[c];
    const d = Math.hypot(s.positions[vi * 3] - hit.point.x, s.positions[vi * 3 + 1] - hit.point.y, s.positions[vi * 3 + 2] - hit.point.z);
    if (d < bd) {
      bd = d;
      best = vi;
    }
  }
  return { face: hit.face, vert: best };
}

// ---------------------------------------------------------------------------
// operators

const actionProp = {
  id: 'action',
  label: 'Action',
  type: 'enum' as const,
  default: 'TOGGLE',
  items: [
    ['TOGGLE', 'Toggle', 'Select all, or deselect all when something is selected'],
    ['SELECT', 'Select', 'Select all'],
    ['DESELECT', 'Deselect', 'Deselect all'],
    ['INVERT', 'Invert', 'Invert the selection'],
  ] as [string, string, string][],
};

function selectAll(face: boolean, action: string) {
  const me = meshOf()!;
  const sel = selection(me);
  const hv = hidden(me);
  if (face) {
    const ff = faceFlags(me, sel);
    let act = action;
    if (act === 'TOGGLE') act = ff.some((x) => x) ? 'DESELECT' : 'SELECT';
    for (let f = 0; f < ff.length; f++) if (!faceHidden(me, f)) ff[f] = act === 'SELECT' ? 1 : act === 'DESELECT' ? 0 : ff[f] ? 0 : 1;
    commitSelection(me, fromFaces(me, ff));
  } else {
    let act = action;
    if (act === 'TOGGLE') act = sel.some((x, i) => x && !hv?.[i]) ? 'DESELECT' : 'SELECT';
    for (let v = 0; v < sel.length; v++) if (!hv?.[v]) sel[v] = act === 'SELECT' ? 1 : act === 'DESELECT' ? 0 : sel[v] ? 0 : 1;
    commitSelection(me, sel);
  }
}

function growShrink(face: boolean, grow: boolean) {
  const me = meshOf()!;
  const sel = selection(me);
  if (face) {
    const ff = faceFlags(me, sel);
    const et = edgeTopology(me);
    const out = ff.slice();
    for (let f = 0; f < ff.length; f++) {
      // grow: unselected faces sharing a vertex with a selected face; shrink: selected faces touching an unselected one
      if (!!ff[f] === grow) continue;
      let touch = false;
      for (let c = me.offsets[f]; c < me.offsets[f + 1] && !touch; c++) {
        const e = et.cornerEdge[c];
        for (let k = et.faceOffsets[e]; k < et.faceOffsets[e + 1]; k++)
          if (!!ff[et.faces[k]] === grow && et.faces[k] !== f) {
            touch = true;
            break;
          }
      }
      if (touch && !faceHidden(me, f)) out[f] = grow ? 1 : 0;
    }
    commitSelection(me, fromFaces(me, out));
  } else {
    const nb = vertexNeighbors(me);
    const hv = hidden(me);
    const out = sel.slice();
    for (let v = 0; v < sel.length; v++) {
      if (!!sel[v] === grow || hv?.[v]) continue;
      for (let k = nb.offsets[v]; k < nb.offsets[v + 1]; k++)
        if (!!sel[nb.neighbors[k]] === grow) {
          out[v] = grow ? 1 : 0;
          break;
        }
    }
    commitSelection(me, out);
  }
}

function hideSelected(face: boolean, unselected: boolean) {
  const me = meshOf()!;
  const sel = selection(me);
  const hv = hidden(me)?.slice() ?? new Uint8Array(nv(me));
  if (face) {
    const ff = faceFlags(me, sel);
    for (let f = 0; f < ff.length; f++) if (!!ff[f] !== unselected) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) hv[me.indices[c]] = 1;
    // a vertex of a still visible face stays visible
    for (let f = 0; f < ff.length; f++) if (!!ff[f] === unselected && !faceHidden(me, f)) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (!hidden(me)?.[me.indices[c]]) hv[me.indices[c]] = 0;
  } else for (let v = 0; v < sel.length; v++) if (!!sel[v] !== unselected) hv[v] = 1;
  for (let v = 0; v < sel.length; v++) if (hv[v]) sel[v] = 0;
  me.hide_vert = hv.some((x) => x) ? hv : undefined;
  commitSelection(me, sel);
}

const mk = (idname: string, label: string, description: string, props: import('../app/app').PropDef[], poll: () => boolean, exec: (p: Record<string, unknown>) => void) => ({ idname, label, description, props, poll, exec: (_c: unknown, p: Record<string, unknown>) => exec(p) });
const facePoll = () => faceMaskOn();
const vertPoll = () => vertMaskOn();

registerOperators([
  {
    idname: 'paint.selection_mask_toggle',
    label: 'Toggle Selection Masking',
    description: 'Paint only the selected faces or vertices',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'FACE',
        items: [
          ['FACE', 'Face Selection Masking', 'Only paint the selected faces'],
          ['VERTEX', 'Vertex Selection Masking', 'Only paint the selected vertices'],
        ],
      },
    ],
    poll: () => paintMode() && !!meshOf(),
    exec: (_c, p) => {
      const me = meshOf()!;
      if (p.mode === 'VERTEX') {
        if (!vertMaskMode()) return 'CANCELLED';
        me.use_paint_mask_vertex = !me.use_paint_mask_vertex;
        if (me.use_paint_mask_vertex) me.use_paint_mask = false;
      } else {
        me.use_paint_mask = !me.use_paint_mask;
        if (me.use_paint_mask) me.use_paint_mask_vertex = false;
      }
      invalidatePaintAttributes();
      app.changed('ui');
    },
  },
  mk('paint.face_select_all', '(De)select All', 'Change the selection of all faces', [actionProp], facePoll, (p) => selectAll(true, p.action as string)),
  mk('paint.vert_select_all', '(De)select All', 'Change the selection of all vertices', [actionProp], vertPoll, (p) => selectAll(false, p.action as string)),
  mk('paint.face_select_more', 'Select More', 'Select the faces around the selection', [], facePoll, () => growShrink(true, true)),
  mk('paint.face_select_less', 'Select Less', 'Deselect the faces along the border of the selection', [], facePoll, () => growShrink(true, false)),
  mk('paint.vert_select_more', 'Select More', 'Select the vertices around the selection', [], vertPoll, () => growShrink(false, true)),
  mk('paint.vert_select_less', 'Select Less', 'Deselect the vertices along the border of the selection', [], vertPoll, () => growShrink(false, false)),
  mk('paint.face_select_linked', 'Select Linked', 'Select all faces connected to the selection', [], facePoll, () => {
    const me = meshOf()!;
    commitSelection(me, fromFaces(me, linkedFaces(me, faceFlags(me, selection(me)))));
  }),
  mk('paint.vert_select_linked', 'Select Linked All', 'Select all vertices connected to the selection', [], vertPoll, () => {
    const me = meshOf()!;
    commitSelection(me, linkedVerts(me, selection(me)));
  }),
  mk('paint.face_select_hide', 'Face Select Hide', 'Hide the selected (or unselected) faces', [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }], facePoll, (p) => hideSelected(true, !!p.unselected)),
  mk('paint.vert_select_hide', 'Vertex Select Hide', 'Hide the selected (or unselected) vertices', [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }], vertPoll, (p) => hideSelected(false, !!p.unselected)),
  mk('paint.face_vert_reveal', 'Reveal Faces/Vertices', 'Show the hidden faces and vertices', [{ id: 'select', label: 'Select', type: 'bool', default: true }], () => paintMode() && !!meshOf(), (p) => {
    const me = meshOf()!;
    const hv = hidden(me);
    if (!hv) return;
    const sel = selection(me);
    if (p.select) for (let v = 0; v < sel.length; v++) if (hv[v]) sel[v] = 1;
    me.hide_vert = undefined;
    commitSelection(me, sel);
  }),
  mk('paint.vert_select_ungrouped', 'Select Ungrouped', 'Select the vertices that are in no vertex group', [{ id: 'extend', label: 'Extend', type: 'bool', default: false }], vertPoll, (p) => {
    const me = meshOf()!;
    const sel = p.extend ? selection(me) : new Uint8Array(nv(me));
    const hv = hidden(me);
    for (let v = 0; v < sel.length; v++) {
      if (hv?.[v]) continue;
      let grouped = false;
      for (const w of me.weights) if (w && w[v] > 0) grouped = true;
      if (!grouped) sel[v] = 1;
    }
    commitSelection(me, sel);
  }),
  {
    idname: 'paint.face_select_linked_pick',
    label: 'Select Linked Pick',
    description: 'Select the faces connected to the face under the cursor',
    props: [
      { id: 'deselect', label: 'Deselect', type: 'bool', default: false },
      { id: 'face', label: 'Face', type: 'int', default: -1, hidden: true },
    ],
    poll: facePoll,
    invoke: (ctx, p) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const r = v.el.getBoundingClientRect();
      const el = pickElement(v, (ctx.event?.x ?? app.pointer.x) - r.left, (ctx.event?.y ?? app.pointer.y) - r.top);
      if (!el) return 'CANCELLED';
      p.face = el.face;
      return linkedPick(true, p);
    },
    exec: (_c, p) => linkedPick(true, p),
  },
  {
    idname: 'paint.vert_select_linked_pick',
    label: 'Select Linked Pick',
    description: 'Select the vertices connected to the vertex under the cursor',
    props: [
      { id: 'select', label: 'Select', type: 'bool', default: true },
      { id: 'vert', label: 'Vertex', type: 'int', default: -1, hidden: true },
    ],
    poll: vertPoll,
    invoke: (ctx, p) => {
      const v = activeView3D();
      if (!v) return 'CANCELLED';
      const r = v.el.getBoundingClientRect();
      const el = pickElement(v, (ctx.event?.x ?? app.pointer.x) - r.left, (ctx.event?.y ?? app.pointer.y) - r.top);
      if (!el) return 'CANCELLED';
      p.vert = el.vert;
      return linkedPick(false, p);
    },
    exec: (_c, p) => linkedPick(false, p),
  },
]);

function linkedPick(face: boolean, p: Record<string, unknown>): 'CANCELLED' | void {
  const me = meshOf();
  if (!me) return 'CANCELLED';
  if (face) {
    const f = p.face as number;
    if (f < 0 || f >= me.offsets.length - 1) return 'CANCELLED';
    const seed = new Uint8Array(me.offsets.length - 1);
    seed[f] = 1;
    const linked = linkedFaces(me, seed);
    const ff = faceFlags(me, selection(me));
    for (let g = 0; g < ff.length; g++) if (linked[g]) ff[g] = p.deselect ? 0 : 1;
    commitSelection(me, fromFaces(me, ff));
  } else {
    const v = p.vert as number;
    if (v < 0 || v >= nv(me)) return 'CANCELLED';
    const seed = new Uint8Array(nv(me));
    seed[v] = 1;
    const linked = linkedVerts(me, seed);
    const sel = selection(me);
    for (let u = 0; u < sel.length; u++) if (linked[u]) sel[u] = p.select ? 1 : 0;
    commitSelection(me, sel);
  }
}

// ---------------------------------------------------------------------------
// select tools (click, box, circle, lasso) while a mask is on

editModeHooks.pick.push((v, x, y, o) => {
  if (!anyMask()) return false;
  const me = meshOf()!;
  const el = pickElement(v, x, y);
  const face = faceMaskOn();
  if (face) {
    const ff = o.extend || o.toggle || o.deselect ? faceFlags(me, selection(me)) : new Uint8Array(me.offsets.length - 1);
    if (el) ff[el.face] = o.deselect ? 0 : o.toggle || o.extend ? (ff[el.face] && o.toggle ? 0 : 1) : 1;
    commitSelection(me, fromFaces(me, ff));
  } else {
    const sel = o.extend || o.toggle || o.deselect ? selection(me) : new Uint8Array(nv(me));
    if (el) sel[el.vert] = o.deselect ? 0 : o.toggle && sel[el.vert] ? 0 : 1;
    commitSelection(me, sel);
  }
  app.pushUndo('Select');
  return true;
});

function regionSelect(v: View3D, inside: (x: number, y: number) => boolean, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR') {
  const me = meshOf()!;
  const s = meshSession();
  if (!s) return;
  const proj = projectVertices(s, v);
  const hv = hidden(me);
  const combine = (cur: number, hit: boolean) => (mode === 'SET' ? hit : mode === 'ADD' ? !!cur || hit : mode === 'SUB' ? !!cur && !hit : mode === 'AND' ? !!cur && hit : !!cur !== hit) ? 1 : 0;
  if (faceMaskOn()) {
    const ff = faceFlags(me, selection(me));
    for (let f = 0; f < ff.length; f++) {
      if (faceHidden(me, f)) continue;
      let x = 0,
        y = 0;
      const n = me.offsets[f + 1] - me.offsets[f];
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
        x += proj[me.indices[c] * 3];
        y += proj[me.indices[c] * 3 + 1];
      }
      ff[f] = combine(ff[f], inside(x / n, y / n));
    }
    commitSelection(me, fromFaces(me, ff));
  } else {
    const sel = selection(me);
    for (let i = 0; i < sel.length; i++) {
      if (hv?.[i]) continue;
      const z = proj[i * 3 + 2];
      sel[i] = combine(sel[i], z >= -1 && z <= 1 && inside(proj[i * 3], proj[i * 3 + 1]));
    }
    commitSelection(me, sel);
  }
  app.pushUndo('Select');
}

editModeHooks.box.push((v, x0, y0, x1, y1, mode) => {
  if (!anyMask()) return false;
  const ax = Math.min(x0, x1),
    bx = Math.max(x0, x1),
    ay = Math.min(y0, y1),
    by = Math.max(y0, y1);
  regionSelect(v, (x, y) => x >= ax && x <= bx && y >= ay && y <= by, mode);
  return true;
});
editModeHooks.region.push((v, r: SelectRegion, mode) => {
  if (!anyMask()) return false;
  const test =
    r.kind === 'circle'
      ? (x: number, y: number) => Math.hypot(x - r.x, y - r.y) <= r.r
      : r.kind === 'box'
        ? (x: number, y: number) => x >= Math.min(r.x0, r.x1) && x <= Math.max(r.x0, r.x1) && y >= Math.min(r.y0, r.y1) && y <= Math.max(r.y0, r.y1)
        : (x: number, y: number) => {
            let c = false;
            const p = r.pts;
            for (let i = 0, j = p.length - 1; i < p.length; j = i++) if (p[i].y > y !== p[j].y > y && x < ((p[j].x - p[i].x) * (y - p[i].y)) / (p[j].y - p[i].y) + p[i].x) c = !c;
            return c;
          };
  regionSelect(v, test, mode);
  return true;
});

/** Select tools offered in the paint toolbars while a selection mask is on. */
export const PAINT_SELECT_TOOLS = [
  { id: 'builtin.select', label: 'Tweak', icon: 'select_tweak', description: 'Click to select' },
  { id: 'builtin.select_box', label: 'Select Box', icon: 'select_box', description: 'Drag a box to select' },
  { id: 'builtin.select_circle', label: 'Select Circle', icon: 'select_circle', description: 'Paint over elements to select them' },
  { id: 'builtin.select_lasso', label: 'Select Lasso', icon: 'select_lasso', description: 'Draw a lasso to select' },
];
export const isSelectTool = (id: string | undefined) => !!id && PAINT_SELECT_TOOLS.some((t) => t.id === id);

// ---------------------------------------------------------------------------
// header toggles, select menu, keys

export function maskToggles() {
  const me = meshOf();
  if (!me) return null;
  const btn = (on: boolean, ic: string, tip: string, mode: string) =>
    h('button', { key: mode, class: { 'hdr-toggle': true, on }, 'data-tip': tip, onclick: () => app.run('paint.selection_mask_toggle', { mode }) }, icon(ic));
  return h(
    'div',
    { class: 'hdr-group select-modes' },
    btn(!!me.use_paint_mask, 'snap_face', 'Face Selection Masking (1)\nOnly paint the selected faces', 'FACE'),
    vertMaskMode() ? btn(!!me.use_paint_mask_vertex && !me.use_paint_mask, 'snap_vertex', 'Vertex Selection Masking (2)\nOnly paint the selected vertices', 'VERTEX') : null,
  );
}

export function paintSelectMenu(): MenuItem[] {
  if (faceMaskOn())
    return [
      { label: 'All', op: 'paint.face_select_all', props: { action: 'SELECT' }, shortcut: 'A' },
      { label: 'None', op: 'paint.face_select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
      { label: 'Invert', op: 'paint.face_select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
      { separator: true },
      { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
      { label: 'Circle Select', op: 'view3d.select_circle', shortcut: 'C' },
      { separator: true },
      { label: 'More', op: 'paint.face_select_more', shortcut: 'Ctrl Numpad +' },
      { label: 'Less', op: 'paint.face_select_less', shortcut: 'Ctrl Numpad -' },
      { separator: true },
      { label: 'Select Linked', op: 'paint.face_select_linked', shortcut: 'Ctrl L' },
      { separator: true },
      { label: 'Reveal Hidden', op: 'paint.face_vert_reveal', shortcut: 'Alt H' },
      { label: 'Hide Selected', op: 'paint.face_select_hide', props: { unselected: false }, shortcut: 'H' },
      { label: 'Hide Unselected', op: 'paint.face_select_hide', props: { unselected: true }, shortcut: 'Shift H' },
    ];
  if (vertMaskOn())
    return [
      { label: 'All', op: 'paint.vert_select_all', props: { action: 'SELECT' }, shortcut: 'A' },
      { label: 'None', op: 'paint.vert_select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
      { label: 'Invert', op: 'paint.vert_select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
      { separator: true },
      { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
      { label: 'Circle Select', op: 'view3d.select_circle', shortcut: 'C' },
      { separator: true },
      { label: 'More', op: 'paint.vert_select_more', shortcut: 'Ctrl Numpad +' },
      { label: 'Less', op: 'paint.vert_select_less', shortcut: 'Ctrl Numpad -' },
      { separator: true },
      { label: 'Select Linked', op: 'paint.vert_select_linked', shortcut: 'Ctrl L' },
      { separator: true },
      { label: 'Ungrouped Vertices', op: 'paint.vert_select_ungrouped' },
      { separator: true },
      { label: 'Reveal Hidden', op: 'paint.face_vert_reveal', shortcut: 'Alt H' },
      { label: 'Hide Selected', op: 'paint.vert_select_hide', props: { unselected: false }, shortcut: 'H' },
      { label: 'Hide Unselected', op: 'paint.vert_select_hide', props: { unselected: true }, shortcut: 'Shift H' },
    ];
  return [];
}

for (const mode of PAINT_MODES) {
  const prev = modeMenus[mode] ?? {};
  modeMenus[mode] = {
    ...prev,
    select: paintSelectMenu,
    headerExtra: maskToggles,
  };
}

const fk = (key: string, op: string, props?: Record<string, unknown>, mods: Partial<KeyItem> = {}): KeyItem => ({ key, op, props, ...mods, when: faceMaskOn });
const vk = (key: string, op: string, props?: Record<string, unknown>, mods: Partial<KeyItem> = {}): KeyItem => ({ key, op, props, ...mods, when: vertMaskOn });
const maskKeys: KeyItem[] = [
  fk('A', 'paint.face_select_all', { action: 'SELECT' }),
  fk('A', 'paint.face_select_all', { action: 'DESELECT' }, { alt: true }),
  fk('I', 'paint.face_select_all', { action: 'INVERT' }, { ctrl: true }),
  fk('H', 'paint.face_vert_reveal', {}, { alt: true }),
  fk('H', 'paint.face_select_hide', { unselected: false }),
  fk('H', 'paint.face_select_hide', { unselected: true }, { shift: true }),
  fk('L', 'paint.face_select_linked', {}, { ctrl: true }),
  fk('L', 'paint.face_select_linked_pick', { deselect: false }),
  fk('L', 'paint.face_select_linked_pick', { deselect: true }, { shift: true }),
  fk('NUMPAD_PLUS', 'paint.face_select_more', {}, { ctrl: true }),
  fk('NUMPAD_MINUS', 'paint.face_select_less', {}, { ctrl: true }),
  fk('B', 'view3d.select_box_tool'),
  fk('C', 'view3d.select_circle'),
  vk('A', 'paint.vert_select_all', { action: 'SELECT' }),
  vk('A', 'paint.vert_select_all', { action: 'DESELECT' }, { alt: true }),
  vk('I', 'paint.vert_select_all', { action: 'INVERT' }, { ctrl: true }),
  vk('H', 'paint.face_vert_reveal', {}, { alt: true }),
  vk('H', 'paint.vert_select_hide', { unselected: false }),
  vk('H', 'paint.vert_select_hide', { unselected: true }, { shift: true }),
  vk('L', 'paint.vert_select_linked', {}, { ctrl: true }),
  vk('L', 'paint.vert_select_linked_pick', { select: true }),
  vk('L', 'paint.vert_select_linked_pick', { select: false }, { shift: true }),
  vk('NUMPAD_PLUS', 'paint.vert_select_more', {}, { ctrl: true }),
  vk('NUMPAD_MINUS', 'paint.vert_select_less', {}, { ctrl: true }),
  vk('B', 'view3d.select_box_tool'),
  vk('C', 'view3d.select_circle'),
];
const toggles = (vertex: boolean): KeyItem[] => [{ key: 'ONE', op: 'paint.selection_mask_toggle', props: { mode: 'FACE' } }, ...(vertex ? [{ key: 'TWO', op: 'paint.selection_mask_toggle', props: { mode: 'VERTEX' } }] : [])];
// mask keys first so they win over the brush keys of the same mode
addKeys('Vertex Paint', [...toggles(true), ...maskKeys]);
addKeys('Weight Paint', [...toggles(true), ...maskKeys]);
addKeys('Image Paint', [...toggles(false), ...maskKeys.filter((k) => k.when === faceMaskOn)]);

// ---------------------------------------------------------------------------
// overlay: mesh wire (face mask: selected faces tinted) / vertices (vertex mask)

const C = {
  edge: new Color(0, 0, 0),
  edgeSel: new Color().setRGB(1.0, 0.6, 0.0).convertSRGBToLinear(),
  face: new Color().setRGB(1.0, 0.64, 0.0).convertSRGBToLinear(),
  vert: new Color(0, 0, 0),
  vertSel: new Color().setRGB(1.0, 0.478, 0.0).convertSRGBToLinear(),
};

const pointMat = new ShaderMaterial({
  vertexShader: /* glsl */ `
    attribute vec3 color;
    varying vec3 vColor;
    void main() {
      vColor = color;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_Position.z -= 0.0001 * gl_Position.w;
      gl_PointSize = 6.0;
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      if (dot(c, c) > 0.25) discard;
      gl_FragColor = vec4(vColor, 1.0);
      #include <colorspace_fragment>
    }
  `,
  depthWrite: false,
  transparent: true,
});

let cached: { key: unknown[]; group: Group } | null = null;
const scene = new Scene();
scene.matrixWorldAutoUpdate = false;

function build(me: MeshData, face: boolean): Group {
  const g = new Group();
  g.matrixAutoUpdate = false;
  const sel = selection(me);
  const hv = hidden(me);
  const et = edgeTopology(me);
  const P = me.positions;
  const pos: number[] = [],
    col: number[] = [];
  const ff = face ? faceFlags(me, sel) : null;
  for (let e = 0; e < et.count; e++) {
    const a = et.verts[e * 2],
      b = et.verts[e * 2 + 1];
    if (hv?.[a] || hv?.[b]) continue;
    let on = false;
    if (ff) for (let k = et.faceOffsets[e]; k < et.faceOffsets[e + 1]; k++) on = on || !!ff[et.faces[k]];
    const c = on ? C.edgeSel : C.edge;
    pos.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  const lg = new BufferGeometry();
  lg.setAttribute('position', new Float32BufferAttribute(pos, 3));
  lg.setAttribute('color', new Float32BufferAttribute(col, 3));
  const lines = new LineSegments(lg, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: face ? 0.6 : 0.35, depthWrite: false }));
  lines.matrixAutoUpdate = false;
  g.add(lines);
  if (ff) {
    // light tint on the selected faces
    const tp: number[] = [];
    const tmp: number[] = [];
    for (let f = 0; f < ff.length; f++) {
      if (!ff[f]) continue;
      tmp.length = 0;
      triangulatePoly(P, me.indices.subarray(me.offsets[f], me.offsets[f + 1]), tmp, 0);
      for (const k of tmp) {
        const vi = me.indices[me.offsets[f] + k];
        tp.push(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]);
      }
    }
    if (tp.length) {
      const fg = new BufferGeometry();
      fg.setAttribute('position', new Float32BufferAttribute(tp, 3));
      const m = new Mesh(fg, new MeshBasicMaterial({ color: C.face, transparent: true, opacity: 0.22, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
      m.matrixAutoUpdate = false;
      g.add(m);
    }
  } else {
    const vp: number[] = [],
      vc: number[] = [];
    for (let v = 0; v < sel.length; v++) {
      if (hv?.[v]) continue;
      const c = sel[v] ? C.vertSel : C.vert;
      vp.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      vc.push(c.r, c.g, c.b);
    }
    const pg = new BufferGeometry();
    pg.setAttribute('position', new Float32BufferAttribute(vp, 3));
    pg.setAttribute('color', new Float32BufferAttribute(vc, 3));
    const pts = new Points(pg, pointMat);
    pts.matrixAutoUpdate = false;
    g.add(pts);
  }
  return g;
}

function dispose(g: Group) {
  g.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material && m.material !== pointMat) (m.material as MeshBasicMaterial).dispose();
  });
}

function drawMaskOverlay(v: View3D, camera: Camera) {
  const r = renderContext?.engine.renderer;
  if (!r || !anyMask()) return;
  const am = activeMeshData();
  if (!am || (v.localView && !v.localView.has(am.ob.id))) return;
  const { ob, me } = am;
  const face = faceMaskOn();
  const key = [me.positions, me.indices, me.select_vert, me.hide_vert, face];
  if (!cached || cached.key.some((k, i) => k !== key[i])) {
    if (cached) dispose(cached.group);
    cached = { key, group: build(me, face) };
  }
  const ev = app.graph.get(ob.id);
  if (ev) cached.group.matrix.copy(ev.world);
  scene.add(cached.group);
  scene.updateMatrixWorld(true);
  r.render(scene, camera);
  scene.clear();
}

viewportExtensions.push((v) => {
  const fn = (_s: Scene, camera: Camera) => drawMaskOverlay(v, camera);
  v.extraOverlays.push(fn);
  return () => {
    v.extraOverlays = v.extraOverlays.filter((f) => f !== fn);
  };
});
