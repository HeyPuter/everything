// Attribute nodes: Domain Size, Remove Named Attribute and Rename Attribute.
import './fdata';
import { gn, sprop } from './defs';
import { isInternal, type Component, type GeometrySet } from '../geometry';

// ---------------------------------------------------------------------------
// Domain Size

const COMPONENT_OUTPUTS: Record<string, string[]> = {
  MESH: ['Point Count', 'Edge Count', 'Face Count', 'Face Corner Count'],
  POINTCLOUD: ['Point Count'],
  CURVE: ['Point Count', 'Spline Count'],
  INSTANCES: ['Instance Count'],
  GREASEPENCIL: ['Layer Count'],
};

gn(
  'GeometryNodeAttributeDomainSize',
  'attribute',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const comp = sprop(ctx.node, 'component') || 'MESH';
      const out: Record<string, number> = { 'Point Count': 0, 'Edge Count': 0, 'Face Count': 0, 'Face Corner Count': 0, 'Spline Count': 0, 'Instance Count': 0, 'Layer Count': 0 };
      if (comp === 'MESH' && g.mesh) {
        out['Point Count'] = g.mesh.vertCount;
        out['Edge Count'] = g.mesh.edgeCount;
        out['Face Count'] = g.mesh.faceCount;
        out['Face Corner Count'] = g.mesh.cornerCount;
      } else if (comp === 'POINTCLOUD' && g.points) out['Point Count'] = g.points.count;
      else if (comp === 'CURVE' && g.curves) {
        out['Point Count'] = g.curves.pointCount;
        out['Spline Count'] = g.curves.curveCount;
      } else if (comp === 'INSTANCES' && g.instances) out['Instance Count'] = g.instances.count;
      return out;
    },
  },
  {
    items: { component: ['MESH', 'POINTCLOUD', 'CURVE', 'INSTANCES', 'GREASEPENCIL'] },
    propPatch: { component: { expand: true } },
    available: (n, s, isOut) => !isOut || (COMPONENT_OUTPUTS[sprop(n, 'component') || 'MESH'] ?? []).includes(s.identifier),
  },
);

// ---------------------------------------------------------------------------
// Remove Named Attribute

/** Built-in attribute names that cannot be removed. */
const PROTECTED = new Set(['position', 'id_instance', '.edge_verts', '.corner_vert', '.corner_edge']);

/** Whether `name` matches a pattern where one `*` stands for any text. */
export function wildcardMatch(pattern: string, name: string): boolean {
  const parts = pattern.split('*');
  if (parts.length > 2) return name === pattern;
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(name);
}

function attrNames(g: GeometrySet): Set<string> {
  const s = new Set<string>();
  for (const c of g.components()) for (const k of c.attrs.keys()) if (!isInternal(k)) s.add(k);
  return s;
}

function withoutAttrs(g: GeometrySet, names: Set<string>): GeometrySet {
  return g.map((c) => {
    if (![...c.attrs.keys()].some((k) => names.has(k))) return c;
    const cc = c.copy() as Component;
    for (const k of names) cc.attrs.delete(k);
    return cc;
  });
}

gn(
  'GeometryNodeRemoveAttribute',
  'attribute',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const name = ctx.string('Name');
      if (!name) return { Geometry: g };
      const wildcard = sprop(ctx.node, 'Pattern Mode') === 'Wildcard' && name.includes('*');
      const existing = attrNames(g);
      const remove = new Set<string>();
      if (wildcard) {
        for (const k of existing) if (wildcardMatch(name, k) && !PROTECTED.has(k)) remove.add(k);
      } else {
        if (PROTECTED.has(name)) {
          ctx.warn(`Built-in attributes cannot be removed: "${name}"`);
          return { Geometry: g };
        }
        if (!existing.has(name)) {
          ctx.warn(`There is no attribute named "${name}"`);
          return { Geometry: g };
        }
        remove.add(name);
      }
      return { Geometry: remove.size ? withoutAttrs(g, remove) : g };
    },
  },
  {
    menus: {
      'Pattern Mode': [
        ['Exact', 'Exact'],
        ['Wildcard', 'Wildcard'],
      ],
    },
  },
);

// ---------------------------------------------------------------------------
// Rename Attribute

function renameOn(c: Component, pairs: [string, string][], overwrite: boolean): Component | null {
  const cc = c.copy() as Component;
  let changed = false;
  for (const [from, to] of pairs) {
    const a = cc.attrs.get(from);
    if (!a || from === to) continue;
    if (cc.attrs.has(to) && !overwrite) return null;
    cc.attrs.delete(from);
    cc.attrs.set(to, a);
    changed = true;
  }
  return changed ? cc : c;
}

gn(
  'GeometryNodeRenameAttribute',
  'attribute',
  {
    exec: (ctx) => {
      const g = ctx.geometry('Geometry');
      const old = ctx.string('Old'),
        neu = ctx.string('New');
      const prefix = sprop(ctx.node, 'Mode') === 'Prefix';
      const overwrite = ctx.bool('Overwrite');
      if (!old && !prefix) return { Geometry: g };
      const names = attrNames(g);
      const pairs: [string, string][] = prefix ? [...names].filter((n) => n.startsWith(old)).map((n) => [n, neu + n.slice(old.length)]) : names.has(old) ? [[old, neu]] : [];
      if (!pairs.length) {
        if (!prefix) ctx.warn(`There is no attribute named "${old}"`);
        return { Geometry: g };
      }
      if (pairs.some(([, to]) => !to || PROTECTED.has(to))) {
        ctx.warn('Attributes cannot be renamed to an empty or built-in name');
        return { Geometry: g };
      }
      let failed = false;
      const out = g.map((c) => {
        const r = renameOn(c, pairs, overwrite);
        if (!r) failed = true;
        return r ?? c;
      });
      if (failed) ctx.warn(`"${prefix ? old : pairs[0][0]}" could not be renamed because "${pairs[0][1]}" exists (enable Overwrite to replace it)`);
      return { Geometry: out };
    },
  },
  {
    menus: {
      Mode: [
        ['Single', 'Single'],
        ['Prefix', 'Prefix'],
      ],
    },
  },
);

