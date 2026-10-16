// Properties editor for Point Cloud objects: the Object Data tab (data-block, Attributes) plus
// the Material and Modifiers tabs.
import { h, type Child } from '../ui/h';
import { app, onAppReady } from '../app/app';
import { propertiesTabs } from '../editors/properties/properties';
import { dataBlockSelector } from '../editors/properties/tabs';
import { uiList } from '../editors/properties/uilist';
import { panel } from '../ui/widgets';
import { modifierTypes } from '../eval/modifiers';
import { cloneShared } from '../data/cow';
import { uid } from '../data/defaults';
import type { ObjectData } from '../data/types';
import { pointCloudOf, pointCount, uniquePointCloudName } from './data';
import type { PointCloudData } from './types';

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc', 'geometry');
};

const TYPE_LABEL: Record<string, string> = { FLOAT: 'Float', INT: 'Integer', INT8: '8-Bit Integer', BOOLEAN: 'Boolean', FLOAT_VECTOR: 'Vector', FLOAT2: '2D Vector', FLOAT_COLOR: 'Color', QUATERNION: 'Quaternion' };

function attributesPanel(pc: PointCloudData): Child {
  // position is built in (shown first, not removable); internal attributes are hidden
  const list = pc.attributes.map((a, i) => ({ a, i })).filter(({ a }) => !a.name.startsWith('.'));
  const rows = [{ key: 'position', label: 'position', icon: 'group_vcol', right: h('span', { class: 'prop-note' }, 'Vector'), rightSize: 'compact' as const }, ...list.map(({ a }) => ({ key: a.name, label: a.name, icon: 'group_vcol', right: h('span', { class: 'prop-note' }, TYPE_LABEL[a.data_type] ?? a.data_type), rightSize: 'compact' as const }))];
  const active = list.findIndex((x) => x.i === (pc.active_attribute ?? -1)) + 1;
  return panel('pc-attrs', 'Attributes', () => [
    uiList(
      'pc-attributes',
      rows,
      active,
      (k) => {
        pc.active_attribute = k === 0 ? -1 : (list[k - 1]?.i ?? -1);
        app.changed('ui');
      },
      {
        add: () => app.run('geometry.attribute_add_pointcloud', {}, { invoke: true }),
        remove: () => app.run('geometry.attribute_remove_pointcloud'),
        rename: (k, name) => {
          const it = list[k - 1];
          if (!it || !name || name === 'position' || pc.attributes.some((x) => x.name === name)) return;
          pc.attributes = pc.attributes.map((x, j) => (j === it.i ? { ...x, name } : x));
          changed('Rename Attribute');
        },
      },
    ),
    h('div', { class: 'prop-note' }, `${pointCount(pc).toLocaleString()} points`),
  ]);
}

function pointCloudData(o: ObjectData, pc: PointCloudData): Child {
  const doc = app.doc;
  const users = Object.values(doc.objects).filter((x) => x.data === pc.id).length;
  return [
    dataBlockSelector('pc', 'pointcloud_data', Object.values(doc.pointclouds ?? {}), pc.id, (id) => id && ((o.data = id), changed('Assign Point Cloud')), () => {}, {
      users,
      duplicate: () => {
        const d = cloneShared(pc);
        d.id = uid('pc');
        d.name = uniquePointCloudName(doc, pc.name);
        doc.pointclouds![d.id] = d;
        o.data = d.id;
        changed('Make Single User');
      },
    }),
    attributesPanel(pc),
  ];
}

const dataTab = propertiesTabs.find((t) => t.id === 'DATA');
if (dataTab) {
  const draw = dataTab.draw,
    poll = dataTab.poll;
  dataTab.draw = (p) => {
    const o = app.activeObject;
    const pc = pointCloudOf(app.doc, o);
    if (o && pc) return pointCloudData(o, pc);
    return draw(p);
  };
  dataTab.poll = () => app.activeObject?.type === 'POINTCLOUD' || poll();
  const prev = Object.getOwnPropertyDescriptor(dataTab, 'icon');
  const base = () => (prev?.get ? prev.get.call(dataTab) : prev?.value) as string;
  Object.defineProperty(dataTab, 'icon', { get: () => (app.activeObject?.type === 'POINTCLOUD' ? 'pointcloud_data' : base()), configurable: true });
}

for (const id of ['MATERIAL', 'MODIFIER']) {
  const tab = propertiesTabs.find((t) => t.id === id);
  if (!tab) continue;
  const poll = tab.poll;
  tab.poll = () => app.activeObject?.type === 'POINTCLOUD' || poll();
}

onAppReady(() => {
  const t = modifierTypes.NODES;
  if (t) t.objectTypes = [...new Set([...(t.objectTypes ?? ['MESH', 'CURVE', 'FONT', 'LATTICE']), 'POINTCLOUD'])];
});
