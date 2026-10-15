// Header, context and add menus of the Video Sequencer.
import { app } from '../app/app';
import type { MenuItem } from '../ui/menu';
import { markerMenu } from '../animation/animeditor';
import { activeStrip, selectedStrips, hasEditor, seqEditor, type SeqEditorLike } from './context';
import { inputCount, STRIP_LABELS } from './strips';
import { COLOR_TAGS, effectTypesFor } from './stripops';
import { mirrorItems, pivotItems } from './previewops';
import { stripIcon } from './theme';

const camOptions = (): MenuItem[] => {
  const doc = app.doc;
  const cams = doc.object_order.map((id) => doc.objects[id]).filter((o) => o?.type === 'CAMERA');
  const items: MenuItem[] = [{ label: `${doc.scene.name || 'Scene'} (Active Camera)`, icon: 'scene_data', op: 'sequencer.scene_strip_add', props: { camera: '' } }];
  for (const c of cams) items.push({ label: `${doc.scene.name || 'Scene'} — ${c.name}`, icon: 'outliner_ob_camera', op: 'sequencer.scene_strip_add', props: { camera: c.id } });
  return items;
};

export function addMenu(): MenuItem[] {
  const fx = (type: string, label: string): MenuItem => ({ label, op: 'sequencer.effect_strip_add', props: { type }, icon: inputCount(type as 'ADD') ? stripIcon(type as 'ADD') : undefined });
  return [
    { label: 'Scene', icon: 'scene_data', submenu: camOptions },
    {
      label: 'Mask',
      icon: 'mod_mask',
      submenu: () => {
        const masks = Object.values(app.doc.masks ?? {});
        return masks.length ? masks.map((m) => ({ label: m.name, icon: 'mod_mask', op: 'sequencer.mask_strip_add', props: { mask: m.id } })) : [{ label: 'No masks (create one in the clip editor’s mask mode)', disabled: true }];
      },
    },
    { label: 'Movie', icon: 'file_movie', op: 'sequencer.movie_strip_add' },
    { label: 'Sound', icon: 'file_sound', op: 'sequencer.sound_strip_add' },
    { label: 'Image/Sequence', icon: 'file_image', op: 'sequencer.image_strip_add' },
    { separator: true },
    { label: 'Color', icon: 'seq_color', op: 'sequencer.effect_strip_add', props: { type: 'COLOR' } },
    { label: 'Text', icon: 'seq_text', op: 'sequencer.effect_strip_add', props: { type: 'TEXT' } },
    { label: 'Adjustment Layer', icon: 'seq_adjustment', op: 'sequencer.effect_strip_add', props: { type: 'ADJUSTMENT' } },
    { separator: true },
    {
      label: 'Effect Strip',
      icon: 'seq_effect',
      submenu: () => [
        { label: 'Multicam Selector', op: 'sequencer.effect_strip_add', props: { type: 'MULTICAM' } },
        { separator: true },
        fx('ADD', 'Add'),
        fx('SUBTRACT', 'Subtract'),
        fx('MULTIPLY', 'Multiply'),
        fx('ALPHA_OVER', 'Alpha Over'),
        fx('ALPHA_UNDER', 'Alpha Under'),
        fx('COLORMIX', 'Color Mix'),
        { separator: true },
        fx('TRANSFORM', 'Transform'),
        fx('SPEED', 'Speed Control'),
        { separator: true },
        fx('GLOW', 'Glow'),
        fx('GAUSSIAN_BLUR', 'Gaussian Blur'),
      ],
    },
    {
      label: 'Transition',
      icon: 'seq_transition',
      submenu: () => [{ label: 'Sound Crossfade', op: 'sequencer.crossfade_sounds' }, { separator: true }, fx('CROSS', 'Crossfade'), fx('GAMMA_CROSS', 'Gamma Crossfade'), { separator: true }, fx('WIPE', 'Wipe')],
    },
    { label: 'Fade', submenu: fadeItems },
  ];
}

export function viewMenu(ed: SeqEditorLike & { showToolbar: boolean; showSidebar: boolean; showMarkers: boolean; showWaveforms: boolean; showThumbnails: boolean; previewSize: string; setPreviewSize(v: string): void; redraw(): void }): MenuItem[] {
  const timeline = ed.view !== 'PREVIEW';
  const preview = ed.view !== 'SEQUENCER';
  const items: MenuItem[] = [
    { label: 'Sidebar', shortcut: 'N', checked: ed.showSidebar, action: () => ed.toggleSidebar() },
    { label: 'Toolbar', shortcut: 'T', checked: ed.showToolbar, action: () => ed.toggleToolbar() },
    { separator: true },
  ];
  if (timeline)
    items.push(
      { label: 'Frame Selected', op: 'sequencer.view_selected', shortcut: 'Numpad .' },
      { label: 'Frame All', op: 'sequencer.view_all', shortcut: 'Home' },
      { label: 'Go to Current Frame', op: 'sequencer.view_frame', shortcut: 'Numpad 0' },
      { separator: true },
      { label: 'Show Seconds', shortcut: 'Ctrl T', checked: ed.showSeconds, action: () => ((ed.showSeconds = !ed.showSeconds), ed.redraw(), app.changed('ui')) },
      { label: 'Show Markers', checked: ed.showMarkers, action: () => ((ed.showMarkers = !ed.showMarkers), ed.redraw()) },
      { separator: true },
      {
        label: 'Range',
        submenu: () => [
          { label: 'Set Preview Range to Strips', op: 'sequencer.set_range_to_strips', props: { preview: true }, shortcut: 'Ctrl Alt P' },
          { label: 'Clear Preview Range', op: 'anim.previewrange_clear' },
          { separator: true },
          { label: 'Set Frame Range to Strips', op: 'sequencer.set_range_to_strips', props: { preview: false } },
        ],
      },
      {
        label: 'Navigation',
        submenu: () => [
          { label: 'Play Animation', op: 'screen.animation_play', shortcut: 'Space' },
          { separator: true },
          { label: 'Go to Current Frame', op: 'sequencer.view_frame', shortcut: 'Numpad 0' },
          { separator: true },
          { label: 'Jump to Previous Strip', op: 'sequencer.strip_jump', props: { next: false, center: false }, shortcut: 'Page Up' },
          { label: 'Jump to Next Strip', op: 'sequencer.strip_jump', props: { next: true, center: false }, shortcut: 'Page Down' },
          { separator: true },
          { label: 'Jump to Previous Strip (Center)', op: 'sequencer.strip_jump', props: { next: false, center: true }, shortcut: 'Alt Page Up' },
          { label: 'Jump to Next Strip (Center)', op: 'sequencer.strip_jump', props: { next: true, center: true }, shortcut: 'Alt Page Down' },
        ],
      },
      { separator: true },
    );
  if (preview)
    items.push(
      { label: 'Fit Preview in Window', op: 'sequencer.view_all_preview', shortcut: timeline ? '' : 'Home' },
      {
        label: 'Fractional Zoom',
        submenu: () => [8, 4, 2, 1, 0.5, 0.25, 0.125].map((r) => ({ label: r >= 1 ? `Zoom ${r}:1` : `Zoom 1:${1 / r}`, op: 'sequencer.view_zoom_ratio', props: { ratio: r } })),
      },
      {
        label: 'Preview Size',
        submenu: () =>
          [
            ['AUTO', 'Automatic (fit display)'],
            ['SCENE', 'Scene Size'],
            ['PROXY_75', '75%'],
            ['PROXY_50', '50%'],
            ['PROXY_25', '25%'],
          ].map(([v, l]) => ({ label: l, active: ed.previewSize === v, action: () => ed.setPreviewSize(v) })),
      },
      { separator: true },
    );
  items.push(
    { label: 'Sequencer', icon: 'seq_sequencer', active: ed.view === 'SEQUENCER', action: () => ed.setView('SEQUENCER') },
    { label: 'Preview', icon: 'seq_preview', active: ed.view === 'PREVIEW', action: () => ed.setView('PREVIEW') },
    { label: 'Sequencer & Preview', icon: 'seq_splitview', active: ed.view === 'SEQUENCER_PREVIEW', action: () => ed.setView('SEQUENCER_PREVIEW') },
    { label: 'Toggle Sequencer/Preview', op: 'sequencer.view_toggle', shortcut: 'Ctrl Tab' },
    { separator: true },
    {
      label: 'Render Preview',
      submenu: () => [
        { label: 'Render Sequencer Image', op: 'render.render', props: { animation: false } },
        { label: 'Render Sequencer Animation', op: 'render.render', props: { animation: true } },
      ],
    },
    { label: 'Render Audio…', op: 'sound.mixdown' },
    { label: 'Export Subtitles…', icon: 'export', op: 'sequencer.export_subtitles' },
  );
  return items;
}

export function selectMenu(preview = false): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'All', op: 'sequencer.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'sequencer.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'sequencer.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'sequencer.select_box', shortcut: 'B' },
  ];
  if (!preview) items.push({ label: 'Box Select (Include Handles)', op: 'sequencer.select_box', props: { include_handles: true }, shortcut: 'Ctrl B' });
  items.push(
    { label: 'Circle Select', op: 'sequencer.select_circle', shortcut: 'C' },
    {
      label: 'Lasso Select',
      submenu: () =>
        SHAPE_MODES.map(([mode, label]) => ({ label, op: 'sequencer.select_lasso', props: { mode } })),
    },
  );
  if (preview) return items;
  return [
    ...items,
    { separator: true },
    { label: 'More', op: 'sequencer.select_more', shortcut: 'Ctrl Numpad +' },
    { label: 'Less', op: 'sequencer.select_less', shortcut: 'Ctrl Numpad -' },
    { separator: true },
    {
      label: 'Side of Frame',
      submenu: () => [
        { label: 'Left', op: 'sequencer.select_side_of_frame', props: { side: 'LEFT' }, shortcut: '[' },
        { label: 'Right', op: 'sequencer.select_side_of_frame', props: { side: 'RIGHT' }, shortcut: ']' },
        { label: 'Current Frame', op: 'sequencer.select_side_of_frame', props: { side: 'CURRENT' } },
      ],
    },
    {
      label: 'Handle',
      submenu: () => [
        { label: 'Both', op: 'sequencer.select_handles', props: { side: 'BOTH' } },
        { label: 'Left', op: 'sequencer.select_handles', props: { side: 'LEFT' } },
        { label: 'Right', op: 'sequencer.select_handles', props: { side: 'RIGHT' } },
        { separator: true },
        { label: 'Both Neighbors', op: 'sequencer.select_handles', props: { side: 'BOTH_NEIGHBORS' } },
        { label: 'Left Neighbor', op: 'sequencer.select_handles', props: { side: 'LEFT_NEIGHBOR' } },
        { label: 'Right Neighbor', op: 'sequencer.select_handles', props: { side: 'RIGHT_NEIGHBOR' } },
      ],
    },
    {
      label: 'Channel',
      submenu: () => [
        { label: 'Left', op: 'sequencer.select_side', props: { side: 'LEFT' } },
        { label: 'Right', op: 'sequencer.select_side', props: { side: 'RIGHT' } },
        { separator: true },
        { label: 'Both Sides', op: 'sequencer.select_side', props: { side: 'BOTH' } },
      ],
    },
    {
      label: 'Linked',
      submenu: () => [
        { label: 'All', op: 'sequencer.select_linked', shortcut: 'Ctrl L' },
        { label: 'Pick Linked', op: 'sequencer.select_linked_pick', shortcut: 'L' },
      ],
    },
    { separator: true },
    {
      label: 'Select Grouped',
      shortcut: 'Shift G',
      submenu: () =>
        [
          ['TYPE', 'Type'],
          ['TYPE_BASIC', 'Global Type'],
          ['TYPE_EFFECT', 'Effect Type'],
          ['DATA', 'Data'],
          ['EFFECT', 'Effect'],
          ['EFFECT_LINK', 'Effect/Linked'],
          ['OVERLAP', 'Overlap'],
        ].map(([type, label]) => ({ label, op: 'sequencer.select_grouped', props: { type } })),
    },
  ];
}

const SHAPE_MODES = [
  ['SET', 'Set'],
  ['ADD', 'Extend'],
  ['SUB', 'Subtract'],
] as const;

function transformItems(preview: boolean): MenuItem[] {
  if (preview)
    return [
      { label: 'Move', op: 'sequencer.strip_transform', props: { mode: 'TRANSLATE' }, shortcut: 'G' },
      { label: 'Rotate', op: 'sequencer.strip_transform', props: { mode: 'ROTATE' }, shortcut: 'R' },
      { label: 'Scale', op: 'sequencer.strip_transform', props: { mode: 'RESIZE' }, shortcut: 'S' },
    ];
  return [
    { label: 'Move', op: 'transform.seq_slide', shortcut: 'G' },
    { label: 'Move/Extend from Current Frame', op: 'transform.transform', props: { mode: 'TIME_EXTEND' }, shortcut: 'E' },
    { label: 'Slip Strip Contents', op: 'sequencer.slip', shortcut: 'S' },
    { separator: true },
    { label: 'Snap Strips to the Current Frame', op: 'sequencer.snap', shortcut: 'Shift S' },
    { label: 'Clear Strip Offsets', op: 'sequencer.offset_clear', shortcut: 'Alt O' },
    { separator: true },
    { label: 'Swap Strip Left', op: 'sequencer.swap', props: { side: 'LEFT' }, shortcut: 'Alt ←' },
    { label: 'Swap Strip Right', op: 'sequencer.swap', props: { side: 'RIGHT' }, shortcut: 'Alt →' },
    { separator: true },
    { label: 'Remove Gaps', op: 'sequencer.gap_remove', props: { all: false }, shortcut: 'Backspace' },
    { label: 'Remove Gaps (All)', op: 'sequencer.gap_remove', props: { all: true }, shortcut: 'Shift Backspace' },
    { label: 'Insert Gaps', op: 'sequencer.gap_insert', shortcut: 'Shift =' },
  ];
}

/** I in the timeline: quick retiming actions. */
export function retimingMenu(): MenuItem[] {
  return [
    { label: 'Add Retiming Key', op: 'sequencer.retiming_key_add' },
    { label: 'Add Freeze Frame', op: 'sequencer.retiming_freeze_frame_add' },
  ];
}

function stripRetimingItems(): MenuItem[] {
  const act = hasEditor() ? activeStrip() : null;
  return [
    { label: 'Add Retiming Key', op: 'sequencer.retiming_key_add' },
    { label: 'Add Freeze Frame', op: 'sequencer.retiming_freeze_frame_add' },
    { label: 'Add Speed Transition', op: 'sequencer.retiming_transition_add' },
    { separator: true },
    { label: 'Delete Retiming Keys', op: 'sequencer.retiming_key_delete', shortcut: 'X' },
    { label: 'Reset Retiming', op: 'sequencer.retiming_reset' },
    { separator: true },
    { label: 'Set Speed', op: 'sequencer.retiming_segment_speed_set', shortcut: 'R' },
    { label: 'Show Retiming Keys', checked: !!act?.show_retiming_keys, op: 'sequencer.retiming_show', shortcut: 'Ctrl R' },
  ];
}

export function colorTagMenu(): MenuItem[] {
  return COLOR_TAGS.map(([color, label]) => ({ label, icon: color === 'NONE' ? 'x' : `seq_tag_${color.slice(6)}`, op: 'sequencer.strip_color_tag_set', props: { color } }));
}

export function effectChangeMenu(): MenuItem[] {
  const act = hasEditor() ? activeStrip() : null;
  if (!act) return [];
  return effectTypesFor(act.type).map((t) => ({ label: STRIP_LABELS[t], active: t === act.type, op: 'sequencer.change_effect_type', props: { type: t } }));
}

function inputItems(): MenuItem[] {
  return [
    { label: 'Reload Strips', op: 'sequencer.reload', props: { adjust_length: false }, shortcut: 'Alt R' },
    { label: 'Reload Strips and Adjust Length', op: 'sequencer.reload', props: { adjust_length: true }, shortcut: 'Shift Alt R' },
    { label: 'Change Path/Files', op: 'sequencer.change_path' },
    { label: 'Swap Data', op: 'sequencer.swap_data' },
  ];
}

/** Shift C: change what the active strip uses. */
export function changeMenu(): MenuItem[] {
  const act = hasEditor() ? activeStrip() : null;
  const items: MenuItem[] = [];
  if (act && ['MOVIE', 'SOUND', 'IMAGE'].includes(act.type)) items.push({ label: 'Path/Files', op: 'sequencer.change_path' });
  if (act && effectTypesFor(act.type).length) items.push({ label: 'Effect Type', submenu: effectChangeMenu });
  if (!items.length) items.push({ label: 'Nothing to change for the active strip', disabled: true } as MenuItem);
  return items;
}

export function stripMenu(preview = false): MenuItem[] {
  const act = hasEditor() ? activeStrip() : null;
  const items: MenuItem[] = [{ label: 'Transform', submenu: () => transformItems(preview) }];
  if (!preview) items.push({ label: 'Retiming', submenu: stripRetimingItems });
  if (preview) {
    items.push(
      { separator: true },
      { label: 'Copy', op: 'sequencer.copy', shortcut: 'Ctrl C' },
      { label: 'Paste', op: 'sequencer.paste', shortcut: 'Ctrl V' },
      { label: 'Delete', op: 'sequencer.delete', shortcut: 'X' },
      { separator: true },
      ...(act?.type === 'TEXT'
        ? [
            {
              label: 'Text',
              submenu: (): MenuItem[] => [
                { label: 'Toggle Text Editing', op: 'sequencer.text_edit_mode_toggle', shortcut: 'Tab' },
                { separator: true },
                { label: 'Copy', op: 'sequencer.text_edit_copy', shortcut: 'Ctrl C' },
                { label: 'Paste', op: 'sequencer.text_edit_paste', shortcut: 'Ctrl V' },
                { label: 'Cut', op: 'sequencer.text_edit_cut', shortcut: 'Ctrl X' },
                { separator: true },
                { label: 'Delete', op: 'sequencer.text_delete', props: { type: 'NEXT_OR_SELECTION' }, shortcut: 'Delete' },
                { label: 'Line Break', op: 'sequencer.text_line_break', shortcut: 'Enter' },
                { separator: true },
                { label: 'Select All', op: 'sequencer.text_select_all', shortcut: 'Ctrl A' },
                { label: 'Deselect All', op: 'sequencer.text_deselect_all', shortcut: 'Esc' },
              ],
            } as MenuItem,
            { separator: true } as MenuItem,
          ]
        : []),
      {
        label: 'Show/Hide',
        submenu: () => [
          { label: 'Show Hidden Strips', op: 'sequencer.unmute', props: { unselected: false }, shortcut: 'Alt H' },
          { separator: true },
          { label: 'Hide Selected', op: 'sequencer.mute', props: { unselected: false }, shortcut: 'H' },
          { label: 'Hide Unselected', op: 'sequencer.mute', props: { unselected: true }, shortcut: 'Shift H' },
        ],
      },
    );
    return items;
  }
  items.push(
    { separator: true },
    { label: 'Split', op: 'sequencer.split', props: { type: 'SOFT' }, shortcut: 'K' },
    { label: 'Hold Split', op: 'sequencer.split', props: { type: 'HARD' }, shortcut: 'Shift K' },
    { separator: true },
    { label: 'Copy', op: 'sequencer.copy', shortcut: 'Ctrl C' },
    { label: 'Paste', op: 'sequencer.paste', shortcut: 'Ctrl V' },
    { label: 'Duplicate', op: 'sequencer.duplicate_move', shortcut: 'Shift D' },
    { separator: true },
    { label: 'Delete', op: 'sequencer.delete', shortcut: 'X' },
  );
  if (act) {
    items.push(
      { separator: true },
      { label: 'Add Modifier', submenu: () => modifierAddItems() },
      { label: 'Copy Modifiers to Selection', op: 'sequencer.strip_modifier_copy' },
    );
    if (inputCount(act.type) || effectTypesFor(act.type).length)
      items.push(
        { separator: true },
        {
          label: 'Effect Strip',
          submenu: () => [
            { label: 'Change Effect Type', submenu: effectChangeMenu },
            { label: 'Reassign Inputs', op: 'sequencer.reassign_inputs', shortcut: 'R' },
            { label: 'Swap Inputs', op: 'sequencer.swap_inputs', shortcut: 'Alt S' },
          ],
        },
      );
    if (act.type === 'MOVIE') items.push({ separator: true }, { label: 'Movie Strip', submenu: () => [{ label: 'Set Render Size', op: 'sequencer.rendersize' }] });
    if (act.type === 'IMAGE') items.push({ separator: true }, { label: 'Set Render Size', op: 'sequencer.rendersize' }, { label: 'Separate Images', op: 'sequencer.images_separate', shortcut: 'Y' });
    if (act.type === 'MULTICAM') items.push({ separator: true }, { label: 'Split Multicam', submenu: () => multicamItems() });
  }
  items.push(
    { separator: true },
    { label: 'Make Meta Strip', op: 'sequencer.meta_make', shortcut: 'Ctrl G' },
    { label: 'UnMeta Strip', op: 'sequencer.meta_separate', shortcut: 'Ctrl Alt G' },
    { label: hasEditor() && seqEditor().meta_stack.length && act?.type !== 'META' ? 'Exit Meta Strip' : 'Toggle Meta Strip', op: 'sequencer.meta_toggle', shortcut: 'Tab' },
    { separator: true },
    { label: 'Set Color Tag', submenu: colorTagMenu },
    { separator: true },
    lockMuteItem(),
    { separator: true },
    { label: 'Connect', icon: 'linked', op: 'sequencer.connect', props: { toggle: false } },
    { label: 'Disconnect', op: 'sequencer.disconnect' },
    { separator: true },
    { label: 'Inputs', submenu: inputItems },
  );
  return items;
}

function multicamItems(): MenuItem[] {
  const act = hasEditor() ? activeStrip() : null;
  const out: MenuItem[] = [];
  for (let c = 1; c < Math.min(11, act?.channel ?? 1); c++) out.push({ label: `Camera ${c}`, active: act?.multicam_source === c, op: 'sequencer.split_multicam', props: { camera: c }, shortcut: String(c % 10) });
  return out;
}

function modifierAddItems(): MenuItem[] {
  return [
    { label: 'Brightness/Contrast', op: 'sequencer.strip_modifier_add', props: { type: 'BRIGHT_CONTRAST' } },
    { label: 'Color Balance', op: 'sequencer.strip_modifier_add', props: { type: 'COLOR_BALANCE' } },
    { label: 'White Balance', op: 'sequencer.strip_modifier_add', props: { type: 'WHITE_BALANCE' } },
  ];
}

function lockMuteItem(): MenuItem {
  return {
    label: 'Lock/Mute',
    submenu: () => [
      { label: 'Lock Strips', op: 'sequencer.lock', shortcut: 'Ctrl H' },
      { label: 'Unlock Strips', op: 'sequencer.unlock', shortcut: 'Ctrl Alt H' },
      { separator: true },
      { label: 'Mute Strips', op: 'sequencer.mute', props: { unselected: false }, shortcut: 'H' },
      { label: 'Unmute Strips', op: 'sequencer.unmute', props: { unselected: false }, shortcut: 'Alt H' },
      { label: 'Mute Unselected Strips', op: 'sequencer.mute', props: { unselected: true }, shortcut: 'Shift H' },
      { label: 'Unmute Deselected Strips', op: 'sequencer.unmute', props: { unselected: true }, shortcut: 'Shift Alt H' },
    ],
  };
}

export function imageMenu(): MenuItem[] {
  return [
    {
      label: 'Transform',
      submenu: () => [
        { label: 'Move', op: 'sequencer.strip_transform', props: { mode: 'TRANSLATE' }, shortcut: 'G' },
        { label: 'Rotate', op: 'sequencer.strip_transform', props: { mode: 'ROTATE' }, shortcut: 'R' },
        { label: 'Scale', op: 'sequencer.strip_transform', props: { mode: 'RESIZE' }, shortcut: 'S' },
      ],
    },
    { label: 'Mirror', submenu: mirrorItems },
    { label: 'Pivot Point', submenu: pivotItems },
    { separator: true },
    {
      label: 'Clear',
      submenu: () => [
        { label: 'All Transforms', op: 'sequencer.strip_transform_clear', props: { property: 'ALL' } },
        { label: 'Position', op: 'sequencer.strip_transform_clear', props: { property: 'POSITION' }, shortcut: 'Alt G' },
        { label: 'Scale', op: 'sequencer.strip_transform_clear', props: { property: 'SCALE' }, shortcut: 'Alt S' },
        { label: 'Rotation', op: 'sequencer.strip_transform_clear', props: { property: 'ROTATION' }, shortcut: 'Alt R' },
      ],
    },
    {
      label: 'Set Fit',
      submenu: () =>
        [
          ['FIT', 'Scale to Fit'],
          ['FILL', 'Scale to Fill'],
          ['STRETCH', 'Stretch to Fill'],
          ['ORIGINAL', 'Use Original Size'],
        ].map(([v, l]) => ({ label: l, op: 'sequencer.strip_transform_fit', props: { fit_method: v } })),
    },
  ];
}

export function contextMenu(): MenuItem[] {
  const sel = hasEditor() ? selectedStrips() : [];
  const items: MenuItem[] = [
    { heading: 'Strip' },
    { label: 'Copy', op: 'sequencer.copy', shortcut: 'Ctrl C' },
    { label: 'Paste', op: 'sequencer.paste', shortcut: 'Ctrl V' },
    { label: 'Duplicate', op: 'sequencer.duplicate_move', shortcut: 'Shift D' },
    { label: 'Delete', op: 'sequencer.delete', shortcut: 'X' },
    { separator: true },
    { label: 'Split', op: 'sequencer.split', props: { type: 'SOFT' }, shortcut: 'K' },
    { label: 'Hold Split', op: 'sequencer.split', props: { type: 'HARD' }, shortcut: 'Shift K' },
    { separator: true },
    { label: 'Slip Strip Contents', op: 'sequencer.slip', shortcut: 'S' },
    { label: 'Snap Strips to the Current Frame', op: 'sequencer.snap', shortcut: 'Shift S' },
    { separator: true },
    { label: 'Set Color Tag', submenu: colorTagMenu },
    { separator: true },
  ];
  if (sel.length)
    items.push(
      { label: 'Fade', submenu: fadeItems },
      { label: 'Clear Fade', op: 'sequencer.fades_clear' },
      { separator: true },
    );
  items.push(
    { label: 'Make Meta Strip', op: 'sequencer.meta_make', shortcut: 'Ctrl G' },
    { label: 'UnMeta Strip', op: 'sequencer.meta_separate', shortcut: 'Ctrl Alt G' },
    { separator: true },
    { label: 'Connect', icon: 'linked', op: 'sequencer.connect', props: { toggle: false } },
    { label: 'Disconnect', op: 'sequencer.disconnect' },
    { separator: true },
    lockMuteItem(),
    { separator: true },
    { label: 'Add Marker', op: 'screen.marker_add', shortcut: 'M' },
  );
  return items;
}

export function fadeItems(): MenuItem[] {
  return [
    { label: 'Fade In and Out', op: 'sequencer.fades_add', props: { type: 'IN_OUT' } },
    { label: 'Fade In', op: 'sequencer.fades_add', props: { type: 'IN' } },
    { label: 'Fade Out', op: 'sequencer.fades_add', props: { type: 'OUT' } },
    { label: 'From Current Frame', op: 'sequencer.fades_add', props: { type: 'CURSOR_FROM' } },
    { label: 'To Current Frame', op: 'sequencer.fades_add', props: { type: 'CURSOR_TO' } },
  ];
}

export { markerMenu };
