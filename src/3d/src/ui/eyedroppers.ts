// More eyedroppers and drops onto property buttons: pick a bone in the viewport for a bone field
// (E), pick a property to drive the one under the mouse, drag a colour swatch onto another colour
// button, drop an Outliner item on an object field or a material on a material slot.
import { Vector3, Matrix4 } from 'three';
import { app, registerOperators } from '../app/app';
import { addKeys } from '../app/keymap';
import { bindingAt, buttonHooks, type PropBinding } from './binding';
import { animOf, areaEditorAt, buttonMenuHooks, startEyedropper, targetButton } from './buttons';
import { addDriver } from '../animation/driverseditor';
import { defaultDriverCurve } from '../animation/drivercurves';
import type { ObjectData } from '../data/types';
import { keyState } from '../anim/keyframes';

// ---------------------------------------------------------------------------
// bone eyedropper

/** The armature a bone field picks from (the object in the field next to it). */
function boneFieldArmature(b: PropBinding): ObjectData | null {
  if (!/subtarget$/.test(b.key)) return null;
  const id = b.owner[b.key.replace(/subtarget$/, 'target')];
  const ob = typeof id === 'string' ? app.doc.objects[id] : undefined;
  return ob?.type === 'ARMATURE' && ob.data ? ob : null;
}

type ViewLike = { el: HTMLElement; project(p: Vector3): { x: number; y: number } };

/** The bone of `ob` drawn nearest to a point of the 3D view (posed when the armature has a pose). */
export function boneNear(v: ViewLike, ob: ObjectData, x: number, y: number, radius = 12): string | null {
  const arm = ob.data ? app.doc.armatures[ob.data] : undefined;
  const ev = app.graph.get(ob.id);
  if (!arm || !ev) return null;
  const w = ev.world ?? new Matrix4();
  let best: string | null = null;
  let bd = radius;
  for (const b of arm.bones) {
    const pb = ev.pose?.bones.get(b.name) as { pose: Matrix4; length: number } | undefined;
    const head = pb ? new Vector3().setFromMatrixPosition(pb.pose).applyMatrix4(w) : new Vector3(...b.head).applyMatrix4(w);
    const tail = pb ? new Vector3(0, pb.length, 0).applyMatrix4(pb.pose).applyMatrix4(w) : new Vector3(...b.tail).applyMatrix4(w);
    const hs = v.project(head),
      ts = v.project(tail);
    const dx = ts.x - hs.x,
      dy = ts.y - hs.y,
      l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - hs.x) * dx + (y - hs.y) * dy) / l2));
    const d = Math.hypot(hs.x + dx * t - x, hs.y + dy * t - y);
    if (d < bd) {
      bd = d;
      best = b.name;
    }
  }
  return best;
}

function boneEyedropper(b: PropBinding) {
  const ob = boneFieldArmature(b);
  if (!ob) return;
  startEyedropper('Eyedropper Bone', `Bone Eyedropper: click a bone of ${ob.name} in the 3D viewport, Esc to cancel`, (e) => {
    const area = areaEditorAt(e.clientX, e.clientY);
    if (area?.type !== 'VIEW_3D' || !area.editor?.el) return false;
    const v = area.editor as unknown as ViewLike;
    const r = v.el.getBoundingClientRect();
    const name = boneNear(v, ob, e.clientX - r.left, e.clientY - r.top);
    if (!name) return false;
    b.owner[b.key] = name;
    b.onChange?.();
    app.graph.invalidate?.();
    return true;
  });
}

// ---------------------------------------------------------------------------
// driver eyedropper: the clicked property drives the one the eyedropper started on

function driverEyedropper(b: PropBinding) {
  const a = animOf(b);
  if (!a) return;
  startEyedropper('Eyedropper Driver', `Driver Eyedropper: click the property that drives "${b.label}", Esc to cancel`, (e) => {
    const src = bindingAt(e.target as Element);
    const s = src ? animOf(src) : null;
    if (!src || !s || src === b) {
      app.report('WARNING', 'Click a property that can be animated');
      return false;
    }
    const arr = Array.isArray(src.owner[src.key]) || ArrayBuffer.isView(src.owner[src.key]);
    const srcPath = arr ? `${s.path}[${Math.max(0, src.index ?? 0)}]` : s.path;
    const name = (s.path.split('.').pop() ?? 'var').replace(/\[.*$/, '').replace(/[^A-Za-z0-9_]/g, '_') || 'var';
    const made = addDriver(app.doc, a.ob, a.path, b.index ?? -1, { type: 'AVERAGE', expression: name });
    for (const d of made) {
      d.type = 'AVERAGE';
      d.variables = [{ name, type: 'SINGLE_PROP', targets: [{ id: s.ob.id, id_type: 'OBJECT', data_path: srcPath }] }];
      d.fcurve ??= defaultDriverCurve(d);
    }
    app.graph.invalidate?.();
    app.report('INFO', `${b.label} is driven by ${s.ob.name} ▸ ${srcPath}`);
    return made.length > 0;
  });
}

// ---------------------------------------------------------------------------
// colour drag and drop

/** Set a colour button from another colour (keeping its own alpha when the source has none). */
export function dropColor(b: PropBinding, rgba: number[]): boolean {
  // node inputs only store a value once edited: start from the default
  const cur = b.owner[b.key] ?? b.def;
  if (b.kind !== 'color' || !(Array.isArray(cur) || ArrayBuffer.isView(cur))) return false;
  const n = (cur as ArrayLike<number>).length;
  const next = Array.from({ length: n }, (_, i) => (i < 3 ? (rgba[i] ?? 0) : i === 3 ? (rgba[3] ?? (cur as ArrayLike<number>)[3] ?? 1) : (cur as ArrayLike<number>)[i]));
  b.owner[b.key] = ArrayBuffer.isView(cur) ? new (cur.constructor as Float32ArrayConstructor)(next) : next;
  b.onChange?.();
  app.graph.invalidate?.();
  return true;
}

const css = (c: number[]) => `rgb(${c.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055)) * 255)).join(',')})`;

buttonHooks.colorDrag = (rgba, e0) => {
  const ghost = document.createElement('div');
  ghost.className = 'color-drag';
  ghost.style.background = css(rgba);
  document.body.append(ghost);
  document.body.classList.add('color-dragging');
  let over: Element | null = null;
  const place = (e: PointerEvent) => {
    ghost.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-id]') ?? null;
    if (el !== over) {
      over?.classList.remove('drop-target');
      over = bindingAt(el)?.kind === 'color' ? el : null;
      over?.classList.add('drop-target');
    }
  };
  const end = () => {
    removeEventListener('pointermove', place, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('keydown', key, true);
    over?.classList.remove('drop-target');
    ghost.remove();
    document.body.classList.remove('color-dragging');
  };
  const up = (e: PointerEvent) => {
    end();
    const b = bindingAt(document.elementFromPoint(e.clientX, e.clientY));
    if (b && !b.disabled && b.kind === 'color') {
      app.run('ui.drop_color', { color: rgba.slice(0, 3), alpha: rgba[3] ?? -1, target: b.id }, { invoke: false });
    }
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      end();
    }
  };
  addEventListener('pointermove', place, true);
  addEventListener('pointerup', up, true);
  addEventListener('keydown', key, true);
  place(e0);
};

// ---------------------------------------------------------------------------
// drops from the Outliner: names onto object fields, materials onto material slots

/** The data-block an Outliner row's dragged label names (objects first, then materials). */
function namedBlock(name: string): { table: 'objects' | 'materials'; id: string } | null {
  const ob = Object.values(app.doc.objects).find((o) => o.name === name);
  if (ob) return { table: 'objects', id: ob.id };
  const ma = Object.values(app.doc.materials).find((m) => m.name === name);
  return ma ? { table: 'materials', id: ma.id } : null;
}

/** Index of the material slot row an element is in, or -1. */
function slotRow(el: Element | null): number {
  const row = el?.closest?.('.uilist[data-list="mat-slots"] .ul-row') as HTMLElement | null;
  return row ? Number(row.dataset.index) : -1;
}

function dropTarget(e: DragEvent): { kind: 'object'; b: PropBinding } | { kind: 'slot'; index: number } | null {
  const el = e.target as Element | null;
  const b = bindingAt(el);
  if (b && !b.disabled && b.kind === 'object') return { kind: 'object', b };
  const i = slotRow(el);
  return i >= 0 ? { kind: 'slot', index: i } : null;
}

addEventListener(
  'dragover',
  (e) => {
    const t = dropTarget(e);
    if (!t || !e.dataTransfer?.types.includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  },
  true,
);

addEventListener(
  'drop',
  (e) => {
    const t = dropTarget(e);
    const name = e.dataTransfer?.getData('text/plain') ?? '';
    if (!t || !name) return;
    const blk = namedBlock(name);
    if (t.kind === 'object') {
      if (blk?.table !== 'objects') return;
      e.preventDefault();
      e.stopPropagation();
      app.run('ui.drop_name', { string: name, target: t.b.id }, { invoke: false });
    } else {
      const ma = Object.values(app.doc.materials).find((m) => m.name === name);
      if (!ma) return;
      e.preventDefault();
      e.stopPropagation();
      app.run('ui.drop_material', { material: ma.id, slot: t.index }, { invoke: false });
    }
  },
  true,
);

// ---------------------------------------------------------------------------
// operators

const bindingById = (id: unknown) => {
  const el = id ? document.querySelector(`[data-id="${CSS.escape(String(id))}"]`) : null;
  return el ? bindingAt(el) : targetButton();
};

registerOperators([
  {
    idname: 'ui.eyedropper_bone',
    label: 'Eyedropper Bone',
    description: 'Pick a bone in the 3D viewport for the bone field under the mouse',
    poll: () => {
      const b = targetButton();
      return !!b && !!boneFieldArmature(b);
    },
    invoke: () => {
      boneEyedropper(targetButton()!);
      return 'RUNNING_MODAL';
    },
    exec: () => 'CANCELLED',
  },
  {
    idname: 'ui.eyedropper_driver',
    label: 'Eyedropper Driver',
    description: 'Click another property: it drives the property under the mouse',
    poll: () => {
      const b = targetButton();
      return !!b && !!animOf(b);
    },
    invoke: () => {
      driverEyedropper(targetButton()!);
      return 'RUNNING_MODAL';
    },
    exec: () => 'CANCELLED',
  },
  {
    idname: 'ui.drop_color',
    label: 'Drop Color',
    description: 'Set the colour button under the mouse to a dropped colour',
    redo: false,
    props: [
      { id: 'color', label: 'Color', type: 'color', default: [0, 0, 0] },
      { id: 'alpha', label: 'Alpha', type: 'float', default: -1, hidden: true },
      { id: 'target', label: 'Target', type: 'string', default: '', hidden: true },
    ],
    exec: (_c, p) => {
      const b = bindingById(p.target);
      const c = p.color as number[];
      return b && dropColor(b, Number(p.alpha) >= 0 ? [...c.slice(0, 3), Number(p.alpha)] : c.slice(0, 3)) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'ui.drop_name',
    label: 'Drop Name',
    description: 'Set the object field under the mouse to the dropped object',
    redo: false,
    props: [
      { id: 'string', label: 'String', type: 'string', default: '' },
      { id: 'target', label: 'Target', type: 'string', default: '', hidden: true },
    ],
    exec: (_c, p) => {
      const b = bindingById(p.target);
      const ob = Object.values(app.doc.objects).find((o) => o.name === p.string);
      if (!b || b.kind !== 'object' || !ob || (b.items && !b.items.includes(ob.id))) {
        app.report('WARNING', 'That object cannot be used here');
        return 'CANCELLED';
      }
      b.owner[b.key] = ob.id;
      b.onChange?.();
      app.graph.invalidate?.();
    },
  },
  {
    idname: 'ui.drop_material',
    label: 'Drop Material in Material Slot',
    description: 'Put the dropped material into a material slot of the active object',
    props: [
      { id: 'material', label: 'Material', type: 'string', default: '' },
      { id: 'slot', label: 'Slot', type: 'int', default: 0, min: 0 },
    ],
    poll: () => !!app.activeObject?.data,
    exec: (ctx, p) => {
      const ob = app.activeObject!;
      const ma = ctx.doc.materials[String(p.material)];
      const t = { MESH: 'meshes', CURVE: 'curves', FONT: 'curves', META: 'metaballs', CURVES: 'hair_curves', GREASEPENCIL: 'grease_pencils' }[ob.type as string];
      const owner = t ? (ctx.doc as unknown as Record<string, Record<string, { materials?: (string | null)[] }>>)[t]?.[ob.data!] : undefined;
      const slot = Math.round(Number(p.slot));
      if (!ma || !owner?.materials || slot < 0) return 'CANCELLED';
      while (owner.materials.length <= slot) owner.materials.push(null);
      owner.materials[slot] = ma.id;
      ob.active_material_index = slot;
      app.graph.invalidate?.();
    },
  },
]);

addKeys('User Interface', [{ key: 'E', op: 'ui.eyedropper_bone' }]);

buttonMenuHooks.push(
  { slot: 'values', items: (b) => (boneFieldArmature(b) ? [{ label: 'Bone Eyedropper', shortcut: 'E', op: 'ui.eyedropper_bone' }] : []) },
  {
    // with the other driver entries: not for keyframed properties
    slot: 'drivers',
    items: (b) => {
      const a = animOf(b);
      const st = a ? keyState(app.doc, a.ob, a.path, -1) : 'none';
      return a && (st === 'none' || st === 'driven') ? [{ label: 'Pick Driver Source…', op: 'ui.eyedropper_driver' }] : [];
    },
  },
);
