/**
 * Video > Retouch, for people in the shot (model/retouch.js), in segments:
 *  - Face: skin smoothing, even tone, brighten and sharpening, blemish, dark
 *    circle and teeth fixes placed by face landmarks, and a gentle reshape
 *    of the face, eyes, nose, smile and chin
 *  - Body: slimmer body and waist, longer legs, head size, shoulder width
 *    and slimmer arms, placed by pose landmarks
 *  - Makeup: lips, eyes (eyeshadow, eyeliner, brow tint) and cheeks (blush,
 *    contour, highlight), each with an amount and its own shades
 *  - Hair: a new hair color that keeps the hair's own light and shade
 *  - Looks: one-click looks that set several of these at once, and the
 *    user's own saved looks (model/retouch-looks.js)
 * Each part is stored once a slider moves; its Reset removes it. Models
 * load the first time a tool that needs them is used.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { slider, color, propSection, tabSet, choiceGrid } from './common.js';
import { segmented } from '../controls.js';
import { toast, promptDialog, confirmDialog } from '../dialog.js';
import {
  LIP_COLOR_DEFAULT, LIP_SWATCHES, FACE_SHAPE_DEFAULT, HAIR_COLOR_DEFAULT, HAIR_SWATCHES, BODY_SHAPE_DEFAULT, MAKEUP_PARTS,
  normalizeRetouch, retouchAmounts, skinFixAmounts, normalizeFaceShape, faceShapeAmounts, normalizeHairColor, hairColorOn,
  normalizeBodyShape, bodyShapeAmounts, normalizeMakeup, makeupAmounts, faceModelsFor,
} from '../../model/retouch.js';
import { RETOUCH_LOOKS, applyLook, lookMatches, hasRetouch } from '../../model/retouch-looks.js';
import { userLooks, saveLook, renameLook, removeLook, onLooksChanged } from '../retouch-looks.js';
import { ready, segmenterState, segmenterError, onSegmenterChange } from '../../media/segmenter.js';
import { faceModelReady, faceModelState, faceModelError, onFaceModelChange } from '../../media/face-landmarks.js';
import { hairModelReady, hairModelState, hairModelError, onHairModelChange } from '../../media/hair-segmenter.js';
import { poseModelReady, poseModelState, poseModelError, onPoseModelChange } from '../../media/pose-landmarks.js';

const SKIN = [
  { key: 'smooth', label: 'Smooth skin' },
  { key: 'even', label: 'Even tone' },
  { key: 'brighten', label: 'Brighten' },
  { key: 'sharpen', label: 'Sharpen' },
];
const FIXES = [
  { key: 'blemishes', label: 'Blemishes' },
  { key: 'darkCircles', label: 'Dark circles' },
  { key: 'teeth', label: 'Whiten teeth' },
];
const SHAPE = [
  { key: 'slim', label: 'Slimmer face' },
  { key: 'eyes', label: 'Eye size' },
  { key: 'nose', label: 'Slimmer nose' },
  { key: 'smile', label: 'Smile' },
  { key: 'chin', label: 'Chin length' },
];
const BODY = [
  { key: 'slim', label: 'Slimmer body' },
  { key: 'waist', label: 'Slimmer waist' },
  { key: 'legs', label: 'Longer legs', min: 0 },
  { key: 'head', label: 'Head size' },
  { key: 'shoulders', label: 'Shoulder width' },
  { key: 'arms', label: 'Slimmer arms' },
];
const part = (key) => MAKEUP_PARTS.find((p) => p.key === key);

/** Status line for a model: loading text while it loads, its error if it fails. */
const modelStatus = (state, error, loading) => (state === 'loading' ? loading : state === 'failed' ? error : '');

/** Keep a panel in step with a model; the listener drops itself once the panel is gone. */
function follow(el, subscribe, render) {
  const off = subscribe(() => {
    if (!el.isConnected) off();
    else render();
  });
}

/** Start loading every model a clip's retouch needs. */
function loadModelsFor(clip) {
  const n = faceModelsFor(clip);
  if (retouchAmounts(clip?.retouch)) ready();
  if (n.face) faceModelReady();
  if (n.hair) hairModelReady();
  if (n.pose) poseModelReady();
}

/**
 * A row of round shade swatches (a radio group) ending in a custom color
 * well. onPick(hex, final) runs for both; set(hex, on) marks the shade
 * shown (none while the part is off).
 */
function swatchRow({ label, swatches, onPick }) {
  const btns = swatches.map((s) => {
    const b = h('button.marker-swatch', { type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': s.label, 'data-tip': s.label, style: { '--swatch': s.color } });
    b.addEventListener('click', () => {
      onPick(s.color, true);
      announce(`${label} ${s.label}`);
    });
    return b;
  });
  const custom = h('input.swatch-custom', { type: 'color', value: swatches[0].color, 'aria-label': `${label} custom color`, 'data-tip': 'Custom color' });
  custom.addEventListener('input', () => onPick(custom.value, false));
  custom.addEventListener('change', () => onPick(custom.value, true));
  const el = h('div.marker-swatches.retouch-swatches', h('div.retouch-swatch-group', { role: 'radiogroup', 'aria-label': `${label} shades` }, btns), custom);
  return {
    el,
    set(hex, on) {
      btns.forEach((b, i) => b.setAttribute('aria-checked', String(on && swatches[i].color === hex)));
      if (document.activeElement !== custom && hex) custom.value = hex;
    },
  };
}

/* Face ----------------------------------------------------------------------- */

function skinSection(view) {
  const edit = (label, key, patch, final) => view.edit(label, (c) => {
    c.retouch = normalizeRetouch({ ...c.retouch, ...patch });
  }, { key: `retouch-${key}`, final });
  const field = (f, needsFace) => slider(view, {
    label: f.label,
    min: 0,
    max: 100,
    get: (c) => Math.round(c.retouch?.[f.key] || 0),
    set: (v, final) => {
      edit('Retouch', f.key, { [f.key]: v }, final);
      if (v > 0) (needsFace ? faceModelReady : ready)();
    },
  });
  const sliders = SKIN.map((f) => field(f, false));
  const fixes = FIXES.map((f) => field(f, true));
  const status = h('p.asset-hint.cutout-status', { role: 'status' });
  const tip = h('p.asset-hint', 'Works on the skin of people in the shot; the background is left alone. The fixes below the line find faces first.');
  const render = () => {
    const c = view.clip;
    if (!c) return;
    const basic = retouchAmounts(c.retouch) ? modelStatus(segmenterState(), segmenterError(), 'Finding people in the shot...') : '';
    const face = skinFixAmounts(c.retouch) ? modelStatus(faceModelState(), faceModelError(), 'Finding faces...') : '';
    status.textContent = basic || face;
    status.hidden = !status.textContent;
  };
  render();
  view.bind(render);
  const el = propSection('Skin', [
    ...sliders.map((s) => s.el),
    h('hr.retouch-rule', { 'aria-hidden': 'true' }),
    ...fixes.map((s) => s.el),
    status,
    tip,
  ], {
    onReset: () => {
      // Lip color lives with the skin fixes but belongs to Makeup, so it stays.
      view.edit('Reset skin retouch', (c) => {
        if (!c.retouch) return false;
        const { lips, lipColor } = c.retouch;
        if (lips) c.retouch = normalizeRetouch({ lips, lipColor });
        else delete c.retouch;
      });
      announce('Skin retouch reset');
    },
  });
  follow(el, onSegmenterChange, render);
  follow(el, onFaceModelChange, render);
  return el;
}

function faceSection(view) {
  const cur = (c) => c.faceShape || FACE_SHAPE_DEFAULT;
  const edit = (label, key, patch, final) => view.edit(label, (c) => {
    c.faceShape = normalizeFaceShape({ ...cur(c), ...patch });
  }, { key: `face-${key}`, final });
  const which = segmented({
    label: 'Which faces',
    options: [{ value: 'all', label: 'All faces' }, { value: 'largest', label: 'Largest face' }],
    value: cur(view.clip || {}).faces,
    onChange: (v) => edit('Which faces', 'faces', { faces: v }, true),
  });
  view.bind(() => {
    const c = view.clip;
    if (c) which.set(cur(c).faces);
  });
  const sliders = SHAPE.map((f) => slider(view, {
    label: f.label,
    min: -100,
    max: 100,
    get: (c) => Math.round(c.faceShape?.[f.key] || 0),
    set: (v, final) => {
      edit('Face shape', f.key, { [f.key]: v }, final);
      if (v) faceModelReady();
    },
  }));
  const status = h('p.asset-hint.cutout-status', { role: 'status' });
  const tip = h('p.asset-hint', 'Small amounts look most natural. Negative values go the other way (fuller face, smaller eyes, a frown).');
  const render = () => {
    const c = view.clip;
    if (!c) return;
    status.textContent = faceShapeAmounts(c.faceShape) ? modelStatus(faceModelState(), faceModelError(), 'Finding faces...') : '';
    status.hidden = !status.textContent;
  };
  render();
  view.bind(render);
  const el = propSection('Face shape', [h('div.field', h('span.field-label', 'Which faces'), which.el), ...sliders.map((s) => s.el), status, tip], {
    onReset: () => {
      view.edit('Reset face shape', (c) => {
        if (!c.faceShape) return false;
        delete c.faceShape;
      });
      announce('Face shape reset');
    },
  });
  follow(el, onFaceModelChange, render);
  return el;
}

/* Body ----------------------------------------------------------------------- */

function bodySection(view) {
  const cur = (c) => c.bodyShape || BODY_SHAPE_DEFAULT;
  const edit = (label, key, patch, final) => view.edit(label, (c) => {
    c.bodyShape = normalizeBodyShape({ ...cur(c), ...patch });
  }, { key: `body-${key}`, final });
  const which = segmented({
    label: 'Which people',
    options: [{ value: 'all', label: 'Everyone' }, { value: 'largest', label: 'Largest person' }],
    value: cur(view.clip || {}).people,
    onChange: (v) => edit('Which people', 'people', { people: v }, true),
  });
  view.bind(() => {
    const c = view.clip;
    if (c) which.set(cur(c).people);
  });
  const sliders = BODY.map((f) => slider(view, {
    label: f.label,
    min: f.min ?? -100,
    max: 100,
    get: (c) => Math.round(c.bodyShape?.[f.key] || 0),
    set: (v, final) => {
      edit('Body shape', f.key, { [f.key]: v }, final);
      if (v) poseModelReady();
    },
  }));
  const status = h('p.asset-hint.cutout-status', { role: 'status' });
  const tip = h('p.asset-hint', 'Small amounts look most natural; negative values go the other way. Straight lines stay straight except right next to the body, and longer legs stretch the rows below the hips evenly.');
  const render = () => {
    const c = view.clip;
    if (!c) return;
    status.textContent = bodyShapeAmounts(c.bodyShape) ? modelStatus(poseModelState(), poseModelError(), 'Finding people in the shot...') : '';
    status.hidden = !status.textContent;
  };
  render();
  view.bind(render);
  const el = propSection('Body shape', [h('div.field', h('span.field-label', 'Which people'), which.el), ...sliders.map((s) => s.el), status, tip], {
    onReset: () => {
      view.edit('Reset body shape', (c) => {
        if (!c.bodyShape) return false;
        delete c.bodyShape;
      });
      announce('Body shape reset');
    },
  });
  follow(el, onPoseModelChange, render);
  return el;
}

/* Makeup --------------------------------------------------------------------- */

/** Amount slider and shades of one makeup part (clip.makeup). */
function makeupItem(view, p) {
  const edit = (label, patch, final) => {
    view.edit(label, (c) => {
      c.makeup = normalizeMakeup({ ...c.makeup, ...patch });
    }, { key: `makeup-${p.key}`, final });
    if (makeupAmounts(view.clip?.makeup)) faceModelReady();
  };
  const amount = slider(view, {
    label: p.label,
    min: 0,
    max: 100,
    get: (c) => Math.round(c.makeup?.[p.key] || 0),
    set: (v, final) => edit(p.label, { [p.key]: v }, final),
  });
  // A shade without an amount would do nothing, so picking one starts at a medium amount.
  const shades = swatchRow({ label: p.label, swatches: p.swatches, onPick: (hex, final) => edit(p.label, { [p.colorKey]: hex, [p.key]: view.clip?.makeup?.[p.key] || 50 }, final) });
  view.bind(() => {
    const c = view.clip;
    if (c) shades.set(c.makeup?.[p.colorKey] || p.color, (c.makeup?.[p.key] || 0) > 0);
  });
  return h('div.makeup-item', amount.el, shades.el);
}

function lipsSection(view) {
  const edit = (patch, final) => {
    view.edit('Lip color', (c) => {
      c.retouch = normalizeRetouch({ ...c.retouch, ...patch });
    }, { key: 'retouch-lips', final });
    if (view.clip?.retouch?.lips) faceModelReady();
  };
  const amount = slider(view, {
    label: 'Lip color',
    min: 0,
    max: 100,
    get: (c) => Math.round(c.retouch?.lips || 0),
    set: (v, final) => edit({ lips: v }, final),
  });
  const shades = swatchRow({ label: 'Lip color', swatches: LIP_SWATCHES, onPick: (hex, final) => edit({ lipColor: hex, lips: view.clip?.retouch?.lips || 50 }, final) });
  const picker = color(view, {
    label: 'Lip shade',
    get: (c) => c.retouch?.lipColor || LIP_COLOR_DEFAULT,
    set: (v, final) => edit({ lipColor: v, lips: view.clip?.retouch?.lips || 50 }, final),
  });
  view.bind(() => {
    const c = view.clip;
    if (c) shades.set(c.retouch?.lipColor || LIP_COLOR_DEFAULT, (c.retouch?.lips || 0) > 0);
  });
  return propSection('Lips', [h('div.makeup-item', amount.el, shades.el), picker.el], {
    onReset: () => {
      view.edit('Reset lip color', (c) => {
        if (!c.retouch || (!c.retouch.lips && !c.retouch.lipColor)) return false;
        const { lips, lipColor, ...rest } = c.retouch;
        if (retouchAmounts(rest) || skinFixAmounts(rest)) c.retouch = normalizeRetouch(rest);
        else delete c.retouch;
      });
      announce('Lip color reset');
    },
  });
}

/** A makeup group (Eyes, Cheeks): its parts, and a Reset that clears only them. */
function makeupGroup(view, title, keys) {
  const parts = keys.map(part);
  return propSection(title, parts.map((p) => makeupItem(view, p)), {
    onReset: () => {
      view.edit(`Reset ${title.toLowerCase()} makeup`, (c) => {
        if (!c.makeup || !parts.some((p) => p.key in c.makeup || p.colorKey in c.makeup)) return false;
        const rest = { ...c.makeup };
        for (const p of parts) {
          delete rest[p.key];
          delete rest[p.colorKey];
        }
        if (makeupAmounts(rest)) c.makeup = normalizeMakeup(rest);
        else delete c.makeup;
      });
      announce(`${title} makeup reset`);
    },
  });
}

function makeupSections(view) {
  const status = h('p.asset-hint.cutout-status', { role: 'status' });
  const render = () => {
    const c = view.clip;
    if (!c) return;
    status.textContent = makeupAmounts(c.makeup) || c.retouch?.lips ? modelStatus(faceModelState(), faceModelError(), 'Finding faces...') : '';
    status.hidden = !status.textContent;
  };
  render();
  view.bind(render);
  follow(status, onFaceModelChange, render);
  return [
    lipsSection(view),
    makeupGroup(view, 'Eyes', ['eyeshadow', 'eyeliner', 'brows']),
    makeupGroup(view, 'Cheeks', ['blush', 'contour', 'highlight']),
    status,
    h('p.asset-hint', 'Placed on each face the landmarks find and follows it as it moves. Pick a shade to start at a medium amount.'),
  ];
}

/* Hair ----------------------------------------------------------------------- */

function hairSection(view) {
  const cur = (c) => c.hairColor || HAIR_COLOR_DEFAULT;
  const edit = (label, key, patch, final) => {
    view.edit(label, (c) => {
      c.hairColor = normalizeHairColor({ ...cur(c), ...patch });
    }, { key: `hair-${key}`, final });
    if (hairColorOn(view.clip?.hairColor)) {
      faceModelReady();
      hairModelReady();
    }
  };
  // A color without strength would do nothing, so picking one starts at a medium strength.
  const pick = (hex, final) => edit('Hair color', 'color', { color: hex, strength: cur(view.clip).strength || 60 }, final);
  const swatches = h('div.marker-swatches.hair-swatches', { role: 'radiogroup', 'aria-label': 'Hair color presets' }, HAIR_SWATCHES.map((s) => {
    const b = h('button.marker-swatch', { type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': s.label, 'data-tip': s.label, style: { '--swatch': s.color } });
    b.addEventListener('click', () => {
      pick(s.color, true);
      announce(`Hair color ${s.label}`);
    });
    return b;
  }));
  const picker = color(view, { label: 'Hair color', get: (c) => cur(c).color, set: (v, final) => pick(v, final) });
  const strength = slider(view, {
    label: 'Strength',
    min: 0,
    max: 100,
    get: (c) => Math.round(cur(c).strength),
    set: (v, final) => edit('Hair color strength', 'strength', { strength: v }, final),
  });
  const status = h('p.asset-hint.cutout-status', { role: 'status' });
  const render = () => {
    const c = view.clip;
    if (!c) return;
    const col = cur(c).color;
    swatches.querySelectorAll('.marker-swatch').forEach((b, i) => b.setAttribute('aria-checked', String(HAIR_SWATCHES[i].color === col && hairColorOn(c.hairColor))));
    status.textContent = hairColorOn(c.hairColor) ? modelStatus(faceModelState(), faceModelError(), 'Finding faces...') || modelStatus(hairModelState(), hairModelError(), 'Finding hair...') : '';
    status.hidden = !status.textContent;
  };
  render();
  view.bind(render);
  const tip = h('p.asset-hint', 'Recolors the hair around each face in the shot.');
  const el = propSection('Hair', [h('div.field', h('span.field-label', 'Presets'), swatches), picker.el, strength.el, status, tip], {
    onReset: () => {
      view.edit('Reset hair color', (c) => {
        if (!c.hairColor) return false;
        delete c.hairColor;
      });
      announce('Hair color reset');
    },
  });
  follow(el, onHairModelChange, render);
  follow(el, onFaceModelChange, render);
  return el;
}

/* Looks ---------------------------------------------------------------------- */

/** Apply a look (null: none) to the clip as one undo step and load what it needs. */
function useLook(view, look, name) {
  const ok = view.edit(look ? `Apply look ${name}` : 'Remove retouch look', (c) => {
    if (!look && !hasRetouch(c)) return false;
    applyLook(c, look);
  });
  if (ok === false) return;
  loadModelsFor(view.clip);
  announce(look ? `${name} look applied` : 'Retouch removed');
}

/** An original little face swatch in a look's accent color. */
const lookPreview = (accent) => h('span.look-preview', { style: { '--look': accent }, 'aria-hidden': 'true' });

function looksSection(view) {
  const items = [{ id: null, label: 'None', preview: icon('close', 16) }, ...RETOUCH_LOOKS.map((l) => ({ id: l.id, label: l.label, preview: lookPreview(l.accent) }))];
  const grid = choiceGrid({
    label: 'Retouch looks',
    className: 'look-grid',
    items,
    value: undefined,
    onPick: (id) => {
      const look = RETOUCH_LOOKS.find((l) => l.id === id) || null;
      useLook(view, look, look?.label);
      render();
    },
  });
  grid.buttons.forEach((b, i) => {
    const look = RETOUCH_LOOKS[i - 1];
    if (look) b.setAttribute('data-tip', look.hint);
  });
  const render = () => {
    const c = view.clip;
    if (!c) return;
    const on = hasRetouch(c) ? RETOUCH_LOOKS.find((l) => lookMatches(c, l))?.id : null;
    // No tile is checked when the clip has a mix of its own.
    grid.buttons.forEach((b, i) => b.setAttribute('aria-checked', String(on === undefined ? false : (items[i].id ?? null) === on)));
  };
  render();
  view.bind(render);
  return propSection('Looks', [grid.el, h('p.asset-hint', 'Each look sets skin, face, body and makeup at once; fine-tune it in the other segments. Hair color is left as it is.')]);
}

function yourLooksSection(view) {
  const list = h('div.look-list', { role: 'list', 'aria-label': 'Your looks' });
  const empty = h('p.asset-hint', 'No looks of your own yet. Retouch a clip, then save it as a look.');
  const save = h('button.btn.small', { type: 'button', 'data-tip': 'Keep this clip\'s retouch to reuse it on other clips' }, icon('bookmark', 14), 'Save as look');
  save.addEventListener('click', async () => {
    const clip = view.clip;
    if (!clip || !(hasRetouch(clip) || hairColorOn(clip.hairColor))) {
      toast('Set some retouch first, then save it as a look.', { kind: 'info' });
      return;
    }
    const name = await promptDialog({ title: 'Save look', label: 'Look name', value: 'My look', confirm: 'Save', maxLength: 80 });
    if (!name) return;
    const look = saveLook(name, view.clip);
    if (look) toast(`Saved look "${look.name}". Find it under Retouch > Looks.`, { kind: 'success' });
  });
  const render = () => {
    const c = view.clip;
    if (!c) return;
    save.disabled = !(hasRetouch(c) || hairColorOn(c.hairColor));
    const looks = userLooks();
    list.hidden = !looks.length;
    empty.hidden = Boolean(looks.length);
    list.replaceChildren(...looks.map((l) => {
      const apply = h('button.btn.small.look-apply', { type: 'button', 'aria-pressed': String(lookMatches(c, l)) }, h('span.look-name', l.name));
      apply.addEventListener('click', () => {
        useLook(view, l, l.name);
        render();
      });
      const rename = h('button.icon-btn.small', { type: 'button', 'aria-label': `Rename ${l.name}`, 'data-tip': 'Rename' }, icon('pencil', 14));
      rename.addEventListener('click', async () => {
        const name = await promptDialog({ title: 'Rename look', label: 'Look name', value: l.name, confirm: 'Rename', maxLength: 80 });
        if (name) renameLook(l.id, name);
      });
      const del = h('button.icon-btn.small', { type: 'button', 'aria-label': `Delete ${l.name}`, 'data-tip': 'Delete' }, icon('trash', 14));
      del.addEventListener('click', async () => {
        if (await confirmDialog({ title: 'Delete look', message: `Delete the look "${l.name}"? Clips that use it keep their retouch.`, confirm: 'Delete', danger: true })) removeLook(l.id);
      });
      return h('div.look-row', { role: 'listitem' }, apply, rename, del);
    }));
  };
  render();
  view.bind(render);
  const el = propSection('Your looks', [list, empty], { actions: save });
  const off = onLooksChanged(() => {
    if (!el.isConnected) off();
    else render();
  });
  return el;
}

/* Segments ------------------------------------------------------------------- */

const SEGMENTS = [
  { id: 'face', label: 'Face', icon: 'retouch', make: (view) => [skinSection(view), faceSection(view)], on: (c) => Boolean(retouchAmounts(c.retouch) || skinFixAmounts({ ...c.retouch, lips: 0 }) || faceShapeAmounts(c.faceShape)) },
  { id: 'body', label: 'Body', icon: 'body', make: (view) => [bodySection(view)], on: (c) => Boolean(bodyShapeAmounts(c.bodyShape)) },
  { id: 'makeup', label: 'Makeup', icon: 'brush', make: makeupSections, on: (c) => Boolean(makeupAmounts(c.makeup) || c.retouch?.lips) },
  { id: 'hair', label: 'Hair', icon: 'scissors', make: (view) => [hairSection(view)], on: (c) => hairColorOn(c.hairColor) },
  { id: 'looks', label: 'Looks', icon: 'magic', make: (view) => [looksSection(view), yourLooksSection(view)], on: () => false },
];

/** The segment shown, kept across selections like the sub-tabs. */
let shown = 'face';

export function retouchTab(view) {
  const segs = tabSet({
    label: 'Retouch',
    className: 'retouch-segs',
    items: SEGMENTS,
    value: shown,
    onChange: (id) => {
      shown = id;
      show(id);
    },
  });
  // Icons, and a dot on the segments that change the clip.
  const marks = segs.list.querySelectorAll('.insp-tab');
  const dots = SEGMENTS.map((s, i) => {
    const dot = h('span.retouch-seg-dot', { 'aria-hidden': 'true', hidden: true });
    const sr = h('span.sr-only', '');
    marks[i].prepend(icon(s.icon, 14));
    marks[i].append(dot, sr);
    return { dot, sr };
  });
  const mark = () => {
    const c = view.clip;
    if (!c) return;
    SEGMENTS.forEach((s, i) => {
      const on = s.on(c);
      dots[i].dot.hidden = !on;
      dots[i].sr.textContent = on ? ' (in use)' : '';
    });
  };
  const show = (id) => {
    view.resetScope();
    view.bind(mark);
    segs.panel.replaceChildren(...SEGMENTS.find((s) => s.id === id).make(view));
    mark();
  };
  show(segs.current);
  return h('div.retouch-tab', segs.list, segs.panel);
}
