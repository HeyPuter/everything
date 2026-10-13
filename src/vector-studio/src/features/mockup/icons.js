/** Original icons for mockups, font matching and image expansion (24px grid, 2px strokes, currentColor). */
import { registerIcons } from '../../ui/icons.js';

export function registerMockupIcons() {
  registerIcons({
    // A photo frame with a tilted card (the art) sitting on it.
    mockup: [['rect', { x: '2', y: '4', width: '20', height: '16', rx: '2' }], ['path', { d: 'M7 9.5l8.5-1.5 1.5 6.5-8.5 1.5z', 'stroke-width': '1.5' }]],
    // Corner brackets around a quad: finding a surface.
    'mockup-detect': [['path', { d: 'M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4' }], ['path', { d: 'M8 9l8-1 1 7-9 1z', 'stroke-width': '1.5' }]],
    // A capital A with a magnifier: which font is this?
    'match-font': [['path', { d: 'M3 18L8.5 4h1L15 18M5.2 13h7.6' }], ['circle', { cx: '17.5', cy: '15.5', r: '3' }], ['path', { d: 'M19.7 17.7L22 20' }]],
    // An image with arrows pushing its edges outward.
    'expand-image': [['rect', { x: '7', y: '7', width: '10', height: '10', rx: '1' }], ['path', { d: 'M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6', 'stroke-width': '1.5' }], ['path', { d: 'M9 15l2-2.5 1.5 1.5 1.5-2 1 3', 'stroke-width': '1.5' }]],
    // A page with its bleed edge dashed around it.
    'fill-bleed': [['rect', { x: '6', y: '6', width: '12', height: '12', rx: '1' }], ['path', { d: 'M2.5 2.5h19v19h-19z', 'stroke-dasharray': '2.5 2.5', 'stroke-width': '1.5' }]],
  });
}
