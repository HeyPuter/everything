// Clip editor regions: Toolbar (T, "Track" tab: Clip, Marker, Tracking Settings, Track panels)
// and Sidebar (N: Track, Footage and Stabilization tabs).
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { panel, numberField, checkbox, enumMenu, textField, opButton, colorSwatch, toggleButton } from '../ui/widgets';
import { num, bool, enumProp, splitRow, vecProp } from '../ui/props';
import { activeTrack, clipFrameToSourceIndex, ensureMarker, focalPixels, markerAt, markerExact, type MovieClipData, type MovieTrackingTrack, type MotionModel } from './types';
import { readySource, frameCache, cacheSettings } from './source';
import { measureMotion } from './stabilize';
import type { ClipEditor } from './editor';

const MODELS: [MotionModel, string][] = [
  ['Loc', 'Location'],
  ['LocRot', 'Location & Rotation'],
  ['LocScale', 'Location & Scale'],
  ['LocRotScale', 'Location, Rotation & Scale'],
  ['Affine', 'Affine'],
];
const MATCH: [string, string][] = [
  ['KEYFRAME', 'Keyframe'],
  ['PREV_FRAME', 'Previous Frame'],
];

const commit = (label: string, final = true) => {
  app.changed('doc');
  if (final) app.pushUndo(label);
};

const valueRow = (label: string, value: string) => splitRow(label, h('span', { class: 'clip-value' }, value));

function rgbToggles(owner: Record<string, unknown>, keys: [string, string, string], id: string) {
  return h(
    'div',
    { class: 'row-aligned clip-rgb' },
    (['R', 'G', 'B'] as const).map((l, i) =>
      toggleButton(`${id}-${l}`, l, !!owner[keys[i]], (v) => {
        owner[keys[i]] = v;
        commit('Change Channel');
      }, { tip: `Use ${['Red', 'Green', 'Blue'][i]} Channel\nUse this channel for tracking` }),
    ),
  );
}

// ---------------------------------------------------------------------------
// toolbar

export function drawToolbar(ed: ClipEditor): Child {
  const c = ed.clip;
  const body: Child[] = [];
  if (!c) body.push(h('div', { class: 'sb-empty' }, 'No movie clip'), opButton('clip.open', 'Open…', {}, { icon: 'file_folder' }));
  else {
    const s = c.tracking.settings;
    body.push(
      panel('clip-t-clip', 'Clip', () => [h('div', { class: 'btn-col' }, opButton('clip.set_scene_frames', 'Set Scene Frames')), h('div', { class: 'btn-row' }, opButton('clip.prefetch', 'Prefetch'), opButton('clip.reload', 'Reload'))]),
      panel('clip-t-marker', 'Marker', () => [h('div', { class: 'btn-row' }, opButton('clip.add_marker_at_click', 'Add'), opButton('clip.delete_track', 'Delete')), h('div', { class: 'btn-col' }, opButton('clip.detect_features', 'Detect Features'))]),
      panel('clip-t-settings', 'Tracking Settings', () => [
        num(s, 'default_pattern_size', 'Pattern Size', { int: true, min: 5, max: 1000, unit: 'pixel', tip: 'Size of pattern area for newly created tracks' }),
        num(s, 'default_search_size', 'Search Size', { int: true, min: 5, max: 1000, unit: 'pixel', tip: 'Size of search area for newly created tracks' }),
        enumProp(s, 'default_motion_model', 'Motion Model', MODELS, { tip: 'Default motion model to use for tracking' }),
        enumProp(s, 'default_pattern_match', 'Match', MATCH, { tip: 'Track pattern from given frame when tracking marker to next frame' }),
        bool(s, 'use_default_brute', 'Prepass', { tip: 'Use a brute-force translation-only initialization when tracking' }),
        bool(s, 'use_default_normalization', 'Normalize', { tip: 'Normalize light intensities while tracking (slower)' }),
        splitRow('', rgbToggles(s as unknown as Record<string, unknown>, ['use_default_red_channel', 'use_default_green_channel', 'use_default_blue_channel'], 'clip-def-rgb')),
        h('div', { class: 'btn-col' }, opButton('clip.track_settings_as_default', 'Copy from Active Track')),
        panel(
          'clip-t-settings-extra',
          'Tracking Settings Extra',
          () => [
            num(s, 'default_weight', 'Weight', { min: 0, max: 1, slider: true, unit: 'factor' }),
            num(s, 'default_correlation_min', 'Correlation', { min: 0, max: 1, slider: true, unit: 'factor', tip: 'Default minimum value of correlation between matched pattern and reference that is still treated as successful tracking' }),
            num(s, 'default_margin', 'Margin', { int: true, min: 0, max: 300, unit: 'pixel', tip: 'Default distance from image boundary at which marker stops tracking' }),
            num(s, 'default_frames_limit', 'Frames Limit', { int: true, min: 0, max: 32767, tip: 'Every tracking cycle, this number of frames are tracked (0 = unlimited)' }),
          ],
          { sub: true, closed: true },
        ),
      ]),
      panel('clip-t-track', 'Track', () => {
        const ib = (op: string, ic: string, props: Record<string, unknown>, tip: string) =>
          h(
            'button',
            { key: `${op}-${ic}`, class: 'btn icon-btn', disabled: !app.poll(op), 'data-tip': tip, onclick: () => app.run(op, props, { area: ed.area }) },
            icon(ic),
          );
        return [
          h(
            'div',
            { class: 'clip-tool-row' },
            h('span', { class: 'clip-tool-label' }, 'Track:'),
            h(
              'div',
              { class: 'row-aligned' },
              ib('clip.track_markers', 'tracking_backwards_single', { backwards: true, sequence: false }, 'Track Markers\nTrack selected markers one frame backwards (Alt ←)'),
              ib('clip.track_markers', 'tracking_backwards', { backwards: true, sequence: true }, 'Track Markers\nTrack selected markers backwards (Shift Ctrl T)'),
              ib('clip.track_markers', 'tracking_forwards', { backwards: false, sequence: true }, 'Track Markers\nTrack selected markers forwards (Ctrl T)'),
              ib('clip.track_markers', 'tracking_forwards_single', { backwards: false, sequence: false }, 'Track Markers\nTrack selected markers one frame forwards (Alt →)'),
            ),
          ),
          h(
            'div',
            { class: 'clip-tool-row' },
            h('span', { class: 'clip-tool-label' }, 'Clear:'),
            h(
              'div',
              { class: 'row-aligned' },
              ib('clip.clear_track_path', 'tracking_clear_backwards', { action: 'UPTO' }, 'Clear Track Path\nClear path up to current frame (Shift T)'),
              ib('clip.clear_track_path', 'tracking_clear_forwards', { action: 'REMAINED' }, 'Clear Track Path\nClear path after the current frame (Alt T)'),
            ),
          ),
          h(
            'div',
            { class: 'clip-tool-row' },
            h('span', { class: 'clip-tool-label' }, 'Refine:'),
            h(
              'div',
              { class: 'row-aligned' },
              ib('clip.refine_markers', 'tracking_refine_backwards', { backwards: true }, 'Refine Markers\nRefine markers from the next keyframe'),
              ib('clip.refine_markers', 'tracking_refine_forwards', { backwards: false }, 'Refine Markers\nRefine markers from the previous keyframe'),
            ),
          ),
          h('div', { class: 'clip-tool-row' }, h('span', { class: 'clip-tool-label' }, 'Merge:'), h('div', { class: 'btn-col' }, opButton('clip.join_tracks', 'Join Tracks'), opButton('clip.average_tracks', 'Average Tracks'))),
        ];
      }),
    );
  }
  return h('div', { key: 'toolbar', class: 'clip-toolbar' }, h('div', { class: 'sb-body' }, body), h('div', { class: 'sb-tabs' }, h('button', { class: 'sb-tab on' }, 'Track')));
}

// ---------------------------------------------------------------------------
// sidebar

const TABS = ['Track', 'Footage', 'Stabilization'];

export function drawSidebar(ed: ClipEditor): Child {
  const c = ed.clip;
  if (!TABS.includes(ed.sidebarTab)) ed.sidebarTab = 'Track';
  let body: Child[];
  if (!c) body = [h('div', { class: 'sb-empty' }, 'No active movie clip')];
  else if (ed.sidebarTab === 'Footage') body = footageTab(c);
  else if (ed.sidebarTab === 'Stabilization') body = stabilizationTab(ed, c);
  else body = trackTab(ed, c);
  return h(
    'div',
    { key: 'sidebar', class: 'clip-sidebar' },
    h('div', { class: 'sb-body' }, body),
    h(
      'div',
      { class: 'sb-tabs' },
      TABS.map((t) => h('button', { key: t, class: { 'sb-tab': true, on: t === ed.sidebarTab }, onclick: () => ((ed.sidebarTab = t), ed.drawUI()) }, t)),
    ),
  );
}

function trackTab(ed: ClipEditor, c: MovieClipData): Child[] {
  const t = activeTrack(c);
  const f = ed.clipFrame;
  const out: Child[] = [];
  out.push(
    panel('clip-n-track', 'Track', () => {
      if (!t) return h('div', { class: 'sb-empty' }, 'No active track');
      return [
        h(
          'div',
          { class: 'clip-name-row' },
          textField(`clip-tname-${t.name}`, t.name, (v) => {
            if (!v || v === t.name || c.tracking.tracks.some((o) => o.name === v)) return;
            // keep references by name in constraints in sync
            for (const ob of Object.values(app.doc.objects)) for (const con of ob.constraints) if (con.type === 'FOLLOW_TRACK' && con.track === t.name) con.track = v;
            if (c.tracking.active_track === t.name) c.tracking.active_track = v;
            t.name = v;
            commit('Rename Track');
          }),
          toggleButton('clip-tlock', icon(t.lock ? 'locked' : 'unlocked'), t.lock, (v) => ((t.lock = v), commit(v ? 'Lock Track' : 'Unlock Track')), { tip: 'Lock\nTrack is locked and all changes to it are disabled' }),
        ),
        h(
          'div',
          { class: 'clip-preview-row' },
          rgbToggles(t as unknown as Record<string, unknown>, ['use_red_channel', 'use_green_channel', 'use_blue_channel'], 'clip-trgb'),
          toggleButton('clip-tbw', 'B/W', t.use_grayscale_preview, (v) => ((t.use_grayscale_preview = v), commit('Grayscale Preview')), { tip: 'Grayscale\nDisplay what the tracking algorithm sees in the preview' }),
        ),
        h('canvas', { key: 'pattern-preview', class: 'clip-pattern-preview', width: 240, height: 160 }),
        num(t, 'weight', 'Weight', { min: 0, max: 1, slider: true, unit: 'factor', tip: 'Influence of this track on a final solution' }),
        num(t, 'weight_stab', 'Stab Weight', { min: 0, max: 1, slider: true, unit: 'factor', tip: 'Influence of this track on 2D stabilization' }),
        h('div', { class: 'clip-info' }, t.last_correlation !== undefined ? `Correlation of the last tracked frame: ${t.last_correlation.toFixed(3)}` : 'Not tracked yet'),
        splitRow(
          'Custom Color',
          h(
            'div',
            { class: 'clip-color-row' },
            checkbox('clip-tcc', '', t.use_custom_color, (v) => ((t.use_custom_color = v), commit('Custom Color'))),
            colorSwatch('clip-tcolor', t.color, (v, fin) => ((t.color = [v[0], v[1], v[2]]), commit('Track Color', fin)), { linear: false }),
            h('button', { class: 'btn icon-btn', 'data-tip': 'Copy Color\nCopy color to all selected tracks', disabled: !app.poll('clip.track_copy_color'), onclick: () => app.run('clip.track_copy_color') }, icon('duplicate')),
          ),
        ),
      ];
    }),
  );
  if (t)
    out.push(
      panel('clip-n-tsettings', 'Tracking Settings', () => [
        enumProp(t, 'motion_model', 'Motion Model', MODELS, { tip: 'Default motion model to use for tracking' }),
        enumProp(t, 'pattern_match', 'Match', MATCH, { tip: 'Track pattern from given frame when tracking marker to next frame' }),
        bool(t, 'use_brute', 'Prepass', { tip: 'Use a brute-force translation-only pre-track before refinement' }),
        bool(t, 'use_normalization', 'Normalize', { tip: 'Normalize light intensities while tracking. Slower' }),
        panel(
          'clip-n-tsettings-extra',
          'Tracking Settings Extras',
          () => [
            num(t, 'correlation_min', 'Correlation', { min: 0, max: 1, slider: true, unit: 'factor', tip: 'Minimal value of correlation between matched pattern and reference that is still treated as successful tracking' }),
            num(t, 'margin', 'Margin', { int: true, min: 0, max: 300, unit: 'pixel', tip: 'Distance from image boundary at which marker stops tracking' }),
            num(t, 'frames_limit', 'Frames Limit', { int: true, min: 0, max: 32767, tip: 'Every tracking cycle, this number of frames are tracked (0 = unlimited)' }),
          ],
          { sub: true, closed: true },
        ),
      ]),
    );
  const cam = c.tracking.camera;
  out.push(
    panel('clip-n-camera', 'Camera', () => [
      num(cam, 'sensor_width', 'Sensor Width', { min: 0, max: 500, unit: 'none', tip: 'Width of CCD sensor in millimeters' }),
      num(cam, 'pixel_aspect', 'Pixel Aspect', { min: 0.1, max: 5000, tip: 'Pixel aspect ratio' }),
      panel(
        'clip-n-lens',
        'Lens',
        () => [
          cam.units === 'MILLIMETERS'
            ? num(cam, 'focal_length', 'Focal Length', { min: 0.0001, max: 5000, tip: "Camera's focal length (mm)" })
            : splitRow(
                'Focal Length',
                numberField({
                  id: 'clip-focal-px',
                  value: focalPixels(c),
                  min: 0,
                  unit: 'pixel',
                  set: (v, fin) => {
                    cam.focal_length = (v * cam.sensor_width) / Math.max(1, c.size[0]);
                    commit('Change Focal Length', fin);
                  },
                }),
              ),
          enumProp(cam, 'units', 'Units', [
            ['PIXELS', 'px'],
            ['MILLIMETERS', 'mm'],
          ]),
          vecProp(cam, 'principal_point', 'Optical Center', { min: -1, max: 1, step: 0.01 }),
          h('div', { class: 'btn-col' }, opButton('clip.set_center_principal', 'Set Principal to Center')),
          enumProp(cam, 'distortion_model', 'Lens Distortion', [['POLYNOMIAL', 'Polynomial']]),
          num(cam, 'k1', 'K1', { softMin: -10, softMax: 10, precision: 4, tip: 'First coefficient of third order polynomial radial distortion' }),
          num(cam, 'k2', 'K2', { softMin: -10, softMax: 10, precision: 4, tip: 'Second coefficient of third order polynomial radial distortion' }),
          num(cam, 'k3', 'K3', { softMin: -10, softMax: 10, precision: 4, tip: 'Third coefficient of third order polynomial radial distortion' }),
          h('div', { class: 'clip-info' }, 'Distortion is used by the Follow Track constraint (Undistort).'),
        ],
        { sub: true },
      ),
    ]),
  );
  if (t) out.push(panel('clip-n-marker', 'Marker', () => markerPanel(ed, c, t, f)));
  return out;
}

function markerPanel(ed: ClipEditor, c: MovieClipData, t: MovieTrackingTrack, f: number): Child {
  const held = markerAt(t, f);
  if (!held) return h('div', { class: 'sb-empty' }, 'No marker');
  const exact = markerExact(t, f);
  const [W, H] = c.size;
  const edit = (label: string, fn: (m: NonNullable<ReturnType<typeof ensureMarker>>) => void, fin: boolean) => {
    if (t.lock) return;
    const m = ensureMarker(t, f);
    if (!m) return;
    fn(m);
    commit(label, fin);
  };
  const field = (id: string, label: string, value: number, set: (v: number, fin: boolean) => void, unit: 'pixel' | 'none' = 'pixel') => splitRow(label, numberField({ id, value, unit, disabled: t.lock, set }));
  const patW = (Math.max(...held.pattern_corners.map((p) => p[0])) - Math.min(...held.pattern_corners.map((p) => p[0]))) * W;
  const patH = (Math.max(...held.pattern_corners.map((p) => p[1])) - Math.min(...held.pattern_corners.map((p) => p[1]))) * H;
  return [
    h(
      'div',
      { class: 'split-row check' },
      h('div', { class: 'sr-label' }),
      h(
        'div',
        { class: 'sr-value' },
        checkbox('clip-menabled', 'Enabled', !held.mute, (v) => edit(v ? 'Enable Marker' : 'Disable Marker', (m) => (m.mute = !v), true), { disabled: t.lock, tip: 'Marker is enabled at the current frame' }),
      ),
    ),
    valueRow('Status', held.mute ? 'Disabled' : exact ? (exact.is_keyed ? 'Keyframed' : 'Tracked') : 'Estimated (held)'),
    field('clip-mx', 'Position X', held.co[0] * W, (v, fin) => edit('Move Marker', (m) => (m.co = [v / W, m.co[1]]), fin)),
    field('clip-my', 'Y', held.co[1] * H, (v, fin) => edit('Move Marker', (m) => (m.co = [m.co[0], v / H]), fin)),
    splitRow('Offset X', numberField({ id: 'clip-ox', value: t.offset[0] * W, unit: 'pixel', disabled: t.lock, set: (v, fin) => ((t.offset = [v / W, t.offset[1]]), commit('Track Offset', fin)) })),
    splitRow('Y', numberField({ id: 'clip-oy', value: t.offset[1] * H, unit: 'pixel', disabled: t.lock, set: (v, fin) => ((t.offset = [t.offset[0], v / H]), commit('Track Offset', fin)) })),
    field('clip-pw', 'Pattern Width', patW, (v, fin) =>
      edit('Pattern Size', (m) => {
        const k = v / Math.max(1e-6, patW);
        m.pattern_corners = m.pattern_corners.map((p) => [p[0] * k, p[1]]) as typeof m.pattern_corners;
      }, fin),
    ),
    field('clip-ph', 'Height', patH, (v, fin) =>
      edit('Pattern Size', (m) => {
        const k = v / Math.max(1e-6, patH);
        m.pattern_corners = m.pattern_corners.map((p) => [p[0], p[1] * k]) as typeof m.pattern_corners;
      }, fin),
    ),
    field('clip-sw', 'Search Width', (held.search_max[0] - held.search_min[0]) * W, (v, fin) => edit('Search Size', (m) => ((m.search_min = [-v / 2 / W, m.search_min[1]]), (m.search_max = [v / 2 / W, m.search_max[1]])), fin)),
    field('clip-sh', 'Height', (held.search_max[1] - held.search_min[1]) * H, (v, fin) => edit('Search Size', (m) => ((m.search_min = [m.search_min[0], -v / 2 / H]), (m.search_max = [m.search_max[0], v / 2 / H])), fin)),
  ];
}

function footageTab(c: MovieClipData): Child[] {
  const src = readySource(c);
  return [
    panel('clip-n-footage', 'Footage Settings', () => [
      valueRow('Source', c.source === 'MOVIE' ? 'Movie File' : 'Image Sequence'),
      valueRow('File', c.filepath || '—'),
      valueRow('Resolution', c.size[0] ? `${c.size[0]} × ${c.size[1]}` : '—'),
      valueRow('Duration', `${c.frame_duration} frames`),
      valueRow('Frame Rate', `${c.fps} fps`),
      valueRow('Decoder', src ? (src.kind === 'webcodecs' ? 'WebCodecs (frame accurate)' : src.kind === 'video' ? 'Video element seeking' : 'Image decoder') : 'Loading…'),
      num(c, 'frame_start', 'Start Frame', { int: true, tip: 'Global scene frame number at which this movie starts playing (affects all data associated with a clip)' }),
      num(c, 'frame_offset', 'Frame Offset', { int: true, tip: 'Offset of footage first frame relative to its file name (affects only how footage is loading, does not change data associated with a clip)' }),
    ]),
    panel('clip-n-cache', 'Cache', () => [
      splitRow(
        'Memory Limit',
        numberField({ id: 'clip-cache-limit', value: cacheSettings.limitMB, int: true, min: 64, max: 65536, unit: 'none', tip: 'Memory cache limit for decoded clip frames (MB)', set: (v) => ((cacheSettings.limitMB = v), app.changed('ui')) }),
      ),
      valueRow('Used', `${(frameCache.used / 1024 / 1024).toFixed(1)} MB`),
      valueRow('Cached Frames', src ? String(src.cached().length) : '0'),
      h('div', { class: 'btn-row' }, opButton('clip.prefetch', 'Prefetch'), opButton('clip.reload', 'Reload')),
    ]),
  ];
}

function stabilizationTab(ed: ClipEditor, c: MovieClipData): Child[] {
  const st = c.tracking.stabilization;
  const list = (key: 'use_2d_stabilization' | 'use_2d_stabilization_rotation', idxKey: 'active_track_index' | 'active_rotation_track_index', add: string, remove: string, select: string) => {
    const tracks = c.tracking.tracks.filter((t) => t[key]);
    return h(
      'div',
      { class: 'clip-list-wrap' },
      h(
        'div',
        { class: 'clip-list' },
        tracks.length
          ? tracks.map((t, i) =>
              h(
                'div',
                {
                  key: t.name,
                  class: { 'clip-list-item': true, on: i === st[idxKey] },
                  onclick: () => {
                    st[idxKey] = i;
                    app.changed('ui');
                  },
                },
                icon('tracker'),
                t.name,
              ),
            )
          : h('div', { class: 'clip-list-empty' }, 'No tracks'),
      ),
      h(
        'div',
        { class: 'clip-list-btns' },
        h('button', { class: 'btn icon-btn', 'data-tip': 'Add selected tracks', disabled: !app.poll(add), onclick: () => app.run(add) }, icon('add')),
        h('button', { class: 'btn icon-btn', 'data-tip': 'Remove the highlighted track', disabled: !app.poll(remove), onclick: () => app.run(remove) }, icon('remove')),
        h('button', { class: 'btn icon-btn', 'data-tip': 'Select these tracks', onclick: () => app.run(select) }, icon('select_box')),
      ),
    );
  };
  const motion = st.use_2d_stabilization ? measureMotion(c, ed.clipFrame) : null;
  return [
    panel(
      'clip-n-stab',
      '2D Stabilization',
      () => [
        num(st, 'anchor_frame', 'Anchor Frame', { int: true, min: 0, tip: 'Reference point to anchor stabilization (other frames will be adjusted relative to this frame\'s position)' }),
        splitRow(
          'Stabilization Type',
          h('div', { class: 'btn-col' }, checkbox('clip-st-rot', 'Rotation', st.use_stabilize_rotation, (v) => ((st.use_stabilize_rotation = v), commit('Stabilize Rotation'))), checkbox('clip-st-scale', 'Scale', st.use_stabilize_scale, (v) => ((st.use_stabilize_scale = v), commit('Stabilize Scale')), { disabled: !st.use_stabilize_rotation })),
        ),
        h('div', { class: 'sub-label' }, 'Tracks for Location'),
        list('use_2d_stabilization', 'active_track_index', 'clip.stabilize_2d_add', 'clip.stabilize_2d_remove', 'clip.stabilize_2d_select'),
        st.use_stabilize_rotation ? [h('div', { class: 'sub-label' }, 'Tracks for Rotation/Scale'), list('use_2d_stabilization_rotation', 'active_rotation_track_index', 'clip.stabilize_2d_rotation_add', 'clip.stabilize_2d_rotation_remove', 'clip.stabilize_2d_rotation_select')] : null,
        bool(st, 'use_autoscale', 'Autoscale', { tip: 'Automatically scale footage to cover unfilled areas when stabilizing' }),
        st.use_autoscale ? num(st, 'scale_max', 'Max', { min: 0, max: 10, tip: 'Limit the amount of automatic scaling' }) : null,
        vecProp(st, 'target_position', 'Target', { unit: 'pixel', names: ['X', 'Y'] }),
        st.use_stabilize_rotation ? num(st, 'target_rotation', 'Rotation', { unit: 'angle' }) : null,
        st.use_stabilize_scale ? num(st, 'target_scale', 'Scale', { min: 1e-6, softMin: 0.01, softMax: 10 }) : null,
        num(st, 'influence_location', 'Influence Location', { min: 0, max: 1, slider: true, unit: 'factor' }),
        st.use_stabilize_rotation ? num(st, 'influence_rotation', 'Rotation', { min: 0, max: 1, slider: true, unit: 'factor' }) : null,
        st.use_stabilize_scale ? num(st, 'influence_scale', 'Scale', { min: 0, max: 1, slider: true, unit: 'factor' }) : null,
        enumProp(st, 'filter_type', 'Interpolate', [
          ['NEAREST', 'Nearest'],
          ['BILINEAR', 'Bilinear'],
          ['BICUBIC', 'Bicubic'],
        ]),
        splitRow('', checkbox('clip-st-show', 'Show Stable (in this editor)', ed.overlays.show_stable, (v) => ((ed.overlays.show_stable = v), ed.draw(), ed.drawUI()), { tip: 'Display the stabilized footage in this clip editor' })),
        motion ? valueRow('Measured', `Δ ${motion.translation[0].toFixed(2)}, ${motion.translation[1].toFixed(2)} px${st.use_stabilize_rotation ? `, ${((motion.angle * 180) / Math.PI).toFixed(2)}°, ×${motion.scale.toFixed(4)}` : ''} (${motion.count} tracks)`) : null,
        h('div', { class: 'btn-col' }, opButton('clip.export_stabilized_footage', 'Export Stabilized Footage…'), opButton('clip.export_stabilization_data', 'Export Stabilization Data…')),
      ],
      {
        header: h('span', { class: 'panel-check', onpointerdown: (e: PointerEvent) => e.stopPropagation() }, checkbox('clip-st-use', '', st.use_2d_stabilization, (v) => ((st.use_2d_stabilization = v), commit(v ? 'Enable 2D Stabilization' : 'Disable 2D Stabilization')), { tip: 'Use 2D Stabilization\nUse 2D stabilization for footage' })),
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// pattern preview (Track panel)

export function drawPatternPreviews(ed: ClipEditor) {
  const cv = ed.ui.querySelector<HTMLCanvasElement>('.clip-pattern-preview');
  if (!cv) return;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#1a1b1c';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const c = ed.clip;
  const t = c && activeTrack(c);
  const m = t ? markerAt(t, ed.clipFrame) : null;
  const src = c ? readySource(c) : null;
  if (!c || !t || !m || !src) return;
  const bmp = src.peek(clipFrameToSourceIndex(c, ed.clipFrame));
  if (!bmp) return;
  const g = ed.markerGeom(m);
  // fit the pattern bounding box (plus margin) into the preview keeping the aspect ratio
  const xs = g.corners.map((p) => p[0]),
    ys = g.corners.map((p) => p[1]);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  const pad = Math.max(x1 - x0, y1 - y0) * 0.15;
  const bw = x1 - x0 + 2 * pad,
    bh = y1 - y0 + 2 * pad;
  const k = Math.min(cv.width / bw, cv.height / bh);
  const ox = (cv.width - bw * k) / 2 - (x0 - pad) * k,
    oy = (cv.height - bh * k) / 2 - (y0 - pad) * k;
  ctx.imageSmoothingEnabled = false;
  ctx.filter = t.use_grayscale_preview ? 'grayscale(1)' : 'none';
  ctx.setTransform(k, 0, 0, k, ox, oy);
  ctx.drawImage(bmp, 0, 0, c.size[0], c.size[1]);
  ctx.filter = 'none';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = m.mute ? '#fc4239' : '#fcfecf';
  ctx.lineWidth = 1;
  ctx.beginPath();
  g.corners.forEach((p, i) => (i ? ctx.lineTo(p[0] * k + ox, p[1] * k + oy) : ctx.moveTo(p[0] * k + ox, p[1] * k + oy)));
  ctx.closePath();
  ctx.stroke();
  const ax = g.x * k + ox,
    ay = g.y * k + oy;
  ctx.beginPath();
  ctx.moveTo(ax - 5, ay);
  ctx.lineTo(ax + 5, ay);
  ctx.moveTo(ax, ay - 5);
  ctx.lineTo(ax, ay + 5);
  ctx.stroke();
}

