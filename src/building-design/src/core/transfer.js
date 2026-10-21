/**
 * Transfer project standards: copy types, materials, view templates,
 * filters, project parameters and object styles from another project.
 * Items with the same id and content are skipped; items whose id is taken
 * by something different come in as copies with a new id and name.
 */
import { uniqueName } from './ops.js';

export const STANDARD_GROUPS = [
  { id: 'types', label: 'Types (walls, floors, doors, components and all others)', match: (it) => it.kind.endsWith('Type') && it.kind !== 'groupType' },
  { id: 'groups', label: 'Model groups', match: (it) => it.kind === 'groupType' },
  { id: 'materials', label: 'Materials', match: (it) => it.kind === 'material' },
  { id: 'templates', label: 'View templates', match: (it) => it.kind === 'viewTemplate' },
  { id: 'filters', label: 'Filters', match: (it) => it.kind === 'viewFilter' },
  { id: 'params', label: 'Project parameters', match: (it) => it.kind === 'projectParam' },
  { id: 'lineStyles', label: 'Line styles', match: (it) => it.kind === 'lineStyle' },
  { id: 'objectStyles', label: 'Object styles', match: () => false },
];

const same = (a, b) => JSON.stringify({ ...a, id: 0 }) === JSON.stringify({ ...b, id: 0 });

/** Materials a type refers to. */
function materialIds(t) {
  const ids = new Set();
  for (const l of t.layers || []) if (l.materialId) ids.add(l.materialId);
  for (const k of ['materialId', 'panelMaterialId', 'frameMaterialId']) if (t[k]) ids.add(t[k]);
  if (t.curtain?.materialId) ids.add(t.curtain.materialId);
  return ids;
}

/** Count of items in each group of a source project. */
export function standardCounts(src) {
  const out = {};
  for (const g of STANDARD_GROUPS) out[g.id] = g.id === 'objectStyles' ? Object.keys(src.get('project')?.objectStyles || {}).length : src.filter(g.match).length;
  return out;
}

/** Copy the chosen groups from `src` into `doc` (inside a transaction). Returns { added, skipped }. */
export function transferStandards(src, doc, groups) {
  const chosen = new Set(groups);
  const remap = new Map();
  let added = 0;
  let skipped = 0;
  const bring = (it) => {
    const existing = doc.get(it.id);
    if (existing && same(existing, it)) {
      skipped++;
      return it.id;
    }
    const names = doc.all(it.kind).map((x) => x.name);
    const copy = existing ? { ...it, id: undefined, name: uniqueName(names, `${it.name} (transferred)`) } : { ...it };
    const added1 = doc.add(copy);
    added++;
    return added1.id;
  };
  // Materials first, so types can point at them (and at renamed copies).
  const wantMaterials = chosen.has('materials') || chosen.has('types');
  if (wantMaterials) {
    const needed = new Set();
    if (chosen.has('types')) for (const t of src.filter(STANDARD_GROUPS[0].match)) for (const m of materialIds(t)) needed.add(m);
    for (const m of src.all('material')) if (chosen.has('materials') || needed.has(m.id)) remap.set(m.id, bring(m));
  }
  const fixMaterials = (t) => {
    const r = (id) => remap.get(id) ?? id;
    const out = { ...t };
    if (out.layers) out.layers = out.layers.map((l) => ({ ...l, materialId: r(l.materialId) }));
    for (const k of ['materialId', 'panelMaterialId', 'frameMaterialId']) if (out[k]) out[k] = r(out[k]);
    if (out.curtain) out.curtain = { ...out.curtain, materialId: r(out.curtain.materialId) };
    return out;
  };
  if (chosen.has('types')) for (const t of src.filter(STANDARD_GROUPS[0].match)) bring(fixMaterials(t));
  if (chosen.has('groups')) for (const g of src.all('groupType')) bring(g);
  if (chosen.has('filters')) for (const f of src.all('viewFilter')) remap.set(f.id, bring(f));
  if (chosen.has('templates'))
    for (const t of src.all('viewTemplate')) {
      const filters = (t.settings?.filters || []).map((f) => ({ ...f, id: remap.get(f.id) ?? f.id })).filter((f) => doc.has(f.id));
      bring({ ...t, settings: { ...t.settings, filters } });
    }
  if (chosen.has('params')) for (const p of src.all('projectParam')) bring(p);
  if (chosen.has('lineStyles')) for (const p of src.all('lineStyle')) bring(p);
  if (chosen.has('objectStyles')) {
    const os = src.get('project')?.objectStyles;
    if (os) {
      const cur = doc.get('project')?.objectStyles || {};
      doc.update('project', { objectStyles: { ...cur, ...os } });
      added += Object.keys(os).length;
    }
  }
  return { added, skipped };
}
