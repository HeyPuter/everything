// More button operations: unset / assign the default of custom properties, copy a driver to the
// selected objects, jump to the target of a pointer property, the context menu of operator
// buttons (Quick Favorites, shortcuts, Python command) and the F1 help card for whatever is under
// the pointer.
import { app, operators, registerOperators } from '../app/app';
import { addKeys, shortcutLabel } from '../app/keymap';
import { h, type Child } from './h';
import { icon } from './icons';
import { openMenu, openPopover, itemContextHooks, menuHelpHook, type MenuItem } from './menu';
import { bindingAt, bindingValue, type PropBinding } from './binding';
import { activateHovered, animOf, buttonDefaultHooks, buttonMenuHooks, buttonOwnerLoc, isCustomProp, targetButton, writeClipboard } from './buttons';
import { fullDataPath } from './rnapath';
import { favoriteMenuItem } from './favorites';
import { shortcutMenuItems } from './shortcuts';
import { formatOpCall } from '../scripting/oplog';
import { customPropMeta, setCustomPropMeta } from './customprops';
import { addDriver } from '../animation/driverseditor';
import './wm.css';
import type { Driver, ObjectData } from '../data/types';

// ---------------------------------------------------------------------------
// operator buttons

/** The operator call of an operator button (elements carry `data-op` / `data-op-props`). */
export function opButtonAt(el: Element | null): { op: string; props: Record<string, unknown>; label: string } | null {
  const b = el?.closest?.('[data-op]') as HTMLElement | null;
  const op = b?.dataset.op;
  if (!b || !op || !operators.has(op)) return null;
  let props: Record<string, unknown> = {};
  try {
    props = b.dataset.opProps ? JSON.parse(b.dataset.opProps) : {};
  } catch {
    props = {};
  }
  return { op, props, label: b.textContent?.trim() || operators.get(op)!.label };
}

function hoveredElement(): Element | null {
  return document.elementFromPoint(app.pointer.x, app.pointer.y);
}

function copyPythonCommand(op: string, props: Record<string, unknown>) {
  const text = formatOpCall(op, props);
  writeClipboard(text);
  app.report('INFO', `Copied: ${text}`);
}

/** Right-click menu of an operator button or menu item. */
export function operatorMenu(op: string, props: Record<string, unknown>, label: string): MenuItem[] {
  return [
    favoriteMenuItem({ label, op, props }),
    { separator: true },
    ...shortcutMenuItems(op, Object.keys(props).length ? props : undefined, label),
    { separator: true },
    { label: 'Copy Python Command', action: () => copyPythonCommand(op, props) },
    { separator: true },
    { label: 'Help', shortcut: shortcutLabel('wm.doc_view_manual_ui_context'), action: () => showHelp({ kind: 'op', op, props, label }) },
  ];
}

// menu items: favourites come from ui/favorites, the rest from here
itemContextHooks.push((item) => {
  if (!item.op) return [];
  const label = item.label ?? operators.get(item.op)?.label ?? item.op;
  return operatorMenu(item.op, item.props ?? {}, label).slice(1);
});

addEventListener(
  'contextmenu',
  (e) => {
    if (app?.modal) return;
    const t = e.target as HTMLElement;
    if (t.closest?.('.popup-layer, input, textarea') || bindingAt(t)) return;
    const ob = opButtonAt(t);
    if (!ob) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(operatorMenu(ob.op, ob.props, ob.label), { x: e.clientX, y: e.clientY }, { title: ob.label });
  },
  true,
);

// ---------------------------------------------------------------------------
// custom properties, drivers, targets

function customOwner(b: PropBinding) {
  const loc = buttonOwnerLoc(b);
  if (!loc || !isCustomProp(b)) return null;
  const table = loc.table === 'scenes' ? null : (app.doc as unknown as Record<string, Record<string, Record<string, unknown>>>)[loc.table];
  const block = loc.table === 'scenes' ? (app.doc.scene as unknown as Record<string, unknown>) : table?.[loc.id];
  return block ?? null;
}

function drivenOf(b: PropBinding): { ob: ObjectData; drivers: Driver[]; path: string } | null {
  const a = animOf(b);
  if (!a) return null;
  const all = a.ob.animation_data?.drivers.filter((d) => d.data_path === a.path) ?? [];
  return all.length ? { ob: a.ob, drivers: all, path: a.path } : null;
}

function copyDriversToSelected(b: PropBinding, all: boolean): number {
  const src = drivenOf(b);
  if (!src) return 0;
  const drivers = all || b.index === undefined ? src.drivers : src.drivers.filter((d) => d.array_index === b.index);
  let n = 0;
  for (const ob of app.selectedObjects()) {
    if (ob.id === src.ob.id) continue;
    if (src.path.startsWith('data.') && ob.type !== src.ob.type) continue;
    for (const d of drivers) {
      const made = addDriver(app.doc, ob, d.data_path, d.array_index);
      for (const m of made) {
        Object.assign(m, structuredClone({ ...d, data_path: m.data_path, array_index: m.array_index }));
        // variables that read the source object itself now read the copy's own object
        for (const v of m.variables) for (const t of v.targets) if (t.id === src.ob.id) t.id = ob.id;
      }
      if (made.length) n++;
    }
  }
  return n;
}

/** The data-block a pointer property points at: an object id, or a bone name of the target armature. */
function jumpTarget(b: PropBinding): { ob: ObjectData; bone?: string } | null {
  const v = bindingValue(b);
  if (b.kind === 'object' && typeof v === 'string' && app.doc.objects[v]) return { ob: app.doc.objects[v] };
  if (typeof v === 'string' && v && /subtarget$/.test(b.key)) {
    const tkey = b.key.replace(/subtarget$/, 'target');
    const tid = b.owner[tkey];
    const ob = typeof tid === 'string' ? app.doc.objects[tid] : undefined;
    if (ob?.type === 'ARMATURE') return { ob, bone: v };
  }
  return null;
}

function jumpTo(t: { ob: ObjectData; bone?: string }) {
  const doc = app.doc;
  if (doc.mode === 'OBJECT' || (t.bone && doc.mode === 'POSE' && app.activeObject?.id === t.ob.id)) {
    if (doc.mode === 'OBJECT') {
      for (const o of Object.values(doc.objects)) o.select = o.id === t.ob.id;
      doc.scene.active_object = t.ob.id;
    }
    if (t.bone) {
      const arm = t.ob.data ? doc.armatures[t.ob.data] : undefined;
      if (arm?.bones.some((x) => x.name === t.bone)) {
        arm.active_bone = t.bone;
        for (const x of arm.bones) x.select = x.name === t.bone;
      }
    }
    app.changed('select');
    return true;
  }
  app.report('WARNING', 'Switch to Object Mode to jump to another object');
  return false;
}

// custom properties reset to the default set in Edit Property (or Assign Value as Default)
buttonDefaultHooks.push((b) => {
  const block = customOwner(b);
  if (!block) return undefined;
  const d = customPropMeta(block, b.key).default;
  const cur = b.owner[b.key];
  if (d !== undefined && typeof d === typeof cur) return d;
  if (typeof cur === 'number') return 0;
  if (typeof cur === 'boolean') return false;
  if (typeof cur === 'string') return '';
  if (Array.isArray(cur) || ArrayBuffer.isView(cur)) return Array.from(cur as ArrayLike<number>, () => 0);
  return undefined;
});

buttonMenuHooks.push(
  {
    slot: 'reset',
    items: (b) => {
      if (!isCustomProp(b)) return [];
      const v = b.owner[b.key];
      return [...(typeof v === 'number' ? [{ label: 'Assign Value as Default', op: 'ui.assign_default_button' }] : []), { label: 'Unset', op: 'ui.unset_property_button' }];
    },
  },
  {
    slot: 'selected',
    items: (b) => {
      if (!drivenOf(b)) return [];
      const arr = b.index !== undefined;
      const many = app.selectedObjects().length > 1;
      return [
        { label: arr ? 'Copy All Drivers to Selected' : 'Copy Driver to Selected', disabled: !many, op: 'ui.copy_driver_to_selected_button', props: { all: true } },
        ...(arr ? [{ label: 'Copy Single Driver to Selected', disabled: !many, op: 'ui.copy_driver_to_selected_button', props: { all: false } }] : []),
      ];
    },
  },
  { slot: 'target', items: (b) => (jumpTarget(b) ? [{ label: 'Jump to Target', op: 'ui.jump_to_target_button' }] : []) },
  { slot: 'help', items: (b) => [{ label: 'Help', shortcut: shortcutLabel('wm.doc_view_manual_ui_context'), action: () => showHelp({ kind: 'prop', b }) }] },
);

registerOperators([
  {
    idname: 'ui.unset_property_button',
    label: 'Unset Property',
    description: 'Remove the custom property under the mouse from its data-block',
    redo: false,
    poll: () => {
      const b = targetButton();
      return !!b && isCustomProp(b);
    },
    exec: () => {
      const b = targetButton()!;
      const block = customOwner(b);
      delete b.owner[b.key];
      if (block) setCustomPropMeta(block, b.key, null);
      b.onChange?.();
      app.graph.invalidate?.();
    },
  },
  {
    idname: 'ui.assign_default_button',
    label: 'Assign Value as Default',
    description: 'Make the current value of the custom property under the mouse its default value',
    redo: false,
    poll: () => {
      const b = targetButton();
      return !!b && isCustomProp(b) && typeof b.owner[b.key] === 'number';
    },
    exec: () => {
      const b = targetButton()!;
      const block = customOwner(b);
      if (!block) return 'CANCELLED';
      setCustomPropMeta(block, b.key, { ...customPropMeta(block, b.key), default: b.owner[b.key] as number });
      app.report('INFO', `Default of "${b.key}" is now ${b.owner[b.key]}`);
    },
  },
  {
    idname: 'ui.copy_driver_to_selected_button',
    label: 'Copy Driver to Selected',
    description: 'Give the other selected objects a copy of the driver of the property under the mouse',
    redo: false,
    props: [{ id: 'all', label: 'All', type: 'bool', default: false }],
    poll: () => {
      const b = targetButton();
      return !!b && !!drivenOf(b) && app.selectedObjects().length > 1;
    },
    exec: (_c, p) => {
      const n = copyDriversToSelected(targetButton()!, !!p.all);
      if (!n) {
        app.report('WARNING', 'No other selected object has this property');
        return 'CANCELLED';
      }
      app.graph.invalidate?.();
      app.report('INFO', `Copied the driver to ${n} object${n === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'ui.jump_to_target_button',
    label: 'Jump to Target',
    description: 'Make the object (or bone) the property under the mouse points at the active one',
    redo: false,
    poll: () => {
      const b = targetButton();
      return !!b && !!jumpTarget(b);
    },
    exec: () => (jumpTo(jumpTarget(targetButton()!)!) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'ui.copy_python_command_button',
    label: 'Copy Python Command',
    description: 'Copy the Python command of the operator button under the mouse to the clipboard',
    undo: false,
    poll: () => !!opButtonAt(hoveredElement()),
    exec: () => {
      const ob = opButtonAt(hoveredElement())!;
      copyPythonCommand(ob.op, ob.props);
    },
  },
]);

registerOperators([
  {
    idname: 'ui.button_execute',
    label: 'Press Button',
    description: 'Press the button under the mouse (start typing in a field, toggle, open a menu)',
    undo: false,
    internal: true,
    props: [{ id: 'skip_depressed', label: 'Skip Depressed', type: 'bool', default: false }],
    poll: () => !!targetButton(),
    exec: () => activateHovered(),
  },
  {
    idname: 'ui.button_string_clear',
    label: 'Clear Button String',
    description: 'Empty the text field under the mouse',
    redo: false,
    poll: () => {
      const b = targetButton();
      return !!b && b.kind === 'text';
    },
    exec: () => {
      const b = targetButton()!;
      b.owner[b.key] = '';
      b.onChange?.();
    },
  },
]);

addKeys('User Interface', [{ key: 'C', ctrl: true, shift: true, op: 'ui.copy_python_command_button' }]);

// ---------------------------------------------------------------------------
// help card (F1)

type HelpSubject = { kind: 'prop'; b: PropBinding } | { kind: 'op'; op: string; props: Record<string, unknown>; label: string } | { kind: 'tip'; title: string; text: string };

/** Tooltip text of the element (and its ancestors) without the Python line. */
function tipOf(el: Element | null): string {
  const t = (el?.closest?.('[data-tip]') as HTMLElement | null)?.dataset.tip ?? '';
  return t
    .split('\n')
    .filter((l) => !/^Python:/.test(l))
    .join('\n')
    .trim();
}

function subjectAt(el: Element | null): HelpSubject | null {
  if (!el || el.closest('.popup-layer')) return null;
  const b = bindingAt(el);
  if (b) return { kind: 'prop', b };
  const ob = opButtonAt(el);
  if (ob) return { kind: 'op', ...ob };
  const tip = tipOf(el);
  if (tip) {
    const [title, ...rest] = tip.split('\n');
    return { kind: 'tip', title, text: rest.join('\n') };
  }
  return null;
}

function fmt(v: unknown): string {
  if (typeof v === 'number') return String(Math.round(v * 1e4) / 1e4);
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return `(${Array.from(v as ArrayLike<number>, (x) => fmt(x)).join(', ')})`;
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  return v === null || v === undefined ? '—' : String(v);
}

const KIND_NAMES: Record<string, string> = { number: 'Number', bool: 'On / Off', enum: 'Choice', color: 'Color', text: 'Text', vector: 'Vector', object: 'Object' };

function line(label: string, value: Child) {
  return h('div', { class: 'hc-row' }, h('span', { class: 'hc-key' }, label), h('span', { class: 'hc-val' }, value));
}

function helpBody(s: HelpSubject): Child {
  if (s.kind === 'op') {
    const op = operators.get(s.op);
    const key = shortcutLabel(s.op, Object.keys(s.props).length ? s.props : undefined);
    return [
      h('div', { class: 'hc-title' }, icon('info_small'), s.label),
      op?.description ? h('p', { class: 'hc-desc' }, op.description) : null,
      line('Shortcut', key || 'None (right-click ▸ Assign Shortcut)'),
      line('Python', h('code', null, formatOpCall(s.op, s.props))),
      app.poll(s.op) ? null : line('Status', 'Not available in the current context'),
    ];
  }
  if (s.kind === 'tip') return [h('div', { class: 'hc-title' }, icon('info_small'), s.title), s.text ? h('p', { class: 'hc-desc' }, s.text) : null];
  const b = s.b;
  const el = document.querySelector(`[data-id="${CSS.escape(b.id)}"]`);
  const tip = tipOf(el);
  const loc = buttonOwnerLoc(b);
  const tipLines = tip.split('\n');
  const desc = tipLines[0] === b.label ? tipLines.slice(1).join('\n') : tip;
  const range = b.min !== undefined || b.max !== undefined ? `${b.min ?? '−∞'} to ${b.max ?? '∞'}` : '';
  return [
    h('div', { class: 'hc-title' }, icon('info_small'), b.label),
    desc ? h('p', { class: 'hc-desc' }, desc) : null,
    line('Type', `${KIND_NAMES[b.kind] ?? b.kind}${b.int ? ' (whole numbers)' : ''}`),
    line('Value', fmt(bindingValue(b))),
    range ? line('Range', range) : null,
    b.items?.length && b.kind === 'enum' ? line('Options', b.items.join(', ')) : null,
    loc ? line('Python', h('code', null, fullDataPath(loc, b.key, b.index))) : null,
    h(
      'div',
      { class: 'hc-keys' },
      [
        ['I', 'Insert keyframe'],
        ['Ctrl D', 'Add driver'],
        ['Backspace', 'Reset to default'],
        ['Ctrl C / Ctrl V', 'Copy / paste value'],
        ['Ctrl Wheel', 'Step the value'],
        ['Alt', 'Edit all selected'],
      ].map(([k, t]) => h('span', { key: k }, h('kbd', null, k), ` ${t}`)),
    ),
  ];
}

export function showHelp(s: HelpSubject, at: { x: number; y: number } = { ...app.pointer }) {
  openPopover({ x: at.x + 8, y: at.y + 8 }, () => h('div', { class: 'help-card' }, helpBody(s)), { width: 340, className: 'help-card-host' });
}

function opHelp(id: string): HelpSubject | null {
  const op = operators.get(id.replace(/^bpy\.ops\./, '').replace(/\(.*$/, ''));
  return op ? { kind: 'op', op: op.idname, props: {}, label: op.label } : null;
}

registerOperators([
  {
    idname: 'wm.doc_view_manual_ui_context',
    label: 'View Help',
    description: 'Show a help card for the button or menu item under the mouse',
    undo: false,
    poll: () => !!subjectAt(hoveredElement()),
    exec: () => {
      const s = subjectAt(hoveredElement());
      if (!s) return 'CANCELLED';
      showHelp(s);
    },
  },
  {
    idname: 'wm.doc_view_manual',
    label: 'View Help',
    description: 'Show the help card of an operator, by its identifier (e.g. mesh.subdivide)',
    undo: false,
    internal: true,
    props: [{ id: 'doc_id', label: 'Doc ID', type: 'string', default: '' }],
    exec: (_c, p) => {
      const s = opHelp(String(p.doc_id ?? ''));
      if (!s) {
        app.report('WARNING', `No help for "${p.doc_id}"`);
        return 'CANCELLED';
      }
      showHelp(s);
    },
  },
  {
    idname: 'wm.doc_view',
    label: 'View Documentation',
    description: 'Show the help card of an operator, by its Python name (e.g. bpy.ops.mesh.subdivide)',
    undo: false,
    internal: true,
    props: [{ id: 'doc_id', label: 'Doc ID', type: 'string', default: '' }],
    exec: (_c, p) => {
      const s = opHelp(String(p.doc_id ?? ''));
      if (!s) {
        app.report('WARNING', `No documentation for "${p.doc_id}"`);
        return 'CANCELLED';
      }
      showHelp(s);
    },
  },
]);

addKeys('Window', [{ key: 'F1', op: 'wm.doc_view_manual_ui_context' }]);

menuHelpHook.show = (item, at) => item.op && showHelp({ kind: 'op', op: item.op, props: item.props ?? {}, label: item.label ?? operators.get(item.op)?.label ?? item.op }, at);
