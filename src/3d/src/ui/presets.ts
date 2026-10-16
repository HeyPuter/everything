// Presets: named sets of values for a panel (render format, camera sensor, …) or for an
// operator's properties (shown at the top of its redo panel and dialog). Built-in presets come
// with the kind; the user's own are kept in IndexedDB (in memory when it is unavailable) and are
// read once at startup so menus can list them right away.
import { h, type Child } from './h';
import { icon } from './icons';
import { app, defaultProps, operators, registerOperators, type Operator } from '../app/app';
import { openMenu, promptText, type MenuItem } from './menu';

export type PresetValues = Record<string, unknown>;

export interface PresetKind {
  id: string;
  /** menu title, e.g. "Format Presets" */
  label: string;
  /** the current values a new preset stores */
  capture(): PresetValues;
  /** set the values of a preset (the caller pushes the undo step) */
  apply(values: PresetValues, name: string): void;
  /** presets that come with the app, [name, values] */
  builtins?: () => [string, PresetValues][];
  /** undo step name when applying (default "Apply Preset"); null: not an undo step */
  undo?: string | null;
  /** operator that adds (or with remove_name removes) a preset of this kind, e.g. "cloth.preset_add" */
  addOp?: string;
}

const kinds = new Map<string, PresetKind>();

const opKinds = new Map<string, string>();

export function registerPresetKind(k: PresetKind) {
  kinds.set(k.id, k);
  if (k.addOp && !opKinds.has(k.addOp)) {
    opKinds.set(k.addOp, k.id);
    registerOperators([addPresetOperator(k.addOp, `Add ${k.label.replace(/ Presets$/, '')} Preset`, k.id)]);
  }
}

export function presetKind(id: string): PresetKind | undefined {
  return kinds.get(id) ?? operatorKind(id);
}

// ---------------------------------------------------------------------------
// storage

const DB = 'p3d-presets';
const STORE = 'presets';
/** user presets: kind → name → values */
const user = new Map<string, Map<string, PresetValues>>();
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

/** Read the stored presets (once); resolves when they are in memory. */
export const presetsLoaded: Promise<void> = (async () => {
  const d = await db();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => {
        for (const r of req.result as { kind: string; name: string; values: PresetValues }[]) {
          if (!r || typeof r.kind !== 'string' || typeof r.name !== 'string') continue;
          // presets written before startup finished win over the stored copy
          const m = user.get(r.kind) ?? user.set(r.kind, new Map()).get(r.kind)!;
          if (!m.has(r.name)) m.set(r.name, r.values ?? {});
        }
        resolve();
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
})();

let writes: Promise<void> = Promise.resolve();

function persist(kind: string, name: string, values: PresetValues | null) {
  writes = writes.then(async () => {
    const d = await db();
    if (!d) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = d.transaction(STORE, 'readwrite');
        const st = tx.objectStore(STORE);
        const key = `${kind}/${name}`;
        if (values) st.put({ key, kind, name, values: structuredClone(values) });
        else st.delete(key);
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      } catch {
        // storage unavailable: the preset lasts for this session
        resolve();
      }
    });
  });
}

/** Resolves once every preset change so far is stored. */
export function presetsSaved(): Promise<void> {
  return writes;
}

export function userPresets(kind: string): [string, PresetValues][] {
  return [...(user.get(kind) ?? new Map<string, PresetValues>())].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
}

export function savePreset(kind: string, name: string, values: PresetValues) {
  const m = user.get(kind) ?? user.set(kind, new Map()).get(kind)!;
  m.set(name, structuredClone(values));
  persist(kind, name, values);
}

export function removePreset(kind: string, name: string): boolean {
  const m = user.get(kind);
  if (!m?.delete(name)) return false;
  persist(kind, name, null);
  return true;
}

/** All presets of a kind: built-in first, then the user's. */
export function allPresets(kind: string): { name: string; values: PresetValues; builtin: boolean }[] {
  const k = presetKind(kind);
  return [...(k?.builtins?.() ?? []).map(([name, values]) => ({ name, values, builtin: true })), ...userPresets(kind).map(([name, values]) => ({ name, values, builtin: false }))];
}

/** Last preset applied per kind (shown on the operator preset button). */
const lastApplied = new Map<string, string>();

export function applyPreset(kind: string, name: string): boolean {
  const k = presetKind(kind);
  const p = allPresets(kind).find((x) => x.name === name);
  if (!k || !p) return false;
  k.apply(structuredClone(p.values), name);
  lastApplied.set(kind, name);
  if (k.undo !== null) app.pushUndo(k.undo ?? 'Apply Preset');
  app.changed('doc');
  return true;
}

// ---------------------------------------------------------------------------
// operator presets

/** Operator properties a preset stores (visible ones). */
export function operatorPresetValues(idname: string, props: Record<string, unknown>): PresetValues {
  const op = operators.get(idname);
  const out: PresetValues = {};
  for (const d of op?.props ?? []) if (!d.hidden && d.id in props) out[d.id] = structuredClone(props[d.id]);
  return out;
}

/** Where operator presets of the open redo panel / dialog read and write their values. */
const opTargets = new Map<string, { get(): Record<string, unknown>; set(v: PresetValues): void }>();

export function setOperatorPresetTarget(idname: string, t: { get(): Record<string, unknown>; set(v: PresetValues): void } | null) {
  if (t) opTargets.set(idname, t);
  else opTargets.delete(idname);
}

/** Put the open redo panel / dialog of an operator back to its default values. */
function restoreOperatorDefaults(idname: string) {
  const op = operators.get(idname);
  if (!op) return;
  const t = opTargets.get(idname);
  lastApplied.delete(`op:${idname}`);
  if (t) t.set(operatorPresetValues(idname, defaultProps(op)));
  else app.run('wm.operator_defaults');
}

function operatorKind(id: string): PresetKind | undefined {
  if (!id.startsWith('op:')) return undefined;
  const idname = id.slice(3);
  const op = operators.get(idname);
  if (!op) return undefined;
  return {
    id,
    label: 'Operator Presets',
    undo: null,
    capture: () => operatorPresetValues(idname, opTargets.get(idname)?.get() ?? app.lastOp?.props ?? {}),
    apply: (values) => {
      const known = operatorPresetValues(idname, { ...values });
      const t = opTargets.get(idname);
      if (t) t.set(known);
      else if (app.lastOp?.idname === idname) app.redoLast(known);
    },
  };
}

// ---------------------------------------------------------------------------
// menus and buttons

/** Ask for a name and save the current values as a preset. */
export function addPresetPrompt(kind: string) {
  const k = presetKind(kind);
  if (!k) return;
  promptText('New Preset', lastApplied.get(kind) && !allPresets(kind).find((p) => p.name === lastApplied.get(kind))?.builtin ? lastApplied.get(kind)! : '', (name) => {
    name = name.trim();
    if (!name) return;
    runAdd(kind, name, false);
  });
}

/** Add (or remove) a preset through its kind's operator, so it can be scripted and searched. */
function runAdd(kind: string, name: string, remove: boolean) {
  if (kind.startsWith('op:')) app.run('wm.operator_preset_add', { name, operator: kind.slice(3), remove_name: remove });
  else {
    const op = presetKind(kind)?.addOp;
    if (op) app.run(op, { name, remove_name: remove });
    else addOrRemove(kind, name, remove);
  }
}

/** Save the current values as a preset, or remove one; shared by the preset operators. */
function addOrRemove(kind: string, name: string, remove: boolean): boolean {
  const k = presetKind(kind);
  if (!k || !name) return false;
  if (remove) {
    if (!removePreset(kind, name)) return false;
    if (lastApplied.get(kind) === name) lastApplied.delete(kind);
    app.report('INFO', `Removed preset "${name}"`);
  } else {
    savePreset(kind, name, k.capture());
    lastApplied.set(kind, name);
    app.report('INFO', `Saved preset "${name}"`);
  }
  app.changed('ui');
  return true;
}

function addPresetOperator(idname: string, label: string, kind: string): Operator {
  return {
    idname,
    label,
    description: 'Save the current settings as a preset (or remove a preset of yours)',
    undo: false,
    props: [
      { id: 'name', label: 'Name', type: 'string', default: '' },
      { id: 'remove_name', label: 'Remove Name', type: 'bool', default: false, hidden: true },
      { id: 'remove_active', label: 'Remove Active', type: 'bool', default: false, hidden: true },
    ],
    exec: (_c, p) => {
      const name = String(p.remove_active ? (lastApplied.get(kind) ?? '') : (p.name ?? '')).trim();
      return addOrRemove(kind, name, !!(p.remove_name || p.remove_active)) ? 'FINISHED' : 'CANCELLED';
    },
  };
}

export function presetMenu(kind: string): MenuItem[] {
  const list = allPresets(kind);
  const own = list.filter((p) => !p.builtin);
  const cur = lastApplied.get(kind);
  const items: MenuItem[] = list.map((p) => ({ label: p.name, active: p.name === cur, action: () => applyPreset(kind, p.name) }));
  if (!list.length) items.push({ heading: 'No presets yet' });
  if (kind.startsWith('op:')) items.push({ separator: true }, { label: 'Restore Defaults', action: () => restoreOperatorDefaults(kind.slice(3)) });
  items.push(
    { separator: true },
    { label: 'Add Preset…', icon: 'add', action: () => addPresetPrompt(kind) },
    ...(own.length
      ? [
          {
            label: 'Remove Preset',
            icon: 'remove',
            submenu: () =>
              own.map((p) => ({
                label: p.name,
                action: () => runAdd(kind, p.name, true),
              })),
          },
        ]
      : []),
  );
  return items;
}

/** The stacked-lines button in a panel header that opens the preset menu. */
export function presetButton(kind: string, tip?: string): Child {
  const k = presetKind(kind);
  return h(
    'button',
    {
      class: 'hdr-toggle preset-btn',
      'data-tip': tip ?? k?.label ?? 'Presets',
      'data-preset': kind,
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(presetMenu(kind), e.currentTarget as HTMLElement, { title: k?.label ?? 'Presets' });
      },
    },
    icon('collapsemenu'),
  );
}

/** The preset row at the top of a redo panel / operator dialog: menu, add, remove. */
export function operatorPresetRow(idname: string): Child {
  const kind = `op:${idname}`;
  const cur = lastApplied.get(kind);
  const own = userPresets(kind);
  return h(
    'div',
    { class: 'op-presets', 'data-preset': kind },
    h(
      'button',
      {
        class: 'enum-menu op-preset-menu',
        'data-tip': 'Operator Presets\nSaved settings for this operation',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(presetMenu(kind), e.currentTarget as HTMLElement, { title: 'Operator Presets' });
        },
      },
      h('span', { class: 'em-label' }, cur && allPresets(kind).some((p) => p.name === cur) ? cur : 'Operator Presets'),
      h('span', { class: 'em-arrow' }, icon('down_arrow_hlt')),
    ),
    h('button', { class: 'icon-btn', 'data-tip': 'Add Preset', onclick: () => addPresetPrompt(kind) }, icon('add')),
    h(
      'button',
      {
        class: 'icon-btn',
        'data-tip': 'Remove the selected preset',
        disabled: !cur || !own.some(([n]) => n === cur),
        onclick: () => cur && app.run('wm.operator_preset_add', { name: cur, operator: idname, remove_name: true }),
      },
      icon('remove'),
    ),
  );
}

registerOperators([
  {
    idname: 'wm.operator_preset_add',
    label: 'Add Operator Preset',
    description: 'Save the settings of the operation as a preset (or remove a preset)',
    undo: false,
    internal: true,
    props: [
      { id: 'name', label: 'Name', type: 'string', default: '' },
      { id: 'operator', label: 'Operator', type: 'string', default: '' },
      { id: 'remove_name', label: 'Remove Name', type: 'bool', default: false },
      { id: 'remove_active', label: 'Remove Active', type: 'bool', default: false, hidden: true },
    ],
    exec: (_c, p) => {
      const kind = `op:${String(p.operator ?? '')}`;
      const name = String(p.remove_active ? (lastApplied.get(kind) ?? '') : (p.name ?? '')).trim();
      return addOrRemove(kind, name, !!(p.remove_name || p.remove_active)) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'wm.operator_presets_cleanup',
    label: 'Clean Up Operator Presets',
    description: 'Remove values that operations no longer have from saved operator presets',
    undo: false,
    exec: () => {
      let n = 0;
      for (const [kind, m] of user) {
        if (!kind.startsWith('op:')) continue;
        const op = operators.get(kind.slice(3));
        for (const [name, values] of m) {
          const keep = op ? operatorPresetValues(op.idname, values) : {};
          if (Object.keys(keep).length !== Object.keys(values).length) {
            n++;
            if (!op || !Object.keys(keep).length) removePreset(kind, name);
            else savePreset(kind, name, keep);
          }
        }
      }
      app.report('INFO', n ? `Cleaned up ${n} preset${n === 1 ? '' : 's'}` : 'All operator presets are up to date');
    },
  },
  {
    idname: 'script.execute_preset',
    label: 'Apply Preset',
    description: 'Apply a preset by name',
    undo: false,
    internal: true,
    props: [
      { id: 'filepath', label: 'Name', type: 'string', default: '' },
      { id: 'menu_idname', label: 'Preset Menu', type: 'string', default: '' },
    ],
    exec: (_c, p) => (applyPreset(String(p.menu_idname ?? ''), String(p.filepath ?? '')) ? 'FINISHED' : 'CANCELLED'),
  },
]);
