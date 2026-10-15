// Properties editor: Object Data tab for metaballs (surface settings and the active element),
// and material slots for metaball objects.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { propertiesTabs } from '../editors/properties/properties';
import { dataBlockSelector } from '../editors/properties/tabs';
import { panel } from '../ui/widgets';
import { num, bool, enumProp, vecProp } from '../ui/props';
import { cloneShared } from '../data/cow';
import { uid } from '../data/defaults';
import type { ObjectData } from '../data/types';
import { ELEMENT_TYPES, metaballOf } from './data';
import { uniqueMetaballName } from './ops';
import type { MetaballData } from './types';

function changed(label: string) {
  app.pushUndo(label);
  app.changed('doc', 'geometry');
}

function activeElementPanel(mb: MetaballData): Child {
  const i = mb.active_element ?? -1;
  const e = i >= 0 ? mb.elements[i] : undefined;
  if (!e) return null;
  const sizes =
    e.type === 'CAPSULE'
      ? [num(e, 'size_x', 'Size X', { unit: 'distance', min: 0 })]
      : e.type === 'PLANE'
        ? [num(e, 'size_x', 'Size X', { unit: 'distance', min: 0 }), num(e, 'size_y', 'Y', { unit: 'distance', min: 0 })]
        : e.type === 'BALL'
          ? []
          : [num(e, 'size_x', 'Size X', { unit: 'distance', min: 0 }), num(e, 'size_y', 'Y', { unit: 'distance', min: 0 }), num(e, 'size_z', 'Z', { unit: 'distance', min: 0 })];
  return panel('mb-element', 'Active Element', () => [
    enumProp(
      e,
      'type',
      'Type',
      ELEMENT_TYPES.map(([v, l]) => [v, l] as [string, string]),
    ),
    num(e, 'stiffness', 'Stiffness', { min: 0, max: 10 }),
    num(e, 'radius', 'Radius', { unit: 'distance', min: 0 }),
    ...sizes,
    vecProp(e, 'co', 'Location', { unit: 'distance' }),
    bool(e, 'use_negative', 'Negative'),
    bool(e, 'hide', 'Hide'),
  ]);
}

function metaballData(o: ObjectData, mb: MetaballData): Child {
  const doc = app.doc;
  const users = Object.values(doc.objects).filter((x) => x.data === mb.id).length;
  return [
    dataBlockSelector('mb', 'meta_data', Object.values(doc.metaballs ?? {}), mb.id, (id) => id && ((o.data = id), changed('Assign Metaball')), () => {}, {
      users,
      duplicate: () => {
        const d = cloneShared(mb);
        d.id = uid('mb');
        d.name = uniqueMetaballName(doc, mb.name);
        doc.metaballs![d.id] = d;
        o.data = d.id;
        changed('Make Single User');
      },
    }),
    panel('mb-settings', 'Metaball', () => [
      num(mb, 'resolution', 'Resolution Viewport', { unit: 'distance', min: 0.005, max: 10, softMin: 0.05, step: 0.1 }),
      num(mb, 'render_resolution', 'Render', { unit: 'distance', min: 0.005, max: 10, softMin: 0.025, step: 0.1 }),
      num(mb, 'threshold', 'Influence Threshold', { min: 0, max: 5 }),
      enumProp(mb, 'update_method', 'Update on Edit', [
        ['UPDATE_ALWAYS', 'Always'],
        ['HALFRES', 'Half'],
        ['FAST', 'Fast'],
        ['NEVER', 'Never'],
      ]),
    ]),
    app.doc.mode === 'EDIT' ? activeElementPanel(mb) : null,
  ];
}

const dataTab = propertiesTabs.find((t) => t.id === 'DATA');
if (dataTab) {
  const draw = dataTab.draw,
    poll = dataTab.poll;
  dataTab.poll = () => app.activeObject?.type === 'META' || poll();
  dataTab.draw = (p) => {
    const o = app.activeObject;
    const mb = metaballOf(app.doc, o);
    if (o && mb) return metaballData(o, mb);
    if (o?.type === 'META') return h('div', { class: 'prop-note' }, 'No data');
    return draw(p);
  };
  // the tab icon follows the object type
  const prev = Object.getOwnPropertyDescriptor(dataTab, 'icon');
  const base = () => (prev?.get ? prev.get.call(dataTab) : prev?.value) as string;
  Object.defineProperty(dataTab, 'icon', { get: () => (app.activeObject?.type === 'META' ? 'meta_data' : base()), configurable: true });
}

const matTab = propertiesTabs.find((t) => t.id === 'MATERIAL');
if (matTab) {
  const poll = matTab.poll;
  matTab.poll = () => app.activeObject?.type === 'META' || poll();
}
