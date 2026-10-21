/**
 * Video > Cutout: automatic background removal. clip.cutout = { feather,
 * shrink, smooth } (model/cutout.js); the person matte is worked out on
 * this device, frame by frame, while the clip is drawn. Turning it off
 * removes the object; the panel remembers the last settings this session.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { openCutoutRefine } from '../cutout-refine.js';
import { slider, toggle, propSection } from './common.js';
import { CUTOUT_DEFAULT } from '../../model/cutout.js';
import { canvasSection } from './video-extras.js';
import { ready, segmenterState, segmenterError, onSegmenterChange } from '../../media/segmenter.js';
import { modelStatusLine } from './model-status.js';

const remembered = new Map();

export function cutoutTab(view) {
  const cur = (c) => c.cutout || remembered.get(c.id) || CUTOUT_DEFAULT;
  const setCutout = (label, key, fn, final) => view.edit(label, (c) => {
    if (!c.cutout) return false;
    fn(c.cutout);
    remembered.set(c.id, { ...c.cutout });
  }, { key: `cutout-${key}`, final });

  const enable = toggle(view, {
    label: 'Remove background',
    hint: 'Keeps the people in the shot and hides everything around them. Runs on this device.',
    get: (c) => Boolean(c.cutout),
    set: (on) => {
      view.edit(on ? 'Remove background' : 'Keep background', (c) => {
        if (on) c.cutout = { ...cur(c) };
        else {
          if (c.cutout) remembered.set(c.id, { ...c.cutout });
          delete c.cutout;
        }
      });
      if (on) ready();
      announce(on ? 'Background removal on' : 'Background removal off');
    },
  });

  const feather = slider(view, {
    label: 'Edge softness',
    min: 0,
    max: 100,
    get: (c) => Math.round(cur(c).feather),
    set: (v, final) => setCutout('Cutout edge softness', 'feather', (k) => (k.feather = v), final),
  });
  const shrink = slider(view, {
    label: 'Edge position',
    min: -50,
    max: 50,
    get: (c) => Math.round(cur(c).shrink),
    set: (v, final) => setCutout('Cutout edge position', 'shrink', (k) => (k.shrink = v), final),
  });
  const smooth = slider(view, {
    label: 'Steadiness',
    min: 0,
    max: 100,
    get: (c) => Math.round(cur(c).smooth),
    set: (v, final) => setCutout('Cutout steadiness', 'smooth', (k) => (k.smooth = v), final),
  });
  const refine = h('button.btn.small', { type: 'button' }, icon('brush', 14), 'Refine with brush...');
  refine.addEventListener('click', () => openCutoutRefine(view.ctx, view.id));
  const fixes = h('span.asset-hint.cutout-fixes');
  const clearFixes = h('button.btn.small.ghost', { type: 'button' }, 'Clear fixes');
  clearFixes.addEventListener('click', () => {
    setCutout('Clear cutout fixes', 'strokes', (k) => delete k.strokes, true);
    announce('Cutout fixes cleared');
  });
  const refineRow = h('div.cutout-refine', refine, fixes, clearFixes);
  const status = modelStatusLine();
  const tip = h('p.asset-hint', 'Works best with people in clear view. Raise Edge position to trim halos; lower it to keep loose hair. Turn on Canvas below to put a color, a gradient or a blurred copy of the shot behind them.');
  const params = h('div.chroma-params', feather.el, shrink.el, smooth.el, refineRow, tip);

  const render = () => {
    const c = view.clip;
    if (!c) return;
    const on = Boolean(c.cutout);
    params.classList.toggle('is-off', !on);
    params.querySelectorAll('input, button').forEach((el) => {
      el.disabled = !on;
    });
    const n = c.cutout?.strokes?.length || 0;
    fixes.textContent = n ? `${n} fix${n === 1 ? '' : 'es'}` : '';
    clearFixes.hidden = !n;
    const s = segmenterState();
    status.set(!on ? '' : s === 'loading' ? 'Getting background removal ready...' : s === 'failed' ? segmenterError() : '');
  };
  render();
  view.bind(render);
  const section = h('div', propSection('Background removal', [enable.el, status.el, params], {
    onReset: () => view.edit('Reset background removal', (c) => {
      if (c.cutout) c.cutout = { ...CUTOUT_DEFAULT };
      remembered.delete(c.id);
    }),
  }), canvasSection(view));
  // Model progress; the listener drops itself once this panel is gone.
  const off = onSegmenterChange(() => {
    if (!section.isConnected) off();
    else render();
  });
  return section;
}
