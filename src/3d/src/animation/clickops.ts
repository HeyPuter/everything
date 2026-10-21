// Click selection as operators (action.clickselect, graph.clickselect, nla.click_select,
// nla.channels_click): select what is under a point of the editor, for scripts, the keymap
// editor and the operator search. The editors' own mouse handling does the same on clicks.
import { app, registerOperators, type OpContext } from '../app/app';
import { DopeSheet } from './dopesheet';
import { GraphEditor } from './graph';
import { NlaEditor } from './nla';
import { selectAll, selectColumns, setKeySelected } from './keyedit';

/** Point to select at, in the editor's main region: the mouse_x/y props or the event position. */
function regionPoint(ctx: OpContext, p: Record<string, unknown>, ed: { local: (e: { clientX: number; clientY: number }) => { x: number; y: number } }) {
  if ((p.mouse_x as number) >= 0 && (p.mouse_y as number) >= 0) return { x: p.mouse_x as number, y: p.mouse_y as number };
  const ev = ctx.event ?? app.pointer;
  return ed.local({ clientX: ev.x, clientY: ev.y });
}

const pointProps = [
  { id: 'mouse_x', label: 'Mouse X', type: 'int' as const, default: -1, hidden: true },
  { id: 'mouse_y', label: 'Mouse Y', type: 'int' as const, default: -1, hidden: true },
  { id: 'extend', label: 'Extend Select', type: 'bool' as const, default: false },
  { id: 'deselect_all', label: 'Deselect On Nothing', type: 'bool' as const, default: false },
];

registerOperators([
  {
    idname: 'action.clickselect',
    label: 'Select Keyframes',
    description: 'Select the keyframes under the point (Alt: the whole column, Ctrl Alt: every key of the channel)',
    props: [...pointProps, { id: 'column', label: 'Column Select', type: 'bool', default: false }, { id: 'channel', label: 'Only Channel', type: 'bool', default: false }],
    poll: (ctx) => ctx.area?.editor instanceof DopeSheet,
    exec: (ctx, p) => {
      const ed = ctx.area!.editor as DopeSheet;
      const { x, y } = regionPoint(ctx, p, ed);
      const curves = ed.list.curves;
      const hit = ed.keyAt(x, y);
      if (!hit) {
        if (p.deselect_all && !p.extend) selectAll(curves, 'DESELECT');
        else return 'CANCELLED';
        return;
      }
      if (p.channel) {
        if (!p.extend) selectAll(curves, 'DESELECT');
        for (const r of hit.ch.curves) r.fc.keyframe_points.forEach((k) => setKeySelected(k, true));
        return;
      }
      if (p.column) {
        selectColumns(curves, [hit.frame], !!p.extend);
        return;
      }
      const keys = ed.keysAt(hit.ch, hit.frame);
      const allSel = keys.every((k) => k.select_control_point);
      if (p.extend) keys.forEach((k) => setKeySelected(k, !allSel));
      else {
        selectAll(curves, 'DESELECT');
        keys.forEach((k) => setKeySelected(k, true));
      }
    },
  },
  {
    idname: 'graph.clickselect',
    label: 'Select Keyframes',
    description: 'Select the keyframe or handle under the point (Alt: the whole column, Ctrl Alt: every key of the curve)',
    props: [...pointProps, { id: 'column', label: 'Column Select', type: 'bool', default: false }, { id: 'curves', label: 'Only Curves', type: 'bool', default: false }],
    poll: (ctx) => ctx.area?.editor instanceof GraphEditor,
    exec: (ctx, p) => {
      const ed = ctx.area!.editor as GraphEditor;
      const { x, y } = regionPoint(ctx, p, ed);
      const curves = ed.visibleCurves();
      const hit = ed.pick(x, y);
      if (p.curves) {
        const r = hit?.r ?? ed.pickCurve(x, y);
        if (!r) return 'CANCELLED';
        if (!p.extend) selectAll(curves, 'DESELECT');
        r.fc.keyframe_points.forEach((k) => setKeySelected(k, true));
        ed.setActive(r);
        return;
      }
      if (!hit) {
        const r = ed.pickCurve(x, y);
        if (r) {
          if (!p.extend) selectAll(curves, 'DESELECT');
          r.fc.keyframe_points.forEach((k) => setKeySelected(k, true));
          ed.setActive(r);
          return;
        }
        if (p.deselect_all && !p.extend) selectAll(curves, 'DESELECT');
        else return 'CANCELLED';
        return;
      }
      if (p.column) {
        selectColumns(curves, [hit.k.co[0]], !!p.extend);
        return;
      }
      const { r, k, part } = hit;
      const cur = part === 'co' ? !!k.select_control_point : part === 'l' ? !!k.select_left_handle : !!k.select_right_handle;
      const v = p.extend ? !cur : true;
      if (!p.extend) selectAll(curves, 'DESELECT');
      if (part === 'co') setKeySelected(k, v);
      else if (part === 'l') k.select_left_handle = v;
      else k.select_right_handle = v;
      if (v) ed.setActive(r, k);
    },
  },
  {
    idname: 'nla.click_select',
    label: 'Select',
    description: 'Select the NLA strip under the point',
    props: pointProps,
    poll: (ctx) => ctx.area?.editor instanceof NlaEditor,
    exec: (ctx, p) => {
      const ed = ctx.area!.editor as NlaEditor;
      const { x, y } = regionPoint(ctx, p, ed);
      const hit = ed.stripAt(x, y);
      if (!hit) {
        if (p.deselect_all && !p.extend) ed.deselectStrips();
        else return 'CANCELLED';
        return;
      }
      if (p.extend) hit.strip.select = !hit.strip.select;
      else {
        ed.deselectStrips();
        hit.strip.select = true;
      }
      if (hit.strip.select) ed.activeStrip = hit.strip;
      for (const t of hit.ad.nla_tracks) t.select = t === hit.track;
    },
  },
  {
    idname: 'nla.channels_click',
    label: 'Mouse Click on NLA Tracks',
    description: 'Select the NLA track (or object, action line) under the point',
    props: [
      { id: 'mouse_y', label: 'Mouse Y', type: 'int', default: -1, hidden: true },
      { id: 'extend', label: 'Extend Select', type: 'bool', default: false },
    ],
    poll: (ctx) => ctx.area?.editor instanceof NlaEditor,
    exec: (ctx, p) => {
      const ed = ctx.area!.editor as NlaEditor;
      const ev = ctx.event ?? app.pointer;
      const y = (p.mouse_y as number) >= 0 ? (p.mouse_y as number) : ed.local({ clientX: ev.x, clientY: ev.y }).y;
      const ch = ed.list.rows[ed.rowAt(y)];
      if (!ch) return 'CANCELLED';
      ed.clickChannel(ch, !!p.extend);
    },
  },
]);
