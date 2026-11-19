// Tooltips for the options bar. Tools render their controls as HTML; after
// rendering, every control without a title gets one here: written help for
// the common controls (with their keyboard shortcuts), the command's label,
// shortcut and description for command buttons, else its visible label.
import { commands } from './registry';
import { formatShortcut, isMac } from './shortcuts';

const tips: Record<string, string> = {
  // Brushes (painting and retouching tools).
  'brush-size': 'Brush diameter in pixels. [ makes it smaller, ] larger',
  'retouch-size': 'Brush diameter in pixels. [ makes it smaller, ] larger',
  'brush-hardness': 'Edge hardness: 0% is soft, 100% sharp. Shift+[ softer, Shift+] harder',
  'retouch-hardness': 'Edge hardness: 0% is soft, 100% sharp. Shift+[ softer, Shift+] harder',
  'brush-opacity': 'Most a stroke can cover. Number keys: 1 = 10% … 0 = 100%; two digits quickly for an exact value',
  'brush-flow': 'How fast paint builds up while you drag over an area. Shift+number keys',
  'brush-mode': 'How the paint blends with the pixels below',
  'brush-smoothing': 'Steadies the stroke; higher values follow the pointer more loosely',
  'tool-strength': 'Strength of the effect per stroke',
  'tone-range': 'Tones the tool changes most',
  'tone-exposure': 'Strength of the effect per stroke',
  'sponge-flow': 'How much the saturation changes per stroke',
  'protect-tones': 'Keeps hues from shifting and clipping while dodging or burning',
  'sponge-mode': 'Remove or add color saturation',
  'pattern-scale': 'Size of the pattern relative to its definition',
  'pattern-aligned': 'Continue the pattern across strokes instead of restarting it at each stroke',
  'clone-aligned': 'Keep the source moving with the brush between strokes; off restarts at the source',
  'heal-aligned': 'Keep the source moving with the brush between strokes; off restarts at the source',
  'clone-sample': 'Which layers the source pixels are taken from',
  'heal-sample': 'Which layers the source pixels are taken from',
  'mixer-preset': 'Combination of wetness, load and mix',
  'art-style': 'Shape of the strokes painted from the source state',
  'bg-sampling': 'When the color to erase is sampled: continuously, at the first click, or from the background color',
  'bg-tolerance': 'How different a color can be from the sampled one and still be erased',
  'replace-tolerance': 'How different a color can be from the sampled one and still be replaced',
  // Selections.
  'sel-feather': 'Softens the edge of new selections by this many pixels',
  'sel-aa': 'Smooths the jagged edges of curved selections',
  'marquee-style': 'Draw freely, with a fixed aspect ratio, or at a fixed size',
  'marquee-w': 'Width (or width ratio) of the marquee',
  'marquee-h': 'Height (or height ratio) of the marquee',
  tolerance: 'How different a color can be from the clicked one and still be included (0–255)',
  'wand-contiguous': 'Only select connected areas; off selects the color everywhere',
  'wand-all': 'Sample the merged visible layers instead of the current layer',
  'qs-all': 'Sample the merged visible layers instead of the current layer',
  'object-all': 'Sample the merged visible layers instead of the current layer',
  'object-mode': 'Draw a rectangle or a lasso around the object',
  'sample-size': 'Average of the pixels around the click',
  'sampler-size': 'Average of the pixels around each sampler',
  'sample-layers': 'Sample the current layer, the current layer and those below it, or all layers, optionally without adjustment layers',
  'wand-sample-size': 'Compare with the clicked pixel or the average of the pixels around it',
  // Healing and removal.
  'spot-type': 'How the spot is replaced',
  'spot-all': 'Sample the merged visible layers instead of the current layer',
  'patch-mode': 'Blend the patch with its surroundings or fill it from the context',
  'patch-all': 'Sample the merged visible layers instead of the current layer',
  'remove-all': 'Sample the merged visible layers instead of the current layer',
  'remove-each': 'Apply after each stroke; off waits until you commit',
  'cm-mode': 'Move the selected area or extend it by copying',
  'cm-all': 'Sample the merged visible layers instead of the current layer',
  'contextMove-structure': 'How closely the result keeps the original shapes (1–7)',
  'contextMove-color': 'How much colors are blended with the surroundings (0–10)',
  'mixer-all': 'Sample the merged visible layers instead of the current layer',
  'red-pupil': 'Size of the pupil relative to the eye',
  'red-darken': 'How dark the corrected pupil becomes',
  // Fill and gradient.
  'bucket-source': 'Fill with the foreground color or the current pattern',
  'bucket-opacity': 'Opacity of the fill. Number keys set it',
  'gradient-mode': 'How the gradient blends with the pixels below',
  'gradient-opacity': 'Opacity of the gradient. Number keys set it',
  'gradient-reverse': 'Swap the start and end colors',
  'gradient-dither': 'Add slight noise to prevent banding',
  'gradient-transparency': 'Use the transparency stops of the gradient',
  'gradient-method': 'How colors are interpolated between stops',
  // Shapes and paths.
  'vec-mode': 'Draw a shape layer, a path, or pixels',
  'vec-op': 'How a new shape combines with the existing ones',
  'vec-w': 'Width of the selected shape',
  'vec-h': 'Height of the selected shape',
  'vec-weight': 'Thickness of the line',
  'vec-radius': 'Corner radius',
  'vec-tri-radius': 'Corner radius',
  'vec-poly-radius': 'Corner radius',
  'vec-sides': 'Number of sides (or points of a star)',
  'vec-smooth-indents': 'Round the inner corners of stars',
  'vec-arrow-start': 'Arrowhead at the start of the line',
  'vec-arrow-end': 'Arrowhead at the end of the line',
  'pen-mode': 'Draw a shape layer or a path',
  'pen-op': 'How a new path combines with the existing ones',
  'pen-rubber': 'Preview the next segment while moving the pointer',
  'pen-auto': 'Click a segment to add an anchor point, or an anchor point to delete it',
  'pen-fit': 'How closely the freeform path follows the pointer',
  // Crop, slices, artboards and frames.
  'crop-preset': 'Aspect ratio or size of the crop',
  'crop-rw': 'Width part of the aspect ratio',
  'crop-rh': 'Height part of the aspect ratio',
  'crop-overlay': 'Guide drawn inside the crop box',
  'pc-w': 'Width of the corrected image',
  'pc-h': 'Height of the corrected image',
  'pc-grid': 'Show a grid inside the perspective box',
  'slice-style': 'Draw freely, with a fixed aspect ratio, or at a fixed size',
  'artboard-preset': 'Size of new artboards',
  'artboard-w': 'Artboard width',
  'artboard-h': 'Artboard height',
  'artboard-bg': 'Background of new artboards',
  'frame-fit': 'How placed images fit the frame',
  // Measuring and notes.
  'count-group': 'Count group that new marks are added to',
  'count-color': 'Color of the marks of this group',
  'count-marker': 'Size of the marks',
  'count-label': 'Size of the numbers',
  'note-tool-author': 'Name shown on new notes',
  // Move and view.
  'auto-select': `Click selects the topmost layer under the pointer (or hold ${isMac ? '⌘' : 'Ctrl'})`,
  'transform-snap': 'Snap to guides, layers and the canvas while transforming',
  'transform-proportions': 'Keep the proportions while scaling (Shift switches)',
  'view-angle': 'Rotation of the view in degrees',
  'rotate-all': 'Rotate every open window',
  'scrubby-zoom': 'Drag left or right to zoom out or in',
};

// What each tool does, for the toolbar tooltips.
export const toolTips: Record<string, string> = {
  move: 'Move and transform layers and selections',
  artboard: 'Create, move and resize artboards',
  'rect-marquee': 'Select a rectangle (Shift for a square)',
  'ellipse-marquee': 'Select an ellipse (Shift for a circle)',
  'row-marquee': 'Select a row one pixel high',
  'column-marquee': 'Select a column one pixel wide',
  lasso: 'Select a freehand area',
  'polygonal-lasso': 'Select an area with straight edges, click by click',
  'magnetic-lasso': 'Select an area whose edge snaps to the image',
  'object-selection': 'Select the object inside a rectangle or lasso',
  'quick-selection': 'Paint a selection that grows to the edges',
  'magic-wand': 'Select areas of similar color',
  crop: 'Crop and straighten the image',
  'perspective-crop': 'Crop and correct perspective at the same time',
  slice: 'Divide the image into slices for export',
  'slice-select': 'Select, move and edit slices',
  frame: 'Draw frames that mask placed images',
  eyedropper: 'Pick the foreground color from the image (Alt: background)',
  'color-sampler': 'Place up to ten color readouts in the Info panel',
  ruler: 'Measure distances and angles; straighten the image',
  count: 'Count objects by clicking them',
  note: 'Attach text notes to the canvas',
  'spot-healing': 'Remove spots by painting over them',
  'healing-brush': 'Paint with sampled texture matched to the surrounding light (Alt-click a source)',
  patch: 'Repair a selected area from another area',
  'context-move': 'Move or extend a selection and fill where it was',
  'remove-tool': 'Paint over distractions to remove them',
  'red-eye': 'Remove red eye from flash photos',
  brush: 'Paint with the foreground color',
  pencil: 'Paint hard-edged strokes',
  'color-replacement': 'Replace a color while keeping the texture',
  'mixer-brush': 'Paint that mixes with the colors on the canvas',
  'clone-stamp': 'Paint with pixels sampled from another area (Alt-click a source)',
  'pattern-stamp': 'Paint with a pattern',
  'history-brush': 'Paint back pixels from an earlier history state',
  'art-history': 'Paint stylized strokes from an earlier history state',
  eraser: 'Erase to transparency, or to the background color on a background',
  'background-eraser': 'Erase the sampled color while keeping the edges of the foreground',
  'magic-eraser': 'Erase areas of similar color with one click',
  gradient: 'Fill with a gradient by dragging',
  bucket: 'Fill similar colored areas with the foreground color or a pattern',
  'blur-tool': 'Soften areas by painting',
  'sharpen-tool': 'Sharpen areas by painting',
  'smudge-tool': 'Smear paint as if with a finger',
  dodge: 'Lighten areas by painting',
  burn: 'Darken areas by painting',
  sponge: 'Change the saturation of areas by painting',
  pen: 'Draw paths and shapes with anchor points and curves',
  'freeform-pen': 'Draw paths freehand',
  'curvature-pen': 'Draw smooth paths by clicking points on the curve',
  'add-anchor': 'Add anchor points to a path',
  'delete-anchor': 'Remove anchor points from a path',
  'convert-point': 'Switch anchor points between smooth and corner',
  type: 'Add horizontal text',
  'type-vertical': 'Add vertical text',
  'type-mask': 'Make a selection in the shape of horizontal text',
  'type-mask-vertical': 'Make a selection in the shape of vertical text',
  'path-select': 'Select and move whole paths and shapes',
  'direct-select': 'Select and move anchor points and segments',
  'rect-shape': 'Draw rectangles (Shift for squares)',
  'ellipse-shape': 'Draw ellipses (Shift for circles)',
  'triangle-shape': 'Draw triangles',
  'polygon-shape': 'Draw polygons and stars',
  'line-shape': 'Draw lines and arrows',
  'custom-shape': 'Draw shapes from the shape library',
  hand: 'Pan the view (or hold Space with any tool)',
  'rotate-view': 'Rotate the view without changing the image',
  zoom: 'Zoom in by clicking or dragging (Alt zooms out)',
};
/** The toolbar tooltip of a tool: name, key and what it does. */
export function toolTitle(t: { id: string; label: string; key?: string }) {
  const key = t.key ? ` (${t.key.toUpperCase()})` : '';
  return `${t.label}${key}${toolTips[t.id] ? `\n${toolTips[t.id]}` : ''}`;
}
/** Keep every control in the options bar titled, however a tool renders it. */
export function watchOptionTips(root: HTMLElement) {
  applyOptionTips(root);
  new MutationObserver(() => applyOptionTips(root)).observe(root, { childList: true, subtree: true });
}
/** Give every control in `root` without a title a helpful one. */
export function applyOptionTips(root: HTMLElement) {
  for (const c of root.querySelectorAll<HTMLElement>('input:not([type=hidden]),select,button,textarea,[role=slider]')) {
    const label = c.closest('label');
    if (c.title || label?.title) continue;
    const command = c.dataset.command ? commands.get(c.dataset.command) : undefined;
    let tip = tips[c.id];
    if (!tip && command) {
      const keys = formatShortcut(command.shortcut);
      tip = `${command.label.replace(/…$/, '')}${keys ? ` (${keys})` : ''}${command.description ? `: ${command.description}` : ''}`;
    }
    // A label's own words, without the option texts of a select inside it.
    const words = label ? [...label.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(' ') : '';
    tip ??= (c.getAttribute('aria-label') || words || c.textContent || '').replace(/\s+/g, ' ').trim();
    if (tip) (label ?? c).title = tip;
  }
}
