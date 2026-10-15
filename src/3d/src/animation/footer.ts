// Playback footer shown under the Dope Sheet (Playback/Keying popovers,
// auto-keying, transport controls, current frame and frame range).
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { openPopover } from '../ui/menu';
import { numberField, enumMenu } from '../ui/widgets';
import type { Keyframe } from '../data/types';
import { keyingSetItems } from '../anim/keyingsets';

export const KEY_TYPES: [Keyframe['type'], string][] = [
  ['KEYFRAME', 'Keyframe'],
  ['BREAKDOWN', 'Breakdown'],
  ['MOVING_HOLD', 'Moving Hold'],
  ['EXTREME', 'Extreme'],
  ['JITTER', 'Jitter'],
  ['GENERATED', 'Generated'],
];

function popoverButton(label: string, ic: string | null, body: () => Child) {
  return h(
    'button',
    {
      key: `pop-${label}`,
      class: 'hdr-menu',
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        openPopover(e.currentTarget as HTMLElement, () => h('div', { class: 'pop-panel' }, h('div', { class: 'pop-title' }, label), body()), { width: 240 });
      },
    },
    ic ? icon(ic) : null,
    label,
    icon('down_arrow_hlt', 'tiny'),
  );
}

export function playbackFooter(): Child {
  const s = app.doc.scene;
  const ts = s.tool_settings;
  const playing = app.playing;
  return h(
    'div',
    { class: 'hdr-row anim-footer-row' },
    popoverButton('Playback', null, () =>
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
    popoverButton('Keying', 'keyframe', () => [
      h('div', { class: 'pop-label' }, 'Active Keying Set'),
      enumMenu(
        'anim-ks',
        keyingSetItems().map(([value, label]) => ({ value, label })),
        s.keying_set ?? 'LocRotScale',
        (v) => ((s.keying_set = v as 'Location'), app.pushUndo('Keying Set'), app.changed('ui')),
      ),
      h('div', { class: 'pop-label' }, 'New Keyframe Type'),
      enumMenu(
        'anim-kt',
        KEY_TYPES.map(([value, label]) => ({ value, label })),
        ts.keyframe_type,
        (v) => ((ts.keyframe_type = v as Keyframe['type']), app.pushUndo('Keyframe Type'), app.changed('ui')),
      ),
    ]),
    h('div', { class: 'hdr-spacer' }),
    h(
      'button',
      {
        class: {
          'hdr-toggle': true,
          on: ts.use_keyframe_insert_auto,
          rec: true,
        },
        'data-tip': 'Auto Keying\nAutomatic keyframe insertion for objects, bones and masks',
        onclick: () => ((ts.use_keyframe_insert_auto = !ts.use_keyframe_insert_auto), app.pushUndo('Auto Keying'), app.changed('ui')),
      },
      icon('rec'),
    ),
    h(
      'div',
      { class: 'hdr-group play' },
      h(
        'button',
        {
          class: 'hdr-toggle',
          'data-tip': 'Jump to Endpoint\nJump to first frame (Shift ←)',
          onclick: () => app.run('screen.frame_jump', { end: false }),
        },
        icon('rew'),
      ),
      h(
        'button',
        {
          class: 'hdr-toggle',
          'data-tip': 'Jump to Keyframe\nPrevious keyframe (↓)',
          onclick: () => app.run('screen.keyframe_jump', { next: false }),
        },
        icon('prev_keyframe'),
      ),
      h(
        'button',
        {
          class: { 'hdr-toggle': true, on: playing === 'reverse' },
          'data-tip': 'Play Animation in Reverse',
          onclick: () => app.run('screen.animation_play', { reverse: true }),
        },
        icon(playing === 'reverse' ? 'pause' : 'play_reverse'),
      ),
      h(
        'button',
        {
          class: { 'hdr-toggle': true, on: playing === 'forward' },
          'data-tip': 'Play Animation (Space)',
          onclick: () => app.run('screen.animation_play'),
        },
        icon(playing === 'forward' ? 'pause' : 'play'),
      ),
      h(
        'button',
        {
          class: 'hdr-toggle',
          'data-tip': 'Jump to Keyframe\nNext keyframe (↑)',
          onclick: () => app.run('screen.keyframe_jump', { next: true }),
        },
        icon('next_keyframe'),
      ),
      h(
        'button',
        {
          class: 'hdr-toggle',
          'data-tip': 'Jump to Endpoint\nJump to last frame (Shift →)',
          onclick: () => app.run('screen.frame_jump', { end: true }),
        },
        icon('ff'),
      ),
    ),
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
      'button',
      {
        class: { 'hdr-toggle': true, on: !!s.use_preview_range },
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
    h(
      'div',
      { class: 'tl-range' },
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
