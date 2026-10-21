// Animation maintenance operators: Revive Disabled F-Curves, Export Keying Set (as a Python
// script that rebuilds it) and Update Animated Transform Constraints (moves keys of the
// Transformation constraint's shared range properties onto its rotation / scale ranges).
import { app, registerOperators } from '../app/app';
import type { ActionData, Constraint, DocumentData, FCurve, KeyingSetData } from '../data/types';
import { newText } from '../data/defaults';
import { download } from '../io/native';
import { AnimEditor } from './animeditor';
import { uniqueName } from './actionops';
import { activeUserSet } from '../anim/keyingsets';

/** Every F-Curve of every action (and driver curve) in the file. */
function allCurves(doc: DocumentData): FCurve[] {
  const out: FCurve[] = [];
  for (const a of Object.values(doc.actions)) out.push(...a.fcurves);
  return out;
}

registerOperators([
  {
    idname: 'anim.channels_fcurves_enable',
    label: 'Revive Disabled F-Curves',
    description: 'Let F-Curves whose property could not be found try again (after renaming a bone or restoring a modifier, for example)',
    poll: (ctx) => ctx.area?.editor instanceof AnimEditor || Object.keys(ctx.doc.actions).length > 0,
    exec: (ctx) => {
      const ed = ctx.area?.editor instanceof AnimEditor ? ctx.area.editor : null;
      const curves = ed ? ed.list.curves.map((r) => r.fc) : allCurves(ctx.doc);
      let n = 0;
      for (const fc of curves)
        if (fc.disabled) {
          delete fc.disabled;
          n++;
        }
      if (!n) {
        app.report('INFO', 'No disabled F-Curves');
        return 'CANCELLED';
      }
      app.report('INFO', `Revived ${n} F-Curve${n === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'anim.keying_set_export',
    label: 'Export Keying Set...',
    description: 'Write the active keying set as a Python script that recreates it (a text data-block; with a file name, also downloaded)',
    props: [{ id: 'filepath', label: 'File Path', type: 'string', default: '' }],
    poll: () => !!activeUserSet(),
    exec: (ctx, p) => {
      const set = activeUserSet();
      if (!set) return 'CANCELLED';
      const body = keyingSetScript(ctx.doc, set);
      const name = uniqueName(`${set.name.replace(/[^\w.-]+/g, '_')}.py`, Object.values(ctx.doc.texts).map((t) => t.name));
      const t = newText(name, body, 'python');
      ctx.doc.texts[t.id] = t;
      const file = String(p.filepath ?? '').trim();
      if (file) download(body, file.endsWith('.py') ? file : `${file}.py`, 'text/x-python');
      app.report('INFO', `Keying set exported to the text "${name}"`);
    },
  },
  {
    idname: 'anim.update_animated_transform_constraints',
    label: 'Update Animated Transform Constraints',
    description: 'Move animation of Transformation constraints from the shared from/to range properties onto the rotation or scale ranges their mapping uses',
    props: [{ id: 'use_convert_to_radians', label: 'Convert to Radians', type: 'bool', default: true }],
    poll: () => true,
    exec: (ctx, p) => {
      const n = updateTransformConstraintCurves(ctx.doc, !!p.use_convert_to_radians);
      app.report('INFO', n ? `Updated ${n} F-Curve${n === 1 ? '' : 's'}` : 'No Transformation constraint animation to update');
      if (!n) return 'CANCELLED';
    },
  },
]);

/** A Python script (in the scripting API's terms) that rebuilds a keying set. */
export function keyingSetScript(doc: DocumentData, set: KeyingSetData): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = [
    '# Keying set: ' + set.name,
    'import bpy',
    '',
    'scene = bpy.context.scene',
    `ks = scene.keying_sets.new(idname=${q(set.name)}, name=${q(set.name)})`,
    '',
  ];
  for (const path of set.paths) {
    const ob = path.id ? doc.objects[path.id] : undefined;
    if (!ob) {
      lines.push(`# skipped a path without a target: ${q(path.data_path)}`);
      continue;
    }
    lines.push(`ks.paths.add(bpy.data.objects[${q(ob.name)}], ${q(path.data_path)}, index=${path.index})`);
  }
  lines.push('', 'scene.keying_sets.active = ks', '');
  return lines.join('\n');
}

const AXES = ['x', 'y', 'z'];
const RANGE = /^constraints\["((?:[^"\\]|\\.)*)"\]\.(from|to)_(min|max)_([xyz])$/;
const POSE_RANGE = /^pose\.bones\["((?:[^"\\]|\\.)*)"\]\.constraints\["((?:[^"\\]|\\.)*)"\]\.(from|to)_(min|max)_([xyz])$/;

/**
 * Re-target F-Curves of a Transformation constraint's unsuffixed range properties
 * (`from_min_x`, …) to the `_rot` / `_scale` properties when the constraint maps rotation or
 * scale; rotation values can be converted from degrees. Returns the number of curves changed.
 */
export function updateTransformConstraintCurves(doc: DocumentData, toRadians: boolean): number {
  let n = 0;
  const seen = new Set<FCurve>();
  for (const ob of Object.values(doc.objects)) {
    const acts = new Set<ActionData>();
    const ad = ob.animation_data;
    if (ad?.action && doc.actions[ad.action]) acts.add(doc.actions[ad.action]);
    for (const t of ad?.nla_tracks ?? []) for (const s of t.strips) if (doc.actions[s.action]) acts.add(doc.actions[s.action]);
    for (const act of acts)
      for (const fc of act.fcurves) {
        if (seen.has(fc)) continue;
        let con: Constraint | undefined, side: string, which: string, axis: string, tail: string;
        const m = RANGE.exec(fc.data_path);
        const pm = m ? null : POSE_RANGE.exec(fc.data_path);
        if (m) {
          con = ob.constraints.find((c) => c.name === JSON.parse(`"${m[1]}"`));
          [side, which, axis] = [m[2], m[3], m[4]];
          tail = `${side}_${which}_${axis}`;
        } else if (pm) {
          con = ob.pose?.[JSON.parse(`"${pm[1]}"`)]?.constraints.find((c) => c.name === JSON.parse(`"${pm[2]}"`));
          [side, which, axis] = [pm[3], pm[4], pm[5]];
          tail = `${side}_${which}_${axis}`;
        } else continue;
        if (!con || con.type !== 'TRANSFORM' || !AXES.includes(axis)) continue;
        const map = (side === 'from' ? con.map_from : con.map_to) as string;
        if (map !== 'ROTATION' && map !== 'SCALE') continue;
        const suffix = map === 'ROTATION' ? '_rot' : '_scale';
        fc.data_path = fc.data_path.slice(0, fc.data_path.length - tail.length) + tail + suffix;
        if (map === 'ROTATION' && toRadians) {
          const k = Math.PI / 180;
          for (const key of fc.keyframe_points) {
            key.co[1] *= k;
            key.handle_left[1] *= k;
            key.handle_right[1] *= k;
          }
        }
        seen.add(fc);
        n++;
      }
  }
  return n;
}


