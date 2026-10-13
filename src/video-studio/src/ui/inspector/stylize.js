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
import { DEFAULT_TRANSFORM, makeClip, makeTrack } from '../../model/project.js';
import * as T from '../../model/timeline.js';
import { STYLE_LOOKS, STYLE_AMOUNT_DEFAULT, styleEffect, normalizeStylize } from '../../model/stylize.js';
import { aiAvailable } from '../../media/tts.js';
import { RESTYLE_STYLES, RESTYLE_PROMPT_MAX, fitSize, restylePicture, restyleFileName } from '../../media/restyle.js';
import { stackPreview } from '../panels/previews.js';
import { toast } from '../dialog.js';
import { defaultLength } from '../preferences-dialog.js';
import { choiceGrid, slider, propSection, note } from './common.js';
import '../../styles/avatar.css';

/** The clip's picture at timeline time (its own pixels and color, untransformed): { blob, width, height }. */
export async function clipPicture(ctx, clip, time) {
  const p = ctx.store.project;
  const asset = p.assets[clip.assetId];
  if (!asset) throw new Error('This clip has no media.');
  const size = fitSize(asset.width || p.settings.width, asset.height || p.settings.height);
  const w = Math.max(16, Math.round(size.w / 2) * 2);
  const hh = Math.max(16, Math.round(size.h / 2) * 2);
  const one = structuredClone(clip);
  Object.assign(one, { start: 0, transform: { ...DEFAULT_TRANSFORM }, opacity: 1, blend: 'normal', animIn: null, animOut: null, animLoop: null, keyframes: {}, transition: null });
  for (const k of ['stylize', 'effects', 'masks', 'group', 'disabled', 'parent', 'canvas', 'motionBlur']) delete one[k];
  const local = Math.min(Math.max(0, time - clip.start), Math.max(0, clip.duration - 1000));
  const project = { ...p, settings: { ...p.settings, width: w, height: hh, background: { type: 'color', color: '#000000', blur: 0 } }, tracks: [makeTrack('video', { main: true, clips: [one] })], markers: [] };
  delete project.range;
  const { renderStill } = await import('../../engine/exporter.js');
  const bmp = await renderStill(project, ctx.library, local, { maxWidth: w });
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not capture the picture.');
  return { blob, width: c.width, height: c.height };
}

function services(ctx) {
  return {
    picture: (clip, time) => clipPicture(ctx, clip, time),
    restyle: (picture, opts) => restylePicture(picture, opts),
    ...ctx.restyleServices,
  };
}

/** Put a restyled picture on an overlay track over the clip it came from (or at the playhead for a video frame). */
export function addRestyledClip(ctx, sourceId, asset) {
  const { store } = ctx;
  const src = T.findClip(store.project, sourceId)?.clip;
  const still = src?.type === 'image';
  const clip = makeClip('image', {
    assetId: asset.id,
    name: asset.name,
    start: still ? src.start : store.time,
    duration: still ? src.duration : Math.max(T.MIN_CLIP, defaultLength.image()),
  });
  if (src) clip.transform = { ...src.transform };
  const ok = store.update('Add restyled picture', (p) => {
    T.addClip(p, clip, { ...store.opts, main: false });
  });
  if (!ok) return null;
  store.select(clip.id);
  return clip;
}

/** Show the restyled picture in an image clip instead of its own (one undo step). */
export function replacePicture(ctx, clipId, asset) {
  return ctx.actions.editClip(clipId, 'Replace with restyled picture', (c) => {
    if (c.type !== 'image') return false;
    c.assetId = asset.id;
    c.name = asset.name;
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

function restyleSection(view) {
  const { ctx, store } = view;
  if (!aiAvailable(ctx)) {
    const btn = ctx.account?.onSignIn ? h('button.btn.small', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 14), 'Sign in to Puter') : null;
    return propSection('AI restyle', [note('AI restyle redraws the picture with Puter AI, so it needs a Puter account.', 'user'), btn]);
  }
  let style = null;
  let busy = false;
  let result = null; // { blob, url, styleId, assetId }
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
    if (result) URL.revokeObjectURL(result.url);
    result = null;
    out.replaceChildren();
  };

  async function toMedia() {
    if (result.assetId && store.project.assets[result.assetId]) return store.project.assets[result.assetId];
    const c = view.clip;
    const file = new File([result.blob], restyleFileName(c?.name || store.project.assets[c?.assetId]?.name, result.styleId, result.blob.type || 'image/png'), { type: result.blob.type || 'image/png' });
    const [asset] = await ctx.actions.importFiles([file], { origin: 'restyle' });
    if (!asset) throw new Error("Couldn't add the picture to your media.");
    result.assetId = asset.id;
    return asset;
  }

  function renderResult() {
    if (!result) return;
    const c = view.clip;
    const add = h('button.btn.primary', { type: 'button' }, icon('plus', 14), 'Add as clip');
    const replace = c?.type === 'image' ? h('button.btn', { type: 'button' }, icon('replace', 14), 'Replace picture') : null;
    const save = h('button.btn', { type: 'button' }, icon('import', 14), 'Save to media');
    const drop = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Discard result', 'data-tip': 'Discard' }, icon('close', 14));
    const id = view.id;
    const act = (fn, done) => async () => {
      try {
        const asset = await toMedia();
        fn(asset);
        announce(done);
      } catch (err) {
        toast(err?.message || "Couldn't use the picture.", { kind: 'error' });
      }
    };
    add.addEventListener('click', act((asset) => addRestyledClip(ctx, id, asset), 'Restyled picture added'));
    replace?.addEventListener('click', act((asset) => replacePicture(ctx, id, asset), 'Picture replaced'));
    save.addEventListener('click', act(() => save.replaceChildren(icon('check', 14), 'In media'), 'Saved to media'));
    drop.addEventListener('click', clearResult);
    out.replaceChildren(h('img', { src: result.url, alt: 'Restyled picture' }), h('div.restyle-actions', add, replace, save, drop));
  }

  go.addEventListener('click', async () => {
    const c = view.clip;
    if (!c || busy) return;
    busy = true;
    sync();
    const svc = services(ctx);
    try {
      status.replaceChildren(h('span.spinner'), c.type === 'video' ? 'Capturing the frame...' : 'Preparing the picture...');
      const picture = await svc.picture(c, store.time);
      status.replaceChildren(h('span.spinner'), 'Restyling... this can take a little while.');
      const { blob } = await svc.restyle(picture, { prompt: prompt.value, style });
      clearResult();
      result = { blob, url: URL.createObjectURL(blob), styleId: style, assetId: null };
      renderResult();
      status.textContent = 'Done. Add it as a clip, replace the picture, or save it to your media.';
      announce('Restyled picture ready');
    } catch (err) {
      status.replaceChildren();
      toast(err?.message || "Couldn't restyle the picture.", { kind: 'error' });
    }
    busy = false;
    sync();
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
  return propSection('AI restyle', [what, h('div.restyle-chips', { role: 'group', 'aria-label': 'Styles' }, chips), prompt, h('div.tts-actions', go), status, out]);
}

export function stylizeTab(view) {
  return h('div.stylize-tab', looksSection(view), restyleSection(view));
}
