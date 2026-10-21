// Strip properties: the Sequencer sidebar (N) tabs and the Properties editor Strip tabs.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { sceneByName, sceneObjects, scenesByName } from '../scenes/scenes';
import { num, bool, enumProp, splitRow, oid, type PropOpts } from '../ui/props';
import { panel, numberField, colorSwatch, checkbox, textField, enumMenu, button, opButton } from '../ui/widgets';
import { openMenu, promptText } from '../ui/menu';
import type { Strip, StripModifier, ColorBalanceData } from './types';
import { BLEND_ITEMS, inputCount, isStill, finalStart, finalEnd, finalDuration, setLeftHandle, setRightHandle, translateStrip, isVisual, TRANSITIONS, findStrip, resolveOverlap } from './strips';
import { activeStrip, afterEdit, seqEditor, seqList, toolSettings, hasEditor, sceneFps } from './context';
import { stripIcon } from './theme';
import { DEFAULT_SAFE_AREAS } from '../render/final/cameraoverlay';
import type { PreviewGuides } from './preview';
import { restartPlayback } from './audio';
import { movieCacheStats } from './media';
import { pickFiles, fileBytes } from './add';
import { drawCurves } from '../nodes/editor/rampui';
import { extraModifierUI, modifierAddItems } from './modextra';
import { proxyPanel } from './proxyui';
import { stylePresetMenu } from './textpresets';
import { EQUALIZER_LAYOUTS } from './modops';
import type { NodeData, NodeTreeData } from '../data/types';

const edited: PropOpts = { onChange: () => (afterEdit(), restartPlayback()) };

function color(owner: Record<string, unknown>, key: string, label: string, alpha = false) {
  const v = (owner[key] as number[]) ?? [0, 0, 0, 1];
  return splitRow(
    label,
    colorSwatch(`${oid(owner)}.${key}`, v, (nv, final) => {
      owner[key] = nv.slice(0, v.length);
      app.changed('doc');
      if (final) app.pushUndo(`Change ${label}`);
    }, { alpha, linear: false }),
  );
}

function frameField(id: string, label: string, value: number, set: (v: number) => void, disabled = false) {
  return splitRow(label, numberField({ id, value, int: true, disabled, set: (v, final) => {
    set(Math.round(v));
    afterEdit();
    app.changed('doc');
    if (final) {
      restartPlayback();
      app.pushUndo(`Change ${label}`);
    }
  } }));
}

/** Header of the strip panels: icon, name (rename) and mute toggle. */
function stripHeader(s: Strip): Child {
  return h(
    'div',
    { class: 'seq-sb-head' },
    icon(stripIcon(s.type)),
    textField(`seq-name-${oid(s)}`, s.name, (v) => rename(s, v)),
    h(
      'button',
      {
        class: { 'hdr-toggle': true, on: !s.mute },
        'data-tip': 'Mute\nMute the strip (H)',
        onclick: () => {
          s.mute = !s.mute;
          app.pushUndo(s.mute ? 'Mute Strip' : 'Unmute Strip');
          app.changed('doc');
          restartPlayback();
        },
      },
      icon(s.mute ? 'checkbox_dehlt' : 'checkbox_hlt'),
    ),
  );
}

export function rename(s: Strip, name: string) {
  name = name.trim();
  if (!name || name === s.name) return;
  const ed = seqEditor();
  if (findStrip(ed.strips, name)) {
    app.report('ERROR', `A strip named "${name}" already exists`);
    app.changed('ui');
    return;
  }
  const old = s.name;
  const walk = (l: Strip[]) => {
    for (const x of l) {
      if (x.input_1 === old) x.input_1 = name;
      if (x.input_2 === old) x.input_2 = name;
      if (x.connections) x.connections = x.connections.map((n) => (n === old ? name : n));
      for (const m of x.modifiers ?? []) if (m.input_mask_strip === old) m.input_mask_strip = name;
      if (x.strips) walk(x.strips);
    }
  };
  walk(ed.strips);
  ed.meta_stack = ed.meta_stack.map((n) => (n === old ? name : n));
  if (ed.active_strip === old) ed.active_strip = name;
  s.name = name;
  app.pushUndo('Rename Strip');
  app.changed('doc');
}

function effectPanel(s: Strip): Child {
  const rows: Child[] = [];
  const t = s.type;
  if (t === 'COLOR') rows.push(color(s as never, 'color', 'Color'));
  if (t === 'TEXT') {
    rows.push(
      h('textarea', {
        key: `seq-text-${oid(s)}`,
        class: 'seq-textarea',
        rows: 3,
        value: s.text ?? '',
        spellcheck: 'false',
        onkeydown: (e: KeyboardEvent) => e.stopPropagation(),
        oninput: (e: Event) => {
          s.text = (e.target as HTMLTextAreaElement).value;
          app.changed('doc');
        },
        onchange: () => app.pushUndo('Change Text'),
      }),
      num(s, 'wrap_width', 'Wrap Width', { min: 0, softMax: 1, precision: 2, slider: true }),
    );
  }
  if (TRANSITIONS.includes(t)) {
    if (t === 'WIPE') {
      rows.push(
        enumProp(s, 'transition_type', 'Transition', [['SINGLE', 'Single'], ['DOUBLE', 'Double'], ['IRIS', 'Iris'], ['CLOCK', 'Clock']]),
        enumProp(s, 'direction', 'Direction', [['OUT', 'Out'], ['IN', 'In']]),
        num(s, 'blur_width', 'Blur Width', { min: 0, max: 1, slider: true, precision: 2 }),
        num(s, 'angle', 'Angle', { unit: 'angle', min: -Math.PI / 2, max: Math.PI / 2 }),
      );
    }
  }
  if (inputCount(t) && t !== 'COLORMIX') {
    rows.push(bool(s, 'use_default_fade', 'Default Fade'), !s.use_default_fade ? num(s, 'effect_fader', 'Effect Fader', { min: 0, max: 1, slider: true, precision: 3 }) : null);
  }
  if (t === 'GLOW')
    rows.push(
      num(s, 'threshold', 'Threshold', { min: 0, max: 1, slider: true, precision: 3 }),
      num(s, 'clamp', 'Clamp', { min: 0, max: 1, slider: true, precision: 3 }),
      num(s, 'boost_factor', 'Boost Factor', { min: 0, max: 10, precision: 3 }),
      num(s, 'blur_radius', 'Blur Distance', { min: 0.5, max: 20, precision: 2 }),
      num(s, 'quality', 'Quality', { int: true, min: 1, max: 5 }),
      bool(s, 'use_only_boost', 'Only Boost'),
    );
  if (t === 'MULTICAM') rows.push(num(s, 'multicam_source', 'Source Channel', { int: true, min: 0, max: 127 }), h('div', { class: 'seq-sb-note' }, 'Cut to another camera with the number keys (1–9, 0) while hovering the timeline.'));
  if (t === 'GAUSSIAN_BLUR') rows.push(num(s, 'size_x', 'Size X', { min: 0, softMax: 200, precision: 1 }), num(s, 'size_y', 'Y', { min: 0, softMax: 200, precision: 1 }));
  if (t === 'SPEED') {
    rows.push(enumProp(s, 'speed_control', 'Speed Control', [['STRETCH', 'Stretch'], ['MULTIPLY', 'Multiply'], ['FRAME_NUMBER', 'Frame Number'], ['LENGTH', 'Length']]));
    if (s.speed_control === 'MULTIPLY') rows.push(num(s, 'speed_factor', 'Multiply Factor', { min: 0, softMax: 10, precision: 3 }));
    if (s.speed_control === 'FRAME_NUMBER') rows.push(num(s, 'speed_frame_number', 'Frame Number', { min: 0, precision: 1 }));
    if (s.speed_control === 'LENGTH') rows.push(num(s, 'speed_length', 'Length', { unit: 'percentage', min: 0, softMax: 200, precision: 1 }));
  }
  if (t === 'COLORMIX') rows.push(enumProp(s, 'blend_effect', 'Blending Mode', BLEND_ITEMS.filter(([v]) => !['REPLACE', 'CROSS', 'ALPHA_OVER', 'ALPHA_UNDER', 'GAMMA_CROSS'].includes(v))), num(s, 'factor', 'Blend Factor', { min: 0, max: 1, slider: true, precision: 3 }));
  if (t === 'TRANSFORM')
    rows.push(
      enumProp(s, 'translation_unit', 'Translation Unit', [['PIXELS', 'Pixels'], ['PERCENT', 'Percent']]),
      num(s, 'translate_start_x', 'Position X', { precision: 1 }),
      num(s, 'translate_start_y', 'Y', { precision: 1 }),
      bool(s, 'use_uniform_scale', 'Uniform Scale'),
      num(s, 'scale_start_x', s.use_uniform_scale ? 'Scale' : 'Scale X', { precision: 3 }),
      s.use_uniform_scale ? null : num(s, 'scale_start_y', 'Y', { precision: 3 }),
      num(s, 'rotation_start', 'Rotation', { precision: 2 }),
    );
  if (inputCount(t)) {
    const names = seqList()
      .filter((x) => x !== s && x.type !== 'SOUND')
      .map((x) => ({ value: x.name, label: x.name, icon: stripIcon(x.type) }));
    const setInput = (key: 'input_1' | 'input_2') => (v: string) => {
      s[key] = v;
      afterEdit();
      app.pushUndo('Change Input');
      app.changed('doc');
    };
    rows.push(splitRow('Input 1', enumMenu(`seq-in1-${oid(s)}`, names, s.input_1 ?? '', setInput('input_1'))));
    if (inputCount(t) > 1) rows.push(splitRow('Input 2', enumMenu(`seq-in2-${oid(s)}`, names, s.input_2 ?? '', setInput('input_2'))));
  }
  if (!rows.length) return null;
  return panel('seq-effect', t === 'TEXT' ? 'Effect Strip' : 'Effect Strip', () => rows);
}

function pickFont(s: Strip) {
  void pickFiles('.ttf,.otf,.woff,.woff2,font/*', false).then(async (files) => {
    if (!files.length) return;
    s.font_file = await fileBytes(files[0]);
    app.pushUndo('Load Font');
    app.changed('doc');
  });
}

function textStylePanels(s: Strip): Child {
  if (s.type !== 'TEXT') return null;
  return [
    panel('seq-text-style', 'Style', () => [
      splitRow(
        'Presets',
        h(
          'button',
          {
            class: 'btn seq-style-presets',
            'data-tip': 'Text style presets: apply one to the selected text strips, or save this style',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openMenu(stylePresetMenu((cb) => promptText('Preset Name', 'Style', (v) => v && cb(v))), e.currentTarget as HTMLElement);
            },
          },
          'Presets',
          icon('down_arrow_hlt', 'tiny'),
        ),
      ),
      splitRow(
        'Font',
        h(
          'div',
          { class: 'row-aligned' },
          h('span', { class: 'seq-src' }, s.font_file ? s.font_file.filepath : 'Default (sans-serif)'),
          button(`seq-font-${oid(s)}`, icon('file_folder'), () => pickFont(s), { tip: 'Load Font\nUse a font file (TTF, OTF, WOFF) for this text' }),
          s.font_file ? button(`seq-font-x-${oid(s)}`, icon('x'), () => ((s.font_file = null), app.pushUndo('Default Font'), app.changed('doc')), { tip: 'Use the default font' }) : null,
        ),
      ),
      num(s, 'font_size', 'Size', { min: 0, softMax: 2000, precision: 1 }),
      splitRow('', h('div', { class: 'row-aligned' }, checkbox(`seq-bold-${oid(s)}`, 'Bold', !!s.use_bold, (v) => ((s.use_bold = v), app.pushUndo('Bold'), app.changed('doc'))), checkbox(`seq-italic-${oid(s)}`, 'Italic', !!s.use_italic, (v) => ((s.use_italic = v), app.pushUndo('Italic'), app.changed('doc'))))),
      color(s as never, 'color', 'Color', true),
      panel('seq-text-outline', h('span', null, checkbox(`seq-outl-${oid(s)}`, 'Outline', !!s.use_outline, (v) => ((s.use_outline = v), app.pushUndo('Outline'), app.changed('doc')))), () => [color(s as never, 'outline_color', 'Color', true), num(s, 'outline_width', 'Width', { min: 0, max: 1, slider: true, precision: 3 })], { sub: true, closed: true }),
      panel('seq-text-shadow', h('span', null, checkbox(`seq-shad-${oid(s)}`, 'Shadow', !!s.use_shadow, (v) => ((s.use_shadow = v), app.pushUndo('Shadow'), app.changed('doc')))), () => [color(s as never, 'shadow_color', 'Color', true), num(s, 'shadow_angle', 'Angle', { unit: 'angle', min: 0, max: Math.PI * 2 }), num(s, 'shadow_offset', 'Offset', { min: 0, max: 1, slider: true, precision: 3 }), num(s, 'shadow_blur', 'Blur', { min: 0, max: 1, slider: true, precision: 3 })], { sub: true, closed: true }),
      panel('seq-text-box', h('span', null, checkbox(`seq-box-${oid(s)}`, 'Box', !!s.use_box, (v) => ((s.use_box = v), app.pushUndo('Box'), app.changed('doc')))), () => [color(s as never, 'box_color', 'Color', true), num(s, 'box_margin', 'Margin', { min: 0, max: 1, slider: true, precision: 3 }), num(s, 'box_roundness', 'Roundness', { min: 0, max: 1, slider: true, precision: 3 })], { sub: true, closed: true }),
    ]),
    panel('seq-text-layout', 'Layout', () => {
      const loc = s.location ?? [0.5, 0.5];
      return [
        splitRow('Location X', numberField({ id: `seq-locx-${oid(s)}`, value: loc[0], precision: 3, set: (v, f) => ((s.location = [v, loc[1]]), app.changed('doc'), f && app.pushUndo('Location')) })),
        splitRow('Y', numberField({ id: `seq-locy-${oid(s)}`, value: loc[1], precision: 3, set: (v, f) => ((s.location = [loc[0], v]), app.changed('doc'), f && app.pushUndo('Location')) })),
        enumProp(s, 'alignment_x', 'Alignment X', [['LEFT', 'Left'], ['CENTER', 'Center'], ['RIGHT', 'Right']]),
        enumProp(s, 'anchor_x', 'Anchor X', [['LEFT', 'Left'], ['CENTER', 'Center'], ['RIGHT', 'Right']]),
        enumProp(s, 'anchor_y', 'Y', [['BOTTOM', 'Bottom'], ['CENTER', 'Center'], ['TOP', 'Top']]),
      ];
    }),
  ];
}

/** A faded property shows its key count and a button to remove the fade instead of a plain value. */
function fadeRow(s: Strip, prop: 'blend_alpha' | 'volume', label: string): Child {
  const keys = s.keys?.[prop];
  if (!keys?.length) return null;
  return splitRow(label, h('div', { class: 'row-aligned' }, h('span', { class: 'seq-src' }, `Faded (${keys.length} keys)`), opButton('sequencer.fades_clear', 'Clear')));
}

function compositingPanel(s: Strip): Child {
  if (!isVisual(s)) return null;
  return panel('seq-compositing', 'Compositing', () => [enumProp(s, 'blend_type', 'Blend', BLEND_ITEMS), fadeRow(s, 'blend_alpha', 'Opacity') ?? num(s, 'blend_alpha', 'Opacity', { min: 0, max: 1, slider: true, precision: 3 })]);
}

function transformPanels(s: Strip): Child {
  if (!isVisual(s)) return null;
  const t = s.transform,
    c = s.crop;
  const animated = (['transform.offset_x', 'transform.offset_y', 'transform.rotation', 'transform.scale_x', 'transform.scale_y'] as const).filter((p) => s.keys?.[p]?.length);
  return [
    panel('seq-transform', 'Transform', () => [
      animated.length
        ? splitRow('Animated', h('div', { class: 'row-aligned' }, h('span', { class: 'seq-src' }, [...new Set(animated.map((p) => (p.includes('offset') ? 'Position' : p.includes('scale') ? 'Scale' : 'Rotation')))].join(', ')), opButton('sequencer.keyframe_clear', 'Clear')))
        : null,
      num(t, 'offset_x', 'Position X', { unit: 'pixel', precision: 0 }),
      num(t, 'offset_y', 'Y', { unit: 'pixel', precision: 0 }),
      num(t, 'scale_x', 'Scale X', { precision: 3 }),
      num(t, 'scale_y', 'Y', { precision: 3 }),
      num(t, 'rotation', 'Rotation', { unit: 'angle' }),
      splitRow('Origin X', numberField({ id: `seq-orx-${oid(s)}`, value: t.origin[0], precision: 3, set: (v, f) => ((t.origin = [v, t.origin[1]]), app.changed('doc'), f && app.pushUndo('Origin')) })),
      splitRow('Y', numberField({ id: `seq-ory-${oid(s)}`, value: t.origin[1], precision: 3, set: (v, f) => ((t.origin = [t.origin[0], v]), app.changed('doc'), f && app.pushUndo('Origin')) })),
      splitRow('Mirror', h('div', { class: 'row-aligned' }, checkbox(`seq-fx-${oid(s)}`, 'X', s.use_flip_x, (v) => ((s.use_flip_x = v), app.pushUndo('Mirror'), app.changed('doc'))), checkbox(`seq-fy-${oid(s)}`, 'Y', s.use_flip_y, (v) => ((s.use_flip_y = v), app.pushUndo('Mirror'), app.changed('doc'))))),
      enumProp(t, 'filter', 'Filter', [['AUTO', 'Auto'], ['NEAREST', 'Nearest'], ['BILINEAR', 'Bilinear']]),
    ]),
    panel('seq-crop', 'Crop', () => [num(c, 'min_x', 'Left', { int: true, min: 0, unit: 'pixel' }), num(c, 'max_x', 'Right', { int: true, min: 0, unit: 'pixel' }), num(c, 'max_y', 'Top', { int: true, min: 0, unit: 'pixel' }), num(c, 'min_y', 'Bottom', { int: true, min: 0, unit: 'pixel' })], { closed: true }),
  ];
}

function videoColorPanels(s: Strip): Child {
  if (!isVisual(s)) return null;
  const out: Child[] = [];
  if (['MOVIE', 'IMAGE', 'SCENE', 'META'].includes(s.type)) out.push(panel('seq-video', 'Video', () => [num(s, 'strobe', 'Strobe', { min: 1, max: 30, precision: 1 }), bool(s, 'use_reverse_frames', 'Reverse Frames')], { closed: true }));
  out.push(panel('seq-color', 'Color', () => [num(s, 'color_saturation', 'Saturation', { min: 0, max: 20, softMax: 2, precision: 3 }), num(s, 'color_multiply', 'Multiply', { min: 0, max: 20, softMax: 2, precision: 3 }), bool(s, 'multiply_alpha', 'Multiply Alpha')], { closed: true }));
  return out;
}

function soundPanel(s: Strip): Child {
  if (s.type !== 'SOUND' && s.type !== 'SCENE') return null;
  if (s.type === 'SCENE') return null;
  return panel('seq-sound', 'Sound', () => [fadeRow(s, 'volume', 'Volume') ?? num(s, 'volume', 'Volume', { min: 0, max: 100, softMax: 2, precision: 3, ...edited }), num(s, 'pan', 'Pan', { min: -1, max: 1, slider: true, precision: 3, ...edited }), bool(s, 'show_waveform', 'Display Waveform'), num(s, 'sound_offset', 'Sound Offset', { unit: 'time', precision: 3, ...edited })]);
}

function sourcePanel(s: Strip): Child {
  const rows: Child[] = [];
  if (s.media && (s.type === 'MOVIE' || s.type === 'SOUND' || s.type === 'IMAGE')) rows.push(splitRow('File', h('span', { class: 'seq-src' }, s.media.filepath)), splitRow('Size', h('span', { class: 'seq-src' }, fmtBytes(s.media.bytes.byteLength))));
  if (s.type === 'IMAGE' && s.elements?.length) {
    rows.push(splitRow('File', h('span', { class: 'seq-src' }, s.elements.length > 1 ? `${s.elements[0].filename} … (${s.elements.length} images)` : s.elements[0].filename)));
    rows.push(splitRow('Size', h('span', { class: 'seq-src' }, fmtBytes(s.elements.reduce((n, e) => n + e.bytes.byteLength, 0)))));
  }
  if (s.orig_width) rows.push(splitRow('Resolution', h('span', { class: 'seq-src' }, `${s.orig_width} × ${s.orig_height}`)));
  if (s.type === 'MOVIE') rows.push(splitRow('FPS', h('span', { class: 'seq-src' }, s.fps ? `${+s.fps.toFixed(3)}` : '—')));
  if (s.type === 'MOVIE') rows.push(bool(s, 'use_deinterlace', 'Deinterlace'));
  if (s.type === 'MOVIECLIP') {
    const clips = Object.values(app.doc.movieclips ?? {});
    rows.push(
      splitRow(
        'Clip',
        enumMenu(`seq-clip-${oid(s)}`, [{ value: '', label: '—' }, ...clips.map((c) => ({ value: c.id, label: c.name, icon: 'clip_editor' }))], s.clip ?? '', (v) => {
          s.clip = v || null;
          app.pushUndo('Change Clip');
          app.changed('doc');
        }),
      ),
      splitRow('', checkbox(`seq-stab-${oid(s)}`, 'Use 2D Stabilization', !!s.stabilize2d, (v) => ((s.stabilize2d = v), app.pushUndo('Use 2D Stabilization'), app.changed('doc')))),
    );
  }
  if (s.type === 'MASK') {
    const masks = Object.values(app.doc.masks ?? {});
    rows.push(
      splitRow(
        'Mask',
        enumMenu(`seq-mask-${oid(s)}`, [{ value: '', label: '—' }, ...masks.map((m) => ({ value: m.id, label: m.name, icon: 'mod_mask' }))], s.mask ?? '', (v) => {
          s.mask = v || null;
          app.pushUndo('Change Mask');
          app.changed('doc');
        }),
      ),
    );
  }
  if (s.type === 'SCENE') {
    const doc = app.doc;
    const target = sceneByName(doc, s.scene) ?? doc.scene;
    const inScene = sceneObjects(doc, target);
    const cams = doc.object_order.filter((id) => inScene.has(id)).map((id) => doc.objects[id]).filter((o) => o?.type === 'CAMERA');
    rows.push(
      splitRow(
        'Scene',
        enumMenu(`seq-scene-${oid(s)}`, scenesByName(doc).map((sc) => ({ value: sc.name, label: sc.name, icon: 'scene_data' })), target.name, (v) => {
          s.scene = v;
          s.scene_camera = null;
          app.pushUndo('Change Scene');
          app.changed('doc');
        }),
      ),
    );
    rows.push(
      splitRow(
        'Camera',
        enumMenu(`seq-cam-${oid(s)}`, [{ value: '', label: 'Scene Camera', icon: 'scene_data' }, ...cams.map((c) => ({ value: c.id, label: c.name, icon: 'outliner_ob_camera' }))], s.scene_camera ?? '', (v) => {
          s.scene_camera = v || null;
          app.pushUndo('Change Camera');
          app.changed('doc');
        }),
      ),
    );
  }
  if (!rows.length) return null;
  return panel('seq-source', 'Source', () => rows);
}

function timePanel(s: Strip): Child {
  const effectRange = !!inputCount(s.type);
  return panel('seq-time', 'Time', () => [
    frameField(`seq-ch-${oid(s)}`, 'Channel', s.channel, (v) => {
      s.channel = Math.max(1, Math.min(128, v));
      resolveOverlap(seqList(), [s], toolSettings().overlap_mode);
    }),
    frameField(`seq-start-${oid(s)}`, 'Start', finalStart(s), (v) => {
      translateStrip(s, v - finalStart(s));
      resolveOverlap(seqList(), [s], toolSettings().overlap_mode);
    }, effectRange || s.lock),
    frameField(`seq-dur-${oid(s)}`, 'Duration', finalDuration(s), (v) => setRightHandle(s, finalStart(s) + Math.max(1, v)), effectRange || s.lock),
    frameField(`seq-end-${oid(s)}`, 'End', finalEnd(s), (v) => setRightHandle(s, v), effectRange || s.lock),
    isStill(s) || effectRange
      ? null
      : [
          frameField(`seq-os-${oid(s)}`, 'Strip Offset Start', s.frame_offset_start, (v) => setLeftHandle(s, s.frame_start + Math.max(0, v)), s.lock),
          frameField(`seq-oe-${oid(s)}`, 'End', s.frame_offset_end, (v) => setRightHandle(s, s.frame_start + s.frame_duration - Math.max(0, v)), s.lock),
          splitRow('Hold Offset Start', h('span', { class: 'seq-src' }, String(s.animation_offset_start))),
          splitRow('End', h('span', { class: 'seq-src' }, String(s.animation_offset_end))),
        ],
    splitRow('Current Frame', h('span', { class: 'seq-src' }, String(app.doc.scene.frame_current - s.frame_start))),
    splitRow('', checkbox(`seq-lock-${oid(s)}`, 'Lock', s.lock, (v) => ((s.lock = v), app.pushUndo(v ? 'Lock Strip' : 'Unlock Strip'), app.changed('doc')))),
    splitRow('Length', h('span', { class: 'seq-src' }, `${(finalDuration(s) / sceneFps()).toFixed(2)} s`)),
  ]);
}

function fmtBytes(n: number) {
  return n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} KiB`;
}

export function stripTab(): Child {
  if (!hasEditor()) return h('div', { class: 'sb-empty' }, 'No active strip');
  const s = activeStrip();
  if (!s) return h('div', { class: 'sb-empty' }, 'No active strip');
  return [stripHeader(s), effectPanel(s), textStylePanels(s), compositingPanel(s), transformPanels(s), videoColorPanels(s), soundPanel(s), sourcePanel(s), timePanel(s)];
}

// ---------------------------------------------------------------------------
// modifiers

function vec3Rows(owner: ColorBalanceData, key: 'lift' | 'gamma' | 'gain' | 'offset' | 'power' | 'slope', label: string, invKey: keyof ColorBalanceData) {
  const v = owner[key];
  return h(
    'div',
    { class: 'seq-cb-col' },
    h('div', { class: 'seq-cb-title' }, label),
    colorSwatch(`seq-cb-${oid(owner)}-${key}`, v.map((x) => Math.max(0, Math.min(1, x / 2))), (nv, final) => {
      owner[key] = [nv[0] * 2, nv[1] * 2, nv[2] * 2];
      app.changed('doc');
      if (final) app.pushUndo(`Change ${label}`);
    }, { linear: false }),
    ...v.map((x, i) =>
      numberField({
        id: `seq-cb-${oid(owner)}-${key}-${i}`,
        label: 'RGB'[i],
        value: x,
        min: 0,
        softMax: 2,
        precision: 3,
        set: (nv, final) => {
          const a = [...owner[key]] as [number, number, number];
          a[i] = nv;
          owner[key] = a;
          app.changed('doc');
          if (final) app.pushUndo(`Change ${label}`);
        },
      }),
    ),
    checkbox(`seq-cb-${oid(owner)}-${String(invKey)}`, 'Inverse', !!owner[invKey], (b) => (((owner as unknown as Record<string, boolean>)[invKey as string] = b), app.pushUndo('Invert'), app.changed('doc'))),
  );
}

/** Mask input of a modifier: none, another strip or a mask data-block. */
function maskRows(s: Strip, m: StripModifier): Child {
  const type = m.input_mask_type ?? 'NONE';
  const set = (label: string) => (app.pushUndo(label), app.changed('doc'));
  const rows: Child[] = [
    splitRow(
      'Mask Input',
      enumMenu(
        `seq-modmask-${oid(m)}`,
        [
          { value: 'NONE', label: 'None' },
          { value: 'STRIP', label: 'Strip', description: 'Use another strip’s image as the mask' },
          { value: 'ID', label: 'Mask', description: 'Use a mask drawn in the clip editor' },
        ],
        type,
        (v) => ((m.input_mask_type = v as 'NONE'), set('Mask Input Type')),
      ),
    ),
  ];
  if (type === 'STRIP')
    rows.push(
      splitRow(
        'Mask Strip',
        enumMenu(`seq-modmask-s-${oid(m)}`, [{ value: '', label: '—' }, ...seqList().filter((x) => x !== s && x.type !== 'SOUND').map((x) => ({ value: x.name, label: x.name, icon: stripIcon(x.type) }))], m.input_mask_strip ?? '', (v) => ((m.input_mask_strip = v || null), set('Mask Strip'))),
      ),
    );
  if (type === 'ID')
    rows.push(
      splitRow(
        'Mask',
        enumMenu(`seq-modmask-m-${oid(m)}`, [{ value: '', label: '—' }, ...Object.values(app.doc.masks ?? {}).map((x) => ({ value: x.id, label: x.name, icon: 'mod_mask' }))], m.input_mask_id ?? '', (v) => ((m.input_mask_id = v || null), set('Mask'))),
      ),
    );
  return rows;
}

function modifierPanel(s: Strip, m: StripModifier, i: number): Child {
  const header = h(
    'span',
    { class: 'seq-mod-hd', onpointerdown: () => s.active_modifier !== m.name && app.run('sequencer.strip_modifier_set_active', { modifier: m.name }) },
    h('button', { class: { 'hdr-toggle': true, on: !m.mute }, 'data-tip': 'Mute\nMute this modifier', onclick: () => ((m.mute = !m.mute), app.pushUndo('Mute Modifier'), app.changed('doc')) }, icon(m.mute ? 'checkbox_dehlt' : 'checkbox_hlt')),
    textField(`seq-mod-name-${oid(m)}`, m.name, (v) => {
      if (!v || s.modifiers.some((x) => x !== m && x.name === v)) return;
      m.name = v;
      app.pushUndo('Rename Modifier');
      app.changed('doc');
    }),
    button(`seq-mod-up-${i}`, icon('triangle_up'), () => app.run('sequencer.strip_modifier_move', { name: m.name, direction: 'UP' }), { tip: 'Move Up', disabled: i === 0 }),
    button(`seq-mod-down-${i}`, icon('triangle_down'), () => app.run('sequencer.strip_modifier_move', { name: m.name, direction: 'DOWN' }), { tip: 'Move Down', disabled: i === s.modifiers.length - 1 }),
    h(
      'button',
      {
        class: 'icon-btn seq-mod-more',
        'data-tip': 'More modifier commands',
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openMenu(
            [
              { label: 'Duplicate', icon: 'duplicate', op: 'sequencer.strip_modifier_duplicate', props: { name: m.name } },
              { label: 'Copy to Selected Strips', op: 'sequencer.strip_modifier_copy', props: { type: 'APPEND' } },
              { separator: true },
              { label: 'Move to First', icon: 'triangle_up', op: 'sequencer.strip_modifier_move_to_index', props: { modifier: m.name, index: 0 }, disabled: i === 0 },
              { label: 'Move to Last', icon: 'triangle_down', op: 'sequencer.strip_modifier_move_to_index', props: { modifier: m.name, index: s.modifiers.length - 1 }, disabled: i === s.modifiers.length - 1 },
            ],
            e.currentTarget as HTMLElement,
          );
        },
      },
      icon('down_arrow_hlt'),
    ),
    button(`seq-mod-x-${i}`, icon('x'), () => app.run('sequencer.strip_modifier_remove', { name: m.name }), { tip: 'Remove Modifier' }),
  );
  return panel(`seq-mod-${i}-${m.type}`, '', () => {
    const extra = extraModifierUI(s, m, maskRows);
    if (extra !== undefined) return extra;
    if (m.type === 'BRIGHT_CONTRAST') return [num(m, 'bright', 'Brightness', { precision: 3 }), num(m, 'contrast', 'Contrast', { min: -100, max: 100, precision: 3 }), maskRows(s, m)];
    if (m.type === 'WHITE_BALANCE') return [color(m as never, 'white_value', 'White Value'), maskRows(s, m)];
    if (m.type === 'SOUND_EQUALIZER') {
      const bands = (m.bands ??= []);
      const ed: PropOpts = { onChange: () => restartPlayback() };
      const redefine = h(
        'div',
        { class: 'row-aligned seq-eq-redefine' },
        ...EQUALIZER_LAYOUTS.map(([v, l]) => opButton('sequencer.strip_modifier_equalizer_redefine', l, { graphs: v, name: m.name }, { tip: 'Replace the bands with a new set spread over the audible range' })),
      );
      return [redefine, bands.map((b, i) =>
        panel(
          `seq-eq-${oid(m)}-${i}`,
          b.type === 'LOWSHELF' ? 'Low Shelf' : b.type === 'HIGHSHELF' ? 'High Shelf' : `Band ${i}`,
          () => [
            enumProp(b as never, 'type', 'Type', [
              ['LOWSHELF', 'Low Shelf'],
              ['PEAKING', 'Peak'],
              ['HIGHSHELF', 'High Shelf'],
            ]),
            num(b, 'frequency', 'Frequency', { min: 20, max: 20000, precision: 0, ...ed }),
            num(b, 'gain', 'Gain (dB)', { min: -36, max: 36, precision: 1, ...ed }),
            b.type === 'PEAKING' ? num(b, 'q', 'Q', { min: 0.1, max: 30, precision: 2, ...ed }) : null,
          ],
          { sub: true },
        ),
      )];
    }
    if (m.type === 'CURVES') {
      m.curve_mapping ??= {};
      // the curve widget of the RGB Curves node, drawing into the modifier's mapping
      const node = { id: oid(m), type: 'ShaderNodeRGBCurve', name: m.name, location: [0, 0], inputs: {}, props: m.curve_mapping } as unknown as NodeData;
      return [
        h('div', { class: 'seq-curves' }, drawCurves({ node, tree: { type: 'COMPOSITOR', nodes: [], links: [] } as unknown as NodeTreeData, key: `seq-curve-${oid(m)}`, where: 'sidebar', changed: (label, final) => (app.changed('doc'), final !== false && app.pushUndo(label)) })),
        maskRows(s, m),
      ];
    }
    const cb = m.color_balance!;
    const lgg = cb.correction_method === 'LIFT_GAMMA_GAIN';
    return [
      enumProp(cb, 'correction_method', 'Color Balance', [['LIFT_GAMMA_GAIN', 'Lift/Gamma/Gain'], ['OFFSET_POWER_SLOPE', 'Offset/Power/Slope (ASC-CDL)']]),
      h(
        'div',
        { class: 'seq-cb' },
        lgg ? [vec3Rows(cb, 'lift', 'Lift', 'invert_lift'), vec3Rows(cb, 'gamma', 'Gamma', 'invert_gamma'), vec3Rows(cb, 'gain', 'Gain', 'invert_gain')] : [vec3Rows(cb, 'offset', 'Offset', 'invert_offset'), vec3Rows(cb, 'power', 'Power', 'invert_power'), vec3Rows(cb, 'slope', 'Slope', 'invert_slope')],
      ),
      num(m, 'color_multiply', 'Multiply', { min: 0, max: 20, softMax: 2, precision: 3 }),
      maskRows(s, m),
    ];
  }, { header, className: `seq-mod-panel${(s.active_modifier ?? s.modifiers[s.modifiers.length - 1]?.name) === m.name ? ' active' : ''}` });
}

export function modifiersTab(): Child {
  const s = hasEditor() ? activeStrip() : null;
  if (!s) return h('div', { class: 'sb-empty' }, 'No active strip');
  return [
    stripHeader(s),
    h(
      'div',
      { class: 'seq-mod-add' },
      h(
        'button',
        {
          class: 'btn seq-add-mod',
          'data-tip': 'Add Modifier\nAdd a modifier to the active strip',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(modifierAddItems(s), e.currentTarget as HTMLElement);
          },
        },
        icon('add'),
        'Add Modifier',
        icon('down_arrow_hlt', 'tiny'),
      ),
    ),
    s.modifiers.map((m, i) => modifierPanel(s, m, i)),
  ];
}

// ---------------------------------------------------------------------------
// cache

export function cacheTab(info: { previewSize: string; renderMs: number; scale: number }): Child {
  const st = movieCacheStats();
  return [
    proxyPanel(info.previewSize),
    panel('seq-cache', 'Cache', () => [
      hasEditor() ? checkbox('seq-cache-final', 'Final Frames', seqEditor().use_cache_final !== false, (v) => ((seqEditor().use_cache_final = v), app.pushUndo('Cache Settings'), app.changed('doc')), { tip: 'Keep composited frames so scrubbing back to them is instant' }) : null,
      splitRow('Movies', h('span', { class: 'seq-src' }, String(st.movies))),
      splitRow('Cached Frames', h('span', { class: 'seq-src' }, String(st.frames))),
      splitRow('', opButton('sequencer.refresh_all', 'Clear Cache', {}, { icon: 'file_refresh' })),
    ]),
    panel('seq-proxy', 'Preview', () => [
      splitRow('Preview Size', h('span', { class: 'seq-src' }, info.previewSize === 'AUTO' ? `Automatic (${Math.round(info.scale * 100)}%)` : info.previewSize === 'SCENE' ? 'Scene Size' : `${info.previewSize.slice(6)}%`)),
      splitRow('Last Render', h('span', { class: 'seq-src' }, `${info.renderMs.toFixed(1)} ms`)),
    ]),
  ];
}

// ---------------------------------------------------------------------------
// view

/** Frame overlay switch (Shift O) and "reference = current frame" (O). */
export function toggleFrameOverlay() {
  const ed = seqEditor();
  ed.show_overlay_frame = !ed.show_overlay_frame;
  app.pushUndo(ed.show_overlay_frame ? 'Show Frame Overlay' : 'Hide Frame Overlay');
  app.changed('doc');
}

export function setOverlayReference() {
  const ed = seqEditor();
  ed.use_overlay_frame_lock = true;
  ed.overlay_frame = app.doc.scene.frame_current;
  ed.show_overlay_frame = true;
  app.pushUndo('Set Overlay Reference');
  app.changed('doc');
}

/** View tab: frame overlay and the 2D cursor (safe areas and guides: previewGuidePanels). */
export function viewTab(): Child {
  const ed = seqEditor();
  const ts = toolSettings();
  const cur = ts.cursor_location ?? [0, 0];
  const lock = !!ed.use_overlay_frame_lock;
  const changed = (label: string) => (app.pushUndo(label), app.changed('doc'));
  return [
    panel('seq-overlay-frame', 'Frame Overlay', () => [
      checkbox('seq-ofr-show', 'Show (Shift O)', !!ed.show_overlay_frame, (v) => ((ed.show_overlay_frame = v), changed('Frame Overlay'))),
      splitRow(
        lock ? 'Frame' : 'Frame Offset',
        numberField({ id: 'seq-ofr-frame', value: ed.overlay_frame ?? 0, int: true, set: (v, f) => ((ed.overlay_frame = Math.round(v)), app.changed('doc'), f && app.pushUndo('Overlay Frame')) }),
      ),
      checkbox('seq-ofr-lock', 'Lock to Frame', lock, (v) => {
        // switching keeps the same reference frame
        const f = app.doc.scene.frame_current;
        ed.overlay_frame = v ? f + (ed.overlay_frame ?? 0) : (ed.overlay_frame ?? f) - f;
        ed.use_overlay_frame_lock = v;
        changed('Overlay Lock');
      }),
      splitRow(
        'Overlay Type',
        enumMenu(
          'seq-ofr-type',
          [
            { value: 'RECTANGLE', label: 'Rectangle', description: 'The reference frame shows inside a rectangle over the current one' },
            { value: 'REFERENCE', label: 'Reference', description: 'Only the reference frame shows' },
            { value: 'CURRENT', label: 'Current', description: 'Only the current frame shows' },
          ],
          ed.overlay_frame_type ?? 'RECTANGLE',
          (v) => ((ed.overlay_frame_type = v as 'RECTANGLE'), changed('Overlay Type')),
        ),
      ),
      splitRow('', button('seq-ofr-ref', 'Reference = Current Frame (O)', () => setOverlayReference())),
    ]),
    panel('seq-2dcursor', '2D Cursor', () => [
      splitRow('Location X', numberField({ id: 'seq-cur-x', value: cur[0], unit: 'pixel', precision: 0, set: (v, f) => ((ts.cursor_location = [v, cur[1]]), app.changed('ui'), f && app.pushUndo('2D Cursor')) })),
      splitRow('Y', numberField({ id: 'seq-cur-y', value: cur[1], unit: 'pixel', precision: 0, set: (v, f) => ((ts.cursor_location = [cur[0], v]), app.changed('ui'), f && app.pushUndo('2D Cursor')) })),
    ]),
  ];
}

/** View tab: safe areas (shared with the camera's), the 4:3 centre-cut ones and composition guides of the preview. */
export function previewGuidePanels(pv: { opts: { safeAreas: boolean; safeCenter: boolean; guides: boolean }; composition: PreviewGuides; displayChannel: number; draw(): void; request(): void }, redraw: () => void): Child[] {
  const sc = app.doc.scene;
  const sa = () => (sc.safe_areas ??= JSON.parse(JSON.stringify(DEFAULT_SAFE_AREAS)) as NonNullable<typeof sc.safe_areas>);
  const pair = (key: 'title' | 'action' | 'title_center' | 'action_center', label: string) =>
    [0, 1].map((i) =>
      splitRow(
        i ? 'Y' : label,
        numberField({
          id: `seq-sa-${key}-${i}`,
          value: (sc.safe_areas ?? DEFAULT_SAFE_AREAS)[key][i],
          min: 0,
          max: 1,
          slider: true,
          unit: 'factor',
          set: (v, f) => {
            const a = sa();
            a[key] = (i ? [a[key][0], v] : [v, a[key][1]]) as [number, number];
            pv.draw();
            if (f) app.pushUndo('Safe Areas');
          },
        }),
      ),
    );
  const g = pv.composition;
  const gt = (key: Exclude<keyof PreviewGuides, 'composition_guide_color'>, label: string) => checkbox(`seq-cg-${key}`, label, g[key], (v) => ((g[key] = v), (pv.opts.guides = true), redraw()));
  return [
    panel('seq-view-settings', 'View Settings', () => [
      splitRow(
        'Channel',
        numberField({
          id: 'seq-display-channel',
          value: pv.displayChannel,
          int: true,
          min: 0,
          max: 128,
          tip: 'Preview the channels up to this one only (0 shows every channel)',
          set: (v) => {
            pv.displayChannel = Math.max(0, Math.round(v));
            pv.request();
          },
        }),
      ),
    ]),
    panel('seq-safe', 'Safe Areas', () => [checkbox('seq-safe-show', 'Show Safe Areas', pv.opts.safeAreas, (v) => ((pv.opts.safeAreas = v), redraw())), ...pair('title', 'Title X'), ...pair('action', 'Action X')]),
    panel('seq-safe-center', 'Center-Cut Safe Areas', () => [checkbox('seq-safe-cc', 'Show Center-Cut', pv.opts.safeCenter, (v) => ((pv.opts.safeCenter = v), redraw())), ...pair('title_center', 'Title X'), ...pair('action_center', 'Action X')], { closed: true }),
    panel(
      'seq-guides',
      'Composition Guides',
      () => [
        gt('show_composition_thirds', 'Thirds'),
        h('div', { class: 'pop-label' }, 'Center'),
        gt('show_composition_center', 'Center'),
        gt('show_composition_center_diagonal', 'Diagonal'),
        h('div', { class: 'pop-label' }, 'Golden'),
        gt('show_composition_golden', 'Ratio'),
        gt('show_composition_golden_tria_a', 'Triangle A'),
        gt('show_composition_golden_tria_b', 'Triangle B'),
        h('div', { class: 'pop-label' }, 'Harmony'),
        gt('show_composition_harmony_tri_a', 'Triangle A'),
        gt('show_composition_harmony_tri_b', 'Triangle B'),
        splitRow('Color', colorSwatch('seq-cg-color', g.composition_guide_color, (v) => ((g.composition_guide_color = [v[0], v[1], v[2]]), redraw()))),
      ],
      { closed: true },
    ),
  ];
}
