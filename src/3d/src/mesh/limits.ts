// Size ceiling for building geometry. Operators and modifiers keep Blender's ranges, but at the top
// of those ranges (an Ico Sphere with 10 subdivisions, Subdivision level 6 on a dense mesh, a
// 100000-step Screw) the result would not fit in a browser tab's memory and the tab would crash.
// They estimate the size first and refuse with a clear message instead.

/** Most face corners (and vertices) one build may produce (~1-2 GB of working memory at the limit). */
export const MAX_MESH_ELEMENTS = 8_000_000;

export class MeshTooLargeError extends Error {}

const millions = (n: number) => (n >= 1e9 ? `${Math.round(n / 1e9)} billion` : `${(n / 1e6).toFixed(n < 1e8 ? 1 : 0)} million`);

/**
 * Throw a MeshTooLargeError when `corners` face corners (or `verts` vertices) would exceed the
 * ceiling. `what` names the operation, e.g. "Add Ico Sphere" or "Subdivision".
 */
export function ensureMeshSize(what: string, corners: number, verts = 0): void {
  const n = Math.max(corners, verts);
  if (n <= MAX_MESH_ELEMENTS) return;
  throw new MeshTooLargeError(`${what} would make about ${millions(n)} ${corners >= verts ? 'face corners' : 'vertices'}, more than the ${millions(MAX_MESH_ELEMENTS)} this page can hold in memory. Use lower settings.`);
}

/** Face corners of an Edit Mode mesh (anything with a face list). */
export function meshEditCorners(m: { faces: { verts: ArrayLike<number> }[] }): number {
  let n = 0;
  for (const f of m.faces) n += f.verts.length;
  return n;
}
