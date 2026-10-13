/** Original icons for the generative features (24px grid, 2px strokes, currentColor). */
import { registerIcons } from '../../ui/icons.js';

/** A four-pointed spark centered at cx, cy. */
const spark = (cx, cy, r) => {
  const a = +(r * 0.2).toFixed(2);
  const b = +(r * 0.8).toFixed(2);
  return ['path', { d: `M${cx} ${cy - r}q${a} ${b} ${r} ${r}q-${b} ${a} -${r} ${r}q-${a} -${b} -${r} -${r}q${b} -${a} ${r} -${r}z`, 'stroke-width': '1.5' }];
};

export function registerGenerativeIcons() {
  registerIcons({
    // A Bezier curve with its handle, and a spark.
    'gen-vectors': [['path', { d: 'M3 20C5 11 10 9 14 12' }], ['path', { d: 'M14 12h6', 'stroke-width': '1.5' }], ['rect', { x: '12.5', y: '10.5', width: '3', height: '3' }], spark(18, 6, 3.5)],
    // A blob shape with stripes inside it.
    'gen-shape-fill': [['path', { d: 'M5 8c0-3 4-5 7-4s7 1 7 5-2 9-7 10-7-2-7-5 0-3 0-6z' }], ['path', { d: 'M8 9l5 9M11 6l6 10', 'stroke-width': '1.5' }]],
    // A tile of repeated motifs.
    'gen-pattern': [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }], ['circle', { cx: '8', cy: '8', r: '2' }], ['circle', { cx: '16', cy: '16', r: '2' }], ['path', { d: 'M14 6l4 4M6 14l4 4', 'stroke-width': '1.5' }]],
    // Three swatches fanned with a spark.
    'gen-recolor': [['rect', { x: '3', y: '9', width: '6', height: '12', rx: '1' }], ['path', { d: 'M9 19l5-9 3 1.5' }], ['path', { d: 'M9 21h11v-5' }], spark(17, 5, 3)],
    // Lines of text with a spark.
    'gen-text': [['path', { d: 'M3 6h10M3 11h14M3 16h9M3 21h12' }], spark(19, 6, 3)],
    // A clock face made of a stack of cards.
    'gen-history': [['rect', { x: '6', y: '3', width: '15', height: '15', rx: '2' }], ['path', { d: 'M3 7v12a2 2 0 0 0 2 2h12' }], ['path', { d: 'M13.5 7v4l2.5 2', 'stroke-width': '1.5' }]],
    // A figure over a checkered (transparent) background.
    'gen-remove-bg': [['path', { d: 'M3 3h4v4H3zM11 3h4v4h-4zM7 7h4v4H7zM3 11h4v4H3z', fill: 'currentColor', stroke: 'none', opacity: '0.45' }], ['circle', { cx: '15', cy: '11', r: '3' }], ['path', { d: 'M9 21c0-4 3-6 6-6s6 2 6 6' }]],
    // A light bulb with a spark for prompt ideas.
    'gen-idea': [['path', { d: 'M9 18h6M10 21h4' }], ['path', { d: 'M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3z' }]],
  });
}
