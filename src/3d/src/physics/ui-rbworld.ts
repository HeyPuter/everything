// Scene tab: Rigid Body World panel (enable, collections, settings, cache, field weights).
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, checkbox, enumMenu, opButton } from '../ui/widgets';
import { num, bool, splitRow } from '../ui/props';
import { sceneRigidBodyPanel } from '../editors/properties/tabs';
import { cachePanel, changed, fieldWeightsPanel } from './ui-common';
import { RB_CACHE } from './rigidbody';
import type { RigidBodyWorldX } from './types';

function collectionRow(id: string, owner: Record<string, unknown>, key: string, label: string, none: string): Child {
  const items = [{ value: '', label: none }, ...Object.values(app.doc.collections).filter((c) => c.id !== app.doc.scene.collection).map((c) => ({ value: c.id, label: c.name, icon: 'collection' }))];
  return splitRow(label, enumMenu(id, items, String(owner[key] ?? ''), (v) => ((owner[key] = v || null), changed(`Set ${label}`))));
}

sceneRigidBodyPanel.draw = () => {
  const w = app.doc.scene.rigidbody_world as RigidBodyWorldX | null;
  if (!w) return panel('sc-rb', 'Rigid Body World', () => h('div', { class: 'row-aligned', style: { padding: '2px 0' } }, opButton('rigidbody.world_add', 'Add Rigid Body World')));
  const d = !!w.is_baked;
  return panel(
    'sc-rb',
    'Rigid Body World',
    () => [
      h('div', { class: 'row-aligned', style: { padding: '2px 0' } }, opButton('rigidbody.world_remove', 'Remove Rigid Body World')),
      panel('sc-rb-settings', 'Settings', () => [
        collectionRow('sc-rb-coll', w as never, 'collection', 'Collection', 'All rigid bodies'),
        collectionRow('sc-rb-ccoll', w as never, 'constraints', 'Constraints', 'All constraints'),
        num(w, 'time_scale', 'Speed', { min: 0, max: 100, disabled: d }),
        bool(w, 'use_split_impulse', 'Split Impulse', { disabled: d, tip: 'Push overlapping bodies apart gently, so the correction does not make them bounce' }),
        num(w, 'substeps_per_frame', 'Substeps Per Frame', { int: true, min: 1, max: 1000, disabled: d }),
        num(w, 'solver_iterations', 'Solver Iterations', { int: true, min: 1, max: 1000, disabled: d }),
      ], { sub: true }),
      cachePanel('sc-rb-cache', RB_CACHE, w as unknown as { frame_start: number; frame_end: number; is_baked: boolean }),
      fieldWeightsPanel('sc-rb-fw', w as never, d),
    ],
    { header: checkbox('sc-rb-on', '', w.enabled !== false, (v) => ((w.enabled = v), changed('Toggle Rigid Body World'))) },
  );
};
