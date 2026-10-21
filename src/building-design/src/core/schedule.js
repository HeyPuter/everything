/**
 * Schedules: tables of elements of one category with chosen fields,
 * sorting, optional grouping by type with counts and totals, and CSV export.
 */
import { openingSize, verticalExtent, levelOf, stairLayout, rampLayout } from './model.js';
import { schemeLabel, AREA_TYPES } from './props.js';
import { typeThickness, KIND_LABEL, CATEGORIES } from './catalog.js';
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
};

export function scheduleColumns(doc, view) {
  const cat = SCHEDULE_CATEGORIES[view.category];
  if (!cat) return [];
  const ids = view.fields?.length ? view.fields : cat.defaults;
  return ids.map((id) => cat.fields.find((f) => f.id === id)).filter(Boolean);
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
  const els = cat.kinds.flatMap((k) => app.doc.all(k));
  let rows = els.map((el) => {
    const values = {};
    for (const c of cols) {
      try {
        values[c.id] = c.get(el, ctx);
      } catch {
        values[c.id] = '';
      }
    }
    return { id: el.id, ids: [el.id], values };
  });
  const itemize = view.itemize ?? !cat.group;
  if (!itemize) {
    const groups = new Map();
    const keyCols = cols.filter((c) => c.type === 'text' && !c.edit);
    for (const r of rows) {
      const key = keyCols.map((c) => r.values[c.id]).join('|');
      if (!groups.has(key)) groups.set(key, { id: null, ids: [], values: { ...r.values, count: 0 } });
      const g = groups.get(key);
      g.ids.push(r.id);
      for (const c of cols) {
        if (c.type === 'count') g.values[c.id] = (g.values[c.id] || 0) + 1;
        else if (['area', 'volume', 'length'].includes(c.type) && g.ids.length > 1) g.values[c.id] = (+g.values[c.id] || 0) + (+r.values[c.id] || 0);
        else if (c.edit && g.ids.length > 1 && g.values[c.id] !== r.values[c.id]) g.values[c.id] = '';
      }
    }
    rows = [...groups.values()];
  }
  const sort = view.sortBy && cols.some((c) => c.id === view.sortBy) ? view.sortBy : cols[0]?.id;
  const dir = view.sortDir === 'desc' ? -1 : 1;
  if (sort)
    rows.sort((a, b) => {
      const x = a.values[sort];
      const y = b.values[sort];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
    });
  return rows;
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
