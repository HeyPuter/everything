// Retiming operators: keys, freeze frames, eased transitions, segment speed, reset, display.
import { app, registerOperators, type Operator } from '../app/app';
import type { Strip } from './types';
import { seqList, selectedStrips, hasEditor, afterEdit, isLocked, toolSettings } from './context';
import { restartPlayback } from './audio';
import { openRedoPopup } from '../ui/redo';
import { retimable, hasRetiming, addKey, addFreezeFrame, addTransition, deleteKeys, resetRetiming, setSegmentSpeed, segmentAt, segmentSpeed, selectedKeys, ensureKeys } from './retime';
import { finalStart, finalEnd, resolveOverlap } from './strips';

const targets = () => (hasEditor() ? selectedStrips().filter((s) => retimable(s) && !isLocked(s)) : []);
const withKeys = () => targets().filter(hasRetiming);
const anyKeySelected = () => withKeys().some((s) => selectedKeys(s).length > 0);

function finish(changed: Strip[]) {
  if (!changed.length) return 'CANCELLED' as const;
  resolveOverlap(seqList(), changed, toolSettings().overlap_mode);
  afterEdit();
  restartPlayback();
  return 'FINISHED' as const;
}

/** Segments a speed change applies to: selected keys' following segments, else the one at the playhead, else all. */
function speedSegments(s: Strip, frame: number): number[] {
  if (!hasRetiming(s)) return [0];
  const k = s.retiming_keys!;
  const sel = selectedKeys(s).filter((i) => i < k.length - 1);
  if (sel.length) return sel;
  if (frame >= finalStart(s) && frame < finalEnd(s)) return [segmentAt(k, frame - s.frame_start)];
  return k.slice(0, -1).map((_, i) => i);
}

const ops: Operator[] = [
  {
    idname: 'sequencer.retiming_show',
    label: 'Retime Strips',
    description: 'Show or hide the retiming keys of the selected strips',
    poll: () => targets().length > 0,
    exec: () => {
      const t = targets();
      const show = !t.every((s) => s.show_retiming_keys);
      for (const s of t) s.show_retiming_keys = show;
    },
  },
  {
    idname: 'sequencer.retiming_key_add',
    label: 'Add Retiming Key',
    description: 'Add a retiming key at the current frame to the selected strips',
    props: [{ id: 'timeline_frame', label: 'Timeline Frame', type: 'int', default: 0 }],
    poll: () => targets().length > 0,
    invoke: (c, p) => app.run('sequencer.retiming_key_add', { ...p, timeline_frame: c.doc.scene.frame_current }, { invoke: false }),
    exec: (_c, p) => {
      const f = p.timeline_frame as number;
      const changed: Strip[] = [];
      for (const s of targets()) {
        if (f <= finalStart(s) || f >= finalEnd(s)) continue;
        const had = hasRetiming(s);
        if (addKey(s, f - s.frame_start) >= 0) {
          s.show_retiming_keys = true;
          changed.push(s);
        } else if (!had) delete s.retiming_keys;
      }
      if (!changed.length) {
        app.report('WARNING', 'No selected strip at the current frame can take a key here');
        return 'CANCELLED';
      }
      afterEdit();
    },
  },
  {
    idname: 'sequencer.retiming_freeze_frame_add',
    label: 'Add Freeze Frame',
    description: 'Hold the content frame at the current frame for a number of frames',
    props: [{ id: 'duration', label: 'Duration', type: 'int', default: 12, min: 1 }],
    poll: () => targets().length > 0,
    exec: (c, p) => {
      const f = c.doc.scene.frame_current;
      const changed: Strip[] = [];
      for (const s of targets()) {
        if (f <= finalStart(s) || f >= finalEnd(s)) continue;
        const had = hasRetiming(s);
        if (addFreezeFrame(s, f - s.frame_start, p.duration as number)) {
          s.show_retiming_keys = true;
          changed.push(s);
        } else if (!had) delete s.retiming_keys;
      }
      return finish(changed);
    },
  },
  {
    idname: 'sequencer.retiming_transition_add',
    label: 'Add Speed Transition',
    description: 'Ease from one speed to the next around the selected retiming keys',
    props: [{ id: 'duration', label: 'Duration', type: 'int', default: 12, min: 2 }],
    poll: anyKeySelected,
    exec: (_c, p) => {
      const changed: Strip[] = [];
      for (const s of withKeys()) {
        let any = false;
        // from the last so indices stay valid as keys are replaced by pairs
        for (const i of selectedKeys(s).reverse()) if (addTransition(s, i, p.duration as number)) any = true;
        if (any) changed.push(s);
      }
      if (!changed.length) {
        app.report('WARNING', 'Select inner retiming keys with room on both sides for the transition');
        return 'CANCELLED';
      }
      return finish(changed);
    },
  },
  {
    idname: 'sequencer.retiming_key_delete',
    label: 'Delete Retiming Keys',
    description: 'Delete the selected retiming keys',
    poll: anyKeySelected,
    exec: () => finish(withKeys().filter((s) => deleteKeys(s, selectedKeys(s)))),
  },
  {
    idname: 'sequencer.retiming_reset',
    label: 'Reset Retiming',
    description: 'Play the selected strips at normal speed again',
    poll: () => withKeys().length > 0,
    exec: () => finish(withKeys().filter((s) => resetRetiming(s))),
  },
  {
    idname: 'sequencer.retiming_segment_speed_set',
    label: 'Set Speed',
    description: 'Set the playback speed of the retiming segment at the current frame (or of selected keys), as a percentage',
    props: [
      { id: 'speed', label: 'Speed', type: 'float', default: 100, min: 0.1, max: 10000, softMax: 400, precision: 1, subtype: 'percentage' },
      { id: 'keep_retiming', label: 'Preserve Current Retiming', type: 'bool', default: true },
    ],
    poll: () => targets().length > 0,
    invoke: (c, p) => {
      // start from the current speed and offer the value for adjustment right away
      const s = targets()[0];
      const segs = speedSegments(s, c.doc.scene.frame_current);
      p.speed = hasRetiming(s) ? Math.round(segmentSpeed(s.retiming_keys!, segs[0]) * 1000) / 10 : 100;
      const at = { x: app.pointer.x, y: app.pointer.y };
      setTimeout(() => openRedoPopup(at), 0);
      return 'FINISHED';
    },
    exec: (c, p) => {
      const speed = (p.speed as number) / 100;
      const changed: Strip[] = [];
      for (const s of targets()) {
        if (!p.keep_retiming && hasRetiming(s)) resetRetiming(s);
        ensureKeys(s);
        // later segments shift as earlier ones change length: go from the last
        let any = false;
        for (const i of speedSegments(s, c.doc.scene.frame_current).sort((a, b) => b - a)) if (setSegmentSpeed(s, i, speed)) any = true;
        if (any) changed.push(s);
        else if (s.retiming_keys?.length === 2 && segmentSpeed(s.retiming_keys, 0) === 1) delete s.retiming_keys;
      }
      return finish(changed);
    },
  },
];

registerOperators(ops);
