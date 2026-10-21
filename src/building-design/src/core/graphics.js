/**
 * View graphics control: per-category overrides, rule-based filters and
 * view templates.
 *
 *   view.overrides  { [categoryId]: { color, weight, halftone } }
 *   view.filters    [{ id, visible, override: { color, weight, halftone } }]
 *   viewFilter      { name, categories: [categoryId], rules: [{ param, op, value }] }
 *   viewTemplate    { name, viewKind, settings: { scale, detail, style, hiddenCats, overrides, filters, ... } }
 *   view.templateId the template that controls the view's graphics
 *
 * Colours and weights restyle the 2D graphics of plans and of annotations;
 * halftone also applies in 3D. Hidden filters hide what they match.
 */
import { categoryOf, KIND_LABEL } from './catalog.js';
import { levelOf } from './model.js';
import { PlanBuilder, materialOf } from './plan.js';
import { hiddenByWorkset } from './worksets.js';

export const FILTER_PARAMS = [
  { value: 'category', label: 'Category' },
  { value: 'typeName', label: 'Type Name' },
  { value: 'familyName', label: 'Family Name' },
  { value: 'mark', label: 'Mark' },
  { value: 'typeMark', label: 'Type Mark' },
  { value: 'comments', label: 'Comments' },
  { value: 'level', label: 'Level' },
  { value: 'name', label: 'Name' },
  { value: 'number', label: 'Number' },
  { value: 'department', label: 'Department' },
  { value: 'function', label: 'Function' },
  { value: 'structural', label: 'Structural' },
  { value: 'material', label: 'Material' },
  { value: 'keynote', label: 'Keynote' },
  { value: 'phaseCreated', label: 'Phase Created' },
];

export const FILTER_OPS = [
  { value: 'equals', label: 'equals' },
  { value: 'notEquals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'beginsWith', label: 'begins with' },
  { value: 'greater', label: 'is greater than' },
  { value: 'less', label: 'is less than' },
  { value: 'hasValue', label: 'has a value' },
  { value: 'hasNoValue', label: 'has no value' },
];

/** Settings a view template controls. */
export const TEMPLATE_KEYS = ['scale', 'detail', 'style', 'hiddenCats', 'overrides', 'filters', 'roomFill', 'roomFillBy', 'cutHeight', 'viewDepth', 'phaseId', 'phaseFilter'];

/** Value of a filter parameter for an element (strings and numbers). */
export function filterValue(doc, el, param) {
  const type = doc.get(el.typeId);
  switch (param) {
    case 'category':
      return categoryOf(el, doc) || '';
    case 'typeName':
      return type?.name ?? '';
    case 'familyName':
      return type?.familyName ?? KIND_LABEL[el.kind] ?? '';
    case 'typeMark':
      return type?.mark ?? '';
    case 'level':
      return levelOf(doc, el)?.name ?? '';
    case 'function':
      return type?.function ?? '';
    case 'structural':
      return el.structural ? 'Yes' : 'No';
    case 'material':
      return materialOf(doc, el)?.name ?? '';
    case 'keynote':
      return el.keynote ?? type?.keynote ?? '';
    case 'phaseCreated':
      return doc.get(el.phaseId)?.name ?? '';
    default: {
      const v = el.params?.[param] ?? el[param] ?? type?.params?.[param] ?? type?.[param];
      return v == null ? '' : v;
    }
  }
}

function ruleMatches(v, rule) {
  const s = String(v ?? '');
  const t = String(rule.value ?? '');
  const ci = (x) => x.toLowerCase();
  switch (rule.op) {
    case 'equals':
      return ci(s) === ci(t);
    case 'notEquals':
      return ci(s) !== ci(t);
    case 'contains':
      return ci(s).includes(ci(t));
    case 'notContains':
      return !ci(s).includes(ci(t));
    case 'beginsWith':
      return ci(s).startsWith(ci(t));
    case 'greater':
      return Number.isFinite(+s) && Number.isFinite(+t) ? +s > +t : s.localeCompare(t, undefined, { numeric: true }) > 0;
    case 'less':
      return Number.isFinite(+s) && Number.isFinite(+t) ? +s < +t : s.localeCompare(t, undefined, { numeric: true }) < 0;
    case 'hasValue':
      return s !== '';
    case 'hasNoValue':
      return s === '';
    default:
      return false;
  }
}

/** Does a filter select this element? (categories, and every rule). */
export function filterMatches(doc, filter, el) {
  if (!filter || !el) return false;
  if (filter.categories?.length) {
    const cat = categoryOf(el, doc);
    if (!cat || !filter.categories.includes(cat)) return false;
  }
  return (filter.rules || []).every((r) => ruleMatches(filterValue(doc, el, r.param), r));
}

/**
 * Graphics of an element in a view: { hidden, color, weight, halftone }.
 * Category overrides first, then filters in order (later ones win).
 */
export function viewGraphics(doc, view, el) {
  const out = { hidden: false, color: null, weight: null, halftone: false };
  if (!view || !el) return out;
  const cat = categoryOf(el, doc);
  // Object styles set the project-wide look of a category; views override it.
  const os = cat ? doc.get('project')?.objectStyles?.[cat] : null;
  if (os) merge(out, { color: os.color, weight: os.weight });
  const co = cat ? view.overrides?.[cat] : null;
  if (co) merge(out, co);
  for (const f of view.filters || []) {
    const def = doc.get(f.id);
    if (!def || !filterMatches(doc, def, el)) continue;
    if (f.visible === false) out.hidden = true;
    if (f.override) merge(out, f.override);
  }
  return out;
}

function merge(out, o) {
  if (o.color) out.color = o.color;
  if (o.weight) out.weight = +o.weight;
  if (o.halftone) out.halftone = true;
}

/** True when a view's filters hide the element. */
export function hiddenByFilters(doc, view, el) {
  if (hiddenByWorkset(doc, view, el)) return true;
  if (!view?.filters?.length) return false;
  for (const f of view.filters) {
    if (f.visible !== false) continue;
    if (filterMatches(doc, doc.get(f.id), el)) return true;
  }
  return false;
}

function hexRgb(hex) {
  const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Restyle 2D graphics with a colour and line weight (returns a new builder). */
export function restyle(g, { color, weight }) {
  if (!g || (!color && !weight)) return g;
  const rgb = color ? hexRgb(color) : null;
  const b = new PlanBuilder();
  const paint = (c, fallbackAlpha) => {
    if (!rgb) return c;
    // Keep the transparency of tinted fills and of masks; recolour ink.
    if (c && c[0] === -2) return c;
    const a = c ? c[3] : fallbackAlpha;
    return [rgb[0], rgb[1], rgb[2], a];
  };
  for (const l of g.lines) b.lines.push({ ...l, w: weight || l.w, c: paint(l.c, 255) });
  for (const f of g.fills) b.fills.push({ ...f, color: paint(f.color, 110) });
  for (const t of g.texts) b.texts.push({ ...t, color: rgb ? [...rgb, 255] : t.color });
  b.picks = g.picks;
  return b;
}

/** Filters a view depends on (to cache its graphics correctly). */
export function viewFilterItems(doc, view) {
  return (view.filters || []).map((f) => doc.get(f.id));
}

// Templates ------------------------------------------------------------------------------------

export function templateSettings(view) {
  const s = {};
  for (const k of TEMPLATE_KEYS) if (view[k] !== undefined) s[k] = structuredClone(view[k]);
  return s;
}

/** Patch that makes a view follow a template (inside a transaction). */
export function applyTemplatePatch(tpl) {
  const patch = { templateId: tpl.id };
  for (const k of TEMPLATE_KEYS) if (tpl.settings?.[k] !== undefined) patch[k] = structuredClone(tpl.settings[k]);
  return patch;
}

/** Push a template's settings to every view that uses it. */
export function propagateTemplate(doc, tplId) {
  const tpl = doc.get(tplId);
  if (!tpl) return 0;
  let n = 0;
  for (const v of doc.items.values()) {
    if (v.templateId !== tplId) continue;
    doc.update(v.id, applyTemplatePatch(tpl));
    n++;
  }
  return n;
}

/** View kinds a template made from a view of this kind can apply to. */
export function templateKindOf(kind) {
  if (kind === 'plan' || kind === 'areaPlan') return 'plan';
  if (kind === 'elevation' || kind === 'section') return 'elevation';
  return kind;
}
