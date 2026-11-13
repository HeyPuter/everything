/**
 * Generate category of the Media tab: describe a picture, pick a frame
 * shape and a style, and Puter AI draws it. Results stay in a small strip
 * for this session; the chosen ones are imported as media.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { segmented } from '../controls.js';
import { toast } from '../dialog.js';
import { prefs, setPref } from '../prefs.js';
import { aiAvailable } from '../../media/tts.js';
import { IMAGE_ASPECTS, IMAGE_STYLES, PROMPT_MAX, aspectForSize, generateImage, imageFileName } from '../../media/imagegen.js';
import { emptyState } from './common.js';

const MAX_RESULTS = 8;

function signInHint(ctx) {
  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;
  return emptyState('user', 'Sign in to generate pictures', 'Picture generation runs on Puter AI, so it needs a Puter account.', btn);
}

/** getFolder() returns the media bin folder new pictures go into. */
export function generatePanel(ctx, { getFolder = () => null } = {}) {
  if (!aiAvailable(ctx)) return { el: signInHint(ctx), dispose() {} };
  const { store, actions } = ctx;
  const saved = prefs().generate || {};
  let aspect = IMAGE_ASPECTS.some((a) => a.id === saved.aspect) ? saved.aspect : aspectForSize(store.project.settings.width, store.project.settings.height).id;
  let style = IMAGE_STYLES.some((s) => s.id === saved.style) ? saved.style : 'none';
  let busy = false;
  const results = []; // { id, url, blob, prompt, assetId }
  const save = () => setPref('generate', { aspect, style });

  const text = h('textarea#gen-text.textarea.gen-text', { maxLength: PROMPT_MAX, rows: 4, placeholder: 'Describe the picture, e.g. a foggy pine forest at sunrise' });
  const aspects = segmented({
    label: 'Frame shape',
    options: IMAGE_ASPECTS.map((a) => ({ value: a.id, label: a.label })),
    value: aspect,
    onChange: (v) => {
      aspect = v;
      save();
    },
  });
  const styleSel = h('select#gen-style.select', IMAGE_STYLES.map((s) => h('option', { value: s.id, selected: s.id === style }, s.label)));
  styleSel.addEventListener('change', () => {
    style = styleSel.value;
    save();
  });
  const go = h('button.btn.primary', { type: 'button' }, icon('magic', 16), 'Generate');
  const status = h('p.tts-status', { role: 'status' });
  const strip = h('div.gen-results', { role: 'list', 'aria-label': 'Generated pictures' });

  const update = () => {
    go.disabled = busy || !text.value.trim();
  };
  text.addEventListener('input', update);
  text.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!go.disabled) go.click();
    }
  });

  async function importResult(r, { add }) {
    if (!r.assetId || !store.project.assets[r.assetId]) {
      const file = new File([r.blob], imageFileName(r.prompt, (r.blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')), { type: r.blob.type || 'image/png' });
      const [asset] = await actions.importFiles([file], { folder: getFolder(), origin: 'generate' });
      if (!asset) return;
      r.assetId = asset.id;
    }
    const asset = store.project.assets[r.assetId];
    if (add) actions.addAsset(asset);
    else announce(`Saved ${asset.name} to your media`);
    renderResults();
  }

  function renderResults() {
    strip.replaceChildren(...results.map((r) => {
      const saved = Boolean(r.assetId && store.project.assets[r.assetId]);
      const toMedia = h('button.btn.small', { type: 'button', disabled: saved }, icon(saved ? 'check' : 'import', 14), saved ? 'In media' : 'Save to media');
      const toTimeline = h('button.btn.small.primary', { type: 'button' }, icon('plus', 14), 'Add');
      const drop = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Discard picture', 'data-tip': 'Discard' }, icon('close', 14));
      toMedia.addEventListener('click', () => importResult(r, { add: false }).catch((err) => toast(err?.message || "Couldn't save the picture.", { kind: 'error' })));
      toTimeline.addEventListener('click', () => importResult(r, { add: true }).catch((err) => toast(err?.message || "Couldn't add the picture.", { kind: 'error' })));
      drop.addEventListener('click', () => {
        results.splice(results.indexOf(r), 1);
        URL.revokeObjectURL(r.url);
        renderResults();
      });
      return h('div.gen-card', { role: 'listitem' },
        h('img.gen-img', { src: r.url, alt: r.prompt, draggable: 'false' }),
        h('div.gen-card-actions', toMedia, toTimeline, drop),
      );
    }));
  }

  go.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    update();
    status.replaceChildren(h('span.spinner'), 'Creating the picture... this can take a little while.');
    try {
      const { blob, prompt } = await generateImage(text.value, { aspect, style });
      const r = { id: Math.random().toString(36).slice(2), blob, prompt, url: URL.createObjectURL(blob), assetId: null };
      results.unshift(r);
      while (results.length > MAX_RESULTS) URL.revokeObjectURL(results.pop().url);
      status.textContent = 'Done. Save it to your media or add it to the timeline.';
      announce('Picture created');
      renderResults();
    } catch (err) {
      status.replaceChildren();
      toast(err?.message || "Couldn't create the picture.", { kind: 'error' });
    } finally {
      busy = false;
      update();
    }
  });

  update();
  const el = h('div.gen-panel',
    h('div.field', h('label.field-label', { for: 'gen-text' }, 'Describe the picture'), text),
    h('div.field', h('span.field-label', { id: 'gen-aspect-label' }, 'Frame shape'), aspects.el),
    h('div.field', h('label.field-label', { for: 'gen-style' }, 'Style'), styleSel),
    h('div.tts-actions', go),
    status,
    strip,
  );
  aspects.el.setAttribute('aria-labelledby', 'gen-aspect-label');
  return {
    el,
    dispose() {
      for (const r of results) URL.revokeObjectURL(r.url);
    },
  };
}
