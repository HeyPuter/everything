// Properties editor for Curves objects: the Object Data tab (data-block, Surface, Attributes),
// plus the Material and Modifiers tabs (geometry nodes) for this object type.
import { h, type Child } from '../ui/h';
import { app, onAppReady, registerOperators } from '../app/app';
import { propertiesTabs } from '../editors/properties/properties';
import { dataBlockSelector } from '../editors/properties/tabs';
import { uiList } from '../editors/properties/uilist';
import { panel } from '../ui/widgets';
import { bool, objectProp, textProp } from '../ui/props';
import { modifierTypes } from '../eval/modifiers';
import type { ObjectData } from '../data/types';
import { allocData, type DataType } from '../geonodes/types';
import { cloneHair, curveCount, domainSize, hairOf, pointCount, uniqueHairName } from './data';
import { uid } from '../data/defaults';
import type { HairCurvesData, HairDomain } from './types';

const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc', 'geometry');
};

const TYPE_LABEL: Record<string, string> = {
  FLOAT: 'Float',
  INT: 'Integer',
  INT8: '8-Bit Integer',
  BOOLEAN: 'Boolean',
  FLOAT_VECTOR: 'Vector',
  FLOAT2: '2D Vector',
  FLOAT_COLOR: 'Color',
  QUATERNION: 'Quaternion',
};

function attributesPanel(hc: HairCurvesData): Child {
  const list = hc.attributes.map((a, i) => ({ a, i })).filter(({ a }) => !a.name.startsWith('.'));
  const active = list.findIndex((x) => x.i === (hc.active_attribute ?? -1));
  return panel('hc-attrs', 'Attributes', () => [
    uiList(
      'hc-attributes',
      list.map(({ a }) => ({ key: a.name, label: a.name, icon: 'group_vcol', right: h('span', { class: 'prop-note' }, `${a.domain === 'POINT' ? 'Point' : 'Curve'} ▸ ${TYPE_LABEL[a.data_type] ?? a.data_type}`), rightSize: 'wide' })),
      active,
      (k) => {
        hc.active_attribute = list[k]?.i ?? -1;
        app.changed('ui');
      },
      {
        add: () => app.run('curves.attribute_add', {}, { invoke: true }),
        remove: () => app.run('curves.attribute_remove'),
        rename: (k, name) => {
          const it = list[k];
          if (!it || !name || hc.attributes.some((x) => x.name === name)) return;
          hc.attributes = hc.attributes.map((x, j) => (j === it.i ? { ...x, name } : x));
          changed('Rename Attribute');
        },
      },
    ),
    h('div', { class: 'prop-note' }, `${curveCount(hc)} curves, ${pointCount(hc)} points`),
  ]);
}

function surfacePanel(hc: HairCurvesData): Child {
  const surf = hc.surface ? app.doc.objects[hc.surface] : null;
  const me = surf?.type === 'MESH' && surf.data ? app.doc.meshes[surf.data] : null;
  return panel('hc-surface', 'Surface', () => [
    objectProp(hc, 'surface', 'Surface', { filter: (o) => o.type === 'MESH', none: 'None' }),
    me ? textProp(hc, 'surface_uv_map', 'UV Map') : null,
    bool(hc, 'use_sculpt_collision', 'Surface Collision'),
  ]);
}

function hairData(o: ObjectData, hc: HairCurvesData): Child {
  const doc = app.doc;
  const users = Object.values(doc.objects).filter((x) => x.data === hc.id).length;
  return [
    dataBlockSelector('hc', 'curves_data', Object.values(doc.hair_curves ?? {}), hc.id, (id) => id && ((o.data = id), changed('Assign Curves')), () => {}, {
      users,
      duplicate: () => {
        const d = cloneHair(hc);
        d.id = uid('hc');
        d.name = uniqueHairName(doc, hc.name);
        doc.hair_curves![d.id] = d;
        o.data = d.id;
        changed('Make Single User');
      },
    }),
    attributesPanel(hc),
    surfacePanel(hc),
  ];
}

const dataTab = propertiesTabs.find((t) => t.id === 'DATA');
if (dataTab) {
  const draw = dataTab.draw,
    poll = dataTab.poll;
  dataTab.draw = (p) => {
    const o = app.activeObject;
    const hc = hairOf(app.doc, o);
    if (o && hc) return hairData(o, hc);
    return draw(p);
  };
  dataTab.poll = () => app.activeObject?.type === 'CURVES' || poll();
  const prev = Object.getOwnPropertyDescriptor(dataTab, 'icon');
  const base = () => (prev?.get ? prev.get.call(dataTab) : prev?.value) as string;
  Object.defineProperty(dataTab, 'icon', { get: () => (app.activeObject?.type === 'CURVES' ? 'curves_data' : base()), configurable: true });
}

for (const id of ['MATERIAL', 'MODIFIER']) {
  const tab = propertiesTabs.find((t) => t.id === id);
  if (!tab) continue;
  const poll = tab.poll;
  tab.poll = () => app.activeObject?.type === 'CURVES' || poll();
}

// geometry nodes modifiers work on Curves objects
onAppReady(() => {
  const t = modifierTypes.NODES;
  if (t) t.objectTypes = [...(t.objectTypes ?? ['MESH', 'CURVE', 'FONT', 'LATTICE']), 'CURVES'];
});

// ---------------------------------------------------------------------------
// attribute add / remove

const DOMAINS: [string, string][] = [
  ['POINT', 'Point'],
  ['CURVE', 'Curve'],
];
const TYPES: [string, string][] = Object.entries(TYPE_LABEL).filter(([k]) => k !== 'QUATERNION') as [string, string][];

const activeCurves = () => hairOf(app.doc, app.activeObject);

registerOperators([
  {
    idname: 'curves.attribute_add',
    label: 'Add Attribute',
    description: 'Add an attribute to the curves',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: 'Attribute' },
      { id: 'domain', label: 'Domain', type: 'enum', default: 'POINT', items: DOMAINS },
      { id: 'data_type', label: 'Data Type', type: 'enum', default: 'FLOAT', items: TYPES },
    ],
    poll: () => !!activeCurves(),
    exec: (_c, p) => {
      const hc = activeCurves()!;
      let name = (p.name as string) || 'Attribute';
      const base = name;
      for (let i = 1; hc.attributes.some((a) => a.name === name); i++) name = `${base}.${String(i).padStart(3, '0')}`;
      const domain = p.domain as HairDomain;
      const type = p.data_type as DataType;
      hc.attributes = [...hc.attributes, { name, domain, data_type: type, data: allocData(type, domainSize(hc, domain)) }];
      hc.active_attribute = hc.attributes.length - 1;
    },
  },
  {
    idname: 'curves.attribute_remove',
    label: 'Remove Attribute',
    description: 'Remove the active attribute',
    poll: () => {
      const hc = activeCurves();
      return !!hc && (hc.active_attribute ?? -1) >= 0 && !!hc.attributes[hc.active_attribute ?? -1];
    },
    exec: () => {
      const hc = activeCurves()!;
      const i = hc.active_attribute ?? -1;
      hc.attributes = hc.attributes.filter((_, k) => k !== i);
      hc.active_attribute = Math.min(i, hc.attributes.length - 1);
    },
  },
]);
