/**
 * Icons for the utility panels: Lucide glyphs where one fits, plus original
 * glyphs on the same 24px grid with 2px strokes.
 */
import { History, ListVideo, Link2, FileText, WandSparkles, Play, Square, Camera, FolderPlus, FilePlus, RefreshCw, Crosshair, ExternalLink, FileInput, FileOutput, ListPlus, Settings2, LayoutGrid, Rows3, StepForward, Undo2, Redo2, Images, SwatchBook, ArrowDownToLine, CopyPlus, Menu, TriangleAlert } from 'lucide';
import { registerIcons } from '../../ui/icons.js';

const P = (d, extra = {}) => ['path', { d, ...extra }];
const C = (cx, cy, r, extra = {}) => ['circle', { cx: String(cx), cy: String(cy), r: String(r), ...extra }];
const R = (x, y, w, h, extra = {}) => ['rect', { x: String(x), y: String(y), width: String(w), height: String(h), ...extra }];

export function registerPanelIcons() {
  registerIcons({
    'panel-history': History,
    'link-missing': TriangleAlert,
    'panel-actions': ListVideo,
    'panel-links': Link2,
    'panel-document-info': FileText,
    'panel-magic-wand': WandSparkles,
    play: Play,
    stop: Square,
    camera: Camera,
    'folder-plus-2': FolderPlus,
    'file-plus-2': FilePlus,
    'refresh-cw-2': RefreshCw,
    'go-to': Crosshair,
    'external-link': ExternalLink,
    'file-input': FileInput,
    'file-output': FileOutput,
    'list-plus': ListPlus,
    'settings-2': Settings2,
    'view-buttons': LayoutGrid,
    'view-list': Rows3,
    'step-forward': StepForward,
    'step-back': Undo2,
    'step-ahead': Redo2,
    images: Images,
    'swatch-book': SwatchBook,
    'arrow-down-to-line': ArrowDownToLine,
    'copy-plus': CopyPlus,
    'panel-menu': Menu,
    // Original glyphs.
    record: [C(12, 12, 6, { fill: 'currentColor' })],
    'panel-attributes': [R(4, 4, 16, 16, { rx: '2' }), C(12, 12, 1.5, { fill: 'currentColor' }), P('M12 4v3M12 17v3M4 12h3M17 12h3')],
    'panel-color-guide': [C(12, 12, 8), P('M12 4v8l6.9 4M12 12l-6.9 4'), C(12, 12, 2.5, { fill: 'currentColor' })],
    'panel-asset-export': [R(3, 9, 9, 9, { rx: '1.5' }), R(7, 5, 9, 9, { rx: '1.5' }), P('M15 3h6v6M21 3l-7 7')],
    'snapshot-state': [R(4, 6, 16, 13, { rx: '2' }), P('M9 6l1.5-2h3L15 6'), C(12, 12.5, 3)],
    'history-state': [R(6, 3, 12, 18, { rx: '1.5' }), P('M9 8h6M9 12h6M9 16h4')],
    'modal-dialog': [R(3, 5, 18, 14, { rx: '2' }), P('M3 9h18M7 13h6')],
    'center-point': [C(12, 12, 2, { fill: 'currentColor' }), P('M12 3v5M12 16v5M3 12h5M16 12h5')],
    'path-cw': [P('M20 12a8 8 0 1 1-3-6.2'), P('M17 2v4h-4')],
    'path-ccw': [P('M4 12a8 8 0 1 0 3-6.2'), P('M7 2v4h4')],
    'fill-nonzero': [P('M4 4h16v16H4z', { fill: 'currentColor', 'fill-opacity': '0.35' }), R(8, 8, 8, 8, { fill: 'currentColor' })],
    'fill-evenodd': [P('M4 4h16v16H4zM8 8v8h8V8z', { fill: 'currentColor', 'fill-opacity': '0.35', 'fill-rule': 'evenodd' }), R(8, 8, 8, 8)],
    'trim-marks': [P('M7 2v4M2 7h4M17 2v4M22 7h-4M7 22v-4M2 17h4M17 22v-4M22 17h-4'), R(8, 8, 8, 8, { 'stroke-dasharray': '2 2' })],
    'harmony': [C(8, 9, 4), C(16, 9, 4), C(12, 16, 4)],
  });
}
