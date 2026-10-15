// Pushes preference values into the modules that use them (display tables, editor
// defaults, keyframe defaults, audio, file handling) and extends the add-object operators
// with the "New Objects" preferences.
import { Color, SRGBColorSpace } from 'three';
import { app, onAppReady, operators, type PropDef } from '../app/app';
import { prefs } from '../app/prefs';
import { widgetSettings } from '../ui/widgets';
import { keyframeDefaults } from '../anim/fcurve';
import { animSettings } from '../animation/view2d';
import { textureSettings, applyTextureSettings } from '../render/images';
import { renderViewSettings } from '../render/final/renderwindow';
import { annotateSettings } from '../editors/view3d/tools3d';
import { textEditorSettings } from '../scripting/textedit';
import { consoleSettings } from '../scripting/runner';
import { nodeEditorSettings } from '../nodes/registry';
import { paintDisplaySettings } from '../paint/display';
import { weightRamp, DEFAULT_WEIGHT_RAMP } from '../paint/math';
import { audioSettings } from '../sequencer/media';
import { recentSettings } from '../io/recentlist';
import { fileEvents } from '../io/files';
import { setMode } from '../ops/object';
import { shell } from '../ui/shell';
import { onPrefsApply } from './store';

const srgb = (c: Color, v: number[]) => c.setRGB(v[0], v[1], v[2], SRGBColorSpace);

onPrefsApply((p) => {
  widgetSettings.factorPercentage = p.factor_display_type === 'PERCENTAGE';
  widgetSettings.colorPicker = p.color_picker_type;

  keyframeDefaults.interpolation = p.keyframe_new_interpolation_type;
  keyframeDefaults.handle = p.keyframe_new_handle_type;
  keyframeDefaults.insertNeeded = p.use_keyframe_insert_needed;
  keyframeDefaults.xyzToRgb = p.use_insertkey_xyz_to_rgb;
  animSettings.gridMinPx = Math.max(10, Math.min(200, p.view2d_grid_spacing_min));
  animSettings.timecode = p.timecode_style;
  animSettings.unselectedAlpha = Math.max(0.01, Math.min(1, p.fcurve_unselected_alpha));
  animSettings.onlySelectedKeys = p.show_only_selected_curve_keyframes;

  if (textureSettings.anisotropy !== p.anisotropic_filter) {
    textureSettings.anisotropy = p.anisotropic_filter;
    applyTextureSettings();
  }
  renderViewSettings.mode = p.render_display_type;

  annotateSettings.color = [...p.annotation_color] as [number, number, number];
  annotateSettings.eraserRadius = Math.max(1, p.annotation_eraser_radius);
  textEditorSettings.autoClose = p.use_text_edit_auto_close;
  textEditorSettings.useSpaces = p.use_tabs_as_spaces;
  consoleSettings.scrollback = Math.max(32, p.scrollback);
  nodeEditorSettings.insertOffset = p.node_use_insert_offset;
  nodeEditorSettings.insertMargin = Math.max(0, p.node_margin);
  srgb(paintDisplaySettings.maskColor, p.sculpt_paint_overlay_color);
  const ramp = p.use_weight_color_range && p.weight_color_range?.length === 5 ? p.weight_color_range : DEFAULT_WEIGHT_RAMP;
  ramp.forEach((c, i) => {
    weightRamp[i] = [c[0], c[1], c[2]];
    paintDisplaySettings.weightRamp[i].set(c[0], c[1], c[2]);
  });

  audioSettings.sampleRate = p.audio_sample_rate;
  audioSettings.latency = p.audio_latency;
  audioSettings.channels = p.audio_channels;
  recentSettings.max = Math.max(1, Math.min(50, Math.round(p.recent_files)));

  // headers follow the Header Position preference
  for (const a of shell?.screen.areas ?? []) a.applyUi();
  syncAddDefaults();
  app.changed('ui', 'view');
});

// ---------------------------------------------------------------------------
// New Objects: default alignment and entering Edit Mode for add-object operators

/** Object types that have an Edit Mode. */
const EDITABLE = new Set(['MESH', 'CURVE', 'FONT', 'ARMATURE', 'LATTICE', 'META', 'SURFACE']);
const addOps = new Set<string>();

function isAlignProp(d: PropDef) {
  return d.id === 'align' && d.type === 'enum' && !!d.items?.some((i) => i[0] === 'VIEW') && !!d.items?.some((i) => i[0] === 'WORLD');
}

function syncAddDefaults() {
  for (const id of addOps) {
    const op = operators.get(id);
    for (const d of op?.props ?? []) {
      if (isAlignProp(d)) d.default = prefs.object_align;
      else if (d.id === 'enter_editmode') d.default = prefs.use_enter_edit_mode;
    }
  }
}

onAppReady(() => {
  for (const op of operators.values()) {
    if (!op.props?.some(isAlignProp) || !op.exec) continue;
    addOps.add(op.idname);
    if (!op.props.some((d) => d.id === 'enter_editmode')) op.props.push({ id: 'enter_editmode', label: 'Enter Edit Mode', type: 'bool', default: prefs.use_enter_edit_mode });
    const prev = op.exec;
    op.exec = (ctx, p) => {
      const startMode = ctx.doc.mode;
      const r = prev(ctx, p);
      if ((r === undefined || r === 'FINISHED') && p.enter_editmode && startMode === 'OBJECT') {
        const ob = app.activeObject;
        if (ob && EDITABLE.has(ob.type)) setMode(ctx.doc, 'EDIT');
      }
      return r;
    };
  }
  syncAddDefaults();

  // Save Prompt: the browser asks before leaving with changes made since the last save or open
  let savedRevision = app.revision;
  const mark = () => (savedRevision = app.revision);
  fileEvents.saved.push(mark);
  fileEvents.opened.push(mark);
  addEventListener('beforeunload', (e) => {
    if (!prefs.use_save_prompt || !app.dirty || app.revision === savedRevision) return;
    e.preventDefault();
    e.returnValue = '';
  });
});
