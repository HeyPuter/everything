/**
 * Extra controls of the Video > Basic tab: uniform scale (separate Scale X /
 * Scale Y when off), the align-to-frame buttons, and the per-clip picture
 * sections (motion blur, noise reduction, enhance quality, relight, canvas), each with an on
 * checkbox in its header. Values live in model/clip-extras.js.
 */
import '../../styles/masks.css';
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { evaluate } from '../../engine/scene.js';
import { EXTRA_DEFAULTS, CANVAS_TYPES, ALIGN_EDGES, alignPosition, fitBox, upscaleFactor } from '../../model/clip-extras.js';
import { segmented } from '../controls.js';
import { slider, propSection, toggle, color, uidFor, row, note } from './common.js';

/** Box size (project px) of the clip at its current keyed scale, without animations. */
export function clipBoxSize(view) {
  const c = view.clip;
  const { width: W, height: H } = view.project.settings;
  let base;
  if (c.type === 'video' || c.type === 'image') {
    const a = view.project.assets[c.assetId];
    base = fitBox(a?.width || W, a?.height || H, c.crop, W, H);
  } else {
    const m = view.ctx.player?.text?.measure?.(c);
    base = { w: m?.projW || 100, h: m?.projH || 100 };
  }
  const s = view.valueOf('scale');
  return { w: base.w * s * view.valueOf('sx'), h: base.h * s * view.valueOf('sy') };
}

/** Uniform scale switch plus Scale X / Scale Y sliders shown when it is off. */
export function scaleFields(view) {
  const sx = slider(view, {
    label: 'Scale X', min: 1, max: 500, hardMax: 5000, unit: '%', prop: 'sx',
    get: () => Math.round(view.valueOf('sx') * 100),
    set: (v, final) => view.animate('sx', Math.max(0.01, v / 100), { label: 'Scale X', final }),
  });
  const sy = slider(view, {
    label: 'Scale Y', min: 1, max: 500, hardMax: 5000, unit: '%', prop: 'sy',
    get: () => Math.round(view.valueOf('sy') * 100),
    set: (v, final) => view.animate('sy', Math.max(0.01, v / 100), { label: 'Scale Y', final }),
  });
  const uniform = toggle(view, {
    label: 'Uniform scale',
    get: (c) => c?.transform?.uniform !== false,
    set: (on) => {
      view.edit(on ? 'Uniform scale' : 'Separate X and Y scale', (c) => {
        if (on) {
          // Back to one scale: the stretch goes away.
          delete c.transform.uniform;
          delete c.transform.sx;
          delete c.transform.sy;
          delete c.keyframes?.sx;
          delete c.keyframes?.sy;
        } else c.transform.uniform = false;
      });
      announce(on ? 'Uniform scale on' : 'Scale X and Y can now differ');
    },
  });
  const sync = () => {
    const off = view.clip?.transform?.uniform === false;
    sx.el.hidden = !off;
    sy.el.hidden = !off;
  };
  sync();
  view.bind(sync);
  return [uniform.el, sx.el, sy.el];
}

/** Row of buttons that put the clip against a frame edge or center it. */
export function alignRow(view) {
  const buttons = ALIGN_EDGES.map((e) => {
    const b = h('button.icon-btn.press-btn', { type: 'button', 'aria-label': e.label, 'data-tip': e.label, 'data-align': e.id }, icon(e.icon, 16));
    b.addEventListener('click', () => {
      const c = view.clip;
      if (!c) return;
      const { width: W, height: H } = view.project.settings;
      const box = boxFromPlayer(view) || clipBoxSize(view);
      const patch = alignPosition(e.id, box.w, box.h, view.valueOf('rotation'), W, H);
      const [prop, value] = Object.entries(patch)[0];
      view.animate(prop, value, { label: e.label });
      announce(e.label);
    });
    return b;
  });
  const group = h('div.insp-tools.align-tools', { role: 'group', 'aria-label': 'Align to frame' }, ...buttons.slice(0, 3), h('span.align-sep', { 'aria-hidden': 'true' }), ...buttons.slice(3));
  return row('Align', group);
}

/** The clip's box as the player measures it (text sizes come from the renderer), at keyed values. */
function boxFromPlayer(view) {
  const player = view.ctx.player;
  if (!player?.boxFor) return null;
  const c = view.clip;
  const t = Math.min(c.start + c.duration - 1, Math.max(c.start, view.store.time));
  const layers = evaluate(view.project, t, { includeHidden: true }).flatMap((l) => (l.kind === 'transition' ? [l.from, l.to] : [l]));
  const layer = layers.find((l) => l.clip?.id === c.id);
  if (!layer) return null;
  // Measure at the keyed (not animated) scale so align ignores in/out animations.
  const b = player.boxFor({ ...layer, scale: view.valueOf('scale'), sx: view.valueOf('sx'), sy: view.valueOf('sy') });
  return b ? { w: b.w, h: b.h } : null;
}

/**
 * Section whose header checkbox turns clip[key].on on or off (creating the
 * settings with defaults on first use).
 */
function extraSection(view, { key, title, children, hint, actions = null }) {
  const el = propSection(title, children, {
    open: false,
    actions,
    onReset: () => {
      view.edit(`Reset ${title.toLowerCase()}`, (c) => {
        c[key] = { ...EXTRA_DEFAULTS[key], on: c[key]?.on ?? true };
        if (key === 'relight') {
          delete c.keyframes?.['relight.angle'];
          delete c.keyframes?.['relight.intensity'];
        }
        if (key === 'enhance') delete c.keyframes?.['enhance.strength'];
      });
      announce(`${title} reset`);
    },
  });
  el.classList.add('grade-section', 'extra-section');
  const box = h('input.section-check', { type: 'checkbox', id: uidFor('on'), 'aria-label': `Apply ${title.toLowerCase()}`, 'data-tip': 'Turn on or off' });
  box.addEventListener('change', () => {
    const on = box.checked;
    view.edit(on ? `Turn on ${title.toLowerCase()}` : `Turn off ${title.toLowerCase()}`, (c) => {
      c[key] = { ...EXTRA_DEFAULTS[key], ...c[key], on };
    });
    // Opening a section by turning it on shows its settings.
    const toggleBtn = el.querySelector('.section-toggle');
    if (on && toggleBtn?.getAttribute('aria-expanded') === 'false') toggleBtn.click();
  });
  el.querySelector('.section-head').prepend(box);
  const body = el.querySelector('.section-body');
  if (hint) body.prepend(note(hint));
  const sync = () => {
    const on = Boolean(view.clip?.[key]?.on);
    if (box.checked !== on) box.checked = on;
    body.classList.toggle('is-off', !on);
  };
  sync();
  view.bind(sync);
  return el;
}

/** Edit one value of clip[key], creating the settings (on) when missing. */
function setExtra(view, key, label, field, value, final) {
  return view.edit(label, (c) => {
    c[key] = { ...EXTRA_DEFAULTS[key], ...c[key], [field]: value };
  }, { key: `${key}-${field}`, final });
}

const extraValue = (key, field) => (c) => c?.[key]?.[field] ?? EXTRA_DEFAULTS[key][field];

export function motionBlurSection(view) {
  const amount = slider(view, {
    label: 'Amount', min: 0, max: 100,
    get: (c) => Math.round(extraValue('motionBlur', 'amount')(c)),
    set: (v, final) => setExtra(view, 'motionBlur', 'Motion blur', 'amount', v, final),
  });
  return extraSection(view, { key: 'motionBlur', title: 'Motion blur', children: [amount.el], hint: 'Blurs the clip along its own movement (keyframes and animations).' });
}

export function denoiseSection(view) {
  const strength = slider(view, {
    label: 'Strength', min: 0, max: 100,
    get: (c) => Math.round(extraValue('denoise', 'strength')(c)),
    set: (v, final) => setExtra(view, 'denoise', 'Reduce noise', 'strength', v, final),
  });
  return extraSection(view, { key: 'denoise', title: 'Reduce image noise', children: [strength.el] });
}

/**
 * Enhance quality: crisper soft or small footage (sharpening that adapts to
 * the picture, a little local detail, better upscaling). Strength is
 * keyframable. Notes when the source is smaller than the project frame.
 */
export function enhanceSection(view) {
  const strength = slider(view, {
    label: 'Strength', min: 0, max: 100, prop: 'enhance.strength',
    get: () => Math.round(view.clip?.enhance ? view.valueOf('enhance.strength') : EXTRA_DEFAULTS.enhance.strength),
    set: (v, final) => {
      if (!view.clip?.enhance) setExtra(view, 'enhance', 'Enhance quality', 'strength', v, final);
      else view.animate('enhance.strength', v, { label: 'Enhance quality', final });
    },
  });
  const small = h('p.insp-note.enhance-small', { hidden: true }, icon('info', 14), h('span'));
  const sync = () => {
    const c = view.clip;
    const a = c && view.project.assets[c.assetId];
    const { width: W, height: H } = view.project.settings;
    const up = a ? upscaleFactor(a.width, a.height, W, H) : 0;
    small.hidden = !(up > 1.05);
    if (!small.hidden) small.lastChild.textContent = `This ${c.type === 'image' ? 'picture' : 'video'} is ${a.width} × ${a.height}, smaller than the ${W} × ${H} frame. Enhance helps it stay sharp when it is enlarged.`;
  };
  sync();
  view.bind(sync);
  return extraSection(view, {
    key: 'enhance',
    title: 'Enhance quality',
    children: [strength.el, small],
    hint: 'Makes soft or low resolution footage look crisper: sharpens detail without halos and enlarges small sources more cleanly.',
  });
}

/** Keyframable relight value: a key at the playhead when keyed, else the setting. */
function relightSlider(view, field, opts) {
  const prop = `relight.${field}`;
  return slider(view, {
    ...opts,
    prop,
    get: () => Math.round(view.clip?.relight ? view.valueOf(prop) : EXTRA_DEFAULTS.relight[field]),
    set: (v, final) => {
      if (!view.clip?.relight) setExtra(view, 'relight', 'Relight', field, v, final);
      else view.animate(prop, v, { label: 'Relight', final });
    },
  });
}

export function relightSection(view) {
  const angle = relightSlider(view, 'angle', { label: 'Light from', min: -180, max: 180, unit: '°', className: 'centered' });
  const intensity = relightSlider(view, 'intensity', { label: 'Intensity', min: 0, max: 100 });
  const temp = slider(view, {
    label: 'Temperature', min: -100, max: 100, className: 'centered track-temp',
    get: (c) => Math.round(extraValue('relight', 'temperature')(c)),
    set: (v, final) => setExtra(view, 'relight', 'Relight', 'temperature', v, final),
  });
  return extraSection(view, { key: 'relight', title: 'Relight', children: [angle.el, intensity.el, temp.el], hint: 'A soft light from one side. 0° is from the right, 90° from the top.' });
}

export function canvasSection(view) {
  const type = segmented({
    label: 'Fill',
    options: CANVAS_TYPES.map((t) => ({ value: t.id, label: t.label })),
    value: extraValue('canvas', 'type')(view.clip),
    onChange: (v) => setExtra(view, 'canvas', 'Canvas fill', 'type', v, true),
  });
  const c1 = color(view, { label: 'Color', get: extraValue('canvas', 'color'), set: (v, final) => setExtra(view, 'canvas', 'Canvas color', 'color', v, final) });
  const c2 = color(view, { label: 'Second color', get: extraValue('canvas', 'color2'), set: (v, final) => setExtra(view, 'canvas', 'Canvas color', 'color2', v, final) });
  const angle = slider(view, {
    label: 'Angle', min: 0, max: 360, unit: '°',
    get: (c) => Math.round(extraValue('canvas', 'angle')(c)),
    set: (v, final) => setExtra(view, 'canvas', 'Canvas gradient', 'angle', v, final),
  });
  const blur = slider(view, {
    label: 'Blur', min: 0, max: 100,
    get: (c) => Math.round(extraValue('canvas', 'blur')(c)),
    set: (v, final) => setExtra(view, 'canvas', 'Canvas blur', 'blur', v, final),
  });
  const all = h('button.btn.small.ghost', { type: 'button', 'data-tip': 'Use this canvas for every video and image clip' }, 'Apply to all');
  all.addEventListener('click', (e) => {
    e.stopPropagation();
    const src = view.clip?.canvas || { ...EXTRA_DEFAULTS.canvas };
    let n = 0;
    view.store.update('Apply canvas to all', (p) => {
      for (const track of p.tracks) {
        if (track.locked) continue;
        for (const c of track.clips) {
          if (c.type !== 'video' && c.type !== 'image') continue;
          c.canvas = { ...src, on: true };
          n++;
        }
      }
      return n > 0;
    }, { structural: false });
    announce(`Canvas applied to ${n} clip${n === 1 ? '' : 's'}`);
  });
  const sync = () => {
    const t = extraValue('canvas', 'type')(view.clip);
    type.set(t);
    c1.el.hidden = t === 'blur';
    c2.el.hidden = t !== 'gradient';
    angle.el.hidden = t !== 'gradient';
    blur.el.hidden = t !== 'blur';
  };
  sync();
  view.bind(sync);
  return extraSection(view, {
    key: 'canvas',
    title: 'Canvas',
    actions: all,
    children: [h('div.field.insp-row', h('span.field-label', 'Fill'), type.el), c1.el, c2.el, angle.el, blur.el],
    hint: 'Fills the frame behind this clip where it does not cover it.',
  });
}

/** All per-clip picture sections of Video > Basic. */
export function pictureSections(view) {
  return [motionBlurSection(view), denoiseSection(view), enhanceSection(view), relightSection(view), canvasSection(view)];
}

