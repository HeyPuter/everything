// Helpers for element-wise field functions used by the function node families.
import { fnField, type Field } from '../field';
import { fieldComps, type FieldType } from '../types';

type Arg = number | number[];

/**
 * Field computing `f` element by element. Each argument is a number (single-component inputs) or
 * a reused array of components; `f` returns a number or an array with the output's components.
 */
export function lift(out: FieldType, ins: Field[], f: (a: Arg[]) => number | ArrayLike<number>): Field {
  const comps = ins.map((x) => fieldComps(x.type));
  const oc = fieldComps(out);
  return fnField(out, ins, (ev, o, n) => {
    const args: Arg[] = comps.map((c) => (c === 1 ? 0 : new Array<number>(c).fill(0)));
    const strides = ev.map((e, k) => (e.single ? 0 : comps[k]));
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < ev.length; k++) {
        const d = ev[k].data,
          s = i * strides[k];
        if (comps[k] === 1) args[k] = d[s];
        else {
          const a = args[k] as number[];
          for (let c = 0; c < comps[k]; c++) a[c] = d[s + c];
        }
      }
      const r = f(args);
      if (oc === 1) o[i] = r as number;
      else for (let c = 0; c < oc; c++) o[i * oc + c] = (r as ArrayLike<number>)[c];
    }
  });
}

/** Stride of an evaluated input (0 for single values). */
export const strideOf = (e: { single: boolean }, comps = 1) => (e.single ? 0 : comps);
