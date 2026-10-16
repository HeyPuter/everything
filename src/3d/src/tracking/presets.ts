// Motion tracking presets: camera sensors, track colors and tracking settings. A few built-in
// presets plus the user's own, kept in the browser (per user, not per file). Each kind has an
// "add preset" operator (with remove) and a preset menu next to its panel.
import { app, registerOperators } from '../app/app';
import { promptText, openMenu, type MenuItem } from '../ui/menu';
import { h } from '../ui/h';
import { icon } from '../ui/icons';
import { contextClip } from './ops';
import { activeTrack, tobj, type MovieClipData, type MovieTrackingCamera, type MovieTrackingSettings } from './types';

type Kind = 'camera' | 'color' | 'settings';
type Values = Record<string, unknown>;
interface Preset {
  name: string;
  values: Values;
  builtin?: boolean;
}

// common sensor formats (width × height in mm)
const CAMERAS: [string, number, number][] = [
  ['Full Frame (36 × 24 mm)', 36, 24],
  ['APS-C (23.6 × 15.6 mm)', 23.6, 15.6],
  ['APS-C, small (22.3 × 14.9 mm)', 22.3, 14.9],
  ['Super 35 (24.9 × 18.7 mm)', 24.89, 18.66],
  ['Micro Four Thirds (17.3 × 13 mm)', 17.3, 13],
  ['1 inch (13.2 × 8.8 mm)', 13.2, 8.8],
  ['1/1.7 inch (7.6 × 5.7 mm)', 7.6, 5.7],
  ['1/2.3 inch (6.17 × 4.55 mm)', 6.17, 4.55],
  ['Super 16 (12.5 × 7.4 mm)', 12.52, 7.41],
  ['Medium Format (43.8 × 32.9 mm)', 43.8, 32.9],
];

const COLORS: [string, [number, number, number]][] = [
  ['Red', [0.9, 0.15, 0.12]],
  ['Orange', [1, 0.5, 0.05]],
  ['Yellow', [0.95, 0.85, 0.1]],
  ['Green', [0.2, 0.8, 0.25]],
  ['Cyan', [0.1, 0.8, 0.9]],
  ['Blue', [0.15, 0.35, 0.95]],
  ['Purple', [0.6, 0.25, 0.9]],
  ['Pink', [0.95, 0.4, 0.7]],
];

const SETTINGS: [string, Partial<MovieTrackingSettings>][] = [
  ['Default', { default_pattern_size: 21, default_search_size: 71, default_motion_model: 'Loc', default_pattern_match: 'KEYFRAME', default_correlation_min: 0.75, default_margin: 0, use_default_brute: true, use_default_normalization: false, default_frames_limit: 0 }],
  ['Blurry Footage', { default_pattern_size: 31, default_search_size: 101, default_motion_model: 'LocScale', default_pattern_match: 'KEYFRAME', default_correlation_min: 0.65, default_margin: 5, use_default_brute: true, use_default_normalization: true, default_frames_limit: 0 }],
  ['Fast Motion', { default_pattern_size: 25, default_search_size: 201, default_motion_model: 'Loc', default_pattern_match: 'PREV_FRAME', default_correlation_min: 0.7, default_margin: 10, use_default_brute: true, use_default_normalization: false, default_frames_limit: 0 }],
  ['Planar', { default_pattern_size: 41, default_search_size: 121, default_motion_model: 'Affine', default_pattern_match: 'KEYFRAME', default_correlation_min: 0.8, default_margin: 0, use_default_brute: true, use_default_normalization: true, default_frames_limit: 0 }],
];

const SETTING_KEYS = Object.keys(SETTINGS[0][1]).concat(['use_default_red_channel', 'use_default_green_channel', 'use_default_blue_channel', 'default_weight']);
const CAMERA_KEYS: (keyof MovieTrackingCamera)[] = ['sensor_width', 'units', 'pixel_aspect', 'focal_length'];

const KEY = 'p3d.clipPresets.v1';
let cache: Record<Kind, Preset[]> | null = null;

function userPresets(): Record<Kind, Preset[]> {
  if (cache) return cache;
  cache = { camera: [], color: [], settings: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<Kind, Preset[]>>;
    for (const k of ['camera', 'color', 'settings'] as Kind[]) if (Array.isArray(raw[k])) cache[k] = raw[k]!.filter((p) => typeof p?.name === 'string' && p.values);
  } catch {
    // no stored presets
  }
  return cache;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(userPresets()));
  } catch {
    // storage unavailable: presets last for this session
  }
}

export function presets(kind: Kind): Preset[] {
  const builtin: Preset[] =
    kind === 'camera'
      ? CAMERAS.map(([name, w]) => ({ name, values: { sensor_width: w, units: 'MILLIMETERS', pixel_aspect: 1 }, builtin: true }))
      : kind === 'color'
        ? COLORS.map(([name, c]) => ({ name, values: { color: c }, builtin: true }))
        : SETTINGS.map(([name, v]) => ({ name, values: v as Values, builtin: true }));
  return [...builtin, ...userPresets()[kind]];
}

/** Apply a preset to the clip of the context. */
export function applyPreset(c: MovieClipData, kind: Kind, p: Preset) {
  if (kind === 'camera') Object.assign(c.tracking.camera, p.values);
  else if (kind === 'settings') Object.assign(c.tracking.settings, p.values);
  else {
    const col = p.values.color as [number, number, number];
    const act = activeTrack(c);
    // the active track and the other selected ones
    for (const t of tobj(c).tracks) if (t === act || t.select) ((t.use_custom_color = true), (t.color = [...col]));
  }
  app.pushUndo(kind === 'camera' ? 'Camera Preset' : kind === 'color' ? 'Track Color Preset' : 'Tracking Settings Preset');
  app.changed('doc');
}

function currentValues(c: MovieClipData, kind: Kind): Values | null {
  if (kind === 'camera') return Object.fromEntries(CAMERA_KEYS.map((k) => [k, c.tracking.camera[k]]));
  if (kind === 'settings') return Object.fromEntries(SETTING_KEYS.map((k) => [k, (c.tracking.settings as unknown as Values)[k]]));
  const t = activeTrack(c);
  return t ? { color: [...t.color] } : null;
}

const PRESET_PROPS = [
  { id: 'name', label: 'Name', type: 'string' as const, default: '' },
  { id: 'remove_name', label: 'Remove', type: 'bool' as const, default: false, hidden: true },
];

function presetOp(kind: Kind, idname: string, label: string, what: string) {
  return {
    idname,
    label,
    description: `Save the current ${what} as a named preset (or remove a saved preset)`,
    undo: false,
    props: PRESET_PROPS,
    poll: (ctx: Parameters<typeof contextClip>[0]) => {
      const c = contextClip(ctx);
      return !!c && (kind !== 'color' || !!activeTrack(c));
    },
    invoke: (ctx: Parameters<typeof contextClip>[0], p: Record<string, unknown>) => {
      if (p.remove_name || String(p.name ?? '').trim()) return run(ctx, p);
      promptText(`${label}: name`, '', (name) => {
        if (name?.trim()) app.run(idname, { name: name.trim() }, { invoke: false });
      });
      return 'CANCELLED' as const;
    },
    exec: (ctx: Parameters<typeof contextClip>[0], p: Record<string, unknown>) => run(ctx, p),
  };
  function run(ctx: Parameters<typeof contextClip>[0], p: Record<string, unknown>) {
    const name = String(p.name ?? '').trim();
    if (!name) return 'CANCELLED' as const;
    const list = userPresets()[kind].filter((x) => x.name !== name);
    if (!p.remove_name) {
      const v = currentValues(contextClip(ctx)!, kind);
      if (!v) return 'CANCELLED' as const;
      list.push({ name, values: v });
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    userPresets()[kind] = list;
    save();
    app.report('INFO', p.remove_name ? `Removed preset "${name}"` : `Saved preset "${name}"`);
    app.changed('ui');
    return 'FINISHED' as const;
  }
}

registerOperators([presetOp('camera', 'clip.camera_preset_add', 'Add Camera Preset', 'camera sensor and lens'), presetOp('color', 'clip.track_color_preset_add', 'Add Track Color Preset', 'color of the active track'), presetOp('settings', 'clip.tracking_settings_preset_add', 'Add Tracking Settings Preset', 'default tracking settings')]);

const ADD_OP: Record<Kind, string> = { camera: 'clip.camera_preset_add', color: 'clip.track_color_preset_add', settings: 'clip.tracking_settings_preset_add' };

export function presetMenu(c: MovieClipData, kind: Kind): MenuItem[] {
  const list = presets(kind);
  const user = list.filter((p) => !p.builtin);
  return [
    ...list.filter((p) => p.builtin).map((p) => ({ label: p.name, action: () => applyPreset(c, kind, p) })),
    ...(user.length ? [{ separator: true } as MenuItem, ...user.map((p) => ({ label: p.name, action: () => applyPreset(c, kind, p) }))] : []),
    { separator: true },
    { label: 'Add Preset…', icon: 'add', op: ADD_OP[kind] },
    ...(user.length ? [{ label: 'Remove Preset', submenu: () => user.map((p) => ({ label: p.name, icon: 'remove', op: ADD_OP[kind], props: { name: p.name, remove_name: true } })) } as MenuItem] : []),
  ];
}

/** Small preset button for a panel header. */
export function presetButton(c: MovieClipData, kind: Kind, tip: string) {
  return h(
    'button',
    {
      class: 'icon-btn clip-preset-btn',
      'data-tip': tip,
      onpointerdown: (e: PointerEvent) => {
        e.stopPropagation();
        e.preventDefault();
        openMenu(presetMenu(c, kind), e.currentTarget as HTMLElement, { title: tip });
      },
    },
    icon('collapsemenu'),
  );
}
