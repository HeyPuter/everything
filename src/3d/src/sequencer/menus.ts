// Header, context and add menus of the Video Sequencer.
import { app } from '../app/app';
import type { MenuItem } from '../ui/menu';
import { markerMenu } from '../animation/animeditor';
import { activeStrip, selectedStrips, hasEditor, seqEditor, type SeqEditorLike } from './context';
import { inputCount } from './strips';
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
      submenu: () => [fx('CROSS', 'Cross'), fx('GAMMA_CROSS', 'Gamma Cross'), fx('WIPE', 'Wipe')],
    },
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
      { label: 'Set Preview Range to Strips', op: 'sequencer.set_range_to_strips', props: { preview: true }, shortcut: 'Ctrl Alt P' },
      { label: 'Set Frame Range to Strips', op: 'sequencer.set_range_to_strips', props: { preview: false } },
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
    { separator: true },
    { label: 'Render Audio…', op: 'sound.mixdown' },
  );
  return items;
}

export function selectMenu(preview = false): MenuItem[] {
  const items: MenuItem[] = [
    { label: 'All', op: 'sequencer.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'sequencer.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'sequencer.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
  ];
  if (preview) return items;
  return [
    ...items,
    { separator: true },
    { label: 'Box Select', op: 'sequencer.select_box', shortcut: 'B' },
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

export function stripMenu(preview = false): MenuItem[] {
  const act = hasEditor() ? activeStrip() : null;
  const sel = hasEditor() ? selectedStrips() : [];
  if (preview)
    return [
      {
        label: 'Transform',
        submenu: () => [
          { label: 'Move', op: 'sequencer.strip_transform', props: { mode: 'TRANSLATE' }, shortcut: 'G' },
          { label: 'Rotate', op: 'sequencer.strip_transform', props: { mode: 'ROTATE' }, shortcut: 'R' },
          { label: 'Scale', op: 'sequencer.strip_transform', props: { mode: 'RESIZE' }, shortcut: 'S' },
        ],
      },
      { separator: true },
      { label: 'Copy', op: 'sequencer.copy', shortcut: 'Ctrl C' },
      { label: 'Paste', op: 'sequencer.paste', shortcut: 'Ctrl V' },
      { label: 'Delete', op: 'sequencer.delete', shortcut: 'X' },
      { separator: true },
      ...muteLockItems(),
    ];
  const items: MenuItem[] = [
    {
      label: 'Transform',
      submenu: () => [
        { label: 'Move', op: 'transform.seq_slide', shortcut: 'G' },
        { label: 'Move/Extend from Current Frame', op: 'transform.transform', props: { mode: 'TIME_EXTEND' }, shortcut: 'E' },
        { label: 'Slip Strip Contents', op: 'sequencer.slip', shortcut: 'S' },
        { separator: true },
        { label: 'Snap Strips to the Current Frame', op: 'sequencer.snap', shortcut: 'Shift S' },
        { label: 'Clear Strip Offsets', op: 'sequencer.offset_clear', shortcut: 'Alt O' },
        { separator: true },
        { label: 'Swap Strip Left', op: 'sequencer.swap', props: { side: 'LEFT' }, shortcut: 'Alt ←' },
        { label: 'Swap Strip Right', op: 'sequencer.swap', props: { side: 'RIGHT' }, shortcut: 'Alt →' },
      ],
    },
    { separator: true },
    { label: 'Split', op: 'sequencer.split', props: { type: 'SOFT' }, shortcut: 'K' },
    { label: 'Hold Split', op: 'sequencer.split', props: { type: 'HARD' }, shortcut: 'Shift K' },
    { separator: true },
    { label: 'Copy', op: 'sequencer.copy', shortcut: 'Ctrl C' },
    { label: 'Paste', op: 'sequencer.paste', shortcut: 'Ctrl V' },
    { label: 'Duplicate', op: 'sequencer.duplicate_move', shortcut: 'Shift D' },
    { label: 'Delete', op: 'sequencer.delete', shortcut: 'X' },
    { separator: true },
  ];
  if (act && inputCount(act.type))
    items.push(
      {
        label: 'Effect Strip',
        submenu: () => [
          { label: 'Reassign Inputs', op: 'sequencer.reassign_inputs', shortcut: 'R' },
          { label: 'Swap Inputs', op: 'sequencer.swap_inputs', shortcut: 'Alt S' },
        ],
      },
      { separator: true },
    );
  if (sel.some((s) => s.type === 'IMAGE' && (s.elements?.length ?? 0) > 1)) items.push({ label: 'Separate Images', op: 'sequencer.images_separate', shortcut: 'Y' }, { separator: true });
  items.push(
    { label: 'Make Meta Strip', op: 'sequencer.meta_make', shortcut: 'Ctrl G' },
    { label: 'UnMeta Strip', op: 'sequencer.meta_separate', shortcut: 'Ctrl Alt G' },
    { label: hasEditor() && seqEditor().meta_stack.length && act?.type !== 'META' ? 'Exit Meta Strip' : 'Toggle Meta Strip', op: 'sequencer.meta_toggle', shortcut: 'Tab' },
    { separator: true },
    ...muteLockItems(),
    { separator: true },
    {
      label: 'Gaps',
      submenu: () => [
        { label: 'Remove Gaps', op: 'sequencer.gap_remove', props: { all: false }, shortcut: 'Backspace' },
        { label: 'Remove Gaps (All)', op: 'sequencer.gap_remove', props: { all: true }, shortcut: 'Shift Backspace' },
        { label: 'Insert Gaps', op: 'sequencer.gap_insert', shortcut: 'Shift =' },
      ],
    },
    { label: 'Movie Strip', submenu: () => [{ label: 'Refresh All', op: 'sequencer.refresh_all' }] },
  );
  return items;
}

function muteLockItems(): MenuItem[] {
  return [
    {
      label: 'Mute',
      submenu: () => [
        { label: 'Mute Strips', op: 'sequencer.mute', props: { unselected: false }, shortcut: 'H' },
        { label: 'Unmute Strips', op: 'sequencer.unmute', props: { unselected: false }, shortcut: 'Alt H' },
        { label: 'Mute Unselected Strips', op: 'sequencer.mute', props: { unselected: true }, shortcut: 'Shift H' },
        { label: 'Unmute Deselected Strips', op: 'sequencer.unmute', props: { unselected: true }, shortcut: 'Shift Alt H' },
      ],
    },
    {
      label: 'Lock',
      submenu: () => [
        { label: 'Lock Strips', op: 'sequencer.lock', shortcut: 'Ctrl H' },
        { label: 'Unlock Strips', op: 'sequencer.unlock', shortcut: 'Ctrl Alt H' },
      ],
    },
  ];
}

export function imageMenu(): MenuItem[] {
  return [
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
  return [
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
    { label: 'Make Meta Strip', op: 'sequencer.meta_make', shortcut: 'Ctrl G' },
    { label: 'UnMeta Strip', op: 'sequencer.meta_separate', shortcut: 'Ctrl Alt G' },
    { separator: true },
    ...muteLockItems(),
    { separator: true },
    { label: 'Add Marker', op: 'screen.marker_add', shortcut: 'M' },
  ];
}

export { markerMenu };
