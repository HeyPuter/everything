/**
 * Icons for the paint panels: Lucide glyphs (ISC) plus original glyphs on
 * the same 24px grid with 2px strokes.
 */
import { Ban, Box, FolderPlus, Folder, Funnel, LayoutGrid, LibraryBig, List, RotateCcw } from 'lucide';
import { registerIcons } from '../../ui/icons.js';

const fill = (d) => ['path', { d, fill: 'currentColor', stroke: 'none' }];

export function registerPaintIcons() {
  registerIcons({
    'web-warning': Box,
    'grid-view': LayoutGrid,
    'list-view': List,
    library: LibraryBig,
    filter: Funnel,
    'folder-plus': FolderPlus,
    folder: Folder,
    ban: Ban,
    'rotate-ccw': RotateCcw,
    'gradient-linear': [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }], fill('M5 3h3v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'), ['path', { d: 'M12 3v18M16 3v18' }]],
    'gradient-radial': [['circle', { cx: '12', cy: '12', r: '9' }], ['circle', { cx: '12', cy: '12', r: '5' }], fill('M12 10a2 2 0 1 1 0 4a2 2 0 0 1 0-4z')],
    'gradient-freeform': [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }], ['path', { d: 'M8.5 9 15.5 8.5 12 15.5z', 'stroke-dasharray': '2 2' }], fill('M8.5 6.5a2.5 2.5 0 1 1 0 5a2.5 2.5 0 0 1 0-5z'), fill('M15.5 6.8a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 0 1 0-3.4z'), fill('M12 13.3a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 0 1 0-4.4z')],
    'stroke-within': [['rect', { x: '4', y: '4', width: '16', height: '16' }], ['path', { d: 'M9 4v16M15 4v16' }]],
    'stroke-along': [['rect', { x: '4', y: '4', width: '16', height: '16' }], ['path', { d: 'M8 8h8v8' }]],
    'stroke-across': [['rect', { x: '4', y: '4', width: '16', height: '16' }], ['path', { d: 'M4 4l4 4M20 4l-4 4M20 20l-4-4M4 20l4-4' }]],
    'dash-exact': [['path', { d: 'M4 21v-4M4 13V9M4 5V3h2M10 3h4M18 3h3' }]],
    'dash-corners': [['path', { d: 'M4 21v-5M4 12V3h9M17 3h4' }]],
    'arrow-beyond': [['path', { d: 'M3 12h11M14 5v14' }], fill('M14 7.5 21 12l-7 4.5z')],
    'arrow-at-end': [['path', { d: 'M3 12h9M20 5v14' }], fill('M12 7.5 19 12l-7 4.5z')],
    'stroke-panel': [['path', { d: 'M4 5h16' }], fill('M4 10h16v3H4z'), fill('M4 16h16v5H4z')],
    'add-stroke': [['rect', { x: '3', y: '3', width: '13', height: '13', rx: '1' }], ['rect', { x: '6.5', y: '6.5', width: '6', height: '6' }], ['path', { d: 'M19 15v6M16 18h6' }]],
    'add-fill': [fill('M4 3h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z'), ['path', { d: 'M19 15v6M16 18h6' }]],
    fx: [['path', { d: 'M6 20c2 0 2.5-1.5 3-5s1-7 2-9 2-2 3-2M6 11h6M15 12l5 7M20 12l-5 7' }]],
    'reduce-basic': [['circle', { cx: '12', cy: '12', r: '8' }], ['path', { d: 'M8 12h8' }]],
    'graphic-styles': [['rect', { x: '3', y: '3', width: '7', height: '7', rx: '1' }], ['rect', { x: '14', y: '3', width: '7', height: '7', rx: '1' }], ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }], fill('M15 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z')],
  });
}
