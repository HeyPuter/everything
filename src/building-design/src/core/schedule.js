/**
 * Schedules: tables of elements of one category with chosen fields,
 * sorting, optional grouping by type with counts and totals, and CSV export.
 */
import { openingSize, verticalExtent, levelOf, stairLayout, rampLayout } from './model.js';
import { schemeLabel, AREA_TYPES } from './props.js';
import { roofGeometry } from './build3d.js';
import { mepSize, systemOf } from './mep.js';
import { spaceLoads, spaceType } from './spaces.js';
import { VIEW_KINDS, VIEW_LABEL } from './doc.js';
import { scaleLabel } from './units.js';
import { typeThickness, KIND_LABEL, CATEGORIES, categoryOf } from './catalog.js';
import { paramFields } from './params.js';
import { area as polyArea, perimeter, dist } from './geom.js';
import { formatLength, formatArea, formatVolume } from './units.js';

const typeName = (el, c) => c.doc.get(el.typeId)?.name ?? '';
const famName = (el, c) => c.doc.get(el.typeId)?.familyName ?? KIND_LABEL[el.kind] ?? '';
const lvlName = (el, c) => levelOf(c.doc, el)?.name ?? '';
const wallH = (el, c) => {
  const { base, top } = verticalExtent(c.doc, el);
  return top - base;
};
const slabArea = (el) => polyArea(el.boundary || []) - (el.holes || []).reduce((s, h) => s + polyArea(h), 0);

const F = (id, label, get, type = 'text', edit = null) => ({ id, label, get, type, edit });
const COUNT = F('count', 'Count', () => 1, 'count');

export const SCHEDULE_CATEGORIES = {
  door: {
    label: 'Doors',
    kinds: ['door'],
    fields: [
      F('mark', 'Mark', (el) => el.mark ?? '', 'text', 'mark'),
      F('family', 'Family', famName),
      F('type', 'Type', typeName),
      F('width', 'Width', (el, c) => openingSize(c.doc, el).width, 'length'),
      F('height', 'Height', (el, c) => openingSize(c.doc, el).height, 'length'),
      F('level', 'Level', lvlName),
      F('host', 'Wall Type', (el, c) => c.doc.get(c.doc.get(el.hostId)?.typeId)?.name ?? ''),
      F('comments', 'Comments', (el) => el.comments ?? '', 'text', 'comments'),
      COUNT,
    ],
    defaults: ['mark', 'family', 'type', 'width', 'height', 'level', 'comments'],
  },
  window: {
    label: 'Windows',
    kinds: ['window'],
    fields: [
      F('mark', 'Mark', (el) => el.mark ?? '', 'text', 'mark'),
      F('family', 'Family', famName),
      F('type', 'Type', typeName),
      F('width', 'Width', (el, c) => openingSize(c.doc, el).width, 'length'),
      F('height', 'Height', (el, c) => openingSize(c.doc, el).height, 'length'),
      F('sill', 'Sill Height', (el, c) => openingSize(c.doc, el).sill, 'length'),
      F('level', 'Level', lvlName),
      F('comments', 'Comments', (el) => el.comments ?? '', 'text', 'comments'),
      COUNT,
    ],
    defaults: ['mark', 'family', 'type', 'width', 'height', 'sill', 'level'],
  },
  room: {
    label: 'Rooms',
    kinds: ['room'],
    fields: [
      F('number', 'Number', (el) => el.number ?? '', 'text', 'number'),
      F('name', 'Name', (el) => el.name ?? '', 'text', 'name'),
      F('level', 'Level', lvlName),
      F('area', 'Area', (el, c) => c.scene.rooms.room(el)?.area ?? 0, 'area'),
      F('perimeter', 'Perimeter', (el, c) => c.scene.rooms.room(el)?.perimeter ?? 0, 'length'),
      F('volume', 'Volume', (el, c) => (c.scene.rooms.room(el)?.area ?? 0) * (+el.upperOffset || 0), 'volume'),
      F('department', 'Department', (el) => el.department ?? '', 'text', 'department'),
      F('floorFinish', 'Floor Finish', (el) => el.floorFinish ?? '', 'text', 'floorFinish'),
      F('wallFinish', 'Wall Finish', (el) => el.wallFinish ?? '', 'text', 'wallFinish'),
      F('ceilingFinish', 'Ceiling Finish', (el) => el.ceilingFinish ?? '', 'text', 'ceilingFinish'),
      F('comments', 'Comments', (el) => el.comments ?? '', 'text', 'comments'),
      COUNT,
    ],
    defaults: ['number', 'name', 'level', 'area', 'perimeter', 'floorFinish'],
  },
  wall: {
    label: 'Walls',
    kinds: ['wall'],
    fields: [
      F('type', 'Type', typeName),
      F('level', 'Base Level', lvlName),
      F('length', 'Length', (el) => dist(el.a, el.b), 'length'),
      F('height', 'Height', wallH, 'length'),
      F('width', 'Width', (el, c) => typeThickness(c.doc.get(el.typeId)), 'length'),
      F('area', 'Area', (el, c) => dist(el.a, el.b) * wallH(el, c), 'area'),
      F('volume', 'Volume', (el, c) => dist(el.a, el.b) * wallH(el, c) * typeThickness(c.doc.get(el.typeId)), 'volume'),
      F('structural', 'Structural', (el) => (el.structural ? 'Yes' : 'No')),
      F('mark', 'Mark', (el) => el.mark ?? '', 'text', 'mark'),
      F('comments', 'Comments', (el) => el.comments ?? '', 'text', 'comments'),
      COUNT,
    ],
    defaults: ['type', 'level', 'length', 'height', 'area', 'volume'],
  },
  floor: {
    label: 'Floors',
    kinds: ['floor'],
    fields: [
      F('type', 'Type', typeName),
      F('level', 'Level', lvlName),
      F('area', 'Area', slabArea, 'area'),
      F('perimeter', 'Perimeter', (el) => perimeter(el.boundary || []), 'length'),
      F('volume', 'Volume', (el, c) => slabArea(el) * typeThickness(c.doc.get(el.typeId)), 'volume'),
      F('mark', 'Mark', (el) => el.mark ?? '', 'text', 'mark'),
      COUNT,
    ],
    defaults: ['type', 'level', 'area', 'volume'],
  },
  component: {
    label: 'Furniture and Fixtures',
    kinds: ['component'],
    fields: [
      F('category', 'Category', (el, c) => CATEGORIES.find((x) => x.id === c.doc.get(el.typeId)?.category)?.label ?? ''),
      F('family', 'Family', famName),
      F('type', 'Type', typeName),
      F('level', 'Level', lvlName),
      F('mark', 'Mark', (el) => el.mark ?? '', 'text', 'mark'),
      F('comments', 'Comments', (el) => el.comments ?? '', 'text', 'comments'),
      COUNT,
    ],
    defaults: ['category', 'family', 'type', 'level', 'count'],
    group: true,
  },
  column: {
    label: 'Columns',
    kinds: ['column'],
    fields: [F('type', 'Type', typeName), F('level', 'Base Level', lvlName), F('height', 'Height', wallH, 'length'), F('mark', 'Mark', (el) => el.mark ?? '', 'text', 'mark'), COUNT],
    defaults: ['type', 'level', 'height', 'count'],
    group: true,
  },
  stair: {
    label: 'Stairs',
    kinds: ['stair'],
    fields: [
      F('type', 'Type', typeName),
      F('level', 'Base Level', lvlName),
      F('risers', 'Risers', (el, c) => stairLayout(c.doc, el).risers, 'number'),
      F('riser', 'Riser Height', (el, c) => stairLayout(c.doc, el).riserHeight, 'length'),
      F('tread', 'Tread Depth', (el, c) => stairLayout(c.doc, el).tread, 'length'),
      F('width', 'Width', (el, c) => stairLayout(c.doc, el).width, 'length'),
      COUNT,
    ],
    defaults: ['type', 'level', 'risers', 'riser', 'tread', 'width'],
  },
  area: {
    label: 'Areas',
    kinds: ['area'],
    fields: [
      F('number', 'Number', (el) => el.number ?? '', 'text', 'number'),
      F('name', 'Name', (el) => el.name ?? '', 'text', 'name'),
      F('scheme', 'Area Scheme', (el) => schemeLabel(el.scheme)),
      F('areaType', 'Area Type', (el) => AREA_TYPES.find((t) => t.value === (el.areaType || 'floor'))?.label ?? ''),
      F('level', 'Level', lvlName),
      F('area', 'Area', (el, c) => c.scene.areas.area(el)?.area ?? 0, 'area'),
      F('perimeter', 'Perimeter', (el, c) => c.scene.areas.area(el)?.perimeter ?? 0, 'length'),
      F('comments', 'Comments', (el) => el.comments ?? '', 'text', 'comments'),
      COUNT,
    ],
    defaults: ['number', 'name', 'scheme', 'level', 'area'],
  },
  ramp: {
    label: 'Ramps',
    kinds: ['ramp'],
    fields: [
      F('type', 'Type', typeName),
      F('level', 'Base Level', lvlName),
      F('width', 'Width', (el, c) => rampLayout(c.doc, el).width, 'length'),
      F('run', 'Run Length', (el, c) => rampLayout(c.doc, el).run, 'length'),
      F('rise', 'Rise', (el, c) => rampLayout(c.doc, el).rise, 'length'),
      F('slope', 'Slope', (el, c) => `1:${Math.round(rampLayout(c.doc, el).ratio * 10) / 10}`),
      F('mark', 'Mark', (el) => el.mark ?? '', 'text', 'mark'),
      COUNT,
    ],
    defaults: ['type', 'level', 'width', 'run', 'rise', 'slope'],
  },
  roof: {
    label: 'Roofs',
    kinds: ['roof'],
    fields: [
      F('type', 'Type', typeName),
      F('level', 'Base Level', lvlName),
      F('area', 'Footprint Area', slabArea, 'area'),
      F('perimeter', 'Perimeter', (el) => perimeter(el.boundary || []), 'length'),
      F('mark', 'Mark', (el) => el.mark ?? '', 'text', 'mark'),
      COUNT,
    ],
    defaults: ['type', 'level', 'area', 'perimeter'],
  },
  ceiling: {
    label: 'Ceilings',
    kinds: ['ceiling'],
    fields: [
      F('type', 'Type', typeName),
      F('level', 'Level', lvlName),
      F('offset', 'Height Offset', (el) => +el.offset || 0, 'length'),
      F('area', 'Area', slabArea, 'area'),
      F('mark', 'Mark', (el) => el.mark ?? '', 'text', 'mark'),
      COUNT,
    ],
    defaults: ['type', 'level', 'offset', 'area'],
  },
  space: {
    label: 'Spaces',
    kinds: ['space'],
    fields: [
      F('number', 'Number', (el) => el.number ?? '', 'text', 'number'),
      F('name', 'Name', (el) => el.name ?? '', 'text', 'name'),
      F('level', 'Level', lvlName),
      F('zone', 'Zone', (el, c) => c.doc.get(el.zoneId)?.name ?? ''),
      F('spaceType', 'Space Type', (el) => spaceType(el).label),
      F('area', 'Area', (el, c) => spaceLoads(el, c.scene.rooms.room(el))?.area * 1e6 || 0, 'area'),
      F('volume', 'Volume (m?)', (el, c) => Math.round((spaceLoads(el, c.scene.rooms.room(el))?.volume || 0) * 10) / 10, 'number'),
      F('people', 'People', (el, c) => spaceLoads(el, c.scene.rooms.room(el))?.people ?? 0, 'number'),
      F('cooling', 'Cooling (W)', (el, c) => Math.round(spaceLoads(el, c.scene.rooms.room(el))?.cooling || 0), 'number'),
      F('heating', 'Heating (W)', (el, c) => Math.round(spaceLoads(el, c.scene.rooms.room(el))?.heating || 0), 'number'),
      COUNT,
    ],
    defaults: ['number', 'name', 'zone', 'area', 'people', 'cooling', 'heating'],
  },
  duct: {
    label: 'Ducts',
    kinds: ['duct'],
    fields: [
      F('system', 'System Type', (el) => systemOf(el).label),
      F('type', 'Type', typeName),
      F('size', 'Size', (el, c) => {
        const s = mepSize(c.doc, el);
        return s.round ? `⌀${Math.round(s.w)}` : `${Math.round(s.w)} x ${Math.round(s.h)}`;
      }),
      F('length', 'Length', (el) => dist(el.a, el.b), 'length'),
      F('level', 'Level', lvlName),
      COUNT,
    ],
    defaults: ['system', 'size', 'length', 'count'],
    group: true,
  },
  pipe: {
    label: 'Pipes',
    kinds: ['pipe'],
    fields: [
      F('system', 'System Type', (el) => systemOf(el).label),
      F('type', 'Type', typeName),
      F('diameter', 'Diameter', (el, c) => mepSize(c.doc, el).w, 'length'),
      F('length', 'Length', (el) => dist(el.a, el.b), 'length'),
      F('level', 'Level', lvlName),
      COUNT,
    ],
    defaults: ['system', 'diameter', 'length', 'count'],
    group: true,
  },
  footing: {
    label: 'Structural Foundations',
    kinds: ['footing', 'wallFooting'],
    fields: [F('family', 'Family', famName), F('type', 'Type', typeName), F('level', 'Level', (el, c) => lvlName(el.wallId ? c.doc.get(el.wallId) || el : el, c)), F('mark', 'Mark', (el) => el.mark ?? '', 'text', 'mark'), COUNT],
    defaults: ['family', 'type', 'level', 'count'],
    group: true,
  },
  materialTakeoff: {
    label: 'Material Takeoff',
    // One row per layer of every layered element.
    items: (ctx) => {
      const out = [];
      for (const el of ctx.doc.all('wall', 'floor', 'roof', 'ceiling')) {
        const type = ctx.doc.get(el.typeId);
        if (!type?.layers) continue;
        const face = layeredArea(el, ctx);
        type.layers.forEach((l, i) => out.push({ ...el, id: el.id, layer: l, layerIndex: i, faceArea: face }));
      }
      return out;
    },
    fields: [
      F('material', 'Material', (r, c) => c.doc.get(r.layer.materialId)?.name ?? ''),
      F('category', 'Category', (r) => KIND_LABEL[r.kind]),
      F('type', 'Type', typeName),
      F('function', 'Layer Function', (r) => r.layer.function ?? ''),
      F('thickness', 'Thickness', (r) => +r.layer.thickness || 0, 'length'),
      F('area', 'Area', (r) => r.faceArea, 'area'),
      F('volume', 'Volume', (r) => r.faceArea * (+r.layer.thickness || 0), 'volume'),
      F('level', 'Level', lvlName),
      COUNT,
    ],
    defaults: ['material', 'area', 'volume', 'count'],
    group: true,
  },
  sheetList: {
    label: 'Sheet List',
    items: (ctx) => ctx.doc.all('sheet'),
    fields: [
      F('number', 'Sheet Number', (el) => el.number ?? '', 'text', 'number'),
      F('name', 'Sheet Name', (el) => el.name ?? '', 'text', 'name'),
      F('drawnBy', 'Drawn By', (el) => el.drawnBy ?? '', 'text', 'drawnBy'),
      F('checkedBy', 'Checked By', (el) => el.checkedBy ?? '', 'text', 'checkedBy'),
      F('issueDate', 'Issue Date', (el) => el.issueDate ?? '', 'text', 'issueDate'),
      F('views', 'Views', (el, c) => c.doc.all('viewport').filter((v) => v.viewId === el.id).length, 'number'),
      COUNT,
    ],
    defaults: ['number', 'name', 'drawnBy', 'issueDate', 'views'],
  },
  viewList: {
    label: 'View List',
    items: (ctx) => ctx.doc.filter((v) => VIEW_KINDS.has(v.kind) && v.kind !== 'sheet' && v.kind !== 'schedule'),
    fields: [
      F('name', 'View Name', (el) => el.name ?? '', 'text', 'name'),
      F('kind', 'View Type', (el) => VIEW_LABEL[el.kind] ?? el.kind),
      F('level', 'Associated Level', lvlName),
      F('scale', 'Scale', (el, c) => (el.scale ? scaleLabel(+el.scale, c.doc.units) : '')),
      F('detail', 'Detail Level', (el) => ({ coarse: 'Coarse', medium: 'Medium', fine: 'Fine' })[el.detail] ?? ''),
      F('sheet', 'Sheet', (el, c) => {
        const vp = c.doc.all('viewport').find((v) => v.placedId === el.id);
        const sh = vp && c.doc.get(vp.viewId);
        return sh ? `${sh.number} - ${sh.name}` : '';
      }),
      F('template', 'View Template', (el, c) => c.doc.get(el.templateId)?.name ?? ''),
      COUNT,
    ],
    defaults: ['name', 'kind', 'level', 'scale', 'sheet'],
  },
};

/** Face area a layer of a wall, floor, roof or ceiling covers. */
function layeredArea(el, c) {
  if (el.kind === 'wall') return dist(el.a, el.b) * wallH(el, c);
  if (el.kind === 'roof') return roofSurfaceArea(c.doc, el);
  return slabArea(el);
}

/** Sloped surface area of a roof (footprint area over the cosine of each face's slope). */
function roofSurfaceArea(doc, el) {
  try {
    const g = roofGeometry(doc, el);
    let s = 0;
    for (const f of g.faces) s += polyArea(f.poly) / (f.plane ? Math.cos(Math.atan(f.plane.k)) : 1);
    return s - (el.holes || []).reduce((t, h) => t + polyArea(h), 0);
  } catch {
    return slabArea(el);
  }
}

/** Does a schedule row pass the schedule's filters? */
function rowPasses(view, values) {
  for (const f of view.filter || []) if (!scheduleRuleMatches(values[f.field], f)) return false;
  return true;
}

function scheduleRuleMatches(v, rule) {
  const s = String(v ?? '');
  const t = String(rule.value ?? '');
  const n = parseFloat(s);
  const m = parseFloat(t);
  switch (rule.op) {
    case 'equals':
      return s.toLowerCase() === t.toLowerCase() || (Number.isFinite(n) && Number.isFinite(m) && Math.abs(n - m) < 1e-6);
    case 'notEquals':
      return !scheduleRuleMatches(v, { ...rule, op: 'equals' });
    case 'contains':
      return s.toLowerCase().includes(t.toLowerCase());
    case 'notContains':
      return !s.toLowerCase().includes(t.toLowerCase());
    case 'beginsWith':
      return s.toLowerCase().startsWith(t.toLowerCase());
    case 'greater':
      return Number.isFinite(n) && Number.isFinite(m) ? n > m : s.localeCompare(t, undefined, { numeric: true }) > 0;
    case 'less':
      return Number.isFinite(n) && Number.isFinite(m) ? n < m : s.localeCompare(t, undefined, { numeric: true }) < 0;
    case 'hasValue':
      return s !== '';
    case 'hasNoValue':
      return s === '';
    default:
      return true;
  }
}

/** A category's built-in fields plus the project parameters of its elements. */
export function allFields(doc, category) {
  const cat = SCHEDULE_CATEGORIES[category];
  if (!cat) return [];
  if (!cat.kinds) return cat.fields;
  const extra = paramFields(doc, cat.kinds, (k) => (k === 'component' ? '*' : categoryOf({ kind: k }, doc)));
  return [...cat.fields.filter((f) => f.id !== 'count'), ...extra, ...cat.fields.filter((f) => f.id === 'count')];
}

export function scheduleColumns(doc, view) {
  const cat = SCHEDULE_CATEGORIES[view.category];
  if (!cat) return [];
  const fields = allFields(doc, view.category);
  const ids = view.fields?.length ? view.fields : cat.defaults;
  return ids.map((id) => fields.find((f) => f.id === id)).filter(Boolean);
}

/**
 * Rows: [{ id (or null for group rows), ids, values: { fieldId: raw } }],
 * sorted, and grouped by type when the schedule is not itemized.
 */
export function scheduleRows(app, view) {
  const cat = SCHEDULE_CATEGORIES[view.category];
  if (!cat) return [];
  const ctx = { doc: app.doc, scene: app.scene };
  const cols = scheduleColumns(app.doc, view);
  // Filters may use fields that are not shown.
  const fields = allFields(app.doc, view.category);
  const filterCols = (view.filter || []).map((f) => fields.find((x) => x.id === f.field)).filter((c) => c && !cols.includes(c));
  const els = cat.items ? cat.items(ctx) : cat.kinds.flatMap((k) => app.doc.all(k));
  let rows = [];
  for (const el of els) {
    const values = {};
    for (const c of [...cols, ...filterCols]) {
      try {
        values[c.id] = c.get(el, ctx);
      } catch {
        values[c.id] = '';
      }
    }
    if (!rowPasses(view, values)) continue;
    rows.push({ id: el.id, ids: [el.id], values });
  }
  const itemize = view.itemize ?? !cat.group;
  if (!itemize) {
    const groups = new Map();
    const keyCols = cols.filter((c) => c.type === 'text' && !c.edit && !c.editParam);
    for (const r of rows) {
      const key = keyCols.map((c) => r.values[c.id]).join('|');
      if (!groups.has(key)) groups.set(key, { id: null, ids: [], values: { ...r.values, count: 0 } });
      const g = groups.get(key);
      g.ids.push(r.id);
      for (const c of cols) {
        if (c.type === 'count') g.values[c.id] = (g.values[c.id] || 0) + 1;
        else if (['area', 'volume', 'length'].includes(c.type) && g.ids.length > 1) g.values[c.id] = (+g.values[c.id] || 0) + (+r.values[c.id] || 0);
        else if ((c.edit || c.editParam) && g.ids.length > 1 && g.values[c.id] !== r.values[c.id]) g.values[c.id] = '';
      }
    }
    rows = [...groups.values()];
  }
  const sort = view.sortBy && cols.some((c) => c.id === view.sortBy) ? view.sortBy : cols[0]?.id;
  const dir = view.sortDir === 'desc' ? -1 : 1;
  const cmp = (x, y) => (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }));
  const group = view.groupBy && cols.some((c) => c.id === view.groupBy) ? view.groupBy : null;
  if (sort || group)
    rows.sort((a, b) => {
      if (group) {
        const g = cmp(a.values[group], b.values[group]);
        if (g) return g;
      }
      return sort ? cmp(a.values[sort], b.values[sort]) * dir : 0;
    });
  return rows;
}

/** Rows split into groups by a field: [{ value, rows }] (one group when there is no grouping). */
export function scheduleGroups(view, rows) {
  if (!view.groupBy) return [{ value: null, rows }];
  const out = [];
  for (const r of rows) {
    const v = r.values[view.groupBy];
    if (!out.length || out.at(-1).value !== v) out.push({ value: v, rows: [] });
    out.at(-1).rows.push(r);
  }
  return out;
}

export function formatCell(col, v, units) {
  if (v == null || v === '') return '';
  switch (col.type) {
    case 'length':
      return formatLength(+v, units);
    case 'area':
      return formatArea(+v, units);
    case 'volume':
      return formatVolume(+v, units);
    case 'number':
    case 'count':
      return String(Math.round(+v * 100) / 100);
    default:
      return String(v);
  }
}

export function scheduleTotals(cols, rows) {
  const out = {};
  for (const c of cols) {
    if (c.type === 'count') out[c.id] = rows.reduce((s, r) => s + (+r.values[c.id] || 0), 0);
    else if (c.type === 'area' || c.type === 'volume') out[c.id] = rows.reduce((s, r) => s + (+r.values[c.id] || 0), 0);
  }
  return out;
}

function csvCell(s) {
  const t = String(s ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function toCSV(cols, rows, units) {
  const lines = [cols.map((c) => csvCell(c.label)).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(formatCell(c, r.values[c.id], units))).join(','));
  return lines.join('\r\n');
}
