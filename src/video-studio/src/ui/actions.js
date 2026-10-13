/**
 * Editing actions shared by the panels, timeline, menus and keyboard
 * shortcuts. Each action is one undoable store.update().
 */
import { US } from '../lib/time.js';
import { announce, h } from '../lib/dom.js';
import { makeClip, DEFAULT_TEXT_STYLE } from '../model/project.js';
import { normalizeGrade } from '../model/color.js';
import { TEXT_PRESETS, EFFECTS, FILTERS, TRANSITIONS } from '../model/catalog.js';
import { setKey, removeKey, keyIndexAt, valueAt, baseValue, setBaseValue } from '../model/keyframes.js';
import { isMultiColorSticker } from '../engine/stickers.js';
import { findTextLook } from '../model/text-presets.js';
import * as T from '../model/timeline.js';
import { mirrorCurve } from '../model/speed-curve.js';
import { toast, openDialog } from './dialog.js';
import { createOrganizeActions } from './organize-actions.js';
import { createSmartActions } from './smart-actions.js';
import { createMulticamActions } from './multicam-actions.js';
import { createMediaActions } from './media-actions.js';
import { allClipsDeep, removeAssetClips } from '../model/compound.js';
import { defaultLength } from './preferences-dialog.js';
import { createClipEffectActions } from './clip-effects-actions.js';


export function createActions(ctx) {
  const { store } = ctx;
  let clipboard = [];

  const sel = () => store.selectedIds;
  const at = () => store.time;

  function addClipAndSelect(label, clip, opts) {
    const ok = store.update(label, (p) => {
      T.addClip(p, clip, { ...store.opts, ...opts });
    });
    if (ok) {
      store.select(clip.id);
      announce(`${label}`);
    }
    return ok ? clip : null;
  }

  const actions = {
    /** Import local files into the project's media library. Returns the new assets. */
    async importFiles(files, { addToTimeline = false, folder = null, origin } = {}) {
      const list = [...files];
      const assets = [];
      for (const file of list) {
        try {
          const asset = await ctx.library.importFile(file, origin ? { origin } : undefined);
          // Into the media bin folder being viewed (see model/bins.js).
          if (folder && store.project.bins?.some((b) => b.id === folder)) asset.folder = folder;
          assets.push(asset);
        } catch (err) {
          console.error(err);
          toast(err?.message || `Couldn't import ${file.name}`, { kind: 'error' });
        }
      }
      if (!assets.length) return [];
      store.update(assets.length === 1 ? `Import ${assets[0].name}` : `Import ${assets.length} files`, (p) => {
        for (const a of assets) p.assets[a.id] = a;
      }, { structural: false });
      // Several files go one after another, starting at the playhead.
      let at = store.time;
      if (addToTimeline) for (const a of assets) at = T.clipEnd(actions.addAsset(a, { start: at }) || { start: at, duration: 0 });
      announce(assets.length === 1 ? `Imported ${assets[0].name}` : `Imported ${assets.length} files`);
      return assets;
    },

    /** Register an asset produced in the app (recording, speech, sound effect). */
    registerAsset(asset) {
      store.update(`Add ${asset.name}`, (p) => {
        p.assets[asset.id] = asset;
      }, { structural: false });
      return asset;
    },

    removeAsset(assetId) {
      const used = allClipsDeep(store.project).some((c) => c.assetId === assetId);
      store.update('Delete media', (p) => {
        // Clips inside compound clips and on other timelines go too.
        removeAssetClips(p, [assetId]);
        delete p.assets[assetId];
      });
      if (used) announce('Media and its clips deleted');
    },

    /** Put an asset on the timeline at the playhead (or opts.start/trackId). */
    addAsset(asset, opts = {}) {
      const p = store.project;
      const isVisual = asset.kind === 'video' || asset.kind === 'image';
      const type = asset.kind === 'image' ? 'image' : asset.kind === 'audio' ? 'audio' : 'video';
      const duration = asset.kind === 'image' ? defaultLength.image() : Math.max(T.MIN_CLIP, asset.duration);
      const clip = makeClip(type, { assetId: asset.id, name: asset.name, duration, start: opts.start ?? at() });
      const main = T.mainTrack(p);
      const toMain = isVisual && opts.trackId === undefined && (opts.main ?? true) && main && !main.locked;
      // An empty project adopts the first visual asset's shape and frame rate.
      const firstVisual = isVisual && !T.allClips(p).some((c) => c.type === 'video' || c.type === 'image');
      const added = addClipAndSelect(`Add ${asset.name}`, clip, { main: toMain, trackId: opts.trackId });
      if (added && firstVisual && opts.adoptRatio !== false) actions.adoptMediaShape(asset);
      return added;
    },

    /**
     * Put several assets on the timeline one after another from the playhead
     * (or opts.start), in the given order, as a single undo step.
     */
    addAssets(assets, opts = {}) {
      const before = store.history.undoStack.length;
      const added = [];
      let start = opts.start ?? at();
      for (const a of assets) {
        const clip = actions.addAsset(a, { ...opts, start });
        if (!clip) continue;
        added.push(clip);
        start = T.clipEnd(clip);
      }
      // Fold the per-asset steps into the first one, so one undo removes them all.
      if (store.history.undoStack.length > before + 1) {
        const first = store.history.undoStack[before];
        store.history.undoStack.splice(before);
        store.history.undoStack.push({ ...first, label: `Add ${added.length} clips` });
      }
      if (added.length > 1) {
        store.select(added.map((c) => c.id));
        announce(`Added ${added.length} clips`);
      }
      return added;
    },

    /**
     * When the first visual clip lands in a project whose ratio is "Original",
     * the canvas takes that media's shape; the frame rate follows the media.
     * Folded into the add step so one undo removes both.
     */
    adoptMediaShape(asset) {
      const s = store.project.settings;
      const patch = {};
      if (s.ratio === 'original' && asset.width && asset.height) {
        const k = Math.min(1, 3840 / Math.max(asset.width, asset.height));
        patch.width = Math.max(16, Math.round((asset.width * k) / 2) * 2);
        patch.height = Math.max(16, Math.round((asset.height * k) / 2) * 2);
      }
      if (asset.fps) {
        const rounded = [24, 25, 30, 50, 60].reduce((a, b) => (Math.abs(b - asset.fps) < Math.abs(a - asset.fps) ? b : a));
        if (rounded !== s.fps) patch.fps = rounded;
      }
      if (!Object.keys(patch).length) return;
      const entry = store.history.undoStack.at(-1);
      store.update('Match media', (p) => {
        Object.assign(p.settings, patch);
      }, { structural: false });
      if (entry) {
        store.history.undoStack.pop();
      }
    },

    /** Add a text clip in a style preset's or word-art effect's look. */
    addText(presetId = 'plain', opts = {}) {
      const preset = findTextLook(presetId) || TEXT_PRESETS[0];
      const clip = makeClip('text', {
        start: opts.start ?? at(),
        text: opts.text ?? preset.text ?? 'Your text',
        style: { ...DEFAULT_TEXT_STYLE, ...preset.style },
        ...(preset.kind === 'effect' ? {} : { preset: preset.id }),
        duration: opts.duration || defaultLength.text(),
      });
      if (opts.y !== undefined) clip.transform.y = opts.y;
      return addClipAndSelect('Add text', clip, { trackId: opts.trackId });
    },

    addSticker(stickerId, opts = {}) {
      const clip = makeClip('sticker', { start: opts.start ?? at(), sticker: stickerId, color: opts.color || '#ffd23f', duration: opts.duration || defaultLength.text() });
      // Multi-color graphics start with their own palette.
      const mode = opts.colorMode ?? (isMultiColorSticker(stickerId) ? 'original' : null);
      if (mode === 'original') clip.colorMode = 'original';
      clip.transform.scale = 0.6;
      return addClipAndSelect('Add graphic', clip, { trackId: opts.trackId });
    },

    addEffect(effectId, opts = {}) {
      const fx = EFFECTS.find((e) => e.id === effectId);
      const clip = makeClip('effect', { start: opts.start ?? at(), effect: effectId, name: fx?.label || 'Effect' });
      return addClipAndSelect(`Add ${fx?.label || 'effect'}`, clip, { trackId: opts.trackId });
    },

    /** Filters apply to the selected visual clip, or as a filter clip on their own track. */
    addFilter(filterId, opts = {}) {
      const f = FILTERS.find((x) => x.id === filterId);
      const target = opts.toClip ?? store.selected?.clip;
      if (target && (target.type === 'video' || target.type === 'image') && !opts.asTrack) {
        store.update(`Apply ${f?.label || 'filter'}`, (p) => {
          const c = T.findClip(p, target.id)?.clip;
          if (c) c.filter = filterId ? { id: filterId, intensity: c.filter?.intensity ?? 100 } : null;
        });
        announce(filterId ? `${f?.label} applied to clip` : 'Filter removed');
        return null;
      }
      const clip = makeClip('filter', { start: opts.start ?? at(), filter: filterId, name: f?.label || 'Filter' });
      return addClipAndSelect(`Add ${f?.label || 'filter'}`, clip, { trackId: opts.trackId });
    },

    /** Add a color layer, optionally carrying a look (opts.adjust values, opts.grade; may come from a drag). */
    addAdjustment(opts = {}) {
      const name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim().slice(0, 200) : 'Color layer';
      const clip = makeClip('adjust', { start: opts.start ?? at(), name });
      for (const k of Object.keys(clip.adjust)) {
        const v = Number(opts.adjust?.[k]);
        if (Number.isFinite(v)) clip.adjust[k] = Math.max(-100, Math.min(100, v));
      }
      const grade = normalizeGrade(opts.grade);
      if (grade) clip.grade = grade;
      return addClipAndSelect('Add color layer', clip, { trackId: opts.trackId });
    },

    /**
     * Apply a transition at the cut after clipId (or the cut nearest the
     * playhead on the base track).
     */
    applyTransition(transitionId, opts = {}) {
      const p = store.project;
      let clipId = opts.clipId;
      if (!clipId) {
        const s = store.selected;
        if (s && T.nextAdjacent(p, s.clip.id)) clipId = s.clip.id;
      }
      if (!clipId) {
        const main = T.mainTrack(p);
        let best = null;
        let bestD = Infinity;
        for (const c of main.clips) {
          if (!T.nextAdjacent(p, c.id)) continue;
          const d = Math.abs(T.clipEnd(c) - at());
          if (d < bestD) {
            best = c;
            bestD = d;
          }
        }
        clipId = best?.id;
      }
      if (!clipId) {
        toast('Add a transition between two clips that touch on the same track.', { kind: 'info' });
        return false;
      }
      const tr = TRANSITIONS.find((x) => x.id === transitionId);
      const ok = store.update(transitionId ? `Add ${tr?.label || 'transition'}` : 'Remove transition', (proj) => T.setTransition(proj, clipId, transitionId, opts.duration ?? defaultLength.transition()));
      if (!ok) toast('These clips are too short for a transition.', { kind: 'info' });
      else announce(transitionId ? `${tr?.label} transition added` : 'Transition removed');
      return ok;
    },

    applyTransitionToAll(transitionId, duration = defaultLength.transition()) {
      store.update('Apply transition to all', (p) => {
        const main = T.mainTrack(p);
        for (const c of main.clips) if (T.nextAdjacent(p, c.id)) T.setTransition(p, c.id, transitionId, duration);
      });
    },

    /** Set animation (kind = 'in' | 'out' | 'loop') on the selected visual clip. */
    applyAnimation(kind, animId, duration) {
      const s = store.selected;
      if (!s || !('animIn' in s.clip)) {
        toast('Select a video, image, text or graphic clip first.', { kind: 'info' });
        return false;
      }
      const key = kind === 'in' ? 'animIn' : kind === 'out' ? 'animOut' : 'animLoop';
      const def = kind === 'loop' ? 2 * US : defaultLength.animation();
      return store.update(animId ? 'Add animation' : 'Remove animation', (p) => {
        const c = T.findClip(p, s.clip.id).clip;
        if (!animId) c[key] = null;
        else {
          c[key] = { id: animId, duration: Math.min(duration ?? c[key]?.duration ?? def, c.duration) };
          // Loop animations replace in/out ones, and the other way round.
          if (kind === 'loop') {
            c.animIn = null;
            c.animOut = null;
          } else c.animLoop = null;
        }
      });
    },

    /** Generic clip property edit. fn(clip) mutates. */
    editClip(id, label, fn, opts = {}) {
      return store.update(label, (p) => {
        const f = T.findClip(p, id);
        if (!f || f.track.locked) return false;
        return fn(f.clip, f.track, p);
      }, { structural: false, ...opts });
    },

    /** Edit every selected clip that has the property. */
    editSelected(label, fn, opts = {}) {
      const ids = sel();
      if (!ids.length) return false;
      return store.update(label, (p) => {
        let any = false;
        for (const id of ids) {
          const f = T.findClip(p, id);
          if (!f || f.track.locked) continue;
          if (fn(f.clip, f.track, p) !== false) any = true;
        }
        return any;
      }, { structural: false, ...opts });
    },

    /**
     * Set a keyframable property. When the clip already has keys for it, the
     * value becomes a key at the playhead; otherwise the base value changes.
     */
    setAnimatable(id, prop, value, opts = {}) {
      return actions.editClip(id, opts.label || 'Edit', (c) => {
        const local = Math.round(at() - c.start);
        const tol = Math.round(US / store.fps / 2);
        if (c.keyframes?.[prop]?.length && local >= 0 && local <= c.duration) {
          setKey(c.keyframes, prop, local, value, 'linear', tol);
        } else {
          setBaseValue(c, prop, value);
        }
      }, opts);
    },

    /**
     * Set several transform/opacity values in one step (player handles).
     * Keyed properties get a key at the playhead; others change the base.
     */
    setTransform(id, patch, opts = {}) {
      return actions.editClip(id, opts.label || 'Transform', (c) => {
        if (!c.transform) return false;
        const local = Math.round(at() - c.start);
        const tol = Math.round(US / store.fps / 2);
        for (const [prop, value] of Object.entries(patch)) {
          if (c.keyframes?.[prop]?.length && local >= 0 && local <= c.duration) setKey(c.keyframes, prop, local, value, 'linear', tol);
          else if (prop === 'opacity') c.opacity = value;
          else c.transform[prop] = value;
        }
      }, opts);
    },

    /** Add or remove a keyframe for prop at the playhead. */
    toggleKeyframe(id, prop) {
      const f = T.findClip(store.project, id);
      if (!f) return;
      const c = f.clip;
      const local = Math.round(at() - c.start);
      if (local < 0 || local > c.duration) {
        toast('Move the playhead over the clip to add a keyframe.', { kind: 'info' });
        return;
      }
      const tol = Math.round(US / store.fps / 2);
      const has = keyIndexAt(c.keyframes, prop, local, tol) >= 0;
      actions.editClip(id, has ? 'Remove keyframe' : 'Add keyframe', (clip) => {
        if (has) {
          // Removing the only key keeps its value instead of jumping back to an old base value.
          if (clip.keyframes[prop]?.length === 1) setBaseValue(clip, prop, clip.keyframes[prop][0].v);
          removeKey(clip.keyframes, prop, local, tol);
        } else {
          clip.keyframes ||= {};
          setKey(clip.keyframes, prop, local, valueAt(clip.keyframes, prop, local, baseValue(clip, prop)), 'linear', tol);
        }
      });
      announce(has ? 'Keyframe removed' : 'Keyframe added');
    },

    /** Add keyframes for every transform property at the playhead (the toolbar diamond). */
    addKeyframeAll() {
      const s = store.selected;
      if (!s) return;
      const c = s.clip;
      const local = Math.round(at() - c.start);
      if (local < 0 || local > c.duration) return;
      const props = 'transform' in c ? ['x', 'y', 'scale', 'rotation', 'opacity'] : 'volume' in c ? ['volume'] : [];
      if (!props.length) return;
      actions.editClip(c.id, 'Add keyframe', (clip) => {
        for (const prop of props) {
          const base = prop === 'opacity' ? clip.opacity : prop === 'volume' ? clip.volume : clip.transform[prop];
          setKey(clip.keyframes, prop, local, valueAt(clip.keyframes, prop, local, base), 'linear', Math.round(US / store.fps / 2));
        }
      });
      announce('Keyframe added');
    },

    split() {
      const t = at();
      let created = [];
      const ok = store.update('Split', (p) => {
        created = T.splitAt(p, t, sel());
        return created.length > 0;
      });
      if (!ok) toast('Move the playhead over a clip to split it.', { kind: 'info' });
      else announce(created.length === 1 ? 'Clip split' : `${created.length} clips split`);
    },

    deleteSelected() {
      const ids = sel();
      if (!ids.length) return;
      store.update(ids.length === 1 ? 'Delete clip' : 'Delete clips', (p) => T.deleteClips(p, ids, store.opts) > 0);
      store.clearSelection();
      announce(ids.length === 1 ? 'Clip deleted' : `${ids.length} clips deleted`);
    },

    deleteLeft() {
      const ok = store.update('Delete left', (p) => T.trimToPlayhead(p, at(), 'left', sel(), store.opts) > 0);
      if (ok && store.toggles.ripple) {
        // The kept part now starts where the deleted part began.
        const s = store.selected;
        if (s) store.seek(s.clip.start);
      }
    },

    deleteRight() {
      store.update('Delete right', (p) => T.trimToPlayhead(p, at(), 'right', sel(), store.opts) > 0);
    },

    duplicate() {
      const ids = sel();
      if (!ids.length) return;
      const made = [];
      store.update('Duplicate', (p) => {
        for (const id of ids) {
          const c = T.duplicateClip(p, id, store.opts);
          if (c) made.push(c.id);
        }
        return made.length > 0;
      });
      store.select(made);
    },

    copy() {
      const ids = sel();
      if (!ids.length) return false;
      clipboard = ids
        .map((id) => T.findClip(store.project, id))
        .filter(Boolean)
        .map(({ clip, track }) => ({ ...structuredClone(clip), _main: Boolean(track.main) }));
      announce(clipboard.length === 1 ? 'Copied clip' : `Copied ${clipboard.length} clips`);
      return true;
    },

    cut() {
      if (actions.copy()) actions.deleteSelected();
    },

    paste() {
      if (!clipboard.length) return;
      let pasted = [];
      store.update('Paste', (p) => {
        pasted = T.pasteClips(p, clipboard, at(), store.opts);
        return pasted.length > 0;
      });
      store.select(pasted.map((c) => c.id));
    },

    hasClipboard: () => clipboard.length > 0,

    selectAll() {
      store.select(T.allClips(store.project).map((c) => c.id));
    },

    freeze() {
      const s = store.selected;
      if (!s || s.clip.type !== 'video') {
        toast('Select a video clip under the playhead to freeze a frame.', { kind: 'info' });
        return;
      }
      let still = null;
      store.update('Freeze frame', (p) => {
        still = T.freezeFrame(p, s.clip.id, at(), 3 * US, store.opts);
        return Boolean(still);
      });
      if (still) store.select(still.id);
    },

    detachAudio() {
      const s = store.selected;
      if (!s || s.clip.type !== 'video') return;
      let audio = null;
      store.update('Detach audio', (p) => {
        audio = T.detachAudio(p, s.clip.id);
        return Boolean(audio);
      });
      if (!audio) toast('This clip has no audio to extract.', { kind: 'info' });
      else announce('Audio extracted to its own track');
    },

    /**
     * Reverse a video clip: re-encode its file backwards once (cached per
     * file) and point the clip at the reversed copy, mirroring its in point.
     * Running it again on a reversed clip restores the original.
     */
    async reverseClip(id = store.selected?.clip.id) {
      const f = id && T.findClip(store.project, id);
      if (!f || f.clip.type !== 'video' || f.clip.freeze) {
        toast('Select a video clip to reverse.', { kind: 'info' });
        return;
      }
      const clip = f.clip;
      const asset = store.project.assets[clip.assetId];
      if (!asset) return;
      const mirrorIn = (src, dst) => Math.max(0, Math.round(src.duration - (clip.in + clip.duration * clip.speed)));
      // Undo by pointing back at the original file.
      if (asset.reversedOf && store.project.assets[asset.reversedOf]) {
        const orig = store.project.assets[asset.reversedOf];
        actions.editClip(id, 'Reverse', (c) => {
          c.in = mirrorIn(asset, orig);
          c.assetId = orig.id;
          c.reversed = false;
          if (c.speedCurve) c.speedCurve = mirrorCurve(c.speedCurve);
        });
        return;
      }
      let target = Object.values(store.project.assets).find((a) => a.reversedOf === asset.id);
      if (!target) {
        const { reverseFile } = await import('../media/reverse.js');
        const ac = new AbortController();
        const bar = h('span');
        const progress = h('div.progress', bar);
        const cancel = h('button.btn', { type: 'button' }, 'Cancel');
        const d = openDialog({ title: 'Reversing clip', body: h('div.reverse-progress', h('p.dialog-text', `Reversing ${asset.name}. This can take a moment for long clips.`), progress), actions: [cancel], className: 'small', closeOnBackdrop: false, onClose: () => ac.abort() });
        cancel.addEventListener('click', () => d.close());
        try {
          const blob = await ctx.library.mediaBlob(asset);
          const file = await reverseFile(blob, asset.name, { signal: ac.signal, onProgress: (p) => (bar.style.width = `${Math.round(p * 100)}%`) });
          const [made] = await actions.importFiles([file]);
          if (!made) return;
          store.update('Reverse', (p) => {
            p.assets[made.id].reversedOf = asset.id;
          }, { structural: false });
          store.history.undoStack.pop();
          target = store.project.assets[made.id];
          d.close();
        } catch (err) {
          d.close();
          if (err?.name !== 'AbortError') toast(err?.message || "Couldn't reverse this clip.", { kind: 'error' });
          return;
        }
      }
      actions.editClip(id, 'Reverse', (c) => {
        c.in = mirrorIn(asset, target);
        c.assetId = target.id;
        c.reversed = true;
        // A speed curve plays backwards too, so the reversed clip mirrors the original's timing.
        if (c.speedCurve) c.speedCurve = mirrorCurve(c.speedCurve);
      });
      announce('Clip reversed');
    },

    /** Swap the media of a clip, keeping its timing, effects and keyframes. */
    replaceClip(id, asset) {
      const f = T.findClip(store.project, id);
      if (!f || !asset) return false;
      const c = f.clip;
      const visual = c.type === 'video' || c.type === 'image';
      if (visual && asset.kind === 'audio') return false;
      if (c.type === 'audio' && asset.kind === 'image') return false;
      if (asset.kind !== 'image' && asset.duration < c.duration * (c.speed || 1)) {
        toast('The new media is shorter than this clip. Trim the clip first or pick a longer file.', { kind: 'info' });
        return false;
      }
      return actions.editClip(id, 'Replace clip', (clip) => {
        clip.assetId = asset.id;
        clip.name = asset.name;
        clip.in = 0;
        clip.freeze = false;
        clip.reversed = false;
        if (visual) clip.type = asset.kind === 'image' ? 'image' : 'video';
      });
    },

    mirror() {
      actions.editSelected('Mirror', (c) => {
        if (!c.transform) return false;
        c.transform.flipH = !c.transform.flipH;
      });
    },

    rotate() {
      actions.editSelected('Rotate', (c) => {
        if (!c.transform) return false;
        // Keyed rotation: the base value is ignored, so step from (and key) the value at the playhead.
        const local = Math.round(at() - c.start);
        const keyed = c.keyframes?.rotation?.length && local >= 0 && local <= c.duration;
        const r = valueAt(c.keyframes, 'rotation', Math.min(c.duration, Math.max(0, local)), c.transform.rotation);
        const next = ((Math.round(r / 90) * 90 + 90) % 360 + 360) % 360;
        if (keyed) setKey(c.keyframes, 'rotation', local, next, 'linear', Math.round(US / store.fps / 2));
        else c.transform.rotation = next;
      });
    },

    setSpeed(id, speed) {
      store.update('Change speed', (p) => T.setSpeed(p, id, speed, store.opts), { coalesce: `speed:${id}` });
    },

    /**
     * Give a clip a speed curve (null: back to constant 1x). key coalesces a
     * drag into one undo step; span keeps the source length the drag began with.
     */
    setSpeedCurve(id, points, { label = 'Speed curve', key = null, span, dropRamp = false } = {}) {
      return store.update(label, (p) => T.setSpeedCurve(p, id, points, { ...store.opts, ...(span !== undefined ? { span } : {}), dropRamp }), key ? { coalesce: `${key}:${id}` } : {});
    },

    /** Move the selected clips by whole frames (negative: earlier), as one undo step per run of presses. */
    nudgeSelected(frames) {
      const ids = sel();
      const lead = ids.map((id) => T.findClip(store.project, id)).find(Boolean);
      if (!lead) return false;
      const d = Math.round((frames * US) / store.fps);
      return store.update('Nudge clip', (p) => T.moveClip(p, lead.clip.id, { start: Math.max(0, lead.clip.start + d), trackId: lead.track.id }, { ...store.opts, with: ids }), { coalesce: `nudge:${ids.join(',')}` });
    },

    /** Velocity ramp (curve plus accent) in one undo step; null removes it. */
    applySpeedRamp(id, rampId, { accent = true, label = rampId ? 'Velocity ramp' : 'Remove velocity ramp' } = {}) {
      return store.update(label, (p) => T.applySpeedRamp(p, id, rampId, { ...store.opts, accent }));
    },

    /** Turn the accent of a clip's velocity ramp on or off (the curve stays as it is). */
    setRampAccent(id, on) {
      return store.update(on ? 'Add ramp accent' : 'Remove ramp accent', (p) => T.setRampAccent(p, id, on));
    },

    toggleClipMute(id) {
      actions.editClip(id, 'Mute clip', (c) => {
        if (!('muted' in c)) return false;
        c.muted = !c.muted;
      });
    },

    addMarker() {
      return actions.addMarkerAt(at());
    },

    removeMarker(id) {
      store.update('Delete marker', (p) => {
        p.markers = p.markers.filter((m) => m.id !== id);
      }, { structural: false });
    },

    toggleTrack(trackId, prop) {
      store.update(prop === 'locked' ? 'Lock track' : prop === 'hidden' ? 'Hide track' : 'Mute track', (p) => {
        const t = T.findTrack(p, trackId);
        if (!t) return false;
        t[prop] = !t[prop];
      }, { structural: false });
    },

    setProjectSettings(patch, label = 'Project settings') {
      store.update(label, (p) => {
        Object.assign(p.settings, patch);
      }, { structural: false });
    },

    /** Proxy media for the preview: 'off', 'on' or 'auto' (the default, stored as no field). */
    setProxyMode(mode) {
      if (!['off', 'on', 'auto'].includes(mode)) return;
      store.update('Proxy media', (p) => {
        if ((p.settings.proxy || 'auto') === mode) return false;
        // Media is shared by all of the project's timelines, so they all follow.
        for (const settings of [p.settings, ...(p.timelines || []).map((t) => t.settings).filter(Boolean)]) {
          if (mode === 'auto') delete settings.proxy;
          else settings.proxy = mode;
        }
      }, { structural: false });
    },

    renameProject(name) {
      store.update('Rename project', (p) => {
        p.name = name;
      }, { structural: false });
    },
  };
  Object.assign(actions, createOrganizeActions(ctx), createSmartActions(ctx), createMulticamActions(ctx), createMediaActions(ctx), createClipEffectActions(ctx));
  return actions;
}
