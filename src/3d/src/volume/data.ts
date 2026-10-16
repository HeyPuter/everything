// Volume data-block helpers: factory, lookup, naming. Pure (no app state).
import { uid } from '../data/defaults';
import type { DocumentData, ObjectData } from '../data/types';
import type { VolumeData, VolumeDisplay, VolumeRender } from './types';

export const defaultVolumeDisplay = (): VolumeDisplay => ({
  density: 1,
  wireframe_type: 'BOXES',
  wireframe_detail: 'COARSE',
  interpolation_method: 'LINEAR',
  use_slice: false,
  slice_axis: 'AUTO',
  slice_depth: 0.5,
});

export const defaultVolumeRender = (): VolumeRender => ({ precision: 'HALF', space: 'OBJECT', step_size: 0, clipping: 0.001 });

export function newVolume(name = 'Volume'): VolumeData {
  return {
    id: uid('vo'),
    name,
    filepath: '',
    grids: [],
    active_grid_index: 0,
    display: defaultVolumeDisplay(),
    render: defaultVolumeRender(),
    velocity_grid: 'velocity',
    velocity_scale: 1,
    materials: [],
  };
}

export function volumeOf(doc: DocumentData, ob: ObjectData | null | undefined): VolumeData | null {
  if (!ob || ob.type !== 'VOLUME' || !ob.data) return null;
  return doc.volumes?.[ob.data] ?? null;
}

export function uniqueVolumeName(doc: DocumentData, base: string) {
  const names = new Set(Object.values(doc.volumes ?? {}).map((m) => m.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}
