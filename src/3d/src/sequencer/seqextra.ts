// More sequencer operators: Duplicate Linked (timeline and preview), click selection and handle
// selection as operators, pixel sampling in the preview, the frame overlay rectangle (O in the
// preview), retiming keys added and slid in one go, and the keyframe operators of the preview.
import { app, operators, registerOperators, type OpContext, type Operator } from '../app/app';
import type { Strip } from './types';
import { hoverSeq, hasEditor, overPreview, selectedStrips, seqEditor, isLocked, afterEdit } from './context';
import { selectStrip } from './ops';
import { addFreezeFrame, addKey, addTransition, hasRetiming, retimable, selectedKeys } from './retime';
import { startRetimingKeyMove } from './transform';
import { finalStart, finalEnd } from './strips';
import type { PreviewRegion } from './preview';

const preview = (): PreviewRegion | null => (hoverSeq() as unknown as { preview?: PreviewRegion } | null)?.preview ?? null;

/** Run another operator's invoke (or exec) with this operator's context. */
function delegate(id: string): (ctx: OpContext, p: Record<string, unknown>) => ReturnType<NonNullable<Operator['exec']>> {
  return (ctx, p) => {
    const op = operators.get(id);
    if (!op) return 'CANCELLED';
    return (op.invoke ?? op.exec)!(ctx, p);
  };
}

/** Timeline strip and handle under the pointer. */
function hit(): { strip: Strip; handle: 'LEFT' | 'RIGHT' | null } | null {
  const ed = hoverSeq() as unknown as {
    hitTest?(x: number, y: number): { strip: Strip; handle: 'LEFT' | 'RIGHT' | null } | null;
    local?(e: { clientX: number; clientY: number }): { x: number; y: number };
  } | null;
  if (!ed?.hitTest || !ed.local) return null;
  const { x, y } = ed.local({ clientX: app.pointer.x, clientY: app.pointer.y });
  return ed.hitTest(x, y);
}

const retimeTargets = () => (hasEditor() ? selectedStrips().filter((s) => retimable(s) && !isLocked(s)) : []);

registerOperators([
  {
    idname: 'sequencer.duplicate_move_linked',
    label: 'Duplicate Linked',
    description: 'Duplicate the selected strips, keeping them on the same media, and move them',
    poll: () => hasEditor() && selectedStrips().length > 0,
    invoke: delegate('sequencer.duplicate_move'),
  },
  {
    idname: 'sequencer.preview_duplicate_move_linked',
    label: 'Duplicate Linked',
    description: 'Duplicate the selected strips, keeping them on the same media, and move their images in the preview',
    poll: () => hasEditor() && selectedStrips().length > 0 && overPreview(),
    invoke: delegate('sequencer.preview_duplicate_move'),
  },
  {
    idname: 'sequencer.select',
    label: 'Select',
    description: 'Select the strip under the pointer (or the named strip)',
    props: [
      { id: 'strip', label: 'Strip', type: 'string', default: '', hidden: true },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'toggle', label: 'Toggle Selection', type: 'bool', default: false },
      { id: 'deselect_all', label: 'Deselect On Nothing', type: 'bool', default: true },
      { id: 'ignore_connections', label: 'Ignore Connections', type: 'bool', default: false },
    ],
    poll: () => hasEditor(),
    exec: (_c, p) => {
      const named = p.strip ? seqEditor().strips.find((s) => s.name === p.strip) : undefined;
      const s = named ?? (overPreview() ? (hoverSeq()?.pickStrip(app.pointer.x, app.pointer.y) ?? null) : (hit()?.strip ?? null));
      if (!s && (p.extend || p.toggle || !p.deselect_all)) return 'CANCELLED';
      selectStrip(s, { extend: !!p.extend, toggle: !!p.toggle, deselectAll: !!p.deselect_all, ignoreConnections: !!p.ignore_connections });
      afterEdit();
    },
  },
  {
    idname: 'sequencer.select_handle',
    label: 'Select Handle',
    description: 'Select the strip handle under the pointer (the start or end of a strip, for trimming)',
    props: [{ id: 'ignore_connections', label: 'Ignore Connections', type: 'bool', default: false }],
    poll: () => hasEditor() && !overPreview(),
    exec: (_c, p) => {
      const h = hit();
      if (!h?.handle) return 'CANCELLED';
      selectStrip(h.strip, { handle: h.handle, ignoreConnections: !!p.ignore_connections });
      afterEdit();
    },
  },
  {
    idname: 'sequencer.sample',
    label: 'Sample Color',
    description: 'Show the color of the preview image under the pointer while moving (click or Esc to stop)',
    undo: false,
    poll: () => hasEditor() && !!preview(),
    invoke: () => {
      const pv = preview()!;
      const show = (x: number, y: number) => {
        const v = pv.sample(x, y);
        const r = pv.el.getBoundingClientRect();
        pv.sampleInfo = v ? { x: x - r.left, y: y - r.top, ...v } : null;
        pv.draw();
        return v;
      };
      show(app.pointer.x, app.pointer.y);
      const end = () => {
        const last = pv.sampleInfo;
        pv.sampleInfo = null;
        pv.draw();
        if (last) app.report('INFO', `Sample at ${last.px[0]}, ${last.px[1]}: ${last.rgba.map((c) => c.toFixed(3)).join(', ')}`);
      };
      app.startModal({
        label: 'Sample Color',
        cursor: 'crosshair',
        header: () => 'Sample: move over the preview, click or Esc to finish',
        onPointerMove: (e) => void show(e.clientX, e.clientY),
        onPointerDown: () => 'FINISHED',
        onKey: (e) => (e.type === 'keydown' && (e.key === 'Escape' || e.key === 'Enter') ? 'FINISHED' : undefined),
        cancel: end,
        finish: end,
      });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'sequencer.view_ghost_border',
    label: 'Frame Overlay Region',
    description: 'Drag a rectangle in the preview where the frame overlay shows the reference frame',
    poll: () => hasEditor() && !!preview(),
    invoke: () => {
      const pv = preview()!;
      const ed = seqEditor();
      const [W, H] = [Math.max(1, app.doc.scene.render.resolution_x), Math.max(1, app.doc.scene.render.resolution_y)];
      let start: [number, number] | null = null;
      const rect = (x: number, y: number) => {
        const r = pv.el.getBoundingClientRect();
        pv.boxRect = start ? { x0: start[0] - r.left, y0: start[1] - r.top, x1: x - r.left, y1: y - r.top } : null;
        pv.draw();
      };
      app.startModal({
        label: 'Frame Overlay Region',
        cursor: 'crosshair',
        header: () => (start ? 'Release to set the overlay region' : 'Drag the region where the reference frame shows (Esc cancels)'),
        onPointerDown: (e) => {
          if (e.button !== 0) return 'CANCELLED';
          start = [e.clientX, e.clientY];
          rect(e.clientX, e.clientY);
        },
        onPointerMove: (e) => rect(e.clientX, e.clientY),
        onPointerUp: (e) => {
          if (!start) return;
          const a = pv.toFrame(start[0], start[1]),
            b = pv.toFrame(e.clientX, e.clientY);
          const c01 = (v: number) => Math.max(0, Math.min(1, v));
          const x0 = c01(Math.min(a[0], b[0]) / W),
            x1 = c01(Math.max(a[0], b[0]) / W),
            y0 = c01(Math.min(a[1], b[1]) / H),
            y1 = c01(Math.max(a[1], b[1]) / H);
          if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return 'CANCELLED';
          ed.overlay_frame_rect = [x0, y0, x1, y1];
          ed.overlay_frame_type = 'RECTANGLE';
          ed.show_overlay_frame = true;
          return 'FINISHED';
        },
        onKey: (e) => (e.type === 'keydown' && e.key === 'Escape' ? 'CANCELLED' : undefined),
        cancel: () => ((pv.boxRect = null), pv.draw()),
        finish: () => {
          pv.boxRect = null;
          afterEdit();
          app.pushUndo('Frame Overlay Region');
        },
      });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'sequencer.retiming_add_freeze_frame_slide',
    label: 'Add Freeze Frame and Slide',
    description: 'Hold the content frame at the current frame; move the pointer to set how long it holds',
    poll: () => retimeTargets().length > 0,
    invoke: (c) => {
      const f = c.doc.scene.frame_current;
      const s = retimeTargets().find((x) => f > finalStart(x) && f < finalEnd(x));
      const ed = hoverSeq();
      if (!s || !ed) {
        app.report('WARNING', 'Put the playhead over a selected strip to freeze it there');
        return 'CANCELLED';
      }
      const had = hasRetiming(s);
      if (!addFreezeFrame(s, f - s.frame_start, 1)) {
        if (!had) delete s.retiming_keys;
        return 'CANCELLED';
      }
      s.show_retiming_keys = true;
      // the key ending the freeze follows the pointer
      const end = s.retiming_keys!.findIndex((k) => k.frame === f - s.frame_start + 1);
      afterEdit();
      return end > 0 && startRetimingKeyMove(ed, s, end, app.pointer.x) ? 'RUNNING_MODAL' : 'FINISHED';
    },
  },
  {
    idname: 'sequencer.retiming_add_transition_slide',
    label: 'Add Speed Transition and Slide',
    description: 'Ease between speeds around the selected retiming key (or one at the current frame); move the pointer to set the length',
    poll: () => retimeTargets().length > 0,
    invoke: (c) => {
      const f = c.doc.scene.frame_current;
      const ed = hoverSeq();
      const s = retimeTargets().find((x) => hasRetiming(x) && selectedKeys(x).length) ?? retimeTargets().find((x) => f > finalStart(x) && f < finalEnd(x));
      if (!s || !ed) return 'CANCELLED';
      let i = hasRetiming(s) ? (selectedKeys(s).find((k) => k > 0 && k < s.retiming_keys!.length - 1) ?? -1) : -1;
      if (i < 0) i = addKey(s, f - s.frame_start);
      if (i <= 0 || !addTransition(s, i, 2)) {
        app.report('WARNING', 'The transition needs a retiming key with room on both sides');
        return 'CANCELLED';
      }
      s.show_retiming_keys = true;
      afterEdit();
      return startRetimingKeyMove(ed, s, i + 1, app.pointer.x) ? 'RUNNING_MODAL' : 'FINISHED';
    },
  },
  {
    idname: 'anim.keyframe_delete_vse',
    label: 'Delete Keyframes',
    description: 'Delete the keyframes of the selected strips at the current frame',
    poll: () => hasEditor() && selectedStrips().length > 0,
    exec: delegate('sequencer.keyframe_delete'),
  },
  {
    idname: 'anim.keyframe_clear_vse',
    label: 'Clear Keyframes',
    description: 'Remove all keyframes of the selected strips',
    poll: () => hasEditor() && selectedStrips().length > 0,
    exec: delegate('sequencer.keyframe_clear'),
  },
]);
