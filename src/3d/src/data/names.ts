// Unique names inside a list (modifiers of an object, vertex groups of a mesh, data-blocks of a type).

/** `base`, or `base.001`, `base.002`… when one of `names` already has it (the way Blender numbers names). */
export function uniqueNameAmong(names: Iterable<string>, base: string): string {
  const taken = new Set(names);
  if (!taken.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(n)) return n;
  }
}

/**
 * The name for renaming `item` of `list` to `typed`: trimmed and made unique among the other items;
 * null when nothing changes (an empty name, or the current one).
 */
export function renamedIn<T extends { name: string }>(list: readonly T[], item: T, typed: string): string | null {
  const n = typed.trim();
  if (!n || n === item.name) return null;
  return uniqueNameAmong(
    list.filter((x) => x !== item).map((x) => x.name),
    n,
  );
}
