// Dope Sheet ▸ Grease Pencil: more keyframe operators (scale, extend, mirror, snap, copy / paste,
// select before / after the current frame, more / less, linked, columns of selected keys, jump to
// keys) and their shortcuts.
import { app, registerOperators, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import { copyDrawing, compactDrawings, sortFrames, gpOf } from './data';
import { hoverGP, layersOf, type GPDopeSheet } from './dopesheet';
import type { GPFrame, GPKeyframeType, GPLayer, GreasePencilData } from './types';

const poll = (ctx: OpContext) => !!hoverGP(ctx);
const selected = (ed: GPDopeSheet) => ed.allFrames().filter((f) => f.select);
const pollSel = (ctx: OpContext) => {
  const ed = hoverGP(ctx);
  return !!ed && selected(ed).length > 0;
};

/** After frames were renumbered: a moved key replaces a key it lands on; keys stay sorted. */
export function settleFrames(gp: GreasePencilData, layer: GPLayer, moved: Set<GPFrame>) {
  const taken = new Set(layer.frames.filter((f) => moved.has(f)).map((f) => f.frame_number));
  layer.frames = layer.frames.filter((f) => moved.has(f) || !taken.has(f.frame_number));
  // two moved keys on one frame: keep the last
  const seen = new Map<number, GPFrame>();
  for (const f of layer.frames) seen.set(f.frame_number, f);
  layer.frames = [...seen.values()];
  sortFrames(layer);
  void gp;
}

function settleAll(ed: GPDopeSheet, moved: Set<GPFrame>) {
  for (const { gp, layer } of layersOf(ed)) settleFrames(gp, layer, moved);
  for (const { gp } of ed.frameSets()) compactDrawings(gp);
}

/** Interactive time transforms of the selected keys: scale around / extend from the current frame. */
function timeModal(ed: GPDopeSheet, kind: 'SCALE' | 'EXTEND', startX: number): boolean {
  const sel = selected(ed);
  if (!sel.length) return false;
  const cfra = app.doc.scene.frame_current;
  const orig = new Map(sel.map((f) => [f, f.frame_number]));
  const lx = (clientX: number) => ed.local({ clientX, clientY: 0 }).x;
  const startFrame = ed.view.xf(lx(startX));
  const side = startFrame >= cfra ? 1 : -1;
  let value = kind === 'SCALE' ? 1 : 0;
  const apply = () => {
    for (const [f, n] of orig) {
      if (kind === 'SCALE') f.frame_number = Math.round(cfra + (n - cfra) * value);
      else if ((n - cfra) * side >= 0) f.frame_number = n + value;
      else f.frame_number = n;
    }
    ed.draw();
    app.changed('frame');
  };
  app.startModal({
    label: kind === 'SCALE' ? 'Scale Keyframes' : 'Extend Keyframes',
    cursor: 'ew-resize',
    onPointerMove: (e) => {
      const x = lx(e.clientX);
      if (kind === 'SCALE') {
        const c = ed.view.fx(cfra);
        const d0 = lx(startX) - c;
        value = Math.abs(d0) > 2 ? (x - c) / d0 : 1;
      } else value = Math.round((e.clientX - startX) / ed.view.ppf);
      apply();
    },
    onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : 'FINISHED'),
    onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' ? 'FINISHED' : true),
    cancel: () => {
      for (const [f, n] of orig) f.frame_number = n;
      ed.draw();
    },
    finish: () => settleAll(ed, new Set(orig.keys())),
    header: () => (kind === 'SCALE' ? `Scale: ${value.toFixed(3)}` : `Time: ${value > 0 ? '+' : ''}${value} frames`),
  });
  return true;
}

interface ClipKey {
  layer: string;
  offset: number;
  type: GPKeyframeType;
  drawing: ReturnType<typeof copyDrawing>;
}
let clipboard: ClipKey[] = [];

registerOperators([
  {
    idname: 'grease_pencil.frames_scale',
    label: 'Scale Keyframes',
    description: 'Scale the timing of the selected keys around the current frame',
    props: [{ id: 'value', label: 'Scale', type: 'float', default: 1 }],
    poll: pollSel,
    invoke: (ctx) => (timeModal(hoverGP(ctx)!, 'SCALE', ctx.event?.x ?? app.pointer.x) ? 'RUNNING_MODAL' : 'CANCELLED'),
    exec: (ctx, p) => {
      const ed = hoverGP(ctx)!;
      const cfra = ctx.doc.scene.frame_current;
      const sel = selected(ed);
      for (const f of sel) f.frame_number = Math.round(cfra + (f.frame_number - cfra) * (p.value as number));
      settleAll(ed, new Set(sel));
    },
  },
  {
    idname: 'grease_pencil.frames_extend',
    label: 'Extend Keyframes',
    description: 'Move the selected keys on the mouse side of the current frame',
    poll: pollSel,
    invoke: (ctx) => (timeModal(hoverGP(ctx)!, 'EXTEND', ctx.event?.x ?? app.pointer.x) ? 'RUNNING_MODAL' : 'CANCELLED'),
  },
  {
    idname: 'grease_pencil.frames_mirror',
    label: 'Mirror Keyframes',
    description: 'Flip the timing of the selected keys',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'CFRA',
        items: [
          ['CFRA', 'By Times Over Current Frame'],
          ['MARKER', 'By Times Over First Selected Marker'],
        ],
      },
    ],
    poll: pollSel,
    exec: (ctx, p) => {
      const ed = hoverGP(ctx)!;
      const marker = ctx.doc.scene.timeline_markers?.find((m) => m.select);
      if (p.type === 'MARKER' && !marker) return 'CANCELLED';
      const axis = p.type === 'MARKER' ? marker!.frame : ctx.doc.scene.frame_current;
      const sel = selected(ed);
      for (const f of sel) f.frame_number = 2 * axis - f.frame_number;
      settleAll(ed, new Set(sel));
    },
  },
  {
    idname: 'grease_pencil.frames_snap',
    label: 'Snap Keys',
    description: 'Move the selected keys to the current frame or the nearest marker',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'CFRA',
        items: [
          ['CFRA', 'Selection to Current Frame'],
          ['NEAREST_MARKER', 'Selection to Nearest Marker'],
        ],
      },
    ],
    poll: pollSel,
    exec: (ctx, p) => {
      const ed = hoverGP(ctx)!;
      const markers = ctx.doc.scene.timeline_markers ?? [];
      if (p.type === 'NEAREST_MARKER' && !markers.length) return 'CANCELLED';
      const sel = selected(ed);
      for (const f of sel) f.frame_number = p.type === 'CFRA' ? ctx.doc.scene.frame_current : markers.reduce((a, m) => (Math.abs(m.frame - f.frame_number) < Math.abs(a - f.frame_number) ? m.frame : a), markers[0].frame);
      settleAll(ed, new Set(sel));
    },
  },
  {
    idname: 'grease_pencil.frames_copy',
    label: 'Copy Keyframes',
    description: 'Copy the selected keys (with their drawings) to the clipboard',
    poll: pollSel,
    undo: false,
    exec: (ctx) => {
      const ed = hoverGP(ctx)!;
      const sel = selected(ed);
      const first = Math.min(...sel.map((f) => f.frame_number));
      clipboard = [];
      for (const { gp, layer } of layersOf(ed))
        for (const f of layer.frames) if (f.select && gp.drawings[f.drawing]) clipboard.push({ layer: layer.name, offset: f.frame_number - first, type: f.keyframe_type, drawing: copyDrawing(gp.drawings[f.drawing]) });
      app.report('INFO', `Copied ${clipboard.length} keyframe(s)`);
    },
  },
  {
    idname: 'grease_pencil.frames_paste',
    label: 'Paste Keyframes',
    description: 'Paste the copied keys at the current frame, into the layers they came from (or the active layer)',
    props: [
      {
        id: 'merge',
        label: 'Type',
        type: 'enum',
        default: 'MIX',
        items: [
          ['MIX', 'Mix', 'Keep the existing keys, replacing those on the same frames'],
          ['OVER_RANGE', 'Overwrite Range', 'Remove the existing keys in the pasted range first'],
        ],
      },
    ],
    poll: (ctx) => poll(ctx) && clipboard.length > 0,
    exec: (ctx, p) => {
      const ed = hoverGP(ctx)!;
      const cfra = ctx.doc.scene.frame_current;
      const sets = ed.frameSets();
      const active = gpOf(ctx.doc, app.activeObject);
      let n = 0;
      for (const { gp, layer } of layersOf(ed)) for (const f of layer.frames) f.select = false;
      const span = Math.max(...clipboard.map((c) => c.offset));
      for (const c of clipboard) {
        let target: { gp: GreasePencilData; layer: GPLayer } | null = null;
        for (const s of sets) {
          const l = s.gp.layers.find((x) => x.name === c.layer);
          if (l) target = { gp: s.gp, layer: l };
        }
        if (!target && active) target = { gp: active, layer: active.layers[active.active_layer_index] };
        if (!target?.layer || target.layer.lock) continue;
        const { gp, layer } = target;
        if (p.merge === 'OVER_RANGE') layer.frames = layer.frames.filter((f) => f.frame_number < cfra || f.frame_number > cfra + span);
        gp.drawings.push(copyDrawing(c.drawing));
        const frame = cfra + c.offset;
        layer.frames = layer.frames.filter((f) => f.frame_number !== frame);
        layer.frames.push({ frame_number: frame, drawing: gp.drawings.length - 1, keyframe_type: c.type, select: true });
        sortFrames(layer);
        n++;
      }
      for (const { gp } of sets) compactDrawings(gp);
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'grease_pencil.frames_select_leftright',
    label: 'Select Left/Right',
    description: 'Select the keys before or after the current frame',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'LEFT',
        items: [
          ['LEFT', 'Before Current Frame'],
          ['RIGHT', 'After Current Frame'],
        ],
      },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll,
    exec: (ctx, p) => {
      const cfra = ctx.doc.scene.frame_current;
      for (const f of hoverGP(ctx)!.allFrames()) {
        const hit = p.mode === 'LEFT' ? f.frame_number <= cfra : f.frame_number >= cfra;
        f.select = hit || (!!p.extend && !!f.select);
      }
    },
  },
  {
    idname: 'grease_pencil.frames_select_more',
    label: 'Select More',
    description: 'Select the keys next to the selected ones',
    poll,
    exec: (ctx) => {
      for (const { layer } of layersOf(hoverGP(ctx)!)) {
        const was = layer.frames.map((f) => !!f.select);
        layer.frames.forEach((f, i) => (f.select = was[i] || !!was[i - 1] || !!was[i + 1]));
      }
    },
  },
  {
    idname: 'grease_pencil.frames_select_less',
    label: 'Select Less',
    description: 'Deselect the keys at the ends of each selected run',
    poll,
    exec: (ctx) => {
      for (const { layer } of layersOf(hoverGP(ctx)!)) {
        const was = layer.frames.map((f) => !!f.select);
        layer.frames.forEach((f, i) => (f.select = was[i] && (i === 0 || was[i - 1]) && (i === was.length - 1 || was[i + 1])));
      }
    },
  },
  {
    idname: 'grease_pencil.frames_select_linked',
    label: 'Select Linked',
    description: 'Select every key of the layers with a selected key',
    poll,
    exec: (ctx) => {
      for (const { layer } of layersOf(hoverGP(ctx)!)) if (layer.frames.some((f) => f.select)) for (const f of layer.frames) f.select = true;
    },
  },
  {
    idname: 'grease_pencil.frames_select_column_keys',
    label: 'Columns on Selected Keys',
    description: 'Select all keys on the frames of the selected keys',
    poll,
    exec: (ctx) => {
      const ed = hoverGP(ctx)!;
      const frames = new Set(selected(ed).map((f) => f.frame_number));
      for (const f of ed.allFrames()) if (frames.has(f.frame_number)) f.select = true;
    },
  },
  {
    idname: 'grease_pencil.frames_jump',
    label: 'Jump to Keyframes',
    description: 'Set the current frame to the middle of the selected keys',
    poll: pollSel,
    undo: false,
    exec: (ctx) => {
      const sel = selected(hoverGP(ctx)!);
      app.setFrame(Math.round(sel.reduce((a, f) => a + f.frame_number, 0) / sel.length));
    },
  },
]);

addKeys('Dopesheet Grease Pencil', [
  { key: 'S', op: 'grease_pencil.frames_scale' },
  { key: 'E', op: 'grease_pencil.frames_extend' },
  { key: 'M', ctrl: true, op: 'grease_pencil.frames_mirror', props: { type: 'CFRA' } },
  { key: 'S', shift: true, op: 'grease_pencil.frames_snap', props: { type: 'CFRA' } },
  { key: 'C', ctrl: true, op: 'grease_pencil.frames_copy' },
  { key: 'V', ctrl: true, op: 'grease_pencil.frames_paste' },
  { key: 'LEFT_BRACKET', op: 'grease_pencil.frames_select_leftright', props: { mode: 'LEFT' } },
  { key: 'RIGHT_BRACKET', op: 'grease_pencil.frames_select_leftright', props: { mode: 'RIGHT' } },
  { key: 'NUMPAD_PLUS', ctrl: true, op: 'grease_pencil.frames_select_more' },
  { key: 'NUMPAD_MINUS', ctrl: true, op: 'grease_pencil.frames_select_less' },
  { key: 'L', op: 'grease_pencil.frames_select_linked' },
  { key: 'K', op: 'grease_pencil.frames_select_column_keys' },
  { key: 'G', ctrl: true, op: 'grease_pencil.frames_jump' },
]);
