// Text strip style presets: a few built-in looks plus presets saved by the user (kept in this
// browser). A preset holds the style of a text strip (size, colours, outline, shadow, box,
// alignment); applying it leaves the text and its placement alone.
import { app, registerOperators } from '../app/app';
import type { MenuItem } from '../ui/menu';
import type { Strip } from './types';
import { activeStrip, hasEditor, selectedStrips } from './context';

export const STYLE_KEYS = [
  'font_size',
  'color',
  'use_bold',
  'use_italic',
  'use_outline',
  'outline_color',
  'outline_width',
  'use_shadow',
  'shadow_color',
  'shadow_angle',
  'shadow_offset',
  'shadow_blur',
  'use_box',
  'box_color',
  'box_margin',
  'box_roundness',
  'alignment_x',
] as const;
export type TextStyle = Partial<Pick<Strip, (typeof STYLE_KEYS)[number]>>;

export const BUILTIN_STYLES: [string, TextStyle][] = [
  [
    'Subtitle',
    {
      font_size: 48,
      color: [1, 1, 1, 1],
      use_bold: false,
      use_italic: false,
      use_outline: true,
      outline_color: [0, 0, 0, 1],
      outline_width: 0.05,
      use_shadow: false,
      use_box: false,
      alignment_x: 'CENTER',
    },
  ],
  [
    'Title',
    {
      font_size: 120,
      color: [1, 1, 1, 1],
      use_bold: true,
      use_italic: false,
      use_outline: false,
      use_shadow: true,
      shadow_color: [0, 0, 0, 0.8],
      shadow_angle: 0.7854,
      shadow_offset: 0.04,
      shadow_blur: 0.1,
      use_box: false,
      alignment_x: 'CENTER',
    },
  ],
  [
    'Caption Box',
    {
      font_size: 40,
      color: [1, 1, 1, 1],
      use_bold: false,
      use_italic: false,
      use_outline: false,
      use_shadow: false,
      use_box: true,
      box_color: [0, 0, 0, 0.7],
      box_margin: 0.02,
      box_roundness: 0.3,
      alignment_x: 'LEFT',
    },
  ],
];

const STORE = 'seq-text-style-presets';

export function userStyles(): [string, TextStyle][] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveUserStyles(list: [string, TextStyle][]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    app.report('WARNING', 'Presets cannot be saved in this browser');
  }
}

/** The style part of a text strip. */
export function styleOf(s: Strip): TextStyle {
  const out: Record<string, unknown> = {};
  for (const k of STYLE_KEYS) if (s[k] !== undefined) out[k] = structuredClone(s[k]);
  return out as TextStyle;
}

export function applyStyle(s: Strip, st: TextStyle) {
  for (const k of STYLE_KEYS) if (st[k] !== undefined) (s as unknown as Record<string, unknown>)[k] = structuredClone(st[k]);
}

const textStrips = () => (hasEditor() ? selectedStrips().filter((s) => s.type === 'TEXT') : []);

registerOperators([
  {
    idname: 'sequencer.text_strip_style_preset_add',
    label: 'Add Text Style Preset',
    description: 'Save the style of the active text strip as a preset (or remove the preset of that name)',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: 'Style' },
      { id: 'remove_active', label: 'Remove', type: 'bool', default: false },
    ],
    undo: false,
    poll: () => hasEditor() && activeStrip()?.type === 'TEXT',
    exec: (_c, p) => {
      const name = String(p.name ?? '').trim();
      if (!name) return 'CANCELLED';
      const list = userStyles().filter(([n]) => n !== name);
      if (!p.remove_active) list.push([name, styleOf(activeStrip()!)]);
      saveUserStyles(list);
      app.report('INFO', p.remove_active ? `Removed the preset "${name}"` : `Saved the preset "${name}"`);
      app.changed('ui');
    },
  },
  {
    idname: 'sequencer.text_strip_style_preset_apply',
    label: 'Apply Text Style Preset',
    description: 'Give the selected text strips the style of a preset',
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: () => textStrips().length > 0,
    exec: (_c, p) => {
      const st = [...BUILTIN_STYLES, ...userStyles()].find(([n]) => n === p.name)?.[1];
      if (!st) return 'CANCELLED';
      for (const s of textStrips()) applyStyle(s, st);
      app.changed('doc');
    },
  },
]);

/** Presets menu of the Style panel: apply, save the current style, remove saved ones. */
export function stylePresetMenu(promptName: (cb: (name: string) => void) => void): MenuItem[] {
  const users = userStyles();
  return [
    ...BUILTIN_STYLES.map(([n]) => ({ label: n, op: 'sequencer.text_strip_style_preset_apply', props: { name: n } })),
    ...(users.length ? [{ separator: true }, ...users.map(([n]) => ({ label: n, op: 'sequencer.text_strip_style_preset_apply', props: { name: n } }))] : []),
    { separator: true },
    { label: 'Save Current Style…', icon: 'add', action: () => promptName((name) => app.run('sequencer.text_strip_style_preset_add', { name })) },
    ...(users.length
      ? [{ label: 'Remove Saved Preset', submenu: () => users.map(([n]) => ({ label: n, icon: 'remove', op: 'sequencer.text_strip_style_preset_add', props: { name: n, remove_active: true } })) }]
      : []),
  ];
}
