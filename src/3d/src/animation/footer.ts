// Playback footer shown under the Dope Sheet (Playback/Keying popovers,
// auto-keying, transport controls, current frame and frame range).
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { openPopover } from '../ui/menu';
import { numberField, enumMenu, checkbox } from '../ui/widgets';
import type { Keyframe } from '../data/types';
import { keyingSetItems } from '../anim/keyingsets';
import { prefs } from '../app/prefs';
import { setPref } from '../prefs/store';

/** Playback options kept for the session. */
export const playbackOptions = { follow: false };

export const KEY_TYPES: [Keyframe['type'], string][] = [
  ['KEYFRAME', 'Keyframe'],
  ['BREAKDOWN', 'Breakdown'],
  ['MOVING_HOLD', 'Moving Hold'],
  ['EXTREME', 'Extreme'],
  ['JITTER', 'Jitter'],
  ['GENERATED', 'Generated'],
];

function popoverButton(label: string, ic: string | null, body: () => Child, cls = 'hdr-menu hdr-pop') {
  return h(
    'button',
    {
      key: `pop-${label}`,
      class: cls,
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        openPopover(e.currentTarget as HTMLElement, () => h('div', { class: 'pop-panel' }, body()), { width: 260 });
      },
    },
    ic ? icon(ic) : null,
    label,
    icon('down_arrow_hlt', 'tiny'),
  );
}

/** A label/value row of a popover (label right-aligned on the left, controls on the right). */
const popRow = (label: string, ...content: Child[]) => h('div', { class: 'opt-split' }, h('span', { class: 'opt-label' }, label), h('div', { class: 'opt-col' }, ...content));

function playbackPopover(): Child {
  const s = app.doc.scene;
  return [
    popRow(
      'Sync',
      enumMenu(
        'anim-sync',
        [
          { value: 'NONE', label: 'Play Every Frame' },
          { value: 'FRAME_DROP', label: 'Frame Dropping' },
          { value: 'AUDIO_SYNC', label: 'Sync to Audio' },
        ],
        s.sync_mode,
        (v) => ((s.sync_mode = v as 'NONE'), app.pushUndo('Sync Mode'), app.changed('ui')),
      ),
    ),
    popRow(
      'Playback',
      checkbox('anim-limit-range', 'Limit to Frame Range', !!s.lock_frame_selection_to_range, (v) => ((s.lock_frame_selection_to_range = v), app.pushUndo('Limit to Frame Range'), app.changed('ui')), {
        tip: 'Scrubbing stays inside the scene (or preview) frame range',
      }),
      checkbox('anim-follow', 'Follow Current Frame', playbackOptions.follow, (v) => ((playbackOptions.follow = v), app.changed('ui')), {
        tip: 'Animation editors scroll to keep the playhead in view during playback',
      }),
    ),
  ];
}

function keyingPopover(): Child {
  const s = app.doc.scene;
  const ts = s.tool_settings;
  return [
    h('div', { class: 'opt-head' }, 'Active Keying Set'),
    enumMenu(
      'anim-ks',
      keyingSetItems().map(([value, label]) => ({ value, label })),
      s.keying_set ?? 'LocRotScale',
      (v) => ((s.keying_set = v as 'Location'), app.pushUndo('Keying Set'), app.changed('ui')),
    ),
    h('div', { class: 'opt-head' }, 'New Keyframe Type'),
    enumMenu(
      'anim-kt',
      KEY_TYPES.map(([value, label]) => ({ value, label })),
      ts.keyframe_type,
      (v) => ((ts.keyframe_type = v as Keyframe['type']), app.pushUndo('Keyframe Type'), app.changed('ui')),
    ),
    h('div', { class: 'opt-head' }, 'Auto Keying'),
    enumMenu(
      'anim-ak-mode',
      [
        { value: 'ADD_REPLACE_KEYS', label: 'Add & Replace', description: 'Insert new keys and replace existing ones' },
        { value: 'REPLACE_KEYS', label: 'Replace', description: 'Only change keys that already exist on the current frame' },
      ],
      ts.auto_keying_mode ?? 'ADD_REPLACE_KEYS',
      (v) => ((ts.auto_keying_mode = v as 'REPLACE_KEYS'), app.pushUndo('Auto Keying Mode'), app.changed('ui')),
    ),
    checkbox('anim-ak-ks', 'Only Active Keying Set', !!ts.use_keyframe_insert_keyingset, (v) => ((ts.use_keyframe_insert_keyingset = v), app.pushUndo('Only Active Keying Set'), app.changed('ui')), { tip: 'Auto keying keys the channels of the active keying set' }),
    checkbox('anim-ak-avail', 'Only Insert Available', prefs.use_auto_keyframe_insert_available, (v) => (setPref('use_auto_keyframe_insert_available', v), app.changed('ui')), { tip: 'Auto keying only keys channels that already have animation (also in Preferences ▸ Animation)' }),
    checkbox('anim-only-needed', 'Only Insert Needed', prefs.use_keyframe_insert_needed, (v) => (setPref('use_keyframe_insert_needed', v), app.changed('ui')), { tip: 'Skip keyframes that would not change the curve (also in Preferences ▸ Animation)' }),
  ];
}

function timeJumpPopover(): Child {
  const s = app.doc.scene;
  return [
    h('div', { class: 'opt-head' }, 'Time Jump'),
    popRow('Delta', numberField({ id: 'anim-jump-delta', value: s.time_jump_delta ?? 1, min: 0.001, softMax: 100, precision: s.time_jump_unit === 'FRAMES' ? 0 : 2, set: (v, f) => ((s.time_jump_delta = v), app.changed('ui'), f && app.pushUndo('Time Jump Delta')) })),
    popRow(
      'Unit',
      enumMenu(
        'anim-jump-unit',
        [
          { value: 'SECONDS', label: 'Seconds' },
          { value: 'FRAMES', label: 'Frames' },
        ],
        s.time_jump_unit ?? 'SECONDS',
        (v) => ((s.time_jump_unit = v as 'SECONDS'), app.pushUndo('Time Jump Unit'), app.changed('ui')),
      ),
    ),
  ];
}

const tbtn = (ic: string, tip: string, onclick: () => void, on = false) => h('button', { key: tip, class: { 'hdr-toggle': true, on }, 'data-tip': tip, onclick }, icon(ic));

/** Header controls shared by the Timeline, Dope Sheet and Sequencer: playback options, auto keying, transport, frames. */
export function playbackFooter(extra: Child = null): Child {
  const s = app.doc.scene;
  const ts = s.tool_settings;
  const playing = app.playing;
  return h(
    'div',
    { class: 'hdr-row anim-footer-row' },
    popoverButton('Playback', null, playbackPopover),
    h('div', { class: 'hdr-spacer' }),
    // auto keying with the keying options in its dropdown
    h(
      'div',
      { key: 'rec', class: 'hdr-group' },
      h(
        'button',
        {
          key: 'rec-toggle',
          class: { 'hdr-toggle': true, on: ts.use_keyframe_insert_auto, rec: true },
          'data-tip': 'Auto Keying\nAutomatic keyframe insertion for objects, bones and masks',
          onclick: () => ((ts.use_keyframe_insert_auto = !ts.use_keyframe_insert_auto), app.pushUndo('Auto Keying'), app.changed('ui')),
        },
        icon('rec'),
      ),
      popoverButton('', null, keyingPopover, 'hdr-icondrop hidden-icon keying-drop'),
    ),
    h(
      'div',
      { key: 'transport', class: 'hdr-group play' },
      tbtn('rew', 'Jump to Endpoint\nJump to first frame (Shift ←)', () => app.run('screen.frame_jump', { end: false })),
      tbtn('prev_keyframe', 'Jump to Keyframe\nPrevious keyframe (↓)', () => app.run('screen.keyframe_jump', { next: false })),
      tbtn(playing === 'reverse' ? 'pause' : 'play_reverse', 'Play Animation in Reverse', () => app.run('screen.animation_play', { reverse: true }), playing === 'reverse'),
      tbtn(playing === 'forward' ? 'pause' : 'play', 'Play Animation (Space)', () => app.run('screen.animation_play'), playing === 'forward'),
      tbtn('next_keyframe', 'Jump to Keyframe\nNext keyframe (↑)', () => app.run('screen.keyframe_jump', { next: true })),
      tbtn('ff', 'Jump to Endpoint\nJump to last frame (Shift →)', () => app.run('screen.frame_jump', { end: true })),
    ),
    // jump back / forward by the time jump step, with the step in its dropdown
    h(
      'div',
      { key: 'jump', class: 'hdr-group time-jump' },
      tbtn('time_jump_back', 'Jump Time by Delta\nJump back by the time jump step (Ctrl ←)', () => app.run('screen.time_jump', { backward: true })),
      tbtn('time_jump_forward', 'Jump Time by Delta\nJump forward by the time jump step (Ctrl →)', () => app.run('screen.time_jump', { backward: false })),
      popoverButton('', null, timeJumpPopover, 'hdr-icondrop hidden-icon time-jump-drop'),
    ),
    extra,
    h('div', { class: 'hdr-spacer' }),
    h(
      'div',
      { class: 'tl-frame' },
      numberField({
        id: 'anim-cur',
        value: s.frame_current,
        int: true,
        unit: 'frame',
        set: (v) => app.setFrame(v),
      }),
    ),
    h(
      'div',
      { class: 'tl-range' },
      h(
        'button',
        {
          class: { 'hdr-toggle': true, 'tl-preview': true, on: !!s.use_preview_range },
          'data-tip': 'Use Preview Range\nUse an alternative start/end frame range for animation playback and view renders',
          onclick: () => (
            (s.use_preview_range = !s.use_preview_range),
            (s.frame_preview_start ??= s.frame_start),
            (s.frame_preview_end ??= s.frame_end),
            app.pushUndo('Preview Range'),
            app.changed('ui')
          ),
        },
        icon('time'),
      ),
      numberField({
        id: 'anim-start',
        label: 'Start',
        value: s.use_preview_range ? (s.frame_preview_start ?? s.frame_start) : s.frame_start,
        int: true,
        set: (v, f) => (s.use_preview_range ? (s.frame_preview_start = v) : (s.frame_start = v), app.changed('doc'), f && app.pushUndo('Frame Start')),
      }),
      numberField({
        id: 'anim-end',
        label: 'End',
        value: s.use_preview_range ? (s.frame_preview_end ?? s.frame_end) : s.frame_end,
        int: true,
        set: (v, f) => (s.use_preview_range ? (s.frame_preview_end = v) : (s.frame_end = v), app.changed('doc'), f && app.pushUndo('Frame End')),
      }),
    ),
  );
}
