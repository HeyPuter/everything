// Script-defined operators and panels (`bpy.types.Operator` / `bpy.types.Panel` subclasses
// registered with `bpy.utils.register_class`). Operators become regular app operators
// (F3 search, bpy.ops, Adjust Last Operation); panels draw into the 3D viewport sidebar.
import { registerScriptMenu, unregisterScriptMenu } from './menus';
import { declareGroup, declareTypeProp, markGroup, removeTypeProp, type TypeProp } from './typeprops';
import { app, operators, registerOperator, type PropDef, type Operator } from '../app/app';
import { pyError, kwMethod, Struct } from './rna';
import { bpy } from './api';
import { nestedInOperator } from './runner';

// ---------------------------------------------------------------------------
// properties (bpy.props)

export interface ScriptProp {
  __kind: 'propdef';
  type: 'FLOAT' | 'INT' | 'BOOLEAN' | 'STRING' | 'ENUM' | 'FLOAT_VECTOR' | 'INT_VECTOR' | 'BOOL_VECTOR';
  name?: string;
  description?: string;
  default?: unknown;
  min?: number;
  max?: number;
  soft_min?: number;
  soft_max?: number;
  step?: number;
  precision?: number;
  subtype?: string;
  size?: number;
  items?: [string, string, string?][];
  options?: string[];
}

function prop(type: ScriptProp['type']) {
  return (opts: Partial<ScriptProp> = {}): ScriptProp => ({ ...opts, __kind: 'propdef', type });
}

export const bpyProps = {
  __kind: 'module',
  FloatProperty: prop('FLOAT'),
  IntProperty: prop('INT'),
  BoolProperty: prop('BOOLEAN'),
  StringProperty: prop('STRING'),
  EnumProperty: prop('ENUM'),
  FloatVectorProperty: prop('FLOAT_VECTOR'),
  IntVectorProperty: prop('INT_VECTOR'),
  BoolVectorProperty: prop('BOOL_VECTOR'),
  /** A property group value: PointerProperty({type: MyGroup}) (MyGroup extends bpy.types.PropertyGroup). */
  PointerProperty: (opts: { type?: { name?: string } } & Record<string, unknown> = {}) => groupProp('POINTER', opts),
  /** A list of property group items: CollectionProperty({type: MyGroup}); add() / remove(i) / clear(). */
  CollectionProperty: (opts: { type?: { name?: string } } & Record<string, unknown> = {}) => groupProp('COLLECTION', opts),
};

function groupProp(type: 'POINTER' | 'COLLECTION', opts: { type?: { name?: string } } & Record<string, unknown>) {
  const g = opts.type;
  if (!g || typeof g !== 'function' || !(g as unknown as { prototype: unknown }).prototype || !((g as unknown as { prototype: unknown }).prototype instanceof JSPropertyGroup)) throw pyError('TypeError', `${type === 'POINTER' ? 'Pointer' : 'Collection'}Property(): type must be a registered bpy.types.PropertyGroup subclass (data-block pointers are not supported)`);
  return { ...opts, type, group: g.name, __kind: 'propdef' } as unknown as ScriptProp;
}

const prettify = (id: string) => id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Convert a script property declaration into an operator PropDef. */
export function toPropDef(id: string, p: ScriptProp): PropDef {
  const label = p.name || prettify(id);
  const sub = (p.subtype ?? 'NONE').toUpperCase();
  const base = { id, label, min: p.min, max: p.max, softMin: p.soft_min, softMax: p.soft_max, precision: p.precision, hidden: !!p.options?.includes('HIDDEN') };
  switch (p.type) {
    case 'FLOAT': {
      const subtype = sub === 'DISTANCE' ? 'distance' : sub === 'ANGLE' ? 'angle' : sub === 'FACTOR' ? 'factor' : sub === 'PERCENTAGE' ? 'percentage' : sub === 'TIME' ? 'time' : sub === 'PIXEL' ? 'pixel' : 'none';
      return { ...base, type: 'float', default: Number(p.default ?? 0), subtype, step: p.step };
    }
    case 'INT':
      return { ...base, type: 'int', default: Math.round(Number(p.default ?? 0)), step: p.step };
    case 'BOOLEAN':
      return { ...base, type: 'bool', default: !!p.default };
    case 'STRING':
      return { ...base, type: 'string', default: String(p.default ?? '') };
    case 'ENUM': {
      const items = (p.items ?? []).map((it) => [String(it[0]), String(it[1] ?? it[0]), it[2] ? String(it[2]) : undefined] as [string, string, string?]);
      if (!items.length) throw pyError('TypeError', `EnumProperty(${id}): items must not be empty`);
      const def = p.default === undefined || p.default === null ? items[0][0] : String(p.default);
      if (!items.some((it) => it[0] === def)) throw pyError('TypeError', `EnumProperty(${id}): default "${def}" not found in items`);
      return { ...base, type: 'enum', default: def, items };
    }
    case 'FLOAT_VECTOR':
    case 'INT_VECTOR': {
      const size = p.size ?? (Array.isArray(p.default) ? (p.default as unknown[]).length : 3);
      const def = Array.isArray(p.default) ? (p.default as number[]).map(Number) : Array.from({ length: size }, () => 0);
      if (sub === 'COLOR' || sub === 'COLOR_GAMMA') return { ...base, type: 'color', default: def.slice(0, 4) };
      const subtype = sub === 'EULER' ? 'angle' : sub === 'TRANSLATION' || sub === 'XYZ_LENGTH' ? 'distance' : 'xyz';
      return { ...base, type: size === 2 ? 'vec2' : 'vec3', default: def.slice(0, size === 2 ? 2 : 3), subtype };
    }
    case 'BOOL_VECTOR': {
      const def = Array.isArray(p.default) ? (p.default as unknown[]).map(Boolean) : [false, false, false];
      return { ...base, type: 'bools', default: def };
    }
  }
}

// ---------------------------------------------------------------------------
// operators

export interface ScriptOperatorSpec {
  idname: string;
  label: string;
  description?: string;
  options?: string[];
  props: Record<string, ScriptProp>;
  poll?: () => boolean;
  exec: (props: Record<string, unknown>) => unknown;
  invoke?: (props: Record<string, unknown>, event: Record<string, unknown>) => unknown;
  language: 'python' | 'javascript';
}

export const scriptOperators = new Map<string, ScriptOperatorSpec>();
const replacedBuiltins = new Map<string, Operator>();

/** Normalise an operator result ('FINISHED', {'FINISHED'}, Set(['FINISHED'])). */
export function resultString(r: unknown): 'FINISHED' | 'CANCELLED' | 'PASS_THROUGH' | 'RUNNING_MODAL' {
  let s: string[] = [];
  if (typeof r === 'string') s = [r];
  else if (r instanceof Set) s = [...r].map(String);
  else if (Array.isArray(r)) s = r.map(String);
  else if (r === undefined || r === null) s = ['FINISHED'];
  if (s.includes('FINISHED')) return 'FINISHED';
  if (s.includes('RUNNING_MODAL')) return 'RUNNING_MODAL';
  if (s.includes('PASS_THROUGH')) return 'PASS_THROUGH';
  return 'CANCELLED';
}

export function registerScriptOperator(spec: ScriptOperatorSpec) {
  if (!/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(spec.idname)) throw pyError('ValueError', `bl_idname "${spec.idname}" must be "module.name" in lower case (e.g. "object.my_operator")`);
  if (operators.has(spec.idname) && !scriptOperators.has(spec.idname)) throw pyError('ValueError', `bl_idname "${spec.idname}" is used by a built-in operator`);
  const props = Object.entries(spec.props).map(([id, p]) => toPropDef(id, p));
  const opts = spec.options ?? ['REGISTER'];
  const run = (fn: () => unknown) => {
    const r = resultString(nestedInOperator(fn));
    if (r === 'RUNNING_MODAL') {
      app.report('WARNING', `${spec.idname}: modal script operators are not supported`);
      return 'CANCELLED' as const;
    }
    return r === 'PASS_THROUGH' ? ('CANCELLED' as const) : r;
  };
  const op: Operator = {
    idname: spec.idname,
    label: spec.label || prettify(spec.idname.split('.')[1]),
    description: spec.description,
    props,
    undo: opts.includes('UNDO'),
    redo: opts.includes('UNDO') && opts.includes('REGISTER'),
    internal: opts.includes('INTERNAL'),
    poll: spec.poll ? () => !!spec.poll!() : undefined,
    exec: (_ctx, p) => run(() => spec.exec(p)),
    invoke: spec.invoke
      ? (ctx, p) => {
          const e = ctx.event;
          return run(() => spec.invoke!(p, { mouse_x: e?.x ?? 0, mouse_y: e?.y ?? 0, shift: !!e?.shift, ctrl: !!e?.ctrl, alt: !!e?.alt, type: 'NONE', value: 'NOTHING' }));
        }
      : undefined,
  };
  scriptOperators.set(spec.idname, spec);
  registerOperator(op);
}

export function unregisterScriptOperator(idname: string) {
  if (!scriptOperators.has(idname)) return false;
  scriptOperators.delete(idname);
  operators.delete(idname);
  const b = replacedBuiltins.get(idname);
  if (b) registerOperator(b);
  return true;
}

// ---------------------------------------------------------------------------
// UILayout (subset)

export type LayoutItem =
  | { t: 'label'; text: string; icon?: string }
  | { t: 'prop'; data: unknown; prop: string; text: string | null; slider?: boolean; toggle?: boolean; expand?: boolean; index?: number; icon_only?: boolean }
  | { t: 'operator'; idname: string; text: string | null; icon?: string; props: Record<string, unknown> }
  | { t: 'separator' }
  | { t: 'menu'; idname: string; text: string | null; icon?: string }
  | { t: 'layout'; kind: 'row' | 'column' | 'box' | 'split'; align: boolean; layout: UILayout };

export class UILayout {
  readonly __kind = 'layout';
  readonly __type = 'UILayout';
  items: LayoutItem[] = [];
  use_property_split = false;
  use_property_decorate = true;
  enabled = true;
  active = true;
  alert = false;
  scale_x = 1;
  scale_y = 1;
  alignment = 'EXPAND';
  emboss = 'NORMAL';
  label(text: string = '', icon: string = 'NONE') {
    this.items.push({ t: 'label', text: String(text ?? ''), icon: icon && icon !== 'NONE' ? String(icon) : undefined });
  }
  prop(data: unknown, property: string, text: string | null = null, icon = 'NONE', expand = false, slider = false, toggle = -1, icon_only = false, index = -1) {
    void icon;
    if (!data || typeof data !== 'object') throw pyError('TypeError', 'UILayout.prop(): data must be a struct');
    this.items.push({ t: 'prop', data, prop: String(property), text: text === undefined ? null : text, slider: !!slider, toggle: toggle === 1, expand: !!expand, index: index ?? -1, icon_only: !!icon_only });
  }
  operator(operator: string, text: string | null = null, icon = 'NONE') {
    const props: Record<string, unknown> = { __kind: 'opprops' };
    this.items.push({ t: 'operator', idname: String(operator), text: text === undefined ? null : text, icon: icon && icon !== 'NONE' ? String(icon) : undefined, props });
    return props;
  }
  /** A button that opens a script menu (bpy.types.Menu subclass) by its bl_idname. */
  menu(menu: string, text: string | null = null, icon = 'NONE') {
    this.items.push({ t: 'menu', idname: String(menu), text: text === undefined ? null : text, icon: icon && icon !== 'NONE' ? String(icon) : undefined });
  }
  separator(factor = 1) {
    void factor;
    this.items.push({ t: 'separator' });
  }
  separator_spacer() {
    this.items.push({ t: 'separator' });
  }
  private child(kind: 'row' | 'column' | 'box' | 'split', align: boolean) {
    const l = new UILayout();
    l.use_property_split = this.use_property_split;
    l.use_property_decorate = this.use_property_decorate;
    this.items.push({ t: 'layout', kind, align: !!align, layout: l });
    return l;
  }
  row(align = false, heading = '') {
    const l = this.child('row', align);
    if (heading) l.label(heading);
    return l;
  }
  column(align = false, heading = '') {
    const l = this.child('column', align);
    if (heading) l.label(heading);
    return l;
  }
  box() {
    return this.child('box', false);
  }
  split(factor = 0, align = false) {
    void factor;
    return this.child('split', align);
  }
  column_flow(columns = 0, align = false) {
    void columns;
    return this.child('column', align);
  }
  grid_flow(..._a: unknown[]) {
    return this.child('column', false);
  }
  toString() {
    return '<bpy_struct, UILayout>';
  }
}
kwMethod(UILayout.prototype, 'label', ['text', 'icon', 'icon_value', 'text_ctxt', 'translate']);
kwMethod(UILayout.prototype, 'prop', ['data', 'property', 'text', 'icon', 'expand', 'slider', 'toggle', 'icon_only', 'index', 'emboss', 'invert_checkbox', 'placeholder', 'text_ctxt', 'translate', 'event', 'full_event', 'icon_value']);
kwMethod(UILayout.prototype, 'operator', ['operator', 'text', 'icon', 'emboss', 'depress', 'icon_value', 'text_ctxt', 'translate']);
kwMethod(UILayout.prototype, 'separator', ['factor', 'type']);
kwMethod(UILayout.prototype, 'menu', ['menu', 'text', 'icon', 'text_ctxt', 'translate', 'icon_value']);
kwMethod(UILayout.prototype, 'row', ['align', 'heading', 'heading_ctxt', 'translate']);
kwMethod(UILayout.prototype, 'column', ['align', 'heading', 'heading_ctxt', 'translate']);
kwMethod(UILayout.prototype, 'split', ['factor', 'align']);
kwMethod(UILayout.prototype, 'column_flow', ['columns', 'align']);

// ---------------------------------------------------------------------------
// panels

export interface ScriptPanelSpec {
  idname: string;
  label: string;
  space: string;
  region: string;
  category: string;
  order: number;
  defaultClosed: boolean;
  hideHeader: boolean;
  poll?: () => boolean;
  draw: (layout: UILayout) => void;
  language: 'python' | 'javascript';
}

export const scriptPanels = new Map<string, ScriptPanelSpec>();
export const panelListeners = new Set<() => void>();

export function registerScriptPanel(spec: ScriptPanelSpec) {
  if (spec.space !== 'VIEW_3D' || spec.region !== 'UI') {
    app.report('WARNING', `Panel "${spec.idname}": only bl_space_type='VIEW_3D' with bl_region_type='UI' (sidebar) is supported; it will appear in the 3D viewport sidebar`);
  }
  scriptPanels.set(spec.idname, spec);
  panelListeners.forEach((f) => f());
  app.changed('ui');
}

export function unregisterScriptPanel(idname: string) {
  const ok = scriptPanels.delete(idname);
  panelListeners.forEach((f) => f());
  app.changed('ui');
  return ok;
}

// ---------------------------------------------------------------------------
// JavaScript registration helpers (bpy.types / bpy.utils for JS scripts)

/** Base classes for JavaScript scripts: `class MyOp extends bpy.types.Operator { … }`. */
export class JSOperator {
  static bl_idname = '';
  static bl_label = '';
  static bl_description = '';
  static bl_options: string[] = ['REGISTER', 'UNDO'];
  /** property declarations: `static properties = { count: bpy.props.IntProperty({ default: 3 }) }` */
  static properties: Record<string, ScriptProp> = {};
  [key: string]: unknown;
  report(type: unknown, message: string) {
    const t = [...(type instanceof Set ? type : Array.isArray(type) ? type : [type])].map(String)[0] ?? 'INFO';
    app.report(t === 'ERROR' || t === 'WARNING' ? t : 'INFO', String(message));
  }
}
export class JSPanel {
  static bl_idname = '';
  static bl_label = '';
  static bl_space_type = 'VIEW_3D';
  static bl_region_type = 'UI';
  static bl_category = 'Misc';
  static bl_order = 0;
  static bl_options: string[] = [];
  layout!: UILayout;
}

/** Base class for menus: `class MyMenu extends bpy.types.Menu { static bl_idname = 'OBJECT_MT_mine'; draw(context) { … } }`. */
export class JSMenu {
  static bl_idname = '';
  static bl_label = '';
  layout!: UILayout;
}

/** Base class for property groups: `class Settings extends bpy.types.PropertyGroup { static properties = {…} }`. */
export class JSPropertyGroup {
  static properties: Record<string, ScriptProp> = {};
}

type Ctor = { new (): Record<string, unknown>; [k: string]: unknown };

function jsRegister(cls: Ctor) {
  if (typeof cls !== 'function') throw pyError('TypeError', 'register_class(): expected a class');
  if (cls.prototype instanceof JSOperator) {
    const C = cls as unknown as typeof JSOperator & Ctor;
    registerScriptOperator({
      idname: C.bl_idname,
      label: C.bl_label,
      description: C.bl_description,
      options: [...(C.bl_options ?? [])],
      props: C.properties ?? {},
      poll: typeof (C as unknown as { poll?: unknown }).poll === 'function' ? () => !!(C as unknown as { poll: (c: unknown) => boolean }).poll(bpy.context) : undefined,
      exec: (p) => {
        const inst = new C();
        Object.assign(inst, p);
        return (inst.execute as (c: unknown) => unknown).call(inst, bpy.context);
      },
      invoke:
        typeof (C.prototype as Record<string, unknown>).invoke === 'function'
          ? (p, ev) => {
              const inst = new C();
              Object.assign(inst, p);
              return (inst.invoke as (c: unknown, e: unknown) => unknown).call(inst, bpy.context, ev);
            }
          : undefined,
      language: 'javascript',
    });
    return;
  }
  if (cls.prototype instanceof JSPanel) {
    const C = cls as unknown as typeof JSPanel & Ctor;
    registerScriptPanel({
      idname: C.bl_idname || C.name,
      label: C.bl_label || C.name,
      space: C.bl_space_type,
      region: C.bl_region_type,
      category: C.bl_category || 'Misc',
      order: C.bl_order ?? 0,
      defaultClosed: (C.bl_options ?? []).includes('DEFAULT_CLOSED'),
      hideHeader: (C.bl_options ?? []).includes('HIDE_HEADER'),
      poll: typeof (C as unknown as { poll?: unknown }).poll === 'function' ? () => !!(C as unknown as { poll: (c: unknown) => boolean }).poll(bpy.context) : undefined,
      draw: (layout) => {
        const inst = new C() as unknown as JSPanel & { draw: (c: unknown) => void };
        inst.layout = layout;
        inst.draw(bpy.context);
      },
      language: 'javascript',
    });
    return;
  }
  if (cls.prototype instanceof JSMenu) {
    const C = cls as unknown as typeof JSMenu & Ctor;
    registerScriptMenu({
      idname: C.bl_idname || C.name,
      label: C.bl_label || C.name,
      poll: typeof (C as unknown as { poll?: unknown }).poll === 'function' ? () => !!(C as unknown as { poll: (c: unknown) => boolean }).poll(bpy.context) : undefined,
      draw: (layout) => {
        const inst = new C() as unknown as JSMenu & { draw: (c: unknown) => void };
        inst.layout = layout;
        inst.draw(bpy.context);
      },
      language: 'javascript',
    });
    return;
  }
  if (cls.prototype instanceof JSPropertyGroup) {
    declareGroup(cls.name, (cls as unknown as typeof JSPropertyGroup).properties as Record<string, TypeProp>);
    markGroup(cls.name);
    return;
  }
  throw pyError('TypeError', 'register_class(): expected a subclass of bpy.types.Operator, Panel or PropertyGroup');
}

/** `bpy.types.Object` etc.: assigning a property declaration adds it to that type. */
const typeHolders = new Map<string, object>();
function typeHolder(name: string) {
  let h = typeHolders.get(name);
  if (!h)
    typeHolders.set(
      name,
      (h = new Proxy({ __kind: 'type', __name: name } as Record<string, unknown>, {
        set(t, key, v) {
          if (typeof key === 'string' && (v as { __kind?: string })?.__kind === 'propdef') declareTypeProp(name, key, v as TypeProp);
          else t[key as string] = v;
          return true;
        },
        deleteProperty(t, key) {
          if (typeof key === 'string') removeTypeProp(name, key);
          delete t[key as string];
          return true;
        },
      })),
    );
  return h;
}

function jsUnregister(cls: Ctor) {
  const id = (cls as unknown as { bl_idname?: string }).bl_idname || cls.name;
  if (!unregisterScriptOperator(id) && !unregisterScriptPanel(id) && !unregisterScriptMenu(id)) throw pyError('RuntimeError', `unregister_class(): ${id} is not registered`);
}

/** `bpy.types.<Name>` placeholders so `isinstance`-style checks and base classes exist. */
export const bpyTypes: Record<string, unknown> = new Proxy(
  { __kind: 'module', Operator: JSOperator, Panel: JSPanel, Menu: JSMenu, PropertyGroup: JSPropertyGroup, UILayout, Struct } as Record<string, unknown>,
  {
    get(t, p) {
      if (typeof p === 'symbol' || p in t) return t[p as string];
      if (/^[A-Z]/.test(p)) return typeHolder(p);
      return undefined;
    },
  },
);

export const bpyUtils = {
  __kind: 'module',
  register_class: jsRegister,
  unregister_class: jsUnregister,
  register_classes_factory(classes: Ctor[]) {
    return [() => classes.forEach(jsRegister), () => [...classes].reverse().forEach(jsUnregister)];
  },
};

bpy.props = bpyProps;
bpy.types = bpyTypes;
bpy.utils = bpyUtils;
