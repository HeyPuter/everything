// Shared Properties-editor widgets for the physics tabs.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { propertiesTabs, type PropertiesTab } from '../editors/properties/properties';
import { panel, enumMenu, opButton } from '../ui/widgets';
import { num, splitRow } from '../ui/props';
import { icon } from '../ui/icons';
import type { ObjectData } from '../data/types';
import { caches } from './common';
import { uiList } from '../editors/properties/uilist';
import { cacheOwners } from './ops';
import { switchCache } from './ptcaches';
import { FIELD_TYPES } from './types';

/** Register a properties tab right after another one (keeps the default tab order). */
export function insertTabAfter(afterId: string, tab: PropertiesTab) {
  const i = propertiesTabs.findIndex((t) => t.id === afterId);
  if (i >= 0) propertiesTabs.splice(i + 1, 0, tab);
  else propertiesTabs.push(tab);
}

export const changed = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

export function note(text: string, ic = 'info_small'): Child {
  return h('div', { class: 'prop-note' }, icon(ic), ' ', text);
}

export function subHeading(text: string): Child {
  return h('div', { class: 'sub-label' }, text);
}

/** Vertex group selector bound to owner[key]. */
export function vgroupRow(ob: ObjectData, owner: Record<string, unknown>, key: string, label: string, disabled = false): Child {
  const me = ob.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
  return splitRow(
    label,
    enumMenu(
      `vg-${ob.id}-${key}`,
      [{ value: '', label: '—' }, ...(me?.vertex_groups ?? []).map((g) => ({ value: g.name, label: g.name, icon: 'group_vertex' }))],
      String(owner[key] ?? ''),
      (v) => {
        owner[key] = v;
        changed(`Set ${label}`);
      },
      { disabled },
    ),
  );
}

/** Object selector bound to owner[key]. */
export function objectRow(id: string, owner: Record<string, unknown>, key: string, label: string, filter: (o: ObjectData) => boolean): Child {
  const items = Object.values(app.doc.objects).filter(filter);
  return splitRow(
    label,
    enumMenu(id, [{ value: '', label: '—' }, ...items.map((o) => ({ value: o.id, label: o.name, icon: 'object' }))], String(owner[key] ?? ''), (v) => {
      owner[key] = v || null;
      changed(`Set ${label}`);
    }),
  );
}

function byteSize(v: unknown): number {
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v && typeof v === 'object') {
    let n = 0;
    for (const x of Object.values(v)) n += byteSize(x);
    return n;
  }
  return 0;
}

/** Point cache panel: frame range, status and bake buttons. */
export function cachePanel(id: string, key: string, pc: { frame_start: number; frame_end: number; is_baked: boolean }, opts: { closed?: boolean } = {}): Child {
  return panel(
    id,
    'Cache',
    () => {
      const c = caches.get(key);
      const frames = c?.frames.size ?? 0;
      let bytes = 0;
      if (c) for (const f of c.frames.values()) bytes += byteSize(f);
      const mem = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(bytes > 1024 * 1024 * 10 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
      const status = pc.is_baked ? `${frames} frames baked (${mem})` : frames ? `${frames} frames in memory (${mem})` : 'Not cached yet: play from the start frame';
      const owner = cacheOwners(app.doc).find((o) => o.key === key);
      const holder = owner?.holder;
      const list = holder ? ((holder.point_caches as { name?: string }[] | undefined) ?? [{ name: (pc as { name?: string }).name ?? 'Cache' }]) : null;
      const ai = holder ? Math.min((holder.point_cache_index as number) ?? 0, (list?.length ?? 1) - 1) : 0;
      return [
        holder && list
          ? h(
              'div',
              { style: { padding: '4px 0' } },
              uiList(
                `ptc-${key}`,
                list.map((c, i) => ({ key: `${i}`, label: (i === ai ? (pc as { name?: string }).name : c.name) ?? 'Cache', icon: 'physics' })),
                ai,
                (i) => {
                  switchCache(owner!, i);
                  changed('Set Active Cache');
                },
                {
                  add: () => app.run('ptcache.add', { cache: key }),
                  remove: () => app.run('ptcache.remove', { cache: key }),
                  rename: (i, name) => {
                    if (i === ai) (pc as { name?: string }).name = name;
                    else list[i].name = name;
                    changed('Rename Cache');
                  },
                  rows: 2,
                },
              ),
            )
          : null,
        num(pc, 'frame_start', 'Simulation Start', { int: true, disabled: pc.is_baked }),
        num(pc, 'frame_end', 'End', { int: true, min: pc.frame_start, disabled: pc.is_baked }),
        h('div', { class: 'prop-note' }, status),
        h(
          'div',
          { class: 'row-aligned' },
          pc.is_baked ? opButton('ptcache.free_bake', 'Delete Bake', { cache: key }) : opButton('ptcache.bake', 'Bake', { cache: key }),
          pc.is_baked ? null : opButton('ptcache.free', 'Free Cache', { cache: key }, { tip: 'Free this cache so it is recomputed' }),
        ),
        pc.is_baked
          ? null
          : h(
              'div',
              { class: 'row-aligned' },
              opButton('ptcache.bake', 'Calculate to Frame', { cache: key, bake: false }, { tip: 'Simulate up to the current frame without baking' }),
              opButton('ptcache.bake_from_cache', 'Current Cache to Bake', { cache: key }),
            ),
        h('div', { class: 'row-aligned' }, opButton('ptcache.bake_all', 'Bake All Dynamics'), opButton('ptcache.free_bake_all', 'Delete All Bakes')),
        h('div', { class: 'row-aligned' }, opButton('ptcache.bake_all', 'Update All to Frame', { bake: false }, { tip: 'Simulate every cache up to the current frame without baking' })),
      ];
    },
    { closed: opts.closed },
  );
}

/** Field weights panel: gravity, all fields, and each field type. */
export function fieldWeightsPanel(id: string, owner: { effector_weights_gravity?: number; effector_weights_all?: number; effector_weights_types?: Record<string, number> }, disabled = false, sub = false): Child {
  return panel(
    id,
    'Field Weights',
    () => {
      const types = (owner.effector_weights_types ??= {});
      for (const [t] of FIELD_TYPES) if (types[t] === undefined) types[t] = 1;
      return [
        num(owner as Record<string, number>, 'effector_weights_gravity', 'Gravity', { min: 0, max: 1, slider: true, disabled }),
        owner.effector_weights_all !== undefined ? num(owner as Record<string, number>, 'effector_weights_all', 'All', { min: 0, max: 1, slider: true, disabled }) : null,
        FIELD_TYPES.map(([t, label]) => num(types, t, label, { min: 0, max: 1, slider: true, disabled })),
      ];
    },
    { closed: true, sub },
  );
}

/** Collection selector bound to owner[key] (empty = no collection). */
export function collectionRow(id: string, owner: Record<string, unknown>, key: string, label: string, none = '—', disabled = false): Child {
  const items = [{ value: '', label: none }, ...Object.values(app.doc.collections).filter((c) => c.id !== app.doc.scene.collection).map((c) => ({ value: c.id, label: c.name, icon: 'collection' }))];
  return splitRow(label, enumMenu(id, items, String(owner[key] ?? ''), (v) => ((owner[key] = v || null), changed(`Set ${label}`)), { disabled }));
}
