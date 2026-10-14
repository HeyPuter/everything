// Pointer, wheel and touch handling for the piano roll surface. Each drag is
// a gesture object { type, move(e, p), end(e, p), cancel() } created on
// pointer down; edits run as store.begin / preview / commit so a gesture is
// one undo step, and previews always compute from the gesture's start state.
//
// Draw tool: click empty space to add a note (drag right sets its length),
// drag a note to move it, its edges to resize (every selected note together),
// Shift+drag to duplicate, Mod+drag on empty space to select. Right-click (or
// right-drag) deletes. Alt while dragging turns snapping off.
// Paint paints repeated notes, Delete erases, Slice cuts at the pointer,
// Select draws a marquee (Shift adds), Zoom drags a range to fit (click zooms
// in, Alt+click out), Audition plays the rows under the pointer.
// Wheel scrolls (Shift for time), Mod+wheel zooms time at the pointer,
// Alt+wheel zooms the keys; two fingers pan and pinch on touch screens;
// the middle button drags the view.

import { announce } from '../lib/dom.js';
import { clamp, keyName, uid, IS_MAC } from '../lib/util.js';
import { snapFloor, snapRound } from '../model/time.js';
import { regionAt, keyAtY, describeNote, describePos } from './geometry.js';
import * as N from './notes.js';
import { shared } from './state.js';
import { openNoteProps } from './dialogs.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const DRAG_PX = 3;

export function installPointer(ed) {
  const el = ed.surface;
  const store = ed.store;
  const app = ed.app;
  const touches = new Map(); // pointerId -> { x, y }
  let lastCreated = { id: null, at: 0 };

  const local = (e) => {
    const r = el.getBoundingClientRect();
    ed.rect = r;
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const tickAt = (x) => ed.vp.tick(x - ed.L.gridX);
  const keyAt = (y) => keyAtY(ed.L, y, ed.keyH, ed.scrollY);
  const edgePx = () => (ed.coarse ? 10 : 6);
  const modKey = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);
  const isRight = (e) => e.button === 2 || (IS_MAC && e.button === 0 && e.ctrlKey && !e.metaKey);

  /** The note under a grid point and which part of it ('left' | 'right' | 'body'). */
  function hitNote(p, notes = ed.notes) {
    const key = keyAt(p.y);
    const tick = tickAt(p.x);
    let n = N.noteAt(notes, tick, key);
    if (!n) {
      // Tiny notes: accept a few pixels around them.
      const slack = 3 / ed.vp.pxPerTick;
      n = N.noteAt(notes, tick - slack, key) || N.noteAt(notes, tick + slack, key);
    }
    if (!n) return null;
    const x0 = ed.L.gridX + ed.vp.x(n.pos);
    const x1 = ed.L.gridX + ed.vp.x(n.pos + n.len);
    return { note: n, zone: N.hitZone(p.x, x0, Math.max(x1, x0 + 3), edgePx()) };
  }

  function begin(label) {
    store.begin(label);
  }

  function finish(g) {
    ed.gesture = null;
    ed.overlay.marquee = null;
    ed.overlay.zoom = null;
    if (g?.type !== 'slice' || ed.tool !== 'slice') ed.overlay.slice = null;
    ed.dirty = true;
    ed.toolbar?.sync();
  }

  // ---------------------------------------------------------------- gestures

  function moveGesture(e, p, hit, dup) {
    const note = hit.note;
    const additive = e.shiftKey || modKey(e);
    if (!ed.selected.has(note.id) && !dup) ed.selectOnly(note.id);
    const ids = new Set(ed.selected.has(note.id) ? ed.selIds() : [note.id]);
    const t0 = tickAt(p.x);
    const k0 = keyAt(p.y);
    let moved = false;
    let lastKey = note.key;
    let copies = null;
    let dragged = { dPos: 0, dKey: 0 };
    ed.audition(note.key, note.vel);
    begin(dup ? 'Duplicate notes' : 'Move notes');
    return {
      type: 'move',
      move(ev, q) {
        if (!moved && Math.abs(q.x - p.x) < DRAG_PX && Math.abs(q.y - p.y) < DRAG_PX) return;
        moved = true;
        const grid = ed.gridFor(ev);
        const raw = tickAt(q.x) - t0;
        const dPos = grid ? snapRound(raw, grid) : Math.round(raw);
        const dKey = keyAt(q.y) - k0;
        ed.previewNotes((list) => {
          const c = N.clampMove(list, ids, dPos, dKey);
          dragged = c;
          if (dup) {
            const r = N.duplicateNotes(list, ids, c.dPos, c.dKey);
            copies = r.ids;
            return r.notes;
          }
          return N.moveNotes(list, ids, c.dPos, c.dKey);
        });
        const k = note.key + dragged.dKey;
        if (k !== lastKey) {
          lastKey = k;
          ed.audition(k, note.vel);
        }
        ed.hintAt(k, note.pos + dragged.dPos);
      },
      end() {
        ed.stopAudition();
        store.commit();
        if (!moved) {
          if (additive && dup) {
            // Shift+click toggles the note in the selection.
            const next = new Set(ed.selected);
            if (next.has(note.id)) next.delete(note.id);
            else next.add(note.id);
            ed.select(next, { announceIt: true });
          } else if (!ed.selected.has(note.id)) ed.selectOnly(note.id);
          ed.remember(note);
          announce(`${describeNote(note, ed.sig)}, velocity ${Math.round(note.vel * 100)}%`);
          return;
        }
        if (dup && copies) ed.select(copies);
        const count = ids.size;
        const what = count === 1 ? keyName(note.key + dragged.dKey) : plural(count, 'note');
        announce(`${what} ${dup ? 'duplicated' : 'moved'} to ${describePos(note.pos + dragged.dPos, ed.sig)}`);
      },
      cancel() {
        ed.stopAudition();
        store.cancel();
      },
    };
  }

  function resizeGesture(e, p, hit) {
    const note = hit.note;
    if (!ed.selected.has(note.id)) ed.selectOnly(note.id);
    const ids = new Set(ed.selIds());
    const t0 = tickAt(p.x);
    const left = hit.zone === 'left';
    let result = note;
    begin(left ? 'Move note starts' : 'Resize notes');
    return {
      type: 'resize',
      move(ev, q) {
        const grid = ed.gridFor(ev);
        const raw = tickAt(q.x) - t0;
        const minLen = grid || 1;
        if (left) {
          const ns = grid ? snapRound(note.pos + raw, grid) : Math.round(note.pos + raw);
          const d = ns - note.pos;
          ed.previewNotes((list) => N.resizeStart(list, ids, d, minLen));
        } else {
          const end = note.pos + note.len;
          const ne = grid ? snapRound(end + raw, grid) : Math.round(end + raw);
          ed.previewNotes((list) => N.resizeNotes(list, ids, ne - end, minLen));
        }
        result = ed.noteById(note.id) || note;
        ed.hintAt(result.key, left ? result.pos : result.pos + result.len);
      },
      end() {
        store.commit();
        if (result !== note) {
          ed.remember(result);
          announce(`${ids.size === 1 ? keyName(note.key) : plural(ids.size, 'note')} ${left ? `starts at ${describePos(result.pos, ed.sig)}` : describeNote(result, ed.sig).split(', ')[1]}`);
        }
      },
      cancel() {
        store.cancel();
      },
    };
  }

  function addGesture(e, p) {
    const grid = ed.gridFor(e);
    const t = tickAt(p.x);
    const key = keyAt(p.y);
    const pos = Math.max(0, grid ? snapFloor(t, grid) : Math.round(t));
    const last = ed.lastNote;
    let len = last.len;
    const keys = ed.stampKeys(key);
    const ids = keys.map(() => uid(6));
    const make = () => keys.map((k, i) => ({ id: ids[i], key: k, pos, len, vel: last.vel, pan: 0 }));
    ed.select([]);
    begin(keys.length > 1 ? 'Add chord' : 'Add note');
    ed.previewNotes((list) => [...list, ...make()]);
    ed.audition(keys, last.vel);
    let sized = false;
    return {
      type: 'add',
      move(ev, q) {
        if (!sized && Math.abs(q.x - p.x) < DRAG_PX) return;
        sized = true;
        const g = ed.gridFor(ev);
        const raw = tickAt(q.x) - pos;
        len = Math.max(g || 1, g ? snapRound(raw, g) : Math.round(raw));
        ed.previewNotes((list) => [...list, ...make()]);
        ed.hintAt(key, pos + len);
      },
      end() {
        ed.stopAudition();
        store.commit();
        if (sized) shared.last = { len, vel: last.vel };
        lastCreated = { id: ids[0], at: performance.now() };
        ed.cursor.tick = pos;
        ed.cursor.key = key;
        const n = { key, pos, len };
        announce(keys.length > 1 ? `Chord added at ${describePos(pos, ed.sig)}` : `${keyName(key)} added at ${describePos(pos, ed.sig)}, ${describeNote(n, ed.sig).split(', ')[1]}`);
      },
      cancel() {
        ed.stopAudition();
        store.cancel();
      },
    };
  }

  function paintGesture(e, p) {
    const grid = ed.gridFor(e);
    const last = ed.lastNote;
    const step = Math.max(1, last.len);
    const t = tickAt(p.x);
    const origin = Math.max(0, grid ? snapFloor(t, grid) : Math.round(t));
    const base = ed.notes;
    const taken = new Set(base.map((n) => `${n.pos}:${n.key}`));
    const cells = new Map(); // cell index -> note(s)
    ed.select([]);
    begin('Paint notes');
    let lastCell = null;
    const paintAt = (q) => {
      const target = Math.floor((tickAt(q.x) - origin) / step);
      const key = keyAt(q.y);
      // Fill every cell between the last one and this one so fast drags leave no gaps.
      const start = lastCell === null ? target : lastCell;
      const dir = target >= start ? 1 : -1;
      let added = null;
      for (let c = start; ; c += dir) {
        const pos = origin + c * step;
        if (!cells.has(c) && pos >= 0) {
          const keys = ed.stampKeys(key).filter((k) => !taken.has(`${pos}:${k}`));
          cells.set(c, keys.map((k) => ({ id: uid(6), key: k, pos, len: last.len, vel: last.vel, pan: 0 })));
          added = keys;
        }
        if (c === target) break;
      }
      lastCell = target;
      if (!added) return;
      ed.previewNotes((list) => [...list, ...[...cells.values()].flat()]);
      if (added.length) ed.audition(added, last.vel, { hold: false });
      ed.hintAt(key, origin + target * step);
    };
    paintAt(p);
    return {
      type: 'paint',
      move(ev, q) {
        paintAt(q);
      },
      end() {
        store.commit();
        const count = [...cells.values()].flat().length;
        if (count) announce(`${plural(count, 'note')} painted`);
      },
      cancel() {
        store.cancel();
      },
    };
  }

  function eraseGesture(e, p) {
    const base = ed.notes;
    const gone = new Set();
    let lastP = p;
    begin('Delete notes');
    const eraseAt = (q) => {
      const dx = q.x - lastP.x;
      const dy = q.y - lastP.y;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 4));
      let changed = false;
      for (let s = 1; s <= steps; s++) {
        const pt = { x: lastP.x + (dx * s) / steps, y: lastP.y + (dy * s) / steps };
        const hit = hitNote(pt, base);
        if (hit && !gone.has(hit.note.id)) {
          gone.add(hit.note.id);
          changed = true;
        }
      }
      lastP = q;
      if (changed) ed.previewNotes((list) => list.filter((n) => !gone.has(n.id)));
    };
    const first = hitNote(p, base);
    if (first) {
      gone.add(first.note.id);
      ed.previewNotes((list) => list.filter((n) => !gone.has(n.id)));
    }
    return {
      type: 'erase',
      move(ev, q) {
        eraseAt(q);
      },
      end() {
        store.commit();
        if (gone.size) {
          for (const id of gone) ed.selected.delete(id);
          announce(`${plural(gone.size, 'note')} deleted`);
        }
      },
      cancel() {
        store.cancel();
      },
    };
  }

  function marqueeGesture(e, p) {
    const additive = e.shiftKey;
    const baseSel = additive ? new Set(ed.selected) : new Set();
    const t0 = tickAt(p.x);
    const k0 = keyAt(p.y);
    let moved = false;
    if (!additive) ed.select([]);
    return {
      type: 'marquee',
      move(ev, q) {
        if (!moved && Math.abs(q.x - p.x) < DRAG_PX && Math.abs(q.y - p.y) < DRAG_PX) return;
        moved = true;
        const t1 = tickAt(q.x);
        const k1 = keyAt(q.y);
        ed.overlay.marquee = { t0, t1, k0, k1 };
        const ids = N.notesInRect(ed.notes, t0, t1, k0, k1);
        ed.select([...baseSel, ...ids]);
      },
      end() {
        if (moved) announce(ed.selected.size ? `${plural(ed.selected.size, 'note')} selected` : 'No notes selected');
        else {
          ed.cursor.tick = Math.max(0, ed.gridTicks ? snapFloor(t0, ed.gridTicks) : Math.round(t0));
          ed.cursor.key = k0;
        }
      },
      cancel() {
        ed.select([...baseSel]);
      },
    };
  }

  function sliceGesture(e, p) {
    const k0 = keyAt(p.y);
    const snapTick = (ev, q) => {
      const g = ed.gridFor(ev);
      const t = tickAt(q.x);
      return g ? snapRound(t, g) : Math.round(t);
    };
    ed.overlay.slice = { tick: snapTick(e, p), k0, k1: k0 };
    return {
      type: 'slice',
      move(ev, q) {
        ed.overlay.slice = { tick: snapTick(ev, q), k0, k1: keyAt(q.y) };
      },
      end() {
        const s = ed.overlay.slice;
        const lo = Math.min(s.k0, s.k1);
        const hi = Math.max(s.k0, s.k1);
        let count = 0;
        ed.applyNotes('Slice notes', (list) => {
          const r = N.sliceNotes(list, s.tick, (n) => n.key >= lo && n.key <= hi);
          count = r.ids.length;
          return r.notes;
        });
        ed.overlay.slice = { tick: s.tick, k0: null, k1: null };
        announce(count ? `${plural(count, 'note')} sliced at ${describePos(s.tick, ed.sig)}` : 'No note to slice there');
      },
      cancel() {
        ed.overlay.slice = null;
      },
    };
  }

  function zoomGesture(e, p) {
    const t0 = tickAt(p.x);
    const out = e.altKey || isRight(e);
    let moved = false;
    return {
      type: 'zoom',
      move(ev, q) {
        if (!moved && Math.abs(q.x - p.x) < 6) return;
        moved = true;
        ed.overlay.zoom = { t0, t1: tickAt(q.x) };
      },
      end(ev, q) {
        if (moved) {
          const t1 = tickAt(q.x);
          ed.vp.fit(Math.max(0, Math.min(t0, t1)), Math.max(t0, t1));
          ed.dirty = true;
        } else ed.zoomTime(out ? 1 / 1.6 : 1.6, p.x - ed.L.gridX);
      },
      cancel() {},
    };
  }

  function auditionGesture(e, p) {
    let key = keyAt(p.y);
    const hit = hitNote(p);
    ed.audition(key, hit ? hit.note.vel : ed.lastNote.vel);
    return {
      type: 'audition',
      move(ev, q) {
        const k = keyAt(q.y);
        if (k !== key) {
          key = k;
          const h2 = hitNote(q);
          ed.audition(k, h2 ? h2.note.vel : ed.lastNote.vel);
        }
      },
      end() {
        ed.stopAudition();
      },
      cancel() {
        ed.stopAudition();
      },
    };
  }

  /** Clicking or dragging across the keyboard column plays keys (live input: records and step-edits too). */
  function keysGesture(e, p) {
    const live = app.liveInput;
    const velAt = (q) => clamp(0.35 + (0.65 * q.x) / ed.L.keysW, 0.1, 1);
    let key = keyAt(p.y);
    const on = (k, q) => (live ? live.noteOn(k, velAt(q), 'ui') : ed.audition(k, velAt(q)));
    const off = (k) => (live ? live.noteOff(k, 'ui') : ed.stopAudition());
    on(key, p);
    announce(keyName(key));
    return {
      type: 'keys',
      move(ev, q) {
        const k = keyAt(q.y);
        if (k === key) return;
        off(key);
        key = k;
        on(k, q);
      },
      end() {
        off(key);
      },
      cancel() {
        off(key);
      },
    };
  }

  function seekGesture(e, p) {
    const seek = (q, ev) => {
      if (app.engine.mode !== 'pattern') {
        app.hint('Switch to pattern mode (L) to move the playhead in the piano roll');
        return;
      }
      const g = ed.gridFor(ev);
      const t = Math.max(0, tickAt(q.x));
      app.engine.seek(g ? snapFloor(t, g) : t);
      ed.dirty = true;
    };
    seek(p, e);
    return {
      type: 'seek',
      move(ev, q) {
        seek(q, ev);
      },
      end() {
        if (app.engine.mode === 'pattern') announce(`Playhead at ${describePos(app.engine.position, ed.sig)}`);
      },
      cancel() {},
    };
  }

  function laneGesture(e, p) {
    const pan = ed.laneType === 'pan';
    const L = ed.L;
    const top = L.laneY + 4;
    const hh = L.laneH - 8;
    const valueAt = (y) => {
      const f = clamp((y - top) / hh, 0, 1);
      return Math.round((pan ? (0.5 - f) * 2 : 1 - f) * 100) / 100;
    };
    const base = ed.notes;
    const targets = ed.selected.size ? new Set(ed.selIds()) : null;
    const changes = new Map();
    const field = pan ? 'pan' : 'vel';
    let last = { x: p.x, v: valueAt(p.y) };
    begin(pan ? 'Change pan' : 'Change velocity');
    const setRange = (x0, v0, x1, v1) => {
      const a = Math.min(x0, x1) - 3;
      const b = Math.max(x0, x1) + 3;
      for (let i = N.firstVisible(base, tickAt(a)); i < base.length; i++) {
        const n = base[i];
        const nx = L.gridX + ed.vp.x(n.pos);
        if (nx > b) break;
        if (nx < a) continue;
        if (targets && !targets.has(n.id)) continue;
        const f = x1 === x0 ? 1 : clamp((nx - x0) / (x1 - x0), 0, 1);
        let v = v0 + (v1 - v0) * f;
        v = pan ? clamp(v, -1, 1) : clamp(v, 0.01, 1);
        changes.set(n.id, { [field]: Math.round(v * 100) / 100 });
      }
      ed.previewNotes((list) => N.patchNotes(list, changes));
    };
    setRange(p.x, last.v, p.x, last.v);
    return {
      type: 'lane',
      move(ev, q) {
        const v = valueAt(q.y);
        setRange(last.x, last.v, q.x, v);
        last = { x: q.x, v };
        app.hint(`${pan ? 'Pan' : 'Velocity'} ${Math.round(v * 100)}%`);
      },
      end() {
        store.commit();
        if (changes.size) {
          const v = last.v;
          announce(`${pan ? 'Pan' : 'Velocity'} set to ${Math.round(v * 100)}% on ${plural(changes.size, 'note')}`);
          if (!pan) shared.last = { ...ed.lastNote, vel: clamp(v, 0.01, 1) };
        }
      },
      cancel() {
        store.cancel();
      },
    };
  }

  function splitGesture(e, p) {
    const h0 = ed.L.laneH;
    return {
      type: 'split',
      move(ev, q) {
        const laneH = clamp(h0 - (q.y - p.y), 32, Math.max(40, ed.L.h * 0.6));
        ed.laneHLive = laneH;
        ed.dirty = true;
      },
      end() {
        const laneH = ed.laneHLive;
        ed.laneHLive = null;
        if (laneH) ed.setPref({ laneH: Math.round(laneH) });
      },
      cancel() {
        ed.laneHLive = null;
      },
    };
  }

  function hscrollGesture(e, p) {
    const s = ed.scrollMetrics();
    const L = ed.L;
    const x = p.x - L.gridX;
    const onThumb = x >= s.hx && x <= s.hx + s.hw;
    const range = Math.max(1, L.gridW - s.hw);
    const ticksPerPx = Math.max(0, s.total - s.visible) / range;
    if (!onThumb) {
      ed.vp.scrollTo(Math.max(0, ed.vp.scroll + Math.sign(x - s.hx) * s.visible * 0.9));
      ed.dirty = true;
    }
    const s0 = ed.vp.scroll;
    return {
      type: 'hscroll',
      move(ev, q) {
        ed.vp.scrollTo(Math.max(0, s0 + (q.x - p.x) * ticksPerPx));
        ed.dirty = true;
      },
      end() {},
      cancel() {},
    };
  }

  function vscrollGesture(e, p) {
    const s = ed.scrollMetrics();
    const L = ed.L;
    const y = p.y - L.gridY;
    const onThumb = y >= s.vy && y <= s.vy + s.vh;
    const range = Math.max(1, L.gridH - s.vh);
    if (!onThumb) {
      ed.scrollY += Math.sign(y - s.vy) * L.gridH * 0.9;
      ed.clampScroll();
      ed.dirty = true;
    }
    const y0 = ed.scrollY;
    return {
      type: 'vscroll',
      move(ev, q) {
        ed.scrollY = y0 + ((q.y - p.y) * s.maxY) / range;
        ed.clampScroll();
        ed.dirty = true;
      },
      end() {},
      cancel() {},
    };
  }

  function panGesture(e, p) {
    const s0 = ed.vp.scroll;
    const y0 = ed.scrollY;
    return {
      type: 'pan',
      move(ev, q) {
        ed.vp.scrollTo(Math.max(0, s0 - (q.x - p.x) / ed.vp.pxPerTick));
        ed.scrollY = y0 - (q.y - p.y);
        ed.clampScroll();
        ed.dirty = true;
      },
      end() {},
      cancel() {},
    };
  }

  function pinchGesture() {
    const [a, b] = [...touches.values()];
    const L = ed.L;
    const mid0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dx0 = Math.abs(a.x - b.x);
    const dy0 = Math.abs(a.y - b.y);
    const px0 = ed.vp.pxPerTick;
    const kh0 = ed.keyH;
    const tickMid = ed.vp.tick(mid0.x - L.gridX);
    const rowMid = (mid0.y - L.gridY + ed.scrollY) / kh0;
    return {
      type: 'pinch',
      move() {
        const [c, d] = [...touches.values()];
        if (!c || !d) return;
        const mid = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
        const fx = dx0 > 40 ? Math.abs(c.x - d.x) / dx0 : 1;
        const fy = dy0 > 40 ? Math.abs(c.y - d.y) / dy0 : 1;
        ed.vp.pxPerTick = clamp(px0 * fx, ed.vp.minPx, ed.vp.maxPx);
        ed.vp.scroll = Math.max(0, tickMid - (mid.x - L.gridX) / ed.vp.pxPerTick);
        ed.keyH = clamp(kh0 * fy, 5, 40);
        ed.scrollY = rowMid * ed.keyH - (mid.y - L.gridY);
        ed.clampScroll();
        ed.dirty = true;
      },
      end() {
        ed.setPref({ keyH: Math.round(ed.keyH * 10) / 10 });
        ed.toolbar?.sync();
      },
      cancel() {},
    };
  }

  // ---------------------------------------------------------------- dispatch

  function gridGesture(e, p) {
    const tool = ed.tool;
    const right = isRight(e);
    if (right && tool !== 'zoom') return eraseGesture(e, p);
    const hit = hitNote(p);
    if (tool === 'zoom') return zoomGesture(e, p);
    if (tool === 'audition') return auditionGesture(e, p);
    if (tool === 'delete') return eraseGesture(e, p);
    if (tool === 'slice') return sliceGesture(e, p);
    if (tool === 'select') {
      if (hit) {
        if (e.shiftKey || modKey(e)) {
          const next = new Set(ed.selected);
          if (next.has(hit.note.id)) next.delete(hit.note.id);
          else next.add(hit.note.id);
          ed.select(next);
          return null;
        }
        return hit.zone === 'body' ? moveGesture(e, p, hit, false) : resizeGesture(e, p, hit);
      }
      return marqueeGesture(e, p);
    }
    // Draw and paint.
    if (hit) {
      if (hit.zone !== 'body' && !e.shiftKey) return resizeGesture(e, p, hit);
      return moveGesture(e, p, hit, e.shiftKey);
    }
    if (modKey(e) || (e.shiftKey && tool === 'draw' && e.pointerType !== 'touch')) return marqueeGesture(e, p);
    return tool === 'paint' ? paintGesture(e, p) : addGesture(e, p);
  }

  el.addEventListener('pointerdown', (e) => {
    const p = local(e);
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, p);
      if (touches.size === 2) {
        ed.gesture?.cancel?.();
        ed.gesture = pinchGesture();
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (touches.size > 2) return;
    }
    if (ed.gesture) return;
    if (e.button === 1) {
      e.preventDefault();
      ed.gesture = panGesture(e, p);
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button > 2) return;
    el.focus({ preventScroll: true });
    ed.showCursor = false;
    const region = regionAt(ed.L, p.x, p.y);
    let g = null;
    if (region === 'grid') g = gridGesture(e, p);
    else if (region === 'keys') g = isRight(e) ? null : keysGesture(e, p);
    else if (region === 'ruler') g = seekGesture(e, p);
    else if (region === 'lane') g = isRight(e) ? null : laneGesture(e, p);
    else if (region === 'laneLabel') {
      ed.setPref({ laneType: ed.laneType === 'pan' ? 'vel' : 'pan' });
      announce(`Event lane shows ${ed.laneType === 'pan' ? 'pan' : 'velocity'}`);
    } else if (region === 'split') g = splitGesture(e, p);
    else if (region === 'hscroll') g = hscrollGesture(e, p);
    else if (region === 'vscroll') g = vscrollGesture(e, p);
    ed.dirty = true;
    if (!g) return;
    e.preventDefault();
    ed.gesture = g;
    ed.overlay.phantom = null;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events in tests have no active pointer.
    }
  });

  el.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, p);
    if (ed.gesture) {
      if (ed.gesture.type === 'pinch' && e.pointerType !== 'touch') return;
      ed.gesture.move(e, p);
      ed.dirty = true;
      return;
    }
    updateHover(e, p);
  });

  const up = (e, cancelled) => {
    const wasTouch = e.pointerType === 'touch' && touches.has(e.pointerId);
    if (wasTouch) touches.delete(e.pointerId);
    const g = ed.gesture;
    if (!g) return;
    if (g.type === 'pinch') {
      if (touches.size < 2) {
        g.end();
        finish(g);
      }
      return;
    }
    const p = local(e);
    if (cancelled) g.cancel();
    else g.end(e, p);
    finish(g);
  };
  el.addEventListener('pointerup', (e) => up(e, false));
  el.addEventListener('pointercancel', (e) => up(e, true));
  el.addEventListener('lostpointercapture', (e) => {
    if (ed.gesture && e.pointerType !== 'touch') up(e, false);
  });
  el.addEventListener('pointerleave', () => {
    if (ed.gesture) return;
    ed.hover = null;
    ed.overlay.phantom = null;
    if (ed.tool === 'slice') ed.overlay.slice = null;
    ed.dirty = true;
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('dblclick', (e) => {
    const p = local(e);
    if (regionAt(ed.L, p.x, p.y) !== 'grid') return;
    const hit = hitNote(p);
    if (!hit) return;
    if (hit.note.id === lastCreated.id && performance.now() - lastCreated.at < 600) return;
    ed.selectOnly(hit.note.id);
    openNoteProps(ed, hit.note);
  });

  // ---------------------------------------------------------------- hover

  function updateHover(e, p) {
    const region = regionAt(ed.L, p.x, p.y);
    const prev = ed.hover;
    let next = { region, key: -1, note: null, zone: null };
    let cursor = 'default';
    ed.overlay.phantom = null;
    if (region === 'grid' || region === 'keys') {
      next.key = keyAt(p.y);
      const tick = tickAt(p.x);
      if (region === 'keys') {
        cursor = 'pointer';
        app.hint(`${keyName(next.key)}: click or drag across the keys to play`);
      } else {
        const hit = hitNote(p);
        const tool = ed.tool;
        next.note = hit?.note.id || null;
        next.zone = hit?.zone || null;
        ed.hintAt(next.key, tick);
        if (tool === 'slice') {
          const g = ed.gridFor(e);
          ed.overlay.slice = { tick: g ? snapRound(tick, g) : Math.round(tick), k0: null, k1: null };
          cursor = 'col-resize';
        } else if (hit && (tool === 'draw' || tool === 'paint' || tool === 'select')) {
          cursor = hit.zone === 'body' ? (e.shiftKey && tool !== 'select' ? 'copy' : 'move') : 'ew-resize';
        } else if (!hit && (tool === 'draw' || tool === 'paint') && !modKey(e)) {
          const g = ed.gridFor(e);
          const pos = Math.max(0, g ? snapFloor(tick, g) : Math.round(tick));
          ed.overlay.phantom = { pos, len: ed.lastNote.len, keys: ed.stampKeys(next.key) };
          cursor = 'crosshair';
        } else if (tool === 'delete') cursor = hit ? 'pointer' : 'default';
        else if (tool === 'zoom') cursor = e.altKey ? 'zoom-out' : 'zoom-in';
        else if (tool === 'audition') cursor = 'pointer';
        else if (tool === 'select') cursor = 'crosshair';
      }
    } else if (region === 'ruler') {
      cursor = 'pointer';
      app.hint(app.engine.mode === 'pattern' ? 'Click or drag to move the playhead' : 'Switch to pattern mode (L) to move the playhead here');
    } else if (region === 'lane') {
      cursor = 'crosshair';
      app.hint(`Drag to draw ${ed.laneType === 'pan' ? 'pan' : 'velocity'} (selected notes only when there is a selection)`);
    } else if (region === 'laneLabel') {
      cursor = 'pointer';
      app.hint(`Click to show ${ed.laneType === 'pan' ? 'velocity' : 'pan'} in the event lane`);
    } else if (region === 'split') cursor = 'row-resize';
    ed.updateCursorStyle(cursor);
    if (!prev || prev.region !== next.region || prev.key !== next.key || prev.note !== next.note || prev.zone !== next.zone || ed.overlay.phantom || ed.overlay.slice) ed.dirty = true;
    ed.hover = next;
  }

  // ---------------------------------------------------------------- wheel

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
      } else if (e.deltaMode === 2) {
        dx *= ed.L.gridW;
        dy *= ed.L.gridH;
      }
      const region = regionAt(ed.L, p.x, p.y);
      const zoomMod = e.ctrlKey || e.metaKey; // trackpad pinch arrives as Ctrl+wheel
      if (zoomMod && region === 'keys') ed.zoomKeys(Math.exp(-dy * 0.0025), p.y);
      else if (zoomMod) ed.zoomTime(Math.exp(-dy * 0.0025), clamp(p.x - ed.L.gridX, 0, ed.L.gridW));
      else if (e.altKey) ed.zoomKeys(Math.exp(-(dy || dx) * 0.0025), p.y);
      else if (e.shiftKey) ed.vp.scrollBy(dx || dy);
      else {
        ed.scrollY += dy;
        ed.vp.scrollBy(dx);
        ed.clampScroll();
      }
      ed.clampScroll();
      ed.dirty = true;
    },
    { passive: false },
  );

  return { hitNote };
}

