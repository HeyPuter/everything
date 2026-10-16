// Preset menus of panels (the stacked-lines button in their header) and of operators (the row at
// the top of the Adjust Last Operation panel and of operator dialogs). Panel presets store the
// values of the panel's property buttons, so any panel can have them; built-in presets carry
// standard values only (resolutions, frame rates, sensor sizes, viscosities).
import { h, type Child } from './h';
import { icon } from './icons';
import { app } from '../app/app';
import { openMenu } from './menu';
import { getBinding, type PropBinding } from './binding';
import { panelHeaderExtras, isPanelOpen, setPanelOpen } from './widgets';
import { opDialogHeaderHooks } from './ophooks';
import { registerPresetKind, presetMenu, operatorPresetRow, setOperatorPresetTarget, type PresetKind, type PresetValues } from './presets';
import { optionsDialogHooks } from '../io/formats/ui';
import { FORMAT_PRESETS } from '../render/final/props/output';
import { fpsFromPreset } from '../render/final/units';

// ---------------------------------------------------------------------------
// panel presets: values of the panel's bound buttons, by property name

/** The panel the preset menu was opened from. */
let panelEl: HTMLElement | null = null;

function panelBindings(): PropBinding[] {
  if (!panelEl?.isConnected) return [];
  const out: PropBinding[] = [];
  const seen = new Set<string>();
  for (const el of panelEl.querySelectorAll<HTMLElement>('[data-id]')) {
    const b = getBinding(el.dataset.id);
    if (!b || b.kind === 'object' || seen.has(b.key)) continue;
    seen.add(b.key);
    out.push(b);
  }
  return out;
}

function capturePanel(): PresetValues {
  const out: PresetValues = {};
  for (const b of panelBindings()) out[b.key] = structuredClone(b.owner[b.key]);
  return out;
}

function applyPanel(values: PresetValues) {
  const bs = panelBindings();
  const owners = [...new Set(bs.map((b) => b.owner))];
  const touched = new Set<() => void>();
  for (const [k, v] of Object.entries(values)) {
    const b = bs.find((x) => x.key === k);
    const owner = b?.owner ?? owners.find((o) => k in o);
    if (!owner) continue;
    owner[k] = structuredClone(v);
    if (b?.onChange) touched.add(b.onChange);
  }
  for (const f of touched) f();
  app.graph.invalidate?.();
}

/** Give a panel a preset menu (`addOp` names the add / remove operator, e.g. "cloth.preset_add"). */
export function panelPresets(panelId: string, label: string, addOp: string, builtins?: () => [string, PresetValues][]) {
  const kind = `panel:${panelId}`;
  registerPresetKind({ id: kind, label, addOp, capture: capturePanel, apply: applyPanel, builtins });
  panelHeaderExtras[panelId] = () => presetHeaderButton(kind, panelId, label);
}

function presetHeaderButton(kind: string, panelId: string, label: string): Child {
  return h(
    'button',
    {
      class: 'hdr-toggle preset-btn',
      'data-tip': label,
      'data-preset': kind,
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const btn = e.currentTarget as HTMLElement;
        const show = () => {
          panelEl = (document.querySelector(`[data-preset="${CSS.escape(kind)}"]`) as HTMLElement | null)?.closest('[data-panel]') ?? btn.closest('[data-panel]');
          openMenu(presetMenu(kind), btn.isConnected ? btn : (panelEl?.querySelector('.preset-btn') as HTMLElement) ?? { x: e.clientX, y: e.clientY }, { title: label });
        };
        // the values come from the panel's buttons: open it first when it is closed
        if (!isPanelOpen(panelId, true) || !btn.closest('[data-panel]')?.querySelector('.panel-body')) {
          setPanelOpen(panelId, true);
          app.changed('ui');
          app.flush();
          requestAnimationFrame(show);
        } else show();
      },
    },
    icon('collapsemenu'),
  );
}

// ---------------------------------------------------------------------------
// built-in values

/** Sensor sizes of common camera and film formats, width × height in millimetres. */
export const SENSOR_PRESETS: [string, number, number][] = [
  ['Full Frame 35 mm', 36, 24],
  ['APS-H', 28.7, 19],
  ['APS-C', 23.6, 15.6],
  ['Micro Four Thirds', 17.3, 13],
  ['1" Type', 13.2, 8.8],
  ['2/3" Type', 8.8, 6.6],
  ['1/2.3" Type', 6.17, 4.55],
  ['Super 35', 24.89, 18.66],
  ['Super 16', 12.52, 7.41],
  ['35 mm Academy', 22, 16],
  ['Medium Format 645', 56, 41.5],
  ['Medium Format 6×7', 70, 56],
];

/** Kinematic viscosity (m²/s) at 20 °C as base × 10^-exponent. */
const VISCOSITY_PRESETS: [string, number, number][] = [
  ['Water (20 °C)', 1.004, 6],
  ['Glycerol (20 °C)', 1.12, 3],
];

// render format: the resolution fields are not bound buttons, so this kind reads the settings itself
registerPresetKind({
  id: 'render_format',
  label: 'Format Presets',
  addOp: 'render.preset_add',
  capture: () => {
    const r = app.doc.scene.render as unknown as Record<string, unknown>;
    const out: PresetValues = {};
    for (const k of ['resolution_x', 'resolution_y', 'resolution_percentage', 'pixel_aspect_x', 'pixel_aspect_y', 'fps', 'fps_base']) out[k] = r[k];
    return out;
  },
  apply: (v) => Object.assign(app.doc.scene.render, v),
  builtins: () => FORMAT_PRESETS.map(([name, x, y, ax, ay, fps]) => [name, { resolution_x: x, resolution_y: y, resolution_percentage: 100, pixel_aspect_x: ax, pixel_aspect_y: ay, ...fpsFromPreset(fps) }]),
});
panelHeaderExtras['out-format'] = () => presetHeaderButton('render_format', 'out-format', 'Format Presets');

panelPresets('ca-sensor', 'Sensor Presets', 'camera.preset_add', () => SENSOR_PRESETS.map(([n, w, hh]) => [n, { sensor_width: w, sensor_height: hh }]));
panelPresets('clip-n-camera', 'Camera Presets', 'clip.camera_preset_add', () => SENSOR_PRESETS.map(([n, w]) => [n, { sensor_width: w, pixel_aspect: 1 }]));
panelPresets('ph-fl-diff', 'Viscosity Presets', 'fluid.preset_add', () => VISCOSITY_PRESETS.map(([n, b, e]) => [n, { viscosity_base: b, viscosity_exponent: e }]));
panelPresets('ph-cloth', 'Cloth Presets', 'cloth.preset_add');
panelPresets('pa-hairdyn', 'Hair Dynamics Presets', 'particle.hair_dynamics_preset_add');
panelPresets('clip-n-tsettings', 'Tracking Settings Presets', 'clip.tracking_settings_preset_add');
panelPresets('rs-cm-wb', 'White Balance Presets', 'render.color_management_white_balance_preset_add');
panelPresets('seq-text-style', 'Text Style Presets', 'sequencer.text_strip_style_preset_add');

// display curves: the curve widget is not a bound button either
registerPresetKind({
  id: 'panel:rs-cm-curves',
  label: 'Curve Presets',
  addOp: 'render.color_management_curves_preset_add',
  capture: () => ({ curve_mapping: structuredClone(app.doc.scene.render.curve_mapping ?? [[0, 0], [1, 1]]) }),
  apply: (v) => {
    if (Array.isArray(v.curve_mapping)) app.doc.scene.render.curve_mapping = v.curve_mapping as [number, number][];
  },
  builtins: () => [['Linear', { curve_mapping: [[0, 0], [1, 1]] }]],
});
panelHeaderExtras['rs-cm-curves'] = () => presetHeaderButton('panel:rs-cm-curves', 'rs-cm-curves', 'Curve Presets');

// ---------------------------------------------------------------------------
// operator presets in operator dialogs

opDialogHeaderHooks.push((idname, props, apply) => {
  // window-manager and interface operations (Edit Property, …) have no presets
  if (/^(wm|ui)\./.test(idname)) return null;
  // the latest drawn dialog / redo panel of the operator is where its presets read and write
  setOperatorPresetTarget(idname, { get: () => props, set: (v) => apply(v) });
  return operatorPresetRow(idname);
});


// ---------------------------------------------------------------------------
// import / export option dialogs: a preset menu above the options

optionsDialogHooks.push((key, values, sync) => {
  const kind = `io:${key}`;
  const k: PresetKind = {
    id: kind,
    label: 'Operator Presets',
    undo: null,
    capture: () => ({ ...values }),
    apply: (v) => {
      for (const [id, x] of Object.entries(v)) if (id in values && typeof x === typeof values[id]) values[id] = x;
      sync();
    },
  };
  registerPresetKind(k);
  const btn = document.createElement('button');
  btn.className = 'btn io-presets';
  btn.type = 'button';
  btn.textContent = 'Operator Presets';
  btn.title = 'Saved option sets for this format';
  btn.onpointerdown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(presetMenu(kind), btn, { title: 'Operator Presets' });
  };
  return btn;
});
