// Icons: Lucide (ISC) for general glyphs plus original glyphs for music
// controls, drawn on Lucide's 24px grid with 2px strokes so they sit together.
// icon(name) returns an aria-hidden inline SVG; its button carries the name.

import {
  createElement,
  Activity, ArrowDown, ArrowLeftRight, ArrowUp, AudioWaveform, Blend, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  CircleHelp, Clipboard, ClipboardPaste, Cloud, CloudOff, Copy, Cpu, Dices, Download, Ellipsis, EllipsisVertical, Eraser, FileAudio,
  FileMusic, FilePlus, FlipHorizontal, Folder, FolderOpen, Gauge, GripVertical, HardDrive, Headphones, History, Info, Keyboard, Layers,
  Library, Link, ListMusic, Lock, LogIn, LogOut, Magnet, Maximize2, Menu, Mic, Minimize2, Minus, Monitor, Moon, MousePointer2, Music,
  Package, Paintbrush, Palette, Pencil, Pin, Plus, Power, Redo2, RefreshCw, Repeat, Save, Scissors, Search, Settings, Shuffle,
  SlidersHorizontal, SlidersVertical, Sparkles, SquareDashedMousePointer, Star, Sun, Tag, Timer, Trash2, TriangleAlert, Type, Undo2,
  Unlock, Upload, User, Volume2, VolumeX, WandSparkles, Waves, X, ZoomIn, ZoomOut,
} from 'lucide';

const LUCIDE_SET = {
  Activity, ArrowDown, ArrowLeftRight, ArrowUp, AudioWaveform, Blend, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  CircleHelp, Clipboard, ClipboardPaste, Cloud, CloudOff, Copy, Cpu, Dices, Download, Ellipsis, EllipsisVertical, Eraser, FileAudio,
  FileMusic, FilePlus, FlipHorizontal, Folder, FolderOpen, Gauge, GripVertical, HardDrive, Headphones, History, Info, Keyboard, Layers,
  Library, Link, ListMusic, Lock, LogIn, LogOut, Magnet, Maximize2, Menu, Mic, Minimize2, Minus, Monitor, Moon, MousePointer2, Music,
  Package, Paintbrush, Palette, Pencil, Pin, Plus, Power, Redo2, RefreshCw, Repeat, Save, Scissors, Search, Settings, Shuffle,
  SlidersHorizontal, SlidersVertical, Sparkles, SquareDashedMousePointer, Star, Sun, Tag, Timer, Trash2, TriangleAlert, Type, Undo2,
  Unlock, Upload, User, Volume2, VolumeX, WandSparkles, Waves, X, ZoomIn, ZoomOut,
};

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Za-z])([0-9])/g, '$1-$2').toLowerCase();
const LUCIDE = Object.fromEntries(Object.entries(LUCIDE_SET).map(([k, v]) => [kebab(k), v]));

const fill = (d) => ['path', { d, fill: 'currentColor', stroke: 'none' }];
const rect = (x, y, w, hgt, rx = 1) => ['rect', { x: String(x), y: String(y), width: String(w), height: String(hgt), rx: String(rx) }];
const frect = (x, y, w, hgt, rx = 0.5) => ['rect', { x: String(x), y: String(y), width: String(w), height: String(hgt), rx: String(rx), fill: 'currentColor', stroke: 'none' }];

// Original glyphs.
const ORIGINAL = {
  // Transport.
  'transport-play': [fill('M7 4.5v15l12-7.5z')],
  'transport-pause': [fill('M6.5 5h4v14h-4zM13.5 5h4v14h-4z')],
  'transport-stop': [fill('M6 6h12v12H6z')],
  'transport-record': [['circle', { cx: '12', cy: '12', r: '6.5', fill: 'currentColor', stroke: 'none' }]],
  'transport-loop': [['path', { d: 'M17 2.5 20.5 6 17 9.5' }], ['path', { d: 'M3.5 11V9.5A3.5 3.5 0 0 1 7 6h13.5' }], ['path', { d: 'M7 21.5 3.5 18 7 14.5' }], ['path', { d: 'M20.5 13v1.5A3.5 3.5 0 0 1 17 18H3.5' }]],
  metronome: [['path', { d: 'M8.5 3h7l4 18h-15z', 'stroke-linejoin': 'round' }], ['path', { d: 'M12 16 17 6' }], ['path', { d: 'M6 17h12' }]],
  countin: [['path', { d: 'M4 19V9M9 19V5M14 19v-7M19 19V9' }]],
  'tap-tempo': [['path', { d: 'M9 11V5.5a1.5 1.5 0 0 1 3 0V10' }], ['path', { d: 'M12 10V8.5a1.5 1.5 0 0 1 3 0V11' }], ['path', { d: 'M15 11v-.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.5a6 6 0 0 1-5-2.7L5 15.5a1.6 1.6 0 0 1 2.5-2L9 15v-4' }]],
  // Windows.
  'win-playlist': [rect(2.5, 4, 19, 16, 1.5), ['path', { d: 'M2.5 9.5h19M2.5 15h19' }], frect(5, 6, 6, 2), frect(12, 11.5, 7, 2), frect(7, 17, 5, 1.5)],
  'win-rack': [rect(2.5, 4, 19, 16, 1.5), frect(5, 7, 3, 3), frect(10.5, 7, 3, 3), frect(16, 7, 3, 3), frect(5, 14, 3, 3), ['rect', { x: '10.5', y: '14', width: '3', height: '3', rx: '.5' }], frect(16, 14, 3, 3)],
  'win-piano': [rect(2.5, 4, 19, 16, 1.5), ['path', { d: 'M7 4v16M2.5 8h4.5M2.5 12h4.5M2.5 16h4.5' }], frect(9, 7, 4, 2), frect(13.5, 11, 5, 2), frect(10.5, 15, 3, 2)],
  'win-mixer': [['path', { d: 'M5 3v18M12 3v18M19 3v18' }], frect(2.5, 13, 5, 3, 1), frect(9.5, 7, 5, 3, 1), frect(16.5, 15, 5, 3, 1)],
  'win-browser': [rect(2.5, 4, 19, 16, 1.5), ['path', { d: 'M9 4v16' }], ['path', { d: 'M4.5 8h2.5M4.5 11.5h2.5M4.5 15h2.5' }]],
  // Editing tools.
  'tool-draw': [['path', { d: 'M15.5 4.5l4 4L9 19H5v-4z', 'stroke-linejoin': 'round' }], ['path', { d: 'M13 7l4 4' }]],
  'tool-paint': [['path', { d: 'M4 20c2.5 0 4-1.5 4-3.5a2.5 2.5 0 0 0-5 0c0 1-.5 2.5-1 3.5z' }], ['path', { d: 'M8.5 14 19 3.5l1.5 1.5L10 15.5' }]],
  'tool-delete': [['path', { d: 'M8 20h12' }], ['path', { d: 'M5.5 15.5 14 7l5 5-6.5 6.5H8.5z', 'stroke-linejoin': 'round' }], ['path', { d: 'M10 11l5 5' }]],
  'tool-mute': [rect(3, 6, 18, 12, 2), ['path', { d: 'M7 15V9l2.5 3L12 9v6' }], ['path', { d: 'M15 9.5l3.5 5M18.5 9.5 15 14.5' }]],
  'tool-slice': [['path', { d: 'M12 2v20', 'stroke-dasharray': '2.5 2' }], rect(3, 8, 7, 8, 1.5), rect(14, 8, 7, 8, 1.5)],
  'tool-select': [['rect', { x: '3', y: '3', width: '14', height: '14', rx: '1', 'stroke-dasharray': '2.5 2' }], fill('M12 11l9 3.5-3.8 1.3L15.5 20z')],
  'tool-zoom': [['circle', { cx: '10.5', cy: '10.5', r: '6' }], ['path', { d: 'm15 15 5.5 5.5M8 10.5h5M10.5 8v5' }]],
  'tool-play': [['path', { d: 'M4 12h3' }], fill('M10 6v12l9-6z')],
  // Instruments.
  synth: [['path', { d: 'M2 12c1.5-6 3.5-6 5 0s3.5 6 5 0 3.5-6 5 0 3 5 5 2' }]],
  drum: [['ellipse', { cx: '12', cy: '9', rx: '8', ry: '3' }], ['path', { d: 'M4 9v6c0 1.7 3.6 3 8 3s8-1.3 8-3V9' }], ['path', { d: 'M8 11.6v6M16 11.6v6' }]],
  sampler: [rect(3, 5, 18, 14, 2), ['path', { d: 'M6 12h1.5M8.5 9v6M11 7.5v9M13.5 10v4M16 9v6M18 12h.5' }]],
  audio: [['path', { d: 'M3 12h2M6.5 8v8M10 5v14M13.5 9v6M17 7v10M20.5 11v2' }]],
  // Misc.
  fx: [['path', { d: 'M9 20c2 0 2-2 2.5-5l1.5-7c.5-2.5 1-4 3-4' }], ['path', { d: 'M7 10h7' }], ['path', { d: 'm15 13 5 6M20 13l-5 6' }]],
  pattern: [rect(3, 3, 8, 8, 1.5), rect(13, 3, 8, 8, 1.5), rect(3, 13, 8, 8, 1.5), frect(13, 13, 8, 8, 1.5)],
  'pattern-song': [rect(2.5, 6, 8, 5, 1), rect(12.5, 6, 9, 5, 1), rect(6, 14, 11, 5, 1)],
  automation: [['path', { d: 'M3 18 8 9l5 6 4-9 4 4' }], ['circle', { cx: '8', cy: '9', r: '1.5', fill: 'currentColor' }], ['circle', { cx: '13', cy: '15', r: '1.5', fill: 'currentColor' }], ['circle', { cx: '17', cy: '6', r: '1.5', fill: 'currentColor' }]],
  quantize: [['path', { d: 'M4 4v16M10 4v16M16 4v16' }], frect(5.5, 7, 3, 3), frect(11.5, 13, 3, 3), frect(17, 9, 3, 3)],
  chord: [frect(4, 5, 10, 3, 1), frect(7, 10.5, 10, 3, 1), frect(10, 16, 10, 3, 1)],
  legato: [frect(3, 13, 6, 3, 1), frect(9, 9, 6, 3, 1), frect(15, 5, 6, 3, 1)],
  'piano-keys': [rect(3, 4, 18, 16, 1.5), ['path', { d: 'M9 20v-6M15 20v-6' }], frect(7.5, 4, 3, 10), frect(13.5, 4, 3, 10)],
  'cpu-meter': [rect(3, 7, 18, 10, 2), frect(5, 9, 8, 6, 1)],
  'snap-grid': [['path', { d: 'M4 4v16M9.5 4v16M15 4v16M20.5 4v16', 'stroke-width': '1.5' }], ['path', { d: 'M4 12h16.5' }]],
  'send-route': [['circle', { cx: '6', cy: '12', r: '3' }], ['circle', { cx: '18', cy: '6', r: '3' }], ['circle', { cx: '18', cy: '18', r: '3' }], ['path', { d: 'M8.6 10.5 15.4 7.5M8.6 13.5l6.8 3' }]],
};

/** Feature modules add glyphs here (Lucide node format) without editing this file. */
export function registerIcons(map) {
  Object.assign(ORIGINAL, map);
}

export function icon(name, size = 16, extraClass = '') {
  if (name === 'github') return githubMark(size, extraClass);
  const node = ORIGINAL[name] || LUCIDE[name] || LUCIDE['square-dashed-mouse-pointer'];
  const el = createElement(node);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  el.setAttribute('class', `icon${extraClass ? ` ${extraClass}` : ''}`);
  return el;
}

// GitHub's mark, used only to link to this project's repository.
const GITHUB_PATH = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z';

function githubMark(size, extraClass) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon${extraClass ? ` ${extraClass}` : ''}`);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', GITHUB_PATH);
  svg.append(path);
  return svg;
}

export function hasIcon(name) {
  return name === 'github' || Boolean(ORIGINAL[name] || LUCIDE[name]);
}

/** The app icon (public/app-icon.png). Decorative like the glyphs above. */
export function appIcon(size = 24, extraClass = '') {
  const el = document.createElement('img');
  el.src = './app-icon.png';
  el.alt = '';
  el.width = size;
  el.height = size;
  el.decoding = 'async';
  el.draggable = false;
  el.className = `app-icon${extraClass ? ` ${extraClass}` : ''}`;
  return el;
}
