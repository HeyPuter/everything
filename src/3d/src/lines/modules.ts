// Style modules: line drawing described by scripts (View Layer ▸ Freestyle ▸ Control Mode ▸
// Script). A style module is a JavaScript Text data-block. It runs with a `lines` object and
// calls `lines.draw(...)` once per group of lines it wants:
//
//   lines.draw({
//     select: { visibility: 'VISIBLE', edge_types: ['silhouette', 'border'] },   // line set fields
//     style: { color: [0.1, 0.1, 0.4], thickness: 2, caps: 'ROUND' },            // line style fields
//     shade(stroke) { for (let i = 0; i < stroke.length; i++) stroke.a[i] *= 0.8; },
//   });
//
// `select` takes the fields of a line set (plus `edge_types` / `exclude_edge_types` lists),
// `style` the fields of a line style (including modifier lists), `shade` may change the
// finished strokes: per point x, y (pixels), r, g, b, a and the thickness on each side tl / tr.
// Modules run in order; each adds its groups of lines.
import type { FreestyleSettings, LineSet, LineStyleData, LineStyleModifier } from './types';
import { EDGE_TYPES } from './types';
import { newLineSet, newLineStyle, newLineStyleModifier } from './defaults';
import type { StyledStroke } from './core/style';

export interface FreestyleModule {
  /** Text data-block with the module's code */
  script: string | null;
  use: boolean;
}

/** A stroke as style modules see it in `shade`. */
export interface ModuleStroke {
  length: number;
  x: Float32Array;
  y: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  tl: Float32Array;
  tr: Float32Array;
  caps: StyledStroke['caps'];
}

export interface CompiledModules {
  sets: LineSet[];
  styles: Record<string, LineStyleData>;
  shaders: Map<LineSet, (s: ModuleStroke) => void>;
  errors: string[];
}

type Raw = Record<string, unknown>;

const MOD_KINDS = ['color', 'alpha', 'thickness', 'geometry'] as const;

/** A line set from a module's `select` options. */
export function moduleLineSet(name: string, styleId: string, sel: Raw = {}): LineSet {
  const set = newLineSet(name, styleId);
  const types = Array.isArray(sel.edge_types) ? (sel.edge_types as string[]) : null;
  const excl = Array.isArray(sel.exclude_edge_types) ? (sel.exclude_edge_types as string[]) : [];
  if (types) for (const [k] of EDGE_TYPES) set[`select_${k}`] = types.includes(k) || excl.includes(k);
  for (const k of excl) if (EDGE_TYPES.some(([t]) => t === k)) set[`exclude_${k}`] = true;
  for (const [k, v] of Object.entries(sel)) {
    if (k === 'edge_types' || k === 'exclude_edge_types' || k === 'name' || k === 'linestyle') continue;
    if (k in set) (set as unknown as Raw)[k] = v;
  }
  set.show_render = true;
  return set;
}

/** A line style from a module's `style` options (modifiers as partial lists). */
export function moduleLineStyle(id: string, name: string, opts: Raw = {}): LineStyleData {
  const ls = { ...newLineStyle(name), id } as LineStyleData;
  for (const [k, v] of Object.entries(opts)) {
    const kind = MOD_KINDS.find((m) => k === `${m}_modifiers`);
    if (kind && Array.isArray(v)) {
      (ls as unknown as Raw)[k] = (v as Raw[]).map((m) => ({ ...newLineStyleModifier(kind, String(m.type ?? 'ALONG_STROKE')), ...m }) as LineStyleModifier);
    } else if (k in ls && k !== 'id') (ls as unknown as Raw)[k] = v;
  }
  return ls;
}

/**
 * Run the enabled modules (code by text id) and collect the line sets, styles and shaders they
 * declare. Errors of a module are collected; the other modules still run.
 */
export function compileModules(fs: Pick<FreestyleSettings, 'modules'>, code: (id: string) => { name: string; body: string } | null): CompiledModules {
  const out: CompiledModules = { sets: [], styles: {}, shaders: new Map(), errors: [] };
  (fs.modules ?? []).forEach((m, mi) => {
    if (!m.use || !m.script) return;
    const text = code(m.script);
    if (!text) return void out.errors.push(`Style module ${mi + 1}: its text is missing`);
    let n = 0;
    const lines = {
      edgeTypes: EDGE_TYPES.map(([k]) => k),
      draw(o: { select?: Raw; style?: Raw; shade?: (s: ModuleStroke) => void } = {}) {
        const id = `__module_${mi}_${n++}`;
        const style = moduleLineStyle(id, `${text.name} ${n}`, o.style ?? {});
        const set = moduleLineSet(`${text.name} ${n}`, id, o.select ?? {});
        out.styles[id] = style;
        out.sets.push(set);
        if (typeof o.shade === 'function') out.shaders.set(set, o.shade);
      },
    };
    try {
      new Function('lines', `"use strict";\n${text.body}`)(lines);
    } catch (e) {
      out.errors.push(`Style module “${text.name}”: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return out;
}

/** Hand finished strokes to a module's shader (errors are reported once per call). */
export function shadeStrokes(strokes: StyledStroke[], shade: (s: ModuleStroke) => void): string | null {
  for (const s of strokes) {
    try {
      shade({ ...s, length: s.x.length });
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  return null;
}

/** Starting code of a new style module. */
export const MODULE_TEMPLATE = `// Line style module: called with \`lines\`; each lines.draw() adds a group of lines.
// select: line set fields (visibility, edge_types, select_by_collection, …)
// style: line style fields (color, alpha, thickness, caps, *_modifiers, …)
// shade(stroke): adjust finished strokes (x, y, r, g, b, a, tl, tr per point)

lines.draw({
  select: { visibility: 'VISIBLE', edge_types: ['silhouette', 'border', 'crease'] },
  style: { color: [0, 0, 0], thickness: 2, caps: 'ROUND' },
  shade(stroke) {
    // taper both ends
    const n = stroke.length;
    for (let i = 0; i < n; i++) {
      const t = Math.sin((Math.PI * i) / Math.max(1, n - 1));
      stroke.tl[i] *= t;
      stroke.tr[i] *= t;
    }
  },
});
`;
