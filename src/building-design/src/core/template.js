/**
 * New projects: levels, standard views, materials and types for metric or
 * imperial work.
 */
import { Doc, newId } from './doc.js';
import { defaultMaterials, defaultTypes } from './catalog.js';
import { MM_PER_FOOT } from './units.js';
import { defaultPhases } from './phases.js';
import { defaultBasePoints } from './coords.js';

export const VIEW_DEFAULTS = {
  plan: { detail: 'medium', cutHeight: 1200, hiddenCats: [], hiddenIds: [] },
  ceilingPlan: { detail: 'medium', cutHeight: 2300, hiddenCats: ['furniture', 'casework', 'plumbing', 'equipment', 'planting', 'doors', 'windows', 'rooms', 'stairs', 'railings'], hiddenIds: [] },
  view3d: { style: 'shaded', detail: 'fine', hiddenCats: [], hiddenIds: [], sectionBox: null },
  elevation: { style: 'hidden', detail: 'medium', hiddenCats: [], hiddenIds: [], depth: 30000 },
  section: { style: 'hidden', detail: 'medium', hiddenCats: [], hiddenIds: [], depth: 10000 },
};

export function planView(doc, level, kind = 'plan') {
  const imp = doc.units.system === 'imperial';
  const lowest = doc.levels().every((l) => l.elevation >= level.elevation);
  return {
    id: newId('v'),
    kind,
    name: level.name,
    levelId: level.id,
    underlay: kind === 'plan' && !lowest ? 'below' : null,
    scale: imp ? 96 : 100,
    ...VIEW_DEFAULTS[kind],
    cutHeight: kind === 'plan' ? (imp ? 4 * MM_PER_FOOT : 1200) : imp ? 7.5 * MM_PER_FOOT : 2300,
  };
}

export function elevationViews(doc, center = [0, 0], radius = 14000) {
  const imp = doc.units.system === 'imperial';
  const s = imp ? 96 : 100;
  const mk = (name, origin, look) => ({ id: newId('v'), kind: 'elevation', name, origin, look, scale: s, width: 40000, ...VIEW_DEFAULTS.elevation });
  return [
    mk('North', [center[0], center[1] + radius], -Math.PI / 2),
    mk('East', [center[0] + radius, center[1]], Math.PI),
    mk('South', [center[0], center[1] - radius], Math.PI / 2),
    mk('West', [center[0] - radius, center[1]], 0),
  ];
}

export function default3DView(name = '3D View') {
  return {
    id: newId('v'),
    kind: 'view3d',
    name,
    camera: { target: [6000, 4000, 1500], dist: 32000, yaw: -0.85, pitch: 0.55, persp: true, fov: 45 },
    ...VIEW_DEFAULTS.view3d,
  };
}

/**
 * Bring a document opened from an older file up to date: type kinds and
 * materials added since it was saved get their defaults. Runs outside the
 * undo history and does not mark the project modified.
 */
export function upgradeDoc(doc) {
  const system = doc.units.system === 'imperial' ? 'imperial' : 'metric';
  const missingKinds = new Set();
  for (const t of defaultTypes(system)) if (!doc.count(t.kind)) missingKinds.add(t.kind);
  const used = new Set();
  for (const t of defaultTypes(system)) {
    if (!missingKinds.has(t.kind) || doc.has(t.id)) continue;
    doc._put(t.id, Object.freeze(t));
    if (t.materialId) used.add(t.materialId);
  }
  for (const m of defaultMaterials()) if (used.has(m.id) && !doc.has(m.id)) doc._put(m.id, Object.freeze(m));
  if (!doc.count('phase')) for (const p of defaultPhases()) doc._put(p.id, Object.freeze(p));
  if (!doc.count('basePoint')) for (const p of defaultBasePoints(doc)) doc._put(p.id, Object.freeze(p));
  return doc;
}

/**
 * Create an empty project. system: 'metric' | 'imperial'.
 */
export function createProject({ system = 'metric', name = 'Untitled' } = {}) {
  const doc = new Doc();
  const imp = system === 'imperial';
  doc.transact('New project', () => {
    doc.add({
      id: 'project',
      kind: 'project',
      name,
      number: '0001',
      client: '',
      address: '',
      author: '',
      status: 'Concept',
      units: imp ? { system: 'imperial', fraction: 8, metric: 'mm', decimals: 0 } : { system: 'metric', metric: 'mm', fraction: 8, decimals: 0 },
    });
    for (const m of defaultMaterials()) doc.add(m);
    for (const t of defaultTypes(system)) doc.add(t);
    for (const p of defaultPhases()) doc.add(p);
    const h = imp ? 10 * MM_PER_FOOT : 3000;
    const l1 = doc.add({ kind: 'level', name: 'Level 1', elevation: 0 });
    const l2 = doc.add({ kind: 'level', name: 'Level 2', elevation: h });
    for (const l of [l1, l2]) doc.add(planView(doc, l));
    for (const l of [l1, l2]) doc.add(planView(doc, l, 'ceilingPlan'));
    doc.add(default3DView());
    for (const v of elevationViews(doc, [6000, 4000])) doc.add(v);
  });
  doc.clearHistory();
  doc.markSaved();
  return doc;
}
