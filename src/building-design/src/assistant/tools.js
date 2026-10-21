/**
 * What the assistant can do in a project: functions it may call, each with
 * a JSON schema for the model and an implementation working through the
 * app (so every change is one undo step, and selection, views and dialogs
 * behave as if the user had done it).
 */
import { KIND_LABEL, categoryOf } from '../core/catalog.js';
import { SCHEDULE_CATEGORIES } from '../core/schedule.js';
import { isView, newId, VIEW_LABEL } from '../core/doc.js';
import { modelWarnings } from '../core/warnings.js';
import { formatLength } from '../core/units.js';
import { uniqueName } from '../core/ops.js';
import { COMMANDS } from '../commands.js';

const round = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
const pt = (p) => (Array.isArray(p) ? p.map(round) : p);

/** A compact, readable summary of an element for the model. */
function brief(doc, el) {
  const type = doc.get(el.typeId);
  const out = { id: el.id, kind: el.kind, label: KIND_LABEL[el.kind] || VIEW_LABEL[el.kind] || el.kind };
  if (type) out.type = type.name;
  if (el.name) out.name = el.name;
  if (el.number) out.number = el.number;
  if (el.mark) out.mark = el.mark;
  if (el.levelId) out.level = doc.get(el.levelId)?.name;
  if (el.a) out.a = pt(el.a);
  if (el.b) out.b = pt(el.b);
  if (el.at) out.at = pt(el.at);
  return out;
}

function findLevel(doc, name) {
  const levels = doc.levels();
  if (!name) return levels[0];
  const n = String(name).toLowerCase();
  return levels.find((l) => l.name.toLowerCase() === n) || levels.find((l) => l.name.toLowerCase().includes(n)) || null;
}

function findView(doc, name) {
  const n = String(name || '').toLowerCase();
  const views = doc.filter(isView);
  return views.find((v) => v.name.toLowerCase() === n) || views.find((v) => v.name.toLowerCase().includes(n)) || null;
}

/** Commands safe to run on request (they open dialogs, views or tools, or change what is shown). */
const RUNNABLE = new Set(['warnings', 'worksets', 'designOptions', 'globalParams', 'phases', 'zones', 'loads', 'checkSystems', 'sunSettings', 'shadows', 'render', 'tileViews', 'tabViews', 'zoomFit', 'thinLines', 'visibility', 'filters', 'viewTemplates', 'projectInfo', 'units', 'materials', 'levels', 'types', 'purge', 'export', 'print', 'share', 'syncNow', 'options', 'shortcuts', 'help', 'wall', 'door', 'window', 'floor', 'roof', 'room', 'stair', 'column', 'beam', 'dimension', 'text', 'tag', 'tagAll', 'section', 'elevation', 'sheet', 'schedule', 'placeView', 'view3d']);

export const TOOLS = [
  {
    name: 'project_summary',
    description: 'Overview of the open project: name, units, levels, how many elements of each kind, views, sheets and schedules.',
    parameters: { type: 'object', properties: {} },
    run(app) {
      const doc = app.doc;
      const counts = {};
      for (const el of doc.items.values()) {
        if (isView(el) || el.kind.endsWith('Type') || !categoryOf(el, doc)) continue;
        counts[KIND_LABEL[el.kind] || el.kind] = (counts[KIND_LABEL[el.kind] || el.kind] || 0) + 1;
      }
      return {
        name: doc.project.name,
        units: doc.units.system,
        levels: doc.levels().map((l) => ({ name: l.name, elevation: formatLength(l.elevation, doc.units) })),
        elements: counts,
        views: doc.filter(isView).map((v) => ({ name: v.name, kind: VIEW_LABEL[v.kind] })),
        activeView: app.activeView?.name,
        selection: [...app.selection].length,
      };
    },
  },
  {
    name: 'find_elements',
    description: 'Find elements by kind (wall, door, window, room, floor, roof, column, beam, stair, component, space, duct, pipe, ...), level name and/or type or element name text. Returns up to 200 matches with ids.',
    parameters: { type: 'object', properties: { kind: { type: 'string' }, level: { type: 'string' }, text: { type: 'string', description: 'Part of the type name, element name, number or mark.' } } },
    run(app, { kind, level, text }) {
      const doc = app.doc;
      const lv = level ? findLevel(doc, level) : null;
      const q = text ? String(text).toLowerCase() : null;
      const out = [];
      for (const el of doc.items.values()) {
        if (isView(el) || el.kind.endsWith('Type') || el.kind === 'material') continue;
        if (kind && el.kind !== kind) continue;
        if (lv && el.levelId !== lv.id) continue;
        if (q) {
          const hay = `${doc.get(el.typeId)?.name || ''} ${el.name || ''} ${el.number || ''} ${el.mark || ''}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        if (!kind && !categoryOf(el, doc)) continue;
        out.push(brief(doc, el));
        if (out.length >= 200) break;
      }
      return { count: out.length, elements: out };
    },
  },
  {
    name: 'room_areas',
    description: 'Rooms with their level, number, name, area (m² or ft²) and perimeter.',
    parameters: { type: 'object', properties: { level: { type: 'string' } } },
    run(app, { level }) {
      const doc = app.doc;
      const lv = level ? findLevel(doc, level) : null;
      const imp = doc.units.system === 'imperial';
      return doc.all('room').filter((r) => !lv || r.levelId === lv.id).map((r) => {
        const reg = app.scene.rooms.room(r);
        const a = reg ? reg.area / 1e6 : null;
        return { id: r.id, level: doc.get(r.levelId)?.name, number: r.number, name: r.name, area: a == null ? 'not enclosed' : imp ? `${(a * 10.7639).toFixed(1)} ft²` : `${a.toFixed(2)} m²` };
      });
    },
  },
  {
    name: 'get_element',
    description: 'All stored fields of one element (lengths in millimetres).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run(app, { id }) {
      const el = app.doc.get(id);
      if (!el) return { error: 'No element with that id' };
      const json = JSON.stringify(el);
      return json.length > 4000 ? { ...brief(app.doc, el), note: 'Element too large to show in full' } : el;
    },
  },
  {
    name: 'set_parameters',
    description: 'Change stored fields of elements, for example { name, number, mark, comments, height, offset } (lengths in millimetres). One undoable change.',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, values: { type: 'object' } }, required: ['ids', 'values'] },
    run(app, { ids, values }) {
      const doc = app.doc;
      const bad = ['id', 'kind'];
      const patch = Object.fromEntries(Object.entries(values || {}).filter(([k]) => !bad.includes(k)));
      const live = (ids || []).filter((id) => doc.has(id));
      if (!live.length) return { error: 'None of those ids exist' };
      app.commit('Assistant: change parameters', () => live.forEach((id) => doc.update(id, patch)));
      return { changed: live.length };
    },
  },
  {
    name: 'select_elements',
    description: 'Select elements in the app and show them (opens a plan of their level and zooms to them).',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
    run(app, { ids }) {
      const live = (ids || []).filter((id) => app.doc.has(id));
      app.showElements(live);
      return { selected: live.length };
    },
  },
  {
    name: 'open_view',
    description: 'Open a view, schedule or sheet by name.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run(app, { name }) {
      const v = findView(app.doc, name);
      if (!v) return { error: `No view named "${name}"` };
      app.openView(v.id);
      return { opened: v.name };
    },
  },
  {
    name: 'create_schedule',
    description: `Create a schedule and open it. category is one of: ${Object.keys(SCHEDULE_CATEGORIES).join(', ')}. fields are field ids of that category (leave out for the defaults); sortBy and groupBy are field ids.`,
    parameters: { type: 'object', properties: { category: { type: 'string' }, name: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } }, sortBy: { type: 'string' }, descending: { type: 'boolean' }, groupBy: { type: 'string' } }, required: ['category'] },
    run(app, { category, name, fields, sortBy, descending, groupBy }) {
      const cat = SCHEDULE_CATEGORIES[category];
      if (!cat) return { error: `Unknown category. Use one of: ${Object.keys(SCHEDULE_CATEGORIES).join(', ')}` };
      const ids = new Set(cat.fields.map((f) => f.id));
      const doc = app.doc;
      const v = { id: newId('v'), kind: 'schedule', name: uniqueName(doc.all('schedule').map((s) => s.name), name || `${cat.label} Schedule`), category, fields: fields?.length ? fields.filter((f) => ids.has(f)) : null, sortBy: ids.has(sortBy) ? sortBy : null, sortDir: descending ? 'desc' : 'asc', groupBy: ids.has(groupBy) ? groupBy : null };
      app.commit('Assistant: create schedule', () => doc.add(v));
      app.openView(v.id);
      return { created: v.name, fields: cat.fields.map((f) => f.id) };
    },
  },
  {
    name: 'create_level',
    description: 'Add a level at an elevation (millimetres) with a plan view.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, elevation: { type: 'number' } }, required: ['elevation'] },
    run(app, { name, elevation }) {
      const doc = app.doc;
      let lv;
      app.commit('Assistant: create level', () => {
        lv = doc.add({ kind: 'level', name: name || uniqueName(doc.levels().map((l) => l.name), `Level ${doc.levels().length + 1}`), elevation: +elevation || 0 });
        doc.add({ kind: 'plan', name: lv.name, levelId: lv.id, scale: 100, detail: 'medium' });
      });
      return { created: lv.name };
    },
  },
  {
    name: 'create_walls',
    description: 'Draw walls on a level as a chain through points [[x, y], ...] in millimetres (closed: back to the first point). Uses the current wall type unless typeName matches another.',
    parameters: { type: 'object', properties: { level: { type: 'string' }, points: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, closed: { type: 'boolean' }, typeName: { type: 'string' }, height: { type: 'number' } }, required: ['points'] },
    run(app, { level, points, closed, typeName, height }) {
      const doc = app.doc;
      const lv = findLevel(doc, level);
      if (!lv) return { error: 'No such level' };
      const pts = (points || []).filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [+p[0], +p[1]]);
      if (pts.length < 2) return { error: 'Give at least two points' };
      const type = (typeName && doc.all('wallType').find((t) => t.name.toLowerCase().includes(String(typeName).toLowerCase()))) || app.currentType('wall');
      const above = doc.levelAbove(lv.id);
      const segs = pts.slice(0, -1).map((p, i) => [p, pts[i + 1]]);
      if (closed && pts.length > 2) segs.push([pts.at(-1), pts[0]]);
      const ids = [];
      app.commit('Assistant: walls', () => {
        for (const [a, b] of segs) ids.push(doc.add({ kind: 'wall', typeId: type?.id, levelId: lv.id, a, b, baseOffset: 0, topLevelId: height ? null : above?.id ?? null, topOffset: 0, height: +height || 3000, locationLine: 'center', joinA: true, joinB: true, roomBounding: true }).id);
      });
      app.showElements(ids);
      return { created: ids.length, type: type?.name };
    },
  },
  {
    name: 'model_warnings',
    description: 'Problems found in the model (overlapping walls, rooms not enclosed, duplicate marks...).',
    parameters: { type: 'object', properties: {} },
    run(app) {
      return modelWarnings(app.doc, app.scene).slice(0, 60).map((w) => ({ message: w.message, ids: w.ids }));
    },
  },
  {
    name: 'run_command',
    description: `Run an app command that opens a dialog, a tool or changes the display. One of: ${[...RUNNABLE].join(', ')}.`,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    run(app, { command }) {
      if (!RUNNABLE.has(command) || !COMMANDS[command]) return { error: 'That command is not available to the assistant' };
      app.run(command);
      return { ran: COMMANDS[command].label };
    },
  },
];

/** Tool definitions in the shape chat APIs take. */
export function toolSchemas() {
  return TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function runTool(app, name, input) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { error: `Unknown function ${name}` };
  try {
    return t.run(app, input || {}) ?? { ok: true };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}
