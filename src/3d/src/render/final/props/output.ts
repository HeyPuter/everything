// Properties ▸ Output: image format, frame range, output files and metadata.
import { h, type Child } from '../../../ui/h';
import { app } from '../../../app/app';
import { registerTab } from '../../../editors/properties/properties';
import { panel, enumMenu, numberField, textField, checkbox, opButton } from '../../../ui/widgets';
import { num, bool, enumProp, colorProp, splitRow, textProp } from '../../../ui/props';
import type { RenderSettings } from '../../../data/types';
import { renderSettings, changed, headerToggle, sub } from './common';
import { FPS_PRESETS, fpsPreset, fpsFromPreset } from '../units';

let customFps = false;

/** Common output formats: [label, x, y, pixel aspect x, y, fps]. */
export const FORMAT_PRESETS: [string, number, number, number, number, number][] = [
  ['HDTV 1080p', 1920, 1080, 1, 1, 24],
  ['HDTV 720p', 1280, 720, 1, 1, 24],
  ['4K UHDTV', 3840, 2160, 1, 1, 24],
  ['4K DCI', 4096, 2160, 1, 1, 24],
  ['2K DCI', 2048, 1080, 1, 1, 24],
  ['TV NTSC 4:3', 720, 486, 10, 11, 29.97],
  ['TV PAL 4:3', 720, 576, 12, 11, 25],
  ['Square 1080', 1080, 1080, 1, 1, 30],
  ['Portrait 1080 × 1920', 1080, 1920, 1, 1, 30],
  ['Portrait 1080 × 1350', 1080, 1350, 1, 1, 30],
];

function formatPanel(r: RenderSettings): Child {
  const preset = fpsPreset(r);
  const showCustom = customFps || preset === 'custom';
  return panel('out-format', 'Format', () => [
    splitRow(
      'Resolution X',
      numberField({ id: 'res-x', value: r.resolution_x, int: true, min: 4, max: 65536, unit: 'pixel', set: (v, f) => ((r.resolution_x = v), app.changed('doc'), f && app.pushUndo('Resolution')) }),
      opButton('render.swap_dimensions', '', {}, { icon: 'rs_swap', className: 'out-swap', tip: 'Swap width and height' }),
    ),
    splitRow('Y', numberField({ id: 'res-y', value: r.resolution_y, int: true, min: 4, max: 65536, unit: 'pixel', set: (v, f) => ((r.resolution_y = v), app.changed('doc'), f && app.pushUndo('Resolution')) })),
    num(r, 'resolution_percentage', '%', { unit: 'percentage', int: true, min: 1, max: 1000, softMax: 100, slider: true }),
    num(r, 'pixel_aspect_x', 'Aspect X', { min: 1, max: 200, tip: 'Horizontal pixel aspect (non-square pixels)' }),
    num(r, 'pixel_aspect_y', 'Y', { min: 1, max: 200 }),
    bool(r, 'use_border', 'Render Region', { tip: 'Render only the region set with Ctrl B in camera view' }),
    bool(r, 'use_crop_to_border', 'Crop to Render Region', { disabled: !r.use_border, tip: 'Output only the region instead of a full frame with transparent surroundings' }),
    splitRow(
      'Frame Rate',
      enumMenu(
        'fps',
        [...FPS_PRESETS.map((v) => ({ value: String(v), label: `${v} fps` })), { value: 'custom', label: 'Custom' }],
        showCustom ? 'custom' : preset,
        (v) => {
          if (v === 'custom') {
            customFps = true;
            app.changed('ui');
            return;
          }
          customFps = false;
          Object.assign(r, fpsFromPreset(Number(v)));
          changed('Frame Rate');
        },
      ),
    ),
    showCustom ? [num(r, 'fps', 'FPS', { int: true, min: 1, max: 1000, softMax: 240 }), num(r, 'fps_base', 'Base', { min: 1e-5, max: 1e6, softMin: 0.1, softMax: 120, precision: 3 })] : null,
  ]);
}

function frameRangePanel(r: RenderSettings): Child {
  const s = app.doc.scene;
  return panel('out-range', 'Frame Range', () => [
    num(s, 'frame_start', 'Frame Start', { int: true, min: 0 }),
    num(s, 'frame_end', 'End', { int: true, min: 0 }),
    num(s, 'frame_step', 'Step', { int: true, min: 1 }),
    sub(
      'out-stretch',
      'Time Stretching',
      () => [
        num(r, 'frame_map_old', 'Old', { int: true, min: 1, max: 900, tip: 'Number of frames of the animation…' }),
        num(r, 'frame_map_new', 'New', { int: true, min: 1, max: 900, tip: '…stretched over this many frames (e.g. Old 100, New 200 plays at half speed)' }),
      ],
      { closed: true },
    ),
  ]);
}

function outputPanel(r: RenderSettings): Child {
  const fmt = r.file_format;
  const colors: [string, string][] = fmt === 'JPEG' || fmt === 'WEBM' ? [['BW', 'BW'], ['RGB', 'RGB']] : [['BW', 'BW'], ['RGB', 'RGB'], ['RGBA', 'RGBA']];
  if (r.color_mode === 'RGBA' && colors.length === 2) r.color_mode = 'RGB';
  return panel('out-output', 'Output', () => [
    textProp(r, 'filepath', 'Output Path'),
    h('div', { class: 'sub-label' }, 'Saving'),
    bool(r, 'use_file_extension', 'File Extensions', { tip: 'Add the file format extension to rendered file names' }),
    enumProp(r, 'file_format', 'File Format', [['PNG', 'PNG'], ['JPEG', 'JPEG'], ['WEBP', 'WebP'], ['WEBM', 'WebM Video']]),
    enumProp(r, 'color_mode', 'Color', colors),
    fmt !== 'PNG' ? num(r, 'quality', 'Quality', { int: true, unit: 'percentage', min: 0, max: 100, slider: true, tip: fmt === 'WEBM' ? 'Video quality (bitrate)' : 'Compression quality of lossy formats' }) : null,
    fmt === 'PNG' ? h('div', { class: 'prop-note' }, 'Animations are saved as a ZIP of numbered PNG files; the metadata below is stored in each file.') : fmt === 'WEBM' ? h('div', { class: 'prop-note' }, 'Animations are saved as a WebM video.') : null,
  ]);
}

function metadataPanel(r: RenderSettings): Child {
  const fields: [keyof RenderSettings & string, string][] = [
    ['use_stamp_date', 'Date'],
    ['use_stamp_time', 'Time'],
    ['use_stamp_render_time', 'Render Time'],
    ['use_stamp_frame', 'Frame'],
    ['use_stamp_frame_range', 'Frame Range'],
    ['use_stamp_memory', 'Memory'],
    ['use_stamp_hostname', 'Hostname'],
    ['use_stamp_camera', 'Camera'],
    ['use_stamp_lens', 'Lens'],
    ['use_stamp_scene', 'Scene'],
    ['use_stamp_marker', 'Marker'],
    ['use_stamp_filename', 'Filename'],
  ];
  return panel(
    'out-metadata',
    'Metadata',
    () => [
      h(
        'div',
        { class: 'out-stamp-grid' },
        fields.map(([k, l]) =>
          checkbox(`out-${k}`, l, !!r[k], (v) => {
            (r as unknown as Record<string, boolean>)[k] = v;
            changed(`Metadata ${l}`);
          }, { tip: `Include the ${l.toLowerCase()} in the metadata of rendered images` }),
        ),
      ),
      sub(
        'out-stamp-note',
        'Note',
        () => [splitRow('', textField('out-note-text', r.stamp_note_text ?? '', (v) => ((r.stamp_note_text = v), changed('Stamp Note'))))],
        { closed: true, header: headerToggle(r, 'use_stamp_note', 'Stamp Note') },
      ),
      sub(
        'out-stamp-burn',
        'Burn Into Image',
        () => [
          num(r, 'stamp_font_size', 'Font Size', { int: true, min: 8, max: 64 }),
          colorProp(r, 'stamp_foreground' as never, 'Text Color', { alpha: true }),
          colorProp(r, 'stamp_background' as never, 'Background', { alpha: true }),
          bool(r, 'use_stamp_labels', 'Include Labels', { tip: 'Draw the name of each field before its value' }),
        ],
        { closed: true, header: headerToggle(r, 'use_stamp', 'Burn Into Image') },
      ),
    ],
    { closed: true },
  );
}

registerTab({
  id: 'OUTPUT',
  label: 'Output',
  icon: 'output',
  group: 1,
  poll: () => true,
  draw: () => {
    const r = renderSettings();
    return [formatPanel(r), frameRangePanel(r), outputPanel(r), metadataPanel(r)];
  },
});
