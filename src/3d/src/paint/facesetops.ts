// Sculpt Mode face set and visibility operators (create / initialize / grow / shrink face sets,
// hide and show by face set, mask or visibility front).
import { app, operators, registerOperators, type OpContext } from '../app/app';
import type { MeshData } from '../data/types';
import { activeView3D } from '../editors/view3d/view3d';
import { vertexFaces } from '../mesh/mesh';
import { activeMeshData, meshSession } from './session';
import { invalidatePaintAttributes } from './display';
import { faceCount, faceSetsOf, growFaceSet, hiddenFacesOf, initFaceSets, maxFaceSet, setHiddenFaces, shrinkFaceSet, type FaceSetInitMode } from './fsdata';

export const sculptPoll = () => app.doc.mode === 'SCULPT' && !!activeMeshData();

/** Face under the pointer of an operator context (or the current pointer). */
export function faceUnderCursor(ctx?: OpContext): number | null {
  const v = activeView3D();
  const s = meshSession();
  if (!v || !s) return null;
  const r = v.el.getBoundingClientRect();
  const x = (ctx?.event?.x ?? app.pointer.x) - r.left,
    y = (ctx?.event?.y ?? app.pointer.y) - r.top;
  if (x < 0 || y < 0 || x > r.width || y > r.height) return null;
  const hit = s.raycast(v, x, y);
  return hit ? hit.face : null;
}

/** Face set id under the pointer (0 when the pointer is not over the mesh). */
export function faceSetUnderCursor(ctx?: OpContext): number {
  const f = faceUnderCursor(ctx);
  if (f === null) return 0;
  const me = activeMeshData()!.me;
  return faceSetsOf(me)?.[f] ?? 1;
}

/** Writable face sets (a fresh array, initialized to set 1 when the mesh has none). */
export function newFaceSets(me: MeshData): Int32Array {
  return faceSetsOf(me)?.slice() ?? new Int32Array(faceCount(me)).fill(1);
}

export function commitFaceSets(me: MeshData, fs: Int32Array) {
  me.sculpt_face_set = fs;
  invalidatePaintAttributes();
}

/** Assign new hidden face flags (null shows everything). */
export function commitHidden(me: MeshData, hide: Uint8Array | null) {
  setHiddenFaces(me, hide);
  invalidatePaintAttributes();
  app.changed('geometry');
}

function maskedFace(me: MeshData, f: number): boolean {
  const m = me.sculpt_mask;
  if (!m || m.length !== me.positions.length / 3) return false;
  for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (m[me.indices[c]] < 0.5) return false;
  return true;
}

function selectedFace(me: MeshData, f: number): boolean {
  const s = me.select_vert;
  if (!s) return false;
  for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (!s[me.indices[c]]) return false;
  return true;
}

registerOperators([
  {
    idname: 'sculpt.face_sets_create',
    label: 'Create Face Set',
    description: 'Put a group of faces into a new face set',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'MASKED',
        items: [
          ['MASKED', 'Face Set from Masked', 'Faces whose vertices are all masked'],
          ['VISIBLE', 'Face Set from Visible', 'All visible faces'],
          ['ALL', 'Face Set Full Mesh', 'Every face of the mesh'],
          ['SELECTION', 'Face Set from Edit Mode Selection', 'Faces selected in Edit Mode'],
        ],
      },
    ],
    poll: sculptPoll,
    exec: (_ctx, p) => {
      const { me } = activeMeshData()!;
      const nf = faceCount(me);
      const hide = hiddenFacesOf(me);
      const fs = newFaceSets(me);
      const id = maxFaceSet(faceSetsOf(me)) + 1;
      let n = 0;
      for (let f = 0; f < nf; f++) {
        const take = p.mode === 'MASKED' ? maskedFace(me, f) && !hide?.[f] : p.mode === 'VISIBLE' ? !hide?.[f] : p.mode === 'ALL' ? true : selectedFace(me, f);
        if (take) {
          fs[f] = id;
          n++;
        }
      }
      if (!n) {
        app.report('WARNING', p.mode === 'MASKED' ? 'No masked faces' : p.mode === 'SELECTION' ? 'No faces selected in Edit Mode' : 'No faces');
        return 'CANCELLED';
      }
      commitFaceSets(me, fs);
    },
  },
  {
    idname: 'sculpt.face_sets_init',
    label: 'Init Face Sets',
    description: 'Replace all face sets with sets derived from the mesh',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'LOOSE_PARTS',
        items: [
          ['LOOSE_PARTS', 'By Loose Parts', 'One face set per connected piece'],
          ['FACE_SET_BOUNDARIES', 'By Face Set Boundaries', 'One face set per connected region of each face set'],
          ['MATERIALS', 'By Materials', 'One face set per material slot'],
          ['NORMALS', 'By Normals', 'Split where the surface bends more than the threshold'],
          ['UV_SEAMS', 'By UV Seams', 'Split along UV seams'],
          ['CREASES', 'By Edge Creases', 'Split along creased edges'],
          ['SHARP_EDGES', 'By Sharp Edges', 'Split along edges marked sharp'],
        ],
      },
      {
        id: 'threshold',
        label: 'Threshold',
        type: 'float',
        default: 0.5,
        min: 0,
        max: 1,
        subtype: 'factor',
        showIf: (p) => p.mode === 'NORMALS' || p.mode === 'CREASES',
      },
    ],
    poll: sculptPoll,
    exec: (_ctx, p) => {
      const { me } = activeMeshData()!;
      commitFaceSets(me, initFaceSets(me, p.mode as FaceSetInitMode, p.threshold as number));
    },
  },
  {
    idname: 'sculpt.face_sets_randomize_colors',
    label: 'Randomize Face Sets Colors',
    description: 'Pick a new set of display colors for the face sets',
    poll: sculptPoll,
    exec: () => {
      const { me } = activeMeshData()!;
      me.face_sets_color_seed = ((me.face_sets_color_seed ?? 0) + 1 + Math.floor(Math.random() * 1000)) % 100000;
      // keep the largest set uncolored so the mesh stays readable
      const fs = faceSetsOf(me);
      if (fs) {
        const count = new Map<number, number>();
        for (const id of fs) count.set(id, (count.get(id) ?? 0) + 1);
        me.face_sets_color_default = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }
      invalidatePaintAttributes();
    },
  },
  {
    idname: 'sculpt.face_set_edit',
    label: 'Edit Face Set',
    description: 'Grow or shrink the face set under the cursor',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'GROW',
        items: [
          ['GROW', 'Grow Face Set', 'Add the faces around the face set'],
          ['SHRINK', 'Shrink Face Set', 'Remove the faces along the border of the face set'],
        ],
      },
      { id: 'active_face_set', label: 'Face Set', type: 'int', default: 0, hidden: true },
      { id: 'repeat', label: 'Repeat', type: 'int', default: 1, min: 1, max: 100 },
    ],
    poll: sculptPoll,
    invoke: (ctx, p) => {
      p.active_face_set = faceSetUnderCursor(ctx);
      return operators.get('sculpt.face_set_edit')!.exec!(ctx, p);
    },
    exec: (_ctx, p) => {
      const { me } = activeMeshData()!;
      const id = p.active_face_set as number;
      if (!id) return 'CANCELLED';
      let fs = newFaceSets(me);
      const hide = hiddenFacesOf(me);
      for (let i = 0; i < (p.repeat as number); i++) fs = p.mode === 'GROW' ? growFaceSet(me, fs, id, hide) : shrinkFaceSet(me, fs, id, hide);
      commitFaceSets(me, fs);
    },
  },
  {
    idname: 'sculpt.face_set_change_visibility',
    label: 'Face Sets Visibility',
    description: 'Hide or show face sets',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'TOGGLE',
        items: [
          ['TOGGLE', 'Toggle Visibility', 'Show only the face set under the cursor, or everything when it already is the only one'],
          ['SHOW_ACTIVE', 'Show Active Face Set', 'Show only the face set under the cursor'],
          ['HIDE_ACTIVE', 'Hide Active Face Set', 'Hide the face set under the cursor'],
        ],
      },
      { id: 'active_face_set', label: 'Face Set', type: 'int', default: 0, hidden: true },
    ],
    poll: sculptPoll,
    invoke: (ctx, p) => {
      p.active_face_set = faceSetUnderCursor(ctx);
      return operators.get('sculpt.face_set_change_visibility')!.exec!(ctx, p);
    },
    exec: (_ctx, p) => {
      const { me } = activeMeshData()!;
      const nf = faceCount(me);
      const fs = faceSetsOf(me);
      const id = p.active_face_set as number;
      const cur = hiddenFacesOf(me);
      const hide = new Uint8Array(nf);
      const inSet = (f: number) => (fs ? fs[f] : 1) === id;
      if (p.mode === 'HIDE_ACTIVE') {
        if (!id) return 'CANCELLED';
        for (let f = 0; f < nf; f++) hide[f] = cur?.[f] || inSet(f) ? 1 : 0;
      } else if (p.mode === 'SHOW_ACTIVE') {
        if (!id) return 'CANCELLED';
        for (let f = 0; f < nf; f++) hide[f] = inSet(f) ? 0 : 1;
      } else {
        // toggle: when something is hidden, show everything; otherwise isolate the active set
        if (cur && cur.some((x) => x)) {
          commitHidden(me, null);
          return;
        }
        if (!id) return 'CANCELLED';
        for (let f = 0; f < nf; f++) hide[f] = inSet(f) ? 0 : 1;
      }
      commitHidden(me, hide);
    },
  },
  {
    idname: 'paint.hide_show_all',
    label: 'Hide/Show All',
    description: 'Hide or show every face',
    props: [
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'SHOW',
        items: [
          ['HIDE', 'Hide', 'Hide every face'],
          ['SHOW', 'Show', 'Show every face'],
        ],
      },
    ],
    poll: sculptPoll,
    exec: (_ctx, p) => {
      const { me } = activeMeshData()!;
      commitHidden(me, p.action === 'HIDE' ? new Uint8Array(faceCount(me)).fill(1) : null);
    },
  },
  {
    idname: 'paint.visibility_invert',
    label: 'Invert Visibility',
    description: 'Hide the visible faces and show the hidden ones',
    poll: sculptPoll,
    exec: () => {
      const { me } = activeMeshData()!;
      const cur = hiddenFacesOf(me);
      const hide = new Uint8Array(faceCount(me));
      for (let f = 0; f < hide.length; f++) hide[f] = cur?.[f] ? 0 : 1;
      commitHidden(me, hide);
    },
  },
  {
    idname: 'paint.hide_show_masked',
    label: 'Hide/Show Masked',
    description: 'Hide or show the masked part of the mesh',
    props: [
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'HIDE',
        items: [
          ['HIDE', 'Hide', 'Hide the masked faces'],
          ['SHOW', 'Show', 'Show the masked faces'],
        ],
      },
    ],
    poll: sculptPoll,
    exec: (_ctx, p) => {
      const { me } = activeMeshData()!;
      const nf = faceCount(me);
      const cur = hiddenFacesOf(me);
      const hide = cur ? cur.slice() : new Uint8Array(nf);
      for (let f = 0; f < nf; f++) if (maskedFace(me, f)) hide[f] = p.action === 'HIDE' ? 1 : 0;
      commitHidden(me, hide);
    },
  },
  {
    idname: 'paint.visibility_filter',
    label: 'Visibility Filter',
    description: 'Grow or shrink the visible part of the mesh',
    props: [
      {
        id: 'action',
        label: 'Action',
        type: 'enum',
        default: 'GROW',
        items: [
          ['GROW', 'Grow Visibility', 'Show the faces around the visible region'],
          ['SHRINK', 'Shrink Visibility', 'Hide the faces along the border of the visible region'],
        ],
      },
      { id: 'iterations', label: 'Iterations', type: 'int', default: 1, min: 1, max: 100 },
    ],
    poll: sculptPoll,
    exec: (_ctx, p) => {
      const { me } = activeMeshData()!;
      let hide = hiddenFacesOf(me);
      if (!hide) return 'CANCELLED';
      const vf = vertexFaces(me);
      const nf = faceCount(me);
      for (let it = 0; it < (p.iterations as number); it++) {
        const src: Uint8Array = hide;
        const next = src.slice();
        for (let f = 0; f < nf; f++) {
          // GROW: a hidden face next to a visible one appears; SHRINK: a visible face next to a hidden one hides
          if ((p.action === 'GROW') !== !!src[f]) continue;
          let touches = false;
          for (let c = me.offsets[f]; c < me.offsets[f + 1] && !touches; c++) {
            const v = me.indices[c];
            for (let k = vf.offsets[v]; k < vf.offsets[v + 1]; k++)
              if (!!src[vf.faces[k]] !== !!src[f]) {
                touches = true;
                break;
              }
          }
          if (touches) next[f] = p.action === 'GROW' ? 0 : 1;
        }
        hide = next;
      }
      commitHidden(me, hide);
    },
  },
]);
