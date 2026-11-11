/**
 * Color > Basic: auto adjust, where the color applies (whole clip, people
 * or background), color match, LUT, and the Color, Light and Detail slider
 * groups. Every slider is keyframable ('adjust.<key>' keyframes).
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { clock } from '../../lib/time.js';
import { DEFAULT_ADJUST } from '../../model/project.js';
import { ADJUST_SECTIONS, adjustProp, ADJUST_PREFIX } from '../../model/color.js';
import { matchReferences } from '../../model/color-match.js';
import { clipLabel } from '../../model/timeline.js';
import { lutFailed } from '../../engine/luts.js';
import { sliderField, segmented } from '../controls.js';
import { ready } from '../../media/segmenter.js';
import { slider, row, uidFor, note, propSection, restoreFocus } from './common.js';
import { gradeSection, editGrade } from './color-common.js';
import { autoAdjust, chooseLutFiles, applyLut, savePreset, matchColor } from '../color-tools.js';
import { promptDialog, toast } from '../dialog.js';
import { prefs, setPref } from '../prefs.js';

function adjustSlider(view, { key, label, min = -100, track }) {
  const prop = adjustProp(key);
  return slider(view, {
    label,
    min,
    max: 100,
    prop,
    className: [min < 0 ? 'centered' : '', track ? `track-${track}` : ''].filter(Boolean).join(' '),
    get: () => Math.round(view.valueOf(prop)),
    set: (v, final) => view.animate(prop, v, { label: `Adjust ${label.toLowerCase()}`, final }),
  });
}

/** Zero a set of adjust keys and drop their keyframes. */
function resetKeys(c, keys) {
  c.adjust ||= { ...DEFAULT_ADJUST };
  for (const k of keys) {
    c.adjust[k] = 0;
    if (c.keyframes) delete c.keyframes[ADJUST_PREFIX + k];
  }
}

function lutSection(view) {
  const { library } = view.ctx;
  const id = uidFor('lut');
  const sel = h('select.select', { id });
  const missing = h('p.insp-note.lut-missing', { hidden: true }, icon('warning', 14), h('span', 'This LUT file is not in your library, so it is not applied. Import it again to use it.'));
  let entries = [];
  const render = () => {
    const cur = view.clip?.grade?.lut || null;
    const known = cur && entries.some((e) => e.id === cur.id);
    sel.replaceChildren(
      h('option', { value: '' }, 'None'),
      ...entries.map((e) => h('option', { value: e.id }, e.name)),
      cur && !known ? h('option', { value: cur.id }, `${cur.name} (missing)`) : null,
      h('option', { value: '__import' }, 'Import .cube file...'),
    );
    sel.value = cur?.id || '';
    missing.hidden = !(cur && (!known || lutFailed(cur.id)) && library);
  };
  const load = () => library?.listLuts().then((list) => {
    entries = list;
    render();
  }).catch(() => {});
  load();
  if (library) {
    const off = library.on('luts', (list) => {
      if (!sel.isConnected) {
        off();
        return;
      }
      entries = list;
      render();
    });
  }
  sel.addEventListener('change', async () => {
    const v = sel.value;
    if (v === '__import') {
      render();
      if (!library) return;
      const made = await chooseLutFiles(view.ctx);
      if (made[0]) applyLut(view.ctx, view.id, made[0]);
      return;
    }
    applyLut(view.ctx, view.id, v ? entries.find((e) => e.id === v) || view.clip?.grade?.lut : null);
  });
  const intensity = slider(view, {
    label: 'Intensity',
    min: 0,
    max: 100,
    get: (c) => Math.round(c.grade?.lut?.intensity ?? 100),
    set: (v, final) => editGrade(view, 'LUT intensity', (g) => {
      if (!g.lut) return false;
      g.lut.intensity = v;
    }, { key: 'lut-intensity', final }),
  });
  const sync = () => {
    render();
    intensity.el.hidden = !view.clip?.grade?.lut;
  };
  sync();
  view.bind(() => {
    // With focus on the picker, its options stay (rebuilding them could close it); it still
    // shows the clip's LUT (undo, another panel) when that is one of them.
    if (document.activeElement !== sel) {
      sync();
      return;
    }
    const cur = view.clip?.grade?.lut?.id || '';
    if (sel.value !== cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    intensity.el.hidden = !view.clip?.grade?.lut;
  });
  return gradeSection(view, {
    id: 'lut',
    title: 'LUT',
    children: [row('Look', sel, { id }), intensity.el, missing],
    onReset: () => applyLut(view.ctx, view.id, null),
  });
}

/**
 * Match color: pick another clip and make this one look like it. The
 * result lands in the Light and Color sliders (and the luma curve), so the
 * section resets and undo take it back.
 */
function matchSection(view) {
  const { store } = view.ctx;
  const id = uidFor('match');
  const sel = h('select.select', { id });
  const go = h('button.btn.small.block', { type: 'button', 'data-tip': 'Set the light and color sliders so this clip looks like the chosen one' }, icon('palette', 14), 'Match');
  let sig = '';
  const render = () => {
    const refs = matchReferences(store.project, view.id);
    const name = (c) => clipLabel(store.project, c);
    const next = JSON.stringify([refs.before?.id, refs.below?.id, refs.all.map((c) => [c.id, name(c), c.start])]);
    if (next === sig) return;
    sig = next;
    const keep = sel.value;
    sel.replaceChildren(
      refs.before ? h('option', { value: refs.before.id }, `Clip before: ${name(refs.before)}`) : null,
      refs.below ? h('option', { value: refs.below.id }, `Clip below: ${name(refs.below)}`) : null,
      refs.all.length
        ? h('optgroup', { label: 'All video and photo clips' }, refs.all.map((c) => h('option', { value: c.id }, `${name(c)} at ${clock(c.start)}`)))
        : h('option', { value: '', disabled: true }, 'No other video or photo clips'),
    );
    if (keep && refs.all.some((c) => c.id === keep)) sel.value = keep;
    sel.disabled = !refs.all.length;
    go.disabled = !refs.all.length;
  };
  let strength = Number(prefs().matchStrength ?? 100);
  const amount = sliderField({
    label: 'Strength',
    min: 0,
    max: 100,
    value: strength,
    onInput: (v, final) => {
      strength = v;
      if (final) setPref('matchStrength', v);
    },
  });
  go.addEventListener('click', async () => {
    if (!sel.value) return;
    go.disabled = true;
    go.setAttribute('aria-busy', 'true');
    try {
      await matchColor(view.ctx, view.id, sel.value, { strength });
    } finally {
      go.disabled = false;
      go.removeAttribute('aria-busy');
      restoreFocus(go);
    }
  });
  render();
  view.bind(() => {
    if (document.activeElement !== sel) render();
  });
  return propSection('Match color', [
    row('Match to', sel, { id }),
    amount.el,
    go,
    note('Replaces the light and color sliders and the luma curve. Undo, or use the section resets, to go back.'),
  ]);
}

/** Where the clip's color applies: everywhere, on the people, or around them. */
function targetRow(view) {
  const seg = segmented({
    label: 'Apply color to',
    options: [{ value: 'all', label: 'Whole clip' }, { value: 'person', label: 'People' }, { value: 'background', label: 'Background' }],
    value: view.clip?.colorTarget || 'all',
    onChange: (v) => {
      view.edit(v === 'all' ? 'Color on whole clip' : v === 'person' ? 'Color on people' : 'Color on background', (c) => {
        if (v === 'all') {
          if (!c.colorTarget) return false;
          delete c.colorTarget;
        } else c.colorTarget = v;
      });
      if (v !== 'all') ready();
    },
  });
  const hint = h('p.asset-hint');
  const sync = () => {
    const t = view.clip?.colorTarget || 'all';
    seg.set(t);
    hint.hidden = t === 'all';
    hint.textContent = 'People are found on this device. Color layers, masks set to limit color and this choice combine.';
  };
  sync();
  view.bind(sync);
  return h('div.color-target', h('div.field.insp-row', h('span.field-label', 'Apply to'), seg.el), hint);
}

export function colorBasicTab(view) {
  const auto = h('button.btn.small', { type: 'button', 'data-tip': 'Balance exposure, contrast and white balance from the current frame' }, icon('wand', 14), 'Auto adjust');
  auto.addEventListener('click', () => autoAdjust(view.ctx, view.id));
  const save = h('button.btn.small', { type: 'button', 'data-tip': 'Keep this look to reuse it on other clips' }, icon('bookmark', 14), 'Save as preset');
  save.addEventListener('click', async () => {
    const name = await promptDialog({ title: 'Save color preset', label: 'Preset name', value: 'My look', confirm: 'Save', maxLength: 80 });
    const clip = view.clip;
    if (!name || !clip) return;
    savePreset(name, clip);
    toast(`Saved preset "${name}". Find it under Color > Your presets.`, { kind: 'success' });
  });
  const tools = h('div.color-tools', auto, save);
  const sections = ADJUST_SECTIONS.map((s) => gradeSection(view, {
    id: s.id,
    title: s.title,
    children: s.keys.map((k) => adjustSlider(view, k).el),
    onReset: () => {
      view.edit(`Reset ${s.title.toLowerCase()}`, (c) => resetKeys(c, s.keys.map((k) => k.key)));
      announce(`${s.title} reset`);
    },
  }));
  const resetAll = h('button.btn.small.block', { type: 'button' }, icon('rotateLeft', 14), 'Reset all');
  resetAll.addEventListener('click', () => {
    view.edit('Reset color', (c) => {
      resetKeys(c, Object.keys(DEFAULT_ADJUST));
      delete c.grade;
    });
    announce('Color reset');
  });
  const isLayer = view.clip?.type === 'adjust';
  return h('div.color-basic',
    tools,
    isLayer ? null : targetRow(view),
    isLayer ? note('A color layer grades every clip below it on the timeline.') : null,
    lutSection(view),
    isLayer ? null : matchSection(view),
    sections,
    h('div.insp-footer', resetAll),
  );
}
