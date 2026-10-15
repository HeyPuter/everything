// Panel of the Mesh Cache modifier, with loading MDD / PC2 files from disk.
import { h } from '../../../ui/h';
import { num, bool, enumProp, splitRow, axisToggles } from '../../../ui/props';
import { enumRow, button, enumMenu } from '../../../ui/widgets';
import { app, registerOperators } from '../../../app/app';
import type { ModifierBase } from '../../../data/types';
import { modifierFields, modifierExtraUI } from '../stack';
import { vgroupRow, sub, touch, flagToggles } from './kit';
import { findModifier } from '../../../object/modifierops';
import { parseMDD, parsePC2, cacheFromModifier, type PointCache } from '../../../eval/mods/meshcache';
import { alembicMeshPaths, readAlembicTrack } from '../../../eval/mods/meshseq';

type Rec = Record<string, unknown>;

/** Store a parsed cache on the modifier. */
export function setCache(m: ModifierBase, c: PointCache, name: string) {
  Object.assign(m, {
    cache_format: c.format,
    filepath: name,
    _cache_format: c.format,
    _cache_points: c.points,
    _cache_frames: c.frames,
    _cache_data: c.data,
    _cache_times: c.times,
    _cache_start: c.start ?? 0,
    _cache_rate: c.rate ?? 1,
  });
  if (!c.times) delete m._cache_times;
}

/** Read a cache file chosen by the user into the modifier. */
export async function loadCacheFile(m: ModifierBase, file: File) {
  const buf = await file.arrayBuffer();
  const ext = file.name.toLowerCase().split('.').pop();
  const fmt = ext === 'pc2' ? 'PC2' : ext === 'mdd' ? 'MDD' : String(m.cache_format ?? 'MDD');
  try {
    const c = fmt === 'PC2' ? parsePC2(buf) : parseMDD(buf);
    setCache(m, c, file.name);
    app.graph.invalidate();
    app.pushUndo('Load Mesh Cache');
    app.changed('doc');
    app.report('INFO', `Loaded ${c.frames} frames of ${c.points} points`);
  } catch (e) {
    app.report('ERROR', e instanceof Error ? e.message : String(e));
  }
}

registerOperators([
  {
    idname: 'object.mesh_cache_open',
    label: 'Open Mesh Cache',
    description: 'Load an MDD or PC2 point cache file into a Mesh Cache modifier',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: () => !!app.activeObject?.modifiers.some((m) => m.type === 'MESH_CACHE'),
    undo: false,
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const m = findModifier(ob, p.modifier) ?? ob.modifiers.find((x) => x.type === 'MESH_CACHE');
      if (!m) return 'CANCELLED';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.mdd,.pc2';
      input.onchange = () => {
        const f = input.files?.[0];
        if (f) void loadCacheFile(m, f);
      };
      input.click();
    },
  },
]);

const AXES: [string, string][] = [
  ['POS_X', 'X'],
  ['POS_Y', 'Y'],
  ['POS_Z', 'Z'],
  ['NEG_X', '-X'],
  ['NEG_Y', '-Y'],
  ['NEG_Z', '-Z'],
];

modifierFields.MESH_CACHE = [];
modifierExtraUI.MESH_CACHE = (ob, m) => {
  const r = m as Rec;
  const c = cacheFromModifier(m);
  const custom = r.play_mode === 'CUSTOM';
  const mode = String(r.time_mode ?? 'FRAME');
  return [
    enumProp(r, 'cache_format', 'Format', [
      ['MDD', 'MDD'],
      ['PC2', 'PC2'],
    ]),
    splitRow('File Path', h('div', { class: 'row-aligned' }, h('span', { class: 'mod-file' }, String(r.filepath || 'None')), button(`${m.id}.open`, 'Open…', () => app.run('object.mesh_cache_open', { modifier: m.id }), { tip: 'Load an MDD or PC2 file' }))),
    c ? h('div', { class: 'mod-note' }, `${c.frames} frames, ${c.points} points`) : null,
    num(r, 'factor', 'Influence', { min: 0, max: 1, slider: true }),
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
    splitRow(
      'Deform Mode',
      enumRow(
        `${m.id}.deform_mode`,
        [
          { value: 'OVERWRITE', label: 'Overwrite' },
          { value: 'INTEGRATE', label: 'Integrate' },
        ],
        String(r.deform_mode ?? 'OVERWRITE'),
        (v) => ((r.deform_mode = v), touch('Change Deform Mode')),
      ),
    ),
    splitRow(
      'Interpolation',
      enumRow(
        `${m.id}.interpolation`,
        [
          { value: 'NONE', label: 'None' },
          { value: 'LINEAR', label: 'Linear' },
        ],
        String(r.interpolation ?? 'LINEAR'),
        (v) => ((r.interpolation = v), touch('Change Interpolation')),
      ),
    ),
    sub(m, 'time', 'Time Remapping', () => [
      enumProp(r, 'time_mode', 'Time Mode', [
        ['FRAME', 'Frame'],
        ['TIME', 'Time'],
        ['FACTOR', 'Factor'],
      ]),
      splitRow(
        'Play Mode',
        enumRow(
          `${m.id}.play_mode`,
          [
            { value: 'SCENE', label: 'Scene' },
            { value: 'CUSTOM', label: 'Custom' },
          ],
          String(r.play_mode ?? 'SCENE'),
          (v) => ((r.play_mode = v), touch('Change Play Mode')),
        ),
      ),
      custom
        ? mode === 'FACTOR'
          ? num(r, 'eval_factor', 'Evaluation Factor', { min: 0, max: 1, slider: true, anim: { ob, path: `modifiers["${m.name}"].eval_factor` } })
          : mode === 'TIME'
            ? num(r, 'eval_time', 'Evaluation Time', { min: 0, anim: { ob, path: `modifiers["${m.name}"].eval_time` } })
            : num(r, 'eval_frame', 'Evaluation Frame', { min: 0, anim: { ob, path: `modifiers["${m.name}"].eval_frame` } })
        : [num(r, 'frame_start', 'Frame Start'), num(r, 'frame_scale', 'Frame Scale', { min: 0, max: 100 })],
    ]),
    sub(m, 'axis', 'Axis Mapping', () => [enumProp(r, 'forward_axis', 'Forward', AXES), enumProp(r, 'up_axis', 'Up', AXES), axisToggles(r, 'flip_axis', 'Flip Axis')]),
  ];
};

// ---------------------------------------------------------------------------
// Mesh Sequence Cache (Alembic)

/** Read one object of the stored archive into the modifier. */
export function setSequencePath(m: ModifierBase, path: string): boolean {
  const bytes = m._abc_bytes as Uint8Array | undefined;
  if (!bytes) return false;
  const track = readAlembicTrack(bytes, path);
  if (!track) return false;
  Object.assign(m, { object_path: path, _seq_data: track.data, _seq_times: track.times, _seq_points: track.points });
  return true;
}

registerOperators([
  {
    idname: 'cachefile.open',
    label: 'Open Cache File',
    description: 'Load an Alembic file into a Mesh Sequence Cache modifier',
    props: [{ id: 'modifier', label: 'Modifier', type: 'string', default: '' }],
    poll: () => !!app.activeObject?.modifiers.some((m) => m.type === 'MESH_SEQUENCE_CACHE'),
    undo: false,
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const m = findModifier(ob, p.modifier) ?? ob.modifiers.find((x) => x.type === 'MESH_SEQUENCE_CACHE');
      if (!m) return 'CANCELLED';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.abc';
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return;
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          const paths = alembicMeshPaths(bytes);
          if (!paths.length) throw new Error('The file has no meshes');
          const me = ob.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
          const nv = me ? me.positions.length / 3 : -1;
          // prefer a mesh with the same vertex count as this one
          const pick = paths.find((x) => x.points === nv) ?? paths[0];
          Object.assign(m, { filepath: f.name, _abc_bytes: bytes, _abc_paths: paths.map((x) => x.path) });
          setSequencePath(m, pick.path);
          app.graph.invalidate(ob.id);
          app.pushUndo('Open Cache File');
          app.changed('doc');
        } catch (e) {
          app.report('ERROR', e instanceof Error ? e.message : String(e));
        }
      };
      input.click();
    },
  },
]);

modifierFields.MESH_SEQUENCE_CACHE = [];
modifierExtraUI.MESH_SEQUENCE_CACHE = (ob, m) => {
  const r = m as Rec;
  const paths = (r._abc_paths as string[] | undefined) ?? [];
  return [
    splitRow('Cache File', h('div', { class: 'row-aligned' }, h('span', { class: 'mod-file' }, String(r.filepath || 'None')), button(`${m.id}.openabc`, 'Open…', () => app.run('cachefile.open', { modifier: m.id }), { tip: 'Load an Alembic (.abc) file' }))),
    paths.length
      ? splitRow(
          'Object Path',
          enumMenu(`${m.id}.object_path`, paths.map((p) => ({ value: p, label: p })), String(r.object_path ?? ''), (v) => {
            if (setSequencePath(m, v)) touch('Set Object Path');
          }),
        )
      : null,
    flagToggles(r, 'read_data', 'Read Data', [['VERT', 'Vertex']]),
    bool(r, 'use_vertex_interpolation', 'Interpolate'),
    num(r, 'frame_offset', 'Frame Offset'),
    bool(r, 'override_frame', 'Override Frame'),
    r.override_frame ? num(r, 'frame', 'Frame', { anim: { ob, path: `modifiers["${m.name}"].frame` } }) : null,
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
  ];
};
