// Filter menu entries: IDs, labels, categories and command IDs of every
// operation, without the operations themselves (they load with the first
// dialog or run, and in the filter worker). `filterMenu` is generated from
// the catalog; tests/filters-menu.test.ts checks it and rewrites it with
// UPDATE_FILTER_MENU=1.
import { RESTORE_ID, RESTORE_LABEL } from '../../imaging/restore/id';
// IDs of renamed operations, still found in projects and actions saved by
// earlier versions.
export const renamedFilters: Record<string, string> = { 'smart-blur': 'edge-preserving-blur', 'smart-sharpen': 'advanced-sharpen' };
// The Filter Gallery stacks other filters; it runs as one pseudo-operation.
export const GALLERY_ID = 'filter-gallery';
// Portrait & Restore runs its own filter stack as one pseudo-operation too.
export { RESTORE_ID };

export function categorySlug(category: string) {
  return category.toLowerCase().replace(/[^a-z]+/g, '-');
}
// Workspaces with their own top-level menu entries and shortcuts.
const special: Record<string, string> = {
  'lens-correction': 'filter.lens-correction',
  develop: 'filter.develop',
  'adaptive-wide-angle': 'filter.adaptive-wide-angle',
  denoise: 'filter.denoise',
  'sharpen-details': 'filter.sharpen-details',
};
/** Filters with their own entry at the top of the Filter menu. */
export const topLevelFilter = (opId: string) => opId in special;
export function commandId(opId: string) {
  if (opId === RESTORE_ID) return 'filter.portrait-restore';
  return opId === GALLERY_ID ? 'filter.gallery' : (special[opId] ?? `filter.apply.${opId}`);
}
export function opIdFromCommand(id: string): string | undefined {
  if (id === 'filter.gallery') return GALLERY_ID;
  if (id === 'filter.portrait-restore') return RESTORE_ID;
  if (id.startsWith('filter.apply.')) return id.slice('filter.apply.'.length);
  return Object.entries(special).find(([, c]) => c === id)?.[0];
}

export type FilterMenuEntry = { id: string; label: string; category: string; immediate?: boolean };
/** Menu label of an operation (or the gallery). */
export function filterLabel(opId: string) {
  const id = renamedFilters[opId] ?? opId;
  if (id === RESTORE_ID) return RESTORE_LABEL;
  return id === GALLERY_ID ? 'Filter Gallery' : (filterMenu.find((f) => f.id === id)?.label ?? opId);
}

// prettier-ignore
export const filterMenu: FilterMenuEntry[] = [
  { id: 'average', label: 'Average', category: 'Blur', immediate: true },
  { id: 'blur', label: 'Blur', category: 'Blur', immediate: true },
  { id: 'blur-more', label: 'Blur More', category: 'Blur', immediate: true },
  { id: 'box-blur', label: 'Box Blur', category: 'Blur' },
  { id: 'gaussian-blur', label: 'Gaussian Blur', category: 'Blur' },
  { id: 'lens-blur', label: 'Lens Blur', category: 'Blur' },
  { id: 'motion-blur', label: 'Motion Blur', category: 'Blur' },
  { id: 'radial-blur', label: 'Radial Blur', category: 'Blur' },
  { id: 'edge-preserving-blur', label: 'Edge-Preserving Blur', category: 'Blur' },
  { id: 'shape-blur', label: 'Shape Blur', category: 'Blur' },
  { id: 'surface-blur', label: 'Surface Blur', category: 'Blur' },
  { id: 'field-blur', label: 'Field Blur', category: 'Blur Gallery' },
  { id: 'iris-blur', label: 'Iris Blur', category: 'Blur Gallery' },
  { id: 'path-blur', label: 'Path Blur', category: 'Blur Gallery' },
  { id: 'spin-blur', label: 'Spin Blur', category: 'Blur Gallery' },
  { id: 'tilt-shift', label: 'Tilt-Shift', category: 'Blur Gallery' },
  { id: 'add-noise', label: 'Add Noise', category: 'Noise' },
  { id: 'denoise', label: 'Denoise', category: 'Noise' },
  { id: 'despeckle', label: 'Despeckle', category: 'Noise', immediate: true },
  { id: 'dust-and-scratches', label: 'Dust & Scratches', category: 'Noise' },
  { id: 'median', label: 'Median', category: 'Noise' },
  { id: 'reduce-noise', label: 'Reduce Noise', category: 'Noise' },
  { id: 'clouds', label: 'Clouds', category: 'Render', immediate: true },
  { id: 'difference-clouds', label: 'Difference Clouds', category: 'Render', immediate: true },
  { id: 'fibers', label: 'Fibers', category: 'Render' },
  { id: 'flame', label: 'Flame', category: 'Render' },
  { id: 'lens-flare', label: 'Lens Flare', category: 'Render' },
  { id: 'lighting-effects', label: 'Lighting Effects', category: 'Render' },
  { id: 'picture-frame', label: 'Picture Frame', category: 'Render' },
  { id: 'tree', label: 'Tree', category: 'Render' },
  { id: 'sharpen', label: 'Sharpen', category: 'Sharpen', immediate: true },
  { id: 'sharpen-edges', label: 'Sharpen Edges', category: 'Sharpen', immediate: true },
  { id: 'sharpen-more', label: 'Sharpen More', category: 'Sharpen', immediate: true },
  { id: 'advanced-sharpen', label: 'Advanced Sharpen', category: 'Sharpen' },
  { id: 'unsharp-mask', label: 'Unsharp Mask', category: 'Sharpen' },
  { id: 'sharpen-details', label: 'Sharpen Details', category: 'Sharpen' },
  { id: 'diffuse', label: 'Diffuse', category: 'Stylize' },
  { id: 'emboss', label: 'Emboss', category: 'Stylize' },
  { id: 'extrude', label: 'Extrude', category: 'Stylize' },
  { id: 'find-edges', label: 'Find Edges', category: 'Stylize', immediate: true },
  { id: 'glowing-edges', label: 'Glowing Edges', category: 'Stylize' },
  { id: 'oil-paint', label: 'Oil Paint', category: 'Stylize' },
  { id: 'solarize', label: 'Solarize', category: 'Stylize', immediate: true },
  { id: 'tiles', label: 'Tiles', category: 'Stylize' },
  { id: 'trace-contour', label: 'Trace Contour', category: 'Stylize' },
  { id: 'wind', label: 'Wind', category: 'Stylize' },
  { id: 'deinterlace', label: 'De-Interlace', category: 'Video' },
  { id: 'broadcast-safe', label: 'Broadcast-Safe Colors', category: 'Video' },
  { id: 'custom', label: 'Custom', category: 'Other' },
  { id: 'high-pass', label: 'High Pass', category: 'Other' },
  { id: 'hsb-hsl', label: 'HSB/HSL', category: 'Other' },
  { id: 'maximum', label: 'Maximum', category: 'Other' },
  { id: 'minimum', label: 'Minimum', category: 'Other' },
  { id: 'offset', label: 'Offset', category: 'Other' },
  { id: 'pinch', label: 'Pinch', category: 'Distort' },
  { id: 'spherize', label: 'Spherize', category: 'Distort' },
  { id: 'twirl', label: 'Twirl', category: 'Distort' },
  { id: 'ripple', label: 'Ripple', category: 'Distort' },
  { id: 'wave', label: 'Wave', category: 'Distort' },
  { id: 'zigzag', label: 'ZigZag', category: 'Distort' },
  { id: 'polar-coordinates', label: 'Polar Coordinates', category: 'Distort' },
  { id: 'shear', label: 'Shear', category: 'Distort' },
  { id: 'displace', label: 'Displace', category: 'Distort' },
  { id: 'glass', label: 'Glass', category: 'Distort' },
  { id: 'ocean-ripple', label: 'Ocean Ripple', category: 'Distort' },
  { id: 'lens-correction', label: 'Lens Correction', category: 'Distort' },
  { id: 'mosaic', label: 'Mosaic', category: 'Pixelate' },
  { id: 'crystallize', label: 'Crystallize', category: 'Pixelate' },
  { id: 'pointillize', label: 'Pointillize', category: 'Pixelate' },
  { id: 'color-halftone', label: 'Color Halftone', category: 'Pixelate' },
  { id: 'fragment', label: 'Fragment', category: 'Pixelate', immediate: true },
  { id: 'facet', label: 'Facet', category: 'Pixelate', immediate: true },
  { id: 'mezzotint', label: 'Mezzotint', category: 'Pixelate' },
  { id: 'develop', label: 'Develop', category: 'Adjustments' },
  { id: 'adaptive-wide-angle', label: 'Wide Angle Correction', category: 'Distort' },
];
