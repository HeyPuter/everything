// Line rendering settings: line styles, a view layer's line sets and settings, and the render
// toggle and thickness. Settings are read through the measured DNA rules (modprops.gen.ts); the
// line style modifiers are not converted (each line style keeps its default sampling modifier).
import type { ID, RenderSettings } from '../../data/types';
import { uid } from '../../data/defaults';
import { defaultFreestyleSettings, newLineSet, newLineStyle } from '../../lines/defaults';
import type { FreestyleSettings, LineSet, LineStyleData } from '../../lines/types';
import type { BStruct } from './reader';
import type { Ctx } from './context';
import { DNA_PROP_RULES } from './modprops.gen';
import { readRule } from './modifiers';

/** Apply every rule of a DNA struct to the keys `target` already has. */
function applyRules(d: BStruct, ctx: Ctx, target: Record<string, unknown>) {
  const rules = DNA_PROP_RULES[d.type];
  if (!rules) return;
  for (const [k, r] of Object.entries(rules.props)) {
    if (!(k in target) || r.ptr) continue;
    const v = readRule(d, r, ctx, (s) => ctx.objectRef(s));
    if (v !== undefined) target[k] = v;
  }
}

const styleCache = new WeakMap<Ctx, Map<number, ID>>();

export function convertLineStyle(ls: BStruct, ctx: Ctx): ID {
  let cache = styleCache.get(ctx);
  if (!cache) styleCache.set(ctx, (cache = new Map()));
  const done = cache.get(ls.offset);
  if (done) return done;
  const data: LineStyleData = { ...newLineStyle(ls.idName), id: uid('ls') };
  applyRules(ls, ctx, data as unknown as Record<string, unknown>);
  data.color = [ls.num('r'), ls.num('g'), ls.num('b')];
  const mods = ['color_modifiers', 'alpha_modifiers', 'thickness_modifiers', 'geometry_modifiers'].reduce((n, k) => n + ls.list(k, 1000).length, 0);
  if (mods) ctx.warn.add('Line style modifiers not imported (default sampling kept)', ls.idName);
  (ctx.doc.linestyles ??= {})[data.id] = data;
  cache.set(ls.offset, data.id);
  return data.id;
}

/** Line settings of a view layer (FreestyleConfig), or null when it has none. */
export function convertFreestyle(vl: BStruct, ctx: Ctx): FreestyleSettings | null {
  const cfg = vl.sub('freestyle_config');
  if (!cfg) return null;
  const fs = defaultFreestyleSettings();
  applyRules(cfg, ctx, fs as unknown as Record<string, unknown>);
  // the "Python scripting" mode has no equivalent here
  fs.mode = 'EDITOR';
  const vlRules = DNA_PROP_RULES[vl.type];
  const useRule = vlRules?.props.use_freestyle;
  if (useRule) fs.use_freestyle = readRule(vl, useRule, ctx, () => null) !== false;
  fs.linesets = cfg.list('linesets', 1000).map((l) => {
    const set: LineSet = newLineSet(l.str('name') || 'LineSet', null);
    applyRules(l, ctx, set as unknown as Record<string, unknown>);
    const st = l.ref('linestyle');
    set.linestyle = st ? convertLineStyle(st, ctx) : null;
    const col = l.ref('group');
    set.collection = col ? ctx.collection(col) : null;
    return set;
  });
  // the active line set carries the "current" flag
  fs.active_lineset_index = Math.max(0, cfg.list('linesets', 1000).findIndex((l) => (l.num('flags') & 1) !== 0));
  return fs;
}

/** Render ▸ Freestyle toggle and line thickness. */
export function convertLineRender(r: BStruct, render: RenderSettings) {
  render.use_freestyle = (r.num('mode') & (1 << 25)) !== 0;
  render.line_thickness_mode = r.num('line_thickness_mode') === 2 ? 'RELATIVE' : 'ABSOLUTE';
  const t = r.num('unit_line_thickness');
  if (t > 0) render.line_thickness = t;
}
