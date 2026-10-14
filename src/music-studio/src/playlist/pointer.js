// Pointer interaction on the playlist clip canvas: the tools (draw, paint,
// delete, mute, slice, select, zoom, playback), clip move / duplicate /
// resize, marquee selection, automation point editing, hover feedback,
// touch long-press menus and two-finger pan and pinch zoom. Every edit runs
// as one store gesture (begin / preview / commit) so a drag is one undo step
// and Escape cancels it.

import * as E from '../model/edits.js';
import { announce } from '../lib/dom.js';
import { clamp } from '../lib/util.js';
import { addPoint, movePoint, removePoint } from '../automation/points.js';
import { resolveTarget } from '../automation/targets.js';
import { formatParam, fromNorm } from '../lib/params.js';
import { snapRound } from '../model/time.js';
import * as C from './clips.js';

const DRAG_PX = 3;
const LONG_PRESS_MS = 500;

export function installPointer(V, el) {
  const { store, app } = V;
  let gesture = null; // { move(pt, e), up(pt, e), cancel() }
  let downAt = null; // { x, y } client coords of the gesture start
  let lastEvent = null;
  let edgeTimer = null;
  let longPress = null;
  const touches = new Map(); // pointerId -> { x, y }
  let pinch = null;

  V.cancelGesture = () => {
    if (!gesture) return false;
    gesture.cancel?.();
    store.cancel();
    endGesture();
    return true;
  };
  V.hasGesture = () => Boolean(gesture);

  function endGesture() {
    gesture = null;
    downAt = null;
    clearInterval(edgeTimer);
    edgeTimer = null;
    clearTimeout(longPress);
    longPress = null;
    if (V.overlay) {
      V.overlay = null;
      V.markDirty();
    }
  }

  const moved = (e) => downAt && (Math.abs(e.clientX - downAt.x) > DRAG_PX || Math.abs(e.clientY - downAt.y) > DRAG_PX);

  // ---------------------------------------------------------------- gestures

  function moveGesture(pt, hit, e) {
    const clip = hit.clip;
    const dup = e.shiftKey;
    const wasSelected = V.selection.has(clip.id);
    if (!wasSelected) V.selectClips([clip.id], { announce: false });
    const ids = [...V.selection];
    let started = false;
    store.begin(dup ? 'Duplicate clips' : 'Move clips');
    return {
      move(p2, ev) {
        if (!started && !moved(ev)) return;
        started = true;
        const g = V.grid(ev);
        const raw = p2.tick - pt.tick;
        const ns = g ? snapRound(clip.start + raw, g) : Math.round(clip.start + raw);
        const r = store.preview((p) => C.moveClips(p, ids, ns - clip.start, p2.track - pt.track, { duplicate: dup }));
        if (r?.ids) V.setSelection(r.ids);
        app.hint(dup ? 'Duplicating: release to drop the copies. Escape cancels.' : 'Moving: hold Alt to move freely, Shift at the start of a drag duplicates. Escape cancels.');
      },
      up() {
        store.commit();
        if (!started) {
          if (wasSelected && V.selection.size > 1 && V.tool() === 'select') V.selectClips([clip.id], { announce: false });
          V.announceClip(store.project.clips.find((c) => c.id === clip.id));
        } else {
          const n = V.selection.size;
          announce(`${dup ? 'Duplicated' : 'Moved'} ${n} clip${n === 1 ? '' : 's'}`);
        }
      },
    };
  }

  function resizeGesture(pt, hit) {
    const clip = hit.clip;
    const edge = hit.zone;
    if (!V.selection.has(clip.id)) V.selectClips([clip.id], { announce: false });
    const ids = [...V.selection];
    store.begin('Resize clips');
    return {
      move(p2, ev) {
        const g = V.grid(ev);
        const at = edge === 'right' ? clip.start + clip.len : clip.start;
        const raw = at + p2.tick - pt.tick;
        const ne = g ? snapRound(raw, g) : Math.round(raw);
        store.preview((p) => C.resizeClips(p, ids, edge, ne - at, { minLen: g || 1 }));
      },
      up() {
        store.commit();
        const c = store.project.clips.find((x) => x.id === clip.id);
        if (c) V.announceClip(c);
      },
    };
  }

  function placeGesture(pt, e) {
    const src = V.source;
    if (!src || !C.sourceExists(store.project, src)) {
      app.notify('Pick a pattern, audio clip or automation in the picker first');
      return null;
    }
    const start = V.snapFloor(pt.tick, e);
    const natural = C.sourceLength(store.project, src, V.durations());
    let len = natural;
    store.begin('Add clip');
    const place = () => {
      const r = store.preview((p) => C.placeClip(p, src, pt.track, start, len));
      V.setSelection([r.id]);
    };
    place();
    let started = false;
    return {
      move(p2, ev) {
        if (!started && !moved(ev)) return;
        started = true;
        const g = V.grid(ev);
        const end = g ? snapRound(p2.tick, g) : Math.round(p2.tick);
        len = Math.max(g || 1, end - start);
        place();
      },
      up() {
        store.commit();
        const c = store.project.clips.find((x) => V.selection.has(x.id));
        if (c) V.announceClip(c, 'Placed ');
      },
    };
  }

  function paintGesture(pt, e) {
    const src = V.source;
    if (!src || !C.sourceExists(store.project, src)) {
      app.notify('Pick a pattern, audio clip or automation in the picker first');
      return null;
    }
    const len = C.sourceLength(store.project, src, V.durations());
    const anchor = V.snapFloor(pt.tick, e);
    const track = pt.track;
    store.begin('Paint clips');
    const base = store.project;
    const taken = new Set(base.clips.filter((c) => c.track === track && c.kind === src.kind && c.ref === src.id).map((c) => c.start));
    const paint = (tick, ev) => {
      const starts = C.paintStarts(anchor, len, V.snapFloor(tick, ev)).filter((s) => !taken.has(s));
      const r = store.preview((p) => E.addClips(p, starts.map((s) => ({ kind: src.kind, ref: src.id, track, start: s, len, offset: 0 }))));
      V.setSelection(r?.ids || []);
    };
    paint(pt.tick, e);
    return {
      move: (p2, ev) => paint(p2.tick, ev),
      up() {
        store.commit();
        const n = V.selection.size;
        announce(`Painted ${n} clip${n === 1 ? '' : 's'}`);
      },
    };
  }

  // Collects start-state clips under the pointer path (delete and mute tools).
  function sweepGesture(pt, label, apply) {
    store.begin(label);
    const byTrack = C.clipsByTrack(store.project.clips, store.project.tracks.length);
    const hits = [];
    const seen = new Set();
    let last = pt;
    const visit = (a, b) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
      for (let s = 0; s <= steps; s++) {
        const q = V.pointAt(a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps);
        const c = C.clipAt(byTrack, q.track, q.tick);
        if (c && !seen.has(c.id)) {
          seen.add(c.id);
          hits.push(c);
        }
      }
    };
    const run = () => {
      if (hits.length) store.preview((p) => apply(p, hits));
    };
    visit(pt, pt);
    run();
    return {
      move(p2) {
        visit(last, p2);
        last = p2;
        run();
      },
      up() {
        store.commit();
        if (hits.length) announce(`${label}: ${hits.length} clip${hits.length === 1 ? '' : 's'}`);
      },
    };
  }

  function deleteGesture(pt) {
    return sweepGesture(pt, 'Delete clips', (p, hits) => E.removeClips(p, hits.map((c) => c.id)));
  }

  function muteGesture(pt) {
    let target = null;
    return sweepGesture(pt, 'Mute clips', (p, hits) => {
      if (target === null) target = !hits[0].mute;
      return C.toggleClipMute(p, hits.map((c) => c.id), target);
    });
  }

  function sliceGesture(pt, e) {
    V.overlay = { type: 'slice', tick: V.snapRound(pt.tick, e), track0: pt.track, track1: pt.track };
    V.markDirty();
    return {
      move(p2, ev) {
        V.overlay = { type: 'slice', tick: V.snapRound(p2.tick, ev), track0: pt.track, track1: p2.track };
        V.markDirty();
      },
      up() {
        const o = V.overlay;
        const lo = Math.min(o.track0, o.track1);
        const hi = Math.max(o.track0, o.track1);
        const r = store.apply('Slice clips', (p) => C.sliceClips(p, o.tick, (c) => c.track >= lo && c.track <= hi));
        const n = r?.ids?.length || 0;
        if (n) V.setSelection(r.ids);
        announce(n ? `Sliced ${n} clip${n === 1 ? '' : 's'}` : 'Nothing to slice here');
      },
    };
  }

  function marqueeGesture(pt, e) {
    const base = e.shiftKey ? new Set(V.selection) : new Set();
    if (!e.shiftKey) V.setSelection([]);
    V.overlay = { type: 'marquee', x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
    V.markDirty();
    return {
      move(p2) {
        V.overlay = { type: 'marquee', x0: pt.x, y0: pt.y, x1: p2.x, y1: p2.y };
        const ids = C.clipsInRange(store.project.clips, V.vp.tick(pt.x), V.vp.tick(p2.x), pt.track, p2.track);
        V.setSelection([...base, ...ids]);
      },
      up() {
        const n = V.selection.size;
        if (n) announce(`${n} clip${n === 1 ? '' : 's'} selected`);
      },
    };
  }

  function zoomGesture(pt, e) {
    V.overlay = { type: 'zoom', x0: pt.x, x1: pt.x };
    const out = e.altKey;
    return {
      move(p2) {
        V.overlay = { type: 'zoom', x0: pt.x, x1: p2.x };
        V.markDirty();
      },
      up() {
        const o = V.overlay;
        if (Math.abs(o.x1 - o.x0) < 6) V.zoomAt(out ? 0.5 : 2, pt.x);
        else V.zoomToRange(V.vp.tick(Math.min(o.x0, o.x1)), V.vp.tick(Math.max(o.x0, o.x1)));
      },
    };
  }

  function scrubGesture(pt) {
    const eng = app.engine;
    if (eng.mode !== 'song') app.setMode('song');
    const at = Math.max(0, pt.tick);
    eng.seek(at);
    eng.play();
    return {
      move(p2) {
        eng.seek(Math.max(0, p2.tick));
      },
      up() {
        eng.stop();
        eng.seek(at);
      },
      cancel() {
        eng.stop();
      },
    };
  }

  function pointGesture(pt, hit, e, adding) {
    const clip = hit.clip;
    const a = hit.auto.a;
    const { bottom, ch } = hit.auto;
    const toLocal = (tick, ev) => {
      const g = V.grid(ev);
      const st = g ? snapRound(tick, g) : Math.round(tick);
      return clamp(clip.offset + st - clip.start, clip.offset, clip.offset + clip.len);
    };
    const toV = (y) => clamp((bottom - y) / ch, 0, 1);
    let points = a.points;
    let index = hit.auto.index;
    if (adding) {
      const r = addPoint(points, { t: toLocal(pt.tick, e), v: toV(pt.y) });
      points = r.points;
      index = r.index;
    }
    store.begin(adding ? 'Add automation point' : 'Move automation point');
    if (adding) store.preview((p) => E.updateAutomation(p, a.id, { points }));
    V.hoverPoint = { clip: clip.id, index };
    const say = () => {
      const pts = store.project.automation[a.id]?.points;
      const q = pts?.[index];
      if (!q) return;
      const tgt = resolveTarget(store.project, a.target);
      const text = tgt ? formatParam(tgt.def, fromNorm(tgt.def, q.v)) : `${Math.round(q.v * 100)}%`;
      app.hint(`${a.name}: ${text}`);
      return text;
    };
    say();
    return {
      move(p2, ev) {
        store.preview((p) => E.updateAutomation(p, a.id, { points: movePoint(points, index, { t: toLocal(p2.tick, ev), v: toV(p2.y) }) }));
        say();
      },
      up() {
        store.commit();
        const text = say();
        if (text) announce(`${a.name} point ${text}`);
      },
    };
  }

  // ---------------------------------------------------------------- dispatch

  function start(e) {
    const pt = V.point(e);
    const hit = V.hit(pt);
    const tool = V.tool();
    const right = e.button === 2;
    V.kbd = false;
    if (right) {
      if (e.shiftKey || !['draw', 'paint', 'delete'].includes(tool)) {
        if (hit?.auto && hit.auto.index >= 0) return deletePoint(hit);
        openContext(e, pt, hit);
        return null;
      }
      if (hit?.auto && hit.auto.index >= 0) return deletePoint(hit);
      return deleteGesture(pt);
    }
    if (e.button !== 0) return null;
    if (e.ctrlKey || e.metaKey) return marqueeGesture(pt, e);
    // Automation points work with the editing tools.
    if (hit?.auto && ['draw', 'paint', 'select'].includes(tool)) {
      if (hit.auto.index >= 0) return pointGesture(pt, hit, e, false);
      if (hit.auto.onLine || tool === 'draw') return pointGesture(pt, hit, e, true);
    }
    switch (tool) {
      case 'draw':
        if (hit) return hit.zone === 'body' ? moveGesture(pt, hit, e) : resizeGesture(pt, hit);
        return placeGesture(pt, e);
      case 'paint':
        if (hit && hit.zone !== 'body') return resizeGesture(pt, hit);
        return paintGesture(pt, e);
      case 'delete':
        return deleteGesture(pt);
      case 'mute':
        return muteGesture(pt);
      case 'slice':
        return sliceGesture(pt, e);
      case 'zoom':
        return zoomGesture(pt, e);
      case 'playback':
        return scrubGesture(pt);
      case 'select':
      default:
        if (hit) return hit.zone === 'body' ? moveGesture(pt, hit, e) : resizeGesture(pt, hit);
        return marqueeGesture(pt, e);
    }
  }

  function deletePoint(hit) {
    const a = hit.auto.a;
    if (a.points.length <= 1) return null;
    store.apply('Delete automation point', (p) => E.updateAutomation(p, a.id, { points: removePoint(a.points, hit.auto.index) }));
    V.hoverPoint = null;
    announce('Point deleted');
    return null;
  }

  function openContext(e, pt, hit) {
    const at = { x: e.clientX, y: e.clientY };
    if (hit?.clip) V.clipMenu(hit.clip, at);
    else V.emptyMenu(pt, at);
  }

  // ---------------------------------------------------------------- events

  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('pointerdown', (e) => {
    // Native scrollbars keep working.
    const box = el.getBoundingClientRect();
    if (e.clientX - box.left >= el.clientWidth || e.clientY - box.top >= el.clientHeight) return;
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        V.cancelGesture();
        startPinch();
        return;
      }
      if (touches.size > 2) return;
    }
    if (gesture) return;
    el.focus({ preventScroll: true });
    e.preventDefault();
    downAt = { x: e.clientX, y: e.clientY };
    lastEvent = e;
    const g = start(e);
    if (!g) {
      downAt = null;
      return;
    }
    gesture = g;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already released pointers cannot be captured.
    }
    if (e.pointerType === 'touch') {
      longPress = setTimeout(() => {
        if (!gesture || moved(lastEvent)) return;
        V.cancelGesture();
        const pt = V.point(lastEvent);
        openContext(lastEvent, pt, V.hit(pt));
      }, LONG_PRESS_MS);
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) {
      movePinch();
      return;
    }
    if (!gesture) {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') hover(e);
      return;
    }
    lastEvent = e;
    if (longPress && moved(e)) {
      clearTimeout(longPress);
      longPress = null;
    }
    gesture.move(V.point(e), e);
    edgeScroll(e);
  });

  const finish = (e) => {
    touches.delete(e.pointerId);
    if (pinch) {
      if (touches.size < 2) pinch = null;
      return;
    }
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    g.up(V.point(e), e);
    endGesture();
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', (e) => {
    touches.delete(e.pointerId);
    if (pinch && touches.size < 2) pinch = null;
    if (gesture) V.cancelGesture();
  });
  el.addEventListener('lostpointercapture', (e) => {
    if (gesture && e.pointerType !== 'touch') finish(e);
  });

  el.addEventListener('pointerleave', () => {
    if (!gesture && V.hoverPoint) {
      V.hoverPoint = null;
      V.markDirty();
    }
  });

  el.addEventListener('dblclick', (e) => {
    const pt = V.point(e);
    const hit = V.hit(pt);
    if (hit?.clip && !hit.auto) V.openClip(hit.clip);
  });

  // Keeps a drag going past the canvas edges by scrolling.
  function edgeScroll(e) {
    const r = el.getBoundingClientRect();
    const dx = e.clientX < r.left + 16 ? -1 : e.clientX > r.left + el.clientWidth - 16 ? 1 : 0;
    const dy = e.clientY < r.top + 12 ? -1 : e.clientY > r.top + el.clientHeight - 12 ? 1 : 0;
    clearInterval(edgeTimer);
    edgeTimer = null;
    if ((!dx && !dy) || !gesture || V.tool() === 'playback') return;
    edgeTimer = setInterval(() => {
      if (!gesture) return;
      V.scrollBy(dx * 14, dy * 10);
      gesture.move(V.point(lastEvent), lastEvent);
    }, 30);
  }

  // ---------------------------------------------------------------- hover

  const CURSORS = { draw: 'crosshair', paint: 'crosshair', delete: 'not-allowed', mute: 'pointer', slice: 'text', select: 'default', zoom: 'zoom-in', playback: 'pointer' };
  function hover(e) {
    const pt = V.point(e);
    const hit = V.hit(pt);
    const tool = V.tool();
    let cursor = CURSORS[tool];
    let hint = '';
    let hp = null;
    if (hit?.auto && ['draw', 'paint', 'select'].includes(tool) && (hit.auto.index >= 0 || hit.auto.onLine || tool === 'draw')) {
      if (hit.auto.index >= 0) {
        hp = { clip: hit.clip.id, index: hit.auto.index };
        cursor = 'move';
        hint = 'Drag the point (time snaps, Alt for free time). Right-click deletes it.';
      } else {
        cursor = 'copy';
        hint = 'Click to add an automation point and drag it.';
      }
    } else if (hit && ['draw', 'paint', 'select'].includes(tool)) {
      if (hit.zone !== 'body') {
        cursor = 'ew-resize';
        hint = hit.zone === 'left' ? 'Drag to trim the start of the clip.' : 'Drag to change the clip length.';
      } else if (tool !== 'paint') {
        cursor = 'grab';
        hint = `Drag to move, Shift+drag to duplicate, Alt to bypass snap. Double-click opens. ${tool === 'draw' ? 'Right-click deletes, Shift+right-click for options.' : 'Right-click for options.'}`;
      }
    } else if (tool === 'draw') hint = 'Click to place the selected source, drag right to set its length. Right-click deletes.';
    else if (tool === 'paint') hint = 'Drag to paint copies of the selected source. Right-click deletes.';
    else if (tool === 'select') hint = 'Drag to select clips. Ctrl or Cmd+drag selects with any tool.';
    if (tool === 'delete') hint = 'Click or drag over clips to delete them.';
    else if (tool === 'mute') hint = 'Click or drag over clips to mute or unmute them.';
    else if (tool === 'slice') hint = 'Click to cut clips at the pointer; drag up or down to cut several tracks.';
    else if (tool === 'zoom') hint = 'Click to zoom in, Alt+click to zoom out, drag to zoom to a range.';
    else if (tool === 'playback') hint = 'Press and hold to play from the pointer; drag to scrub.';
    if (el.style.cursor !== cursor) el.style.cursor = cursor;
    app.hint(hint);
    const prev = V.hoverPoint;
    if ((prev?.clip !== hp?.clip) || (prev?.index !== hp?.index)) {
      V.hoverPoint = hp;
      V.markDirty();
    }
  }

  // ---------------------------------------------------------------- pinch and pan (touch)

  function startPinch() {
    const [a, b] = [...touches.values()];
    const r = el.getBoundingClientRect();
    const mid = (a.x + b.x) / 2 - r.left;
    pinch = {
      dist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      ppt: V.vp.pxPerTick,
      tick: V.vp.tick(mid),
      midY: (a.y + b.y) / 2,
      top: V.scrollY,
    };
  }

  function movePinch() {
    if (touches.size < 2) return;
    const [a, b] = [...touches.values()];
    const r = el.getBoundingClientRect();
    const mid = (a.x + b.x) / 2 - r.left;
    const dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
    const vp = V.vp;
    vp.pxPerTick = clamp(pinch.ppt * (dist / pinch.dist), vp.minPx, vp.maxPx);
    vp.scroll = Math.max(0, pinch.tick - mid / vp.pxPerTick);
    V.setScroll(vp.scroll, pinch.top - ((a.y + b.y) / 2 - pinch.midY));
  }
}
