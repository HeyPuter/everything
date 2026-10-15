// Hair curves ↔ geometry nodes curves component. The component carries every attribute, so
// geometry nodes modifiers on a Curves object see radius, selection, surface UVs, curve types…
import { CurvesComponent, isAnonymous, type AttrMap } from '../geonodes/geometry';
import { dataComps } from '../geonodes/types';
import type { HairAttribute, HairCurvesData } from './types';
import { curveCount, pointCount } from './data';

const cache = new WeakMap<Float32Array, { key: string; c: CurvesComponent }>();

/** The curves component of hair data (shares the arrays; cached per data state). */
export function hairToComponent(hc: HairCurvesData): CurvesComponent {
  const key = `${hc.attributes.length}:${hc.attributes.map((a) => a.name + a.domain + a.data.length).join(',')}`;
  const hit = cache.get(hc.positions);
  if (hit && hit.key === key && hit.c.curveOffsets === hc.curve_offsets && sameAttrs(hit.c, hc.attributes)) return hit.c;
  const attrs: AttrMap = new Map();
  const nc = curveCount(hc),
    np = pointCount(hc);
  let cyclic: Uint8Array = new Uint8Array(nc);
  for (const a of hc.attributes) {
    const n = a.domain === 'POINT' ? np : nc;
    if (a.data.length !== n * dataComps(a.data_type)) continue;
    if (a.name === 'cyclic' && a.domain === 'CURVE') {
      cyclic = a.data instanceof Uint8Array ? a.data : Uint8Array.from(a.data);
      continue;
    }
    attrs.set(a.name, { domain: a.domain, type: a.data_type, data: a.data });
  }
  const c = new CurvesComponent(hc.positions, hc.curve_offsets, cyclic, attrs, [...hc.materials]);
  cache.set(hc.positions, { key, c });
  return c;
}

function sameAttrs(c: CurvesComponent, list: HairAttribute[]) {
  for (const a of list) {
    if (a.name === 'cyclic') continue;
    const x = c.attrs.get(a.name);
    if (x && x.data !== a.data) return false;
  }
  return true;
}

/** Write a curves component into hair data (anonymous attributes are dropped). */
export function componentToHair(c: CurvesComponent, hc: HairCurvesData) {
  hc.positions = c.positions.slice();
  hc.curve_offsets = c.curveOffsets.slice();
  const attrs: HairAttribute[] = [];
  for (const [name, a] of c.attrs) {
    if (isAnonymous(name) || (a.domain !== 'POINT' && a.domain !== 'CURVE')) continue;
    attrs.push({ name, domain: a.domain, data_type: a.type, data: a.data.slice() });
  }
  if (c.cyclic.some((x) => x)) attrs.push({ name: 'cyclic', domain: 'CURVE', data_type: 'BOOLEAN', data: c.cyclic.slice() });
  hc.attributes = attrs;
  if (c.materials.length) hc.materials = [...c.materials];
}
