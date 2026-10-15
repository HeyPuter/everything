// Particle Edit mode for hair particle systems: entering builds editable keys from the generated
// strands; selection (click, box, circle, lasso, roots, tips, random, linked, more / less),
// transforms of keys, and the edit operators (delete, hide / reveal, rekey, subdivide, remove
// doubles, weight, mirror, unify length, free edit).
import { Box3, Matrix3, Matrix4, Vector3 } from 'three';
import { app, operators, registerOperators, type OpContext } from '../../app/app';
import { modeHandlers } from '../../ops/modes';
import { MODE_ITEMS } from '../../editors/view3d/header';
import { activeTools } from '../../app/prefs';
import { editModeHooks, type SelectRegion } from '../../editors/view3d/hooks';
import type { View3D } from '../../editors/view3d/view3d';
import { inSelectRegion } from '../../editors/view3d/selectshapes';
import { transformProviders, type TElement } from '../../ops/transform';
import { setGizmoCenterHook, gizmoCenterHook } from '../../editors/view3d/gizmo';
import { frameHooks } from '../../ops/view3d';
import { proportionalWeights } from '../../modes/proportional';
import type { DocumentData, ObjectData } from '../../data/types';
import type { EditedHair, ObjectPhysics, ParticleSettingsX, ParticleSystemX } from '../../physics/types';
import { evaluateHair, settingsOf, systemOf } from '../../physics/particles';
import { rng } from '../data';
import { combine } from '../select';
import { deleteKeys, deleteStrands, editedFromStrands, keyCount, keyStrands, mirrorStrands, rekey, removeDoubles, selectedStrands, strandCount, subdivideKeys, unifyLength } from './keys';

export type PESelectMode = 'PATH' | 'POINT' | 'TIP';

export interface PEBrush {
  size: number;
  strength: number;
  /** Add: hairs per step */
  count?: number;
  length_mode?: 'GROW' | 'SHRINK';
  puff_mode?: 'ADD' | 'SUB';
  use_puff_volume?: boolean;
}

export interface ParticleEditSettings {
  select_mode: PESelectMode;
  brushes: Record<string, PEBrush>;
  use_preserve_length: boolean;
  use_preserve_root: boolean;
  use_emitter_deflect: boolean;
  emitter_distance: number;
  /** path drawing subdivision (2^n steps per key segment) */
  display_step: number;
  /** draw the children while editing */
  show_children: boolean;
  /** closed mesh hair is cut to by Shape Cut */
  shape_object?: string | null;
  use_default_interpolate: boolean;
  default_key_count: number;
}

export const PE_TOOLS: { id: string; label: string; icon: string; description: string }[] = [
  { id: 'builtin.particle_comb', label: 'Comb', icon: 'hair_comb', description: 'Comb the hair along the stroke' },
  { id: 'builtin.particle_smooth', label: 'Smooth', icon: 'hair_smooth', description: 'Smooth the hair paths' },
  { id: 'builtin.particle_add', label: 'Add', icon: 'hair_add', description: 'Add hair on the emitter surface' },
  { id: 'builtin.particle_length', label: 'Length', icon: 'hair_grow', description: 'Make hair longer or shorter' },
  { id: 'builtin.particle_puff', label: 'Puff', icon: 'hair_puff', description: 'Make hair stand up from the surface (or lie down)' },
  { id: 'builtin.particle_cut', label: 'Cut', icon: 'hair_cut', description: 'Cut hair where the brush passes' },
  { id: 'builtin.particle_weight', label: 'Weight', icon: 'hair_weight', description: 'Paint the weight of hair keys' },
];

const BRUSH_DEFAULTS: Record<string, PEBrush> = {
  'builtin.particle_comb': { size: 50, strength: 0.5 },
  'builtin.particle_smooth': { size: 50, strength: 0.5 },
  'builtin.particle_add': { size: 50, strength: 0.5, count: 10 },
  'builtin.particle_length': { size: 50, strength: 0.5, length_mode: 'GROW' },
  'builtin.particle_puff': { size: 50, strength: 0.5, puff_mode: 'ADD', use_puff_volume: false },
  'builtin.particle_cut': { size: 50, strength: 0.5 },
  'builtin.particle_weight': { size: 50, strength: 0.5 },
};

export function peSettings(doc: DocumentData): ParticleEditSettings {
  const ts = doc.scene.tool_settings as unknown as { particle_edit?: ParticleEditSettings };
  const pe = (ts.particle_edit ??= {} as ParticleEditSettings);
  pe.select_mode ??= 'POINT';
  pe.brushes ??= {};
  pe.use_preserve_length ??= true;
  pe.use_preserve_root ??= true;
  pe.use_emitter_deflect ??= true;
  pe.emitter_distance ??= 0.01;
  pe.display_step ??= 2;
  pe.show_children ??= false;
  pe.use_default_interpolate ??= true;
  pe.default_key_count ??= 5;
  return pe;
}

export function peBrush(doc: DocumentData, tool: string): PEBrush {
  const pe = peSettings(doc);
  return (pe.brushes[tool] ??= { ...(BRUSH_DEFAULTS[tool] ?? { size: 50, strength: 0.5 }) });
}

export const activePETool = () => activeTools.PARTICLE_EDIT ?? 'builtin.particle_comb';

/** The active object's active hair particle system (any mode). */
export function hairSystemOf(ob: ObjectData | null | undefined): { ob: ObjectData; psys: ParticleSystemX; settings: ParticleSettingsX } | null {
  const o = ob as ObjectPhysics | null | undefined;
  if (!o || o.type !== 'MESH' || !o.particle_systems?.length) return null;
  const psys = o.particle_systems[o.active_particle_system_index ?? 0] as ParticleSystemX | undefined;
  const s = psys ? settingsOf(app.doc, psys) : null;
  return psys && s && s.type === 'HAIR' ? { ob: o, psys, settings: s } : null;
}

/** The hair being edited (Particle Edit mode), with its keys. */
export function activePE(): { ob: ObjectData; psys: ParticleSystemX; settings: ParticleSettingsX; ed: EditedHair } | null {
  if (app.doc.mode !== 'PARTICLE_EDIT') return null;
  const r = hairSystemOf(app.activeObject);
  if (!r || !r.psys.edited_hair) return null;
  return { ...r, ed: r.psys.edited_hair };
}
export const inPE = () => !!activePE();
const pePoll = (ctx: OpContext) => ctx.doc.mode === 'PARTICLE_EDIT' && !!activePE();

/** Keys from the generated strands (parents only), in the emitter's object space. */
export function buildEditedHair(ob: ObjectData, psys: ParticleSystemX, s: ParticleSettingsX): EditedHair | null {
  const m = ob.modifiers.find((x) => x.type === 'PARTICLE_SYSTEM' && systemOf(ob, x) === psys);
  const mesh = app.graph.get(ob.id)?.mesh;
  if (!m || !mesh) return null;
  const hair = evaluateHair(ob, m, psys, { ...s, child_type: 'NONE' }, mesh, 0);
  return editedFromStrands(hair.points, hair.segments + 1, hair.parents);
}

modeHandlers.PARTICLE_EDIT = {
  enter(ob) {
    const r = hairSystemOf(ob);
    if (!r) {
      app.report('WARNING', 'Particle Edit needs a mesh with an active hair particle system');
      return false;
    }
    if (!r.psys.edited_hair) {
      const ed = buildEditedHair(r.ob, r.psys, r.settings);
      if (!ed) return false;
      r.psys.edited_hair = ed;
    }
    peSettings(app.doc);
    if (!activeTools.PARTICLE_EDIT?.startsWith('builtin.particle_') && !activeTools.PARTICLE_EDIT?.startsWith('builtin.select')) activeTools.PARTICLE_EDIT = 'builtin.particle_comb';
    return true;
  },
};

MODE_ITEMS.push({ mode: 'PARTICLE_EDIT', label: 'Particle Edit', icon: 'particlemode', types: ['MESH'] });
const modeProp = operators.get('object.mode_set')?.props?.find((p) => p.id === 'mode');
if (modeProp?.items && !modeProp.items.some((i) => i[0] === 'PARTICLE_EDIT')) modeProp.items.push(['PARTICLE_EDIT', 'Particle Edit']);

// ---------------------------------------------------------------------------
// helpers

/** Keys that can be selected / edited in the current select mode (tips only in Tip mode). */
export function editableKeys(ed: EditedHair, mode: PESelectMode): Uint8Array {
  const out = new Uint8Array(keyCount(ed));
  for (let s = 0; s < strandCount(ed); s++) {
    if (ed.hide[s]) continue;
    const a = ed.key_offsets[s],
      b = ed.key_offsets[s + 1];
    if (mode === 'TIP') out[b - 1] = 1;
    else out.fill(1, a, b);
  }
  return out;
}

export function setEd(psys: ParticleSystemX, ed: EditedHair) {
  psys.edited_hair = ed;
}

/** Replace the selection array (copy on write). */
function withSelect(ed: EditedHair, sel: Uint8Array): EditedHair {
  return { ...ed, select: sel };
}

const worldOf = (ob: ObjectData) => app.graph.get(ob.id)?.world.clone() ?? new Matrix4();

function projectKeys(v: View3D, ob: ObjectData, ed: EditedHair) {
  const w = worldOf(ob);
  const n = keyCount(ed);
  const out = new Float32Array(n * 3);
  const p = new Vector3();
  for (let i = 0; i < n; i++) {
    p.fromArray(ed.co, i * 3).applyMatrix4(w);
    const s = v.project(p);
    out[i * 3] = s.x;
    out[i * 3 + 1] = s.y;
    out[i * 3 + 2] = s.z;
  }
  return out;
}

// ---------------------------------------------------------------------------
// operators

const ACTIONS: [string, string][] = [
  ['TOGGLE', 'Toggle'],
  ['SELECT', 'Select'],
  ['DESELECT', 'Deselect'],
  ['INVERT', 'Invert'],
];

function actionOn(cur: number, action: string) {
  return action === 'SELECT' ? 1 : action === 'DESELECT' ? 0 : action === 'INVERT' ? cur ^ 1 : cur;
}

registerOperators([
  {
    idname: 'particle.particle_edit_toggle',
    label: 'Particle Edit Toggle',
    description: 'Enter or leave Particle Edit mode',
    poll: () => !!hairSystemOf(app.activeObject),
    exec: () => {
      if (app.run('object.mode_set', { mode: app.doc.mode === 'PARTICLE_EDIT' ? 'OBJECT' : 'PARTICLE_EDIT' }, { invoke: false }) !== 'FINISHED') return 'CANCELLED';
    },
    undo: false,
  },
  {
    idname: 'particle.edited_clear',
    label: 'Clear Edited',
    description: 'Undo all edits of the hair and generate it from the settings again',
    poll: () => !!hairSystemOf(app.activeObject)?.psys.edited_hair,
    exec: (ctx) => {
      const r = hairSystemOf(app.activeObject)!;
      if (ctx.doc.mode === 'PARTICLE_EDIT') {
        const s = { ...r.settings };
        r.psys.edited_hair = null;
        r.psys.edited_hair = buildEditedHair(r.ob, r.psys, s);
      } else r.psys.edited_hair = null;
    },
  },
  {
    idname: 'particle.select_all',
    label: '(De)select All',
    description: 'Change the selection of all hair keys',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: ACTIONS }],
    poll: pePoll,
    exec: (_c, p) => {
      const { psys, ed } = activePE()!;
      const ok = editableKeys(ed, peSettings(app.doc).select_mode);
      let action = p.action as string;
      if (action === 'TOGGLE') action = ed.select.some((x, i) => x && ok[i]) ? 'DESELECT' : 'SELECT';
      const sel = ed.select.slice();
      for (let i = 0; i < sel.length; i++) if (ok[i]) sel[i] = actionOn(sel[i], action);
      setEd(psys, withSelect(ed, sel));
    },
  },
  {
    idname: 'particle.select_roots',
    label: 'Select Roots',
    description: 'Select the root key of every hair',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'SELECT', items: ACTIONS }],
    poll: pePoll,
    exec: (_c, p) => {
      const { psys, ed } = activePE()!;
      const sel = ed.select.slice();
      for (let s = 0; s < strandCount(ed); s++) if (!ed.hide[s]) sel[ed.key_offsets[s]] = actionOn(sel[ed.key_offsets[s]], p.action as string);
      setEd(psys, withSelect(ed, sel));
    },
  },
  {
    idname: 'particle.select_tips',
    label: 'Select Tips',
    description: 'Select the tip key of every hair',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'SELECT', items: ACTIONS }],
    poll: pePoll,
    exec: (_c, p) => {
      const { psys, ed } = activePE()!;
      const sel = ed.select.slice();
      for (let s = 0; s < strandCount(ed); s++) if (!ed.hide[s]) sel[ed.key_offsets[s + 1] - 1] = actionOn(sel[ed.key_offsets[s + 1] - 1], p.action as string);
      setEd(psys, withSelect(ed, sel));
    },
  },
  {
    idname: 'particle.select_random',
    label: 'Select Random',
    description: 'Randomly select hairs or keys',
    props: [
      { id: 'ratio', label: 'Ratio', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 'seed', label: 'Random Seed', type: 'int', default: 0, min: 0 },
      { id: 'action', label: 'Action', type: 'enum', default: 'SELECT', items: [['SELECT', 'Select'], ['DESELECT', 'Deselect']] },
      { id: 'type', label: 'Type', type: 'enum', default: 'HAIR', items: [['HAIR', 'Hair'], ['POINTS', 'Points']] },
    ],
    poll: pePoll,
    exec: (_c, p) => {
      const { psys, ed } = activePE()!;
      const r = rng((p.seed as number) + 3);
      const sel = ed.select.slice();
      const ok = editableKeys(ed, peSettings(app.doc).select_mode);
      const v = p.action === 'SELECT' ? 1 : 0;
      for (let s = 0; s < strandCount(ed); s++) {
        if (ed.hide[s]) continue;
        if (p.type === 'HAIR') {
          if (r() < (p.ratio as number)) for (let k = ed.key_offsets[s]; k < ed.key_offsets[s + 1]; k++) if (ok[k]) sel[k] = v;
        } else for (let k = ed.key_offsets[s]; k < ed.key_offsets[s + 1]; k++) if (ok[k] && r() < (p.ratio as number)) sel[k] = v;
      }
      setEd(psys, withSelect(ed, sel));
    },
  },
  {
    idname: 'particle.select_more',
    label: 'Select More',
    description: 'Grow the key selection along the hair',
    poll: pePoll,
    exec: () => {
      const { psys, ed } = activePE()!;
      const sel = ed.select.slice();
      const ks = keyStrands(ed);
      for (let k = 0; k < sel.length; k++) {
        if (ed.select[k] || ed.hide[ks[k]]) continue;
        const s = ks[k];
        if ((k > ed.key_offsets[s] && ed.select[k - 1]) || (k + 1 < ed.key_offsets[s + 1] && ed.select[k + 1])) sel[k] = 1;
      }
      setEd(psys, withSelect(ed, sel));
    },
  },
  {
    idname: 'particle.select_less',
    label: 'Select Less',
    description: 'Shrink the key selection along the hair',
    poll: pePoll,
    exec: () => {
      const { psys, ed } = activePE()!;
      const sel = ed.select.slice();
      const ks = keyStrands(ed);
      for (let k = 0; k < sel.length; k++) {
        if (!ed.select[k]) continue;
        const s = ks[k];
        const prev = k > ed.key_offsets[s] ? ed.select[k - 1] : 1;
        const next = k + 1 < ed.key_offsets[s + 1] ? ed.select[k + 1] : 1;
        if (!prev || !next) sel[k] = 0;
      }
      setEd(psys, withSelect(ed, sel));
    },
  },
  {
    idname: 'particle.select_linked',
    label: 'Select Linked All',
    description: 'Select all keys of hairs with a selected key',
    poll: pePoll,
    exec: () => {
      const { psys, ed } = activePE()!;
      const which = selectedStrands(ed);
      const sel = ed.select.slice();
      for (let s = 0; s < which.length; s++) if (which[s]) sel.fill(1, ed.key_offsets[s], ed.key_offsets[s + 1]);
      setEd(psys, withSelect(ed, sel));
    },
  },
  {
    idname: 'particle.select_linked_pick',
    label: 'Select Linked',
    description: 'Select (or deselect) all keys of the hair under the pointer',
    props: [{ id: 'deselect', label: 'Deselect', type: 'bool', default: false }],
    poll: pePoll,
    invoke: (ctx, p) => {
      const v = ctx.area?.editor as View3D | undefined;
      const a = activePE();
      if (!v || !a || !('project' in v)) return 'CANCELLED';
      const r = v.el.getBoundingClientRect();
      const s = nearestStrand(v, a.ob, a.ed, (ctx.event?.x ?? app.pointer.x) - r.left, (ctx.event?.y ?? app.pointer.y) - r.top);
      if (s < 0) return 'CANCELLED';
      const sel = a.ed.select.slice();
      sel.fill(p.deselect ? 0 : 1, a.ed.key_offsets[s], a.ed.key_offsets[s + 1]);
      setEd(a.psys, withSelect(a.ed, sel));
    },
  },
  {
    idname: 'particle.delete',
    label: 'Delete',
    description: 'Delete the selected hairs or keys',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'PARTICLE', items: [['PARTICLE', 'Particle'], ['KEY', 'Key']] }],
    poll: pePoll,
    exec: (_c, p) => {
      const { psys, ed } = activePE()!;
      const which = selectedStrands(ed);
      if (!which.some((x) => x)) return 'CANCELLED';
      setEd(psys, p.type === 'KEY' ? deleteKeys(ed, ed.select) : deleteStrands(ed, which));
    },
  },
  {
    idname: 'particle.hide',
    label: 'Hide Selected',
    description: 'Hide the selected hairs (or the unselected ones)',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: pePoll,
    exec: (_c, p) => {
      const { psys, ed } = activePE()!;
      const which = selectedStrands(ed);
      const hide = ed.hide.slice();
      const sel = ed.select.slice();
      for (let s = 0; s < hide.length; s++)
        if (!hide[s] && (p.unselected ? !which[s] : which[s])) {
          hide[s] = 1;
          sel.fill(0, ed.key_offsets[s], ed.key_offsets[s + 1]);
        }
      setEd(psys, { ...ed, hide, select: sel });
    },
  },
  {
    idname: 'particle.reveal',
    label: 'Reveal',
    description: 'Show the hidden hairs',
    props: [{ id: 'select', label: 'Select', type: 'bool', default: true }],
    poll: pePoll,
    exec: (_c, p) => {
      const { psys, ed } = activePE()!;
      const sel = ed.select.slice();
      for (let s = 0; s < ed.hide.length; s++) if (ed.hide[s] && p.select) sel.fill(1, ed.key_offsets[s], ed.key_offsets[s + 1]);
      setEd(psys, { ...ed, hide: new Uint8Array(ed.hide.length), select: sel });
    },
  },
  {
    idname: 'particle.rekey',
    label: 'Rekey',
    description: 'Change the number of keys of the selected hairs',
    props: [{ id: 'keys_number', label: 'Number of Keys', type: 'int', default: 2, min: 2, max: 100 }],
    poll: pePoll,
    exec: (_c, p) => {
      const { psys, ed } = activePE()!;
      const which = selectedStrands(ed);
      if (!which.some((x) => x)) return 'CANCELLED';
      setEd(psys, rekey(ed, which, p.keys_number as number));
    },
  },
  {
    idname: 'particle.subdivide',
    label: 'Subdivide',
    description: 'Add a key between neighbouring selected keys',
    poll: pePoll,
    exec: () => {
      const { psys, ed } = activePE()!;
      const out = subdivideKeys(ed);
      if (keyCount(out) === keyCount(ed)) return 'CANCELLED';
      setEd(psys, out);
    },
  },
  {
    idname: 'particle.remove_doubles',
    label: 'Remove Doubles',
    description: 'Remove selected hairs whose roots sit on top of another hair',
    props: [{ id: 'threshold', label: 'Merge Distance', type: 'float', default: 0.0002, min: 0, max: 10, subtype: 'distance' }],
    poll: pePoll,
    exec: (_c, p) => {
      const { psys, ed } = activePE()!;
      const r = removeDoubles(ed, p.threshold as number, selectedStrands(ed));
      app.report('INFO', `Removed ${r.removed} double particle${r.removed === 1 ? '' : 's'}`);
      if (!r.removed) return 'CANCELLED';
      setEd(psys, r.ed);
    },
  },
  {
    idname: 'particle.weight_set',
    label: 'Weight Set',
    description: 'Set the weight of the selected keys',
    props: [{ id: 'factor', label: 'Factor', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' }],
    poll: pePoll,
    exec: (_c, p) => {
      const { psys, ed } = activePE()!;
      const w = ed.weight.slice();
      let any = false;
      for (let k = 0; k < w.length; k++)
        if (ed.select[k]) {
          w[k] = p.factor as number;
          any = true;
        }
      if (!any) return 'CANCELLED';
      setEd(psys, { ...ed, weight: w });
    },
  },
  {
    idname: 'particle.mirror',
    label: 'Mirror',
    description: 'Duplicate the selected hairs mirrored across the local X axis',
    poll: pePoll,
    exec: () => {
      const { psys, ed } = activePE()!;
      const which = selectedStrands(ed);
      if (!which.some((x) => x)) return 'CANCELLED';
      setEd(psys, mirrorStrands(ed, which));
    },
  },
  {
    idname: 'particle.unify_length',
    label: 'Unify Length',
    description: 'Give the selected hairs their average length',
    poll: pePoll,
    exec: () => {
      const { psys, ed } = activePE()!;
      const which = selectedStrands(ed);
      if (!which.some((x) => x)) return 'CANCELLED';
      setEd(psys, unifyLength(ed, which));
    },
  },
]);

// ---------------------------------------------------------------------------
// picking & region selection

function nearestStrand(v: View3D, ob: ObjectData, ed: EditedHair, x: number, y: number): number {
  const S = projectKeys(v, ob, ed);
  let best = -1,
    bd = 20 * 20;
  for (let s = 0; s < strandCount(ed); s++) {
    if (ed.hide[s]) continue;
    for (let k = ed.key_offsets[s]; k < ed.key_offsets[s + 1]; k++) {
      if (S[k * 3 + 2] > 1) continue;
      const d = (S[k * 3] - x) ** 2 + (S[k * 3 + 1] - y) ** 2;
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
  }
  return best;
}

editModeHooks.pick.push((v, x, y, o) => {
  const a = inPE() ? activePE() : null;
  if (!a) return false;
  const pe = peSettings(app.doc);
  const { ed } = a;
  const ok = editableKeys(ed, pe.select_mode);
  const S = projectKeys(v, a.ob, ed);
  let hit = -1;
  if (pe.select_mode === 'PATH') {
    const s = nearestStrand(v, a.ob, ed, x, y);
    hit = s >= 0 ? ed.key_offsets[s] : -1;
  } else {
    let bd = 12 * 12;
    for (let k = 0; k < keyCount(ed); k++) {
      if (!ok[k] || S[k * 3 + 2] > 1) continue;
      const d = (S[k * 3] - x) ** 2 + (S[k * 3 + 1] - y) ** 2;
      if (d < bd) {
        bd = d;
        hit = k;
      }
    }
  }
  if (hit < 0 && !o.deselectAll && (o.extend || o.toggle || o.deselect)) return true;
  const sel = ed.select.slice();
  if (!o.extend && !o.toggle && !o.deselect) sel.fill(0);
  if (hit >= 0) {
    const ks = keyStrands(ed);
    // in Path mode a click selects the whole hair
    const [from, to] = pe.select_mode === 'PATH' ? [ed.key_offsets[ks[hit]], ed.key_offsets[ks[hit] + 1]] : [hit, hit + 1];
    for (let k = from; k < to; k++) sel[k] = o.deselect ? 0 : o.toggle ? sel[hit] ^ 1 : 1;
  }
  setEd(a.psys, withSelect(ed, sel));
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
});

function regionSelect(v: View3D, r: SelectRegion, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR', label: string) {
  const a = inPE() ? activePE() : null;
  if (!a) return false;
  const pe = peSettings(app.doc);
  const { ed } = a;
  const ok = editableKeys(ed, pe.select_mode);
  const S = projectKeys(v, a.ob, ed);
  const sel = ed.select.slice();
  for (let k = 0; k < sel.length; k++) {
    if (!ok[k]) continue;
    const hit = S[k * 3 + 2] <= 1 && inSelectRegion(r, S[k * 3], S[k * 3 + 1]) ? 1 : 0;
    sel[k] = combine(sel[k], hit, mode);
  }
  setEd(a.psys, withSelect(ed, sel));
  app.pushUndo(label);
  app.changed('select', 'doc');
  return true;
}

editModeHooks.box.push((v, x0, y0, x1, y1, mode) => regionSelect(v, { kind: 'box', x0, y0, x1, y1 }, mode, 'Box Select'));
editModeHooks.region.push((v, r, mode) => regionSelect(v, r, mode, r.kind === 'circle' ? 'Circle Select' : 'Lasso Select'));

// ---------------------------------------------------------------------------
// transforms of the selected keys (roots stay with Preserve Root)

function selectedWorldKeys(): Vector3[] {
  const a = activePE();
  if (!a) return [];
  const w = worldOf(a.ob);
  const out: Vector3[] = [];
  const ok = editableKeys(a.ed, peSettings(app.doc).select_mode);
  for (let k = 0; k < keyCount(a.ed); k++) if (a.ed.select[k] && ok[k]) out.push(new Vector3().fromArray(a.ed.co, k * 3).applyMatrix4(w));
  return out;
}

transformProviders.push({
  collect({ proportional, connected }) {
    const a = inPE() ? activePE() : null;
    if (!a) return null;
    const pe = peSettings(app.doc);
    const { psys } = a;
    const ed0 = a.ed;
    const ok = editableKeys(ed0, pe.select_mode);
    const roots = new Uint8Array(keyCount(ed0));
    if (pe.use_preserve_root) for (let s = 0; s < strandCount(ed0); s++) roots[ed0.key_offsets[s]] = 1;
    const selected = Array.from(ed0.select, (x, k) => !!x && !!ok[k] && !roots[k]);
    if (!selected.some(Boolean)) return null;
    const w = worldOf(a.ob),
      inv = w.clone().invert();
    const ed = { ...ed0, co: ed0.co.slice() };
    psys.edited_hair = ed;
    const before = ed.co.slice();
    const n = keyCount(ed);
    const pts = Array.from({ length: n }, (_, i) => new Vector3().fromArray(before, i * 3).applyMatrix4(w));
    let weight: Float32Array = Float32Array.from(selected, (x) => (x ? 1 : 0));
    let dist: Float32Array = new Float32Array(n);
    if (proportional) {
      const ks = keyStrands(ed);
      const nb = (k: number) => {
        const s = ks[k];
        const out: number[] = [];
        if (k > ed.key_offsets[s]) out.push(k - 1);
        if (k + 1 < ed.key_offsets[s + 1]) out.push(k + 1);
        return out;
      };
      ({ weight, dist } = proportionalWeights(pts, selected, connected, nb));
      for (let k = 0; k < n; k++) if (roots[k] || ed.hide[ks[k]]) weight[k] = 0;
    }
    const basis = new Matrix3().setFromMatrix4(w);
    const tmp = new Vector3();
    const els: TElement[] = [];
    for (let k = 0; k < n; k++) {
      if (!weight[k]) continue;
      const p0 = pts[k];
      els.push({
        center: p0,
        basis,
        weight: weight[k],
        distance: dist[k],
        apply(m: Matrix4) {
          tmp.copy(p0).applyMatrix4(m).applyMatrix4(inv).toArray(ed.co, k * 3);
        },
        restore() {
          ed.co.set(before);
        },
      });
    }
    if (!els.length) return null;
    return {
      elements: els,
      label: 'Particle',
      finish() {},
      cancel() {},
      onUpdate: () => {
        const co = ed.co.slice();
        psys.edited_hair = { ...ed, co };
        ed.co = co;
        app.changed('doc');
      },
    };
  },
});

const prevGizmo = gizmoCenterHook;
setGizmoCenterHook(() => {
  if (inPE()) {
    const pts = selectedWorldKeys();
    if (!pts.length) return null;
    const c = new Vector3();
    pts.forEach((p) => c.add(p));
    return { center: c.multiplyScalar(1 / pts.length) };
  }
  return prevGizmo?.() ?? null;
});

frameHooks.unshift(() => {
  if (!inPE()) return null;
  const pts = selectedWorldKeys();
  return pts.length ? new Box3().setFromPoints(pts) : null;
});
