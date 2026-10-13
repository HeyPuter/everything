/**
 * Timeline organizing actions: enabling and disabling clips, groups, color
 * labels, selecting by side of the playhead, the in/out range, markers,
 * track management, copying attributes between clips and keyframe easing.
 * Mixed into the main actions object (see actions.js).
 */
import { US, timecode } from '../lib/time.js';
import { uid } from '../lib/ids.js';
import { announce, h } from '../lib/dom.js';
import { CLIP_LABELS, MARKER_COLORS } from '../model/project.js';
import * as T from '../model/timeline.js';
import { openDialog, confirmDialog, promptDialog, toast } from './dialog.js';
import { prefs, setPref } from './prefs.js';
import { createCompound, breakApart } from '../model/compound.js';

export const LABEL_NAMES = { red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', teal: 'Teal', blue: 'Blue', purple: 'Purple', pink: 'Pink' };
export const LABEL_COLORS = { red: '#e5484d', orange: '#f08c3a', yellow: '#e8c547', green: '#46a758', teal: '#2bb3a3', blue: '#3e7ee8', purple: '#8e5ce8', pink: '#e45ca6' };

export const EASE_LABELS = { linear: 'Linear', easeIn: 'Ease in', easeOut: 'Ease out', easeInOut: 'Ease in and out', smooth: 'Smooth', overshoot: 'Overshoot', anticipate: 'Wind up', elastic: 'Elastic', bounce: 'Bounce', hold: 'Hold' };

/** Readable name of any ease, custom curves included. */
export const easeLabel = (name) => EASE_LABELS[name] || (String(name).startsWith('cubic(') ? 'Custom curve' : 'Linear');

/**
 * Attribute groups that can be copied from one clip and pasted onto others.
 * keys: clip fields copied as a whole; kf: keyframe props that go with them.
 */
export const ATTRIBUTE_GROUPS = [
  { id: 'transform', label: 'Position, scale and rotation', keys: ['transform'], kf: ['x', 'y', 'scale', 'rotation', 'sx', 'sy'], types: ['video', 'image', 'text', 'sticker', 'avatar'] },
  { id: 'opacity', label: 'Opacity and blend mode', keys: ['opacity', 'blend'], kf: ['opacity'], types: ['video', 'image', 'text', 'sticker', 'avatar'] },
  { id: 'crop', label: 'Crop', keys: ['crop'], types: ['video', 'image'] },
  { id: 'mask', label: 'Masks', keys: ['mask', 'masks', 'maskUse'], kfPrefix: 'mask', types: ['video', 'image'] },
  { id: 'picture', label: 'Motion blur, noise, relight and canvas', keys: ['motionBlur', 'denoise', 'relight', 'canvas'], kfPrefix: 'relight.', types: ['video', 'image'] },
  { id: 'chroma', label: 'Chroma key', keys: ['chroma'], types: ['video', 'image'] },
  { id: 'enhance', label: 'Enhance quality', keys: ['enhance'], kfPrefix: 'enhance.', types: ['video', 'image'] },
  { id: 'cutout', label: 'Background removal', keys: ['cutout'], types: ['video', 'image'] },
  { id: 'removal', label: 'Object removal', keys: ['removal'], kfPrefix: 'remove', types: ['video', 'image'] },
  { id: 'retouch', label: 'Retouch (skin, face, body, makeup and hair)', keys: ['retouch', 'faceShape', 'bodyShape', 'makeup', 'hairColor'], types: ['video', 'image'] },
  { id: 'color', label: 'Color adjustments', keys: ['adjust', 'grade', 'colorTarget'], kfPrefix: 'adjust.', types: ['video', 'image', 'adjust'] },
  { id: 'filter', label: 'Filter', keys: ['filter'], types: ['video', 'image'] },
  { id: 'stylize', label: 'Style look', keys: ['stylize'], types: ['video', 'image'] },
  { id: 'animation', label: 'Animations', keys: ['animIn', 'animOut', 'animLoop'], types: ['video', 'image', 'text', 'sticker', 'avatar'] },
  { id: 'effects', label: 'Clip effects', keys: ['effects'], types: ['video', 'image', 'text', 'sticker', 'avatar'] },
  { id: 'speed', label: 'Speed', keys: ['smoothSlow'], speed: true, types: ['video', 'audio'] },
  { id: 'audio', label: 'Volume and fades', keys: ['volume', 'fadeIn', 'fadeOut', 'muted'], kf: ['volume'], types: ['video', 'audio'] },
  { id: 'audioFx', label: 'Audio effects', keys: ['audioFx', 'keepPitch'], types: ['video', 'audio'] },
  { id: 'textStyle', label: 'Text style', keys: ['style', 'bubble', 'textFx'], types: ['text'] },
  { id: 'graphic', label: 'Graphic color', keys: ['color'], types: ['sticker'] },
];

/** Optional clip fields an attribute paste may create on a clip that lacks them. */
const OPTIONAL_KEYS = ['mask', 'masks', 'motionBlur', 'denoise', 'relight', 'enhance', 'canvas', 'chroma', 'cutout', 'removal', 'retouch', 'faceShape', 'bodyShape', 'makeup', 'hairColor', 'colorTarget', 'maskUse', 'grade', 'audioFx', 'keepPitch', 'bubble', 'textFx', 'effects', 'smoothSlow', 'stylize'];
/** Optional fields only video clips carry (their group also covers audio clips). */
const VIDEO_ONLY_KEYS = ['smoothSlow'];

/** Attribute groups that apply to a clip type and that the source clip has. */
export function attributeGroupsFor(source, targetTypes = [source.type]) {
  return ATTRIBUTE_GROUPS.filter((g) => g.types.includes(source.type) && targetTypes.some((t) => g.types.includes(t)) && (g.speed ? 'speed' in source : g.keys.some((k) => k in source)));
}

/** Snapshot of a clip's attributes, by group id. */
export function captureAttributes(clip) {
  const out = { type: clip.type, groups: {} };
  for (const g of attributeGroupsFor(clip, ATTRIBUTE_GROUPS.flatMap((x) => x.types))) {
    const entry = { values: {}, keyframes: {} };
    for (const k of g.keys) if (k in clip) entry.values[k] = structuredClone(clip[k]);
    if (g.speed) {
      entry.speed = clip.speed;
      if (clip.speedCurve && !clip.freeze) entry.speedCurve = structuredClone(clip.speedCurve);
    }
    for (const [prop, keys] of Object.entries(clip.keyframes || {})) {
      if (g.kf?.includes(prop) || (g.kfPrefix && prop.startsWith(g.kfPrefix))) entry.keyframes[prop] = structuredClone(keys);
    }
    out.groups[g.id] = entry;
  }
  return out;
}

/**
 * Apply captured attribute groups to a clip in place. Keyframes are scaled to
 * the target's length. Speed is returned (it needs a timeline operation).
 */
export function applyAttributes(clip, captured, groupIds, sourceDuration) {
  let speed = null;
  for (const id of groupIds) {
    const g = ATTRIBUTE_GROUPS.find((x) => x.id === id);
    const entry = captured.groups[id];
    if (!g || !entry || !g.types.includes(clip.type)) continue;
    for (const [k, v] of Object.entries(entry.values)) {
      // Fields that only make sense for one clip type are not created on another.
      if (!(k in clip) && !OPTIONAL_KEYS.includes(k)) continue;
      if (VIDEO_ONLY_KEYS.includes(k) && clip.type !== 'video') continue;
      clip[k] = structuredClone(v);
    }
    if (g.speed && entry.speed) speed = entry.speed;
    if (clip.keyframes) {
      // Replace this group's keyframes with the source's, fitted to this clip.
      for (const prop of Object.keys(clip.keyframes)) {
        if (g.kf?.includes(prop) || (g.kfPrefix && prop.startsWith(g.kfPrefix))) delete clip.keyframes[prop];
      }
      const k = sourceDuration > 0 ? clip.duration / sourceDuration : 1;
      for (const [prop, keys] of Object.entries(entry.keyframes)) {
        const fitted = keys.map((x) => ({ ...x, t: Math.min(clip.duration, Math.round(x.t * k)) }));
        if (fitted.length) clip.keyframes[prop] = fitted;
      }
    }
  }
  return speed;
}

export function createOrganizeActions(ctx) {
  const { store } = ctx;
  let attrBoard = null;
  const sel = () => store.selectedIds;
  const tol = () => Math.round(US / store.fps / 2);

  const a = {
    /** V: turn the selected clips off, or back on when they all are off. */
    toggleDisabled() {
      const ids = sel();
      if (!ids.length) return;
      const clips = ids.map((id) => T.findClip(store.project, id)?.clip).filter(Boolean);
      const turnOn = clips.every((c) => c.disabled);
      store.update(turnOn ? 'Enable clip' : 'Disable clip', (p) => T.setDisabled(p, ids, !turnOn) > 0, { structural: false });
      announce(turnOn ? 'Clip enabled' : 'Clip disabled');
    },

    group() {
      const ids = sel();
      let g = null;
      store.update('Group clips', (p) => {
        g = T.groupClips(p, ids);
        return Boolean(g);
      }, { structural: false });
      if (g) announce('Clips grouped');
      else toast('Select two or more clips to group them.', { kind: 'info' });
    },

    ungroup() {
      const ok = store.update('Ungroup clips', (p) => T.ungroupClips(p, sel()) > 0, { structural: false });
      if (ok) announce('Clips ungrouped');
    },

    setLabel(label) {
      const ids = sel();
      if (!ids.length) return;
      store.update(label ? 'Label clip' : 'Remove label', (p) => T.setClipLabel(p, ids, label) > 0, { structural: false });
    },

    /** [ and ]: select everything left or right of the playhead. */
    selectSide(side) {
      const ids = T.clipsOnSide(store.project, store.time, side);
      store.select(ids);
      announce(`${ids.length} clip${ids.length === 1 ? '' : 's'} selected`);
    },

    /** Split every clip on every unlocked track at the playhead, ignoring the selection. */
    splitAll() {
      let made = [];
      const ok = store.update('Split all', (p) => {
        made = T.splitAt(p, store.time);
        return made.length > 0;
      });
      if (!ok) toast('There are no clips under the playhead.', { kind: 'info' });
      else announce(`${made.length} clip${made.length === 1 ? '' : 's'} split`);
    },

    // ---- In / out range --------------------------------------------------
    markIn() {
      store.update('Set in point', (p) => {
        T.setRangeIn(p, store.time);
      }, { structural: false });
      announce(`In point ${timecode(store.time, store.fps)}`);
    },
    markOut() {
      store.update('Set out point', (p) => {
        T.setRangeOut(p, store.time);
      }, { structural: false });
      announce(`Out point ${timecode(store.time, store.fps)}`);
    },
    clearRange() {
      if (!store.project.range) return;
      store.update('Clear in and out', (p) => T.clearRange(p), { structural: false });
      announce('In and out points cleared');
    },
    rangeFromSelection() {
      const ids = sel();
      if (!ids.length) {
        toast('Select clips to mark their range.', { kind: 'info' });
        return;
      }
      store.update('Mark selection', (p) => Boolean(T.rangeFromClips(p, ids)), { structural: false });
    },
    /** Cut the in/out range out of every unlocked track; close = ripple the gap shut. */
    removeRangeContent(close = true) {
      const r = store.project.range;
      if (!r) {
        toast('Set in and out points first (I and O).', { kind: 'info' });
        return;
      }
      store.update(close ? 'Cut range' : 'Clear range', (p) => {
        T.removeRange(p, r.in, r.out, { close });
        if (close) delete p.range;
      });
      store.seek(r.in);
      announce(close ? 'Range cut and gap closed' : 'Range cleared');
    },
    goToIn() {
      if (store.project.range) store.seek(store.project.range.in);
    },
    goToOut() {
      if (store.project.range) store.seek(store.project.range.out);
    },

    // ---- Markers ---------------------------------------------------------
    /** Add a marker; withNewColor picks the next color after the last marker's. */
    addMarkerAt(t = store.time, { withNewColor = false } = {}) {
      if (store.project.markers.some((m) => Math.abs(m.time - t) < US / store.fps)) return null;
      const last = store.project.markers.at(-1);
      const base = prefs().markerColor || MARKER_COLORS[0];
      const color = withNewColor ? MARKER_COLORS[(MARKER_COLORS.indexOf(last?.color ?? base) + 1) % MARKER_COLORS.length] : base;
      if (withNewColor) setPref('markerColor', color);
      const m = { id: uid('m'), time: Math.round(t), color, label: '' };
      store.update('Add marker', (p) => {
        p.markers.push(m);
        p.markers.sort((x, y) => x.time - y.time);
      }, { structural: false });
      announce('Marker added');
      return m;
    },
    moveMarker(id, time, opts = {}) {
      store.update('Move marker', (p) => T.updateMarker(p, id, { time }), { structural: false, ...opts });
    },
    goToMarker(dir) {
      const m = T.adjacentMarker(store.project, store.time, dir);
      if (!m) {
        announce(dir > 0 ? 'No later marker' : 'No earlier marker');
        return;
      }
      store.seek(m.time);
      announce(m.label ? `Marker: ${m.label}` : `Marker at ${timecode(m.time, store.fps)}`);
    },
    /** Marker editor: name, color, notes, delete. */
    editMarker(id) {
      const m = T.findMarker(store.project, id);
      if (!m) return;
      let color = m.color;
      const name = h('input.input', { type: 'text', value: m.label || '', maxlength: 200, placeholder: 'Marker name', 'aria-label': 'Marker name' });
      const note = h('textarea.input.marker-note', { rows: 4, maxlength: 2000, placeholder: 'Notes', 'aria-label': 'Notes' }, m.note || '');
      const swatches = h('div.marker-swatches', { role: 'radiogroup', 'aria-label': 'Color' }, MARKER_COLORS.map((c) => {
        const b = h('button.marker-swatch', { type: 'button', role: 'radio', 'aria-checked': String(c === color), 'aria-label': c, style: { '--swatch': c } });
        b.addEventListener('click', () => {
          color = c;
          swatches.querySelectorAll('.marker-swatch').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        });
        return b;
      }));
      const del = h('button.btn.danger', { type: 'button' }, 'Delete');
      const cancel = h('button.btn', { type: 'button' }, 'Cancel');
      const save = h('button.btn.primary', { type: 'button' }, 'Save');
      const body = h('div.marker-editor',
        h('p.marker-time', `At ${timecode(m.time, store.fps)}`),
        h('label.field', h('span.field-label', 'Name'), name),
        h('div.field', h('span.field-label', 'Color'), swatches),
        h('label.field', h('span.field-label', 'Notes'), note),
      );
      const d = openDialog({ title: 'Marker', body, actions: [del, h('span.spacer'), cancel, save], className: 'small' });
      del.addEventListener('click', () => {
        a.removeMarkerById(id);
        d.close();
      });
      cancel.addEventListener('click', () => d.close());
      save.addEventListener('click', () => {
        store.update('Edit marker', (p) => T.updateMarker(p, id, { label: name.value.trim(), note: note.value.trim(), color }), { structural: false });
        d.close();
      });
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save.click();
      });
    },
    removeMarkerById(id) {
      store.update('Delete marker', (p) => {
        p.markers = p.markers.filter((x) => x.id !== id);
      }, { structural: false });
      announce('Marker deleted');
    },
    clearMarkers() {
      if (!store.project.markers.length) return;
      store.update('Delete all markers', (p) => {
        p.markers = [];
      }, { structural: false });
    },

    // ---- Tracks ----------------------------------------------------------
    async renameTrack(trackId) {
      const t = T.findTrack(store.project, trackId);
      if (!t) return;
      const name = await promptDialog({ title: 'Rename track', label: 'Track name', value: t.name || t._label || '', maxLength: 60 });
      if (name === null || name === undefined) return;
      store.update('Rename track', (p) => T.renameTrack(p, trackId, name), { structural: false });
    },
    async deleteTrack(trackId) {
      const t = T.findTrack(store.project, trackId);
      if (!t) return;
      if (t.clips.length) {
        const ok = await confirmDialog({ title: t.main ? 'Clear base track?' : 'Delete track?', message: `${t.clips.length} clip${t.clips.length === 1 ? '' : 's'} on this track will be deleted.`, confirm: t.main ? 'Clear' : 'Delete', danger: true });
        if (!ok) return;
      }
      store.update(t.main ? 'Clear track' : 'Delete track', (p) => T.deleteTrack(p, trackId));
      store.clearSelection();
    },
    moveTrack(trackId, dir) {
      store.update('Move track', (p) => T.moveTrack(p, trackId, dir), { structural: false });
    },
    toggleSolo(trackId) {
      store.update('Solo track', (p) => T.toggleSolo(p, trackId), { structural: false });
    },
    setTrackSize(trackId, size) {
      store.update('Track height', (p) => T.setTrackSize(p, trackId, size), { structural: false });
    },
    addTrackNear(trackId, kind, below = false) {
      store.update('Add track', (p) => Boolean(T.insertTrackNear(p, trackId, kind, below)), { keepEmptyTracks: true });
    },
    selectTrackClips(trackId) {
      const t = T.findTrack(store.project, trackId);
      if (t) store.select(t.clips.map((c) => c.id));
    },

    // ---- Attributes ------------------------------------------------------
    copyAttributes(clipId = store.selected?.clip.id) {
      const s = clipId ? T.findClip(store.project, clipId) : null;
      if (!s) {
        toast('Select a clip to copy its attributes.', { kind: 'info' });
        return false;
      }
      attrBoard = { ...captureAttributes(s.clip), duration: s.clip.duration, name: T.clipLabel(store.project, s.clip) };
      announce('Attributes copied');
      toast('Attributes copied. Select clips and paste them.', { kind: 'success' });
      return true;
    },
    hasAttributes: () => Boolean(attrBoard),
    /** Paste with a dialog to pick which attribute groups to apply. */
    async pasteAttributes() {
      if (!attrBoard) {
        toast('Copy attributes from a clip first.', { kind: 'info' });
        return;
      }
      const ids = sel();
      const targets = ids.map((id) => T.findClip(store.project, id)?.clip).filter(Boolean);
      if (!targets.length) {
        toast('Select the clips to paste attributes onto.', { kind: 'info' });
        return;
      }
      const types = [...new Set(targets.map((c) => c.type))];
      const groups = ATTRIBUTE_GROUPS.filter((g) => attrBoard.groups[g.id] && types.some((t) => g.types.includes(t)));
      if (!groups.length) {
        toast('Those attributes do not apply to the selected clips.', { kind: 'info' });
        return;
      }
      const remembered = new Set(prefs().pasteAttrs || groups.map((g) => g.id));
      const boxes = groups.map((g) => {
        const input = h('input', { type: 'checkbox', checked: remembered.has(g.id) || !prefs().pasteAttrs });
        return { g, input, row: h('label.check-row', input, h('span', g.label)) };
      });
      const cancel = h('button.btn', { type: 'button' }, 'Cancel');
      const ok = h('button.btn.primary', { type: 'button' }, 'Paste');
      const all = h('button.btn.ghost.small', { type: 'button' }, 'Select all');
      all.addEventListener('click', () => boxes.forEach((b) => (b.input.checked = true)));
      const d = openDialog({
        title: 'Paste attributes',
        body: h('div.paste-attrs', h('p.dialog-text', `From ${attrBoard.name} to ${targets.length} clip${targets.length === 1 ? '' : 's'}`), h('div.check-list', boxes.map((b) => b.row)), all),
        actions: [cancel, ok],
        className: 'small',
      });
      cancel.addEventListener('click', () => d.close());
      ok.addEventListener('click', () => {
        const chosen = boxes.filter((b) => b.input.checked).map((b) => b.g.id);
        setPref('pasteAttrs', chosen);
        d.close();
        if (chosen.length) a.applyAttributes(chosen, ids);
      });
    },
    /** Apply the copied groups to clips without asking (used by the dialog and tests). */
    applyAttributes(groupIds, ids = sel()) {
      if (!attrBoard) return false;
      return a.applyAttributeBoard(attrBoard, groupIds, ids, 'Paste attributes');
    },
    /** Apply groups of a captured attribute set (copied or a saved preset) to clips, as one step. */
    applyAttributeBoard(board, groupIds, ids = sel(), label = 'Apply attributes') {
      const attrBoard = board;
      return store.update(label, (p) => {
        let any = false;
        for (const id of ids) {
          const f = T.findClip(p, id);
          if (!f || f.track.locked) continue;
          const speed = applyAttributes(f.clip, attrBoard, groupIds, attrBoard.duration);
          const curve = groupIds.includes('speed') ? attrBoard.groups.speed?.speedCurve : null;
          if (T.isTimed(f.clip) && !f.clip.freeze) {
            // A speed curve pastes as a curve; otherwise the constant speed.
            if (curve) T.setSpeedCurve(p, id, structuredClone(curve), store.opts);
            else if (speed) T.setSpeed(p, id, speed, store.opts);
          }
          any = true;
        }
        return any;
      });
    },

    // ---- Compound clips ----------------------------------------------------
    createCompound() {
      const ids = sel();
      if (!ids.length) {
        toast('Select the clips to nest into a compound clip.', { kind: 'info' });
        return null;
      }
      let made = null;
      store.update('Create compound clip', (p) => {
        made = createCompound(p, T.expandGroups(p, ids), store.opts);
        return Boolean(made);
      });
      if (made) {
        store.select(made.id);
        announce(`${made.name} created`);
      }
      return made;
    },
    breakApartCompound(id = store.selected?.clip.id) {
      let restored = [];
      store.update('Break apart compound clip', (p) => {
        restored = breakApart(p, id, store.opts);
        return restored.length > 0;
      });
      if (restored.length) {
        store.select(restored.map((c) => c.id));
        announce('Compound clip broken apart');
      }
    },
    openCompound(id = store.selected?.clip.id) {
      ctx.player?.pause?.();
      if (store.openCompound(id)) announce(`Editing ${store.compoundName}. Use Back to return.`);
    },
    closeCompound() {
      ctx.player?.pause?.();
      if (store.closeCompound()) announce(store.nest.length ? `Editing ${store.compoundName}` : 'Back to the main timeline');
    },

    // ---- Keyframes -------------------------------------------------------
    /** Easing of the keys under the playhead on the selected clip. */
    setKeyEase(easeName, clipId = store.selected?.clip.id, local = null) {
      const f = clipId && T.findClip(store.project, clipId);
      if (!f) return false;
      const t = local ?? Math.round(store.time - f.clip.start);
      const ok = ctx.actions.editClip(clipId, `Keyframe: ${easeLabel(easeName)}`, (c) => T.setKeyEaseAt(c, t, easeName, tol()) > 0);
      if (!ok) toast('Move the playhead onto a keyframe first.', { kind: 'info' });
      return ok;
    },
    moveKeyframe(clipId, from, to, opts = {}) {
      return ctx.actions.editClip(clipId, 'Move keyframe', (c) => T.moveKeyTime(c, from, to, tol()) > 0, opts);
    },
    removeKeyframesAt(clipId, local) {
      return ctx.actions.editClip(clipId, 'Delete keyframe', (c) => T.removeKeysAt(c, local, tol()) > 0);
    },
  };
  return a;
}

export { CLIP_LABELS };
