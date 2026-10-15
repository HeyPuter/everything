// Key configuration model (pure, no DOM): the factory keymap items registered by the
// modules, a preset that rebinds them, user edits on top, items the user added or removed.
// `KeyconfigState.apply()` rewrites the live KeyItem objects so the dispatcher sees the result.
import type { KeyItem, KeyValue } from '../app/keymap';
import type { MenuItem } from '../ui/menu';

/** Serializable fields of a key item. */
export interface ItemFields {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  any: boolean;
  value: KeyValue;
  repeat: boolean;
  op: string;
  props: Record<string, unknown>;
  active: boolean;
}

export type Edit = Partial<ItemFields>;

export interface UserItem extends ItemFields {
  uid: string;
  km: string;
}

/** Options that rebind several items at once (shown above the keymap list). */
export interface KeyconfigOptions {
  /** what Space does: play animation, open the tool menu or search */
  spacebar_action: 'PLAY' | 'TOOL' | 'SEARCH';
  /** A toggles between select all and deselect all */
  use_select_all_toggle: boolean;
  /** Tab opens the mode pie (Ctrl Tab toggles Edit Mode) */
  use_v3d_tab_menu: boolean;
  /** G / R / S switch to the move / rotate / scale tool instead of moving at once */
  use_key_activate_tools: boolean;
}

export const defaultOptions = (): KeyconfigOptions => ({ spacebar_action: 'PLAY', use_select_all_toggle: false, use_v3d_tab_menu: false, use_key_activate_tools: false });

/** Everything the user changed; also the import / export file format. */
export interface KeyconfigData {
  format: 'p3d-keyconfig';
  version: 1;
  name?: string;
  preset: string;
  options: KeyconfigOptions;
  edits: Record<string, Edit>;
  removed: string[];
  added: UserItem[];
}

export const emptyKeyconfig = (preset = 'DEFAULT'): KeyconfigData => ({ format: 'p3d-keyconfig', version: 1, preset, options: defaultOptions(), edits: {}, removed: [], added: [] });

/** Matches factory items for a preset rule. */
export interface ItemMatch {
  op?: string;
  /** subset of the item's operator properties */
  props?: Record<string, unknown>;
  /** title of a menu item (items that open a menu instead of running an operator) */
  menu?: string;
  key?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface PresetRule {
  km: string;
  match: ItemMatch;
  /** new values; `active: false` turns the item off */
  set: Edit;
}

export interface PresetAdd {
  km: string;
  /** copy the context, menu and operator of this factory item (in `like.km` or `km`) */
  like?: ItemMatch & { km?: string };
  set: Edit & { key: string };
}

export interface PresetDef {
  id: string;
  label: string;
  description: string;
  rules: PresetRule[];
  add: PresetAdd[];
}

interface Factory {
  id: string;
  km: string;
  fields: ItemFields;
  menu?: () => MenuItem[];
  menuTitle?: string;
  action?: () => void;
  when?: () => boolean;
}

export function fieldsOf(k: KeyItem): ItemFields {
  return {
    key: k.key,
    ctrl: !!k.ctrl,
    shift: !!k.shift,
    alt: !!k.alt,
    any: !!k.any,
    value: k.value ?? 'PRESS',
    repeat: k.repeat !== false,
    op: k.op ?? '',
    props: k.props ? { ...k.props } : {},
    active: !k.inactive,
  };
}

const bindingText = (f: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean; any?: boolean }) => `${f.any ? 'any+' : ''}${f.ctrl ? 'ctrl+' : ''}${f.shift ? 'shift+' : ''}${f.alt ? 'alt+' : ''}${f.key}`;

function sortedJson(o: Record<string, unknown>) {
  const keys = Object.keys(o).sort();
  return keys.length ? JSON.stringify(keys.map((k) => [k, o[k]])) : '';
}

export function matchItem(m: ItemMatch, f: ItemFields, menuTitle?: string): boolean {
  if (m.op !== undefined && m.op !== f.op) return false;
  if (m.menu !== undefined && (f.op || m.menu !== menuTitle)) return false;
  if (m.key !== undefined && m.key !== f.key) return false;
  if (m.ctrl !== undefined && m.ctrl !== f.ctrl) return false;
  if (m.shift !== undefined && m.shift !== f.shift) return false;
  if (m.alt !== undefined && m.alt !== f.alt) return false;
  if (m.props) for (const [k, v] of Object.entries(m.props)) if (JSON.stringify(f.props[k]) !== JSON.stringify(v)) return false;
  return true;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The edit that turns `base` into `next` (only the fields that differ). */
export function diffFields(base: ItemFields, next: ItemFields): Edit {
  const out: Edit = {};
  for (const k of Object.keys(next) as (keyof ItemFields)[]) if (!sameValue(base[k], next[k])) (out as Record<string, unknown>)[k] = next[k];
  return out;
}

/** Built-in rules that follow the keyconfig options. */
function optionRules(o: KeyconfigOptions): { rules: PresetRule[]; add: PresetAdd[] } {
  const rules: PresetRule[] = [];
  const add: PresetAdd[] = [];
  if (o.spacebar_action === 'TOOL') {
    rules.push({ km: 'Frames', match: { op: 'screen.animation_play', key: 'SPACE', ctrl: false, shift: false }, set: { shift: true } });
    rules.push({ km: 'Window', match: { op: 'wm.toolbar', key: 'SPACE', shift: true }, set: { shift: false } });
  } else if (o.spacebar_action === 'SEARCH') {
    rules.push({ km: 'Frames', match: { op: 'screen.animation_play', key: 'SPACE', ctrl: false, shift: false }, set: { shift: true } });
    rules.push({ km: 'Window', match: { op: 'wm.toolbar', key: 'SPACE', shift: true }, set: { active: false } });
    add.push({ km: 'Window', set: { key: 'SPACE', op: 'wm.search_menu' } });
  }
  if (o.use_select_all_toggle)
    for (const [km, op] of [
      ['Object Mode', 'object.select_all'],
      ['Mesh', 'mesh.select_all'],
      ['Curve', 'curve.select_all'],
      ['Armature', 'armature.select_all'],
      ['Pose', 'pose.select_all'],
      ['Lattice', 'lattice.select_all'],
      ['Metaball', 'mball.select_all'],
      ['UV Editor', 'uv.select_all'],
      ['Graph Editor', 'graph.select_all'],
      ['Dopesheet', 'action.select_all'],
      ['NLA Editor', 'nla.select_all'],
      ['Node Editor', 'node.select_all'],
      ['Sequencer', 'sequencer.select_all'],
      ['Clip Editor', 'clip.select_all'],
      ['Grease Pencil', 'grease_pencil.select_all'],
      ['Animation Channels', 'anim.channels_select_all'],
      ['Markers', 'marker.select_all'],
    ])
      rules.push({ km, match: { op, props: { action: 'SELECT' }, key: 'A', ctrl: false, shift: false, alt: false }, set: { props: { action: 'TOGGLE' } } });
  if (o.use_v3d_tab_menu) {
    rules.push({ km: '3D View', match: { op: 'object.editmode_toggle', key: 'TAB', ctrl: false }, set: { ctrl: true } });
    rules.push({ km: '3D View', match: { op: 'view3d.pie_mode', key: 'TAB', ctrl: true }, set: { ctrl: false } });
    rules.push({ km: '3D View', match: { op: 'object.posemode_toggle', key: 'TAB', ctrl: true }, set: { active: false } });
  }
  if (o.use_key_activate_tools)
    for (const [op, key, name] of [
      ['transform.translate', 'G', 'builtin.move'],
      ['transform.rotate', 'R', 'builtin.rotate'],
      ['transform.resize', 'S', 'builtin.scale'],
    ])
      rules.push({ km: '3D View', match: { op, key, ctrl: false, shift: false, alt: false }, set: { op: 'wm.tool_set_by_id', props: { name } } });
  return { rules, add };
}

/**
 * Live key configuration. `keymaps` is the dispatcher's table; items present when `snapshot()`
 * runs (or added later through `snapshot(km, items)`) become the factory defaults.
 */
export class KeyconfigState {
  data: KeyconfigData = emptyKeyconfig();
  private factory = new WeakMap<KeyItem, Factory>();
  private ids = new Map<string, KeyItem>();
  /** items inserted by the preset / options and by the user, per keymap */
  private inserted = new Map<KeyItem, { id: string; km: string; base: ItemFields; user?: boolean }>();
  private counts = new Map<string, number>();

  constructor(
    public keymaps: Record<string, KeyItem[]>,
    public presets: PresetDef[],
  ) {}

  /** Record factory defaults of all items not seen yet. */
  snapshot(onlyKm?: string, onlyItems?: KeyItem[]) {
    const entries = onlyKm ? [[onlyKm, onlyItems ?? this.keymaps[onlyKm] ?? []] as const] : Object.entries(this.keymaps);
    for (const [km, list] of entries)
      for (const k of list) {
        if (this.factory.has(k) || this.inserted.has(k)) continue;
        const fields = fieldsOf(k);
        const sig = `${km}/${fields.op || `menu:${k.menuTitle ?? ''}`}${sortedJson(fields.props)}/${bindingText(fields)}`;
        const n = this.counts.get(sig) ?? 0;
        this.counts.set(sig, n + 1);
        const id = n ? `${sig}#${n}` : sig;
        this.factory.set(k, { id, km, fields, menu: k.menu, menuTitle: k.menuTitle, action: k.action, when: k.when });
        this.ids.set(id, k);
      }
  }

  preset(): PresetDef | undefined {
    return this.presets.find((p) => p.id === this.data.preset);
  }

  private ruleSets() {
    const p = this.preset();
    const o = optionRules({ ...defaultOptions(), ...this.data.options });
    return { rules: [...(p?.rules ?? []), ...o.rules], add: [...(p?.add ?? []), ...o.add] };
  }

  /** Rewrite all live items from factory + preset + options + user edits. */
  apply() {
    // take out what we inserted last time (objects are reused by id so references stay valid)
    const reuse = new Map<string, KeyItem>();
    for (const [k, info] of this.inserted) {
      reuse.set(info.id, k);
      const list = this.keymaps[info.km];
      const i = list?.indexOf(k) ?? -1;
      if (i >= 0) list.splice(i, 1);
    }
    this.inserted.clear();
    const { rules, add } = this.ruleSets();
    const removed = new Set(this.data.removed);
    for (const [km, list] of Object.entries(this.keymaps))
      for (const k of list) {
        const f = this.factory.get(k);
        if (!f) continue;
        let base = { ...f.fields, props: { ...f.fields.props } };
        for (const r of rules) if (r.km === km && matchItem(r.match, f.fields, f.menuTitle)) base = { ...base, ...r.set };
        this.write(k, f, { ...base, ...this.data.edits[f.id] }, removed.has(f.id));
      }
    // preset / option items, then user items, go first so they win over factory bindings
    const front = new Map<string, KeyItem[]>();
    const userFront = new Map<string, KeyItem[]>();
    add.forEach((a, i) => {
      const id = `preset:${this.data.preset}:${a.km}:${i}:${bindingText(a.set)}`;
      let like: Factory | undefined;
      if (a.like) {
        const lkm = a.like.km ?? a.km;
        const k = (this.keymaps[lkm] ?? []).find((x) => {
          const f = this.factory.get(x);
          return !!f && matchItem(a.like!, f.fields, f.menuTitle);
        });
        like = k ? this.factory.get(k) : undefined;
        if (!like) return;
      }
      const base: ItemFields = { ...(like?.fields ?? fieldsOf({ key: a.set.key })), ...a.set };
      if (!like) base.props = { ...(a.set.props ?? {}) };
      const item: KeyItem = reuse.get(id) ?? { key: base.key };
      item.when = like?.when;
      const sameOp = !!like && base.op === like.fields.op;
      const f: Factory = like ? { ...like, id, km: a.km, fields: base, menu: sameOp ? like.menu : undefined, menuTitle: sameOp ? like.menuTitle : undefined, action: sameOp ? like.action : undefined } : { id, km: a.km, fields: base };
      item.menu = f.menu;
      item.menuTitle = f.menuTitle;
      item.action = f.action;
      this.write(item, f, { ...base, ...this.data.edits[id] }, removed.has(id));
      this.inserted.set(item, { id, km: a.km, base });
      (front.get(a.km) ?? front.set(a.km, []).get(a.km)!).push(item);
    });
    for (const u of this.data.added) {
      const fields: ItemFields = { ...fieldsOf({ key: u.key }), ...pickFields(u as unknown as Record<string, unknown>) };
      const item: KeyItem = reuse.get(`user:${u.uid}`) ?? { key: fields.key };
      this.write(item, { id: `user:${u.uid}`, km: u.km, fields }, fields, false);
      this.inserted.set(item, { id: `user:${u.uid}`, km: u.km, base: fields, user: true });
      (userFront.get(u.km) ?? userFront.set(u.km, []).get(u.km)!).push(item);
    }
    // user items first, then the preset's, then the factory items
    for (const [km, items] of front) (this.keymaps[km] ??= []).unshift(...items);
    for (const [km, items] of userFront) (this.keymaps[km] ??= []).unshift(...items);
  }

  private write(k: KeyItem, f: Factory, v: ItemFields, removed: boolean) {
    k.key = v.key;
    k.ctrl = v.ctrl || undefined;
    k.shift = v.shift || undefined;
    k.alt = v.alt || undefined;
    k.any = v.any || undefined;
    k.value = v.value === 'PRESS' ? undefined : v.value;
    k.repeat = v.repeat ? undefined : false;
    k.inactive = !v.active || removed || undefined;
    const sameOp = v.op === f.fields.op;
    k.op = v.op || undefined;
    k.props = Object.keys(v.props).length ? { ...v.props } : undefined;
    k.menu = sameOp ? f.menu : undefined;
    k.menuTitle = sameOp ? f.menuTitle : undefined;
    k.action = sameOp ? f.action : undefined;
  }

  // ------------------------------------------------------------------ queries

  /** Stable id of a live item ('' for unknown items). */
  idOf(k: KeyItem): string {
    return this.factory.get(k)?.id ?? this.inserted.get(k)?.id ?? '';
  }

  isUserItem(k: KeyItem) {
    return !!this.inserted.get(k)?.user;
  }

  isRemoved(k: KeyItem) {
    return this.data.removed.includes(this.idOf(k));
  }

  /** Fields before user edits (factory + preset + options). */
  baseFields(k: KeyItem): ItemFields {
    const ins = this.inserted.get(k);
    if (ins) return { ...ins.base };
    const f = this.factory.get(k);
    if (!f) return fieldsOf(k);
    let base = { ...f.fields };
    const { rules } = this.ruleSets();
    for (const r of rules) if (r.km === f.km && matchItem(r.match, f.fields, f.menuTitle)) base = { ...base, ...r.set };
    return base;
  }

  /** Factory menu title of an item that opens a menu (kept when the operator is unchanged). */
  factoryMenuTitle(k: KeyItem) {
    return this.factory.get(k)?.menuTitle;
  }

  isModified(k: KeyItem): boolean {
    const id = this.idOf(k);
    if (this.isUserItem(k)) return true;
    return this.data.removed.includes(id) || Object.keys(this.data.edits[id] ?? {}).length > 0;
  }

  modifiedCount(km?: string): number {
    let n = 0;
    for (const [name, list] of Object.entries(this.keymaps)) if (!km || name === km) for (const k of list) if (this.isModified(k)) n++;
    return n;
  }

  // ------------------------------------------------------------------ edits

  /** Change fields of an item (user items are changed directly). */
  edit(k: KeyItem, change: Edit) {
    const id = this.idOf(k);
    if (!id) return;
    const ins = this.inserted.get(k);
    if (ins?.user) {
      const u = this.data.added.find((x) => `user:${x.uid}` === id);
      if (u) Object.assign(u, change, change.op !== undefined && change.op !== u.op && change.props === undefined ? { props: {} } : {});
    } else {
      const base = this.baseFields(k);
      const cur: ItemFields = { ...base, ...this.data.edits[id] };
      const next: ItemFields = { ...cur, ...change };
      if (change.op !== undefined && change.op !== cur.op && change.props === undefined) next.props = {};
      const d = diffFields(base, next);
      if (Object.keys(d).length) this.data.edits[id] = d;
      else delete this.data.edits[id];
    }
    this.apply();
  }

  /** Add a new item at the top of a keymap; returns it. */
  addItem(km: string, fields: Partial<ItemFields> = {}): KeyItem {
    const uid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const base = fieldsOf({ key: 'NONE' });
    this.data.added.push({ ...base, ...fields, props: { ...(fields.props ?? {}) }, uid, km });
    this.apply();
    return [...this.inserted].find(([, v]) => v.id === `user:${uid}`)![0];
  }

  /** Remove an item: user items are deleted, defaults are hidden until restored. */
  remove(k: KeyItem) {
    const id = this.idOf(k);
    if (!id) return;
    if (this.isUserItem(k)) this.data.added = this.data.added.filter((u) => `user:${u.uid}` !== id);
    else if (!this.data.removed.includes(id)) this.data.removed.push(id);
    this.apply();
  }

  /** Restore one item to its default (factory + preset). */
  restore(k: KeyItem) {
    const id = this.idOf(k);
    delete this.data.edits[id];
    this.data.removed = this.data.removed.filter((x) => x !== id);
    this.apply();
  }

  /** Restore one keymap (drops its user items too). */
  restoreKeymap(km: string) {
    for (const k of this.keymaps[km] ?? []) {
      const id = this.idOf(k);
      delete this.data.edits[id];
      this.data.removed = this.data.removed.filter((x) => x !== id);
    }
    this.data.added = this.data.added.filter((u) => u.km !== km);
    this.apply();
  }

  restoreAll() {
    this.data = { ...emptyKeyconfig(this.data.preset), options: this.data.options };
    this.apply();
  }

  /** Replace the configuration (import, preset switch). */
  load(d: KeyconfigData) {
    this.data = normalizeKeyconfig(d);
    this.apply();
  }

  /** A serializable copy (export). */
  export(name?: string): KeyconfigData {
    return JSON.parse(JSON.stringify({ ...this.data, name: name ?? this.data.name })) as KeyconfigData;
  }

  /** Default item looked up by id (for tests and migration). */
  itemById(id: string): KeyItem | undefined {
    return this.ids.get(id) ?? [...this.inserted].find(([, v]) => v.id === id)?.[0];
  }
}

const FIELD_KEYS: (keyof ItemFields)[] = ['key', 'ctrl', 'shift', 'alt', 'any', 'value', 'repeat', 'op', 'props', 'active'];
const VALUES: KeyValue[] = ['PRESS', 'RELEASE', 'CLICK', 'DOUBLE_CLICK'];

function pickFields(o: Record<string, unknown>): Edit {
  const out: Record<string, unknown> = {};
  for (const k of FIELD_KEYS) {
    const v = o[k];
    if (v === undefined) continue;
    if (k === 'key' || k === 'op') {
      if (typeof v === 'string') out[k] = v;
    } else if (k === 'value') {
      if (VALUES.includes(v as KeyValue)) out[k] = v;
    } else if (k === 'props') {
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...(v as object) };
    } else if (typeof v === 'boolean') out[k] = v;
  }
  return out as Edit;
}

/** Validate untrusted keyconfig data (imported files, storage). Throws on wrong format. */
export function normalizeKeyconfig(raw: unknown): KeyconfigData {
  if (!raw || typeof raw !== 'object') throw new Error('Not a key configuration');
  const r = raw as Record<string, unknown>;
  if (r.format !== 'p3d-keyconfig') throw new Error('Not a key configuration file');
  const out = emptyKeyconfig(typeof r.preset === 'string' ? r.preset : 'DEFAULT');
  if (typeof r.name === 'string') out.name = r.name;
  const o = (r.options ?? {}) as Record<string, unknown>;
  if (['PLAY', 'TOOL', 'SEARCH'].includes(o.spacebar_action as string)) out.options.spacebar_action = o.spacebar_action as KeyconfigOptions['spacebar_action'];
  if (typeof o.use_select_all_toggle === 'boolean') out.options.use_select_all_toggle = o.use_select_all_toggle;
  if (typeof o.use_v3d_tab_menu === 'boolean') out.options.use_v3d_tab_menu = o.use_v3d_tab_menu;
  if (typeof o.use_key_activate_tools === 'boolean') out.options.use_key_activate_tools = o.use_key_activate_tools;
  if (r.edits && typeof r.edits === 'object') for (const [id, e] of Object.entries(r.edits as Record<string, unknown>)) if (e && typeof e === 'object') out.edits[id] = pickFields(e as Record<string, unknown>);
  if (Array.isArray(r.removed)) out.removed = r.removed.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(r.added))
    for (const a of r.added) {
      if (!a || typeof a !== 'object') continue;
      const u = a as Record<string, unknown>;
      if (typeof u.km !== 'string' || typeof u.key !== 'string') continue;
      out.added.push({ ...fieldsOf({ key: u.key }), ...pickFields(u), uid: typeof u.uid === 'string' ? u.uid : Math.random().toString(36).slice(2), km: u.km });
    }
  return out;
}
