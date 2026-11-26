// How surface bodies are shown: tinted apart from the solid, and hidden with
// the feature that made them. Their faces and edges come after the solid's in
// the build result, so a part without surfaces is checked in constant time.

import { bodyFeatureOf, makesSurfaceBody } from '../model/surfaces';
import type { Feature, Id } from '../model/types';
import { STATE_HIDDEN } from '../render/renderer';
import type { MenuItem } from '../ui/menu';
import type { App } from './app';

/** Colour of surface bodies: the part's colour shifted towards a warm tan, so sheets read apart from the solid. */
function surfaceTint(app: App): [number, number, number] {
  const base = app.renderer.modelColor ?? app.renderer.theme.model;
  const warm = [0.96, 0.74, 0.36];
  return base.map((c, i) => c * 0.55 + warm[i] * 0.45) as [number, number, number];
}

/** Colours the faces of surface bodies (they come after the solid's in the face list). */
export function applySurfaceColors(app: App) {
  const faces = app.faces;
  if (!faces.length || !faces[faces.length - 1].body) return;
  const rgba = new Uint8Array(faces.length * 4);
  const c = surfaceTint(app).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
  faces.forEach((f, i) => { if (f.body) rgba.set([c[0], c[1], c[2], 255], i * 4); });
  app.renderer.setFaceColors(rgba);
}

/** Features whose surface bodies are hidden (none for a part without surfaces, checked in constant time). */
export function hiddenSurfaceFeatures(app: App): Id[] {
  const fl = app.faces;
  if (!fl.length || !fl[fl.length - 1].body) return [];
  return app.store.doc.features.filter((f) => f.hidden && makesSurfaceBody(f)).map((f) => f.id);
}

/** Hides the faces and edges of surface bodies whose feature is hidden. */
export function markHiddenSurfaces(app: App, faces: Uint8Array, edges: Uint8Array) {
  const fl = app.faces, el = app.edges;
  if (!fl.length || !fl[fl.length - 1].body) return;
  const hidden = new Set<Id>();
  for (const f of app.store.doc.features) if (f.hidden && makesSurfaceBody(f)) hidden.add(f.id);
  if (!hidden.size) return;
  fl.forEach((f, i) => { if (f.body && hidden.has(bodyFeatureOf(f.body)) && i < faces.length) faces[i] |= STATE_HIDDEN; });
  el.forEach((e, i) => { if (e.body && hidden.has(bodyFeatureOf(e.body)) && i < edges.length) edges[i] |= STATE_HIDDEN; });
}

/** Whether a feature can be hidden and shown from the design tree (a sketch, plane or surface). */
export function hideable(f: Feature | undefined): boolean {
  return !!f && (f.type === 'sketch' || f.type === 'plane' || makesSurfaceBody(f));
}


/**
 * The Hide item of a surface feature whose body a later feature replaced
 * (a Trim, Extend or Knit made it into its own body): hiding the feature
 * itself showed no change. It hides the feature the body is now, or says
 * that no body shows the surface (thickened, or knit into the solid).
 * Null when the plain Hide item does what it says.
 */
export function surfaceHideItem(app: App, f: Feature): MenuItem | null {
  if (!makesSurfaceBody(f) || f.hidden) return null;
  // Not built yet (below the rollback bar): hiding it takes effect when it is.
  if (app.store.indexOf(f.id) >= app.buildLimit()) return null;
  const owners = new Set<Id>();
  for (const x of app.faces) {
    if (!x.body) continue;
    const owner = bodyFeatureOf(x.body);
    if (owner === f.id) return null;
    if (x.feature === f.id) owners.add(owner);
  }
  const later = [...owners].map((id) => app.store.feature(id)).filter((x): x is Feature => !!x && makesSurfaceBody(x));
  if (later.length === 1) return { label: `Hide ${later[0].name}`, icon: 'eyeOff', run: () => app.toggleHidden([later[0].id], true) };
  return { label: 'Hide (a later feature used this surface)', icon: 'eyeOff', disabled: true };
}
