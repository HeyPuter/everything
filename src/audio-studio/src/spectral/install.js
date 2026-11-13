// Spectral feature: the Spectral Frequency Display layer, its commands,
// spectral selection tools and spectral editing (Delete, effects and the
// HUD restricted to a spectral selection, Spot Healing, Auto Heal).

import '../styles/spectral.css';
import { h, announce } from '../lib/dom.js';
import { WaveformView } from '../editor/waveform-view.js';
import { openDialog } from '../ui/dialog.js';
import { parseTime } from '../lib/time.js';
import { dsp } from '../audio/dsp.js';
import { SpectralLayer } from './layer.js';
import { zoomRange } from './freq-scale.js';
import { timeSelection, selectionBounds } from './mask.js';
import { getEffect, slotSpec } from '../effects/registry.js';
import { applySpectralMask, healSpectral, restrictEdit } from './process.js';
import {
  SPECTRAL_TOOLS,
  displayOn,
  pitchOn,
  logScale,
  settings,
  setSettings,
  docState,
  visibleBand,
  spectralSelection,
  setSpectralSelection,
  syncWithTimeSelection,
} from './state.js';

const MAX_AUTO_HEAL_SECONDS = 4;

export function installSpectral(app) {
  const layers = new Set();
  const rawApply = new WeakMap();
  let dspSync = null;
  const loadDsp = () =>
    dsp().then((d) => {
      dspSync = d;
      return d;
    });
  loadDsp().catch(() => {});

  const audio = () => (app.active?.kind === 'audio' ? app.active : null);
  const layerOf = (doc) => [...layers].find((l) => l.doc === doc);
  const invalidateDoc = (doc) => layerOf(doc)?.invalidate();
  const commit = (doc, label, state) => (rawApply.get(doc) || doc.apply.bind(doc))(label, state);

  const services = {
    async heal(doc, selection) {
      const d = dspSync || (await loadDsp());
      const next = healSpectral(doc.state, selection, d);
      if (commit(doc, 'Spot Healing Brush', next)) announce('Spot healing applied');
    },
    zoomFrequency(doc, factor, centre) {
      const nyq = doc.sampleRate / 2;
      const r = zoomRange(visibleBand(doc), factor, nyq, logScale(app), centre);
      const st = docState(doc);
      st.lo = r.lo;
      st.hi = r.hi >= nyq - 0.5 ? null : r.hi;
      invalidateDoc(doc);
    },
    resetFrequency(doc) {
      const st = docState(doc);
      st.lo = 0;
      st.hi = null;
      invalidateDoc(doc);
    },
  };

  /**
   * While a spectral selection exists, every same-length edit committed to the
   * document (effects, Amplify, the HUD, Silence, Mix Paste) is restricted to
   * the selected time-frequency region.
   */
  const patchApply = (doc) => {
    if (rawApply.has(doc)) return;
    const orig = doc.apply.bind(doc);
    rawApply.set(doc, orig);
    doc.apply = (label, state, opts) => {
      const sel = spectralSelection(app, doc);
      if (sel && dspSync && state && state !== doc.state) {
        try {
          state = restrictEdit(doc.state, state, sel, dspSync);
        } catch (err) {
          console.warn('[spectral] could not restrict the edit to the selection', err);
        }
      }
      return orig(label, state, opts);
    };
  };

  WaveformView.extensions.push({
    attach(view) {
      const doc = view.doc;
      if (doc.kind !== 'audio') return;
      const layer = new SpectralLayer(app, view, services);
      view.layers.push(layer);
      layers.add(layer);
      patchApply(doc);
      const off = doc.on('change', (e) => {
        if (e.kind === 'selection' || e.kind === 'history') syncWithTimeSelection(app, doc);
        if (e.kind === 'edit' || e.kind === 'history') layer.invalidate();
      });
      const destroy = layer.destroy.bind(layer);
      layer.destroy = () => {
        off();
        layers.delete(layer);
        destroy();
      };
    },
  });

  app.on('prefs', (key) => {
    if (key === 'spectralDisplay') {
      for (const l of layers) l.sync();
      if (!displayOn(app) && SPECTRAL_TOOLS.includes(app.tool)) app.setTool('time');
    } else if (key === 'spectralSettings') {
      for (const l of layers) {
        l.view.layout();
        l.invalidate();
      }
    } else if (key === 'spectralLog' || key === 'spectralPitch' || key === 'spectralGrid' || key === 'spectralGridOpacity' || key.startsWith('pitch')) for (const l of layers) l.invalidate();
    else if (key === 'spectralPlaySelected') app.syncGraph();
  });

  // Preferences > Spectral Displays: with a spectral selection, playback can
  // be limited to its frequency band (a steep band-pass on the file track).
  app.on('spectral-selection', (doc) => {
    if (doc === app.active && app.prefs.get('spectralPlaySelected')) app.syncGraph();
  });
  app.fileGraphHooks = app.fileGraphHooks || [];
  app.fileGraphHooks.push((graph, doc) => {
    if (!app.prefs.get('spectralPlaySelected')) return;
    const sel = spectralSelection(app, doc);
    const b = sel ? selectionBounds(sel) : null;
    const spec = b ? bandSlot(b.f0, b.f1, doc.sampleRate) : null;
    if (spec) for (const t of graph.tracks) t.fx = [...(t.fx || []), { ...spec, key: `${spec.key}:${t.id}` }];
  });

  // Spectral tools are available while the spectral display is showing.
  if (!app.toolProviders) app.toolProviders = [];
  app.toolProviders.push((id) => SPECTRAL_TOOLS.includes(id) && displayOn(app) && Boolean(audio()));

  const C = app.commands;
  const specOn = () => displayOn(app) && Boolean(audio());
  const brushTool = () => specOn() && (app.tool === 'brush' || app.tool === 'heal');
  const brushStep = (dSize, dOpacity) => {
    const s = settings(app);
    const size = Math.max(4, Math.min(200, Math.round(s.brushSize * dSize)));
    const opacity = Math.max(0.05, Math.min(1, Math.round((s.brushOpacity + dOpacity) * 100) / 100));
    setSettings(app, { brushSize: size, brushOpacity: opacity });
    app.setStatus(`Brush size ${size} px, opacity ${Math.round(opacity * 100)}%`);
    announce(`Brush size ${size}, opacity ${Math.round(opacity * 100)} percent`);
  };

  C.register([
    {
      id: 'view.spectral',
      label: 'Show Spectral Frequency Display',
      shortcut: 'Shift+D',
      // The spectral display belongs to the Waveform editor.
      enabled: () => app.active?.kind !== 'session',
      checked: () => displayOn(app),
      run: () => {
        const on = !displayOn(app);
        app.prefs.set('spectralDisplay', on);
        announce(on ? 'Spectral frequency display shown' : 'Spectral frequency display hidden');
      },
    },
    {
      id: 'view.spectralPitch',
      label: 'Show Spectral Pitch Display',
      enabled: () => app.active?.kind !== 'session',
      checked: () => pitchOn(app) && displayOn(app),
      run: () => {
        const on = !(pitchOn(app) && displayOn(app));
        app.prefs.set('spectralPitch', on);
        if (on && !displayOn(app)) app.prefs.set('spectralDisplay', true);
        announce(on ? 'Pitch contour shown' : 'Pitch contour hidden');
      },
    },
    { id: 'view.specLog', label: 'Logarithmic', checked: () => logScale(app), run: () => app.prefs.set('spectralLog', true) },
    { id: 'view.specLinear', label: 'Linear', checked: () => !logScale(app), run: () => app.prefs.set('spectralLog', false) },
    { id: 'view.zoomInFreq', label: 'Zoom In (Frequency)', shortcut: 'Alt+Shift+=', enabled: specOn, run: () => services.zoomFrequency(audio(), 0.6) },
    { id: 'view.zoomOutFreq', label: 'Zoom Out (Frequency)', shortcut: 'Alt+Shift+-', enabled: specOn, run: () => services.zoomFrequency(audio(), 1 / 0.6) },
    { id: 'view.zoomFullFreq', label: 'Zoom Out Full (Frequency)', enabled: specOn, run: () => services.resetFrequency(audio()) },
    {
      id: 'spectral.settings',
      label: 'Spectral Display Settings...',
      enabled: specOn,
      run: () => layerOf(audio())?.openSettings(),
    },
    { id: 'spectral.selectRange', label: 'Spectral Selection...', enabled: specOn, run: () => spectralSelectionDialog(app, audio()) },
    { id: 'spectral.brushSmaller', label: 'Decrease Brush Size', shortcut: '[', enabled: brushTool, run: () => brushStep(1 / 1.25, 0) },
    { id: 'spectral.brushLarger', label: 'Increase Brush Size', shortcut: ']', enabled: brushTool, run: () => brushStep(1.25, 0) },
    { id: 'spectral.opacityDown', label: 'Decrease Brush Opacity', shortcut: 'Shift+[', enabled: brushTool, run: () => brushStep(1, -0.1) },
    { id: 'spectral.opacityUp', label: 'Increase Brush Opacity', shortcut: 'Shift+]', enabled: brushTool, run: () => brushStep(1, 0.1) },
    {
      id: 'fx.autoHeal',
      label: 'Auto Heal Selection',
      shortcut: 'Mod+U',
      enabled: () => Boolean(audio()?.hasSelection || spectralSelection(app, audio())),
      repeatable: true,
      run: async () => {
        const doc = audio();
        const d = dspSync || (await loadDsp());
        let sel = spectralSelection(app, doc);
        // Healing works on the whole selection at once (memory grows with its length), so a
        // spectral selection has the same limit as a time selection.
        const bounds = sel ? selectionBounds(sel) : null;
        const [start, end] = sel
          ? [bounds?.t0 ?? 0, bounds?.t1 ?? 0]
          : [doc.selection.start, doc.selection.end];
        if ((end - start) / doc.sampleRate > MAX_AUTO_HEAL_SECONDS) {
          app.notify(`Auto Heal works on selections up to ${MAX_AUTO_HEAL_SECONDS} seconds. Select a shorter range around the problem.`, { error: true });
          return;
        }
        if (!sel) sel = timeSelection(start, end, doc.sampleRate / 2, doc.selection.channels.slice());
        commit(doc, 'Auto Heal', healSpectral(doc.state, sel, d));
      },
    },
  ]);

  // Delete removes the selected time-frequency region instead of time.
  const del = C.commands.get('edit.delete');
  if (del) {
    C.register({
      ...del,
      enabled: (a, args) => Boolean(spectralSelection(a, a.active)) || (del.enabled ? del.enabled(a, args) : true),
      run: async (a, args) => {
        const doc = a.active;
        const sel = spectralSelection(a, doc);
        if (!sel) return del.run(a, args);
        const d = dspSync || (await loadDsp());
        commit(doc, 'Delete', applySpectralMask(doc.state, sel, 0, d));
      },
    });
  }

  app.spectral = {
    /** The active spectral selection of doc (null without one). */
    selection: (doc = app.active) => spectralSelection(app, doc),
    /** Applies fn (samples, channel, start) => samples, or a gain, inside the selection as one undo step. */
    async apply(doc, label, fn) {
      const sel = spectralSelection(app, doc);
      if (!sel) return false;
      const d = dspSync || (await loadDsp());
      return commit(doc, label, applySpectralMask(doc.state, sel, fn, d));
    },
    clear: (doc = app.active) => doc && setSpectralSelection(app, doc, null),
    /** Sets a spectral selection ({ channels, shapes }, see mask.js). */
    set: (doc, selection) => setSpectralSelection(app, doc, selection),
    /** Commits a state without restricting it to the spectral selection (whole-file operations). */
    applyRaw: (doc, label, state) => commit(doc, label, state),
  };
}

/** Keyboard-friendly spectral selection: a time range and a frequency band. */
async function spectralSelectionDialog(app, doc) {
  const fmt = (f) => app.formatTime(f, doc.sampleRate);
  const st = docState(doc);
  const cur = st.selection?.shapes.length === 1 && st.selection.shapes[0].type === 'rect' ? st.selection.shapes[0] : null;
  const sel = doc.selection;
  const start = h('input.input', { type: 'text', value: fmt(cur ? cur.t0 : sel.start), 'aria-label': 'Start time' });
  const end = h('input.input', { type: 'text', value: fmt(cur ? cur.t1 : sel.end > sel.start ? sel.end : doc.length), 'aria-label': 'End time' });
  const lo = h('input.input.num', { type: 'number', min: '0', max: String(doc.sampleRate / 2), value: String(Math.round(cur ? cur.f0 : 0)), 'aria-label': 'Low frequency in hertz' });
  const hi = h('input.input.num', { type: 'number', min: '0', max: String(doc.sampleRate / 2), value: String(Math.round(cur ? cur.f1 : doc.sampleRate / 2)), 'aria-label': 'High frequency in hertz' });
  const r = await openDialog({
    title: 'Spectral Selection',
    body: h('div.form-grid', h('label', 'Start:'), start, h('label', 'End:'), end, h('label', 'Low Frequency (Hz):'), lo, h('label', 'High Frequency (Hz):'), hi),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Select', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return;
  const format = app.prefs.get('timeFormat');
  const t0 = parseTime(start.value, doc.sampleRate, format, app.timeOptions());
  const t1 = parseTime(end.value, doc.sampleRate, format, app.timeOptions());
  const f0 = Number(lo.value);
  const f1 = Number(hi.value);
  if (![t0, t1, f0, f1].every(Number.isFinite) || t1 <= t0 || f1 <= f0) {
    app.notify('Enter a start before the end and a low frequency below the high frequency.', { error: true });
    return;
  }
  setSpectralSelection(app, doc, { channels: doc.selection.channels.slice(), shapes: [{ type: 'rect', t0, t1, f0, f1 }] });
}

/**
 * Effect slot that passes only [f0, f1] Hz (Scientific Filter, 8th-order
 * Butterworth): band-pass, or low/high pass when the band reaches an end of
 * the spectrum. Null when the band is the whole spectrum.
 */
export function bandSlot(f0, f1, rate) {
  const def = getEffect('scientificFilter');
  if (!def) return null;
  const top = Math.min(20000, rate / 2);
  const lo = f0 > 15 ? Math.max(10, Math.min(top, f0)) : null;
  const hi = f1 < top * 0.98 ? Math.max(10, Math.min(top, f1)) : null;
  if (lo == null && hi == null) return null;
  const mode = lo != null && hi != null ? 2 : hi != null ? 0 : 1;
  const values = { type: 0, mode, order: 8, cutoff: mode === 0 ? hi : lo, highCutoff: hi ?? top, ripple: 1, gain: 0 };
  return slotSpec(def, values, { key: 'spectral-band', rate });
}
