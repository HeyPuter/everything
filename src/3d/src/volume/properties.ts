// Properties editor for Volume objects: the Object Data tab (data-block, Grids, OpenVDB File,
// Viewport Display with slicing, Render) plus the Material and Modifiers tabs.
import { h, type Child } from '../ui/h';
import { app, onAppReady } from '../app/app';
import { propertiesTabs } from '../editors/properties/properties';
import { dataBlockSelector } from '../editors/properties/tabs';
import { uiList } from '../editors/properties/uilist';
import { panel, checkbox } from '../ui/widgets';
import { enumProp, num } from '../ui/props';
import { modifierTypes } from '../eval/modifiers';
import { cloneShared } from '../data/cow';
import { uid } from '../data/defaults';
import type { ObjectData } from '../data/types';
import { volumeOf, uniqueVolumeName } from './data';
import { gridRange, voxelSize } from './grid';
import type { VolumeData, VolumeGrid } from './types';

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc', 'geometry');
};

const TYPE_LABEL: Record<string, string> = { FLOAT: 'Float', VECTOR_FLOAT: 'Vector', INT: 'Integer', BOOLEAN: 'Boolean', MASK: 'Mask' };

const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(3));

function gridInfo(g: VolumeGrid): Child {
  const vs = voxelSize(g);
  const [lo, hi] = gridRange(g);
  const uniform = Math.abs(vs[0] - vs[1]) < 1e-6 * vs[0] && Math.abs(vs[0] - vs[2]) < 1e-6 * vs[0];
  return h(
    'div',
    { class: 'vol-grid-info' },
    h('div', { class: 'prop-note' }, `${g.dims.join(' × ')} voxels, ${uniform ? fmt(vs[0]) : vs.map(fmt).join(' × ')} m`),
    h('div', { class: 'prop-note' }, `${g.grid_class === 'LEVEL_SET' ? 'Distance' : 'Values'} ${fmt(lo)} … ${fmt(hi)}`),
  );
}

/** Data a list of evaluated grids came from: the object's stored grids or its modifier results. */
function gridsPanel(o: ObjectData, vo: VolumeData): Child {
  const ev = app.graph.get(o.id)?.mesh?.volume;
  const evaluated = ev && ev !== vo.grids ? ev : null;
  const shown = evaluated ?? vo.grids;
  const active = Math.min(vo.active_grid_index, shown.length - 1);
  return panel('vo-grids', 'Grids', () => [
    shown.length
      ? uiList(
          'vo-grid-list',
          shown.map((g) => ({ key: g.name, label: g.name, icon: g.data_type === 'VECTOR_FLOAT' ? 'grid_vector' : 'grid_float', right: h('span', { class: 'prop-note' }, TYPE_LABEL[g.data_type] ?? g.data_type), rightSize: 'compact' as const })),
          active,
          (i) => {
            vo.active_grid_index = i;
            app.changed('ui');
          },
          evaluated
            ? {}
            : {
                remove: () => app.run('volume.grid_remove'),
                up: () => app.run('volume.grid_move', { direction: 'UP' }),
                down: () => app.run('volume.grid_move', { direction: 'DOWN' }),
                rename: (i, name) => {
                  vo.active_grid_index = i;
                  app.run('volume.grid_rename', { name });
                },
              },
        )
      : h('div', { class: 'prop-note' }, 'No grids. Add a Mesh to Volume modifier, geometry nodes, or import an OpenVDB file.'),
    evaluated ? h('div', { class: 'prop-note' }, 'Grids produced by modifiers (read-only)') : null,
    shown[active] ? gridInfo(shown[active]) : null,
  ]);
}

function filePanel(vo: VolumeData): Child {
  return panel(
    'vo-file',
    'OpenVDB File',
    () => [
      h('div', { class: 'split-row' }, h('span', { class: 'split-label' }, 'File'), h('span', { class: 'prop-note vol-file' }, vo.filepath || 'None (grids are stored in the project)')),
      h(
        'div',
        { class: 'split-row' },
        h('span', { class: 'split-label' }),
        h('button', { class: 'btn', title: 'Load the grids of another OpenVDB file into this volume', onclick: () => app.run('volume.grids_load', {}, { invoke: true }) }, 'Load File…'),
      ),
    ],
    { closed: !vo.filepath },
  );
}

function displayPanel(vo: VolumeData): Child {
  const d = vo.display;
  const wireOn = d.wireframe_type === 'BOXES' || d.wireframe_type === 'POINTS';
  return panel('vo-display', 'Viewport Display', () => [
    enumProp(d, 'wireframe_type', 'Wireframe', [
      ['NONE', 'None'],
      ['BOUNDS', 'Bounds'],
      ['BOXES', 'Boxes'],
      ['POINTS', 'Points'],
    ]),
    wireOn
      ? enumProp(d, 'wireframe_detail', 'Detail', [
          ['COARSE', 'Coarse'],
          ['FINE', 'Fine'],
        ])
      : null,
    num(d, 'density', 'Density', { min: 0, max: 1000, softMax: 10, step: 0.1 }),
    enumProp(d, 'interpolation_method', 'Interpolation', [
      ['LINEAR', 'Linear'],
      ['CUBIC', 'Cubic'],
      ['CLOSEST', 'Closest'],
    ]),
    panel(
      'vo-slice',
      'Slice',
      () => [
        enumProp(d, 'slice_axis', 'Axis', [
          ['AUTO', 'Auto'],
          ['X', 'X'],
          ['Y', 'Y'],
          ['Z', 'Z'],
        ], { disabled: !d.use_slice }),
        num(d, 'slice_depth', 'Position', { min: 0, max: 1, slider: true, disabled: !d.use_slice }),
      ],
      { sub: true, closed: !d.use_slice, header: checkbox('vo-use-slice', '', d.use_slice, (v) => ((d.use_slice = v), app.pushUndo('Toggle Slice'), app.changed('doc')), { tip: 'Slice\nShow a single slice through the grid instead of the whole volume' }) },
    ),
  ]);
}

function renderPanel(vo: VolumeData): Child {
  const r = vo.render;
  return panel('vo-render', 'Render', () => [
    enumProp(r, 'space', 'Space', [
      ['OBJECT', 'Object'],
      ['WORLD', 'World'],
    ]),
    num(r, 'step_size', 'Step Size', { min: 0, max: 100, unit: r.space === 'WORLD' ? 'distance' : undefined, tip: 'Distance between ray-marching samples (0: from the voxel size)' }),
    num(r, 'clipping', 'Clipping', { min: 0, max: 1, step: 0.001, tip: 'Values below this count as empty space (faster rendering)' }),
    enumProp(r, 'precision', 'Precision', [
      ['FULL', 'Full'],
      ['HALF', 'Half'],
      ['VARIABLE', 'Variable'],
    ]),
  ]);
}

function volumeData(o: ObjectData, vo: VolumeData): Child {
  const doc = app.doc;
  const users = Object.values(doc.objects).filter((x) => x.data === vo.id).length;
  return [
    dataBlockSelector('vo', 'volume_data', Object.values(doc.volumes ?? {}), vo.id, (id) => id && ((o.data = id), changed('Assign Volume')), () => {}, {
      users,
      duplicate: () => {
        const d = cloneShared(vo);
        d.id = uid('vo');
        d.name = uniqueVolumeName(doc, vo.name);
        doc.volumes![d.id] = d;
        o.data = d.id;
        changed('Make Single User');
      },
    }),
    gridsPanel(o, vo),
    filePanel(vo),
    displayPanel(vo),
    renderPanel(vo),
  ];
}

const dataTab = propertiesTabs.find((t) => t.id === 'DATA');
if (dataTab) {
  const draw = dataTab.draw,
    poll = dataTab.poll;
  dataTab.draw = (p) => {
    const o = app.activeObject;
    const vo = volumeOf(app.doc, o);
    if (o && vo) return volumeData(o, vo);
    if (o?.type === 'VOLUME') return h('div', { class: 'prop-note' }, 'No data');
    return draw(p);
  };
  dataTab.poll = () => app.activeObject?.type === 'VOLUME' || poll();
  const prev = Object.getOwnPropertyDescriptor(dataTab, 'icon');
  const base = () => (prev?.get ? prev.get.call(dataTab) : prev?.value) as string;
  Object.defineProperty(dataTab, 'icon', { get: () => (app.activeObject?.type === 'VOLUME' ? 'volume_data' : base()), configurable: true });
}

for (const id of ['MATERIAL', 'MODIFIER']) {
  const tab = propertiesTabs.find((t) => t.id === id);
  if (!tab) continue;
  const poll = tab.poll;
  tab.poll = () => app.activeObject?.type === 'VOLUME' || poll();
}

// geometry nodes modifiers work on volume objects
onAppReady(() => {
  const t = modifierTypes.NODES;
  if (t) t.objectTypes = [...new Set([...(t.objectTypes ?? ['MESH', 'CURVE', 'FONT', 'LATTICE']), 'VOLUME'])];
});
