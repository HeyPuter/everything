// Keying sets: user sets of property paths keyed together (Scene properties ▸ Keying Sets),
// the active keying set used by Insert Keyframe, and the per-property animation menu
// (right-click a property's keyframe decorator).
import { app, registerOperators, onAppReady, operators, type Operator } from '../app/app';
import type { DocumentData, KeyingSetData, ObjectData } from '../data/types';
import { h, type Child } from '../ui/h';
import { panel, checkbox, textField, enumMenu, opButton, numberField } from '../ui/widgets';
import { openMenu, type MenuItem } from '../ui/menu';
import { uiList } from '../editors/properties/uilist';
import { sceneKeyingPanel } from '../editors/properties/tabs';
import { propertyAnimMenuHook } from '../ui/props';
import { keyProperty, keyState } from './keyframes';
import { objectCurves } from './slots';

export const BUILTIN_KEYING_SETS: [string, string][] = [
  ['Location', 'Location'],
  ['Rotation', 'Rotation'],
  ['Scale', 'Scale'],
  ['LocRotScale', 'Location, Rotation & Scale'],
  ['Available', 'Available'],
  ['WholeCharacter', 'Whole Character'],
];

const sets = (doc: DocumentData = app.doc) => (doc.scene.keying_sets ??= []);

/** Built-in and user keying sets as [value, label] pairs (user sets are `KS:<name>`). */
export function keyingSetItems(doc: DocumentData = app.doc): [string, string][] {
  return [...BUILTIN_KEYING_SETS, ...(doc.scene.keying_sets ?? []).map((k): [string, string] => [`KS:${k.name}`, k.name])];
}

/** The active user keying set (null when a built-in set is active). */
export function activeUserSet(doc: DocumentData = app.doc): KeyingSetData | null {
  const ks = doc.scene.keying_set ?? '';
  return ks.startsWith('KS:') ? (doc.scene.keying_sets?.find((k) => k.name === ks.slice(3)) ?? null) : null;
}

function uniqueSetName(base: string) {
  const taken = new Set(sets().map((k) => k.name));
  if (!taken.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!taken.has(n)) return n;
  }
}

/** Add a property path to a keying set (no duplicates; an "all elements" path covers single ones). */
export function addKeyingPath(set: KeyingSetData, id: string, path: string, index: number): boolean {
  if (set.paths.some((p) => p.id === id && p.data_path === path && (p.index === index || p.index === -1))) return false;
  if (index === -1) set.paths = set.paths.filter((p) => !(p.id === id && p.data_path === path));
  set.paths.push({ id, data_path: path, index });
  set.active_path_index = set.paths.length - 1;
  return true;
}

export function removeKeyingPath(set: KeyingSetData, id: string, path: string, index: number): boolean {
  const before = set.paths.length;
  set.paths = set.paths.filter((p) => !(p.id === id && p.data_path === path && (index === -1 || p.index === index || p.index === -1)));
  set.active_path_index = Math.max(0, Math.min(set.active_path_index ?? 0, set.paths.length - 1));
  return set.paths.length !== before;
}

const targetProps = [
  { id: 'object', label: 'Object', type: 'string' as const, default: '', hidden: true },
  { id: 'data_path', label: 'Data Path', type: 'string' as const, default: '', hidden: true },
  { id: 'index', label: 'Index', type: 'int' as const, default: -1, hidden: true },
  { id: 'all', label: 'All', type: 'bool' as const, default: true },
];

function target(p: Record<string, unknown>): { ob: ObjectData; path: string; index: number } | null {
  const ob = (p.object ? app.doc.objects[p.object as string] : undefined) ?? app.activeObject;
  if (!ob || !p.data_path) return null;
  return { ob, path: p.data_path as string, index: p.all ? -1 : (p.index as number) };
}

const ops: Operator[] = [
  {
    idname: 'anim.keying_set_add',
    label: 'Add Empty Keying Set',
    description: 'Add a new, empty keying set and make it active',
    exec: (ctx) => {
      const name = uniqueSetName('Keying Set');
      sets(ctx.doc).push({ name, paths: [] });
      ctx.doc.scene.keying_set = `KS:${name}`;
    },
  },
  {
    idname: 'anim.keying_set_remove',
    label: 'Remove Active Keying Set',
    description: 'Remove the active user keying set',
    poll: (ctx) => !!activeUserSet(ctx.doc),
    exec: (ctx) => {
      const set = activeUserSet(ctx.doc)!;
      const list = sets(ctx.doc);
      const i = list.indexOf(set);
      list.splice(i, 1);
      const next = list[Math.min(i, list.length - 1)];
      ctx.doc.scene.keying_set = next ? `KS:${next.name}` : 'LocRotScale';
    },
  },
  {
    idname: 'anim.keying_set_path_add',
    label: 'Add Empty Keying Set Path',
    description: 'Add an empty path to the active keying set',
    poll: (ctx) => !!activeUserSet(ctx.doc),
    exec: (ctx) => {
      const set = activeUserSet(ctx.doc)!;
      set.paths.push({ id: app.activeObject?.id ?? null, data_path: '', index: -1 });
      set.active_path_index = set.paths.length - 1;
    },
  },
  {
    idname: 'anim.keying_set_path_remove',
    label: 'Remove Active Keying Set Path',
    description: 'Remove the active path from the active keying set',
    poll: (ctx) => !!activeUserSet(ctx.doc)?.paths.length,
    exec: (ctx) => {
      const set = activeUserSet(ctx.doc)!;
      set.paths.splice(set.active_path_index ?? 0, 1);
      set.active_path_index = Math.max(0, Math.min(set.active_path_index ?? 0, set.paths.length - 1));
    },
  },
  {
    idname: 'anim.keyingset_button_add',
    label: 'Add to Keying Set',
    description: 'Add the property to the active keying set (a new one is made when a built-in set is active)',
    props: targetProps,
    exec: (ctx, p) => {
      const t = target(p);
      if (!t) return 'CANCELLED';
      let set = activeUserSet(ctx.doc);
      if (!set) {
        set = { name: uniqueSetName('Button Keying Set'), paths: [] };
        sets(ctx.doc).push(set);
        ctx.doc.scene.keying_set = `KS:${set.name}`;
      }
      if (!addKeyingPath(set, t.ob.id, t.path, t.index)) return 'CANCELLED';
    },
  },
  {
    idname: 'anim.keyingset_button_remove',
    label: 'Remove from Keying Set',
    description: 'Remove the property from the active keying set',
    props: targetProps,
    poll: (ctx) => !!activeUserSet(ctx.doc),
    exec: (ctx, p) => {
      const t = target(p);
      if (!t || !removeKeyingPath(activeUserSet(ctx.doc)!, t.ob.id, t.path, p.all ? -1 : (p.index as number))) return 'CANCELLED';
    },
  },
  {
    idname: 'anim.keyframe_insert_button',
    label: 'Insert Keyframe (Buttons)',
    description: 'Insert a keyframe for the property (all elements, or one)',
    props: targetProps,
    exec: (ctx, p) => {
      const t = target(p);
      if (!t) return 'CANCELLED';
      keyProperty(ctx.doc, t.ob, t.path, t.index);
    },
  },
  {
    idname: 'anim.keyframe_delete_button',
    label: 'Delete Keyframe (Buttons)',
    description: 'Delete the property’s keyframe on the current frame',
    props: targetProps,
    exec: (ctx, p) => {
      const t = target(p);
      const act = t?.ob.animation_data?.action ? ctx.doc.actions[t.ob.animation_data.action] : undefined;
      if (!t || !act) return 'CANCELLED';
      const f = ctx.doc.scene.frame_current;
      let n = 0;
      const mine = new Set(objectCurves(ctx.doc, t.ob));
      for (const fc of mine) {
        if (fc.data_path !== t.path || (t.index >= 0 && fc.array_index !== t.index)) continue;
        const before = fc.keyframe_points.length;
        fc.keyframe_points = fc.keyframe_points.filter((k) => Math.abs(k.co[0] - f) > 0.5);
        n += before - fc.keyframe_points.length;
      }
      act.fcurves = act.fcurves.filter((fc) => !mine.has(fc) || fc.keyframe_points.length || fc.modifiers.length);
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'anim.keyframe_clear_button',
    label: 'Clear Keyframe (Buttons)',
    description: 'Remove all keyframes (the whole F-Curve) of the property',
    props: targetProps,
    exec: (ctx, p) => {
      const t = target(p);
      const act = t?.ob.animation_data?.action ? ctx.doc.actions[t.ob.animation_data.action] : undefined;
      if (!t || !act) return 'CANCELLED';
      const before = act.fcurves.length;
      const mine = new Set(objectCurves(ctx.doc, t.ob));
      act.fcurves = act.fcurves.filter((fc) => !(mine.has(fc) && fc.data_path === t.path && (t.index < 0 || fc.array_index === t.index)));
      if (act.fcurves.length === before) return 'CANCELLED';
    },
  },
];

// The *_button operators take an explicit property (decorator menus); without one they defer to
// the hovered-button versions registered by the UI layer.
const buttonOps = new Set(['anim.keyframe_insert_button', 'anim.keyframe_delete_button', 'anim.keyframe_clear_button']);
registerOperators(ops.filter((o) => !buttonOps.has(o.idname)));
onAppReady(() => {
  for (const def of ops.filter((o) => buttonOps.has(o.idname))) {
    const prev = operators.get(def.idname);
    if (!prev) {
      registerOperators([def]);
      continue;
    }
    const explicit = (p: Record<string, unknown>) => !!p.data_path;
    registerOperators([
      {
        ...prev,
        props: [...targetProps.filter((d) => !(prev.props ?? []).some((x) => x.id === d.id)), ...(prev.props ?? [])],
        // menus pass an explicit property, so the operator stays available without a hovered button
        poll: () => true,
        exec: (ctx, p) => (explicit(p) ? def.exec!(ctx, p) : prev.exec && (!prev.poll || prev.poll(ctx)) ? prev.exec(ctx, p) : 'CANCELLED'),
      },
    ]);
  }
});

/** Extra entries for the property animation menu (drivers, Graph Editor…), added by other modules. */
export const propertyAnimExtraItems: ((ob: ObjectData, path: string, index: number) => MenuItem[])[] = [];

/** Animation menu for a property (keyframe decorator right-click). */
export function propertyAnimMenu(ob: ObjectData, path: string, index: number): MenuItem[] {
  const st = keyState(app.doc, ob, path, index);
  const t = { object: ob.id, data_path: path, index };
  const items: MenuItem[] = [
    { label: 'Insert Keyframes', op: 'anim.keyframe_insert_button', props: { ...t, all: true }, shortcut: 'I' },
    ...(index >= 0 ? [{ label: 'Insert Single Keyframe', op: 'anim.keyframe_insert_button', props: { ...t, all: false } }] : []),
  ];
  if (st !== 'none' && st !== 'driven')
    items.push(
      { label: 'Delete Keyframes', op: 'anim.keyframe_delete_button', props: { ...t, all: true }, shortcut: 'Alt I' },
      { label: 'Clear Keyframes', op: 'anim.keyframe_clear_button', props: { ...t, all: true }, shortcut: 'Shift Alt I' },
    );
  items.push(
    { separator: true },
    { label: 'Add All to Keying Set', op: 'anim.keyingset_button_add', props: { ...t, all: true } },
    ...(index >= 0 ? [{ label: 'Add Single to Keying Set', op: 'anim.keyingset_button_add', props: { ...t, all: false } }] : []),
    { label: 'Remove from Keying Set', op: 'anim.keyingset_button_remove', props: { ...t, all: true } },
    { separator: true },
    st === 'driven' ? { label: 'Delete Drivers', op: 'anim.driver_button_remove', props: t } : { label: 'Add Driver', op: 'anim.driver_button_add', props: t },
    ...propertyAnimExtraItems.flatMap((f) => f(ob, path, index)),
    { separator: true },
    {
      label: 'Copy Data Path',
      action: () => void navigator.clipboard?.writeText(index >= 0 ? `${path}[${index}]` : path).catch(() => {}),
    },
  );
  return items;
}

/** Open the property animation menu at the pointer. */
export function openPropertyAnimMenu(e: MouseEvent, ob: ObjectData, path: string, index: number) {
  e.preventDefault();
  openMenu(propertyAnimMenu(ob, path, index), { x: e.clientX, y: e.clientY });
}

// ---------------------------------------------------------------------------
// Scene properties panel

sceneKeyingPanel.draw = () => keyingSetsPanel();
propertyAnimMenuHook.open = openPropertyAnimMenu;

export function keyingSetsPanel(): Child {
  const s = app.doc.scene;
  const list = s.keying_sets ?? [];
  const active = activeUserSet();
  const changed = (label: string) => (app.pushUndo(label), app.changed('doc'));
  return [
    panel('sc-keying', 'Keying Sets', () => [
      uiList(
        'keyingsets',
        list.map((k) => ({ key: k.name, label: k.name, icon: 'keyframe' })),
        active ? list.indexOf(active) : -1,
        (i) => ((s.keying_set = `KS:${list[i].name}`), changed('Active Keying Set')),
        {
          add: () => app.run('anim.keying_set_add'),
          remove: () => app.run('anim.keying_set_remove'),
          rename: (i, name) => {
            const k = list[i];
            if (!k || !name) return;
            const was = s.keying_set === `KS:${k.name}`;
            k.name = uniqueSetName(name);
            if (was) s.keying_set = `KS:${k.name}`;
            changed('Rename Keying Set');
          },
        },
      ),
      h(
        'div',
        { class: 'split-row' },
        h('div', { class: 'sr-label' }, 'Active Keying Set'),
        h(
          'div',
          { class: 'sr-value' },
          enumMenu(
            'sc-ks-active',
            keyingSetItems().map(([value, label]) => ({ value, label })),
            s.keying_set ?? 'LocRotScale',
            (v) => ((s.keying_set = v as 'Location'), changed('Active Keying Set')),
          ),
        ),
        h('span'),
      ),
    ]),
    active
      ? panel('sc-keying-paths', 'Active Keying Set', () => {
          const idx = active.active_path_index ?? 0;
          const path = active.paths[idx];
          const obs = Object.values(app.doc.objects);
          return [
            uiList(
              'keyingpaths',
              active.paths.map((p, i) => ({ key: `${i}`, label: `${p.id ? (app.doc.objects[p.id]?.name ?? '?') : '—'}: ${p.data_path || '(empty)'}${p.index >= 0 ? `[${p.index}]` : ''}`, icon: 'object' })),
              idx,
              (i) => ((active.active_path_index = i), app.changed('doc')),
              { add: () => app.run('anim.keying_set_path_add'), remove: () => app.run('anim.keying_set_path_remove') },
            ),
            path
              ? [
                  h(
                    'div',
                    { class: 'split-row' },
                    h('div', { class: 'sr-label' }, 'Target'),
                    h(
                      'div',
                      { class: 'sr-value' },
                      enumMenu(
                        'ks-path-id',
                        obs.map((o) => ({ value: o.id, label: o.name })),
                        path.id ?? '',
                        (v) => ((path.id = v), changed('Keying Set Path Target')),
                      ),
                    ),
                    h('span'),
                  ),
                  h(
                    'div',
                    { class: 'split-row' },
                    h('div', { class: 'sr-label' }, 'Data Path'),
                    h(
                      'div',
                      { class: 'sr-value' },
                      textField('ks-path-dp', path.data_path, (v) => ((path.data_path = v), changed('Keying Set Path'))),
                    ),
                    h('span'),
                  ),
                  h(
                    'div',
                    { class: 'split-row check' },
                    h('div', { class: 'sr-label' }),
                    h(
                      'div',
                      { class: 'sr-value' },
                      checkbox('ks-path-all', 'Array All Items', path.index < 0, (v) => ((path.index = v ? -1 : 0), changed('Keying Set Path'))),
                    ),
                    h('span'),
                  ),
                  path.index >= 0
                    ? h(
                        'div',
                        { class: 'split-row' },
                        h('div', { class: 'sr-label' }, 'Index'),
                        h('div', { class: 'sr-value' }, numberField({ id: 'ks-path-index', value: path.index, int: true, min: 0, set: (v, f) => ((path.index = Math.max(0, Math.round(v))), app.changed('doc'), f && app.pushUndo('Keying Set Path')) })),
                        h('span'),
                      )
                    : null,
                ]
              : null,
            h('div', { class: 'btn-row' }, opButton('anim.keyframe_insert', 'Insert Keyframes')),
          ];
        })
      : null,
  ];
}
