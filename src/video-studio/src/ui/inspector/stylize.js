/**
 * Style tab for video and image clips:
 *  - Looks: an art style over the whole clip with one Amount, drawn live on
 *    the device by the effect shaders (model/stylize.js), in the preview and
 *    the export alike
 *  - AI restyle: the picture (or the frame at the playhead of a video) is
 *    redrawn by Puter AI in a chosen style; the result becomes a new image
 *    clip, replaces the picture of an image clip (undoable), or goes to the
 *    media library. Signed-out users see the sign-in prompt.
 * The frame capture and the AI call are injectable: ctx.restyleServices =
 * { picture(clip, time), restyle(picture, opts) }.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { DEFAULT_TRANSFORM, makeClip, makeTrack, normalizeClip } from '../../model/project.js';
import { inheritFromCompound } from '../../model/compound.js';
import { parseMaskProp } from '../../model/masks.js';
import { retainMaskSpace } from '../../model/mask-space.js';
import * as T from '../../model/timeline.js';
import { STYLE_LOOKS, STYLE_AMOUNT_DEFAULT, styleEffect, normalizeStylize } from '../../model/stylize.js';
import { aiAvailable } from '../../media/tts.js';
import { RESTYLE_STYLES, RESTYLE_PROMPT_MAX, fitSize, restylePicture, restyleFileName } from '../../media/restyle.js';
import { stackPreview } from '../panels/previews.js';
import { toast } from '../dialog.js';
import { defaultLength } from '../preferences-dialog.js';
import { choiceGrid, slider, propSection, note } from './common.js';
import '../../styles/avatar.css';

// These controls are rendered into the source picture. Placement, masks and
// live effects stay on the timeline and must not be consumed by replacement.
const PICTURE_FIELDS = ['crop', 'adjust', 'grade', 'filter', 'chroma', 'cutout', 'removal', 'retouch', 'faceShape', 'hairColor', 'bodyShape', 'makeup', 'denoise', 'relight', 'enhance'];
const pictureField = prop => /^remove\d+\./.test(prop) ? 'removal' : prop.split('.')[0];

function pictureSettings(clip) {
  const normalized = normalizeClip(clip);
  return structuredClone({
    settings: Object.fromEntries(PICTURE_FIELDS.map(field => [field, normalized[field]])),
    keyframes: Object.fromEntries(Object.entries(normalized.keyframes).filter(([prop]) => PICTURE_FIELDS.includes(pictureField(prop)))),
  });
}

function consumePictureSettings(clip, baked) {
  if (!baked) return;
  const current = pictureSettings(clip), defaults = makeClip('image');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const field of PICTURE_FIELDS) {
    // Adjustments have independent controls; editing exposure while a job runs
    // must not keep an unchanged contrast adjustment that is already baked in.
    if (field === 'adjust') {
      for (const key of Object.keys(defaults.adjust)) {
        const prop = `adjust.${key}`;
        if (same(current.settings.adjust[key], baked.settings.adjust[key]) && same(current.keyframes[prop], baked.keyframes[prop])) {
          clip.adjust[key] = defaults.adjust[key];
          delete clip.keyframes[prop];
        }
      }
      continue;
    }
    if (baked.settings[field]?.on === false) continue;
    const keys = [...new Set([...Object.keys(current.keyframes), ...Object.keys(baked.keyframes)])].filter(prop => pictureField(prop) === field);
    if (!same(current.settings[field], baked.settings[field]) || keys.some(prop => !same(current.keyframes[prop], baked.keyframes[prop]))) continue;
    if (field in defaults) clip[field] = structuredClone(defaults[field]);
    else delete clip[field];
    for (const prop of keys) delete clip.keyframes[prop];
  }
}

/** The clip's picture at timeline time (its own pixels and color, untransformed): { blob, width, height }. */
export async function clipPicture(ctx, clip, time) {
  const p = ctx.store.project;
  const asset = p.assets[clip.assetId];
  if (!asset) throw new Error('This clip has no media.');
  // Cropping is baked into the pixels. Match their visible aspect ratio so
  // fitting the result back into any project frame preserves its footprint.
  const source = clip.pictureSize || asset;
  const crop = clip.crop || {};
  const sourceW = Math.max(1e-6, (source.width || p.settings.width) * (1 - (crop.l || 0) - (crop.r || 0)));
  const sourceH = Math.max(1e-6, (source.height || p.settings.height) * (1 - (crop.t || 0) - (crop.b || 0)));
  const size = fitSize(sourceW, sourceH);
  const w = Math.max(16, Math.round(size.w / 2) * 2);
  const hh = Math.max(16, Math.round(size.h / 2) * 2);
  const one = structuredClone(clip);
  const baked = pictureSettings(one);
  baked.source = { width: source.width || p.settings.width, height: source.height || p.settings.height, maskSpace: structuredClone(clip.maskSpace) };
  baked.pictureSize = { width: sourceW, height: sourceH };
  Object.assign(one, { start: 0, transform: { ...DEFAULT_TRANSFORM }, opacity: 1, blend: 'normal', animIn: null, animOut: null, animLoop: null, keyframes: structuredClone(baked.keyframes), transition: null });
  // Retained group placement and transition partners belong to the timeline,
  // not the isolated source picture sent for restyling. Keep source timing.
  for (const k of ['stylize', 'effects', 'group', 'disabled', 'parent', 'canvas', 'motionBlur', 'inherited', 'transitionSlices']) delete one[k];
  // Color masks define which pixels receive the captured grade. Alpha masks
  // stay editable on the timeline, without cutting holes into the AI source.
  if (one.maskUse === 'color') {
    for (const [prop, keys] of Object.entries(clip.keyframes || {})) {
      if (parseMaskProp(prop)) one.keyframes[prop] = structuredClone(keys);
    }
  } else delete one.masks;
  const local = Math.min(Math.max(0, time - clip.start), Math.max(0, clip.duration - 1000));
  const project = { ...p, settings: { ...p.settings, width: sourceW, height: sourceH, background: { type: 'color', color: '#000000', blur: 0 } }, tracks: [makeTrack('video', { main: true, clips: [one] })], markers: [] };
  delete project.range;
  const { renderStill } = await import('../../engine/exporter.js');
  const bmp = await renderStill(project, ctx.library, local, { pixelSize: { width: w, height: hh } });
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not capture the picture.');
  return { blob, width: c.width, height: c.height, baked };
}

function services(ctx) {
  return {
    picture: (clip, time) => clipPicture(ctx, clip, time),
    restyle: (picture, opts) => restylePicture(picture, opts),
    ...ctx.restyleServices,
  };
}

/** Put a restyled picture on an overlay track over the clip it came from (or at the playhead for a video frame). */
export function addRestyledClip(ctx, sourceId, asset, baked) {
  const { store } = ctx;
  const src = T.findClip(store.project, sourceId)?.clip;
  const still = src?.type === 'image';
  const clip = makeClip('image', {
    assetId: asset.id,
    name: asset.name,
    start: still ? src.start : store.time,
    duration: still ? src.duration : Math.max(T.MIN_CLIP, defaultLength.image()),
  });
  if (baked?.pictureSize) clip.pictureSize = { ...baked.pictureSize };
  if (src) {
    // The new source pixels have no placement. Retain the source clip's full
    // motion, including former group axes, at this clip's timeline position.
    inheritFromCompound(clip, { ...src, disabled: false, muted: false }, store.project.settings.width, store.project.settings.height);
  }
  const ok = store.update('Add restyled picture', (p) => {
    T.addClip(p, clip, { ...store.opts, main: false });
  });
  if (!ok) return null;
  store.select(clip.id);
  return clip;
}

/** Show the restyled picture in an image clip instead of its own (one undo step). */
export function replacePicture(ctx, clipId, asset, baked) {
  return ctx.actions.editClip(clipId, 'Replace with restyled picture', (c) => {
    if (c.type !== 'image') return false;
    retainMaskSpace(c, baked?.source, baked?.settings.crop);
    consumePictureSettings(c, baked);
    c.assetId = asset.id;
    c.name = asset.name;
    if (baked?.pictureSize) c.pictureSize = { ...baked.pictureSize };
    else delete c.pictureSize;
    // The new picture brings its own look; a live look on top would double it.
    delete c.stylize;
  });
}

function looksSection(view) {
  const none = h('span.style-none', 'None');
  const grid = choiceGrid({
    label: 'Style looks',
    className: 'style-grid',
    items: [{ id: null, label: 'None', preview: none }, ...STYLE_LOOKS.map((s) => ({
      id: s.id,
      label: s.label,
      preview: stackPreview([styleEffect({ id: s.id, amount: STYLE_AMOUNT_DEFAULT })], `style:${s.id}`),
    }))],
    value: view.clip?.stylize?.id ?? null,
    onPick: (id) => view.edit(id ? `Style: ${STYLE_LOOKS.find((s) => s.id === id).label}` : 'Remove style', (c) => {
      if (!id) delete c.stylize;
      else c.stylize = normalizeStylize({ id, amount: c.stylize?.amount ?? STYLE_AMOUNT_DEFAULT });
    }),
  });
  const amount = slider(view, {
    label: 'Amount',
    min: 0,
    max: 100,
    unit: '%',
    get: (c) => c?.stylize?.amount ?? STYLE_AMOUNT_DEFAULT,
    set: (v, final) => view.edit('Style amount', (c) => {
      if (!c.stylize) return false;
      c.stylize = normalizeStylize({ ...c.stylize, amount: v });
    }, { key: 'style-amount', final }),
  });
  const sync = () => {
    const c = view.clip;
    if (!c) return;
    grid.set(c.stylize?.id ?? null);
    amount.el.hidden = !c.stylize;
  };
  view.bind(sync);
  sync();
  return propSection('Looks', [grid.el, amount.el, h('p.field-hint', 'Runs live on the whole clip, in the preview and the export.')], {
    onReset: () => view.edit('Remove style', (c) => {
      if (!c.stylize) return false;
      delete c.stylize;
    }),
  });
}

// A restyle is slow and paid for: its job and its result belong to the clip, not to the tab
// that asked, so leaving the tab and coming back neither loses the picture nor starts it twice.
const restyleJobs = new Map(); // clip id -> promise of { blob, styleId }
const restyleResults = new Map(); // clip id -> { blob, url, styleId, assetId, pending }
const RESULTS_KEPT = 4;

function keepResult(id, result) {
  dropResult(id);
  restyleResults.set(id, result);
  for (const old of restyleResults.keys()) {
    if (restyleResults.size <= RESULTS_KEPT) break;
    dropResult(old);
  }
}

function dropResult(id) {
  const r = restyleResults.get(id);
  if (r) URL.revokeObjectURL(r.url);
  restyleResults.delete(id);
}

function restyleSection(view) {
  const { ctx, store } = view;
  if (!aiAvailable(ctx)) {
    const btn = ctx.account?.onSignIn ? h('button.btn.small', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 14), 'Sign in to Puter') : null;
    return propSection('AI restyle', [note('AI restyle redraws the picture with Puter AI, so it needs a Puter account.', 'user'), btn]);
  }
  let style = null;
  const clipId = `${store.project.id}:${view.id}`;
  let busy = false;
  let acting = false;
  let result = restyleResults.get(clipId) || null;
  const chips = RESTYLE_STYLES.map((s) => {
    const b = h('button.restyle-chip', { type: 'button', 'aria-pressed': 'false' }, s.label);
    b.addEventListener('click', () => {
      style = style === s.id ? null : s.id;
      chips.forEach((c, i) => c.setAttribute('aria-pressed', String(RESTYLE_STYLES[i].id === style)));
      sync();
    });
    return b;
  });
  const prompt = h('textarea.textarea.restyle-prompt', { maxLength: RESTYLE_PROMPT_MAX, rows: 3, 'aria-label': 'Describe the look', placeholder: 'Describe the look (optional with a style), e.g. warm autumn colors' });
  const go = h('button.btn.primary', { type: 'button' }, icon('magic', 16), 'Restyle');
  const status = h('p.tts-status', { role: 'status' });
  const out = h('div.restyle-result');
  prompt.addEventListener('input', () => sync());

  const clearResult = () => {
    dropResult(clipId);
    result = null;
    out.replaceChildren();
  };

  async function toMedia() {
    const r = result;
    if (r.assetId && store.project.assets[r.assetId]) return store.project.assets[r.assetId];
    // One import however many buttons ask for it.
    r.pending ||= (async () => {
      const c = view.clip;
      const file = new File([r.blob], restyleFileName(c?.name || store.project.assets[c?.assetId]?.name, r.styleId, r.blob.type || 'image/png'), { type: r.blob.type || 'image/png' });
      const [asset] = await ctx.actions.importFiles([file], { origin: 'restyle' });
      if (!asset) throw new Error("Couldn't add the picture to your media.");
      r.assetId = asset.id;
      return asset;
    })();
    try {
      return await r.pending;
    } finally {
      r.pending = null;
    }
  }

  function renderResult() {
    if (!result) return;
    const c = view.clip;
    const add = h('button.btn.primary', { type: 'button' }, icon('plus', 14), 'Add as clip');
    const replace = c?.type === 'image' ? h('button.btn', { type: 'button' }, icon('replace', 14), 'Replace picture') : null;
    const save = h('button.btn', { type: 'button' }, icon('import', 14), 'Save to media');
    const drop = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Discard result', 'data-tip': 'Discard' }, icon('close', 14));
    const id = view.id;
    const baked = result.baked;
    const act = (fn, done) => async () => {
      // A second click while the picture is still being imported would use it twice.
      if (acting) return;
      acting = true;
      try {
        const asset = await toMedia();
        fn(asset);
        announce(done);
      } catch (err) {
        toast(err?.message || "Couldn't use the picture.", { kind: 'error' });
      } finally {
        acting = false;
      }
    };
    add.addEventListener('click', act((asset) => addRestyledClip(ctx, id, asset, baked), 'Restyled picture added'));
    replace?.addEventListener('click', act((asset) => replacePicture(ctx, id, asset, baked), 'Picture replaced'));
    save.addEventListener('click', act(() => save.replaceChildren(icon('check', 14), 'In media'), 'Saved to media'));
    drop.addEventListener('click', clearResult);
    out.replaceChildren(h('img', { src: result.url, alt: 'Restyled picture' }), h('div.restyle-actions', add, replace, save, drop));
  }

  /** Show a running job and take its picture when it is ready. */
  async function follow(job) {
    busy = true;
    sync();
    try {
      await job;
      result = restyleResults.get(clipId) || null;
      renderResult();
      status.textContent = 'Done. Add it as a clip, replace the picture, or save it to your media.';
    } catch {
      status.replaceChildren();
    }
    busy = false;
    sync();
  }

  go.addEventListener('click', () => {
    const c = view.clip;
    if (!c || busy || restyleJobs.has(clipId)) return;
    const svc = services(ctx);
    const styleId = style;
    const words = prompt.value;
    status.replaceChildren(h('span.spinner'), c.type === 'video' ? 'Capturing the frame...' : 'Preparing the picture...');
    const job = (async () => {
      const picture = await svc.picture(c, store.time);
      status.replaceChildren(h('span.spinner'), 'Restyling... this can take a little while.');
      const { blob } = await svc.restyle(picture, { prompt: words, style: styleId });
      keepResult(clipId, { blob, baked: picture.baked, url: URL.createObjectURL(blob), styleId, assetId: null, pending: null });
      announce('Restyled picture ready');
    })();
    restyleJobs.set(clipId, job);
    // The job reports for itself: the tab that started it may be gone when it ends.
    job.catch((err) => toast(err?.message || "Couldn't restyle the picture.", { kind: 'error' })).finally(() => restyleJobs.delete(clipId));
    follow(job);
  });

  const what = h('p.field-hint');
  function sync() {
    const c = view.clip;
    if (!c) return;
    go.disabled = busy || (!style && !prompt.value.trim());
    what.textContent = c.type === 'video' ? 'Redraws the frame at the playhead as a new picture.' : 'Redraws this picture.';
  }
  view.bind(sync);
  sync();
  renderResult();
  if (restyleJobs.has(clipId)) {
    status.replaceChildren(h('span.spinner'), 'Restyling... this can take a little while.');
    follow(restyleJobs.get(clipId));
  }
  return propSection('AI restyle', [what, h('div.restyle-chips', { role: 'group', 'aria-label': 'Styles' }, chips), prompt, h('div.tts-actions', go), status, out]);
}

export function stylizeTab(view) {
  return h('div.stylize-tab', looksSection(view), restyleSection(view));
}
