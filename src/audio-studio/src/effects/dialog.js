// Effect dialog, modelled on a pro editor's effect windows: "Effect - Name"
// with a preset bar, a graphical editor when the effect has one, generated
// parameter controls, and a footer with the power (bypass) toggle, Preview
// play/stop, preview loop, input/output meters, Apply and Close.
//
// mode 'apply' (Effects menu): resolves the chosen values on Apply, null on Close.
// mode 'edit' (rack slots): changes go live through onChange; only Close.

import { h, announce } from '../lib/dom.js';
import { icon, registerIcons } from '../ui/icons.js';
import { openDialog } from '../ui/dialog.js';
import { slotSpec } from './registry.js';
import { normalizeValues, paramType, setLinked, linkGroups, coerce } from './params.js';
import { paramControls as buildControls } from './param-ui.js';
import { channelNames, defaultRoute, routeSummary, rememberRoute, recallRoute, sameRoute } from './routing.js';
import { allPresets, userPresets, savePreset, deletePreset, matchPreset, lastValues } from './presets.js';
import { editorFor } from './displays.js';
import { isRealtime, latencyFrames } from './apply.js';

const CUSTOM = '\u0000custom';

registerIcons({
  // Two inputs crossing to two outputs: the channel map.
  'channel-map': [['path', { d: 'M3 6h4c3 0 4 3 5 6s2 6 5 6h4' }], ['path', { d: 'M3 18h4c3 0 4-3 5-6s2-6 5-6h4' }], ['circle', { cx: '3', cy: '6', r: '1' }], ['circle', { cx: '3', cy: '18', r: '1' }]],
});

/**
 * Generated controls for a definition (param-ui.js): tick-scaled sliders,
 * radio and dropdown choices, checkboxes and data editors, framed by section.
 * Returns { el, refresh(values, from) }; onSet(id, value) reports user changes.
 */
export function paramControls(def, getValues, onSet, opts = {}) {
  return buildControls(def, getValues, onSet, opts);
}

/**
 * Inline name entry inside `bar` (a nested modal would fight the open
 * dialog's keyboard handling, so Enter and Escape are caught at the window
 * before the dialog sees them). onSave(name) may throw to show a message.
 * exists(name) true asks before replacing: Save again confirms.
 * Returns a function that dismisses the prompt.
 */
export function inlinePrompt(bar, { label, value = '', onSave, returnFocus, exists }) {
  // A new prompt in the same bar replaces the open one (and its key handler).
  bar.fxPromptDismiss?.();
  const input = h('input.input', { type: 'text', value, 'aria-label': label.replace(/:$/, '') });
  const error = h('span.fx-name-error', { role: 'alert' });
  let open = true;
  const done = (refocus = true) => {
    if (!open) return;
    open = false;
    if (bar.fxPromptDismiss === dismiss) bar.fxPromptDismiss = null;
    window.removeEventListener('keydown', keys, true);
    bar.hidden = true;
    bar.replaceChildren();
    if (refocus) returnFocus?.focus();
  };
  let replacing = null;
  const ok = () => {
    const name = input.value.trim();
    if (name && exists?.(name) && replacing !== name) {
      replacing = name;
      error.textContent = `"${name}" already exists. Save again to replace it.`;
      return;
    }
    try {
      onSave(input.value);
      done();
    } catch (err) {
      error.textContent = err.message;
    }
  };
  const keys = (e) => {
    if (!bar.contains(e.target)) return;
    if (e.key === 'Escape') done();
    else if (e.key === 'Enter' && e.target === input) ok();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', keys, true);
  bar.replaceChildren(h('label.fx-label', label), input, h('button.btn', { type: 'button', onclick: ok }, 'Save'), h('button.btn', { type: 'button', onclick: () => done() }, 'Cancel'), error);
  bar.hidden = false;
  input.focus();
  input.select();
  const dismiss = () => done(false);
  bar.fxPromptDismiss = dismiss;
  return dismiss;
}

/** Input and output level bars (L/R each) fed while the dialog is open. */
function meterStrip() {
  const bar = () => h('div.fx-meter-bar', h('div.fx-meter-fill'));
  const rows = [
    ['In', [bar(), bar()]],
    ['Out', [bar(), bar()]],
  ];
  const el = h('div.fx-meters', { 'aria-hidden': 'true' }, rows.map(([label, bars]) => h('div.fx-meter-row', h('span.fx-meter-label', label), h('div.fx-meter-pair', bars))));
  const toFrac = (peak) => (peak <= 0.001 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(peak) + 60) / 60)));
  const set = (input, output) => {
    [input, output].forEach((pk, r) => {
      rows[r][1].forEach((b, c) => {
        const v = pk[c] ?? pk[0] ?? 0;
        const fill = b.firstChild;
        fill.style.transform = `scaleX(${toFrac(v)})`;
        b.classList.toggle('clip', v >= 0.999);
      });
    });
  };
  return { el, set };
}

/** Peak of each channel of `doc` around frame `at` (input metering without a pre-effect tap). */
function inputPeak(doc, at, frames = 2048) {
  const buf = new Float32Array(frames);
  return doc.state.channels.slice(0, 2).map((c) => {
    c.read(Math.max(0, Math.floor(at - frames)), buf);
    let m = 0;
    for (let i = 0; i < frames; i++) m = Math.max(m, Math.abs(buf[i]));
    return m;
  });
}

/**
 * Opens the effect dialog. Options:
 *  mode 'apply' | 'edit', values, title, applyLabel, enabled (power state),
 *  onChange(values), onPower(enabled), doc, slotId (the rack or track slot
 *  being edited, so editors can show that slot's live readouts), routing
 *  (an object that receives the chosen channel `route` on Apply)
 */
export function openEffectDialog(app, def, { mode = 'apply', values: initial, title, applyLabel = 'Apply', enabled = true, onChange, onPower, doc = app.active?.kind === 'audio' ? app.active : null, slotId = null, routing = null } = {}) {
  let values = normalizeValues(def, initial || lastValues(app.prefs, def));
  let power = enabled;
  const channelCount = doc ? doc.state.channels.length : 2;
  // The channel map applies to effects run on a stereo file from the Effects menu.
  const routable = mode === 'apply' && Boolean(routing) && channelCount === 2;
  let route = routable ? recallRoute(def.id) || defaultRoute(doc.channelMask) : null;
  let previewing = false;
  let restarting = false;
  const realtime = isRealtime(def);
  const groups = linkGroups(def);
  const subscribers = new Set();
  const range = doc ? doc.editRange() : null;
  // What Preview plays: the file being processed, or for a chain being edited (a rack
  // slot, a session track's or clip's effects, track EQ) the document it plays in.
  const playDoc = doc || (mode === 'edit' ? app.active : null);
  const cleanups = [];

  // ----------------------------------------------------------- values
  const ctx = {
    get values() {
      return values;
    },
    set: (id, v) => setValue(id, v),
    subscribe: (fn) => subscribers.add(fn),
    def,
    app,
    doc,
    range,
    slotId,
    /** Runs fn when the dialog closes. */
    onClose: (fn) => cleanups.push(fn),
    /** fn(Float32Array) with this effect's live readouts while audio plays through it. */
    onReadout: (fn) => {
      const mine = (key) => (slotId ? key.endsWith(`:${slotId}`) : key === `preview:${def.id}`);
      const off = app.engine.on('fx-readout', (list) => {
        for (const [key, v] of list) if (mine(key)) fn(v);
      });
      cleanups.push(off);
      return off;
    },
  };
  let controls = null;
  let previewTimer = 0;
  function setValue(id, v, from = id) {
    const p = def.params.find((q) => q.id === id);
    if (!p) return;
    const next = paramType(p) === 'number' ? setLinked(def, values, id, v, groups) : { ...values, [id]: coerce(p, v) };
    if (JSON.stringify(next) === JSON.stringify(values)) return;
    values = next;
    changed(from);
  }
  function setAll(next) {
    values = normalizeValues(def, next);
    changed(null);
  }
  // The Preview Editor follows the settings (and channel map) of effects about to be applied to a file.
  const announceValues = (v) => mode === 'apply' && doc && app.emit('effect-values', v && { def, values: v, doc, route });
  function changed(from) {
    controls?.refresh(values, from);
    subscribers.forEach((fn) => fn(values));
    syncPresetSelect();
    onChange?.(values);
    announceValues(values);
    if (previewing && mode === 'apply' && !previewTimer) {
      previewTimer = requestAnimationFrame(() => {
        previewTimer = 0;
        pushPreview();
      });
    }
  }

  // ---------------------------------------------------------- presets
  const presetSel = h('select.select.fx-preset-select', { 'aria-label': 'Presets', onchange: () => {
    const p = allPresets(app.prefs, def).find((x) => x.name === presetSel.value);
    if (p) {
      setAll(p.values);
      announce(`Preset ${p.name}`);
    }
  } });
  const delBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Delete preset', title: 'Delete preset', onclick: () => {
    const name = presetSel.value;
    const p = allPresets(app.prefs, def).find((x) => x.name === name);
    if (!p?.user) return;
    deletePreset(app.prefs, def.id, name);
    syncPresetSelect();
    announce(`Preset ${name} deleted`);
  } }, icon('trash-2', 15));
  function syncPresetSelect() {
    const list = allPresets(app.prefs, def);
    const current = matchPreset(app.prefs, def, values);
    const opts = [];
    if (!current) opts.push(h('option', { value: CUSTOM }, '(Custom)'));
    const builtIn = list.filter((p) => !p.user);
    const user = list.filter((p) => p.user);
    for (const p of builtIn) opts.push(h('option', { value: p.name }, p.name));
    if (user.length) opts.push(h('optgroup', { label: 'Your Presets' }, user.map((p) => h('option', { value: p.name }, p.name))));
    presetSel.replaceChildren(...opts);
    presetSel.value = current || CUSTOM;
    delBtn.disabled = !list.find((p) => p.name === current)?.user;
  }

  const nameBar = h('div.fx-namebar', { hidden: true });
  const askName = (labelText, initialName, confirm, exists) => cleanups.push(inlinePrompt(nameBar, { label: labelText, value: initialName, onSave: confirm, returnFocus: presetSel, exists }));
  const saveBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Save settings as a preset', title: 'Save settings as a preset', onclick: () => {
    askName('Preset name:', matchPreset(app.prefs, def, values) && !allPresets(app.prefs, def).find((p) => p.name === presetSel.value && !p.user) ? presetSel.value : 'My Preset', (name) => {
      const saved = savePreset(app.prefs, def, name, values);
      syncPresetSelect();
      announce(`Preset ${saved} saved`);
    }, (name) => userPresets(app.prefs, def.id).some((p) => p.name === name));
  } }, icon('save', 15));
  const favBtn = app.favorites
    ? h('button.icon-btn', { type: 'button', 'aria-label': 'Save settings as a favorite', title: 'Save settings as a favorite', onclick: () => {
        askName('Favorite name:', def.name, (text) => {
          const name = String(text || '').trim();
          if (!name) throw new Error('Enter a favorite name.');
          app.favorites.addEffect(name, def.id, values);
          announce(`Favorite ${name} saved`);
        });
      } }, icon('star', 15))
    : null;
  // Channel map: which channels feed the effect and which receive its output.
  const mapPanel = h('div.fx-popover.fx-chmap', { hidden: true, role: 'group', 'aria-label': 'Channel map' });
  const summary = h('div.fx-route-summary');
  const showRoute = () => (summary.textContent = routeSummary(route, channelCount, doc?.channelMask));
  const mapBtn = h('button.icon-btn.fx-map-btn', { type: 'button', 'aria-label': 'Channel map', 'aria-expanded': 'false', title: routable ? 'Channel map: choose the channels the effect reads and writes' : 'Channel routing is available for stereo files from the Effects menu', disabled: !routable, onclick: () => toggle(mapPanel, mapBtn, buildMap) }, icon('channel-map', 16));
  function buildMap() {
    const names = channelNames(2);
    const full = ['Left', 'Right'];
    const pick = (value, options, onPick, label) => {
      const sel = h('select.select', { 'aria-label': label, onchange: () => onPick(Number(sel.value)) }, options.map(([v, text]) => h('option', { value: String(v) }, text)));
      sel.value = String(value);
      return sel;
    };
    const set = (next) => {
      route = next;
      showRoute();
      announceValues(values);
      if (previewing) pushPreview();
    };
    const inputs = [0, 1].map((c) => h('label.fx-chmap-cell', h('span.faint', full[c]), pick(route.in[c], [[0, `File ${names[0]}`], [1, `File ${names[1]}`], [-1, 'Silence']], (v) => set({ ...route, in: route.in.map((x, i) => (i === c ? v : x)) }), `Effect ${full[c].toLowerCase()} input`)));
    const outputs = [0, 1].map((c) => h('label.fx-chmap-cell', h('span.faint', full[c]), pick(route.out[c], [[0, `Effect ${names[0]}`], [1, `Effect ${names[1]}`], [-1, 'Unprocessed']], (v) => set({ ...route, out: route.out.map((x, i) => (i === c ? v : x)) }), `File ${full[c].toLowerCase()} channel output`)));
    mapPanel.replaceChildren(
      h('div.fx-chmap-row', h('span.fx-label', 'Effect inputs:'), inputs),
      h('div.fx-chmap-row', h('span.fx-label', 'File channels get:'), outputs),
      h('div.fx-chmap-row', h('button.btn', { type: 'button', onclick: () => {
        set({ in: [0, 1], out: [0, 1] });
        buildMap();
      } }, 'Reset')),
    );
  }

  // Info: what the effect does and how the controls work.
  const infoPanel = h('div.fx-popover.fx-info', { hidden: true, role: 'note' });
  const infoBtn = h('button.icon-btn.fx-info-btn', { type: 'button', 'aria-label': 'About this effect', 'aria-expanded': 'false', title: 'About this effect', onclick: () => toggle(infoPanel, infoBtn, buildInfo) }, icon('info', 16));
  function buildInfo() {
    const facts = [];
    if (def.about) facts.push(h('p', def.about));
    facts.push(h('p.faint', realtime ? 'Plays live while you preview, and works in the Effects Rack and on tracks.' : 'Processes the selection when you apply it; it cannot be previewed live.'));
    facts.push(
      h(
        'ul.fx-tips',
        h('li', 'Drag a blue value sideways to change it, or click it to type a value with units (2k, 150 ms).'),
        h('li', 'Arrow keys step a focused slider or value; Shift steps further.'),
        h('li', 'Double-click a slider or value to return it to its default.'),
      ),
    );
    infoPanel.replaceChildren(...facts);
  }
  function toggle(panel, btn, build) {
    const open = panel.hidden;
    for (const [pnl, b] of [[mapPanel, mapBtn], [infoPanel, infoBtn]]) {
      pnl.hidden = true;
      b.setAttribute('aria-expanded', 'false');
    }
    if (open) {
      build();
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    }
    if (open) window.addEventListener('keydown', popoverKeys, true);
    else window.removeEventListener('keydown', popoverKeys, true);
  }
  // While one is open, Escape closes the channel map or info popover before the dialog
  // (caught at the window, ahead of the dialog's own Escape, like the inline name prompt).
  function popoverKeys(e) {
    if (e.key !== 'Escape' || !(body.closest('.dialog') || body).contains(e.target) || nameBar.contains(e.target) || e.target.classList?.contains('hot-edit')) return;
    const open = [[mapPanel, mapBtn], [infoPanel, infoBtn]].find(([pnl]) => !pnl.hidden);
    if (!open) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle(...open);
    open[1].focus();
  }
  cleanups.push(() => window.removeEventListener('keydown', popoverKeys, true));

  const presetBar = h('div.fx-presetbar', h('span.fx-label', 'Presets:'), presetSel, saveBtn, delBtn, h('span.fx-bar-sep', { 'aria-hidden': 'true' }), favBtn, h('span.spacer'), mapBtn, infoBtn);
  syncPresetSelect();

  // ------------------------------------------------------------ body
  const editor = editorFor(def);
  const editorEl = editor ? editor(ctx) : null;
  const smoothParam = def.params.find((p) => paramType(p) === 'bool' && /spline|smooth|curve/i.test(p.id));
  const set = (id, v) => setValue(id, v);
  // Params a custom editor lays out itself (views/*.js `hides`) stay out of the generated grid.
  const hides = editor?.hides;
  const gridDef = hides ? { ...def, params: def.params.map((p) => (hides === true || hides.includes(p.id) ? { ...p, hidden: true } : p)) } : def;
  const ctlOpts = { doc, range, smooth: (v) => smoothParam && v[smoothParam.id], onReadout: def.readout ? ctx.onReadout : null };
  const tabs = def.layout?.tabs || null;
  let main;
  if (tabs) {
    // Tabbed pages: each holds its sections (and the graphical editor when `editor` is set).
    const parts = [];
    const tabBtns = [];
    const uid = `fxdlgtab${Math.random().toString(36).slice(2, 8)}`;
    // One tab in the Tab order; arrow keys move between tabs (the ARIA tabs pattern).
    const selectTab = (i, focus = false) => {
      pages.forEach((pg, k) => (pg.hidden = k !== i));
      tabBtns.forEach((b, k) => {
        b.setAttribute('aria-selected', String(k === i));
        b.tabIndex = k === i ? 0 : -1;
      });
      if (focus) tabBtns[i].focus();
    };
    const pages = tabs.map((t, i) => {
      const c = paramControls(def, () => values, set, { ...ctlOpts, sections: t.sections || [] });
      parts.push(c);
      const page = h('div.fx-tabpage', { role: 'tabpanel', id: `${uid}-p${i}`, 'aria-labelledby': `${uid}-t${i}`, hidden: i > 0 }, t.editor && editorEl ? h('div.fx-editor', editorEl) : null, c.el);
      tabBtns.push(h('button.fx-tab', { type: 'button', role: 'tab', id: `${uid}-t${i}`, 'aria-controls': `${uid}-p${i}`, 'aria-selected': String(i === 0), tabindex: i === 0 ? '0' : '-1', onclick: () => selectTab(i), onkeydown: (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        e.stopPropagation();
        selectTab((i + d + tabs.length) % tabs.length, true);
      } }, t.label));
      return page;
    });
    const inTabs = new Set(tabs.flatMap((t) => t.sections || []));
    const restSections = [...new Set(def.params.filter((p) => !p.hidden).map((p) => p.section || null))].filter((n) => !inTabs.has(n));
    const rest = restSections.length ? paramControls(def, () => values, set, { ...ctlOpts, sections: restSections }) : null;
    if (rest) parts.push(rest);
    controls = { refresh: (v, from) => parts.forEach((c) => c.refresh(v, from)) };
    main = h('div.fx-tabs', h('div.fx-tabbar', { role: 'tablist' }, tabBtns), pages, rest?.el);
  } else {
    controls = paramControls(gridDef, () => values, set, ctlOpts);
    main = [editorEl ? h('div.fx-editor', editorEl) : null, controls.el];
  }
  const body = h('div.fx-dialog-body', presetBar, nameBar, mapPanel, infoPanel, main);

  // ---------------------------------------------------------- footer
  const powerBtn = h('button.icon-btn.fx-power', { type: 'button', 'aria-pressed': String(power), 'aria-label': 'Effect power', title: 'Turn the effect on or off (bypass) while previewing', onclick: () => {
    power = !power;
    powerBtn.setAttribute('aria-pressed', String(power));
    announce(power ? 'Effect on' : 'Effect bypassed');
    if (mode === 'edit') onPower?.(power);
    else if (previewing) pushPreview();
  } }, icon('power', 15));
  const playBtn = h('button.icon-btn.fx-play', { type: 'button', 'aria-label': 'Preview', title: realtime || mode === 'edit' ? 'Play the selection through the effect' : 'Preview is not available for this effect', disabled: !playDoc || (!realtime && mode !== 'edit'), onclick: () => togglePreview() }, icon('transport-play', 15));
  const loopBtn = h('button.icon-btn.fx-loop', { type: 'button', 'aria-pressed': String(app.prefs.get('fxPreviewLoop') !== false), 'aria-label': 'Loop preview', title: 'Loop the preview', onclick: () => {
    const on = loopBtn.getAttribute('aria-pressed') !== 'true';
    loopBtn.setAttribute('aria-pressed', String(on));
    app.prefs.set('fxPreviewLoop', on);
    if (previewing) {
      // Restart with the new loop setting; the stop in between does not end the preview.
      restarting = true;
      app.stop();
      restarting = false;
      startPlayback();
    }
  } }, icon('transport-loop', 15));
  const meters = meterStrip();
  showRoute();
  const footerStart = h('div.fx-footer', summary, h('div.fx-footer-tools', powerBtn, playBtn, loopBtn, meters.el));

  function pushPreview() {
    if (mode !== 'apply') return;
    let spec = null;
    if (previewing && realtime) {
      spec = slotSpec(def, values, { key: `preview:${def.id}`, enabled: power, doc, route });
      // Its processing delay, which the file's playback graph compensates (decorateGraph).
      const latency = doc ? latencyFrames(def, values, doc.sampleRate) : 0;
      if (latency) spec.latency = latency;
    }
    app.previewFx = spec ? [spec] : null;
    app.syncGraph();
  }
  function startPlayback() {
    const loop = loopBtn.getAttribute('aria-pressed') === 'true';
    const sel = playDoc.selection;
    const hasSel = sel.end > sel.start;
    app.play({ from: hasSel ? sel.start : playDoc.cursor, loop });
  }
  function setPreviewing(on) {
    previewing = on;
    playBtn.replaceChildren(icon(on ? 'transport-stop' : 'transport-play', 15));
    playBtn.setAttribute('aria-label', on ? 'Stop preview' : 'Preview');
    playBtn.classList.toggle('on', on);
  }
  function togglePreview() {
    if (!playDoc) return;
    if (previewing) {
      app.stop();
      return;
    }
    if (app.active !== playDoc) app.activate(playDoc);
    setPreviewing(true);
    pushPreview();
    startPlayback();
    if (!meterRaf) meterRaf = requestAnimationFrame(meterLoop);
  }
  const onTransport = (s) => {
    if (s === 'stopped' && previewing && !restarting) {
      setPreviewing(false);
      pushPreview();
      meters.set([0, 0], [0, 0]);
    }
  };
  cleanups.push(app.on('transport', onTransport));
  // Meters: the input is read from the file at the playhead; the output is the
  // engine's latest file-track peak (held for a moment, then decaying).
  let out = [0, 0];
  let meterRaf = 0;
  cleanups.push(app.engine.on('meters', (m) => {
    const pk = m.tracks.get('file') || m.master;
    out = [Math.max(out[0], pk[0] ?? 0), Math.max(out[1], pk[1] ?? pk[0] ?? 0)];
  }));
  const meterLoop = () => {
    meterRaf = 0;
    if (!previewing || !playDoc) return;
    // A session has no single input to read: its meters show the output.
    meters.set(doc ? inputPeak(doc, app.engine.position) : [0, 0], out);
    out = out.map((v) => v * 0.8);
    meterRaf = requestAnimationFrame(meterLoop);
  };
  cleanups.push(() => cancelAnimationFrame(meterRaf));

  // Measuring effects (Loudness Meter) leave the audio unchanged: nothing to apply.
  const buttons = mode === 'apply' && !def.measureOnly
    ? [
        { label: 'Close', value: null },
        { label: applyLabel, value: 'apply', primary: true },
      ]
    : [{ label: 'Close', value: null, primary: true }];

  announceValues(values);
  return openDialog({
    title: title || `Effect - ${def.name}`,
    className: `fx-dialog${def.layout?.wide ? ' fx-wide' : ''}${editor?.dialogClass ? ` ${editor.dialogClass}` : ''}`,
    body,
    footerStart,
    buttons,
    initialFocus: '.fx-controls input, .fx-controls .hot, .fx-controls select, .fx-editor button',
  }).then((r) => {
    cancelAnimationFrame(previewTimer);
    announceValues(null);
    cleanups.forEach((f) => f());
    if (previewing) app.stop();
    if (mode === 'apply' && app.previewFx?.some((s) => s.key === `preview:${def.id}`)) {
      app.previewFx = null;
      app.syncGraph();
    }
    if (r === 'apply' && routable) {
      routing.route = route;
      rememberRoute(def.id, sameRoute(route, defaultRoute(doc.channelMask)) ? null : route);
    }
    return r === 'apply' ? values : null;
  });
}
