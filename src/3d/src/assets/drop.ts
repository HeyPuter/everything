// Dragging assets out of the Asset Browser: a thumbnail follows the pointer with a hint of what
// a drop will do, and releasing it over an editor uses the asset there: objects and collections
// land on the surface under the pointer in a 3D view, materials, geometry node groups and actions
// go onto the object under the pointer, worlds become the scene world, node groups become group
// nodes in node editors. Inside the browser a drop on a catalog files the assets there.
import { Vector3 } from 'three';
import { h, patch } from '../ui/h';
import { icon } from '../ui/icons';
import { app, type AreaLike } from '../app/app';
import { shell } from '../ui/shell';
import { surfaceHit } from '../ops/view3d';
import { HEADER } from '../nodes/editor/layout';
import { findAsset, libraryDoc } from './library';
import { ASSET_TYPE_INFO } from './types';
import { nodeEditorOf } from './ops';
import { isPoseAction } from './poselib';
import type { ImportSetting } from './state';

export interface DragPayload {
  refs: string[];
  importMethod: ImportSetting;
  instanceCollections: boolean;
}

/** Drop targets inside the Asset Browser (catalogs); return a hint, and handle the drop. */
export interface InternalTarget {
  hint(el: HTMLElement): string | null;
  drop(el: HTMLElement): boolean;
}

interface ViewLike {
  el: HTMLElement;
  pick(x: number, y: number, r?: number): { id: string } | null;
  unproject(x: number, y: number, d: Vector3): Vector3;
  ray(x: number, y: number): { origin: Vector3; dir: Vector3 };
}

function areaAt(x: number, y: number): AreaLike | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el || el.closest('.popup-layer')) return null;
  const areaEl = el.closest<HTMLElement>('.area');
  if (!areaEl) return null;
  const a = shell.screen.areas.find((x) => x.el === areaEl);
  if (a) return a;
  const hov = app.hoverArea;
  return hov && hov.el === areaEl ? hov : null;
}

const NODE_EDITORS = new Set(['SHADER', 'GEOMETRY', 'COMPOSITOR', 'TEXTURE_NODES']);

interface Plan {
  hint: string;
  ok: boolean;
  run?: () => void;
}

/** What dropping the assets at a client point would do. */
function plan(p: DragPayload, x: number, y: number, internal?: InternalTarget): Plan {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (el && internal) {
    const hint = internal.hint(el);
    if (hint) return { hint, ok: true, run: () => void internal.drop(el) };
  }
  const area = areaAt(x, y);
  const first = findAsset(p.refs[0]);
  if (!first || !area) return { hint: '', ok: false };
  const base = { import_method: p.importMethod };
  const name = first.block.name;
  const many = p.refs.length > 1 ? ` (+${p.refs.length - 1})` : '';
  const runAll = (op: string, extra: (ref: string) => Record<string, unknown>) => () => {
    for (const ref of p.refs) app.run(op, { ...base, asset: ref, ...extra(ref) }, { invoke: false, area });
  };
  if (area.type === 'VIEW_3D') {
    const v = area.editor as ViewLike;
    const r = v.el.getBoundingClientRect();
    const lx = x - r.left,
      ly = y - r.top;
    const under = () => {
      const hit = v.pick(lx, ly, 4);
      return hit ? app.doc.objects[hit.id] : undefined;
    };
    const point = () => {
      // on the surface under the pointer, else on the ground plane, else at the 3D cursor's depth
      const s = surfaceHit(v as never, lx, ly);
      if (s) return [s.x, s.y, s.z];
      const { origin, dir } = v.ray(lx, ly);
      if (Math.abs(dir.z) > 1e-4) {
        const t = -origin.z / dir.z;
        if (t > 0 && t < 1000) {
          const g = origin.clone().addScaledVector(dir, t);
          return [g.x, g.y, 0];
        }
      }
      const q = v.unproject(lx, ly, new Vector3(...app.doc.scene.cursor.location));
      return [q.x, q.y, q.z];
    };
    switch (first.table) {
      case 'objects':
        if (app.doc.mode !== 'OBJECT') return { hint: 'Switch to Object Mode to add objects', ok: false };
        return { hint: `Add “${name}”${many}`, ok: true, run: () => runAll('object.add_named', () => ({ location: point() }))() };
      case 'collections':
        if (app.doc.mode !== 'OBJECT') return { hint: 'Switch to Object Mode to add collections', ok: false };
        return { hint: `Add “${name}”${many}${p.instanceCollections || first.library === 'LOCAL' ? ' as an instance' : ''}`, ok: true, run: () => runAll('object.collection_external_asset_drop', () => ({ location: point(), use_instance: p.instanceCollections }))() };
      case 'materials': {
        const ob = under();
        if (!ob) return { hint: `Drop “${name}” on an object`, ok: false };
        return { hint: `Assign “${name}” to ${ob.name}`, ok: true, run: () => void app.run('object.drop_named_material', { ...base, asset: p.refs[0], object: ob.id }, { invoke: false, area }) };
      }
      case 'worlds':
        return { hint: `Use “${name}” as the world`, ok: true, run: () => void app.run('world.drop_named', { ...base, asset: p.refs[0] }, { invoke: false, area }) };
      case 'node_groups': {
        const g = libraryDoc(first.library)?.node_groups[first.id];
        if (g?.tree.type !== 'GEOMETRY') return { hint: 'Drop shader node groups in a node editor', ok: false };
        const ob = under();
        if (!ob) return { hint: `Drop “${name}” on an object to add a modifier`, ok: false };
        return { hint: `Add “${name}” modifier to ${ob.name}`, ok: true, run: () => void app.run('object.drop_geometry_nodes', { ...base, asset: p.refs[0], object: ob.id }, { invoke: false, area }) };
      }
      case 'actions': {
        const act = libraryDoc(first.library)?.actions[first.id];
        const ob = under() ?? (act && isPoseAction(act) ? app.activeObject ?? undefined : undefined);
        if (!ob) return { hint: `Drop “${name}” on an object`, ok: false };
        const pose = act && isPoseAction(act) && ob.type === 'ARMATURE';
        return { hint: pose ? `Apply pose “${name}” to ${ob.name}` : `Animate ${ob.name} with “${name}”`, ok: true, run: () => void app.run('anim.action_asset_assign', { ...base, asset: p.refs[0], object: ob.id }, { invoke: false, area }) };
      }
      default:
        return { hint: `${ASSET_TYPE_INFO[first.table].plural} cannot be dropped here`, ok: false };
    }
  }
  if (NODE_EDITORS.has(area.type)) {
    const ed = nodeEditorOf({ area });
    if (first.table !== 'node_groups' || !ed?.tree()) return { hint: first.table === 'node_groups' ? 'No node tree to add to' : `${ASSET_TYPE_INFO[first.table].plural} cannot be dropped here`, ok: false };
    const g = libraryDoc(first.library)?.node_groups[first.id];
    const kind: string = ed.treeType() === 'WORLD' ? 'SHADER' : ed.treeType();
    if (g?.tree.type !== kind) return { hint: `“${name}” does not fit in this node tree`, ok: false };
    return {
      hint: `Add “${name}” group node`,
      ok: true,
      run: () => {
        const [nx, ny] = ed.toNode(x, y);
        const w = (g.tree.default_group_node_width ?? 140) / 2;
        app.run('node.add_group_asset', { ...base, asset: p.refs[0], location: [nx - w, -ny + HEADER / 2] }, { invoke: false, area });
      },
    };
  }
  return { hint: '', ok: false };
}

let active: { cancel(): void } | null = null;

/** Start dragging assets once the pointer has moved a little from `down`; returns false when it was only a click. */
export function startAssetDrag(down: PointerEvent, payload: DragPayload, internal?: InternalTarget) {
  const sx = down.clientX,
    sy = down.clientY;
  let ghost: HTMLElement | null = null;
  let last: Plan | null = null;
  let lastAt = 0;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  const first = findAsset(payload.refs[0]);
  if (!first) return;
  const draw = (x: number, y: number) => {
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'ab-drag';
      document.body.append(ghost);
      document.body.classList.add('ab-dragging');
    }
    // picking reads the ID buffer: limit how often the plan is recomputed (and catch up after a pause)
    const now = performance.now();
    clearTimeout(trailing);
    if (!last || now - lastAt > 50) {
      last = plan(payload, x, y, internal);
      lastAt = now;
    } else trailing = setTimeout(() => ghost && ((lastAt = 0), draw(x, y)), 60);
    ghost.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
    const meta = first.block.asset_data;
    patch(ghost, [
      h('div', { class: 'ab-drag-thumb' }, meta?.preview ? h('img', { src: meta.preview, alt: '' }) : icon(ASSET_TYPE_INFO[first.table].icon)),
      h('div', { class: 'ab-drag-text' }, h('div', { class: 'ab-drag-name' }, payload.refs.length > 1 ? `${first.block.name} +${payload.refs.length - 1}` : first.block.name), last.hint ? h('div', { class: { 'ab-drag-hint': true, bad: !last.ok } }, last.hint) : null),
    ]);
  };
  const end = () => {
    clearTimeout(trailing);
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('keydown', key, true);
    ghost?.remove();
    document.body.classList.remove('ab-dragging');
    active = null;
  };
  const move = (e: PointerEvent) => {
    if (!ghost && Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
    draw(e.clientX, e.clientY);
  };
  const up = (e: PointerEvent) => {
    const dragged = !!ghost;
    end();
    if (!dragged) return;
    // the click that follows a drag must not change the selection
    const swallow = (ev: Event) => ev.stopPropagation();
    addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
    const p = plan(payload, e.clientX, e.clientY, internal);
    if (p.ok && p.run) p.run();
    else if (p.hint) app.report('WARNING', p.hint);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !ghost) return;
    e.preventDefault();
    e.stopPropagation();
    end();
  };
  active?.cancel();
  active = { cancel: end };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('keydown', key, true);
}
