// Volume component of geometry sets: a list of named grids in object space. Immutable like the
// other components (operations return new components sharing unchanged grids).
import type { VolumeGrid } from './types';
import { transformGrid } from './grid';

export class VolumeComponent {
  readonly kind = 'VOLUME' as const;
  constructor(public grids: VolumeGrid[] = []) {}
  get count() {
    return this.grids.length;
  }
  copy() {
    return new VolumeComponent([...this.grids]);
  }
  transformed(m: ArrayLike<number>) {
    return new VolumeComponent(this.grids.map((g) => transformGrid(g, m)));
  }
  /** Add or replace a grid by name. */
  withGrid(g: VolumeGrid) {
    const i = this.grids.findIndex((x) => x.name === g.name);
    return new VolumeComponent(i < 0 ? [...this.grids, g] : this.grids.map((x, k) => (k === i ? g : x)));
  }
}

/** Join volume components (grids with the same name: the first wins, later ones are renamed). */
export function joinVolumes(list: (VolumeComponent | undefined)[]): VolumeComponent | undefined {
  const comps = list.filter((c): c is VolumeComponent => !!c && c.grids.length > 0);
  if (!comps.length) return undefined;
  if (comps.length === 1) return comps[0];
  const out: VolumeGrid[] = [];
  const names = new Set<string>();
  for (const c of comps)
    for (const g of c.grids) {
      let n = g.name;
      for (let i = 1; names.has(n); i++) n = `${g.name}.${String(i).padStart(3, '0')}`;
      names.add(n);
      out.push(n === g.name ? g : { ...g, name: n });
    }
  return new VolumeComponent(out);
}
