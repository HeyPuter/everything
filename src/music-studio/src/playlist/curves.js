// Automation curve editing in the playlist: the active automation point (the
// keyboard handle for point and curve edits), stepping through points,
// bending the segment after a point, curve presets for the clip menu, and
// readable descriptions for hints and announcements. The pointer gestures
// (Alt+drag on a segment) live in pointer.js; the curve math in
// automation/evaluate.js and automation/points.js.
//
//   installCurves(V)            adds V.activePoint ({ clip, index } or null) and
//                               V.stepPoint(dir), V.bendCurve(dir), V.resetCurve(),
//                               V.curveItems(clip, index)

import { announce } from '../lib/dom.js';
import * as E from '../model/edits.js';
import { formatBST } from '../model/time.js';
import { formatParam, fromNorm } from '../lib/params.js';
import { setCurve, segmentAt, dragCurve, CURVE_PRESETS } from '../automation/points.js';
import { resolveTarget } from '../automation/targets.js';
import { clipAt, timeOrder } from './clips.js';

/** Tension change per key press, in drag units (normalized value). */
const KEY_STEP = 0.05;

/** "linear", "ease in 40%", "ease out 25%". */
export function describeCurve(c) {
  const k = Math.round(Math.abs(c || 0) * 100);
  if (!k) return 'linear';
  return `${c > 0 ? 'ease in' : 'ease out'} ${k}%`;
}

export function installCurves(V) {
  const { store, app } = V;
  V.activePoint = null;

  const autoOf = (clip) => (clip?.kind === 'auto' ? store.project.automation[clip.ref] || null : null);

  /** The automation clip keyboard edits apply to: the active point's, a selected one, or the one under the cursor. */
  function targetClip() {
    const p = store.project;
    const ap = V.activePoint;
    if (ap) {
      const c = p.clips.find((x) => x.id === ap.clip);
      if (autoOf(c)?.points[ap.index]) return c;
      V.activePoint = null;
    }
    const sel = timeOrder(p.clips.filter((c) => c.kind === 'auto' && V.selection.has(c.id)));
    if (sel.length) return sel[0];
    const under = clipAt(V.byTrack, V.cursor.track, V.cursor.tick);
    return under?.kind === 'auto' ? under : null;
  }

  /** Indices of the points inside a clip's window. */
  function visible(clip, a) {
    const out = [];
    a.points.forEach((pt, i) => {
      if (pt.t >= clip.offset && pt.t <= clip.offset + clip.len) out.push(i);
    });
    return out;
  }

  function valueText(a, v) {
    const tgt = resolveTarget(store.project, a.target);
    return tgt ? formatParam(tgt.def, fromNorm(tgt.def, v)) : `${Math.round(v * 100)}%`;
  }

  function describePoint(clip, a, index) {
    const pt = a.points[index];
    const n = visible(clip, a);
    const pos = formatBST(clip.start + pt.t - clip.offset, store.project.sig);
    const seg = index + 1 < a.points.length ? `, curve ${describeCurve(pt.c)}` : '';
    return `${a.name} point ${n.indexOf(index) + 1} of ${n.length}: ${pos}, ${valueText(a, pt.v)}${seg}`;
  }

  /** Makes the next (dir 1) or previous (dir -1) point of the target clip active. */
  V.stepPoint = (dir) => {
    const clip = targetClip();
    const a = autoOf(clip);
    if (!a) {
      announce('Select an automation clip first');
      app.hint('Select an automation clip, then press , and . to step through its points.');
      return;
    }
    const n = visible(clip, a);
    if (!n.length) return;
    const ap = V.activePoint;
    let k;
    if (ap && ap.clip === clip.id) {
      const cur = n.indexOf(ap.index);
      k = Math.max(0, Math.min(n.length - 1, cur + dir));
    } else k = dir > 0 ? 0 : n.length - 1;
    V.activePoint = { clip: clip.id, index: n[k] };
    V.kbd = true;
    V.revealTick?.(clip.start + a.points[n[k]].t - clip.offset);
    V.markDirty();
    const text = describePoint(clip, a, n[k]);
    announce(text);
    app.hint(`${text}. [ and ] bend the curve to the next point.`);
  };

  /** The segment keyboard curve edits apply to: { clip, a, index } or null (announces why). */
  function keySegment() {
    const clip = targetClip();
    const a = autoOf(clip);
    if (!a) {
      announce('Select an automation clip first');
      return null;
    }
    let index = V.activePoint?.clip === clip.id ? V.activePoint.index : segmentAt(a.points, V.cursor.tick - clip.start + clip.offset);
    if (index < 0 || index + 1 >= a.points.length) {
      announce(index < 0 ? 'Choose a point first: press , or . to step through points' : 'The last point has no curve after it');
      return null;
    }
    if (a.points[index].t === a.points[index + 1].t) index++;
    if (index + 1 >= a.points.length) return null;
    return { clip, a, index };
  }

  function applyCurve(clip, a, index, c, label = 'Change curve') {
    const cur = a.points[index];
    const next = a.points[index + 1];
    if (!next || next.v === cur.v) {
      announce('This segment is flat: give its points different values to curve it');
      return;
    }
    store.apply(label, (p) => E.updateAutomation(p, a.id, { points: setCurve(p.automation[a.id].points, index, c) }));
    V.activePoint = { clip: clip.id, index };
    V.markDirty();
    const text = `${a.name} curve ${describeCurve(store.project.automation[a.id]?.points[index]?.c)}`;
    announce(text);
    app.hint(text);
  }

  /** Bends the active segment up (dir 1) or down (dir -1), like Alt+dragging it. */
  V.bendCurve = (dir) => {
    const s = keySegment();
    if (!s) return;
    const p0 = s.a.points[s.index];
    const p1 = s.a.points[s.index + 1];
    applyCurve(s.clip, s.a, s.index, dragCurve(p0.c, p0.v, p1.v, dir * KEY_STEP));
  };

  V.resetCurve = () => {
    const s = keySegment();
    if (s) applyCurve(s.clip, s.a, s.index, 0, 'Reset curve');
  };

  /** "Curve" submenu items for the segment that starts at point `index` of an automation clip. */
  V.curveItems = (clip, index) => {
    const a = autoOf(clip);
    const pt = a?.points[index];
    const next = a?.points[index + 1];
    if (!pt || !next) return [];
    const flat = next.v === pt.v;
    const cur = pt.c || 0;
    const items = CURVE_PRESETS.map((pr) => ({
      type: 'radio',
      label: pr.label,
      checked: Math.abs(cur - pr.c) < 1e-6,
      enabled: !flat || !pr.c,
      run: () => applyCurve(clip, a, index, pr.c, pr.c ? 'Change curve' : 'Reset curve'),
    }));
    items.push(
      { type: 'sep' },
      {
        type: 'cmd',
        label: 'Reset all curves in this automation',
        enabled: a.points.some((q) => q.c),
        run: () => {
          store.apply('Reset curves', (p) => E.updateAutomation(p, a.id, { points: p.automation[a.id].points.map(({ t, v }) => ({ t, v })) }));
          announce(`${a.name}: all segments linear`);
        },
      },
    );
    return items;
  };

  // A deleted clip or point drops the active point.
  store.on('change', () => {
    const ap = V.activePoint;
    if (!ap) return;
    const c = store.project.clips.find((x) => x.id === ap.clip);
    if (!autoOf(c)?.points[ap.index]) V.activePoint = null;
  });
}
