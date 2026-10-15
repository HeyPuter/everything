// Themes: colour groups per editor, built-in presets, the active theme and its persistence.
// CSS-drawn UI reads variables (set on :root); canvas / WebGL editors read colour tables
// that this module rewrites. Hard-coded greys in the style sheets go through two ramps
// (--g-XX for surfaces, --t-XX for text) that are derived from a few key colours, so a
// theme only has to name those.
import { Color, SRGBColorSpace } from 'three';
import { app } from '../app/app';
import { C as ANIM, KEY_COLORS } from '../animation/theme';
import { viewportTheme, gridMaterial } from '../editors/view3d/draw';
import { editMeshColors } from '../modes/editmesh/overlay';
import { NODE_CLASS_COLORS, NODE_EDITOR_COLORS } from '../nodes/registry';
import { parseHex, toHex, cssColor, lerp, ramp, SURFACE_REFS, TEXT_REFS } from './theme_core';
import { setCanvasGreys } from '../ui/canvastheme';

export { parseHex, toHex };

export type ThemeValues = Record<string, string>;

export interface ThemeItem {
  id: string;
  label: string;
  /** CSS custom property set from the value */
  css?: string;
  /** colour includes alpha */
  alpha?: boolean;
  /** a number (px) instead of a colour */
  number?: { min: number; max: number };
  /** writes the value into a canvas / WebGL colour table */
  set?: (v: string) => void;
  /** the value before any theme was applied */
  def: string;
}

export interface ThemeGroup {
  id: string;
  label: string;
  items: ThemeItem[];
}

export interface ThemePreset {
  id: string;
  label: string;
  values: ThemeValues;
}

const setThree = (c: Color) => (v: string) => {
  const [r, g, b] = parseHex(v);
  c.setRGB(r, g, b, SRGBColorSpace);
};

// ---------------------------------------------------------------------------
// items

const css = (id: string, label: string, cssVar: string, def: string, extra: Partial<ThemeItem> = {}): ThemeItem => ({ id, label, css: cssVar, def, ...extra });

function threeHex(c: Color) {
  const t = c.clone();
  const o = { r: 0, g: 0, b: 0 };
  t.getRGB(o, SRGBColorSpace);
  return toHex(o.r, o.g, o.b);
}

function canvasHex(v: string) {
  // canvas colours are written as #hex or rgba(); normalise for the editor
  const m = /^rgba?\(([^)]*)\)$/.exec(v.trim());
  if (!m) return v.length === 4 || v.length === 7 || v.length === 9 ? v : '#000000';
  const [r, g, b, a = '1'] = m[1].split(',').map((s) => s.trim());
  return toHex(+r / 255, +g / 255, +b / 255, +a);
}

const animItem = (key: keyof typeof ANIM, label: string): ThemeItem => ({ id: `anim.${key}`, label, alpha: true, def: canvasHex(ANIM[key]), set: (v) => (ANIM[key] = cssColor(v)) });
const keyItem = (type: keyof typeof KEY_COLORS, sel: 0 | 1, label: string): ThemeItem => ({ id: `key.${type}.${sel}`, label, def: KEY_COLORS[type][sel], set: (v) => (KEY_COLORS[type][sel] = cssColor(v)) });
const nodeItem = (cls: keyof typeof NODE_CLASS_COLORS, label: string): ThemeItem => ({ id: `node.${cls}`, label, def: NODE_CLASS_COLORS[cls], set: (v) => (NODE_CLASS_COLORS[cls] = cssColor(v)) });
const meshItem = (key: keyof typeof editMeshColors, label: string): ThemeItem => ({ id: `mesh.${key}`, label, def: threeHex(editMeshColors[key]), set: setThree(editMeshColors[key]) });

export const THEME_GROUPS: ThemeGroup[] = [
  {
    id: 'ui',
    label: 'User Interface',
    items: [
      css('text', 'Text', '--c-text', '#e6e6e6'),
      css('text_dim', 'Text Dimmed', '--c-text-dim', '#999999'),
      css('text_hi', 'Text Highlight', '--c-text-hi', '#ffffff'),
      css('accent', 'Accent', '--accent', '#4772b3'),
      css('accent_hi', 'Accent Hover', '--accent-hi', '#5680c2'),
      css('text_on_accent', 'Text on Accent', '--c-text-on-accent', '#ffffff'),
      css('button', 'Button', '--w-regular', '#545454'),
      css('button_hover', 'Button Hover', '--w-regular-hover', '#656565'),
      css('button_outline', 'Button Outline', '--w-outline', '#3d3d3d'),
      css('field', 'Text & List Field', '--w-field', '#1d1d1d'),
      css('number', 'Number Field', '--w-num', '#545454'),
      css('number_hover', 'Number Field Hover', '--w-num-hover', '#5e5e5e'),
      css('toggle', 'Toggle', '--w-toggle', '#545454'),
      css('tab', 'Tab', '--w-tab', '#1d1d1d'),
      css('tab_on', 'Tab Active', '--w-tab-on', '#303030'),
      css('menu', 'Menu Background', '--w-menu', '#282828'),
      css('menu_back', 'Menu Bar', '--w-menu-back', '#181818'),
      css('menu_item_hl', 'Menu Highlight', '--w-menu-item-hl', '#4772b3'),
      css('panel', 'Panel', '--c-panel', '#3d3d3d'),
      css('panel_sub', 'Sub-Panel Shade', '--c-panel-sub', '#0000001f', { alpha: true }),
      css('panel_outline', 'Panel Outline', '--c-panel-outline', '#ffffff11', { alpha: true }),
      { id: 'hover', label: 'Hover Tint', def: '#ffffff' },
      css('radius', 'Roundness', '--radius', '4', { number: { min: 0, max: 10 } }),
      css('keyed', 'Keyframe', '--anim-keyed', '#b3ae36'),
      css('animated', 'Animated', '--anim-animated', '#53992e'),
      css('driven', 'Driven', '--anim-driven', '#9000cc'),
      css('error', 'Error', '--c-error', '#991616'),
      css('warning', 'Warning', '--c-warning', '#ac8737'),
      css('info', 'Info', '--c-info', '#284880'),
    ],
  },
  {
    id: 'window',
    label: 'Window & Editors',
    items: [
      css('border', 'Area Borders', '--c-border', '#161616'),
      css('topbar', 'Top Bar', '--c-topbar', '#181818'),
      css('header', 'Header', '--c-header', '#303030'),
      css('region', 'Region Background', '--c-region', '#303030'),
      css('x', 'X Axis', '--c-x', '#ff3352'),
      css('y', 'Y Axis', '--c-y', '#8bdc00'),
      css('z', 'Z Axis', '--c-z', '#2890ff'),
    ],
  },
  {
    id: 'view3d',
    label: '3D Viewport',
    items: [
      { id: 'v3d.background', label: 'Background', def: threeHex(viewportTheme.bg), set: setThree(viewportTheme.bg) },
      { id: 'v3d.grid', label: 'Grid', def: threeHex(gridMaterial.uniforms.uColor.value as Color), set: setThree(gridMaterial.uniforms.uColor.value as Color) },
      { id: 'v3d.wire', label: 'Wire', def: threeHex(viewportTheme.wire), set: setThree(viewportTheme.wire) },
      { id: 'v3d.wire_edit', label: 'Wire Edit', def: threeHex(viewportTheme.wireEdit), set: setThree(viewportTheme.wireEdit) },
      css('object_selected', 'Object Selected', '--c-selected', '#ed5700', { set: setThree(viewportTheme.selected) }),
      css('object_active', 'Active Object', '--c-active', '#ffa028', { set: setThree(viewportTheme.active) }),
    ],
  },
  {
    id: 'mesh',
    label: 'Mesh Edit Mode',
    items: [
      meshItem('vert', 'Vertex'),
      meshItem('vertSel', 'Vertex Select'),
      meshItem('edge', 'Edge'),
      meshItem('edgeSel', 'Edge Select'),
      meshItem('edgeModeSel', 'Edge Mode Selection'),
      meshItem('faceSel', 'Face Select'),
      meshItem('active', 'Active Element'),
      meshItem('seam', 'Seam'),
      meshItem('sharp', 'Sharp'),
      meshItem('crease', 'Crease'),
      meshItem('normal', 'Normal'),
    ],
  },
  {
    id: 'anim',
    label: 'Animation Editors',
    items: [
      animItem('back', 'Background'),
      animItem('channelBack', 'Channel List'),
      animItem('rulerBack', 'Time Ruler'),
      animItem('rulerText', 'Ruler Text'),
      animItem('grid', 'Grid'),
      animItem('gridMinor', 'Grid Minor'),
      animItem('playhead', 'Current Frame'),
      animItem('previewRange', 'Preview Range'),
      animItem('outOfRange', 'Outside Range'),
      animItem('summary', 'Summary Row'),
      animItem('objectRow', 'Object Channel'),
      animItem('groupRow', 'Group Channel'),
      animItem('channelRow', 'Channel'),
      animItem('channelRowSel', 'Channel Selected'),
      animItem('vertex', 'Curve Vertex'),
      animItem('vertexSelect', 'Curve Vertex Select'),
      animItem('nlaStrip', 'NLA Strip'),
      animItem('nlaStripSelected', 'NLA Strip Selected'),
      keyItem('KEYFRAME', 0, 'Keyframe'),
      keyItem('KEYFRAME', 1, 'Keyframe Selected'),
      keyItem('EXTREME', 0, 'Extreme'),
      keyItem('EXTREME', 1, 'Extreme Selected'),
      keyItem('BREAKDOWN', 0, 'Breakdown'),
      keyItem('BREAKDOWN', 1, 'Breakdown Selected'),
      keyItem('JITTER', 0, 'Jitter'),
      keyItem('JITTER', 1, 'Jitter Selected'),
      keyItem('MOVING_HOLD', 0, 'Moving Hold'),
      keyItem('MOVING_HOLD', 1, 'Moving Hold Selected'),
    ],
  },
  {
    id: 'nodes',
    label: 'Node Editor',
    items: [
      css('nd_back', 'Background', '--nd-back', '#1d1d1d', { set: (v) => (NODE_EDITOR_COLORS.back = cssColor(v)) }),
      { id: 'nd_grid', label: 'Grid Dots', def: NODE_EDITOR_COLORS.grid, set: (v) => (NODE_EDITOR_COLORS.grid = cssColor(v)) },
      { id: 'nd_grid_major', label: 'Grid Dots Major', def: NODE_EDITOR_COLORS.gridMajor, set: (v) => (NODE_EDITOR_COLORS.gridMajor = cssColor(v)) },
      css('nd_body', 'Node Body', '--nd-body', '#303030'),
      css('nd_text', 'Node Text', '--nd-text', '#e6e6e6'),
      css('nd_sel', 'Node Selected', '--nd-sel', '#ed5700'),
      css('nd_active', 'Active Node', '--nd-active', '#ffffff'),
      nodeItem('input', 'Input Node'),
      nodeItem('output', 'Output Node'),
      nodeItem('shader', 'Shader Node'),
      nodeItem('texture', 'Texture Node'),
      nodeItem('color', 'Color Node'),
      nodeItem('vector', 'Vector Node'),
      nodeItem('converter', 'Converter Node'),
      nodeItem('geometry', 'Geometry Node'),
      nodeItem('attribute', 'Attribute Node'),
      nodeItem('group', 'Group Node'),
      nodeItem('layout', 'Layout Node'),
      nodeItem('script', 'Script Node'),
      nodeItem('filter', 'Filter Node'),
      nodeItem('distort', 'Distort Node'),
      nodeItem('matte', 'Matte Node'),
    ],
  },
  {
    id: 'outliner',
    label: 'Outliner',
    items: [
      css('outliner', 'Background', '--c-outliner', '#282828'),
      css('ol_selected', 'Selected Row', '--c-ol-selected', '#1d314d'),
      css('ol_active', 'Active Row', '--c-ol-active', '#334d80'),
      css('ol_sel_text', 'Selected Object Text', '--c-ol-sel-text', '#e96a00'),
      css('ol_act_text', 'Active Object Text', '--c-ol-act-text', '#ffaf29'),
    ],
  },
  {
    id: 'text',
    label: 'Text Editor',
    items: [
      css('te_bg', 'Background', '--te-bg', '#232323'),
      css('te_gutter_bg', 'Line Numbers Background', '--te-gutter-bg', '#1d1d1d'),
      css('te_gutter_fg', 'Line Numbers', '--te-gutter-fg', '#707070'),
      css('te_text', 'Text', '--te-text', '#e6e6e6'),
      css('te_curline', 'Current Line', '--te-curline', '#ffffff0e', { alpha: true }),
      css('te_selection', 'Selection', '--te-selection', '#4772b38c', { alpha: true }),
      css('sy_builtin', 'Built-in', '--sy-builtin', '#e62e67'),
      css('sy_symbols', 'Symbols', '--sy-symbols', '#ff734d'),
      css('sy_special', 'Special', '--sy-special', '#689d06'),
      css('sy_preprocessor', 'Decorator', '--sy-preprocessor', '#9c73e6'),
      css('sy_reserved', 'Reserved', '--sy-reserved', '#c4753b'),
      css('sy_comment', 'Comment', '--sy-comment', '#939393'),
      css('sy_string', 'String', '--sy-string', '#e6d573'),
      css('sy_numbers', 'Numbers', '--sy-numbers', '#48d9e6'),
    ],
  },
  {
    id: 'console',
    label: 'Python Console',
    items: [
      css('pc_bg', 'Background', '--pc-bg', '#1d1d1d'),
      css('pc_output', 'Output', '--pc-output', '#71a8ff'),
      css('pc_input', 'Input', '--pc-input', '#f2f2f2'),
      css('pc_info', 'Info', '--pc-info', '#95d600'),
      css('pc_error', 'Error', '--pc-error', '#ff4d84'),
      css('pc_cursor', 'Cursor', '--pc-cursor', '#dc6060'),
    ],
  },
];

export const ALL_ITEMS: ThemeItem[] = THEME_GROUPS.flatMap((g) => g.items);
const BY_ID = new Map(ALL_ITEMS.map((i) => [i.id, i]));

export function defaultValues(): ThemeValues {
  return Object.fromEntries(ALL_ITEMS.map((i) => [i.id, i.def]));
}

/** CSS text for a theme: :root variables plus editor-scoped overrides. */
export function themeCss(v: ThemeValues): string {
  const vars: string[] = [];
  for (const it of ALL_ITEMS) {
    if (!it.css) continue;
    const val = v[it.id] ?? it.def;
    vars.push(`${it.css}: ${it.number ? `${Number(val) || 0}px` : cssColor(val)};`);
  }
  const get = (id: string) => v[id] ?? BY_ID.get(id)!.def;
  const [hr, hg, hb] = parseHex(v.hover ?? '#ffffff');
  vars.push(`--hl-rgb: ${Math.round(hr * 255)}, ${Math.round(hg * 255)}, ${Math.round(hb * 255)};`);
  for (let l = 0x08; l <= 0xff; l++) {
    const x = l.toString(16).padStart(2, '0');
    vars.push(`--g-${x}: ${ramp(l, SURFACE_REFS, get)};`);
    if (l >= 0x60) vars.push(`--t-${x}: ${ramp(l, TEXT_REFS, get)};`);
  }
  const dark = luminance(v.region ?? '#303030') < 0.4;
  vars.push(`color-scheme: ${dark ? 'dark' : 'light'};`);
  const body = vars.join('\n  ');
  // node and text editor variables are declared on their own elements too
  return `html:root, html .nd-editor {\n  ${body}\n}`;
}

export function luminance(hex: string) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

let styleEl: HTMLStyleElement | null = null;

/** Apply theme values everywhere (CSS variables and canvas colour tables). */
export function applyThemeValues(v: ThemeValues) {
  if (typeof document === 'undefined') return;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'p3d-theme';
  }
  // keep it last so it wins over style sheets loaded later
  document.head.append(styleEl);
  styleEl.textContent = themeCss(v);
  // canvas editors use the same grey ramps
  const get = (id: string) => v[id] ?? BY_ID.get(id)!.def;
  const sg = new Map<number, string>(),
    tg = new Map<number, string>();
  for (let l = 0x08; l <= 0xff; l++) {
    sg.set(l, ramp(l, SURFACE_REFS, get));
    if (l >= 0x60) tg.set(l, ramp(l, TEXT_REFS, get));
  }
  setCanvasGreys(sg, tg);
  for (const it of ALL_ITEMS) if (it.set) it.set(v[it.id] ?? it.def);
  document.documentElement.dataset.theme = luminance(v.region ?? '#303030') < 0.4 ? 'dark' : 'light';
  // (themes also apply before the app exists, so the first frame already has the colours)
  if (app) app.changed('ui', 'view', 'select');
}

// ---------------------------------------------------------------------------
// built-in presets (original colour schemes)

/** The colours the app is drawn with when no theme is set. */
const DEFAULT: ThemePreset = { id: 'DEFAULT', label: 'Default', values: {} };

const GRAPHITE: ThemePreset = {
  id: 'GRAPHITE',
  label: 'Graphite',
  values: {
    text: '#dcdfe2', text_dim: '#8d949b', text_hi: '#ffffff', accent: '#2f8f83', accent_hi: '#3aa597', text_on_accent: '#ffffff',
    button: '#4a4e52', button_hover: '#585d62', button_outline: '#34373a', field: '#191b1d', number: '#4a4e52', number_hover: '#53585d', toggle: '#4a4e52', tab: '#191b1d', tab_on: '#2a2c2e',
    menu: '#232527', menu_back: '#141516', menu_item_hl: '#2f8f83', panel: '#36393c', panel_sub: '#00000026', panel_outline: '#ffffff0f', hover: '#ffffff', radius: '3',
    keyed: '#c9b23a', animated: '#4f9e5a', driven: '#8f4fd1', error: '#a3242b', warning: '#b08a2e', info: '#2d5a86',
    border: '#121314', topbar: '#151617', header: '#2a2c2e', region: '#2a2c2e', x: '#f0425c', y: '#86d62c', z: '#3a8ff5',
    'v3d.background': '#2e3236', 'v3d.grid': '#4a4f55', 'v3d.wire': '#0b0c0d', 'v3d.wire_edit': '#0b0c0d', object_selected: '#e8772e', object_active: '#ffc061',
    'mesh.vertSel': '#ff8f3d', 'mesh.edgeSel': '#ffb05a', 'mesh.edgeModeSel': '#ffd75a', 'mesh.faceSel': '#ffa64a',
    'anim.back': '#2a2c2e', 'anim.channelBack': '#202224', 'anim.rulerBack': '#25272a', 'anim.playhead': '#2f8f83',
    nd_back: '#191b1d', nd_grid: '#272a2d', nd_grid_major: '#30343a', nd_body: '#2c2f32', nd_sel: '#e8772e',
    outliner: '#232527', ol_selected: '#203d3a', ol_active: '#2b5953', ol_sel_text: '#f08a3c', ol_act_text: '#ffc061',
    te_bg: '#1e2022', te_gutter_bg: '#191b1d', te_gutter_fg: '#6b7177', te_selection: '#2f8f838c',
    sy_builtin: '#e5677d', sy_symbols: '#e8955a', sy_special: '#7fb24a', sy_preprocessor: '#a88be0', sy_reserved: '#d29560', sy_comment: '#7f878f', sy_string: '#d9c77a', sy_numbers: '#5cc8d4',
    pc_bg: '#191b1d', pc_output: '#7fb4e6', pc_info: '#86c64a', pc_error: '#ef6a8a',
  },
};

const LIGHT: ThemePreset = {
  id: 'LIGHT',
  label: 'Light',
  values: {
    text: '#1f2328', text_dim: '#5f6670', text_hi: '#000000', accent: '#2f6fd6', accent_hi: '#4a84e0', text_on_accent: '#ffffff',
    button: '#cbd0d6', button_hover: '#bec4cc', button_outline: '#a9afb7', field: '#ffffff', number: '#cfd3d9', number_hover: '#c3c8cf', toggle: '#c3c8cf', tab: '#dfe2e6', tab_on: '#ffffff',
    menu: '#f7f8fa', menu_back: '#e6e8eb', menu_item_hl: '#2f6fd6', panel: '#e2e5e9', panel_sub: '#0000000d', panel_outline: '#0000001a', hover: '#000000', radius: '4',
    keyed: '#c2a400', animated: '#3e9a3a', driven: '#8a35c9', error: '#d64545', warning: '#d49b1f', info: '#4a7fd1',
    border: '#b9bec5', topbar: '#dfe2e6', header: '#e9ebee', region: '#eef0f2', x: '#e02f4d', y: '#4f9a00', z: '#1f6fe0',
    'v3d.background': '#c9ccd1', 'v3d.grid': '#9fa4ab', 'v3d.wire': '#2a2d31', 'v3d.wire_edit': '#2a2d31', object_selected: '#e86a10', object_active: '#f0a300',
    'mesh.vert': '#2a2d31', 'mesh.edge': '#2a2d31', 'mesh.vertSel': '#ff6a00', 'mesh.edgeSel': '#ff8a00', 'mesh.edgeModeSel': '#f2b600', 'mesh.faceSel': '#ff9a2a', 'mesh.active': '#ffffff',
    'anim.back': '#eef0f2', 'anim.channelBack': '#e4e7ea', 'anim.rulerBack': '#dfe2e6', 'anim.rulerText': '#3d434a', 'anim.grid': '#0000001f', 'anim.gridMinor': '#00000012',
    'anim.playhead': '#2f6fd6', 'anim.outOfRange': '#00000014', 'anim.summary': '#d9a0a080', 'anim.objectRow': '#8fb6e080', 'anim.groupRow': '#9ccfbf99', 'anim.channelRow': '#ffffff99', 'anim.channelRowSel': '#7ad07a40',
    'anim.vertex': '#2a2d31', 'anim.vertexSelect': '#ff7a00', 'anim.nlaStrip': '#cfd3d8', 'anim.nlaStripSelected': '#ff9a2a',
    'key.KEYFRAME.0': '#6b7078', 'key.KEYFRAME.1': '#ff9a00',
    nd_back: '#d7dade', nd_grid: '#c4c8cd', nd_grid_major: '#b4b9bf', nd_body: '#f4f5f7', nd_text: '#1f2328', nd_sel: '#e86a10', nd_active: '#000000',
    'node.input': '#d97a96', 'node.output': '#b5596f', 'node.shader': '#6dbb6d', 'node.texture': '#e0a060', 'node.color': '#d0c85a', 'node.vector': '#8a8ae0', 'node.converter': '#5fa8d6', 'node.geometry': '#4fc0a3', 'node.attribute': '#7f8fc9', 'node.group': '#7fb0b0', 'node.layout': '#a9adb3', 'node.script': '#88b388', 'node.filter': '#a58fc0', 'node.distort': '#7cc4c4', 'node.matte': '#c7a6a6',
    outliner: '#f5f6f8', ol_selected: '#cfe0fa', ol_active: '#a9c7f5', ol_sel_text: '#c25200', ol_act_text: '#a35d00',
    te_bg: '#fbfbfc', te_gutter_bg: '#eef0f2', te_gutter_fg: '#8a9099', te_text: '#1f2328', te_curline: '#0000000a', te_selection: '#2f6fd640',
    sy_builtin: '#c0245a', sy_symbols: '#c25a1c', sy_special: '#3f7f00', sy_preprocessor: '#7a4fc9', sy_reserved: '#9a5a1f', sy_comment: '#7b828a', sy_string: '#8a6d00', sy_numbers: '#00808c',
    pc_bg: '#ffffff', pc_output: '#1f5fbf', pc_input: '#1f2328', pc_info: '#3f7f00', pc_error: '#c0245a', pc_cursor: '#c0245a',
  },
};

const HIGH_CONTRAST: ThemePreset = {
  id: 'HIGH_CONTRAST',
  label: 'High Contrast',
  values: {
    text: '#ffffff', text_dim: '#d0d0d0', text_hi: '#ffffff', accent: '#ffd200', accent_hi: '#ffe14d', text_on_accent: '#000000',
    button: '#262626', button_hover: '#3d3d3d', button_outline: '#ffffff', field: '#000000', number: '#262626', number_hover: '#3d3d3d', toggle: '#262626', tab: '#000000', tab_on: '#333333',
    menu: '#000000', menu_back: '#000000', menu_item_hl: '#ffd200', panel: '#141414', panel_sub: '#00000000', panel_outline: '#ffffff80', hover: '#ffffff', radius: '2',
    keyed: '#ffe600', animated: '#38e038', driven: '#c45cff', error: '#ff2a2a', warning: '#ffb300', info: '#3d8bff',
    border: '#ffffff', topbar: '#000000', header: '#0a0a0a', region: '#000000', x: '#ff3355', y: '#66ff00', z: '#33a0ff',
    'v3d.background': '#101010', 'v3d.grid': '#6e6e6e', 'v3d.wire': '#ffffff', 'v3d.wire_edit': '#ffffff', object_selected: '#ff8c00', object_active: '#ffff00',
    'mesh.vert': '#ffffff', 'mesh.edge': '#d0d0d0', 'mesh.vertSel': '#ff8c00', 'mesh.edgeSel': '#ffb000', 'mesh.edgeModeSel': '#ffff00', 'mesh.faceSel': '#ffa500', 'mesh.active': '#00ffff',
    'anim.back': '#000000', 'anim.channelBack': '#000000', 'anim.rulerBack': '#0a0a0a', 'anim.rulerText': '#ffffff', 'anim.grid': '#ffffff40', 'anim.gridMinor': '#ffffff1f', 'anim.playhead': '#ffd200',
    'anim.vertex': '#ffffff', 'anim.vertexSelect': '#ff8c00', 'key.KEYFRAME.0': '#ffffff', 'key.KEYFRAME.1': '#ffd200',
    nd_back: '#000000', nd_grid: '#2a2a2a', nd_grid_major: '#4a4a4a', nd_body: '#141414', nd_text: '#ffffff', nd_sel: '#ff8c00', nd_active: '#ffff00',
    outliner: '#000000', ol_selected: '#333300', ol_active: '#5c5c00', ol_sel_text: '#ff9d1a', ol_act_text: '#ffff00',
    te_bg: '#000000', te_gutter_bg: '#000000', te_gutter_fg: '#bdbdbd', te_text: '#ffffff', te_curline: '#ffffff1f', te_selection: '#ffd20066',
    sy_builtin: '#ff6b9a', sy_symbols: '#ffb36b', sy_special: '#9cff57', sy_preprocessor: '#d0a6ff', sy_reserved: '#ffc27a', sy_comment: '#c0c0c0', sy_string: '#fff176', sy_numbers: '#6bf0ff',
    pc_bg: '#000000', pc_output: '#8fc4ff', pc_input: '#ffffff', pc_info: '#9cff57', pc_error: '#ff6b9a', pc_cursor: '#ffd200',
  },
};

const MIDNIGHT: ThemePreset = {
  id: 'MIDNIGHT',
  label: 'Midnight',
  values: {
    text: '#d8dcf0', text_dim: '#8a90b0', text_hi: '#ffffff', accent: '#7a5cff', accent_hi: '#8d74ff', text_on_accent: '#ffffff',
    button: '#3a3f5c', button_hover: '#474d6e', button_outline: '#2a2e45', field: '#12141f', number: '#3a3f5c', number_hover: '#434968', toggle: '#3a3f5c', tab: '#12141f', tab_on: '#22253a',
    menu: '#1b1e2e', menu_back: '#0f111a', menu_item_hl: '#7a5cff', panel: '#2b2f47', panel_sub: '#00000026', panel_outline: '#ffffff12', hover: '#c8d0ff', radius: '5',
    keyed: '#e0c445', animated: '#4fc28a', driven: '#c06cff', error: '#c23a4f', warning: '#c99a3a', info: '#3c5fc2',
    border: '#0b0c14', topbar: '#0f111a', header: '#22253a', region: '#22253a', x: '#ff4f6e', y: '#8fe04a', z: '#4f9bff',
    'v3d.background': '#252a40', 'v3d.grid': '#3f4666', 'v3d.wire': '#05060b', 'v3d.wire_edit': '#05060b', object_selected: '#ff7a45', object_active: '#ffc36b',
    'anim.back': '#22253a', 'anim.channelBack': '#1a1d2d', 'anim.rulerBack': '#1e2133', 'anim.playhead': '#7a5cff',
    nd_back: '#12141f', nd_grid: '#1f2233', nd_grid_major: '#2a2e45', nd_body: '#262a40', nd_sel: '#ff7a45',
    outliner: '#1b1e2e', ol_selected: '#2a2552', ol_active: '#3d3480', ol_sel_text: '#ff8a5c', ol_act_text: '#ffc36b',
    te_bg: '#161828', te_gutter_bg: '#12141f', te_gutter_fg: '#5f6588', te_selection: '#7a5cff73',
    pc_bg: '#12141f',
  },
};

export const BUILTIN_THEMES: ThemePreset[] = [DEFAULT, GRAPHITE, MIDNIGHT, LIGHT, HIGH_CONTRAST];

/** Full values of a preset (unspecified items fall back to the defaults). */
export function presetValues(p: ThemePreset): ThemeValues {
  return { ...defaultValues(), ...p.values };
}

export function themeItem(id: string) {
  return BY_ID.get(id);
}

