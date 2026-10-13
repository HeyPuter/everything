/**
 * Icon set: Lucide (ISC) for common glyphs plus a few original glyphs for
 * editing commands Lucide has no match for, drawn on the same 24px grid
 * with 2px strokes.
 */
import {
  createElement, MousePointer2, Hand, Undo2, Redo2, Trash2, Link, Unlink, Snowflake, FlipHorizontal2, FlipVertical2, RotateCw, RotateCcw, Crop, Mic, ZoomIn, ZoomOut, Lock, LockOpen, Eye, EyeOff, Volume2, VolumeX, Play, Pause, Maximize, Minimize, SkipBack, SkipForward, StepBack, StepForward, Film, Music, Type, Sticker, Sparkles, Blend, Aperture, SlidersHorizontal, Captions, Download, Upload, Settings, Keyboard, Sun, Moon, Monitor, Plus, Search, LayoutGrid, List, Ellipsis, Copy, Pencil, ChevronDown, ChevronRight, ChevronLeft, ChevronUp, Gauge, WandSparkles, AudioLines, AudioWaveform, Image, Video, Folder, FolderOpen, Cloud, CloudCheck, CloudOff, LogOut, User, X, Check, Info, RectangleHorizontal, Fullscreen, Scan, Clapperboard, Layers, Square, Circle, Bookmark, Flag, Repeat, Timer, MonitorPlay, CircleHelp, Clock, FileVideo, FileAudio, FileImage, Import, Subtitles, Speech, Languages, Replace, GripVertical, Shapes, Zap, Ratio, AlignCenter, AlignLeft, AlignRight, Bold, Italic, Underline, CaseUpper, PaintBucket, SunMedium, Contrast, Droplet, Thermometer, Scissors, ArrowLeftRight, ArrowLeft, Home, CircleAlert, TriangleAlert, MonitorDown, HardDrive, Share2, PanelLeft, PanelRight, PanelBottom, Wand2, Clipboard, ClipboardPaste, Rewind, FastForward, MoveHorizontal, Radio, Square as StopSquare, Waves, Headphones, Maximize2, Pipette, Palette, Star, ListFilter, ArrowUpDown, FolderPlus, FolderInput, Camera, ScreenShare, ImagePlus, RefreshCw,
} from 'lucide';
import {
  Group, Ungroup, Power, PowerOff, Tag, MapPin, BetweenHorizontalStart, BetweenHorizontalEnd, ArrowUp, ArrowDown, Headset, ArrowRightToLine, ArrowLeftToLine, LayoutDashboard, Rows3, Spline, Ruler, Crosshair, Magnet, LayoutTemplate, Menu, Brackets, Grid3x3, Focus, Diamond, ArrowRight,
} from 'lucide';
import {
  ChartSpline, Highlighter, ScanFace,
} from 'lucide';
import {
  ScrollText, SwitchCamera, Grid2x2, MessageSquare, MessageSquareShare, Reply, CircleCheck, SendHorizontal, Users, UserMinus,
} from 'lucide';
import {
  Heart, Hexagon, PenTool, Brush, Eraser, SquaresUnite, SquaresSubtract, SquaresIntersect, CopyPlus, AlignStartVertical, AlignCenterVertical, AlignEndVertical, AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
} from 'lucide';

// Original glyphs.
const Cutout = [
  ['path', { d: 'M3 7V5a2 2 0 0 1 2-2h2' }],
  ['path', { d: 'M17 3h2a2 2 0 0 1 2 2v2' }],
  ['path', { d: 'M21 17v2a2 2 0 0 1-2 2h-2' }],
  ['path', { d: 'M7 21H5a2 2 0 0 1-2-2v-2' }],
  ['circle', { cx: '12', cy: '9', r: '3' }],
  ['path', { d: 'M6.5 21a5.5 5.5 0 0 1 11 0' }],
];
const Split = [
  ['path', { d: 'M12 3v18' }],
  ['path', { d: 'M8 6H5v12h3' }],
  ['path', { d: 'M16 6h3v12h-3' }],
];
const DeleteLeft = [
  ['path', { d: 'M14 3v18' }],
  ['path', { d: 'M18 7h2v10h-2' }],
  ['path', { d: 'M4 8l6 8' }],
  ['path', { d: 'M10 8l-6 8' }],
];
const DeleteRight = [
  ['path', { d: 'M10 3v18' }],
  ['path', { d: 'M6 7H4v10h2' }],
  ['path', { d: 'M14 8l6 8' }],
  ['path', { d: 'M20 8l-6 8' }],
];
const Keyframe = [['path', { d: 'M12 3.5 20.5 12 12 20.5 3.5 12Z' }]];
const KeyframeAdd = [
  ['path', { d: 'M12 3.5 20.5 12 12 20.5 3.5 12Z' }],
  ['path', { d: 'M12 9v6' }],
  ['path', { d: 'M9 12h6' }],
];
const HoverPreview = [
  ['path', { d: 'M12 2v20' }],
  ['path', { d: 'M3 7h6v10H3z' }],
  ['path', { d: 'M15 7h6v10h-6z' }],
];
const Snapping = [
  ['path', { d: 'M4 4h6v6H4z' }],
  ['path', { d: 'M14 14h6v6h-6z' }],
  ['path', { d: 'M10 7h4v7' }],
  ['path', { d: 'm12 12 2 2 2-2' }],
];
const RippleGap = [
  ['path', { d: 'M3 6h5v12H3z' }],
  ['path', { d: 'M16 6h5v12h-5z' }],
  ['path', { d: 'M14 12h-4' }],
  ['path', { d: 'm12 10-2 2 2 2' }],
];
// Two stacked timelines (strips with a playhead tick).
const Timelines = [
  ['rect', { x: '3', y: '4', width: '18', height: '6', rx: '1.5' }],
  ['rect', { x: '3', y: '14', width: '12', height: '6', rx: '1.5' }],
  ['path', { d: 'M9 4v6' }],
  ['path', { d: 'M7 14v6' }],
];
const TimelinePlus = [
  ['rect', { x: '3', y: '4', width: '18', height: '6', rx: '1.5' }],
  ['rect', { x: '3', y: '14', width: '9', height: '6', rx: '1.5' }],
  ['path', { d: 'M18 14v6' }],
  ['path', { d: 'M15 17h6' }],
];
const ZoomFit = [
  ['path', { d: 'M3 8V5a2 2 0 0 1 2-2h3' }],
  ['path', { d: 'M16 3h3a2 2 0 0 1 2 2v3' }],
  ['path', { d: 'M21 16v3a2 2 0 0 1-2 2h-3' }],
  ['path', { d: 'M8 21H5a2 2 0 0 1-2-2v-3' }],
  ['path', { d: 'M8 12h8' }],
  ['path', { d: 'm10 10-2 2 2 2' }],
  ['path', { d: 'm14 10 2 2-2 2' }],
];
const Transition = [
  ['path', { d: 'M3 5h7v14H3z' }],
  ['path', { d: 'M14 5h7v14h-7z' }],
  ['path', { d: 'm9 9 3 3-3 3' }],
  ['path', { d: 'm15 9-3 3 3 3' }],
];
const DetachAudio = [
  ['path', { d: 'M3 4h18v8H3z' }],
  ['path', { d: 'M5 17v3' }],
  ['path', { d: 'M9 15v7' }],
  ['path', { d: 'M13 17v3' }],
  ['path', { d: 'M17 16v5' }],
];
const Reverse = [
  ['path', { d: 'M19 18 11 12l8-6z' }],
  ['path', { d: 'M11 18 3 12l8-6z' }],
];
const ToStart = [
  ['path', { d: 'M5 5v14' }],
  ['path', { d: 'M19 18 9 12l10-6z' }],
];
const ToEnd = [
  ['path', { d: 'M19 5v14' }],
  ['path', { d: 'M5 18l10-6L5 6z' }],
];

const ICONS = {
  cutout: Cutout,
  highlighter: Highlighter,
  retouch: ScanFace,
  select: MousePointer2, hand: Hand, undo: Undo2, redo: Redo2, trash: Trash2, ripple: RippleGap,
  link: Link, unlink: Unlink, freeze: Snowflake, timelines: Timelines, timelinePlus: TimelinePlus,
  // In this Lucide release the "horizontal" glyph shows a horizontal mirror axis (a vertical flip), so the names are swapped.
  flipH: FlipVertical2, flipV: FlipHorizontal2, rotate: RotateCw,
  rotateLeft: RotateCcw, crop: Crop, mic: Mic, zoomIn: ZoomIn, zoomOut: ZoomOut, lock: Lock, unlock: LockOpen, eye: Eye,
  eyeOff: EyeOff, volume: Volume2, mute: VolumeX, play: Play, pause: Pause, fullscreen: Maximize, exitFullscreen: Minimize,
  skipBack: SkipBack, skipForward: SkipForward, stepBack: StepBack, stepForward: StepForward, film: Film, music: Music,
  text: Type, sticker: Sticker, effects: Sparkles, blend: Blend, filters: Aperture, adjust: SlidersHorizontal,
  captions: Captions, download: Download, upload: Upload, export: Upload, settings: Settings, keyboard: Keyboard, sun: Sun,
  moon: Moon, monitor: Monitor, plus: Plus, search: Search, grid: LayoutGrid, list: List, more: Ellipsis, copy: Copy,
  pencil: Pencil, chevronDown: ChevronDown, chevronRight: ChevronRight, chevronLeft: ChevronLeft, chevronUp: ChevronUp,
  speed: Gauge, magic: WandSparkles, audioLines: AudioLines, waveform: AudioWaveform, image: Image, video: Video,
  folder: Folder, folderOpen: FolderOpen, cloud: Cloud, cloudCheck: CloudCheck, cloudOff: CloudOff, logout: LogOut,
  user: User, close: X, check: Check, info: Info, ratio: Ratio, rect: RectangleHorizontal, fullscreenFit: Fullscreen,
  scan: Scan, clapper: Clapperboard, layers: Layers, square: Square, circle: Circle, bookmark: Bookmark, flag: Flag,
  repeat: Repeat, timer: Timer, monitorPlay: MonitorPlay, help: CircleHelp, clock: Clock, fileVideo: FileVideo,
  fileAudio: FileAudio, fileImage: FileImage, import: Import, subtitles: Subtitles, speech: Speech, languages: Languages,
  replace: Replace, grip: GripVertical, shapes: Shapes, zap: Zap, alignCenter: AlignCenter, alignLeft: AlignLeft,
  alignRight: AlignRight, bold: Bold, italic: Italic, underline: Underline, caseUpper: CaseUpper, fill: PaintBucket,
  brightness: SunMedium, contrast: Contrast, droplet: Droplet, temperature: Thermometer, scissors: Scissors,
  swap: ArrowLeftRight, back: ArrowLeft, home: Home, alert: CircleAlert, warning: TriangleAlert, saveLocal: MonitorDown,
  drive: HardDrive, share: Share2, panelLeft: PanelLeft, panelRight: PanelRight, panelBottom: PanelBottom, wand: Wand2,
  clipboard: Clipboard, paste: ClipboardPaste, rewind: Rewind, fastForward: FastForward, moveH: MoveHorizontal,
  record: Radio, stop: StopSquare, waves: Waves, headphones: Headphones, expand: Maximize2,
  split: Split, deleteLeft: DeleteLeft, deleteRight: DeleteRight, keyframe: Keyframe, keyframeAdd: KeyframeAdd,
  hoverPreview: HoverPreview, snapping: Snapping, zoomFit: ZoomFit, transition: Transition, detachAudio: DetachAudio,
  reverse: Reverse, toStart: ToStart, toEnd: ToEnd,
  pipette: Pipette, palette: Palette,
  star: Star, filter: ListFilter, sort: ArrowUpDown, folderPlus: FolderPlus, folderInput: FolderInput,
  camera: Camera, screen: ScreenShare, imagePlus: ImagePlus, refresh: RefreshCw,
};

// Timeline organizing, layout and player tools.
Object.assign(ICONS, {
  group: Group, ungroup: Ungroup, power: Power, powerOff: PowerOff, tag: Tag, mapPin: MapPin,
  insertAbove: BetweenHorizontalStart, insertBelow: BetweenHorizontalEnd, arrowUp: ArrowUp, arrowDown: ArrowDown,
  solo: Headset, markIn: ArrowRightToLine, markOut: ArrowLeftToLine, layout: LayoutDashboard, rows: Rows3,
  easing: Spline, speedCurve: ChartSpline, ruler: Ruler, crosshair: Crosshair, magnet: Magnet, template: LayoutTemplate, menu: Menu, range: Brackets, gridLines: Grid3x3,
  focus: Focus, diamond: Diamond, reset: RotateCcw, arrowRight: ArrowRight,
});

// Multi-camera clips.
Object.assign(ICONS, { multicam: SwitchCamera, angles: Grid2x2 });

// Mask shapes, mask modes and align-to-frame (original glyphs for the split line and the band).
const MaskSplit = [
  ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
  ['path', { d: 'M3 12h18' }],
  ['path', { d: 'M7 16h2M11 16h2M15 16h2M7 19h10' }],
];
const MaskBand = [
  ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
  ['path', { d: 'M3 9h18M3 15h18' }],
];
Object.assign(ICONS, {
  star: Star, heart: Heart, hexagon: Hexagon, penTool: PenTool, brush: Brush, eraser: Eraser,
  maskSplit: MaskSplit, maskBand: MaskBand, maskAdd: SquaresUnite, maskSubtract: SquaresSubtract,
  maskIntersect: SquaresIntersect, duplicate: CopyPlus, script: ScrollText, highlights: Highlighter,
  alignLeftEdge: AlignStartVertical, alignHCenter: AlignCenterVertical, alignRightEdge: AlignEndVertical,
  alignTopEdge: AlignStartHorizontal, alignVCenter: AlignCenterHorizontal, alignBottomEdge: AlignEndHorizontal,
});

// Review sharing and comments.
Object.assign(ICONS, {
  comment: MessageSquare, shareReview: MessageSquareShare, reply: Reply, resolve: CircleCheck, send: SendHorizontal,
  people: Users, removePerson: UserMinus,
});

/** An SVG icon element. Icons are decorative (aria-hidden); label the control instead. */
export function icon(name, size = 16, extraClass = '') {
  const node = ICONS[name] || ICONS.square;
  const el = createElement(node);
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  el.classList.add('icon');
  if (extraClass) el.classList.add(...extraClass.split(' '));
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
  el.className = ['app-logo', extraClass].filter(Boolean).join(' ');
  return el;
}

export const ICON_NAMES = Object.keys(ICONS);
