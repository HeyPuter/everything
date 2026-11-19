// Icons: Lucide (ISC) for general glyphs plus original glyphs for audio-specific
// controls, drawn on Lucide's 24px grid with 2px strokes so they sit together.
// icon(name) returns an aria-hidden inline SVG; its button carries the name.

import {
  createElement,
  Activity,
  CornerDownRight,
  FolderPlus,
  ListFilter,
  ListPlus,
  ArrowDown,
  ArrowUp,
  AudioLines,
  AudioWaveform,
  Bandage,
  Bookmark,
  BookmarkPlus,
  Brush,
  ChartColumn,
  ChartSpline,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  Circle,
  CircleAlert,
  CircleHelp,
  Clipboard,
  ClipboardPaste,
  Clock,
  Cloud,
  Copy,
  Crop,
  Download,
  Ear,
  Ellipsis,
  EllipsisVertical,
  Eye,
  EyeOff,
  FastForward,
  Film,
  FileAudio,
  FileMusic,
  FilePlus,
  Flag,
  Folder,
  FolderOpen,
  Gauge,
  GripVertical,
  HardDrive,
  Headphones,
  History,
  Info,
  Keyboard,
  Lasso,
  Layers,
  LayoutGrid,
  Link,
  ListMusic,
  Lock,
  LogIn,
  LogOut,
  Magnet,
  Maximize2,
  Menu,
  Mic,
  Minimize2,
  Minus,
  Monitor,
  MonitorPlay,
  Moon,
  Move,
  MoveHorizontal,
  Music,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  Redo2,
  RefreshCw,
  Repeat,
  Rewind,
  RotateCcw,
  Save,
  Scissors,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  Slice,
  SlidersHorizontal,
  SlidersVertical,
  Sparkles,
  Square,
  SquareDashed,
  Star,
  Sun,
  TextCursor,
  Trash2,
  TriangleAlert,
  Undo2,
  Unlock,
  Upload,
  User,
  VideoOff,
  Volume2,
  VolumeX,
  WandSparkles,
  Waves,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide';

const LUCIDE_SET = {
  Activity, CornerDownRight, FolderPlus, ListFilter, ListPlus, ArrowDown, ArrowUp, AudioLines, AudioWaveform, Bandage, Bookmark, BookmarkPlus, Brush, ChartColumn, ChartSpline, Check,
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsLeft, ChevronsRight, Circle, CircleAlert, CircleHelp,
  Clipboard, ClipboardPaste, Clock, Cloud, Copy, Crop, Download, Ear, Ellipsis, EllipsisVertical, Eye, EyeOff,
  FastForward, FileAudio, FileMusic, FilePlus, Flag, Folder, FolderOpen, Gauge, GripVertical, HardDrive, Headphones,
  History, Info, Keyboard, Lasso, Layers, LayoutGrid, Link, ListMusic, Lock, LogIn, LogOut, Magnet, Maximize2, Menu,
  Mic, Minimize2, Minus, Monitor, Moon, Move, MoveHorizontal, Music, PanelBottom, PanelLeft, PanelRight, Pause,
  Pencil, Play, Plus, Power, Redo2, RefreshCw, Repeat, Rewind, RotateCcw, Save, Scissors, Search, Settings, SkipBack,
  SkipForward, Slice, SlidersHorizontal, SlidersVertical, Sparkles, Square, SquareDashed, Star, Sun, TextCursor,
  Trash2, TriangleAlert, Undo2, Unlock, Upload, User, Volume2, VolumeX, WandSparkles, Waves, X, ZoomIn, ZoomOut,
  Film, MonitorPlay, VideoOff,
};

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Za-z])([0-9])/g, '$1-$2').toLowerCase();
const LUCIDE = Object.fromEntries(Object.entries(LUCIDE_SET).map(([k, v]) => [kebab(k), v]));

const fill = (d) => ['path', { d, fill: 'currentColor', stroke: 'none' }];

// Original glyphs.
const ORIGINAL = {
  // Editor modes.
  'mode-waveform': [['rect', { x: '2.5', y: '4.5', width: '19', height: '15', rx: '1.5' }], ['path', { d: 'M5 12h2M8 9v6M10.5 7v10M13 10v4M15.5 8v8M18 11v2' }]],
  'mode-multitrack': [['rect', { x: '2.5', y: '4.5', width: '19', height: '15', rx: '1.5' }], ['path', { d: 'M2.5 12h19' }], ['path', { d: 'M5 8.5h7M9 15.5h9' }]],
  // Spectral views.
  'spectral-frequency': [['rect', { x: '2.5', y: '4.5', width: '19', height: '15', rx: '1.5' }], ['path', { d: 'M5 16h3M5 13h6M5 10h4M5 7h2M12 16h5M13 13h6M14 10h3' }]],
  'spectral-pitch': [['rect', { x: '2.5', y: '4.5', width: '19', height: '15', rx: '1.5' }], ['path', { d: 'M5 15c2 0 2-5 4-5s2 3 4 3 2-6 4-6 1.5 2 2 2' }]],
  // Transport.
  'transport-stop': [fill('M6 6h12v12H6z')],
  'transport-play': [fill('M7 4.5v15l12-7.5z')],
  'transport-pause': [fill('M6.5 5h4v14h-4zM13.5 5h4v14h-4z')],
  'transport-record': [['circle', { cx: '12', cy: '12', r: '6.5', fill: 'currentColor', stroke: 'none' }]],
  'transport-start': [fill('M5 5h2.5v14H5z'), fill('M19 5v14L8.5 12z')],
  'transport-end': [fill('M16.5 5H19v14h-2.5z'), fill('M5 5v14l10.5-7z')],
  'transport-rewind': [fill('M12 6v12l-9-6z'), fill('M21 6v12l-9-6z')],
  'transport-forward': [fill('M3 6v12l9-6z'), fill('M12 6v12l9-6z')],
  'transport-loop': [['path', { d: 'M17 2.5 20.5 6 17 9.5' }], ['path', { d: 'M3.5 11V9.5A3.5 3.5 0 0 1 7 6h13.5' }], ['path', { d: 'M7 21.5 3.5 18 7 14.5' }], ['path', { d: 'M20.5 13v1.5A3.5 3.5 0 0 1 17 18H3.5' }]],
  'transport-skip-selection': [['path', { d: 'M3 12h4M17 12h4' }], ['path', { d: 'M9 7v10M15 7v10' }], ['path', { d: 'm18 9 3 3-3 3' }]],
  // Zoom family: a magnifier with an axis cue.
  'zoom-in-amp': [['circle', { cx: '13', cy: '11', r: '5' }], ['path', { d: 'm16.5 14.5 4 4M11 11h4M13 9v4' }], ['path', { d: 'M4 4v16M2.5 5.5 4 4l1.5 1.5M2.5 18.5 4 20l1.5-1.5' }]],
  'zoom-out-amp': [['circle', { cx: '13', cy: '11', r: '5' }], ['path', { d: 'm16.5 14.5 4 4M11 11h4' }], ['path', { d: 'M4 4v16M2.5 5.5 4 4l1.5 1.5M2.5 18.5 4 20l1.5-1.5' }]],
  'zoom-in-time': [['circle', { cx: '11', cy: '13', r: '5' }], ['path', { d: 'm14.5 16.5 4 4M9 13h4M11 11v4' }], ['path', { d: 'M3 4h18M4.5 2.5 3 4l1.5 1.5M19.5 2.5 21 4l-1.5 1.5' }]],
  'zoom-out-time': [['circle', { cx: '11', cy: '13', r: '5' }], ['path', { d: 'm14.5 16.5 4 4M9 13h4' }], ['path', { d: 'M3 4h18M4.5 2.5 3 4l1.5 1.5M19.5 2.5 21 4l-1.5 1.5' }]],
  // Brackets at both ends: the whole length in view.
  'zoom-full': [['circle', { cx: '11.5', cy: '10.5', r: '4.5' }], ['path', { d: 'm14.8 13.8 3 3' }], ['path', { d: 'M3 5v13M2 5h2M2 18h2M21 5v13M20 5h2M20 18h2' }]],
  'zoom-selection': [['circle', { cx: '12', cy: '11', r: '5' }], ['path', { d: 'm15.5 14.5 4.5 4.5' }], ['path', { d: 'M4 6v10M3 6h2M3 16h2' }]],
  'zoom-in-point': [['path', { d: 'M5 4c-2 2-2 14 0 16' }], ['circle', { cx: '13', cy: '11', r: '5' }], ['path', { d: 'm16.5 14.5 4 4' }]],
  'zoom-out-point': [['path', { d: 'M19 4c2 2 2 14 0 16' }], ['circle', { cx: '10', cy: '11', r: '5' }], ['path', { d: 'm13.5 14.5 4 4' }]],
  // Tools.
  'tool-move': [fill('M4 3.5 15 9l-4.6 1.3-2 4.6z'), ['path', { d: 'M16 13v8M12 17h8M14.5 14.5 16 13l1.5 1.5M14.5 19.5 16 21l1.5-1.5M13.5 15.5 12 17l1.5 1.5M18.5 15.5 20 17l-1.5 1.5' }]],
  // A craft knife: a wedge blade on a short handle.
  'tool-razor': [['path', { d: 'M21 3 15 13.5 10.5 9z', 'stroke-linejoin': 'round' }], ['path', { d: 'M10.5 9 15 13.5 8 20.5 3.5 16z', 'stroke-linejoin': 'round' }], ['path', { d: 'm8.5 13.5 2 2' }]],
  'tool-slip': [['path', { d: 'M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3' }], ['path', { d: 'M9 6v12M15 6v12' }]],
  'tool-time': [['path', { d: 'M12 4v16M9 4h6M9 20h6' }]],
  'tool-marquee': [['rect', { x: '4', y: '5', width: '16', height: '14', 'stroke-dasharray': '2.5 2' }]],
  'tool-lasso': [['path', { d: 'M7 17c-3-1.5-4.5-4-3.5-7C5 5 11 3 16 4.5S22 10 20 13s-7 4-11 4' }], ['path', { d: 'M7 17c-1 1.5-.5 3.5 1.5 4' }], ['circle', { cx: '7', cy: '17', r: '1.5' }]],
  'tool-brush': [['path', { d: 'M18.5 3.5 10 12' }], ['path', { d: 'M10 12c-2-1-4.5 0-5 2.5S4 19 3 20.5c2.5.5 6 .5 7.5-1.5s1.5-4-.5-7z', 'stroke-linejoin': 'round' }]],
  'tool-heal': [['rect', { x: '2', y: '8', width: '20', height: '8', rx: '4', transform: 'rotate(-45 12 12)' }], ['path', { d: 'M10.5 10.5h.01M13.5 13.5h.01M13.5 10.5h.01M10.5 13.5h.01' }]],
  // Misc.
  'fx': [['path', { d: 'M9 20c2 0 2-2 2.5-5l1.5-7c.5-2.5 1-4 3-4' }], ['path', { d: 'M7 10h7' }], ['path', { d: 'm15 13 5 6M20 13l-5 6' }]],
  'mute': [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '3' }], ['path', { d: 'M8 16V8l4 5 4-5v8' }]],
  'solo': [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '3' }], ['path', { d: 'M15 8.5c-.5-1-1.5-1.5-3-1.5-2 0-3 1-3 2.3 0 3 6 1.7 6 4.7 0 1.3-1 2.5-3 2.5-1.5 0-2.8-.6-3.2-1.7' }]],
  'arm': [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '3' }], ['path', { d: 'M9 17V7h3.5a3 3 0 0 1 0 6H9M12.5 13l3 4' }]],
  'monitor-input': [['path', { d: 'M4 14v-2a8 8 0 0 1 16 0v2' }], ['rect', { x: '3', y: '14', width: '4', height: '6', rx: '1' }], ['rect', { x: '17', y: '14', width: '4', height: '6', rx: '1' }]],
  'fade-in': [['path', { d: 'M3 20C9 19 15 12 21 4' }], ['path', { d: 'M3 20h18' }]],
  'fade-out': [['path', { d: 'M3 4c6 8 12 15 18 16' }], ['path', { d: 'M3 20h18' }]],
  'normalize': [['path', { d: 'M3 5h18M3 19h18' }], ['path', { d: 'M5 12h2M8 9v6M11 6.5v11M14 8v8M17 10v4M20 12h1' }]],
  'marker-add': [['path', { d: 'M6 3v18' }], fill('M6 4h10l-3 4 3 4H6z'), ['path', { d: 'M16 17h6M19 14v6' }]],
};

/** Feature modules add glyphs here (Lucide node format) without editing this file. */
export function registerIcons(map) {
  Object.assign(ORIGINAL, map);
}

export function icon(name, size = 16, extraClass = '') {
  const node = ORIGINAL[name] || LUCIDE[name] || LUCIDE['square-dashed'];
  const el = createElement(node);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  el.setAttribute('class', `icon${extraClass ? ` ${extraClass}` : ''}`);
  if (size !== 16) el.style.setProperty('--icon-size', `${size}px`);
  return el;
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

export function hasIcon(name) {
  return Boolean(ORIGINAL[name] || LUCIDE[name]);
}

export const ICON_NAMES = () => [...Object.keys(ORIGINAL), ...Object.keys(LUCIDE)];
