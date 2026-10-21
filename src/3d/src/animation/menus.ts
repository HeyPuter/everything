// Header/context menus shared by the Dope Sheet ('action') and Graph Editor ('graph').
import type { MenuItem } from '../ui/menu';
import type { Interpolation, KeyHandleType, Keyframe } from '../data/types';
import type { AnimEditor } from './animeditor';
import { KEY_TYPES } from './footer';

export type Prefix = 'action' | 'graph';

export const INTERPOLATION_ITEMS: {
  heading: string;
  items: [Interpolation, string][];
}[] = [
  {
    heading: 'Interpolation',
    items: [
      ['CONSTANT', 'Constant'],
      ['LINEAR', 'Linear'],
      ['BEZIER', 'Bézier'],
    ],
  },
  {
    heading: 'Easing (by strength)',
    items: [
      ['SINE', 'Sinusoidal'],
      ['QUAD', 'Quadratic'],
      ['CUBIC', 'Cubic'],
      ['QUART', 'Quartic'],
      ['QUINT', 'Quintic'],
      ['EXPO', 'Exponential'],
      ['CIRC', 'Circular'],
    ],
  },
  {
    heading: 'Dynamic Effects',
    items: [
      ['BACK', 'Back'],
      ['BOUNCE', 'Bounce'],
      ['ELASTIC', 'Elastic'],
    ],
  },
];

export const HANDLE_ITEMS: [KeyHandleType, string][] = [
  ['FREE', 'Free'],
  ['VECTOR', 'Vector'],
  ['ALIGNED', 'Aligned'],
  ['AUTO', 'Automatic'],
  ['AUTO_CLAMPED', 'Auto Clamped'],
];

export const EASING_ITEMS: [Keyframe['easing'], string][] = [
  ['AUTO', 'Automatic Easing'],
  ['EASE_IN', 'Ease In'],
  ['EASE_OUT', 'Ease Out'],
  ['EASE_IN_OUT', 'Ease In and Out'],
];

export const EXTRAPOLATION_ITEMS: [string, string][] = [
  ['CONSTANT', 'Constant Extrapolation'],
  ['LINEAR', 'Linear Extrapolation'],
  ['MAKE_CYCLIC', 'Make Cyclic (F-Modifier)'],
  ['CLEAR_CYCLIC', 'Clear Cyclic (F-Modifier)'],
];

export function interpolationMenu(p: Prefix): MenuItem[] {
  const out: MenuItem[] = [];
  for (const sec of INTERPOLATION_ITEMS) {
    out.push({ heading: sec.heading });
    for (const [v, l] of sec.items) out.push({ label: l, op: `${p}.interpolation_type`, props: { type: v } });
  }
  return out;
}
export const handleMenu = (p: Prefix): MenuItem[] =>
  HANDLE_ITEMS.map(([v, l]) => ({
    label: l,
    op: `${p}.handle_type`,
    props: { type: v },
  }));
export const easingMenu = (p: Prefix): MenuItem[] =>
  EASING_ITEMS.map(([v, l]) => ({
    label: l,
    op: `${p}.easing_type`,
    props: { type: v },
  }));
export const keyTypeMenu = (p: Prefix): MenuItem[] =>
  KEY_TYPES.map(([v, l]) => ({
    label: l,
    op: `${p}.keyframe_type`,
    props: { type: v },
  }));
export const extrapolationMenu = (p: Prefix): MenuItem[] =>
  EXTRAPOLATION_ITEMS.map(([v, l]) => ({
    label: l,
    op: `${p}.extrapolation_type`,
    props: { type: v },
  }));

export function snapMenu(p: Prefix): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: 'Selection to Current Frame',
      op: `${p}.snap`,
      props: { type: 'CFRA' },
    },
    {
      label: 'Selection to Nearest Frame',
      op: `${p}.snap`,
      props: { type: 'NEAREST_FRAME' },
    },
    {
      label: 'Selection to Nearest Second',
      op: `${p}.snap`,
      props: { type: 'NEAREST_SECOND' },
    },
    {
      label: 'Selection to Nearest Marker',
      op: `${p}.snap`,
      props: { type: 'NEAREST_MARKER' },
    },
  ];
  if (p === 'graph') {
    items.push(
      {
        label: 'Selection to Cursor Value',
        op: 'graph.snap',
        props: { type: 'VALUE' },
      },
      {
        label: 'Flatten Handles',
        op: 'graph.snap',
        props: { type: 'HORIZONTAL' },
      },
      { separator: true },
      {
        label: 'Cursor to Selected',
        op: 'graph.frame_jump',
        shortcut: 'Ctrl G',
      },
      { label: 'Cursor Value to Selection', op: 'graph.snap_cursor_value' },
    );
  } else
    items.push(
      { separator: true },
      {
        label: 'Current Frame to Selection',
        op: 'action.frame_jump',
        shortcut: 'Ctrl G',
      },
    );
  return items;
}

export function mirrorMenu(p: Prefix): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: 'By Times Over Current Frame',
      op: `${p}.mirror`,
      props: { type: 'CFRA' },
    },
    {
      label: 'By Values Over Zero Value',
      op: `${p}.mirror`,
      props: { type: 'XAXIS' },
    },
    {
      label: 'By Times Over Zero Time',
      op: `${p}.mirror`,
      props: { type: 'YAXIS' },
    },
    {
      label: 'By Times Over First Selected Marker',
      op: `${p}.mirror`,
      props: { type: 'MARKER' },
    },
  ];
  if (p === 'graph')
    items.splice(1, 0, {
      label: 'By Values Over Cursor Value',
      op: 'graph.mirror',
      props: { type: 'VALUE' },
    });
  return items;
}

export function selectMenu(p: Prefix): MenuItem[] {
  const graph = p === 'graph';
  const lasso: MenuItem = {
    label: 'Lasso Select',
    shortcut: 'Ctrl RMB drag',
    submenu: () => [
      { label: 'Set', op: `${p}.select_lasso`, props: { mode: 'SET' } },
      { label: 'Extend', op: `${p}.select_lasso`, props: { mode: 'ADD' } },
      { label: 'Subtract', op: `${p}.select_lasso`, props: { mode: 'SUB' } },
    ],
  };
  return [
    { label: 'All', op: `${p}.select_all`, props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: `${p}.select_all`, props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: `${p}.select_all`, props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    ...(graph ? [{ label: 'Box Select (Include Handles)', op: 'graph.select_box', props: { include_handles: true } }] : []),
    { label: 'Box Select (Axis Range)', op: `${p}.select_box`, props: { axis_range: true }, shortcut: 'Alt B' },
    { label: 'Box Select', op: `${p}.select_box`, props: graph ? { include_handles: false } : {}, shortcut: 'B' },
    { label: 'Circle Select', op: `${p}.select_circle`, shortcut: 'C' },
    lasso,
    { separator: true },
    { label: 'More', op: `${p}.select_more`, shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: `${p}.select_less`, shortcut: 'Ctrl Numpad -' },
    { separator: true },
    { label: 'Select Linked', op: `${p}.select_linked`, shortcut: 'Ctrl L' },
    { separator: true },
    { label: 'Columns on Selected Keys', op: `${p}.select_column`, props: { mode: 'KEYS' }, shortcut: 'K' },
    { label: 'Column on Current Frame', op: `${p}.select_column`, props: { mode: 'CFRA' }, shortcut: 'Ctrl K' },
    { label: 'Columns on Selected Markers', op: `${p}.select_column`, props: { mode: 'MARKERS_COLUMN' }, shortcut: 'Shift K' },
    { label: 'Between Selected Markers', op: `${p}.select_column`, props: { mode: 'MARKERS_BETWEEN' }, shortcut: 'Alt K' },
    { separator: true },
    { label: 'Before Current Frame', op: `${p}.select_leftright`, props: { mode: 'LEFT' }, shortcut: '[' },
    { label: 'After Current Frame', op: `${p}.select_leftright`, props: { mode: 'RIGHT' }, shortcut: ']' },
    ...(!graph ? [{ separator: true }, { label: 'Select By Type', submenu: () => KEY_TYPES.map(([v, l]) => ({ label: l, op: 'action.select_by_type', props: { type: v } })) }] : []),
    ...(graph
      ? [
          { separator: true },
          { label: 'Select Handles', op: 'graph.select_key_handles', props: { left_handle_action: 'SELECT', right_handle_action: 'SELECT', key_action: 'DESELECT' } },
          { label: 'Select Key', op: 'graph.select_key_handles', props: { left_handle_action: 'DESELECT', right_handle_action: 'DESELECT', key_action: 'SELECT' } },
        ]
      : []),
  ];
}

/** Preview range entries shared by the animation editors' View menus. */
export function previewRangeMenu(setSelected: string): MenuItem[] {
  return [
    { label: 'Set Preview Range', op: 'anim.previewrange_set', shortcut: 'P' },
    { label: 'Clear Preview Range', op: 'anim.previewrange_clear', shortcut: 'Alt P' },
    { label: 'Set Preview Range to Selected', op: setSelected, shortcut: 'Ctrl Alt P' },
  ];
}

export function viewMenuCommon(p: Prefix, ed: AnimEditor): MenuItem[] {
  return [
    { label: 'Show Seconds', checked: ed.showSeconds, op: 'anim.show_seconds_toggle', shortcut: 'Ctrl T' },
    { label: 'Only Show Errors', checked: ed.onlyErrors, action: () => ((ed.onlyErrors = !ed.onlyErrors), ed.refresh()) },
    {
      label: 'Show Sliders',
      checked: ed.showSliders,
      action: () => {
        ed.showSliders = !ed.showSliders;
        // make room for the value fields next to the channel names
        if (ed.showSliders) ed.chWidth = Math.max(ed.chWidth, 300);
        ed.refresh();
      },
    },
    { separator: true },
    { label: 'Frame Selected', op: `${p}.view_selected`, shortcut: 'Numpad .' },
    { label: 'Frame All', op: `${p}.view_all`, shortcut: 'Home' },
    { label: 'Frame Scene Range', op: 'anim.scene_range_frame' },
    { label: 'Go to Current Frame', op: `${p}.view_frame`, shortcut: 'Numpad 0' },
    ...(p === 'graph' ? [{ separator: true }, { label: 'Local View', op: 'graph.local_view', shortcut: '/' }, { label: 'Create Ghost Curves', op: 'graph.ghost_curves_create' }, { label: 'Clear Ghost Curves', op: 'graph.ghost_curves_clear' }] : []),
    { separator: true },
    ...previewRangeMenu(`${p}.previewrange_set`),
    { separator: true },
    {
      label: p === 'action' ? 'Toggle Graph Editor' : 'Toggle Dope Sheet',
      op: 'anim.switch_editor',
      props: { type: p === 'action' ? 'GRAPH' : 'DOPESHEET' },
      shortcut: 'Ctrl Tab',
    },
    {
      label: ed.area.screen.maximized === ed.area ? 'Back to Previous' : 'Maximize Area',
      op: 'screen.screen_full_area',
      shortcut: 'Ctrl Space',
    },
  ];
}

function settingMenu(op: string, graph: boolean): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'Mute', op, props: { type: 'MUTE' } },
    { label: 'Lock', op, props: { type: 'PROTECT' } },
  ];
  if (graph) items.push({ label: 'Visibility', op, props: { type: 'VISIBLE' } });
  return items;
}

export function moveChannelsMenu(): MenuItem[] {
  return [
    { label: 'To Top', op: 'anim.channels_move', props: { direction: 'TOP' }, shortcut: 'Shift Page Up' },
    { label: 'Up', op: 'anim.channels_move', props: { direction: 'UP' }, shortcut: 'Page Up' },
    { label: 'Down', op: 'anim.channels_move', props: { direction: 'DOWN' }, shortcut: 'Page Down' },
    { label: 'To Bottom', op: 'anim.channels_move', props: { direction: 'BOTTOM' }, shortcut: 'Shift Page Down' },
  ];
}

export function channelMenu(p: Prefix): MenuItem[] {
  const graph = p === 'graph';
  const items: MenuItem[] = [
    { label: 'Delete Channels', op: 'anim.channels_delete', shortcut: 'X' },
    { label: 'Clean Channels', op: `${p}.clean`, props: { channels: true } },
    { separator: true },
    { label: 'Group Channels', op: 'anim.channels_group', shortcut: 'Ctrl G' },
    { label: 'Ungroup Channels', op: 'anim.channels_ungroup', shortcut: 'Ctrl Alt G' },
    { separator: true },
    { label: 'Toggle Channel Setting', submenu: () => settingMenu('anim.channels_setting_toggle', graph), shortcut: 'Shift W' },
    { label: 'Enable Channel Setting', submenu: () => settingMenu('anim.channels_setting_enable', graph), shortcut: 'Shift Ctrl W' },
    { label: 'Disable Channel Setting', submenu: () => settingMenu('anim.channels_setting_disable', graph), shortcut: 'Alt W' },
    { separator: true },
    { label: 'Toggle Channel Editability', op: 'anim.channels_editable_toggle', shortcut: 'Tab' },
    { label: 'Extrapolation Mode', submenu: () => extrapolationMenu(p), shortcut: 'Shift E' },
    ...(graph ? [{ label: 'F-Curve Modifiers', submenu: fmodifierMenu }] : []),
    { separator: true },
    { label: 'Expand Channels', op: 'anim.channels_expand', shortcut: 'Numpad +' },
    { label: 'Collapse Channels', op: 'anim.channels_collapse', shortcut: 'Numpad -' },
    { separator: true },
    { label: 'Move Channels', submenu: moveChannelsMenu },
    { separator: true },
    { label: 'Revive Disabled F-Curves', op: 'anim.channels_fcurves_enable' },
    { separator: true },
    { label: 'Bake Channels', op: 'anim.channels_bake' },
    ...(graph
      ? [
          { label: 'Keys to Samples', op: 'graph.keys_to_samples', shortcut: 'Alt C' },
          { label: 'Samples to Keys', op: 'graph.samples_to_keys' },
          { label: 'Sound to Samples…', op: 'graph.sound_to_samples' },
          { label: 'Discontinuity (Euler) Filter', op: 'graph.euler_filter' },
        ]
      : []),
    { separator: true },
    { label: 'Frame Selected Channels', op: 'anim.channels_view_selected', shortcut: 'Numpad .' },
  ];
  if (graph)
    items.push(
      { separator: true },
      { label: 'Hide Selected Curves', op: 'graph.hide', shortcut: 'H' },
      { label: 'Hide Unselected Curves', op: 'graph.hide', props: { unselected: true }, shortcut: 'Shift H' },
      { label: 'Reveal Curves', op: 'graph.reveal', shortcut: 'Alt H' },
    );
  return items;
}

export function blendMenu(): MenuItem[] {
  return [
    { label: 'Breakdown', op: 'graph.breakdown' },
    { label: 'Blend to Neighbor', op: 'graph.blend_to_neighbor' },
    { label: 'Blend to Default Value', op: 'graph.blend_to_default' },
    { label: 'Ease', op: 'graph.ease' },
    { label: 'Blend Offset', op: 'graph.blend_offset' },
    { label: 'Blend to Ease', op: 'graph.blend_to_ease' },
    { label: 'Match Slope', op: 'graph.match_slope' },
    { label: 'Push Pull', op: 'graph.push_pull' },
    { label: 'Shear Keys', op: 'graph.shear' },
    { label: 'Scale Average', op: 'graph.scale_average' },
    { label: 'Scale from Neighbor', op: 'graph.scale_from_neighbor' },
    { label: 'Time Offset', op: 'graph.time_offset' },
  ];
}

export function smoothMenu(): MenuItem[] {
  return [
    { label: 'Smooth (Gaussian)', op: 'graph.gaussian_smooth' },
    { label: 'Smooth (Legacy)', op: 'graph.smooth', shortcut: 'Alt O' },
    { label: 'Butterworth Smooth', op: 'graph.butterworth_smooth' },
  ];
}

export function densityMenu(): MenuItem[] {
  return [
    { label: 'Decimate (Ratio)', op: 'graph.decimate', props: { mode: 'RATIO' } },
    { label: 'Decimate (Allowed Change)', op: 'graph.decimate', props: { mode: 'ERROR' } },
    { label: 'Bake Keyframes', op: 'graph.bake_keys', shortcut: 'Shift Alt O' },
    { separator: true },
    { label: 'Clean Keyframes', op: 'graph.clean' },
  ];
}

export const FMODIFIER_TYPES: [string, string][] = [
  ['GENERATOR', 'Generator'],
  ['FNGENERATOR', 'Built-In Function'],
  ['ENVELOPE', 'Envelope'],
  ['CYCLES', 'Cycles'],
  ['NOISE', 'Noise'],
  ['LIMITS', 'Limits'],
  ['STEPPED', 'Stepped Interpolation'],
];

export function fmodifierMenu(): MenuItem[] {
  return [
    {
      label: 'Add F-Curve Modifier',
      submenu: () => FMODIFIER_TYPES.map(([v, l]) => ({ label: l, op: 'graph.fmodifier_add', props: { type: v, only_active: false } })),
      shortcut: 'Shift Ctrl M',
    },
    { separator: true },
    { label: 'Copy F-Modifiers', op: 'graph.fmodifier_copy' },
    { label: 'Paste F-Modifiers', op: 'graph.fmodifier_paste' },
    { label: 'Delete F-Modifiers', op: 'graph.fmodifier_delete' },
  ];
}

export function insertKeyMenu(p: Prefix): MenuItem[] {
  return p === 'action'
    ? [
        { label: 'All Channels', op: 'action.keyframe_insert', props: { type: 'ALL' } },
        { label: 'Only Selected Channels', op: 'action.keyframe_insert', props: { type: 'SEL' } },
        { label: 'In Active Group', op: 'action.keyframe_insert', props: { type: 'GROUP' } },
      ]
    : [
        { label: 'All Channels', op: 'graph.keyframe_insert', props: { type: 'ALL' } },
        { label: 'Only Selected Channels', op: 'graph.keyframe_insert', props: { type: 'SEL' } },
        { label: 'Only Active F-Curve', op: 'graph.keyframe_insert', props: { type: 'ACTIVE' } },
        { separator: true },
        { label: 'Active Channels at Cursor', op: 'graph.keyframe_insert', props: { type: 'CURSOR_ACTIVE' } },
        { label: 'Selected Channels at Cursor', op: 'graph.keyframe_insert', props: { type: 'CURSOR_SEL' } },
      ];
}

export function keyMenu(p: Prefix): MenuItem[] {
  const graph = p === 'graph';
  const transform: MenuItem[] = !graph
    ? [
        { label: 'Move', op: 'action.transform', props: { mode: 'TIME_TRANSLATE' }, shortcut: 'G' },
        { label: 'Extend', op: 'action.transform', props: { mode: 'TIME_EXTEND' }, shortcut: 'E' },
        { label: 'Slide', op: 'action.transform', props: { mode: 'TIME_SLIDE' }, shortcut: 'Shift T' },
        { label: 'Scale', op: 'action.transform', props: { mode: 'TIME_SCALE' }, shortcut: 'S' },
      ]
    : [
        { label: 'Move', op: 'graph.transform', props: { mode: 'TRANSLATION' }, shortcut: 'G' },
        { label: 'Extend', op: 'graph.transform', props: { mode: 'TIME_EXTEND' }, shortcut: 'E' },
        { label: 'Rotate', op: 'graph.transform', props: { mode: 'ROTATION' }, shortcut: 'R' },
        { label: 'Scale', op: 'graph.transform', props: { mode: 'RESIZE' }, shortcut: 'S' },
      ];
  const shape: MenuItem[] = graph
    ? [
        { label: 'Handle Type', submenu: () => handleMenu(p), shortcut: 'V' },
        { label: 'Interpolation Mode', submenu: () => interpolationMenu(p), shortcut: 'T' },
        { label: 'Easing Mode', submenu: () => easingMenu(p), shortcut: 'Ctrl E' },
        { separator: true },
        { label: 'Density', submenu: densityMenu },
        { label: 'Blend', submenu: blendMenu, shortcut: 'Alt D' },
        { label: 'Smooth', submenu: smoothMenu, shortcut: 'Alt S' },
      ]
    : [
        { label: 'Keyframe Type', submenu: () => keyTypeMenu(p), shortcut: 'R' },
        { label: 'Handle Type', submenu: () => handleMenu(p), shortcut: 'V' },
        { label: 'Interpolation Mode', submenu: () => interpolationMenu(p), shortcut: 'T' },
        { label: 'Easing Mode', submenu: () => easingMenu(p), shortcut: 'Ctrl E' },
        { separator: true },
        { label: 'Clean Keyframes', op: 'action.clean' },
        { label: 'Bake Keyframes', op: 'action.bake_keys', shortcut: 'Shift Alt O' },
        { separator: true },
        { label: 'Discontinuity (Euler) Filter', op: 'graph.euler_filter' },
      ];
  return [
    { label: 'Transform', submenu: () => transform },
    { label: 'Snap', submenu: () => snapMenu(p), shortcut: 'Shift S' },
    { label: 'Mirror', submenu: () => mirrorMenu(p), shortcut: 'Ctrl M' },
    { separator: true },
    { label: 'Jump to Selected', op: `${p}.frame_jump`, shortcut: 'Ctrl G' },
    { separator: true },
    graph ? { label: 'Insert', submenu: () => insertKeyMenu(p), shortcut: 'I' } : { label: 'Insert Keyframes', op: 'action.keyframe_insert', shortcut: 'I' },
    { label: 'Copy', op: `${p}.copy`, shortcut: 'Ctrl C' },
    { label: 'Paste', op: `${p}.paste`, shortcut: 'Ctrl V' },
    { label: 'Paste Flipped', op: `${p}.paste`, props: { flipped: true }, shortcut: 'Shift Ctrl V' },
    { label: 'Duplicate', op: `${p}.duplicate_move`, shortcut: 'Shift D' },
    { label: 'Delete', op: `${p}.delete`, shortcut: 'X' },
    { separator: true },
    ...shape,
  ];
}
