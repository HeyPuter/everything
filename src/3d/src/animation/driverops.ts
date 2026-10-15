// Driver operators used from property buttons: Edit Driver popover, Show in Drivers Editor,
// Copy As New Driver, quick "#expression" drivers typed into number fields, and the matching
// entries in the property context menus.
import { app, registerOperators, type OpContext } from '../app/app';
import { openPopover, type MenuItem } from '../ui/menu';
import { getBinding, buttonHooks } from '../ui/binding';
import { animOf, buttonDriverItems } from '../ui/buttons';
import { shell } from '../ui/shell';
import type { Area } from '../ui/screen';
import type { Driver, ObjectData } from '../data/types';
import { getValue } from '../data/rna';
import { propertyAnimExtraItems } from '../anim/keyingsets';
import { driverPopover } from './driverpanel';
import { DriversEditor, addDriver } from './driverseditor';
import { defaultDriverCurve } from './drivercurves';
import { setDriverClipboard, hasDriverClipboard } from './miscops';
import { setExpanded } from './channels';

const targetProps = [
  { id: 'object', label: 'Object', type: 'string' as const, default: '', hidden: true },
  { id: 'data_path', label: 'Data Path', type: 'string' as const, default: '', hidden: true },
  { id: 'index', label: 'Index', type: 'int' as const, default: -1, hidden: true },
];

function targetOf(p: Record<string, unknown>): { ob: ObjectData; path: string; index: number } | null {
  const ob = p.object ? app.doc.objects[p.object as string] : app.activeObject;
  if (!ob || !p.data_path) return null;
  return { ob, path: p.data_path as string, index: (p.index as number) ?? -1 };
}

function findDriver(ob: ObjectData, path: string, index: number): Driver | undefined {
  const ds = ob.animation_data?.drivers ?? [];
  return ds.find((d) => d.data_path === path && d.array_index === index) ?? ds.find((d) => d.data_path === path && (index < 0 || d.array_index === index));
}

/** Open the Edit Driver popover for a driver, under the pointer (or an anchor). */
export function openDriverPopover(ob: ObjectData, d: Driver, at?: HTMLElement | { x: number; y: number }) {
  const anchor = at ?? (document.elementFromPoint(app.pointer.x, app.pointer.y)?.closest('[data-id]') as HTMLElement | null) ?? { x: app.pointer.x, y: app.pointer.y };
  openPopover(
    anchor,
    () => {
      // the driver may have been removed or replaced (undo): look it up again
      const cur = app.doc.objects[ob.id];
      const drv = cur ? findDriver(cur, d.data_path, d.array_index) : undefined;
      return cur && drv ? driverPopover(cur, drv) : null;
    },
    { width: 360, className: 'drv-popover-host' },
  );
}

/** Area showing the Drivers editor, made by splitting the area under the pointer when there is none. */
function driversArea(): Area | null {
  const screen = shell.screen;
  const existing = screen.findArea('DRIVERS');
  if (existing) return existing;
  // the largest area gives up its lower part (the button pressed is usually in a small side area)
  const base = screen.areas.reduce<Area | null>((best, a) => (!best || a.rect.w * a.rect.h > best.rect.w * best.rect.h ? a : best), null);
  if (!base) return null;
  const area = screen.split(base, 'v', 0.55);
  if (!area) return null;
  area.setType('DRIVERS');
  return area;
}

function focusDriver(area: Area, ob: ObjectData, d: Driver) {
  const ed = area.editor;
  if (!(ed instanceof DriversEditor)) return;
  setExpanded(`dob:${ob.id}`, true);
  setExpanded(`drvs:${ob.id}`, true);
  if (!ob.select && ed.onlySelected) ed.onlySelected = false;
  ed.setActiveDriver(ob, d);
  ed.sidebarTab = 'drivers';
  ed.showSidebar = true;
  ed.layout();
  ed.refresh();
  ed.viewAll();
}

registerOperators([
  {
    idname: 'anim.driver_button_edit',
    label: 'Edit Driver',
    description: 'Show the driver settings of the property in a popover',
    props: targetProps,
    undo: false,
    poll: () => true,
    invoke: (_ctx, p) => {
      const t = targetOf(p);
      const d = t ? findDriver(t.ob, t.path, t.index) : undefined;
      if (!t || !d) {
        app.report('WARNING', 'The property has no driver to edit');
        return 'CANCELLED';
      }
      openDriverPopover(t.ob, d);
      return 'FINISHED';
    },
    exec: () => 'CANCELLED',
  },
  {
    idname: 'screen.drivers_editor_show',
    label: 'Show Drivers Editor',
    description: 'Show the drivers in a Drivers editor, focused on the property when one is given',
    props: targetProps,
    undo: false,
    exec: (_ctx: OpContext, p) => {
      const area = driversArea();
      if (!area) return 'CANCELLED';
      const t = targetOf(p);
      const d = t ? findDriver(t.ob, t.path, t.index) : undefined;
      if (t && d) focusDriver(area, t.ob, d);
      app.changed('ui');
    },
  },
  {
    idname: 'ui.copy_as_driver_button',
    label: 'Copy as New Driver',
    description: 'Make a driver that reads this property and put it on the driver clipboard; use Paste Driver on another property',
    props: targetProps,
    undo: false,
    exec: (_ctx, p) => {
      const t = targetOf(p);
      if (!t) return 'CANCELLED';
      const raw = getValue(app.doc, t.ob, t.path);
      const arr = Array.isArray(raw) || ArrayBuffer.isView(raw);
      const index = arr ? Math.max(0, t.index) : -1;
      const name = (t.path.split('.').pop() ?? 'var').replace(/\[.*$/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '') || 'var';
      const d: Driver = {
        data_path: '',
        array_index: 0,
        type: 'AVERAGE',
        expression: name,
        variables: [{ name, type: 'SINGLE_PROP', targets: [{ id: t.ob.id, id_type: 'OBJECT', data_path: arr ? `${t.path}[${index}]` : t.path }] }],
      };
      d.fcurve = defaultDriverCurve(d);
      setDriverClipboard(d);
      app.report('INFO', `Copied a driver that reads ${t.ob.name} ▸ ${arr ? `${t.path}[${index}]` : t.path}`);
    },
  },
]);

/** Entries shared by the button and decorator context menus. */
function driverMenuItems(ob: ObjectData, path: string, index: number, driven: boolean, withCopyPaste: boolean): MenuItem[] {
  const t = { object: ob.id, data_path: path, index };
  const items: MenuItem[] = [];
  if (withCopyPaste) {
    if (driven) items.push({ label: 'Copy Driver', op: 'anim.copy_driver_button', props: t });
    else items.push({ label: 'Copy as New Driver', op: 'ui.copy_as_driver_button', props: t });
    if (hasDriverClipboard()) items.push({ label: 'Paste Driver', op: 'anim.paste_driver_button', props: t });
  } else if (!driven) items.push({ label: 'Copy as New Driver', op: 'ui.copy_as_driver_button', props: t });
  if (driven) items.push({ label: 'Edit Driver', op: 'anim.driver_button_edit', props: t });
  items.push({ label: 'Open Drivers Editor', op: 'screen.drivers_editor_show', props: t });
  return items;
}

buttonDriverItems.push((ob, path, index, driven) => driverMenuItems(ob, path, index, driven, true));
// the decorator menu already lists Copy/Paste Driver
propertyAnimExtraItems.push((ob, path, index) => {
  const driven = !!ob.animation_data?.drivers.some((d) => d.data_path === path && (index < 0 || d.array_index === index));
  return driverMenuItems(ob, path, index, driven, false);
});

// "#expression" typed into a number field drives the property with that expression
buttonHooks.hashExpression = (id, expression) => {
  const b = getBinding(id);
  const a = b ? animOf(b) : null;
  if (!b || !a || !expression) return false;
  const index = b.index ?? a.index;
  const before = a.ob.animation_data?.drivers.find((d) => d.data_path === a.path && d.array_index === Math.max(0, index));
  const made = before ? [before] : addDriver(app.doc, a.ob, a.path, index >= 0 ? index : -1, { type: 'SCRIPTED', expression });
  for (const d of made) {
    d.type = 'SCRIPTED';
    d.expression = expression;
  }
  app.pushUndo('Add Driver');
  app.changed('doc');
  app.report('INFO', `Driven by "${expression}"`);
  return true;
};
