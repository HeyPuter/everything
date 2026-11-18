import type { Layer, LayerProtection } from './document';

export type LockOperation = 'all' | 'position' | 'pixels' | 'transparency';
// The PSD protection flags (lspf) distinguish image-pixel painting, position
// and transparency locks. The layer-record transparency flag remains separate
// on disk.
export function ownLock(layer: Layer, operation: LockOperation = 'all') {
  if (layer.locked) return true;
  const p = layer.protection;
  if (operation === 'position') return !!p?.position;
  if (operation === 'pixels') return !!p?.composite;
  if (operation === 'transparency')
    return !!(p?.transparency || layer.transparencyProtected);
  return false;
}
export function layerLock(
  layers: Layer[],
  id: string,
  operation: LockOperation = 'all',
  includeSelf = true,
): boolean {
  const visit = (items: Layer[], inherited: boolean): boolean | undefined => {
    for (const l of items) {
      const locked = inherited || ownLock(l, operation);
      if (l.id === id)
        return inherited || (includeSelf && ownLock(l, operation));
      const result = visit(l.children, locked);
      if (result !== undefined) return result;
    }
  };
  return visit(layers, false) ?? false;
}
export function setFullLock(layer: Layer, locked: boolean) {
  layer.locked = locked;
  // Unlocked, the Background keeps the locks that make it the Background
  // (see makeBackground); converting it releases them.
  const kept = locked || !!layer.background;
  // Preserve old projects' compact representation until individual options are
  // used. Imported flags remain independent of the legacy record flag.
  if (layer.protection)
    layer.protection = {
      transparency: kept,
      composite: locked,
      position: kept,
      ...(layer.protection.artboards !== undefined
        ? { artboards: locked && layer.protection.artboards }
        : {}),
    };
  if (layer.transparencyProtected !== undefined)
    layer.transparencyProtected = kept;
}
export function setPartialLock(
  layer: Layer,
  key: keyof LayerProtection,
  locked: boolean,
) {
  const p = layer.protection ?? {
    transparency: false,
    composite: false,
    position: false,
  };
  // Expanding a legacy full lock into individual options must keep the other
  // protections enabled. Disabling one option releases only that option.
  if (layer.locked)
    Object.assign(p, { transparency: true, composite: true, position: true });
  p[key] = locked;
  layer.protection = p;
  layer.locked = p.transparency && p.composite && p.position;
  if (key === 'transparency') layer.transparencyProtected = locked;
}
export function exportProtection(layer: Layer): LayerProtection {
  const p = layer.protection;
  return {
    transparency: layer.locked || !!p?.transparency,
    composite: layer.locked || !!p?.composite,
    position: layer.locked || !!p?.position,
    ...(p?.artboards !== undefined ? { artboards: p.artboards } : {}),
  };
}
