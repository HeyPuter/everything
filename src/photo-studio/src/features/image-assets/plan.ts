// Image Assets planning: which files a document's layer names ask for, with
// the document defaults applied, SVG eligibility checked and duplicate paths
// reported. Pure; no DOM.
import { allLayers, type Layer, type PhotoDocument } from '../../model/document';
import { isDefaultsName, parseAssetName, parseDefaults, type AssetFormat, type AssetSize, type AssetVariant } from './names';

export type PlannedAsset = {
  layerId: string;
  layerName: string;
  path: string;
  format: AssetFormat;
  ext: string;
  quality?: number;
  size?: AssetSize;
  // Variant scale from the defaults layer (1 without one).
  scale: number;
};
export type AssetIssue = { layerId: string; layerName: string; message: string };
export type AssetPlan = { assets: PlannedAsset[]; issues: AssetIssue[]; defaultsLayer?: string };

/** Pixels per inch of the document (72 when unset). */
export function documentPpi(doc: PhotoDocument): number {
  const r = doc.resolution;
  if (!r || !(r.horizontalResolution > 0)) return 72;
  return r.horizontalResolutionUnit === 'PPCM' ? r.horizontalResolution * 2.54 : r.horizontalResolution;
}

/** Shape and text layers (or groups of only those) can be written as SVG. */
export function svgEligible(l: Layer): boolean {
  if (l.kind === 'vector' || l.kind === 'text') return true;
  if (l.kind !== 'group') return false;
  const leaves = allLayers(l.children).filter((c) => c.kind !== 'group');
  return leaves.length > 0 && leaves.every((c) => c.kind === 'vector' || c.kind === 'text');
}

const NO_VARIANTS: AssetVariant[] = [{ scale: 1, folder: '', suffix: '' }];

export function planAssets(doc: PhotoDocument): AssetPlan {
  const ppi = documentPpi(doc);
  const issues: AssetIssue[] = [];
  let variants = NO_VARIANTS;
  let defaultsLayer: string | undefined;
  for (const l of doc.layers) {
    const d = parseDefaults(l.name);
    if (!d) continue;
    if (defaultsLayer) {
      issues.push({ layerId: l.id, layerName: l.name, message: 'Only one defaults layer is used; this one is ignored.' });
      continue;
    }
    defaultsLayer = l.id;
    for (const message of d.errors) issues.push({ layerId: l.id, layerName: l.name, message });
    if (d.variants.length) variants = d.variants;
  }
  const assets: PlannedAsset[] = [];
  const owners = new Map<string, Layer>();
  for (const l of allLayers(doc.layers)) {
    if (l.id === defaultsLayer || (isDefaultsName(l.name) && doc.layers.includes(l))) continue;
    const parsed = parseAssetName(l.name, ppi);
    if (!parsed) continue;
    for (const message of parsed.errors) issues.push({ layerId: l.id, layerName: l.name, message });
    for (const o of parsed.outputs) {
      if (o.format === 'svg' && !svgEligible(l)) {
        issues.push({ layerId: l.id, layerName: l.name, message: `“${o.path}”: SVG needs a shape or text layer, or a group of only those.` });
        continue;
      }
      for (const v of variants) {
        const path = `${v.folder}${o.folder}${o.stem}${v.suffix}.${o.ext}`;
        const key = path.toLowerCase();
        const owner = owners.get(key);
        if (owner) {
          issues.push({
            layerId: l.id,
            layerName: l.name,
            message: owner === l ? `“${path}” is written twice by this layer.` : `“${path}” is also written by the layer “${owner.name}”.`,
          });
          continue;
        }
        owners.set(key, l);
        assets.push({ layerId: l.id, layerName: l.name, path, format: o.format, ext: o.ext, ...(o.quality !== undefined ? { quality: o.quality } : {}), ...(o.size ? { size: o.size } : {}), scale: v.scale });
      }
    }
  }
  return { assets, issues, ...(defaultsLayer ? { defaultsLayer } : {}) };
}

/** Whether any layer name asks for an asset (cheap check for menus). */
export function hasAssetNames(doc: PhotoDocument): boolean {
  const ppi = documentPpi(doc);
  return allLayers(doc.layers).some((l) => !isDefaultsName(l.name) && !!parseAssetName(l.name, ppi)?.outputs.length);
}

/** The folder written next to a document saved at `path` ("/a/Poster.photo" → "/a/Poster-assets"). */
export function assetsFolder(path: string): string {
  const slash = path.lastIndexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash);
  const stem = path.slice(slash + 1).replace(/\.[^.]+$/, '') || 'Untitled';
  return `${dir}/${stem}-assets`;
}
