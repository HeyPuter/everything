// Panels of the Explode and Particle Instance modifiers.
import { h } from '../../../ui/h';
import { num, bool, splitRow } from '../../../ui/props';
import { enumRow, enumMenu, opButton } from '../../../ui/widgets';
import { app } from '../../../app/app';
import { modifierFields, modifierExtraUI } from '../stack';
import { vgroupRow, sub, objRow, boolToggles, touch } from './kit';

type Rec = Record<string, unknown>;

const SHOW: [string, string][] = [
  ['show_unborn', 'Unborn'],
  ['show_alive', 'Alive'],
  ['show_dead', 'Dead'],
];

modifierFields.EXPLODE = [];
modifierExtraUI.EXPLODE = (ob, m) => {
  const r = m as Rec;
  const hasParticles = ob.modifiers.some((x) => x.type === 'PARTICLE_SYSTEM');
  const me = ob.data ? app.doc.meshes[ob.data] : undefined;
  const uvName = me && me.uvs.length ? me.uv_map_name || 'UVMap' : '';
  return [
    hasParticles ? null : h('div', { class: 'mod-note' }, 'Add a particle system above this modifier: its particles carry the faces.'),
    splitRow(
      'Particle UV',
      enumMenu(`${m.id}.particle_uv`, [{ value: '', label: '—' }, ...(uvName ? [{ value: uvName, label: uvName, icon: 'uv' }] : [])], String(r.particle_uv ?? ''), (v) => ((r.particle_uv = v), touch('Set Particle UV'))),
    ),
    r.particle_uv ? h('div', { class: 'mod-note' }, 'The UV map holds the particle age (U from 0 at birth to 1 at death).') : null,
    boolToggles(m, 'Show', SHOW),
    bool(r, 'use_edge_cut', 'Cut Edges', { tip: 'Split faces between the particles their corners belong to' }),
    bool(r, 'use_size', 'Size'),
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
    r.vertex_group ? num(r, 'protect', 'Protect', { min: 0, max: 1, slider: true }) : null,
    h('div', { class: 'row-aligned', style: { padding: '2px 8px' } }, opButton('object.explode_refresh', 'Refresh', { modifier: m.name }, { tip: 'Simulate the particles again' })),
  ];
};

modifierFields.PARTICLE_INSTANCE = [];
modifierExtraUI.PARTICLE_INSTANCE = (ob, m) => {
  const r = m as Rec;
  const src = typeof r.object === 'string' ? app.doc.objects[r.object] : undefined;
  const count = src ? src.modifiers.filter((x) => x.type === 'PARTICLE_SYSTEM').length : 0;
  return [
    objRow(r, 'object', 'Object', (o) => o.id !== ob.id && o.modifiers.some((x) => x.type === 'PARTICLE_SYSTEM')),
    src ? num(r, 'particle_system_index', 'Particle System', { int: true, min: 1, max: Math.max(1, count) }) : null,
    splitRow(
      'Space',
      enumRow(
        `${m.id}.space`,
        [
          { value: 'LOCAL', label: 'Local' },
          { value: 'WORLD', label: 'World' },
        ],
        String(r.space ?? 'WORLD'),
        (v) => ((r.space = v), touch('Change Space')),
      ),
    ),
    bool(r, 'use_normal', 'Regular'),
    boolToggles(m, 'Show', SHOW),
    num(r, 'particle_amount', 'Amount', { min: 0, max: 1, slider: true }),
    num(r, 'particle_offset', 'Offset', { min: 0, max: 1, slider: true }),
    sub(m, 'rotation', 'Rotation', () => [
      splitRow(
        'Axis',
        enumRow(
          `${m.id}.axis`,
          ['X', 'Y', 'Z'].map((a) => ({ value: a, label: a })),
          String(r.axis ?? 'Z'),
          (v) => ((r.axis = v), touch('Change Axis')),
        ),
      ),
      num(r, 'rotation', 'Rotation', { min: 0, max: 1, slider: true }),
      num(r, 'random_rotation', 'Random', { min: 0, max: 1, slider: true }),
      bool(r, 'use_size', 'Size'),
    ]),
  ];
};
