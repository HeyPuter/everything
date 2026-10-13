// Application preferences: the schema behind Edit → Preferences, defaults,
// validation of stored or imported values and migration from older stored
// layouts. Pure data; the workspace applies the values (features/preferences).
import type { LayoutKind } from '../app/view-layout';

export const PREFERENCES_VERSION = 2;
export const PREFERENCES_KEY = 'photo-studio-preferences';

export type PageId =
  | 'general'
  | 'interface'
  | 'workspace'
  | 'tools'
  | 'history'
  | 'files'
  | 'export'
  | 'performance'
  | 'cursors'
  | 'transparency'
  | 'units'
  | 'guides'
  | 'type';

export const PAGES: { id: PageId; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'interface', label: 'Interface', icon: 'app-window' },
  { id: 'workspace', label: 'Workspace', icon: 'panels-top-left' },
  { id: 'tools', label: 'Tools', icon: 'wrench' },
  { id: 'history', label: 'History & Autosave', icon: 'history' },
  { id: 'files', label: 'File Handling', icon: 'file-cog' },
  { id: 'export', label: 'Export', icon: 'image-down' },
  { id: 'performance', label: 'Performance', icon: 'gauge' },
  { id: 'cursors', label: 'Cursors', icon: 'mouse-pointer-click' },
  { id: 'transparency', label: 'Transparency & Gamut', icon: 'grid-2x2' },
  { id: 'units', label: 'Units & Rulers', icon: 'ruler' },
  { id: 'guides', label: 'Guides, Grid & Slices', icon: 'grid-3x3' },
  { id: 'type', label: 'Type', icon: 'type' },
];

export type Preferences = {
  version: number;
  // ----- State toggled from menus (View, Window), not listed in the window -----
  showRulers: boolean;
  showGuides: boolean;
  showGrid: boolean;
  snap: boolean;
  guidesLocked?: boolean;
  showPixelGrid?: boolean;
  showLayerEdges?: boolean;
  showAlignmentGuides?: boolean;
  showBrushPreview?: boolean;
  snapTo?: { guides: boolean; grid: boolean; layers: boolean; document: boolean };
  extras?: string[];
  showSlices?: boolean;
  lockSlices?: boolean;
  snapSlices?: boolean;
  showArtboardNames?: boolean;
  showCanvasGuides?: boolean;
  showArtboardGuides?: boolean;
  showMesh?: boolean;
  showEditPins?: boolean;
  showPatternTileBounds?: boolean;
  windowLayout?: LayoutKind;
  rotateAllWindows?: boolean;
  aspectCorrection?: boolean;
  // Warnings the user chose not to see again (General → Reset All Warning Dialogs).
  dismissedWarnings: string[];
  // ----- General -----
  colorPicker: 'app' | 'system';
  interpolation: 'automatic' | 'bicubic-smoother' | 'bicubic-sharper' | 'bicubic' | 'bilinear' | 'nearest';
  animatedZoom: boolean;
  zoomResizesWindows: boolean;
  wheelZooms: boolean;
  zoomClickedToCenter: boolean;
  resetOnLaunch: boolean;
  // ----- Interface -----
  theme: 'dark' | 'medium' | 'light' | 'system';
  uiFontSize: 'small' | 'medium' | 'large';
  uiScale: number;
  highlightColor: 'blue' | 'gray' | 'teal' | 'violet' | 'orange';
  canvasColorStandard: string;
  canvasColorFullMenus: string;
  canvasColorFull: string;
  canvasBorder: 'shadow' | 'line' | 'none';
  showTooltips: boolean;
  richTooltips: boolean;
  panelAnimations: boolean;
  // ----- Workspace -----
  autoCollapsePanels: boolean;
  openAsTabs: boolean;
  floatDocking: boolean;
  largeTabs: boolean;
  narrowOptionsBar: boolean;
  // ----- Tools -----
  toolReadouts: boolean;
  flickPanning: boolean;
  altDragHardness: boolean;
  maskDblClickRefine: boolean;
  shiftToolSwitch: boolean;
  snapPixelGrid: boolean;
  overscroll: boolean;
  // ----- History & autosave -----
  historyStates: number;
  autoSnapshot: boolean;
  nonLinearHistory: boolean;
  recoveryMinutes: number;
  versionsOnSave: boolean;
  versionsPerDocument: number;
  // ----- File handling -----
  extensionCase: 'lower' | 'upper';
  psdCompatibility: 'always' | 'ask' | 'never';
  recentCount: number;
  askLayeredTiff: boolean;
  // ----- Export -----
  quickExportFormat: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff';
  quickExportLocation: 'download' | 'ask' | 'beside';
  // ----- Performance -----
  gpuBackend: 'auto' | 'webgpu' | 'webgl2';
  videoCacheSize: number;
  // ----- Cursors -----
  paintCursor: 'standard' | 'precise' | 'normal' | 'full';
  paintCrosshair: boolean;
  otherCursor: 'standard' | 'precise';
  brushPreviewColor: string;
  // ----- Transparency & gamut -----
  checkerSize: 'none' | 'small' | 'medium' | 'large';
  checkerColors: 'light' | 'medium' | 'dark' | 'custom';
  checkerCustomA: string;
  checkerCustomB: string;
  // ----- Units & rulers -----
  rulerUnits?: string;
  typeUnits: 'pt' | 'px' | 'mm';
  columnWidth: number;
  columnGutter: number;
  columnUnit: 'pt' | 'px' | 'in' | 'cm' | 'mm' | 'pica';
  printPpi: number;
  screenDocPpi: number;
  screenPpi?: number;
  // ----- Guides, grid & slices -----
  guideColor: string;
  guideStyle: 'lines' | 'dashed';
  smartGuideColor: string;
  gridColor: string;
  gridStyle: 'lines' | 'dashed' | 'dots';
  gridEvery: number;
  gridUnit: 'px' | 'in' | 'cm' | 'mm' | 'pt' | 'percent';
  gridSubdivisions: number;
  sliceColor: string;
  sliceNumbers: boolean;
  // ----- Type -----
  smartQuotes: boolean;
  fontNamesEnglish: boolean;
  missingGlyphProtection: boolean;
  fontPreviewSize: 'none' | 'small' | 'medium' | 'large' | 'xlarge' | 'huge';
  textDirection: 'ltr' | 'rtl';
};

type Key = keyof Preferences & string;
export type Choice = readonly [string | number, string];
type Base = {
  page: PageId;
  section: string;
  label: string;
  help?: string;
  // Extra words the search matches.
  keywords?: string;
  // Takes effect after the app reloads.
  restart?: boolean;
};
export type SettingDef = Base &
  (
    | { type: 'boolean'; key: Key; default: boolean }
    | { type: 'number'; key: Key; default: number; min: number; max: number; step?: number; unit?: string; integer?: boolean }
    | { type: 'choice'; key: Key; default: string | number; options: Choice[] }
    | { type: 'color'; key: Key; default: string }
    // A preset ID from `options` or a custom "#rrggbb" color.
    | { type: 'color-choice'; key: Key; default: string; options: Choice[] }
    // Buttons and read-only panels drawn by the window (nothing is stored).
    | { type: 'action'; key?: undefined; id: string; button: string }
    | { type: 'info'; key?: undefined; id: string }
  );

const canvasColors: Choice[] = [
  ['default', 'Theme default'],
  ['black', 'Black'],
  ['dark', 'Dark gray'],
  ['medium', 'Medium gray'],
  ['light', 'Light gray'],
];
export const CANVAS_PRESETS: Record<string, string> = { black: '#000000', dark: '#282828', medium: '#535353', light: '#a8a8a8' };
export const HIGHLIGHTS: Record<Preferences['highlightColor'], { accent: string; row: string; rowLight: string }> = {
  blue: { accent: '#3d8bfd', row: '#3f5875', rowLight: '#c7dcf5' },
  gray: { accent: '#8c8c8c', row: '#5a5a5a', rowLight: '#c9c9c9' },
  teal: { accent: '#1fa39a', row: '#2f5f5b', rowLight: '#bfe6e2' },
  violet: { accent: '#8b6cf0', row: '#4f4775', rowLight: '#dcd4fb' },
  orange: { accent: '#e8892c', row: '#6e5236', rowLight: '#f8dcc0' },
};
export const CHECKER_SIZES: Record<Preferences['checkerSize'], number> = { none: 0, small: 4, medium: 8, large: 16 };
export const CHECKER_COLORS: Record<Exclude<Preferences['checkerColors'], 'custom'>, [string, string]> = {
  light: ['#ffffff', '#cccccc'],
  medium: ['#999999', '#666666'],
  dark: ['#666666', '#333333'],
};
export const FONT_PREVIEW_SIZES: Choice[] = [
  ['none', 'None'],
  ['small', 'Small'],
  ['medium', 'Medium'],
  ['large', 'Large'],
  ['xlarge', 'Extra large'],
  ['huge', 'Huge'],
];
const lengthUnits: Choice[] = [
  ['px', 'Pixels'],
  ['in', 'Inches'],
  ['cm', 'Centimeters'],
  ['mm', 'Millimeters'],
  ['pt', 'Points'],
  ['pica', 'Picas'],
];

/** Every setting shown in the Preferences window, in page and section order.
 * A key may appear on more than one page; it is stored once. */
export const SETTINGS: SettingDef[] = [
  // ----- General -----
  { page: 'general', section: 'Color', type: 'choice', key: 'colorPicker', label: 'Color picker', default: 'app', options: [['app', 'Photo Studio'], ['system', 'System (browser)']], help: 'The picker opened by the foreground and background color chips.', keywords: 'colour' },
  { page: 'general', section: 'Image', type: 'choice', key: 'interpolation', label: 'Image interpolation', default: 'automatic', options: [['automatic', 'Automatic'], ['bicubic-smoother', 'Bicubic Smoother'], ['bicubic-sharper', 'Bicubic Sharper'], ['bicubic', 'Bicubic'], ['bilinear', 'Bilinear'], ['nearest', 'Nearest Neighbor']], help: 'Default resampling for Image Size and transforms.', keywords: 'resample resampling' },
  { page: 'general', section: 'Zoom', type: 'boolean', key: 'animatedZoom', label: 'Animated zoom', default: true, help: 'Zoom commands and clicks glide to the new magnification.' },
  { page: 'general', section: 'Zoom', type: 'boolean', key: 'zoomResizesWindows', label: 'Zoom resizes floating windows', default: false, help: 'Zooming a floating document window resizes it to fit the image.' },
  { page: 'general', section: 'Zoom', type: 'boolean', key: 'wheelZooms', label: 'Zoom with scroll wheel', default: false, help: 'Otherwise the wheel scrolls and Alt or ⌘/Ctrl + wheel zooms.' },
  { page: 'general', section: 'Zoom', type: 'boolean', key: 'zoomClickedToCenter', label: 'Zoom clicked point to center', default: false, help: 'The Zoom tool centers the point you click.' },
  { page: 'general', section: 'Reset', type: 'action', id: 'reset-warnings', button: 'Reset All Warning Dialogs', label: 'Warning dialogs', help: 'Show again every warning you turned off with “Don’t show again”.' },
  { page: 'general', section: 'Reset', type: 'boolean', key: 'resetOnLaunch', label: 'Reset preferences on next launch', default: false, help: 'Every preference returns to its default the next time Photo Studio starts.' },
  // ----- Interface -----
  { page: 'interface', section: 'Appearance', type: 'choice', key: 'theme', label: 'Color theme', default: 'dark', options: [['dark', 'Dark'], ['medium', 'Medium'], ['light', 'Light'], ['system', 'Match system']], keywords: 'dark light mode' },
  { page: 'interface', section: 'Appearance', type: 'choice', key: 'highlightColor', label: 'Highlight color', default: 'blue', options: [['blue', 'Blue'], ['gray', 'Gray'], ['teal', 'Teal'], ['violet', 'Violet'], ['orange', 'Orange']], help: 'Accent for selected rows, focus rings and primary buttons.', keywords: 'accent selection' },
  { page: 'interface', section: 'Text and scaling', type: 'choice', key: 'uiFontSize', label: 'UI font size', default: 'medium', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] },
  { page: 'interface', section: 'Text and scaling', type: 'choice', key: 'uiScale', label: 'UI scaling', default: 100, options: [[90, '90%'], [100, '100%'], [110, '110%'], [125, '125%'], [150, '150%']], help: 'Scales menus, panels, tools and the options bar; the canvas keeps its own zoom.', keywords: 'zoom size dpi' },
  { page: 'interface', section: 'Canvas', type: 'color-choice', key: 'canvasColorStandard', label: 'Canvas color (standard screen mode)', default: 'default', options: canvasColors, keywords: 'pasteboard background' },
  { page: 'interface', section: 'Canvas', type: 'color-choice', key: 'canvasColorFullMenus', label: 'Canvas color (full screen with menus)', default: 'default', options: canvasColors, keywords: 'pasteboard background' },
  { page: 'interface', section: 'Canvas', type: 'color-choice', key: 'canvasColorFull', label: 'Canvas color (full screen)', default: 'black', options: canvasColors, keywords: 'pasteboard background' },
  { page: 'interface', section: 'Canvas', type: 'choice', key: 'canvasBorder', label: 'Image border', default: 'shadow', options: [['shadow', 'Drop shadow'], ['line', 'Line'], ['none', 'None']] },
  { page: 'interface', section: 'Behavior', type: 'boolean', key: 'showTooltips', label: 'Show tooltips', default: true, keywords: 'hints hover' },
  { page: 'interface', section: 'Behavior', type: 'boolean', key: 'richTooltips', label: 'Rich tooltips', default: true, help: 'Tooltips for commands and tools also show a description and the shortcut.', keywords: 'hints hover' },
  { page: 'interface', section: 'Behavior', type: 'boolean', key: 'panelAnimations', label: 'Enable panel animations', default: true, keywords: 'motion transitions reduce' },
  // ----- Workspace -----
  { page: 'workspace', section: 'Panels', type: 'boolean', key: 'autoCollapsePanels', label: 'Auto-collapse icon panels', default: false, help: 'A panel opened from the icon strip closes when you click elsewhere.' },
  { page: 'workspace', section: 'Documents', type: 'boolean', key: 'openAsTabs', label: 'Open documents as tabs', default: true, help: 'Otherwise new documents open in floating windows.' },
  { page: 'workspace', section: 'Documents', type: 'boolean', key: 'floatDocking', label: 'Enable floating document window docking', default: true, help: 'Dropping a floating window’s title bar on the tab bar docks it as a tab.' },
  { page: 'workspace', section: 'Documents', type: 'boolean', key: 'largeTabs', label: 'Large tabs', default: false },
  { page: 'workspace', section: 'Options bar', type: 'boolean', key: 'narrowOptionsBar', label: 'Narrow options bar', default: false, help: 'A shorter options bar with tighter spacing.' },
  // ----- Tools -----
  { page: 'tools', section: 'Feedback', type: 'boolean', key: 'toolReadouts', label: 'Show tooltips while dragging', default: true, help: 'Width, height, offset and angle readouts beside the pointer while you drag.', keywords: 'hud transformation values' },
  { page: 'tools', section: 'Navigation', type: 'boolean', key: 'flickPanning', label: 'Enable flick panning', default: false, help: 'The view keeps gliding after a quick Hand tool drag.', keywords: 'inertia momentum' },
  { page: 'tools', section: 'Navigation', type: 'boolean', key: 'wheelZooms', label: 'Zoom with scroll wheel', default: false },
  { page: 'tools', section: 'Navigation', type: 'boolean', key: 'overscroll', label: 'Overscroll', default: true, help: 'Scroll the image past the window edges.' },
  { page: 'tools', section: 'Painting', type: 'boolean', key: 'altDragHardness', label: 'Vary round brush hardness with vertical drag', default: true, help: 'While resizing a brush with Alt + right-drag (Ctrl + Alt drag on a Mac), dragging up or down changes hardness instead of opacity.' },
  { page: 'tools', section: 'Selection', type: 'boolean', key: 'maskDblClickRefine', label: 'Double-click a layer mask to open Select and Mask', default: true, help: 'Otherwise double-clicking a mask shows its Properties.' },
  { page: 'tools', section: 'Shortcuts', type: 'boolean', key: 'shiftToolSwitch', label: 'Use Shift key for tool switch', default: true, help: 'Off: pressing a tool’s key again cycles through its group.' },
  { page: 'tools', section: 'Shapes and transforms', type: 'boolean', key: 'snapPixelGrid', label: 'Snap vector tools and transforms to pixel grid', default: false, keywords: 'align edges whole pixels' },
  // ----- History & autosave -----
  { page: 'history', section: 'History', type: 'number', key: 'historyStates', label: 'History states', default: 60, min: 1, max: 1000, integer: true, help: 'Steps kept per document. More states use more memory.', keywords: 'undo levels' },
  { page: 'history', section: 'History', type: 'boolean', key: 'autoSnapshot', label: 'Automatically create first snapshot', default: true, help: 'Opened and new documents start with a snapshot of their initial state.' },
  { page: 'history', section: 'History', type: 'boolean', key: 'nonLinearHistory', label: 'Allow non-linear history', default: false, help: 'Editing after stepping back keeps the later states in the list instead of discarding them.' },
  { page: 'history', section: 'Recovery', type: 'choice', key: 'recoveryMinutes', label: 'Save recovery information every', default: 5, options: [[0, 'Never'], [1, '1 minute'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour']], help: 'Unsaved documents are kept in this browser so they can be restored after a crash or a closed tab.', keywords: 'autosave crash backup' },
  { page: 'history', section: 'Versions', type: 'boolean', key: 'versionsOnSave', label: 'Keep a version on each save and autosave', default: true, help: 'Versions are stored in this browser and listed in the Version History panel.', keywords: 'version history' },
  { page: 'history', section: 'Versions', type: 'number', key: 'versionsPerDocument', label: 'Automatic versions per document', default: 30, min: 1, max: 500, integer: true, help: 'Older automatic versions are removed first; named versions are kept.', keywords: 'version history limit' },
  // ----- File handling -----
  { page: 'files', section: 'Saving', type: 'choice', key: 'extensionCase', label: 'Append file extension', default: 'lower', options: [['lower', 'Use lower case (.png)'], ['upper', 'Use upper case (.PNG)']] },
  { page: 'files', section: 'Compatibility', type: 'choice', key: 'psdCompatibility', label: 'Maximize PSD compatibility', default: 'always', options: [['always', 'Always'], ['ask', 'Ask'], ['never', 'Never']], help: 'Include a flattened composite so other apps can show the file. Off makes files smaller.' },
  { page: 'files', section: 'Compatibility', type: 'boolean', key: 'askLayeredTiff', label: 'Ask before saving layered TIFF files', default: true, help: 'TIFF export flattens layers; ask first when the document has several.' },
  { page: 'files', section: 'Recent files', type: 'number', key: 'recentCount', label: 'Recent file list contains', default: 12, min: 0, max: 100, integer: true, unit: 'files' },
  // ----- Export -----
  { page: 'export', section: 'Quick export', type: 'choice', key: 'quickExportFormat', label: 'Quick export format', default: 'png', options: [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP'], ['gif', 'GIF'], ['tiff', 'TIFF']] },
  { page: 'export', section: 'Quick export', type: 'choice', key: 'quickExportLocation', label: 'Quick export location', default: 'download', options: [['download', 'Download to this device'], ['ask', 'Ask for a Puter folder each time'], ['beside', 'Beside the document in Puter']], help: 'Documents not yet saved to Puter download when “beside the document” is chosen.' },
  // ----- Performance -----
  { page: 'performance', section: 'Memory', type: 'info', id: 'memory', label: 'Memory usage' },
  { page: 'performance', section: 'History', type: 'number', key: 'historyStates', label: 'History states', default: 60, min: 1, max: 1000, integer: true, keywords: 'undo levels' },
  { page: 'performance', section: 'Video', type: 'number', key: 'videoCacheSize', label: 'Video frame cache', default: 512, min: 64, max: 8192, integer: true, unit: 'MB', help: 'Decoded video frames kept in memory for scrubbing and playback; the least recently used go first.', keywords: 'video layers timeline memory' },
  { page: 'performance', section: 'Graphics', type: 'choice', key: 'gpuBackend', label: 'Graphics processor backend', default: 'auto', options: [['auto', 'Automatic (WebGPU, then WebGL2)'], ['webgpu', 'WebGPU'], ['webgl2', 'WebGL2']], restart: true, keywords: 'gpu compositor renderer' },
  // ----- Cursors -----
  { page: 'cursors', section: 'Painting cursors', type: 'choice', key: 'paintCursor', label: 'Painting cursor', default: 'normal', options: [['standard', 'Standard (tool icon)'], ['precise', 'Precise (crosshair)'], ['normal', 'Normal brush tip'], ['full', 'Full size brush tip']], help: 'Normal tip outlines where the brush is at least half strength; full size outlines the whole brush.', keywords: 'brush outline' },
  { page: 'cursors', section: 'Painting cursors', type: 'boolean', key: 'paintCrosshair', label: 'Show crosshair in brush tip', default: false },
  { page: 'cursors', section: 'Other cursors', type: 'choice', key: 'otherCursor', label: 'Other cursors', default: 'standard', options: [['standard', 'Standard'], ['precise', 'Precise (crosshair)']] },
  { page: 'cursors', section: 'Brush preview', type: 'color', key: 'brushPreviewColor', label: 'Brush preview color', default: '#ff2a2a', help: 'Fill shown while resizing a brush with Alt + right-drag.' },
  // ----- Transparency & gamut -----
  { page: 'transparency', section: 'Transparency', type: 'choice', key: 'checkerSize', label: 'Grid size', default: 'medium', options: [['none', 'None'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], keywords: 'checkerboard transparent' },
  { page: 'transparency', section: 'Transparency', type: 'choice', key: 'checkerColors', label: 'Grid colors', default: 'light', options: [['light', 'Light'], ['medium', 'Medium'], ['dark', 'Dark'], ['custom', 'Custom']], keywords: 'checkerboard transparent' },
  { page: 'transparency', section: 'Transparency', type: 'color', key: 'checkerCustomA', label: 'Custom grid color 1', default: '#ffffff', keywords: 'checkerboard' },
  { page: 'transparency', section: 'Transparency', type: 'color', key: 'checkerCustomB', label: 'Custom grid color 2', default: '#d6d6d6', keywords: 'checkerboard' },
  { page: 'transparency', section: 'Gamut warning', type: 'info', id: 'gamut', label: 'Gamut warning color and opacity', keywords: 'out of gamut proof' },
  // ----- Units & rulers -----
  { page: 'units', section: 'Units', type: 'choice', key: 'rulerUnits', label: 'Rulers', default: 'px', options: [...lengthUnits, ['percent', 'Percent']], keywords: 'measurement' },
  { page: 'units', section: 'Units', type: 'choice', key: 'typeUnits', label: 'Type', default: 'pt', options: [['pt', 'Points'], ['px', 'Pixels'], ['mm', 'Millimeters']], help: 'Units for font size, leading and baseline shift.', keywords: 'font size' },
  { page: 'units', section: 'Column size', type: 'number', key: 'columnWidth', label: 'Column width', default: 180, min: 0.01, max: 10000, help: 'Used by the Columns unit in New Document.' },
  { page: 'units', section: 'Column size', type: 'number', key: 'columnGutter', label: 'Gutter', default: 12, min: 0, max: 10000 },
  { page: 'units', section: 'Column size', type: 'choice', key: 'columnUnit', label: 'Column units', default: 'pt', options: lengthUnits },
  { page: 'units', section: 'New document preset resolutions', type: 'number', key: 'printPpi', label: 'Print resolution', default: 300, min: 1, max: 10000, unit: 'pixels/inch', help: 'Used by Print and Art & Illustration presets.' },
  { page: 'units', section: 'New document preset resolutions', type: 'number', key: 'screenDocPpi', label: 'Screen resolution', default: 72, min: 1, max: 10000, unit: 'pixels/inch', help: 'Used by Web, Mobile and Film & Video presets.' },
  { page: 'units', section: 'Display', type: 'number', key: 'screenPpi', label: 'Display density for Print Size', default: 96, min: 36, max: 1000, integer: true, unit: 'pixels/inch', keywords: 'print size zoom' },
  // ----- Guides, grid & slices -----
  { page: 'guides', section: 'Guides', type: 'color', key: 'guideColor', label: 'Guide color', default: '#00c8ff' },
  { page: 'guides', section: 'Guides', type: 'choice', key: 'guideStyle', label: 'Guide style', default: 'lines', options: [['lines', 'Lines'], ['dashed', 'Dashed lines']] },
  { page: 'guides', section: 'Guides', type: 'color', key: 'smartGuideColor', label: 'Alignment guide color', default: '#ff4fb3', keywords: 'smart guides' },
  { page: 'guides', section: 'Grid', type: 'color', key: 'gridColor', label: 'Grid color', default: '#808080' },
  { page: 'guides', section: 'Grid', type: 'choice', key: 'gridStyle', label: 'Grid style', default: 'lines', options: [['lines', 'Lines'], ['dashed', 'Dashed lines'], ['dots', 'Dots']] },
  { page: 'guides', section: 'Grid', type: 'number', key: 'gridEvery', label: 'Gridline every', default: 64, min: 0.01, max: 10000 },
  { page: 'guides', section: 'Grid', type: 'choice', key: 'gridUnit', label: 'Gridline units', default: 'px', options: [['px', 'Pixels'], ['in', 'Inches'], ['cm', 'Centimeters'], ['mm', 'Millimeters'], ['pt', 'Points'], ['percent', 'Percent']] },
  { page: 'guides', section: 'Grid', type: 'number', key: 'gridSubdivisions', label: 'Subdivisions', default: 4, min: 1, max: 100, integer: true },
  { page: 'guides', section: 'Slices', type: 'color', key: 'sliceColor', label: 'Slice line color', default: '#3d8bfd' },
  { page: 'guides', section: 'Slices', type: 'boolean', key: 'sliceNumbers', label: 'Show slice numbers', default: true },
  // ----- Type -----
  { page: 'type', section: 'Typing', type: 'boolean', key: 'smartQuotes', label: 'Use smart quotes', default: true, help: 'Straight quotes become curly quotes as you type.', keywords: 'typographer apostrophe' },
  { page: 'type', section: 'Typing', type: 'boolean', key: 'missingGlyphProtection', label: 'Enable missing glyph protection', default: true, help: 'Characters the chosen font cannot draw use a bundled font that can.', keywords: 'fallback tofu' },
  { page: 'type', section: 'Typing', type: 'choice', key: 'textDirection', label: 'Default text direction', default: 'ltr', options: [['ltr', 'Left to right'], ['rtl', 'Right to left']], keywords: 'rtl language engine' },
  { page: 'type', section: 'Font menu', type: 'boolean', key: 'fontNamesEnglish', label: 'Show font names in English', default: true, help: 'Off: local fonts show their names in your language when the font provides one.', keywords: 'localized' },
  { page: 'type', section: 'Font menu', type: 'choice', key: 'fontPreviewSize', label: 'Font preview size', default: 'medium', options: FONT_PREVIEW_SIZES },
];

/** Stored settings (one definition per key). */
export const STORED: Extract<SettingDef, { key: Key }>[] = (() => {
  const seen = new Set<string>();
  const out: Extract<SettingDef, { key: Key }>[] = [];
  for (const s of SETTINGS) {
    if (!s.key || seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s as Extract<SettingDef, { key: Key }>);
  }
  return out;
})();
export const settingFor = (key: string) => STORED.find((s) => s.key === (key as Key));

// Menu state that has no row in the window: type checks only.
const STATE_BOOLEANS = ['showRulers', 'showGuides', 'showGrid', 'snap', 'guidesLocked', 'showPixelGrid', 'showLayerEdges', 'showAlignmentGuides', 'showBrushPreview', 'showSlices', 'lockSlices', 'snapSlices', 'showArtboardNames', 'showCanvasGuides', 'showArtboardGuides', 'showMesh', 'showEditPins', 'showPatternTileBounds', 'rotateAllWindows', 'aspectCorrection'] as const;
const STATE_DEFAULTS = { showRulers: true, showGuides: true, showGrid: false, snap: true };
const LAYOUTS = ['tabs', 'tile-grid', 'tile-vertical', 'tile-horizontal', '2-up-vertical', '2-up-horizontal', '3-up-vertical', '3-up-horizontal', '3-up-stacked', '4-up', '6-up'];

export function defaultPreferences(): Preferences {
  const p: Record<string, unknown> = { version: PREFERENCES_VERSION, ...STATE_DEFAULTS, dismissedWarnings: [] };
  for (const s of STORED) p[s.key] = s.default;
  return p as Preferences;
}

const HEX = /^#[0-9a-f]{6}$/i;
/** A valid value for one setting, or undefined. Numbers are clamped. */
export function coerceSetting(def: Extract<SettingDef, { key: Key }>, v: unknown): unknown {
  switch (def.type) {
    case 'boolean':
      return typeof v === 'boolean' ? v : undefined;
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
      const c = Math.min(def.max, Math.max(def.min, n));
      return def.integer ? Math.round(c) : Math.round(c * 1000) / 1000;
    }
    case 'choice': {
      const hit = def.options.find(([o]) => o === v || String(o) === String(v));
      return hit ? hit[0] : undefined;
    }
    case 'color':
      return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : undefined;
    case 'color-choice':
      return typeof v === 'string' && (HEX.test(v) || def.options.some(([o]) => o === v)) ? (HEX.test(v) ? v.toLowerCase() : v) : undefined;
  }
}

/** Complete, valid preferences from any object (stored, imported or partial).
 * Invalid or unknown values fall back to defaults; `problems` lists them. */
export function validatePreferences(raw: unknown, problems: string[] = []): Preferences {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = defaultPreferences() as Record<string, unknown>;
  for (const def of STORED) {
    if (!(def.key in src)) continue;
    const v = coerceSetting(def, src[def.key]);
    if (v === undefined) problems.push(def.key);
    else out[def.key] = v;
  }
  for (const k of STATE_BOOLEANS) if (typeof src[k] === 'boolean') out[k] = src[k];
  const snapTo = src.snapTo as Record<string, unknown> | undefined;
  if (snapTo && typeof snapTo === 'object' && ['guides', 'grid', 'layers', 'document'].every((k) => typeof snapTo[k] === 'boolean'))
    out.snapTo = { guides: snapTo.guides, grid: snapTo.grid, layers: snapTo.layers, document: snapTo.document };
  if (Array.isArray(src.extras) && src.extras.every((x) => typeof x === 'string')) out.extras = [...src.extras];
  if (typeof src.windowLayout === 'string' && LAYOUTS.includes(src.windowLayout)) out.windowLayout = src.windowLayout;
  if (Array.isArray(src.dismissedWarnings)) out.dismissedWarnings = src.dismissedWarnings.filter((x) => typeof x === 'string').slice(0, 200);
  out.version = PREFERENCES_VERSION;
  return out as Preferences;
}

/** Values kept outside the preferences object by older versions. */
export type LegacyValues = { theme?: string | null; fontPreview?: string | null };

/** Upgrade a stored object to the current layout (before validation). */
export function migratePreferences(raw: unknown, legacy: LegacyValues = {}): Record<string, unknown> {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const version = typeof src.version === 'number' ? src.version : 1;
  if (version < 2) {
    // Version 1 kept a pixel grid spacing, the theme and the font preview
    // size under their own storage keys.
    if (typeof src.gridSize === 'number' && !('gridEvery' in src)) {
      src.gridEvery = src.gridSize;
      src.gridUnit = 'px';
    }
    delete src.gridSize;
    if (legacy.theme && !('theme' in src)) src.theme = legacy.theme;
    if (legacy.fontPreview && !('fontPreviewSize' in src)) src.fontPreviewSize = legacy.fontPreview;
  }
  src.version = PREFERENCES_VERSION;
  return src;
}

/** Preferences to use at startup from the stored JSON text. A stored
 * "reset on next launch" request yields defaults. */
export function loadPreferences(stored: string | null, legacy: LegacyValues = {}): Preferences {
  let raw: unknown = {};
  try {
    raw = JSON.parse(stored ?? '{}');
  } catch {
    raw = {};
  }
  const migrated = migratePreferences(raw, legacy);
  if (migrated.resetOnLaunch === true) return defaultPreferences();
  return validatePreferences(migrated);
}

/** Preferences as a portable JSON file. Only listed settings are written. */
export function exportPreferences(p: Preferences): string {
  const values: Record<string, unknown> = {};
  for (const def of STORED) values[def.key] = p[def.key];
  return JSON.stringify({ format: 'photo-studio-preferences', version: PREFERENCES_VERSION, preferences: values }, null, 2);
}

/** Apply an exported preferences file on top of `current`. Throws when the
 * file is not a preferences file; unknown or invalid entries are reported. */
export function importPreferences(text: string, current: Preferences): { preferences: Preferences; ignored: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  const d = data as { format?: unknown; version?: unknown; preferences?: unknown };
  if (!d || typeof d !== 'object' || d.format !== 'photo-studio-preferences' || !d.preferences || typeof d.preferences !== 'object')
    throw new Error('This file does not contain Photo Studio preferences.');
  const values = migratePreferences({ ...(d.preferences as Record<string, unknown>), version: typeof d.version === 'number' ? d.version : 1 });
  const ignored: string[] = [];
  const known = new Set<string>(STORED.map((s) => s.key));
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(values)) {
    if (k === 'version') continue;
    const def = known.has(k) ? settingFor(k) : undefined;
    const c = def ? coerceSetting(def, v) : undefined;
    if (c === undefined) ignored.push(k);
    else next[k] = c;
  }
  return { preferences: validatePreferences(next), ignored };
}

/** Settings matching a search query (label, help, keywords, section, page). */
export function searchSettings(query: string): SettingDef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return SETTINGS.filter((s) => {
    const page = PAGES.find((p) => p.id === s.page)?.label ?? '';
    const hay = `${s.label} ${s.help ?? ''} ${s.keywords ?? ''} ${s.section} ${page}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Grid spacing in document pixels for the grid preference. */
export function gridSpacingPx(p: Pick<Preferences, 'gridEvery' | 'gridUnit'>, ppi: number, docWidth: number): number {
  const perUnit: Record<string, number> = { px: 1, in: ppi, cm: ppi / 2.54, mm: ppi / 25.4, pt: ppi / 72, percent: docWidth / 100 };
  return Math.max(1, p.gridEvery * (perUnit[p.gridUnit] ?? 1));
}

/** Canvas color CSS for a color-choice value; empty for the theme default. */
export function canvasColorValue(v: string): string {
  if (HEX.test(v)) return v;
  return CANVAS_PRESETS[v] ?? '';
}

/** Checkerboard colors for the transparency preferences. */
export function checkerColors(p: Pick<Preferences, 'checkerColors' | 'checkerCustomA' | 'checkerCustomB' | 'checkerSize'>): [string, string] {
  if (p.checkerSize === 'none') return ['#ffffff', '#ffffff'];
  if (p.checkerColors === 'custom') return [p.checkerCustomA, p.checkerCustomB];
  return CHECKER_COLORS[p.checkerColors];
}
