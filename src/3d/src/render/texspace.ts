// Texture space of an object's data: the box the Generated texture coordinates span. Automatic
// texture spaces follow the geometry's bounds; a manual one is location ± size.
import type { DocumentData, ObjectData } from '../data/types';

type TexSpaceOwner = { use_auto_texspace?: boolean; texspace_location?: [number, number, number]; texspace_size?: [number, number, number] };

export function texSpaceOwner(doc: DocumentData, ob: ObjectData | undefined): TexSpaceOwner | null {
  if (!ob?.data) return null;
  return ((doc.meshes[ob.data] ?? doc.curves[ob.data]) as TexSpaceOwner | undefined) ?? null;
}

/** Manual texture space bounds (min xyz, max xyz) of an object, or null when it is automatic. */
export function manualTexSpace(doc: DocumentData | undefined, ob: ObjectData | undefined): [number, number, number, number, number, number] | null {
  if (!doc) return null;
  const t = texSpaceOwner(doc, ob);
  if (!t || t.use_auto_texspace !== false) return null;
  const l = t.texspace_location ?? [0, 0, 0];
  const s = t.texspace_size ?? [1, 1, 1];
  return [l[0] - s[0], l[1] - s[1], l[2] - s[2], l[0] + s[0], l[1] + s[1], l[2] + s[2]];
}

/** Bounds of a mesh's vertex positions as a texture space (centre and half size). */
export function boundsTexSpace(positions: ArrayLike<number>): { location: [number, number, number]; size: [number, number, number] } {
  if (!positions.length) return { location: [0, 0, 0], size: [1, 1, 1] };
  const mn = [Infinity, Infinity, Infinity],
    mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
    }
  const location = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2) as [number, number, number];
  // a flat side keeps a usable size
  const size = [0, 1, 2].map((k) => Math.max((mx[k] - mn[k]) / 2, 1e-3)) as [number, number, number];
  return { location, size };
}
