// What the relight canvas handles and the Properties editor share: which
// light is selected in each relight layer, whether handles are hidden (N)
// and the settings shown while a light is dragged. This is per-person view
// state, never part of the document, so collaborators each keep their own.
import type { Editor } from '../../editor';
import { findLayer, type ColorMode, type Layer } from '../../model/document';
import {
  normalizeRelight,
  type RelightLight,
  type RelightParams,
} from '../../imaging/relight/model';

export const relightUi = {
  hidden: false,
  // Layer ID -> selected light ID.
  selected: new Map<string, string>(),
  // Settings previewed during a drag (handles draw them instead of the stored ones).
  draft: undefined as { layerId: string; params: RelightParams } | undefined,
};

export const isRelightLayer = (l: Layer | undefined): l is Layer & { kind: 'adjustment' } =>
  l?.kind === 'adjustment' && l.adjustment?.kind === 'relight';

/** The relight layer whose lights can be edited: the only selected layer. */
export function activeRelightLayer(e: Editor): Layer | undefined {
  if (!e.hasDocument || e.selectedIds.size !== 1) return;
  const l = e.layer;
  return isRelightLayer(l) ? l : undefined;
}

export function relightParams(l: Layer): RelightParams {
  return normalizeRelight(l.adjustment?.params);
}

/** The selected light of a layer (the first when none is chosen yet). */
export function selectedLight(layerId: string, p: RelightParams): RelightLight | undefined {
  const id = relightUi.selected.get(layerId);
  return p.lights.find((l) => l.id === id) ?? p.lights[0];
}

export function selectLight(layerId: string, lightId: string | undefined) {
  if (lightId) relightUi.selected.set(layerId, lightId);
  else relightUi.selected.delete(layerId);
}

// Relight layers mix colored light into the image, so they need a color
// composite: indexed, bitmap, duotone, multichannel and grayscale documents
// would end up with colors their mode cannot hold.
const SUPPORTED: readonly ColorMode[] = ['rgb', 'cmyk', 'lab'];
export const relightModeSupported = (mode: ColorMode | undefined) =>
  SUPPORTED.includes(mode ?? 'rgb');
export const RELIGHT_MODE_MESSAGE =
  'Relight layers need an RGB, CMYK or Lab document. Convert it with Image › Mode first.';

export const relightLayerById = (e: Editor, id: string) => {
  const l = findLayer(e.doc.layers, id);
  return isRelightLayer(l) ? l : undefined;
};
