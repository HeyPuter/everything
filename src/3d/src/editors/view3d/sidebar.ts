// Viewport sidebar (N panel): Item / Tool / View tabs.
import { propertyAnimMenuHook } from '../../ui/props';
import { Box3, Vector3, Euler, Quaternion } from 'three';
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import type { View3D } from './view3d';
import { panel, numberField, row, col, checkbox, enumMenu, decorator, opButton } from '../../ui/widgets';
import type { ObjectData } from '../../data/types';
import { keyState, keyProperty } from '../../anim/keyframes';
import { renderContext } from '../../render/context';
import { toolHeader } from './toolbar';
import { toolOptions } from './tooloptions';
import { bindProp } from '../../ui/binding';

export const sidebarTabs: { id: string; label: string; draw: (v: View3D) => Child; poll?: () => boolean }[] = [];

/** Bind a vector component of an object property to a number field. */
export function vecField(ob: ObjectData, key: 'location' | 'rotation_euler' | 'scale' | 'delta_location' | 'delta_scale' | 'delta_rotation_euler', i: number, label: string, unit: 'distance' | 'angle' | 'none') {
  const st = keyState(app.doc, ob, key, i);
  // generic button actions (I, Backspace, Ctrl+C/V, right-click menu) work on these fields too
  bindProp({ id: `${ob.id}.${key}.${i}`, owner: ob as unknown as Record<string, unknown>, key, index: i, label: `${key.replace(/_euler$/, '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())} ${label}`, kind: 'vector', anim: { ob, path: key, index: i } });
  return h(
    'div',
    { class: 'vec-row', key: `${key}${i}` },
    numberField({
      id: `${ob.id}.${key}.${i}`,
      label,
      value: (ob[key] as number[])[i],
      unit,
      precision: unit === 'none' ? 3 : 4,
      anim: st === 'none' ? null : st,
      set: (v, final) => {
        (ob[key] as number[])[i] = v;
        if (app.doc.scene.tool_settings.use_keyframe_insert_auto && final && st !== 'none') keyProperty(app.doc, ob, key, i);
        app.changed('doc');
        if (final) app.pushUndo(`Change ${label}`);
      },
    }),
    lockButton(ob, key, i),
    decorator(
      st,
      () => {
        keyProperty(app.doc, ob, key, i);
        app.pushUndo('Insert Keyframe');
        app.changed('doc');
      },
      propertyAnimMenuHook.open ? (e: MouseEvent) => propertyAnimMenuHook.open!(e, ob, key, i) : undefined,
    ),
  );
}

function lockButton(ob: ObjectData, key: string, i: number) {
  const lk = `lock_${key.replace('_euler', '')}` as 'lock_location';
  const locked = !!ob[lk]?.[i];
  if (!ob[lk]) return h('span', { class: 'lock-btn' });
  return h('button', {
      class: { 'lock-btn': true, on: locked },
      'data-tip': 'Lock\nDisable editing of this channel in the interface',
      onclick: () => {
        const lk = `lock_${key.replace('_euler', '')}` as 'lock_location';
        if (!ob[lk]) return;
        ob[lk][i] = !ob[lk][i];
        app.pushUndo('Lock');
        app.changed('doc');
      },
    }, icon(locked ? 'locked' : 'unlocked'));
}

function objectTransform(ob: ObjectData): Child {
  const rotLabel = ob.rotation_mode === 'QUATERNION' ? 'Rotation' : ob.rotation_mode === 'AXIS_ANGLE' ? 'Rotation' : 'Rotation';
  const ev = app.graph.get(ob.id);
  const box = new Box3();
  if (ev?.mesh) {
    const P = ev.mesh.positions;
    for (let i = 0; i < P.length; i += 3) box.expandByPoint(new Vector3(P[i], P[i + 1], P[i + 2]));
  }
  const dims = box.isEmpty() ? [0, 0, 0] : box.getSize(new Vector3()).multiply(new Vector3(...ob.scale)).toArray();
  return [
    h('div', { class: 'sb-label' }, 'Location:'),
    col(vecField(ob, 'location', 0, 'X', 'distance'), vecField(ob, 'location', 1, 'Y', 'distance'), vecField(ob, 'location', 2, 'Z', 'distance')),
    h('div', { class: 'sb-label' }, `${rotLabel}:`),
    ob.rotation_mode === 'QUATERNION'
      ? col(
          ...['W', 'X', 'Y', 'Z'].map((l, i) =>
            numberField({
              id: `${ob.id}.quat.${i}`,
              label: l,
              value: ob.rotation_quaternion[i],
              set: (v, final) => {
                ob.rotation_quaternion[i] = v;
                app.changed('doc');
                if (final) app.pushUndo('Change Rotation');
              },
            }),
          ),
        )
      : col(vecField(ob, 'rotation_euler', 0, 'X', 'angle'), vecField(ob, 'rotation_euler', 1, 'Y', 'angle'), vecField(ob, 'rotation_euler', 2, 'Z', 'angle')),
    enumMenu(
      'rotmode',
      [
        ['QUATERNION', 'Quaternion (WXYZ)'],
        ['XYZ', 'XYZ Euler'],
        ['XZY', 'XZY Euler'],
        ['YXZ', 'YXZ Euler'],
        ['YZX', 'YZX Euler'],
        ['ZXY', 'ZXY Euler'],
        ['ZYX', 'ZYX Euler'],
        ['AXIS_ANGLE', 'Axis Angle'],
      ].map(([value, label]) => ({ value, label })),
      ob.rotation_mode,
      (m) => {
        app.run('object.rotation_mode_set', { mode: m });
      },
    ),
    h('div', { class: 'sb-label' }, 'Scale:'),
    col(vecField(ob, 'scale', 0, 'X', 'none'), vecField(ob, 'scale', 1, 'Y', 'none'), vecField(ob, 'scale', 2, 'Z', 'none')),
    h('div', { class: 'sb-label' }, 'Dimensions:'),
    col(
      ...['X', 'Y', 'Z'].map((l, i) =>
        numberField({
          id: `${ob.id}.dim.${i}`,
          label: l,
          value: dims[i],
          unit: 'distance',
          min: 0,
          set: (v, final) => {
            const base = box.isEmpty() ? 0 : box.getSize(new Vector3()).toArray()[i];
            if (base > 1e-9) ob.scale[i] = v / base;
            app.changed('doc');
            if (final) app.pushUndo('Change Dimensions');
          },
        }),
      ),
    ),
  ];
}

export const itemPanels: ((v: View3D) => Child)[] = [];

sidebarTabs.push(
  {
    id: 'Item',
    label: 'Item',
    draw: (v) => {
      const ob = app.activeObject;
      const extra = itemPanels.map((f) => f(v));
      if (app.doc.mode === 'EDIT' || app.doc.mode === 'POSE') return extra;
      if (!ob) return [h('div', { class: 'sb-empty' }, 'No active object'), ...extra];
      return [panel('sb-transform', 'Transform', () => objectTransform(ob)), ...extra];
    },
  },
  {
    id: 'Tool',
    label: 'Tool',
    draw: (v) => {
      const ts = app.doc.scene.tool_settings;
      return [
        panel('sb-active-tool', 'Active Tool', () => h('div', { class: 'sb-active-tool' }, toolHeader(v))),
        panel('sb-options', 'Options', () => toolOptions('sb')),
        panel('sb-workspace', 'Workspace', () => [h('div', { class: 'sb-label' }, `Mode: ${app.doc.mode[0] + app.doc.mode.slice(1).toLowerCase().replace('_', ' ')}`)]),
      ];
    },
  },
  {
    id: 'View',
    label: 'View',
    draw: (v) => {
      const cur = app.doc.scene.cursor;
      return [
        panel('sb-view', 'View', () => [
          numberField({ id: 'v-lens', label: 'Focal Length', value: v.nav.lens, min: 1, max: 5000, unit: 'none', precision: 0, set: (x) => ((v.nav.lens = x), renderContext?.engine.requestDraw(), app.changed('ui')) }),
          h('div', { class: 'sb-label' }, 'Clip'),
          col(
            numberField({ id: 'v-cs', label: 'Start', value: v.nav.clipStart, min: 1e-6, unit: 'distance', set: (x) => ((v.nav.clipStart = x), app.changed('ui')) }),
            numberField({ id: 'v-ce', label: 'End', value: v.nav.clipEnd, min: 1e-3, unit: 'distance', set: (x) => ((v.nav.clipEnd = x), app.changed('ui')) }),
          ),
          checkbox('v-localcam', 'Local Camera', v.useLocalCamera, (x) => {
            v.useLocalCamera = x;
            if (x && !v.localCamera) v.localCamera = app.doc.scene.camera;
            v.updateSceneCamera();
            v.afterNav();
            app.changed('ui');
          }),
          v.useLocalCamera
            ? enumMenu('v-localcam-ob', Object.values(app.doc.objects).filter((o) => o.type === 'CAMERA').map((o) => ({ value: o.id, label: o.name, icon: 'outliner_ob_camera' })), v.localCamera ?? '', (id) => {
                v.localCamera = id;
                v.updateSceneCamera();
                v.afterNav();
                app.changed('ui');
              })
            : null,
          v.cameraView ? checkbox('v-region', 'Render Region', !!(app.doc.scene.render as { use_border?: boolean }).use_border, (x) => ((app.doc.scene.render as { use_border?: boolean }).use_border = x, app.pushUndo('Render Region'), app.changed('doc', 'ui'))) : null,
          v.clipPlanes ? h('div', { class: 'sb-row-btn' }, opButton('view3d.clip_border', 'Clear Clipping Region')) : null,
        ]),
        panel('sb-view-lock', 'View Lock', () => [
          row(
            'Lock to Object',
            enumMenu('v-lockob', [{ value: '', label: '—' }, ...Object.values(app.doc.objects).map((o) => ({ value: o.id, label: o.name, icon: 'object' }))], v.lockObject ?? '', (id) => {
              v.lockObject = id || null;
              if (id) v.lockCursor = false;
              v.afterNav();
              app.changed('ui');
            }),
          ),
          !v.lockObject ? checkbox('v-lockcur', 'Lock to 3D Cursor', v.lockCursor, (x) => ((v.lockCursor = x), v.afterNav(), app.changed('ui'))) : null,
          checkbox('v-lock', 'Lock Camera to View', v.lockCameraToView, (x) => ((v.lockCameraToView = x), app.changed('ui'))),
        ]),
        panel('sb-cursor', '3D Cursor', () => [
          h('div', { class: 'sb-label' }, 'Location:'),
          col(
            ...['X', 'Y', 'Z'].map((l, i) =>
              numberField({
                id: `cursor.loc.${i}`,
                label: l,
                value: cur.location[i],
                unit: 'distance',
                set: (x, final) => {
                  cur.location[i] = x;
                  app.changed('doc');
                  if (final) app.pushUndo('Cursor');
                },
              }),
            ),
          ),
          h('div', { class: 'sb-label' }, 'Rotation:'),
          col(
            ...['X', 'Y', 'Z'].map((l, i) =>
              numberField({
                id: `cursor.rot.${i}`,
                label: l,
                value: cur.rotation_euler[i],
                unit: 'angle',
                set: (x, final) => {
                  cur.rotation_euler[i] = x;
                  app.changed('doc');
                  if (final) app.pushUndo('Cursor');
                },
              }),
            ),
          ),
        ]),
        v.quad
          ? panel('sb-quad', 'Quad View', () => [
              checkbox('q-lock', 'Lock', quadMembers(v).some((m) => m.lockRotation), (x) => {
                for (const m of quadMembers(v)) if (m.quad?.role !== 'USER') m.lockRotation = x;
                app.changed('ui');
              }),
              checkbox('q-sync', 'Sync Zoom/Pan', quadMembers(v).some((m) => m.quadSync), (x) => {
                for (const m of quadMembers(v)) m.quadSync = x;
                app.changed('ui');
              }),
            ])
          : null,
        panel('sb-collections', 'Collections', () => collectionRows(), { closed: true }),
      ];
    },
  },
);

/** Viewports of the same Quad View group. */
function quadMembers(v: View3D): View3D[] {
  if (!v.quad) return [v];
  return v.area.screen.areas.map((a) => a.editor as unknown as View3D).filter((e) => e?.quad?.group === v.quad!.group);
}

/** Collection visibility: click a name to show only that collection (Shift adds it), the eye hides it. */
function collectionRows(): Child {
  const doc = app.doc;
  const master = doc.collections[doc.scene.collection];
  if (!master) return null;
  const rows: Child[] = [];
  const all: string[] = [];
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      const c = doc.collections[id];
      if (!c) continue;
      all.push(id);
      rows.push(
        h(
          'div',
          { key: id, class: 'sb-coll', style: `display: flex; align-items: center; gap: 4px; padding-left: ${depth * 12}px` },
          h(
            'button',
            {
              class: { 'sb-coll-name': true, off: c.hide },
              style: 'flex: 1; text-align: left; background: none; border: 0; color: inherit; padding: 2px 4px; cursor: pointer; opacity: ' + (c.hide || c.exclude ? '0.5' : '1'),
              'data-tip': 'Show only this collection (Shift: toggle it)',
              onclick: (e: MouseEvent) => {
                if (e.shiftKey) c.hide = !c.hide;
                else for (const other of all) doc.collections[other].hide = other !== id;
                app.pushUndo('Hide Collection');
                app.changed('doc');
              },
            },
            icon('collection'),
            ' ',
            c.name,
          ),
          h(
            'button',
            {
              class: 'lock-btn',
              'data-tip': 'Hide in Viewport',
              onclick: () => {
                c.hide = !c.hide;
                app.pushUndo('Hide Collection');
                app.changed('doc');
              },
            },
            icon(c.hide ? 'hide_on' : 'hide_off'),
          ),
        ),
      );
      walk(c.children, depth + 1);
    }
  };
  walk(master.children, 0);
  return rows.length ? rows : h('div', { class: 'sb-label' }, 'No collections');
}

export function sidebar(v: View3D): Child {
  const tabs = sidebarTabs.filter((t) => !t.poll || t.poll());
  if (!tabs.some((t) => t.id === v.sidebarTab)) v.sidebarTab = tabs[0]?.id ?? 'Item';
  const tab = tabs.find((t) => t.id === v.sidebarTab);
  return h(
    'div',
    { key: 'sidebar', class: 'v3d-sidebar' },
    h('div', { class: 'sb-body' }, tab ? tab.draw(v) : null),
    h(
      'div',
      { class: 'sb-tabs' },
      tabs.map((t) => h('button', { key: t.id, class: { 'sb-tab': true, on: t.id === v.sidebarTab }, onclick: () => ((v.sidebarTab = t.id), v.drawUI()) }, t.label)),
    ),
  );
}

export { Euler, Quaternion };
