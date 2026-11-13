// A later request supersedes only the same style properties on overlapping
// layers. Completed requests still invalidate older pending choices.
export class StyleRequests<T extends object> {
  private owners = new WeakMap<object, Map<string, Map<keyof T, object>>>();
  constructor(private groups: readonly (readonly (keyof T)[])[] = []) {}

  private claims(keys: readonly (keyof T)[]) {
    const claimed = new Set(keys);
    for (const group of this.groups) if (group.some((key) => claimed.has(key))) for (const key of group) claimed.add(key);
    return claimed;
  }

  begin(owner: object, ids: readonly string[], patch: Partial<T>) {
    let layers = this.owners.get(owner);
    if (!layers) this.owners.set(owner, layers = new Map());
    const token = {};
    const keys = (Object.keys(patch) as (keyof T)[]).filter((key) => patch[key] !== undefined);
    const claims = this.claims(keys);
    for (const id of ids) {
      let fields = layers.get(id);
      if (!fields) layers.set(id, fields = new Map());
      for (const key of claims) fields.set(key, token);
    }
    const current = (id: string) => keys.filter((key) => layers.get(id)?.get(key) === token);
    return {
      patch: (id: string): Partial<T> => Object.fromEntries(current(id).map((key) => [key, patch[key]])) as Partial<T>,
      isCurrent: (id: string) => current(id).length > 0,
      revision: (id: string) => current(id).join('|'),
      finish: () => {
        for (const id of ids) {
          const fields = layers.get(id);
          if (!fields) continue;
          for (const key of claims) if (fields.get(key) === token) fields.delete(key);
          if (!fields.size) layers.delete(id);
        }
      },
    };
  }

  cancel(owner: object, id: string, keys: readonly (keyof T)[]) {
    const layers = this.owners.get(owner);
    const fields = layers?.get(id);
    if (!fields) return;
    for (const key of this.claims(keys)) fields.delete(key);
    if (!fields.size) layers!.delete(id);
  }
}
