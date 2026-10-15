// Mask points following tracking markers: the offset of a parented point at a scene frame is
// the motion of its marker since the frame it was parented at.
import type { DocumentData } from '../data/types';
import type { MaskPoint } from './types';
import { clipTable, markerAt, sceneToClipFrame } from '../tracking/types';

type V = [number, number];

/** Resolver for `layerAt` over a document. */
export function parentResolver(doc: DocumentData) {
  return (p: MaskPoint, sceneFrame: number): V | null => {
    const par = p.parent;
    if (!par) return null;
    const clip = clipTable(doc)[par.clip];
    const t = clip?.tracking.tracks.find((x) => x.name === par.track);
    if (!clip || !t) return null;
    const m = markerAt(t, sceneToClipFrame(clip, sceneFrame));
    if (!m) return null;
    return [m.co[0] - par.co[0], m.co[1] - par.co[1]];
  };
}
