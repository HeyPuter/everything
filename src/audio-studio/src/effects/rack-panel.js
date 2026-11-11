// Effects Rack panel for the active audio file: rack presets, master power,
// the 16-slot list, input/output gain, wet/dry mix, the process range and
// Apply. While the rack has enabled effects, the file plays through it (see
// decorateGraph); Apply renders it into the audio as one undo step and then
// empties the rack so the effects are not heard twice.
//
// In a multitrack session the panel edits a chain of the session instead,
// chosen with the target switch: the selected clip's effects (clip.fx) or
// the selected track's (track.fx, with the track's effects power, input and
// output gain and dry/wet mix). Rack presets load into either chain. Those
// chains play live in the session mix; edits are undoable session steps.
// Effects > Edit Clip / Track Effects in Effects Rack open it that way.

import { h, announce } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { knob, hotNumber, select } from '../ui/controls.js';
import { getEffect } from './registry.js';
import { createRack, createRackEditor, fitSlots, makeSlot, rackActive, renderRack, decorateGraph, RACK_SLOTS } from './rack.js';
import { lazyApplyChain, isAbort } from './apply.js';
import { withProgress } from './progress.js';
import { normalizeValues } from './params.js';
import { inlinePrompt } from './dialog.js';
import { smoothBoundaries } from '../model/edits.js';
import { editSmoothFrames } from '../editor/view-prefs.js';
import { findClip, findTrack, updateClips, updateTrack } from '../model/session-edits.js';

const racks = new WeakMap();

export function rackFor(doc) {
  if (!doc) return null;
  let r = racks.get(doc);
  if (!r) racks.set(doc, (r = createRack()));
  return r;
}

/** Replaces the rack of `doc` and refreshes playback. */
export function setRack(app, doc, rack) {
  racks.set(doc, rack);
  if (doc === app.active) app.syncGraph();
  app.emit('rack', doc);
}

// ------------------------------------------------------------ presets

const PRESETS = 'rackPresets';

export function rackPresets(prefs) {
  const list = prefs.get(PRESETS);
  return Array.isArray(list) ? list : [];
}

/** A rack's portable content (no slot ids or power state). */
export function rackSnapshot(rack) {
  return {
    slots: rack.slots.map((s) => (s ? { effect: s.effect, values: s.values, enabled: s.enabled !== false } : null)),
    input: rack.input,
    output: rack.output,
    mix: rack.mix,
  };
}

export function rackFromSnapshot(snap, base = createRack()) {
  return {
    ...base,
    slots: fitSlots((snap.slots || []).map((s) => (s ? makeSlot(s.effect, s.values, s.enabled) : null))),
    input: Number(snap.input) || 0,
    output: Number(snap.output) || 0,
    mix: snap.mix ?? 1,
  };
}

export function saveRackPreset(prefs, name, rack) {
  name = String(name || '').trim();
  if (!name) throw new Error('Enter a preset name.');
  if (name === '(Default)') throw new Error('Choose another name.');
  const list = rackPresets(prefs).filter((p) => p.name !== name);
  list.push({ name, rack: rackSnapshot(rack) });
  list.sort((a, b) => a.name.localeCompare(b.name));
  prefs.set(PRESETS, list);
}

export function deleteRackPreset(prefs, name) {
  prefs.set(PRESETS, rackPresets(prefs).filter((p) => p.name !== name));
}

// ------------------------------------------------------------ targets

/** Which session chain the panel edits: 'clip' or 'track'. */
export function rackTargetKind(app) {
  return app.rackTarget === 'clip' ? 'clip' : 'track';
}

/** Points the panel at the selected clip's or track's effects (sessions). */
export function setRackTarget(app, kind) {
  app.rackTarget = kind === 'clip' ? 'clip' : 'track';
  app.emit('rack-target', app.rackTarget);
}

/**
 * The session chain the panel edits, or { kind, doc, missing } when nothing
 * suitable is selected:
 *   { kind, doc, id, name, slots(), set(slots), power?(), setPower?(on),
 *     levels?(), setLevels?({ input, output, mix }) }
 */
export function sessionRackTarget(doc, kind) {
  if (kind === 'clip') {
    const clip = doc.clipSelection[0];
    if (!clip) return { kind, doc, missing: 'Select a clip to edit its effects.' };
    const id = clip.id;
    return {
      kind,
      doc,
      id,
      name: findClip(doc.state, id)?.name || 'Clip',
      slots: () => findClip(doc.state, id)?.fx || [],
      // Clip chains have no empty slots.
      set: (slots) => doc.apply('Clip Effects', updateClips(doc.state, [id], { fx: slots.filter(Boolean) }), { coalesce: `clip-fx:${id}` }),
    };
  }
  const track = findTrack(doc.state, doc.selectedTrack);
  if (!track) return { kind, doc, missing: 'Select a track to edit its effects.' };
  const id = track.id;
  return {
    kind,
    doc,
    id,
    name: track.name || (track.type === 'master' ? 'Mix' : 'Track'),
    slots: () => findTrack(doc.state, id)?.fx || [],
    set: (slots) => doc.apply('Track Effects', updateTrack(doc.state, id, { fx: slots }), { coalesce: `fx:${id}` }),
    // Rack input/output gain (dB) and dry/wet mix (0..1).
    levels: () => {
      const t = findTrack(doc.state, id);
      return { input: t?.fxIn ?? 0, output: t?.fxOut ?? 0, mix: t?.fxMix ?? 1 };
    },
    setLevels: (patch) => {
      const keys = { input: 'fxIn', output: 'fxOut', mix: 'fxMix' };
      const out = Object.fromEntries(Object.entries(patch).map(([k, v]) => [keys[k], v]));
      doc.apply('Track Effects', updateTrack(doc.state, id, out), { coalesce: `fx-levels:${id}` });
    },
    power: () => findTrack(doc.state, id)?.fxPower !== false,
    setPower: (on) => {
      doc.endGesture();
      doc.apply(on ? 'Track Effects On' : 'Track Effects Off', updateTrack(doc.state, id, { fxPower: on }));
    },
  };
}

/** Effects menu commands that open the panel on a session chain. */
export function installRackCommands(app) {
  const session = (a) => (a.active?.kind === 'session' ? a.active : null);
  app.commands.register([
    {
      id: 'fx.editClipEffects',
      label: 'Edit Clip Effects in Effects Rack',
      enabled: (a) => Boolean(session(a)?.clipSelection.length),
      run: (a) => {
        setRackTarget(a, 'clip');
        a.dock?.openPanel('effects');
      },
    },
    {
      id: 'fx.editTrackEffects',
      label: 'Edit Track Effects in Effects Rack',
      enabled: (a) => Boolean(session(a) && findTrack(session(a).state, session(a).selectedTrack)),
      run: (a) => {
        setRackTarget(a, 'track');
        a.dock?.openPanel('effects');
      },
    },
  ]);
}

// -------------------------------------------------------------- panel

export function effectsRackPanel(app) {
  const audioDoc = () => (app.active?.kind === 'audio' ? app.active : null);
  const sessionDoc = () => (app.active?.kind === 'session' ? app.active : null);
  /** The session chain being edited (null for audio files). */
  const chain = () => (sessionDoc() ? sessionRackTarget(sessionDoc(), rackTargetKind(app)) : null);
  const rack = () => rackFor(audioDoc());
  /** What the presets, gains and mix show: the file's rack or the session chain as a rack. */
  const current = () => {
    const c = chain();
    if (!c) return rack();
    if (c.missing) return null;
    return { ...createRack(), slots: fitSlots(c.slots()), ...(c.levels ? c.levels() : {}), power: c.power ? c.power() : true };
  };
  /** Sets rack gains or mix on the file's rack or the session track. */
  const setLevel = (key, v) => {
    const c = chain();
    if (c) c.setLevels?.({ [key]: v });
    else update((r) => ({ ...r, [key]: v }));
  };
  const update = (fn, message) => {
    const doc = audioDoc();
    if (!doc) return;
    setRack(app, doc, fn(rackFor(doc)));
    if (message) announce(message);
  };

  // Toolbar: presets and master power.
  const presetSel = h('select.select.rack-preset', { 'aria-label': 'Rack presets', onchange: () => {
    const name = presetSel.value;
    const p = name === '(Default)' ? null : rackPresets(app.prefs).find((x) => x.name === name);
    if (name !== '(Default)' && !p) return;
    const c = chain();
    if (c && !c.missing) {
      // A session chain takes the preset's slots (and, on tracks, its gains and mix).
      const r = p ? rackFromSnapshot(p.rack) : createRack();
      sessionDoc().endGesture();
      c.set(r.slots);
      c.setLevels?.({ input: r.input, output: r.output, mix: r.mix });
      sessionDoc().endGesture();
      announce(p ? `Rack preset ${name}` : 'Effects cleared');
      render();
    } else if (!p) update((r) => ({ ...createRack(), power: r.power, process: r.process }), 'Rack cleared');
    else update((r) => rackFromSnapshot(p.rack, r), `Rack preset ${name}`);
  } });
  const nameRow = h('div.fx-namebar.rack-namebar', { hidden: true });
  const saveBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Save rack as a preset', title: 'Save rack as a preset', onclick: () => askName() }, icon('save', 15));
  const delBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Delete rack preset', title: 'Delete rack preset', onclick: () => {
    const name = presetSel.value;
    if (!rackPresets(app.prefs).some((p) => p.name === name)) return;
    deleteRackPreset(app.prefs, name);
    renderPresets();
    announce(`Rack preset ${name} deleted`);
  } }, icon('trash-2', 15));
  const powerBtn = h('button.icon-btn.rack-master-power', { type: 'button', 'aria-label': 'Effects Rack power', title: 'Turn the whole rack on or off', onclick: () => {
    const c = chain();
    if (c?.setPower) {
      const on = !c.power();
      c.setPower(on);
      announce(on ? 'Track effects on' : 'Track effects off');
      render();
    } else update((r) => ({ ...r, power: !r.power }), rack()?.power ? 'Rack off' : 'Rack on');
  } }, icon('power', 15));
  const toolbar = h('div.panel-toolbar.rack-toolbar', powerBtn, presetSel, saveBtn, delBtn);

  // Target switch: the file's rack, or a session clip's or track's effects.
  const targetBtn = (kind, label, title) => h('button.btn.rack-target-btn', { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { kind }, title, onclick: () => kind !== 'file' && setRackTarget(app, kind) }, label);
  const targetBtns = [targetBtn('file', 'File', 'The active audio file\'s rack'), targetBtn('clip', 'Clip', 'The selected clip\'s effects'), targetBtn('track', 'Track', 'The selected track\'s effects')];
  const targetName = h('span.rack-target-name');
  const targetBar = h('div.rack-target', h('div.rack-target-switch', { role: 'radiogroup', 'aria-label': 'Effects Rack target' }, targetBtns), targetName);
  const missing = h('p.rack-missing.faint', { hidden: true });

  function askName() {
    inlinePrompt(nameRow, { label: 'Preset name:', value: 'My Rack', returnFocus: saveBtn, onSave: (n) => {
      saveRackPreset(app.prefs, n, current());
      renderPresets(n.trim());
      announce(`Rack preset ${n.trim()} saved`);
    } });
  }

  function renderPresets(selectName) {
    const list = rackPresets(app.prefs);
    const r = current();
    const shown = selectName || list.find((p) => r && JSON.stringify(p.rack) === JSON.stringify(rackSnapshot(r)))?.name || (r && !r.slots.some(Boolean) ? '(Default)' : '');
    presetSel.replaceChildren(
      ...(shown ? [] : [h('option', { value: '' }, '(Custom)')]),
      h('option', { value: '(Default)' }, '(Default)'),
      ...list.map((p) => h('option', { value: p.name }, p.name)),
    );
    presetSel.value = shown;
    delBtn.disabled = !list.some((p) => p.name === shown);
  }

  // Slot list.
  const editor = createRackEditor({
    app,
    label: 'Effects Rack slots',
    slotCount: RACK_SLOTS,
    getSlots: () => {
      const c = chain();
      return c ? (c.missing ? [] : c.slots()) : rack()?.slots || [];
    },
    setSlots: (slots) => {
      const c = chain();
      if (c && !c.missing) c.set(slots);
      else if (!c) update((r) => ({ ...r, slots: fitSlots(slots) }));
    },
    disabled: () => {
      const c = chain();
      return c ? Boolean(c.missing) || (c.power ? !c.power() : false) : !rack()?.power;
    },
  });

  // Footer: gains, mix, process range, apply.
  // Typed levels may carry their unit ("-6 dB", "40%") or a decimal comma; empty text is no value.
  const parseLevel = (text) => {
    const s = String(text).trim().replace(',', '.').replace(/\s*(db|%)$/i, '');
    return s ? Number(s) : NaN;
  };
  const gainKnob = (key, label) => {
    let k;
    const hot = hotNumber({
      value: 0,
      min: -60,
      max: 30,
      step: 0.1,
      label,
      pixelsPerStep: 1,
      format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
      parse: parseLevel,
      onInput: (v) => set(v),
      onChange: (v) => set(v),
      defaultValue: 0,
    });
    const set = (v) => {
      k.setValue(v);
      hot.setValue(v);
      setLevel(key, v);
    };
    k = knob({ value: 0, min: -60, max: 30, step: 0.1, defaultValue: 0, label, bipolar: true, size: 26, format: (v) => `${v.toFixed(1)} dB`, onInput: (v) => set(v), onChange: (v) => set(v) });
    return { el: h('div.rack-knob', k, h('div.rack-knob-text', h('span.rack-knob-label', label), hot)), set: (v) => (k.setValue(v), hot.setValue(v)) };
  };
  const input = gainKnob('input', 'Input');
  const output = gainKnob('output', 'Output');
  let mixKnob;
  const mixHot = hotNumber({ value: 100, min: 0, max: 100, step: 1, label: 'Mix', format: (v) => `${Math.round(v)}%`, parse: parseLevel, onInput: (v) => setMix(v), onChange: (v) => setMix(v), defaultValue: 100 });
  const setMix = (v) => {
    mixKnob.setValue(v);
    mixHot.setValue(v);
    setLevel('mix', v / 100);
  };
  mixKnob = knob({ value: 100, min: 0, max: 100, step: 1, defaultValue: 100, label: 'Mix (dry to wet)', size: 26, format: (v) => `${Math.round(v)}% wet`, onInput: (v) => setMix(v), onChange: (v) => setMix(v) });
  const mix = h('div.rack-knob', mixKnob, h('div.rack-knob-text', h('span.rack-knob-label', 'Mix'), mixHot));
  const processSel = select({
    value: 'selection',
    label: 'Process',
    options: [
      { value: 'selection', label: 'Selection Only' },
      { value: 'file', label: 'Entire File' },
    ],
    onChange: (v) => update((r) => ({ ...r, process: v })),
  });
  const applyBtn = h('button.btn.primary.rack-apply', { type: 'button', onclick: () => applyRack(app) }, 'Apply');
  const knobs = h('div.rack-knobs', input.el, output.el, mix);
  const processRow = h('div.rack-process', h('label.rack-toolbar-label', 'Process:'), processSel, h('div.spacer'), applyBtn);
  const footer = h('div.rack-footer', knobs, processRow);

  const empty = h('div.empty-state.rack-empty', icon('fx-rack', 28), h('p', 'Open an audio file or a multitrack session to add effects.'));
  const scroll = h('div.rack-scroll', editor.el);
  const content = h('div.rack-content', targetBar, toolbar, nameRow, missing, scroll, footer);
  const el = h('div.rack-panel', content, empty);
  // A new interaction in the panel starts a new undo step in the session
  // (changes from one slot's effect dialog amend a single step).
  const newGesture = () => sessionDoc()?.endGesture();
  el.addEventListener('pointerdown', newGesture, true);
  el.addEventListener('keydown', newGesture, true);

  function renderTarget(kind) {
    for (const b of targetBtns) {
      const k = b.dataset.kind;
      b.setAttribute('aria-checked', String(k === kind));
      b.disabled = k === 'file' ? kind !== 'file' : kind === 'file';
    }
  }

  function showLevels(r) {
    input.set(r.input ?? 0);
    output.set(r.output ?? 0);
    mixKnob.setValue(Math.round((r.mix ?? 1) * 100));
    mixHot.setValue(Math.round((r.mix ?? 1) * 100));
  }

  function render() {
    const c = chain();
    if (c) {
      content.hidden = false;
      empty.hidden = true;
      renderTarget(c.kind);
      targetName.textContent = c.missing ? '' : `${c.kind === 'clip' ? 'Clip' : 'Track'}: ${c.name}`;
      missing.textContent = c.missing || '';
      missing.hidden = !c.missing;
      // Presets apply to both chains; gains and mix belong to tracks; Apply
      // and the process range to a file's rack.
      for (const x of [presetSel, saveBtn, delBtn]) x.hidden = Boolean(c.missing);
      footer.hidden = Boolean(c.missing) || !c.levels;
      processRow.hidden = true;
      if (c.missing) nameRow.hidden = true;
      powerBtn.hidden = !c.power;
      if (c.power) {
        powerBtn.setAttribute('aria-pressed', String(c.power()));
        powerBtn.setAttribute('aria-label', 'Track effects power');
        powerBtn.title = 'Turn the track\'s effects on or off';
      }
      editor.render();
      if (c.levels) showLevels(c.levels());
      if (!c.missing) renderPresets();
      return;
    }
    const r = rack();
    content.hidden = !r;
    empty.hidden = Boolean(r);
    if (!r) return;
    renderTarget('file');
    targetName.textContent = audioDoc()?.name || '';
    missing.hidden = true;
    for (const x of [presetSel, saveBtn, delBtn, footer, processRow]) x.hidden = false;
    powerBtn.hidden = false;
    powerBtn.setAttribute('aria-label', 'Effects Rack power');
    powerBtn.title = 'Turn the whole rack on or off';
    editor.render();
    powerBtn.setAttribute('aria-pressed', String(r.power !== false));
    showLevels(r);
    processSel.value = r.process;
    applyBtn.disabled = !rackActive(r);
    renderPresets();
  }
  app.on('active', render);
  app.on('rack', (doc) => doc === audioDoc() && render());
  app.on('rack-target', render);
  app.on('doc-change', (doc, e) => {
    if (doc !== sessionDoc()) return;
    if (['clip-selection', 'edit', 'history'].includes(e?.kind)) render();
  });
  app.prefs.on('change', (key) => key === PRESETS && renderPresets());
  render();
  return { el, show: render, focus: () => editor.focus() };
}

/** Renders the active file's rack into the audio. */
export async function applyRack(app) {
  const doc = app.active?.kind === 'audio' ? app.active : null;
  const rack = rackFor(doc);
  if (!rackActive(rack)) return false;
  const [start, end] = rack.process === 'file' || !doc.hasSelection ? [0, doc.length] : [doc.selection.start, doc.selection.end];
  const before = doc.state;
  try {
    const state = await withProgress(app, 'Applying Effects Rack', (signal, onProgress) =>
      renderRack({ rack, state: before, start, end, mask: doc.channelMask, signal, onProgress, applyChain: lazyApplyChain, doc }),
    );
    if (doc.state !== before) return false;
    doc.apply('Effects Rack', smoothBoundaries(before, state, start, end, editSmoothFrames(app, before.sampleRate), doc.channelMask));
    // Empty the rack as it is now: settings changed during the render stay.
    setRack(app, doc, { ...rackFor(doc), slots: fitSlots([]) });
    announce('Effects Rack applied');
    app.setStatus('Effects Rack applied');
    return true;
  } catch (err) {
    if (isAbort(err)) return false;
    throw err;
  }
}

/** Adds an effect to the first empty slot of the active file's rack. */
export function addToRack(app, effectId, values) {
  const doc = app.active?.kind === 'audio' ? app.active : null;
  const def = getEffect(effectId);
  if (!doc || !def) return false;
  const rack = rackFor(doc);
  const i = rack.slots.findIndex((s) => !s);
  if (i < 0) {
    app.notify('The rack is full. Remove an effect first.', { error: true });
    return false;
  }
  const slots = rack.slots.slice();
  slots[i] = makeSlot(effectId, normalizeValues(def, values));
  setRack(app, doc, { ...rack, slots });
  return true;
}

/** Hook for audioFileGraph (app.extendFileGraph): routes playback through the rack. */
export function extendFileGraph(graph, doc) {
  return decorateGraph(graph, racks.get(doc), doc);
}
