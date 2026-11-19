// What the Quick Actions Bar offers in each situation. Kept free of DOM and
// editor code so the choice of actions can be tested on its own.

/** One button: a command, or a tool to switch to. A menu button opens a list of commands. */
export type QuickItem =
  | { kind: 'command'; id: string; label: string; icon: string; checkedLabel?: string }
  | { kind: 'tool'; tool: string; label: string; icon: string }
  | { kind: 'menu'; label: string; icon: string; items: string[] };

export type QuickState =
  | 'none'
  | 'quick-mask'
  | 'selection'
  | 'mask'
  | 'type'
  | 'shape'
  | 'embedded'
  | 'pixel'
  | 'adjustment'
  | 'fill'
  | 'group'
  | 'multiple'
  | 'empty';

/** The parts of the editor state the bar depends on. */
export type QuickContext = {
  hasDocument: boolean;
  selection: boolean;
  quickMask: boolean;
  editingMask: boolean;
  // Top-level selected layers (a group counts once).
  layers: { kind: string; embedded?: boolean; hasMask?: boolean }[];
};

export function quickState(c: QuickContext): QuickState {
  if (!c.hasDocument) return 'none';
  if (c.quickMask) return 'quick-mask';
  if (c.selection) return 'selection';
  if (c.layers.length > 1) return 'multiple';
  const l = c.layers[0];
  if (!l) return 'empty';
  if (c.editingMask && l.hasMask) return 'mask';
  switch (l.kind) {
    case 'text':
      return 'type';
    case 'vector':
      return 'shape';
    case 'adjustment':
      return 'adjustment';
    case 'solid':
      return 'fill';
    case 'group':
      return 'group';
    case 'image':
      return l.embedded ? 'embedded' : 'pixel';
    default:
      return 'pixel';
  }
}

const cmd = (id: string, label: string, icon: string, checkedLabel?: string): QuickItem => ({
  kind: 'command',
  id,
  label,
  icon,
  checkedLabel,
});
const transform = cmd('edit.free-transform', 'Transform', 'transform-box');
const addMask = cmd('layer.mask-reveal-all', 'Add Mask', 'mask-add');

/** The buttons for a state, in order. */
export function quickItems(state: QuickState): QuickItem[] {
  switch (state) {
    case 'quick-mask':
      return [
        cmd('select.quick-mask', 'Exit Quick Mask', 'quick-mask'),
        cmd('select.mask-refine', 'Select and Mask', 'sliders-horizontal'),
      ];
    case 'selection':
      return [
        cmd('edit.ai-fill', 'AI Fill', 'sparkles'),
        cmd('edit.context-fill-apply', 'Context Fill', 'sparkle'),
        {
          kind: 'menu',
          label: 'Modify',
          icon: 'sliders-horizontal',
          items: [
            'select.mask-refine',
            '-',
            'select.modify-feather',
            'select.modify-expand',
            'select.modify-contract',
            'select.modify-smooth',
            'select.modify-border',
            '-',
            'select.grow',
            'select.similar',
            '-',
            'select.transform-selection',
          ],
        },
        cmd('select.inverse', 'Invert', 'arrow-left-right'),
        cmd('layer.mask-reveal-selection', 'Mask', 'mask-add'),
        cmd('layer.via-copy', 'Copy to Layer', 'copy-plus'),
        cmd('select.deselect', 'Deselect', 'x'),
      ];
    case 'mask':
      return [
        cmd('layer.mask-invert', 'Invert Mask', 'contrast'),
        cmd('layer.mask-refine-edge', 'Refine Edge', 'feather'),
        cmd('layer.mask-toggle', 'Disable', 'eye-off', 'Enable'),
        cmd('layer.mask-apply', 'Apply', 'check'),
        cmd('layer.mask-delete', 'Delete Mask', 'trash-2'),
      ];
    case 'type':
      return [
        cmd('type.warp', 'Warp Text', 'waves'),
        cmd('window.panel.character', 'Character', 'text-style-char'),
        transform,
        cmd('type.convert-to-shape', 'Convert to Shape', 'shapes'),
        cmd('type.rasterize', 'Rasterize', 'image'),
      ];
    case 'shape':
      return [
        { kind: 'tool', tool: 'direct-select', label: 'Edit Path', icon: 'direct-select' },
        transform,
        addMask,
        cmd('layer.rasterize-shape', 'Rasterize', 'image'),
      ];
    case 'embedded':
      return [
        cmd('layer.embed-edit', 'Edit Contents', 'embedded-object'),
        cmd('select.subject', 'Select Subject', 'scan-face'),
        transform,
        cmd('layer.rasterize-embedded', 'Rasterize', 'image'),
      ];
    case 'pixel':
      return [
        cmd('select.subject', 'Select Subject', 'scan-face'),
        cmd('layer.remove-background', 'Remove Background', 'eraser'),
        addMask,
        transform,
      ];
    case 'adjustment':
      return [
        cmd('window.panel.properties', 'Properties', 'sliders-horizontal'),
        cmd('layer.clipping-mask', 'Clip to Layer Below', 'adj-clip'),
      ];
    case 'fill':
      return [
        cmd('window.panel.properties', 'Properties', 'sliders-horizontal'),
        cmd('layer.clipping-mask', 'Clip to Layer Below', 'adj-clip'),
        cmd('layer.rasterize-fill', 'Rasterize', 'image'),
      ];
    case 'group':
      return [
        cmd('layer.ungroup', 'Ungroup', 'ungroup'),
        addMask,
        transform,
        cmd('layer.merge-down', 'Merge Group', 'merge'),
      ];
    case 'multiple':
      return [
        cmd('layer.group', 'Group', 'group'),
        cmd('layer.merge-down', 'Merge', 'merge'),
        {
          kind: 'menu',
          label: 'Align',
          icon: 'align-start-vertical',
          items: [
            'layer.align-left',
            'layer.align-hcenter',
            'layer.align-right',
            '-',
            'layer.align-top',
            'layer.align-vcenter',
            'layer.align-bottom',
            '-',
            'layer.distribute-h-space',
            'layer.distribute-v-space',
          ],
        },
        cmd('layer.link', 'Link', 'link'),
        transform,
      ];
    case 'empty':
      return [
        cmd('layer.new-quick', 'New Layer', 'plus'),
        cmd('select.all', 'Select All', 'square-dashed'),
      ];
    default:
      return [];
  }
}

/** Less frequent commands for a state, listed in the bar's More menu above its own options. */
export function quickExtras(state: QuickState): string[] {
  switch (state) {
    case 'selection':
      return ['edit.context-fill', 'edit.fill', 'edit.stroke', '-', 'layer.via-cut', 'select.save'];
    case 'pixel':
    case 'embedded':
      return ['layer.mask-all-objects', 'layer.duplicate-dialog'];
    case 'type':
      return ['type.create-work-path', 'type.match-font'];
    case 'multiple':
      return ['layer.merge-visible', 'layer.select-linked'];
    case 'mask':
      return ['layer.mask-link'];
    default:
      return [];
  }
}

/** Every command a state can show, for checks that they are registered. */
export function quickCommandIds(state: QuickState): string[] {
  const ids = quickItems(state).flatMap((i) =>
    i.kind === 'command' ? [i.id] : i.kind === 'menu' ? i.items : [],
  );
  return [...ids, ...quickExtras(state)].filter((id) => id !== '-');
}

// ----- Placement -----
export type Box = { width: number; height: number };
export type Rect = { left: number; top: number; right: number; bottom: number };
/** Pinned bars keep a place relative to the canvas area, as fractions of the free space. */
export type PinnedPlace = { fx: number; fy: number };
const MARGIN = 8;

/** Where the bar goes: under the selection (above it when there is no room),
 * else near the bottom of the canvas area; a pinned place overrides both. */
export function placeBar(
  viewport: Box,
  bar: Box,
  selection?: Rect,
  pinned?: PinnedPlace,
): { left: number; top: number } {
  const maxLeft = Math.max(MARGIN, viewport.width - bar.width - MARGIN),
    maxTop = Math.max(MARGIN, viewport.height - bar.height - MARGIN);
  const clamp = (v: number, hi: number) => Math.round(Math.max(MARGIN, Math.min(hi, v)));
  if (pinned)
    return {
      left: clamp(MARGIN + pinned.fx * (maxLeft - MARGIN), maxLeft),
      top: clamp(MARGIN + pinned.fy * (maxTop - MARGIN), maxTop),
    };
  let cx = viewport.width / 2,
    top = viewport.height - bar.height - 28;
  if (selection) {
    cx = (selection.left + selection.right) / 2;
    top = selection.bottom + 14;
    if (top + bar.height > viewport.height - MARGIN) top = selection.top - bar.height - 14;
  }
  return { left: clamp(cx - bar.width / 2, maxLeft), top: clamp(top, maxTop) };
}

/** The pinned place for a bar dropped at a position. */
export function pinnedAt(viewport: Box, bar: Box, left: number, top: number): PinnedPlace {
  const spanX = Math.max(1, viewport.width - bar.width - 2 * MARGIN),
    spanY = Math.max(1, viewport.height - bar.height - 2 * MARGIN);
  const f = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
  return { fx: f((left - MARGIN) / spanX), fy: f((top - MARGIN) / spanY) };
}

export function validPinned(v: unknown): PinnedPlace | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { fx, fy } = v as PinnedPlace;
  return Number.isFinite(fx) && Number.isFinite(fy) && fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1
    ? { fx, fy }
    : undefined;
}
