// Helpers shared by node implementations.
import type { Component, GeometrySet } from '../geometry';
import { makeContext, evalFull, evalSelection, type Field, type FieldContext } from '../field';
import type { Domain } from '../types';

/** Attribute data types offered by data-type menus. */
export const DATA_TYPE_ITEMS = ['FLOAT', 'INT', 'BOOLEAN', 'FLOAT_VECTOR', 'FLOAT_COLOR', 'QUATERNION', 'FLOAT4X4', 'FLOAT2'];

/** Domain holding positions of a component. */
export const pointDomainOf = (c: Component): Domain => (c.kind === 'INSTANCES' ? 'INSTANCE' : 'POINT');

/** Evaluate selection plus fields on a component domain. */
export function evalOn(
  c: Component,
  domain: Domain,
  sel: Field | undefined,
  fields: Field[],
): {
  ctx: FieldContext;
  sel: Uint8Array | null;
  values: ReturnType<typeof evalFull>[];
} {
  const ctx = makeContext(c, domain);
  return {
    ctx,
    sel: evalSelection(sel, ctx),
    values: fields.map((f) => evalFull(f, ctx)),
  };
}

/** Components of a geometry that have a given domain. */
export function componentsWith(g: GeometrySet, domain: Domain): Component[] {
  return g.components().filter((c) => c.domainSize(domain) > 0 || hasDomain(c, domain));
}

export function hasDomain(c: Component, d: Domain): boolean {
  switch (c.kind) {
    case 'MESH':
      return d === 'POINT' || d === 'EDGE' || d === 'FACE' || d === 'CORNER';
    case 'POINTS':
      return d === 'POINT';
    case 'CURVES':
      return d === 'POINT' || d === 'CURVE';
    case 'INSTANCES':
      return d === 'INSTANCE';
  }
}
