// Values kept across evaluations (simulation states, baked data): fields can't be stored as
// functions of a geometry that changes, so they are evaluated and stored as attributes on the
// geometries of the same state, and read back through attribute fields.
import type { Val } from '../exec';
import { Field, constOf } from '../field';
import { GeometrySet } from '../geometry';
import { attributeField } from '../inputs';
import { storeOn } from '../nodes/geometry';
import { hasDomain } from '../nodes/common';
import { coerce } from '../evaluator';
import { fieldTypeOfEnum, type Domain, type FieldType } from '../types';
import type { ZoneItem } from './items';
import { FIELD_ITEM_TYPES } from './items';

/** Turn non-constant fields of a state into attributes stored on the state's geometries. */
export function persistState(items: ZoneItem[], values: Val[], prefix: string): Val[] {
  const out = values.slice();
  const fieldIdx: number[] = [];
  items.forEach((it, k) => {
    const v = out[k];
    if (v instanceof Field) {
      const c = constOf(v);
      if (c !== undefined) out[k] = c as Val;
      else if (FIELD_ITEM_TYPES.has(it.socket_type)) fieldIdx.push(k);
      else out[k] = coerce(undefined, it.socket_type);
    }
  });
  if (!fieldIdx.length) return out;
  const geoIdx = items.map((it, k) => (it.socket_type === 'GEOMETRY' && out[k] instanceof GeometrySet ? k : -1)).filter((k) => k >= 0);
  for (const k of fieldIdx) {
    const it = items[k];
    const t = fieldTypeOfEnum(it.socket_type) as FieldType;
    const f = out[k] as Field;
    const name = `#${prefix}:${it.id}`;
    const domain = (it.attribute_domain ?? 'POINT') as Domain;
    for (const g of geoIdx) out[g] = (out[g] as GeometrySet).map((c) => (hasDomain(c, domain) ? storeOn(c, domain, name, t, f) : c));
    out[k] = geoIdx.length ? attributeField(name, t) : coerce(undefined, it.socket_type);
  }
  return out;
}
