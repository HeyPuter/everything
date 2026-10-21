// Generic interactions on property buttons, available on every data-bound widget: copy / paste
// the value, reset to default, keyframes and drivers, data paths, copy to selected objects,
// eyedroppers, and the right-click button menu. Shortcuts live in the "User Interface" keymap and
// apply to the button under the pointer.
import { app, operators, registerOperators, type OpContext } from '../app/app';
import { addKeys, keymaps, keyInputHooks, keyName, keyLabel, type KeyItem } from '../app/keymap';
import { openMenu, tooltipHooks, menuSettings, type MenuItem } from './menu';
import { bindingAt, bindingValue, buttonHooks, getBinding, type PropBinding } from './binding';
import { animTarget, fullDataPath, locateOwner, relDataPath, type OwnerLoc } from './rnapath';
import { keyProperty, keyState } from '../anim/keyframes';
import { tokenize, resolve, getValue } from '../data/rna';
import { parseNumber, linearToSrgb, srgbToLinear } from './widgets';
import { emptyDocument, newObject, newLight, newCamera, newMaterial, newWorld, newCurve, newCollection, newArmature, newLattice } from '../data/defaults';
import { modifierTypes, newModifier } from '../eval/modifiers';
import { constraintTypes, newConstraint } from '../eval/constraints';
import type { DocumentData, ObjectData } from '../data/types';
import { Vector3 } from 'three';

// ---------------------------------------------------------------------------
// target button

/** Binding fixed for the duration of a call (menu items act on the button they were opened from). */
let forced: PropBinding | null = null;

/** The button under the pointer (or the one a context menu was opened from). */
export function targetButton(): PropBinding | undefined {
  if (forced) return forced;
  const el = document.elementFromPoint(app.pointer.x, app.pointer.y);
  if (!el || el.closest('.popup-layer')) return undefined;
  const b = bindingAt(el);
  return b && !b.disabled ? b : undefined;
}

function withButton<T>(b: PropBinding, fn: () => T): T {
  const prev = forced;
  forced = b;
  try {
    return fn();
  } finally {
    forced = prev;
  }
}

const isArray = (v: unknown): v is number[] => Array.isArray(v) || ArrayBuffer.isView(v);

/** Location of the button's owner in the document. */
function ownerLoc(b: PropBinding): OwnerLoc | null {
  return locateOwner(app.doc, b.owner, app.revision);
}

/** Object + path that animate the button, if it can be animated. */
export function animOf(b: PropBinding): { ob: ObjectData; path: string; index: number } | null {
  const idx = b.index ?? -1;
  if (b.anim) return { ob: b.anim.ob, path: b.anim.path, index: b.anim.index ?? idx };
  const loc = ownerLoc(b);
  if (!loc) return null;
  const t = animTarget(app.doc, loc, b.key, app.activeObject);
  if (!t) return null;
  // the path must address a number / bool / numeric array (a value not stored yet uses its default)
  const v = getValue(app.doc, t.ob, t.path) ?? (b.owner[b.key] === undefined ? b.def : undefined);
  if (typeof v !== 'number' && typeof v !== 'boolean' && !isArray(v)) return null;
  return { ob: t.ob, path: t.path, index: idx };
}

function changed(b: PropBinding, label: string) {
  b.onChange?.();
  app.graph.invalidate?.();
  app.pushUndo(label);
  app.changed('doc');
}

function write(b: PropBinding, v: unknown, all: boolean) {
  const cur = b.owner[b.key];
  if (isArray(cur)) {
    const arr = cur as number[];
    if (all && isArray(v)) {
      const next = Array.from(arr);
      for (let i = 0; i < next.length && i < (v as number[]).length; i++) next[i] = clamp(b, Number((v as number[])[i]));
      b.owner[b.key] = ArrayBuffer.isView(arr) ? new (arr.constructor as Float32ArrayConstructor)(next) : next;
    } else if (b.index !== undefined) {
      const next = Array.from(arr);
      next[b.index] = clamp(b, Number(isArray(v) ? ((v as number[])[b.index] ?? (v as number[])[0]) : v));
      b.owner[b.key] = ArrayBuffer.isView(arr) ? new (arr.constructor as Float32ArrayConstructor)(next) : next;
    } else if (isArray(v))
      b.owner[b.key] = Array.from(v as number[])
        .slice(0, arr.length)
        .concat(Array.from(arr).slice((v as number[]).length));
    return;
  }
  if (typeof cur === 'number' && typeof v === 'number') b.owner[b.key] = clamp(b, v);
  else b.owner[b.key] = v;
}

function clamp(b: PropBinding, v: number) {
  if (b.min !== undefined) v = Math.max(b.min, v);
  if (b.max !== undefined) v = Math.min(b.max, v);
  return b.int ? Math.round(v) : v;
}

// ---------------------------------------------------------------------------
// default values

function freshRoot(doc: DocumentData, loc: OwnerLoc): Record<string, unknown> | null {
  const rec = loc.table === 'scenes' ? doc.scene : (doc as unknown as Record<string, Record<string, Record<string, unknown>>>)[loc.table]?.[loc.id];
  if (!rec) return null;
  switch (loc.table) {
    case 'scenes':
      return emptyDocument().scene as unknown as Record<string, unknown>;
    case 'objects':
      return newObject('x', (rec as unknown as ObjectData).type, null) as unknown as Record<string, unknown>;
    case 'lights':
      return newLight((rec as { type?: 'POINT' }).type) as unknown as Record<string, unknown>;
    case 'cameras':
      return newCamera() as unknown as Record<string, unknown>;
    case 'materials':
      return newMaterial() as unknown as Record<string, unknown>;
    case 'worlds':
      return newWorld() as unknown as Record<string, unknown>;
    case 'curves':
      return newCurve() as unknown as Record<string, unknown>;
    case 'collections':
      return newCollection() as unknown as Record<string, unknown>;
    case 'armatures':
      return newArmature() as unknown as Record<string, unknown>;
    case 'lattices':
      return newLattice() as unknown as Record<string, unknown>;
  }
  return null;
}

/** Walk a data path in a freshly made data-block (no name lookups; modifiers etc. are handled by type). */
function walkFresh(root: unknown, path: string): unknown {
  let cur = root;
  for (const t of path ? tokenize(path.replace(/^node_tree\b/, 'tree')) : []) {
    if (!cur || typeof cur !== 'object') return undefined;
    if (t.kind === 'prop') cur = (cur as Record<string, unknown>)[t.name];
    else if (t.kind === 'index') cur = (cur as unknown[])[t.index];
    else cur = Array.isArray(cur) ? (cur as { name?: string }[]).find((x) => x?.name === t.key) : (cur as Record<string, unknown>)[t.key];
  }
  return cur;
}

const KEY_DEFAULTS: Record<string, unknown> = {
  scale: [1, 1, 1],
  delta_scale: [1, 1, 1],
  rotation_quaternion: [1, 0, 0, 0],
  rotation_axis_angle: [0, 0, 1, 0],
  influence: 1,
};

/** Defaults known by other modules (e.g. custom properties); the first non-undefined answer wins. */
export const buttonDefaultHooks: ((b: PropBinding) => unknown)[] = [];

/** Default value of a button's property; undefined when unknown. */
export function defaultValue(b: PropBinding): unknown {
  if (b.def !== undefined) return b.def;
  for (const f of buttonDefaultHooks) {
    const v = f(b);
    if (v !== undefined) return structuredClone(v);
  }
  const owner = b.owner as Record<string, unknown>;
  // modifiers and constraints know their type defaults
  if (typeof owner.type === 'string' && modifierTypes[owner.type as string] && 'show_viewport' in owner) {
    const d = newModifier(owner.type as string, 'x', []) as unknown as Record<string, unknown>;
    if (b.key in d) return structuredClone(d[b.key]);
  }
  if (typeof owner.type === 'string' && 'influence' in owner && 'mute' in owner && (constraintTypes[owner.type as string] || owner.type)) {
    const d = newConstraint(owner.type as string, 'x') as unknown as Record<string, unknown>;
    if (b.key in d) return structuredClone(d[b.key]);
  }
  const loc = ownerLoc(b);
  if (loc) {
    const root = freshRoot(app.doc, loc);
    const fo = root ? walkFresh(root, loc.path) : undefined;
    if (fo && typeof fo === 'object' && b.key in (fo as object)) return structuredClone((fo as Record<string, unknown>)[b.key]);
  }
  if (b.key in KEY_DEFAULTS) return structuredClone(KEY_DEFAULTS[b.key]);
  const cur = owner[b.key];
  if (typeof cur === 'boolean') return false;
  if (typeof cur === 'number') return clamp(b, 0);
  if (isArray(cur)) return Array.from(cur as number[]).map(() => 0);
  if (b.kind === 'enum' && b.items?.length) return b.items[0];
  return undefined;
}

// ---------------------------------------------------------------------------
// clipboard

let internalClip = '';

function formatValue(v: unknown): string {
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (isArray(v))
    return `[${Array.from(v as number[])
      .map((x) => String(Math.round(x * 1e6) / 1e6))
      .join(', ')}]`;
  return String(v ?? '');
}

function writeClipboard(text: string) {
  internalClip = text;
  try {
    void navigator.clipboard?.writeText(text).catch(() => {});
  } catch {
    // the internal clipboard still has it
  }
}

async function readClipboard(): Promise<string> {
  try {
    const t = await navigator.clipboard.readText();
    if (t) return t;
  } catch {
    // permission denied / unavailable: fall back to what we copied ourselves
  }
  return internalClip;
}

function parseArray(text: string): number[] | null {
  const t = text.trim();
  const hex = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(t);
  if (hex) {
    const n = parseInt(hex[1], 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => srgbToLinear(x / 255));
    return hex[2] ? [...rgb, parseInt(hex[2], 16) / 255] : rgb;
  }
  const m = /^[[(]?\s*(-?[\d.e+-]+(?:\s*,\s*-?[\d.e+-]+)+)\s*[\])]?$/i.exec(t);
  if (!m) return null;
  const out = m[1].split(',').map((x) => Number(x.trim()));
  return out.every((x) => Number.isFinite(x)) ? out : null;
}

export function copyButtonValue(b: PropBinding, whole: boolean) {
  const v = whole ? b.owner[b.key] : bindingValue(b);
  const text = b.kind === 'color' && !whole && isArray(v) ? formatValue(v) : formatValue(v);
  writeClipboard(text);
  app.report('INFO', `Copied: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
}

export function pasteButtonValue(b: PropBinding, text: string, whole: boolean): boolean {
  const cur = b.owner[b.key];
  let v: unknown;
  if (b.kind === 'bool') v = /^(true|1|yes|on)$/i.test(text.trim());
  else if (b.kind === 'enum') {
    const t = text.trim().replace(/^['"]|['"]$/g, '');
    if (b.items && !b.items.includes(t)) return false;
    v = t;
  } else if (b.kind === 'text') v = text;
  else if (isArray(cur) && (whole || b.index === undefined)) {
    const arr = parseArray(text);
    if (!arr) return false;
    v = arr;
    whole = true;
  } else {
    const arr = parseArray(text);
    if (arr) v = arr[b.index ?? 0] ?? arr[0];
    else {
      try {
        v = parseNumber(text, 'none');
      } catch {
        return false;
      }
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  write(b, v, whole);
  changed(b, 'Paste Value');
  return true;
}

// ---------------------------------------------------------------------------
// keyframes

function keyedCurves(b: PropBinding, all: boolean) {
  const a = animOf(b);
  if (!a) return null;
  const act = a.ob.animation_data?.action ? app.doc.actions[a.ob.animation_data.action] : undefined;
  const idx = all ? -1 : a.index;
  return { a, act, curves: act ? act.fcurves.filter((f) => f.data_path === a.path && (idx < 0 || f.array_index === idx)) : [] };
}

function insertKey(b: PropBinding, all: boolean) {
  const a = animOf(b);
  if (!a) {
    app.report('WARNING', `"${b.label}" cannot be animated`);
    return false;
  }
  // node inputs only store values once edited: store the default so it can be keyed
  if (b.owner[b.key] === undefined && b.def !== undefined) b.owner[b.key] = structuredClone(b.def);
  keyProperty(app.doc, a.ob, a.path, all ? -1 : a.index);
  return true;
}

function deleteKey(b: PropBinding, all: boolean) {
  const k = keyedCurves(b, all);
  if (!k?.act) return false;
  const frame = app.doc.scene.frame_current;
  let n = 0;
  for (const fc of k.curves) {
    const before = fc.keyframe_points.length;
    fc.keyframe_points = fc.keyframe_points.filter((p) => Math.abs(p.co[0] - frame) > 0.5);
    n += before - fc.keyframe_points.length;
  }
  k.act.fcurves = k.act.fcurves.filter((f) => f.keyframe_points.length || !k.curves.includes(f));
  return n > 0;
}

function clearKeys(b: PropBinding, all: boolean) {
  const k = keyedCurves(b, all);
  if (!k?.act || !k.curves.length) return false;
  k.act.fcurves = k.act.fcurves.filter((f) => !k.curves.includes(f));
  return true;
}

// ---------------------------------------------------------------------------
// copy to selected

/** Objects other than the owner's object that receive the value (selected, same kind of owner). */
function copyToSelected(b: PropBinding, all: boolean): number {
  const doc = app.doc;
  const loc = ownerLoc(b);
  if (!loc) return 0;
  const t = loc.table === 'objects' ? { ob: doc.objects[loc.id], path: relDataPath(loc, b.key) } : animTarget(doc, loc, b.key, app.activeObject);
  if (!t?.ob) return 0;
  const v = structuredClone(b.owner[b.key]);
  let n = 0;
  for (const ob of app.selectedObjects()) {
    if (ob.id === t.ob.id) continue;
    if (t.path.startsWith('data.') && ob.type !== t.ob.type) continue;
    const r = resolve(doc, ob, t.path);
    if (!r || !(r.key in r.owner) || r.owner === b.owner) continue;
    const cur = r.owner[r.key];
    if (typeof cur !== typeof v && !(isArray(cur) && isArray(v))) continue;
    if (isArray(cur) && isArray(v)) {
      const next = Array.from(cur as number[]);
      if (all || b.index === undefined) for (let i = 0; i < next.length && i < (v as number[]).length; i++) next[i] = (v as number[])[i];
      else next[b.index] = (v as number[])[b.index];
      r.owner[r.key] = next;
    } else r.owner[r.key] = structuredClone(v);
    n++;
  }
  return n;
}

buttonHooks.altEdit = (id: string) => {
  const b = getBinding(id);
  if (!b) return;
  const n = copyToSelected(b, false);
  if (n) {
    app.graph.invalidate?.();
    app.pushUndo('Copy to Selected');
    app.changed('doc');
  }
};

// ---------------------------------------------------------------------------
// eyedroppers

/** The area under a screen point (areas set themselves as hovered when the pointer enters). */
export function areaEditorAt(x: number, y: number): { type?: string; editor?: { pick?: (x: number, y: number, r?: number) => { id: string } | null; el?: HTMLElement } } | null {
  const a = app.hoverArea;
  if (!a || !a.el.contains(document.elementFromPoint(x, y))) return null;
  return a as never;
}

function pickObjectAt(e: PointerEvent): string | null {
  const t = e.target as HTMLElement;
  const row = t.closest?.('.ol-row');
  if (row) {
    const name = row.querySelector('.ol-name')?.textContent;
    const ob = Object.values(app.doc.objects).find((o) => o.name === name);
    return ob?.id ?? null;
  }
  const area = areaEditorAt(e.clientX, e.clientY);
  const ed = area?.editor;
  if (ed?.pick && ed.el) {
    const r = ed.el.getBoundingClientRect();
    return ed.pick(e.clientX - r.left, e.clientY - r.top, 6)?.id ?? null;
  }
  return null;
}

export function startEyedropper(label: string, status: string, onPick: (e: PointerEvent) => boolean) {
  document.body.classList.add('eyedropper-active');
  const end = () => document.body.classList.remove('eyedropper-active');
  app.startModal({
    label,
    cursor: 'crosshair',
    header: () => status,
    status: () => [
      ['LMB', 'Sample'],
      ['RMB / Esc', 'Cancel'],
    ],
    onPointerDown: (e) => {
      if (e.button !== 0) {
        end();
        return 'CANCELLED';
      }
      const ok = onPick(e);
      end();
      if (!ok) app.report('WARNING', 'Nothing to sample there');
      return ok ? 'FINISHED' : 'CANCELLED';
    },
    onKey: (e) => {
      if (e.type === 'keydown' && e.key === 'Escape') {
        end();
        return 'CANCELLED';
      }
      return true;
    },
    cancel: end,
  });
}

function colorEyedropper(b: PropBinding) {
  const apply = (rgb: number[]) => {
    const cur = b.owner[b.key] as number[];
    const next = [...rgb.slice(0, 3), ...(cur.length > 3 ? [cur[3]] : [])];
    b.owner[b.key] = next.slice(0, cur.length);
    b.onChange?.();
  };
  const ED = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (ED) {
    new ED()
      .open()
      .then((r) => {
        const n = parseInt(r.sRGBHex.slice(1), 16);
        apply([(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => srgbToLinear(x / 255)));
        app.pushUndo('Eyedropper');
        app.changed('doc');
      })
      .catch(() => {});
    return;
  }
  startEyedropper('Eyedropper', 'Eyedropper: click a color swatch to sample its color, Esc to cancel', (e) => {
    const src = bindingAt(e.target as Element);
    if (src?.kind === 'color' && src !== b) {
      apply(src.owner[src.key] as number[]);
      return true;
    }
    return false;
  });
}

function idEyedropper(b: PropBinding) {
  startEyedropper('Eyedropper', 'Eyedropper: click an object in the 3D viewport or Outliner, Esc to cancel', (e) => {
    const id = pickObjectAt(e);
    if (!id) return false;
    if (b.items && !b.items.includes(id)) {
      app.report('WARNING', 'That object cannot be used here');
      return false;
    }
    b.owner[b.key] = id;
    b.onChange?.();
    return true;
  });
}

function depthEyedropper(b: PropBinding) {
  startEyedropper('Eyedropper Depth', 'Depth Eyedropper: click a surface in the 3D viewport, Esc to cancel', (e) => {
    const area = areaEditorAt(e.clientX, e.clientY);
    const v = area?.editor as unknown as { el: HTMLElement } | undefined;
    if (area?.type !== 'VIEW_3D' || !v) return false;
    const r = v.el.getBoundingClientRect();
    // lazy import keeps the 3D view out of this module's load order
    const hit = surfaceHitFn?.(v, e.clientX - r.left, e.clientY - r.top);
    if (!hit) return false;
    // distance along the camera's view axis from the camera that owns these settings
    const loc = ownerLoc(b);
    const cam = loc && loc.table === 'cameras' ? Object.values(app.doc.objects).find((o) => o.data === loc.id) : app.doc.scene.camera ? app.doc.objects[app.doc.scene.camera] : undefined;
    const ev = cam ? app.graph.get(cam.id) : undefined;
    let d: number;
    if (ev) {
      const p = new Vector3().setFromMatrixPosition(ev.world);
      const dir = new Vector3(0, 0, -1).transformDirection(ev.world);
      d = Math.max(0, hit.clone().sub(p).dot(dir));
    } else d = hit.length();
    b.owner[b.key] = clamp(b, d);
    b.onChange?.();
    return true;
  });
}

let surfaceHitFn: ((v: unknown, x: number, y: number) => Vector3 | null) | null = null;
void import('../ops/view3d').then((m) => (surfaceHitFn = m.surfaceHit as never)).catch(() => {});

const isDepth = (b: PropBinding) => b.kind === 'number' && /(^|_)(distance|depth)$/.test(b.key) && /focus|dof|depth|distance/.test(b.key);

// ---------------------------------------------------------------------------
// operators

const poll = () => !!targetButton();
const pollAnim = () => {
  const b = targetButton();
  return !!b && !!animOf(b);
};

registerOperators([
  {
    idname: 'ui.copy_data_path_button',
    label: 'Copy Data Path',
    description: 'Copy the data path of the property under the mouse to the clipboard',
    props: [{ id: 'full_path', label: 'Full Path', type: 'bool', default: false }],
    poll: () => {
      const b = targetButton();
      return !!b && !!ownerLoc(b);
    },
    exec: (_c, p) => {
      const b = targetButton()!;
      const loc = ownerLoc(b)!;
      const text = p.full_path ? fullDataPath(loc, b.key, b.index) : relDataPath(loc, b.key);
      writeClipboard(text);
      app.report('INFO', `Copied: ${text}`);
    },
    undo: false,
  },
  {
    idname: 'ui.reset_default_button',
    label: 'Reset to Default Value',
    description: 'Reset the property under the mouse to its default value',
    // acts on the button under the pointer, so it can't be re-run from the redo panel
    redo: false,
    props: [{ id: 'all', label: 'All', type: 'bool', default: true }],
    poll,
    exec: (_c, p) => {
      const b = targetButton()!;
      const d = defaultValue(b);
      if (d === undefined) {
        app.report('WARNING', `No default value known for "${b.label}"`);
        return 'CANCELLED';
      }
      write(b, d, !!p.all || b.index === undefined);
      b.onChange?.();
      app.graph.invalidate?.();
    },
  },
  {
    idname: 'ui.copy_to_selected_button',
    label: 'Copy to Selected',
    description: 'Copy the property value to the same property of the other selected objects',
    // acts on the button under the pointer, so it can't be re-run from the redo panel
    redo: false,
    props: [{ id: 'all', label: 'All', type: 'bool', default: true }],
    poll: () => {
      const b = targetButton();
      return !!b && app.selectedObjects().length > 1;
    },
    exec: (_c, p) => {
      const n = copyToSelected(targetButton()!, !!p.all);
      if (!n) {
        app.report('WARNING', 'No other selected item has this property');
        return 'CANCELLED';
      }
      app.graph.invalidate?.();
    },
  },
  {
    idname: 'anim.keyframe_insert_button',
    label: 'Insert Keyframe (Buttons)',
    description: 'Insert a keyframe for the property under the mouse',
    // acts on the button under the pointer, so it can't be re-run from the redo panel
    redo: false,
    props: [{ id: 'all', label: 'All', type: 'bool', default: true }],
    poll,
    exec: (_c, p) => (insertKey(targetButton()!, !!p.all) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'anim.keyframe_delete_button',
    label: 'Delete Keyframe (Buttons)',
    description: 'Delete the keyframe of the property under the mouse on the current frame',
    // acts on the button under the pointer, so it can't be re-run from the redo panel
    redo: false,
    props: [{ id: 'all', label: 'All', type: 'bool', default: true }],
    poll: pollAnim,
    exec: (_c, p) => {
      if (deleteKey(targetButton()!, !!p.all)) return 'FINISHED';
      app.report('WARNING', 'No keyframe on the current frame');
      return 'CANCELLED';
    },
  },
  {
    idname: 'anim.keyframe_clear_button',
    label: 'Clear Keyframe (Buttons)',
    description: 'Remove all keyframes (the animation curves) of the property under the mouse',
    // acts on the button under the pointer, so it can't be re-run from the redo panel
    redo: false,
    props: [{ id: 'all', label: 'All', type: 'bool', default: true }],
    poll: pollAnim,
    exec: (_c, p) => {
      if (clearKeys(targetButton()!, !!p.all)) return 'FINISHED';
      app.report('WARNING', 'The property has no keyframes');
      return 'CANCELLED';
    },
  },
  {
    idname: 'ui.eyedropper_color',
    label: 'Eyedropper',
    description: 'Sample a color for the color property under the mouse',
    poll: () => targetButton()?.kind === 'color',
    invoke: () => {
      colorEyedropper(targetButton()!);
      return 'CANCELLED';
    },
    exec: () => 'CANCELLED',
    undo: false,
  },
  {
    idname: 'ui.eyedropper_id',
    label: 'Eyedropper Data-Block',
    description: 'Pick an object for the object property under the mouse',
    poll: () => targetButton()?.kind === 'object',
    invoke: () => {
      idEyedropper(targetButton()!);
      return 'RUNNING_MODAL';
    },
    exec: () => 'CANCELLED',
  },
  {
    idname: 'ui.eyedropper_depth',
    label: 'Eyedropper Depth',
    description: 'Sample a distance from the 3D view for the depth property under the mouse',
    poll: () => {
      const b = targetButton();
      return !!b && isDepth(b);
    },
    invoke: () => {
      depthEyedropper(targetButton()!);
      return 'RUNNING_MODAL';
    },
    exec: () => 'CANCELLED',
  },
]);

function driverProps(b: PropBinding, all: boolean) {
  const a = animOf(b);
  if (!a) return null;
  return { object: a.ob.id, data_path: a.path, index: all ? -1 : a.index };
}

function addDriver(b: PropBinding, all: boolean) {
  const p = driverProps(b, all);
  if (!p) return void app.report('WARNING', `"${b.label}" cannot be driven`);
  app.run('anim.driver_button_add', p, { invoke: false });
  // then edit the new driver in a popover
  if (app.poll('anim.driver_button_edit')) app.run('anim.driver_button_edit', { ...p, index: b.index ?? p.index }, { invoke: true });
}

/** Extra driver entries of the button context menu (Copy/Paste/Edit Driver, …), added by the animation module. */
export const buttonDriverItems: ((ob: ObjectData, path: string, index: number, driven: boolean) => MenuItem[])[] = [];

function removeDriver(b: PropBinding, all: boolean) {
  const p = driverProps(b, all);
  if (p) app.run('anim.driver_button_remove', p, { invoke: false });
}

/** Enter over a button: start typing in a number field, toggle a checkbox, open a menu. */
export function activateHovered() {
  const el = document.elementFromPoint(app.pointer.x, app.pointer.y)?.closest('[data-id]') as HTMLElement | null;
  if (!el || !targetButton()) return;
  const r = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  if (el.classList.contains('num-field')) dispatchEvent(new PointerEvent('pointerup', init));
}

/** K / Alt K over an animatable button: add it to (or remove it from) the active keying set. */
function keyingSetButton(add: boolean) {
  const b = targetButton();
  const a = b ? animOf(b) : null;
  const op = add ? 'anim.keyingset_button_add' : 'anim.keyingset_button_remove';
  if (!b || !a || !operators.has(op)) return;
  app.run(op, { object: a.ob.id, data_path: a.path, index: b.index ?? -1, all: true });
}

/** Minus over a number button flips its sign. */
function negateHovered() {
  const b = targetButton();
  const v = b ? bindingValue(b) : undefined;
  if (!b || typeof v !== 'number' || (b.kind !== 'number' && b.kind !== 'vector')) return;
  write(b, -v, false);
  changed(b, 'Negate Value');
}

function copyValue(whole: boolean) {
  const b = targetButton();
  if (b) copyButtonValue(b, whole);
}

function pasteValue(whole: boolean) {
  const b = targetButton();
  if (!b) return;
  void readClipboard().then((t) => {
    if (!t || !pasteButtonValue(b, t, whole)) app.report('WARNING', 'Clipboard does not contain a value for this property');
  });
}

addKeys('User Interface', [
  { key: 'E', op: 'ui.eyedropper_color' },
  { key: 'E', op: 'ui.eyedropper_id' },
  { key: 'E', op: 'ui.eyedropper_depth' },
  { key: 'C', ctrl: true, shift: true, op: 'ui.copy_data_path_button' },
  { key: 'C', ctrl: true, shift: true, alt: true, op: 'ui.copy_data_path_button', props: { full_path: true } },
  { key: 'I', op: 'anim.keyframe_insert_button', props: { all: true } },
  { key: 'I', alt: true, op: 'anim.keyframe_delete_button', props: { all: true } },
  { key: 'I', shift: true, alt: true, op: 'anim.keyframe_clear_button', props: { all: true } },
  { key: 'D', ctrl: true, action: () => targetButton() && addDriver(targetButton()!, false) },
  { key: 'D', ctrl: true, alt: true, action: () => targetButton() && removeDriver(targetButton()!, true) },
  { key: 'BACK_SPACE', op: 'ui.reset_default_button', props: { all: true } },
  { key: 'C', ctrl: true, action: () => copyValue(false) },
  { key: 'V', ctrl: true, action: () => pasteValue(false) },
  { key: 'C', ctrl: true, alt: true, action: () => copyValue(true) },
  { key: 'V', ctrl: true, alt: true, action: () => pasteValue(true) },
  { key: 'RET', alt: true, op: 'ui.copy_to_selected_button', props: { all: true } },
  { key: 'RET', action: () => activateHovered() },
  { key: 'NUMPAD_ENTER', action: () => activateHovered() },
  { key: 'K', action: () => keyingSetButton(true) },
  { key: 'K', alt: true, action: () => keyingSetButton(false) },
  { key: 'MINUS', action: () => negateHovered() },
  { key: 'NUMPAD_MINUS', action: () => negateHovered() },
]);

function matches(k: KeyItem, name: string, e: KeyboardEvent) {
  if (k.key !== name || k.inactive || (k.value ?? 'PRESS') !== 'PRESS') return false;
  if (k.any) return true;
  const ctrl = e.ctrlKey || e.metaKey;
  return !!k.shift === e.shiftKey && !!k.ctrl === ctrl && !!k.alt === e.altKey;
}

// Button shortcuts win over editor keymaps while a property button is under the pointer.
keyInputHooks.push((e) => {
  if (e.type !== 'keydown' || e.repeat) return false;
  // property buttons, and operator buttons (Copy Python Command)
  const b = targetButton() ?? (document.elementFromPoint(app.pointer.x, app.pointer.y)?.closest('[data-op]:not(.popup-layer *)') ? true : null);
  if (!b) return false;
  const name = keyName(e);
  for (const k of keymaps['User Interface'] ?? []) {
    if (!matches(k, name, e)) continue;
    if (k.when && !k.when()) continue;
    if (k.action) {
      // value actions need a property button
      if (b === true) continue;
      k.action();
      return true;
    }
    if (k.op && app.poll(k.op)) {
      app.run(k.op, k.props ?? {});
      return true;
    }
  }
  return false;
});

// ---------------------------------------------------------------------------
// button context menu

const sc = (op: string, props?: Record<string, unknown>) => {
  for (const k of keymaps['User Interface'] ?? []) if (!k.inactive && k.op === op && (!props || Object.entries(props).every(([a, v]) => (k.props?.[a] ?? false) === v))) return keyLabel(k);
  return '';
};

/** Sections of the button context menu, in order; other modules add entries to a section. */
export type ButtonMenuSlot = 'keyframes' | 'drivers' | 'keyingsets' | 'reset' | 'datapath' | 'selected' | 'target' | 'values' | 'help';
export const buttonMenuHooks: { slot: ButtonMenuSlot; items: (b: PropBinding) => MenuItem[] }[] = [];

/** Whether the property is one of a data-block's custom properties. */
export function isCustomProp(b: PropBinding): boolean {
  const loc = ownerLoc(b);
  return !!loc && /(^|\.)custom$/.test(loc.path);
}

export { ownerLoc as buttonOwnerLoc, withButton, defaultValue as buttonDefault, readClipboard, writeClipboard };

export function buttonMenu(b: PropBinding): MenuItem[] {
  const a = animOf(b);
  const cur = b.owner[b.key];
  const arr = isArray(cur) && (cur as number[]).length > 1;
  const single = arr && b.index !== undefined;
  const run =
    (op: string, props: Record<string, unknown> = {}) =>
    () =>
      withButton(b, () => app.run(op, props));
  const sections: Record<ButtonMenuSlot, MenuItem[]> = { keyframes: [], drivers: [], keyingsets: [], reset: [], datapath: [], selected: [], target: [], values: [], help: [] };
  const loc = ownerLoc(b);
  if (a) {
    const st = keyState(app.doc, a.ob, a.path, -1);
    const k = keyedCurves(b, true);
    const animated = st !== 'none' && st !== 'driven' && !!k?.curves.length;
    const keyed = animated && keyState(app.doc, a.ob, a.path, single ? (b.index ?? -1) : -1) === 'keyed';
    const t = { object: a.ob.id, data_path: a.path, index: b.index ?? -1 };
    // keyframes
    if (keyed)
      sections.keyframes.push(
        { label: arr ? 'Replace Keyframes' : 'Replace Keyframe', shortcut: sc('anim.keyframe_insert_button'), action: run('anim.keyframe_insert_button', { all: true }) },
        ...(single ? [{ label: 'Replace Single Keyframe', action: run('anim.keyframe_insert_button', { all: false }) }] : []),
        { label: arr ? 'Delete Keyframes' : 'Delete Keyframe', shortcut: sc('anim.keyframe_delete_button'), action: run('anim.keyframe_delete_button', { all: true }) },
        ...(single ? [{ label: 'Delete Single Keyframe', action: run('anim.keyframe_delete_button', { all: false }) }] : []),
      );
    else if (st !== 'driven')
      sections.keyframes.push(
        { label: arr ? 'Insert Keyframes' : 'Insert Keyframe', shortcut: sc('anim.keyframe_insert_button'), action: run('anim.keyframe_insert_button', { all: true }) },
        ...(single ? [{ label: 'Insert Single Keyframe', action: run('anim.keyframe_insert_button', { all: false }) }] : []),
      );
    if (animated) {
      sections.keyframes.push(
        { label: arr ? 'Clear Keyframes' : 'Clear Keyframe', shortcut: sc('anim.keyframe_clear_button'), action: run('anim.keyframe_clear_button', { all: true }) },
        ...(single ? [{ label: 'Clear Single Keyframes', action: run('anim.keyframe_clear_button', { all: false }) }] : []),
      );
      if (operators.has('anim.view_curve_in_graph_editor')) sections.keyframes.push({ label: 'View in Graph Editor', op: 'anim.view_curve_in_graph_editor', props: { ...t, index: single ? t.index : -1, isolate: false } });
    }
    // drivers (the animation module adds Copy / Paste / Edit Driver and the Drivers editor)
    const driverExtras = buttonDriverItems.flatMap((f) => f(a.ob, a.path, b.index ?? -1, st === 'driven')).filter((it) => it.op !== 'ui.copy_as_driver_button');
    if (st === 'driven')
      sections.drivers.push(
        { label: arr ? 'Delete Drivers' : 'Delete Driver', shortcut: 'Ctrl Alt D', action: () => removeDriver(b, true) },
        ...(single ? [{ label: 'Delete Single Driver', action: () => removeDriver(b, false) }] : []),
        ...driverExtras,
      );
    else if (!animated)
      sections.drivers.push(
        { label: arr ? 'Add Drivers' : 'Add Driver', shortcut: arr ? '' : 'Ctrl D', action: () => addDriver(b, true) },
        ...(single ? [{ label: 'Add Single Driver', shortcut: 'Ctrl D', action: () => addDriver(b, false) }] : []),
        ...driverExtras,
      );
    // keying sets
    if (operators.has('anim.keyingset_button_add'))
      sections.keyingsets.push(
        { label: arr ? 'Add All to Keying Set' : 'Add to Keying Set', op: 'anim.keyingset_button_add', props: { ...t, all: true } },
        ...(single ? [{ label: 'Add Single to Keying Set', op: 'anim.keyingset_button_add', props: { ...t, all: false } }] : []),
        ...(inKeyingSet(a.ob.id, a.path) ? [{ label: 'Remove from Keying Set', op: 'anim.keyingset_button_remove', props: { ...t, all: true } }] : []),
      );
    if (st !== 'driven' && operators.has('ui.copy_as_driver_button') && loc) sections.datapath.push({ label: 'Copy as New Driver', op: 'ui.copy_as_driver_button', props: t });
  }
  // reset
  const hasDefault = defaultValue(b) !== undefined;
  sections.reset.push(
    { label: arr ? 'Reset All to Default Values' : 'Reset to Default Value', shortcut: sc('ui.reset_default_button'), disabled: !hasDefault, action: run('ui.reset_default_button', { all: true }) },
    ...(single ? [{ label: 'Reset Single to Default Value', disabled: !hasDefault, action: run('ui.reset_default_button', { all: false }) }] : []),
  );
  // data paths (before Copy as New Driver)
  if (loc)
    sections.datapath.unshift(
      { label: 'Copy Data Path', shortcut: sc('ui.copy_data_path_button'), action: run('ui.copy_data_path_button', { full_path: false }) },
      { label: 'Copy Full Data Path', shortcut: sc('ui.copy_data_path_button', { full_path: true }), action: run('ui.copy_data_path_button', { full_path: true }) },
    );
  // copy to selected
  if (loc && (loc.table === 'objects' || animTarget(app.doc, loc, b.key, app.activeObject))) {
    const many = app.selectedObjects().length > 1;
    sections.selected.push(
      { label: arr ? 'Copy All to Selected' : 'Copy to Selected', disabled: !many, action: run('ui.copy_to_selected_button', { all: true }) },
      ...(single ? [{ label: 'Copy Single to Selected', disabled: !many, action: run('ui.copy_to_selected_button', { all: false }) }] : []),
    );
  }
  // values
  sections.values.push(
    { label: 'Copy Value', shortcut: 'Ctrl C', action: () => copyButtonValue(b, false) },
    { label: 'Paste Value', shortcut: 'Ctrl V', action: () => void readClipboard().then((t) => t && pasteButtonValue(b, t, false)) },
    ...(arr
      ? [
          { label: 'Copy Entire Array', shortcut: 'Ctrl Alt C', action: () => copyButtonValue(b, true) },
          { label: 'Paste Entire Array', shortcut: 'Ctrl Alt V', action: () => void readClipboard().then((t) => t && pasteButtonValue(b, t, true)) },
        ]
      : []),
  );
  if (b.kind === 'color') sections.values.push({ label: 'Eyedropper', shortcut: 'E', action: () => colorEyedropper(b) });
  if (b.kind === 'object') sections.values.push({ label: 'Eyedropper', shortcut: 'E', action: () => idEyedropper(b) });
  if (isDepth(b)) sections.values.push({ label: 'Depth Eyedropper', shortcut: 'E', action: () => depthEyedropper(b) });
  for (const hk of buttonMenuHooks) {
    try {
      sections[hk.slot].push(...withButton(b, () => hk.items(b)));
    } catch {
      // a broken hook never hides the rest of the menu
    }
  }
  const items: MenuItem[] = [];
  for (const k of Object.keys(sections) as ButtonMenuSlot[]) {
    const list = sections[k];
    if (!list.length) continue;
    if (items.length) items.push({ separator: true });
    // entries run (and poll) with this button as the target, wherever the pointer is by then
    items.push(
      ...list.map((it): MenuItem => {
        if (it.action) return { ...it, action: () => withButton(b, it.action!) };
        if (!it.op) return it;
        const { op, props = {} } = it;
        return { ...it, op: undefined, disabled: it.disabled || !withButton(b, () => app.poll(op)), action: () => withButton(b, () => app.run(op, props)) };
      }),
    );
  }
  return items;
}

function inKeyingSet(obId: string, path: string): boolean {
  const name = app.doc.scene.keying_set;
  const set = name?.startsWith('KS:') ? app.doc.scene.keying_sets?.find((k) => `KS:${k.name}` === name) : undefined;
  return !!set?.paths.some((p) => p.id === obId && p.data_path === path);
}

addEventListener(
  'contextmenu',
  (e) => {
    if (app?.modal) return;
    const t = e.target as HTMLElement;
    if (t.closest?.('.popup-layer, input, textarea')) return;
    const b = bindingAt(t);
    if (!b || b.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    openMenu(buttonMenu(b), { x: e.clientX, y: e.clientY }, { title: b.label });
  },
  true,
);

/** Value as text in sRGB for color tooltips / tests. */
export function colorToHex(rgb: number[]) {
  return rgb
    .slice(0, 3)
    .map((x) =>
      Math.round(Math.max(0, Math.min(1, linearToSrgb(x))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
}

export type { OpContext };

// Property tooltips end with the scripting data path of the value.
tooltipHooks.push((el) => {
  const b = getBinding(el.dataset.id);
  if (!b) return null;
  const loc = ownerLoc(b);
  return { title: b.label, lines: loc && menuSettings.pythonTips ? [`Python: ${fullDataPath(loc, b.key, b.index)}`] : [] };
});
