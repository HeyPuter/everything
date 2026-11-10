/** Allocates and reserves an identifier independently of the wall clock. */
export function uniqueId(prefix: string, used: Set<string>): string {
  let id: string;
  do { id = `${prefix}${crypto.getRandomValues(new Uint32Array(4)).join('-')}`; } while (used.has(id));
  used.add(id);
  return id;
}
