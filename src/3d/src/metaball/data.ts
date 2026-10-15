// Metaball data helpers: factories and the "family" rule (metaball objects sharing a base name
// are polygonized together by one basis object).
import { uid } from '../data/defaults';
import type { DocumentData, ObjectData } from '../data/types';
import type { MetaballData, MetaElement, MetaElementType } from './types';

export const ELEMENT_TYPES: [MetaElementType, string, string][] = [
  ['BALL', 'Ball', 'meta_ball'],
  ['CAPSULE', 'Capsule', 'meta_capsule'],
  ['PLANE', 'Plane', 'meta_plane'],
  ['ELLIPSOID', 'Ellipsoid', 'meta_ellipsoid'],
  ['CUBE', 'Cube', 'meta_cube'],
];

export function newMetaElement(type: MetaElementType = 'BALL', co: [number, number, number] = [0, 0, 0], radius = 2): MetaElement {
  const ellipsoid = type === 'ELLIPSOID';
  return {
    type,
    co: [...co],
    rotation: [1, 0, 0, 0],
    radius,
    stiffness: 2,
    size_x: ellipsoid ? 1.2 : 1,
    size_y: ellipsoid ? 0.8 : 1,
    size_z: 1,
    use_negative: false,
    hide: false,
    select: false,
  };
}

export function newMetaball(name = 'Mball'): MetaballData {
  return { id: uid('mb'), name, resolution: 0.4, render_resolution: 0.2, threshold: 0.6, update_method: 'UPDATE_ALWAYS', elements: [], materials: [], active_element: -1 };
}

export function metaballOf(doc: DocumentData, ob: ObjectData | null | undefined): MetaballData | null {
  if (!ob || ob.type !== 'META' || !ob.data) return null;
  return doc.metaballs?.[ob.data] ?? null;
}

/** The family name of a metaball object: its name up to the first '.'. */
export function familyName(name: string) {
  const i = name.indexOf('.');
  return i < 0 ? name : name.slice(0, i);
}

/** All metaball objects sharing `ob`'s family name (including `ob`), sorted by name. */
export function familyOf(doc: DocumentData, ob: ObjectData): ObjectData[] {
  const fam = familyName(ob.name);
  return Object.values(doc.objects)
    .filter((o) => o.type === 'META' && !!o.data && !!doc.metaballs?.[o.data] && familyName(o.name) === fam)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The object that shows the combined surface of a family: the one named exactly like the family, else the first by name. */
export function basisOf(doc: DocumentData, ob: ObjectData): ObjectData {
  const fam = familyOf(doc, ob);
  if (!fam.length) return ob;
  return fam.find((o) => o.name === familyName(o.name)) ?? fam[0];
}
