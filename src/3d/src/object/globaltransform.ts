// Global Transform tools (sidebar ▸ Animation): copy an object's world-space transform and paste
// it onto others — at the current frame, onto selected keys or baked over a range, mirrored over
// an object's axes, or relative to another object / the scene camera — and "Fix to Camera", which
// keys an object so it keeps its place in the camera's view while the camera moves.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import type { DocumentData, ObjectData, ToolSettings } from '../data/types';
import { applyMatrixToObject, toMatrix4 } from '../eval/transform';
import { ensureAction, ensureFCurve, keyProperty, rotationPath } from '../anim/keyframes';
import { insertKeyframe } from '../anim/fcurve';
import { sidebarTabs } from '../editors/view3d/sidebar';
import { h, type Child } from '../ui/h';
import { checkbox, enumMenu, opButton, panel, row } from '../ui/widgets';

/** Settings shown in the panels (stored with the scene's tool settings). */
interface GTSettings {
  anim_mirror_object?: string | null;
  anim_relative_object?: string | null;
  anim_fix_to_cam_use_loc?: boolean;
  anim_fix_to_cam_use_rot?: boolean;
  anim_fix_to_cam_use_scale?: boolean;
}
const settings = (doc: DocumentData) => doc.scene.tool_settings as ToolSettings & GTSettings;

/** The copied world matrix (column-major), shared by Copy / Copy Relative. */
let clip: number[] | null = null;
export function globalTransformClipboard() {
  return clip;
}
export function setGlobalTransformClipboard(m: number[] | null) {
  clip = m;
}

const world = (ob: ObjectData) => app.graph.get(ob.id)?.world.clone() ?? new Matrix4();

/** Matrix a relative copy/paste is measured from: the Relative object, else the scene camera. */
function relativeBase(doc: DocumentData): Matrix4 | null {
  const id = settings(doc).anim_relative_object ?? doc.scene.camera;
  const ob = id ? doc.objects[id] : undefined;
  return ob ? world(ob) : null;
}

/** Write a world matrix to an object through its parent. */
export function setWorldMatrix(ob: ObjectData, m: Matrix4) {
  const parent = ob.parent ? app.graph.get(ob.parent) : undefined;
  const local = parent ? parent.world.clone().multiply(toMatrix4(ob.matrix_parent_inverse)).invert().multiply(m) : m.clone();
  applyMatrixToObject(ob, local);
}

const AXIS = { x: 0, y: 1, z: 2 } as const;
type Axis = keyof typeof AXIS;

/**
 * Mirror a world matrix over the axes of a reference frame (world when null): the location is
 * reflected along `locAxis`, the rotation reflected through the plane normal to `rotAxis`.
 */
export function mirrorMatrix(m: Matrix4, ref: Matrix4 | null, locAxis: Axis, rotAxis: Axis): Matrix4 {
  const r = ref ?? new Matrix4();
  const local = r.clone().invert().multiply(m);
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  local.decompose(p, q, s);
  p.setComponent(AXIS[locAxis], -p.getComponent(AXIS[locAxis]));
  // reflection S·R·S of the rotation through the plane normal to the axis
  const sgn = [1, 1, 1];
  sgn[AXIS[rotAxis]] = -1;
  const S = new Matrix4().makeScale(sgn[0], sgn[1], sgn[2]);
  const R = new Matrix4().makeRotationFromQuaternion(q);
  const mr = S.clone().multiply(R).multiply(S);
  q.setFromRotationMatrix(mr);
  return r.clone().multiply(new Matrix4().compose(p, q, s));
}

const TRANSFORM_PATHS = ['location', 'rotation_euler', 'rotation_quaternion', 'rotation_axis_angle', 'scale'];

/** Frames of the selected transform keys of an object, sorted. */
function selectedKeyFrames(doc: DocumentData, ob: ObjectData): number[] {
  const act = ob.animation_data?.action ? doc.actions[ob.animation_data.action] : undefined;
  if (!act) return [];
  const frames = new Set<number>();
  for (const fc of act.fcurves) if (TRANSFORM_PATHS.includes(fc.data_path)) for (const k of fc.keyframe_points) if (k.select_control_point) frames.add(Math.round(k.co[0]));
  return [...frames].sort((a, b) => a - b);
}

function keyTransform(doc: DocumentData, ob: ObjectData, frame: number, which = { loc: true, rot: true, scale: true }, type?: 'GENERATED') {
  const paths = [which.loc && 'location', which.rot && rotationPath(ob), which.scale && 'scale'].filter(Boolean) as string[];
  if (!type) {
    for (const p of paths) keyProperty(doc, ob, p, -1, frame);
    return;
  }
  const act = ensureAction(doc, ob);
  for (const p of paths) {
    const v = (ob as unknown as Record<string, number[]>)[p];
    v.forEach((x, i) => insertKeyframe(ensureFCurve(act, p, i), frame, x, { type }));
  }
}

function fixToCamera(doc: DocumentData, p: Record<string, unknown>): 'CANCELLED' | undefined {
  const cam = doc.objects[doc.scene.camera!];
  const obs = app.selectedObjects().filter((o) => o.id !== cam.id);
  const which = { loc: !!p.use_location, rot: !!p.use_rotation, scale: !!p.use_scale };
  if (!which.loc && !which.rot && !which.scale) return 'CANCELLED';
  // the object's place in camera space at the current frame
  const rel = new Map(obs.map((ob) => [ob.id, world(cam).invert().multiply(world(ob))]));
  const f0 = doc.scene.frame_current;
  for (let f = doc.scene.frame_start; f <= doc.scene.frame_end; f++) {
    gotoFrame(f);
    for (const ob of obs) {
      const before = { location: [...ob.location], rotation_euler: [...ob.rotation_euler], rotation_quaternion: [...ob.rotation_quaternion], rotation_axis_angle: [...ob.rotation_axis_angle], scale: [...ob.scale] };
      setWorldMatrix(ob, world(cam).multiply(rel.get(ob.id)!));
      // channels that are not fixed keep their animated values
      if (!which.loc) ob.location = before.location as typeof ob.location;
      if (!which.rot) Object.assign(ob, { rotation_euler: before.rotation_euler, rotation_quaternion: before.rotation_quaternion, rotation_axis_angle: before.rotation_axis_angle });
      if (!which.scale) ob.scale = before.scale as typeof ob.scale;
      keyTransform(doc, ob, f, which, 'GENERATED');
    }
  }
  gotoFrame(f0);
  app.report('INFO', `Fixed ${obs.length} object(s) to the camera on ${doc.scene.frame_end - doc.scene.frame_start + 1} frames`);
}

/** Evaluate the scene at a frame (for baking). */
function gotoFrame(f: number) {
  app.setFrame(f);
  app.flush();
}

registerOperators([
  {
    idname: 'object.copy_global_transform',
    label: 'Copy Global Transform',
    description: 'Remember the active object’s world-space transform',
    poll: () => !!app.activeObject,
    exec: () => {
      const m = app.graph.get(app.activeObject!.id)?.world;
      if (!m) return 'CANCELLED';
      clip = m.toArray();
      try {
        void navigator.clipboard?.writeText(JSON.stringify(clip));
      } catch {
        // the system clipboard is optional
      }
    },
    undo: false,
  },
  {
    idname: 'object.copy_relative_transform',
    label: 'Copy Relative Transform',
    description: 'Remember the active object’s transform relative to the Relative object (or the scene camera)',
    poll: () => !!app.activeObject && !!relativeBase(app.doc),
    exec: (ctx) => {
      const base = relativeBase(ctx.doc)!;
      clip = base.invert().multiply(world(app.activeObject!)).toArray();
    },
    undo: false,
  },
  {
    idname: 'object.paste_transform',
    label: 'Paste Global Transform',
    description: 'Move the selected objects to the copied world-space transform',
    props: [
      {
        id: 'method',
        label: 'Paste Method',
        type: 'enum',
        default: 'CURRENT',
        items: [
          ['CURRENT', 'Current Transform'],
          ['EXISTING_KEYS', 'Selected Keys'],
          ['BAKE', 'Bake on Key Range'],
        ],
      },
      { id: 'bake_step', label: 'Frame Step', type: 'int', default: 1, min: 1, max: 1000, showIf: (p) => p.method === 'BAKE' },
      { id: 'use_mirror', label: 'Mirror Transform', type: 'bool', default: false },
      { id: 'mirror_axis_loc', label: 'Location Axis', type: 'enum', default: 'x', items: [['x', 'X'], ['y', 'Y'], ['z', 'Z']], showIf: (p) => !!p.use_mirror },
      { id: 'mirror_axis_rot', label: 'Rotation Axis', type: 'enum', default: 'z', items: [['x', 'X'], ['y', 'Y'], ['z', 'Z']], showIf: (p) => !!p.use_mirror },
      { id: 'use_relative', label: 'Use Relative Paste', type: 'bool', default: false },
    ],
    poll: () => !!clip && (app.doc.mode === 'OBJECT' || app.doc.mode === 'POSE') && app.selectedObjects().length > 0,
    exec: (ctx, p) => {
      const doc = ctx.doc;
      const source = new Matrix4().fromArray(clip!);
      const targetAt = (): Matrix4 | null => {
        let m = source.clone();
        if (p.use_relative) {
          const base = relativeBase(doc);
          if (!base) return null;
          m = base.multiply(m);
        }
        if (p.use_mirror) {
          const mid = settings(doc).anim_mirror_object;
          const mo = mid ? doc.objects[mid] : undefined;
          m = mirrorMatrix(m, mo ? world(mo) : null, p.mirror_axis_loc as Axis, p.mirror_axis_rot as Axis);
        }
        return m;
      };
      const obs = app.selectedObjects();
      if (p.method === 'CURRENT') {
        const m = targetAt();
        if (!m) return 'CANCELLED';
        for (const ob of obs) setWorldMatrix(ob, m);
        return;
      }
      const f0 = doc.scene.frame_current;
      let n = 0;
      for (const ob of obs) {
        const keys = selectedKeyFrames(doc, ob);
        let frames: number[];
        if (p.method === 'EXISTING_KEYS') frames = keys;
        else {
          const a = keys.length ? keys[0] : doc.scene.frame_start,
            b = keys.length ? keys[keys.length - 1] : doc.scene.frame_end;
          frames = [];
          for (let f = a; f <= b; f += Math.max(1, p.bake_step as number)) frames.push(f);
        }
        for (const f of frames) {
          gotoFrame(f);
          const m = targetAt();
          if (!m) continue;
          setWorldMatrix(ob, m);
          keyTransform(doc, ob, f);
          n++;
        }
      }
      gotoFrame(f0);
      if (!n) {
        app.report('WARNING', p.method === 'EXISTING_KEYS' ? 'No selected transform keys to paste onto' : 'Nothing to bake');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'object.fix_to_camera',
    label: 'Fix to Scene Camera',
    description: 'Key the selected objects on every frame of the scene so they keep their current place in the scene camera’s view',
    props: [
      { id: 'use_location', label: 'Location', type: 'bool', default: true },
      { id: 'use_rotation', label: 'Rotation', type: 'bool', default: true },
      { id: 'use_scale', label: 'Scale', type: 'bool', default: true },
    ],
    poll: () => app.doc.mode === 'OBJECT' && !!app.doc.scene.camera && app.selectedObjects().some((o) => o.id !== app.doc.scene.camera),
    invoke: (ctx, p) => {
      // the panel's Location / Rotation / Scale switches decide what is fixed
      const s = settings(ctx.doc);
      Object.assign(p, { use_location: s.anim_fix_to_cam_use_loc ?? p.use_location, use_rotation: s.anim_fix_to_cam_use_rot ?? p.use_rotation, use_scale: s.anim_fix_to_cam_use_scale ?? p.use_scale });
      return fixToCamera(ctx.doc, p);
    },
    exec: (ctx, p) => fixToCamera(ctx.doc, p),
  },
  {
    idname: 'object.delete_fix_to_camera_keys',
    label: 'Delete Generated Keys',
    description: 'Remove the keys Fix to Scene Camera made on the selected objects',
    poll: () => app.selectedObjects().some((o) => !!o.animation_data?.action),
    exec: (ctx) => {
      let n = 0;
      for (const ob of app.selectedObjects()) {
        const act = ob.animation_data?.action ? ctx.doc.actions[ob.animation_data.action] : undefined;
        if (!act) continue;
        for (const fc of act.fcurves) {
          if (!TRANSFORM_PATHS.includes(fc.data_path)) continue;
          const keep = fc.keyframe_points.filter((k) => k.type !== 'GENERATED');
          n += fc.keyframe_points.length - keep.length;
          fc.keyframe_points = keep;
        }
        act.fcurves = act.fcurves.filter((fc) => !TRANSFORM_PATHS.includes(fc.data_path) || fc.keyframe_points.length);
      }
      if (!n) return 'CANCELLED';
      app.report('INFO', `Deleted ${n} generated key(s)`);
    },
  },
]);

// ---------------------------------------------------------------------------
// sidebar ▸ Animation (Object Mode)

function objectPicker(id: string, value: string | null | undefined, set: (v: string | null) => void, filter?: (o: ObjectData) => boolean, placeholder = 'Object') {
  const obs = Object.values(app.doc.objects).filter((o) => !filter || filter(o));
  return enumMenu(id, [{ value: '', label: '—' }, ...obs.map((o) => ({ value: o.id, label: o.name, icon: 'object' }))], value ?? '', (v) => set(v || null), { label: value && app.doc.objects[value] ? undefined : placeholder });
}

function setSetting<K extends keyof GTSettings>(k: K, v: GTSettings[K], label: string) {
  (settings(app.doc) as GTSettings)[k] = v;
  app.pushUndo(label);
  app.changed('doc', 'ui');
}

function globalTransformPanels(): Child {
  const s = settings(app.doc);
  return [
    panel('sb-gt', 'Global Transform', () => [
      h('div', { class: 'btn-row' }, opButton('object.copy_global_transform', 'Copy', {}, { icon: 'copydown' }), opButton('object.paste_transform', 'Paste', { method: 'CURRENT' }, { icon: 'pastedown' }), opButton('object.paste_transform', 'Mirrored', { method: 'CURRENT', use_mirror: true }, { icon: 'pastedown' })),
      h('div', { class: 'sb-label' }, 'These require auto-key:'),
      h('div', { class: 'btn-row' }, opButton('object.paste_transform', 'Paste to Selected Keys', { method: 'EXISTING_KEYS' }, { icon: 'pastedown' })),
      h('div', { class: 'btn-row' }, opButton('object.paste_transform', 'Paste and Bake', { method: 'BAKE' }, { icon: 'pastedown' })),
    ]),
    panel('sb-gt-fix', 'Fix to Camera', () => [
      h(
        'div',
        { class: 'btn-row' },
        checkbox('gt-fix-loc', 'Location', s.anim_fix_to_cam_use_loc ?? true, (x) => setSetting('anim_fix_to_cam_use_loc', x, 'Fix to Camera Location')),
        checkbox('gt-fix-rot', 'Rotation', s.anim_fix_to_cam_use_rot ?? true, (x) => setSetting('anim_fix_to_cam_use_rot', x, 'Fix to Camera Rotation')),
        checkbox('gt-fix-scale', 'Scale', s.anim_fix_to_cam_use_scale ?? true, (x) => setSetting('anim_fix_to_cam_use_scale', x, 'Fix to Camera Scale')),
      ),
      h('div', { class: 'btn-row' }, opButton('object.fix_to_camera'), opButton('object.delete_fix_to_camera_keys')),
    ], { closed: true }),
    panel('sb-gt-mirror', 'Mirror', () => [row('Object', objectPicker('gt-mirror-ob', s.anim_mirror_object, (v) => setSetting('anim_mirror_object', v, 'Mirror Object')))], { closed: true }),
    panel('sb-gt-rel', 'Relative', () => [
      row('Object', objectPicker('gt-rel-ob', s.anim_relative_object, (v) => setSetting('anim_relative_object', v, 'Relative Object'))),
      !s.anim_relative_object ? h('div', { class: 'sb-label' }, 'Using Active Scene Camera') : null,
      h('div', { class: 'btn-row' }, opButton('object.copy_relative_transform', 'Copy', {}, { icon: 'copydown' }), opButton('object.paste_transform', 'Paste', { method: 'CURRENT', use_relative: true }, { icon: 'pastedown' })),
    ], { closed: true }),
  ];
}

sidebarTabs.push({ id: 'Animation', label: 'Animation', poll: () => app.doc.mode === 'OBJECT', draw: () => globalTransformPanels() });
