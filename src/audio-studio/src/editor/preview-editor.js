// Preview Editor: while an effect dialog is open on an audio file, a second
// waveform under the editor shows the result of the effect with its current
// settings, for the part of the file in view (the effect applies to the
// selection, or to the whole visible range without one, through the dialog's
// channel map). It follows the main editor's zoom and scroll and updates a
// moment after settings change.
//
// View > Show Preview Editor turns it on (with no effect dialog open it shows
// the file as it is); independently of that, it also appears for effects that
// change the length of the audio (stretching, deleting silence) when
// Preferences > Effects asks for it (`previewAuto`).
//
// Zoom: Synchronized follows the main editor's view (the wheel over the preview
// zooms both); Independent keeps its own view of the file, zoomed with the wheel
// and reset with a double-click.

import { h } from '../lib/dom.js';
import { Channel } from '../audio/channel.js';
import { WaveformRenderer } from '../render/waveform-gl.js';
import { renderEffect, isAbort, isRealtime } from '../effects/apply.js';
import { cssVar, CANVAS_FONT } from '../ui/theme.js';
import { icon } from '../ui/icons.js';
import { TimeRuler } from './time-ruler.js';
import { Overview } from './overview.js';
import { dbTicks, linearTicks, AMP_UNITS } from './waveform-view.js';
import { channelColumns } from '../audio/peaks.js';

/** Most audio the preview processes, in seconds of the original. */
export const PREVIEW_MAX_SECONDS = 120;

/**
 * A view zoomed by `factor` (< 1 zooms in) around the frame at fraction `at` of its width,
 * kept within [0, max] and at least 16 frames wide.
 */
export function zoomViewAt(view, factor, at, max) {
  const span = view.end - view.start;
  const next = Math.max(16, Math.min(Math.max(16, max), span * factor));
  const anchor = view.start + at * span;
  let start = anchor - at * next;
  start = Math.max(0, Math.min(Math.max(0, max - next), start));
  return { start, end: start + next };
}

/**
 * Range the preview processes: the selection clipped to the view, or the
 * view itself. Returns null when nothing of the file is in view or the range
 * is too long to preview.
 */
export function previewRange(doc, maxSeconds = PREVIEW_MAX_SECONDS, view = doc.view) {
  const vs = Math.max(0, Math.floor(view.start));
  const ve = Math.min(doc.length, Math.ceil(view.end));
  if (ve <= vs) return null;
  let [a, b] = doc.hasSelection ? [Math.max(vs, doc.selection.start), Math.min(ve, doc.selection.end)] : [vs, ve];
  if (b <= a) return { view: [vs, ve], range: null };
  if (b - a > maxSeconds * doc.sampleRate) return { view: [vs, ve], range: null, tooLong: true };
  return { view: [vs, ve], range: [a, b] };
}

export function installPreviewEditor(app, host) {
  const canvas = h('canvas.preview-gl');
  const label = h('span.preview-label');
  const status = h('span.preview-status.faint', { role: 'status' });
  const close = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Hide the Preview Editor', title: 'Hide Preview Editor', onclick: () => app.prefs.set('previewEditor', false) }, icon('x', 13));
  const zoomSelect = h(
    'select.select.sm.preview-zoom',
    { 'aria-label': 'Preview Editor zoom', title: 'Synchronized follows the main editor; Independent keeps its own zoom (scroll to zoom, double-click to show the whole file)', onchange: () => app.prefs.set('previewZoom', zoomSelect.value) },
    h('option', { value: 'sync' }, 'Synchronized'),
    h('option', { value: 'independent' }, 'Independent'),
  );
  // A/B: the original audio or the effect's result, in this view and (through the effect
  // dialog's power button) in what plays.
  let showOriginal = false;
  const abBtn = h(
    'button.btn.sm.preview-ab',
    // A dialog companion: Tab reaches it from the effect dialog that it compares.
    { type: 'button', 'aria-pressed': 'false', title: 'Compare: show and play the original (A) or the processed audio (B)', disabled: true, dataset: { dialogCompanion: '' }, onclick: () => setOriginal(!showOriginal) },
    h('span.ab-a', 'A'),
    h('span.ab-sep', '/'),
    h('span.ab-b', 'B'),
  );
  const head = h('div.preview-head', h('span.preview-title', 'Preview Editor:'), label, abBtn, h('div.spacer'), status, h('label.preview-zoom-label', 'Zoom:', zoomSelect), close);
  const ampCanvas = h('canvas.preview-amp', { 'aria-hidden': 'true' });
  const surface = h('div.preview-surface', canvas, ampCanvas);
  const rulerRow = h('div.preview-ruler');
  const overviewRow = h('div.preview-overview');
  const el = h('div.preview-editor', { hidden: true, role: 'region', 'aria-label': 'Preview Editor' }, head, overviewRow, rulerRow, surface);
  host.append(el);
  const renderer = new WaveformRenderer(canvas);
  let current = null; // { def, values, doc }
  let result = null; // { channels, start, lengthDelta }
  let timer = 0;
  let controller = null;
  let changesLength = false;
  // Independent zoom: the preview's own view of each file.
  const ownViews = new WeakMap();
  const independent = () => app.prefs.get('previewZoom') === 'independent';
  const viewOf = (doc) => {
    if (!independent()) return doc.view;
    let v = ownViews.get(doc);
    if (!v) ownViews.set(doc, (v = { start: 0, end: Math.max(1, doc.length) }));
    return v;
  };
  // With no effect dialog open, View > Show Preview Editor shows the active file as it is.
  const idleDoc = () => (app.prefs.get('previewEditor') && app.active?.kind === 'audio' && app.active.length ? app.active : null);

  // Time ruler over the preview: its own view in Independent mode, the effect's
  // stretched or shrunk span when it changes the length.
  const ruler = new TimeRuler(app, {
    timeline: () => {
      const doc = current?.doc || idleDoc();
      if (!doc) return { rate: 48000, length: 0, view: { start: 0, end: 1 }, cursor: 0, selection: null, markers: [] };
      const v = viewOf(doc);
      const span = result && !result.idle && !showOriginal ? result.span : v.end - v.start;
      return { rate: doc.sampleRate, length: doc.length, view: { start: v.start, end: v.start + Math.max(1, span) }, cursor: app.active === doc ? app.playhead : doc.cursor, selection: null, markers: [] };
    },
    seek: (f) => {
      const doc = current?.doc || idleDoc();
      if (!doc) return;
      const view = app.currentView?.();
      if (view?.doc === doc && view.seek) view.seek(f);
      else doc.setCursor?.(Math.max(0, Math.min(doc.length, Math.round(f))));
    },
  });
  rulerRow.append(ruler.el);

  // Zoom navigator over the preview: the original file, framing the preview's view.
  const shownDoc = () => current?.doc || idleDoc();
  const overview = new Overview(app, {
    timeline: () => {
      const doc = shownDoc();
      if (!doc) return { rate: 48000, length: 0, view: { start: 0, end: 1 }, cursor: 0, selection: null };
      return { rate: doc.sampleRate, length: doc.length, view: viewOf(doc), cursor: app.active === doc ? app.playhead : doc.cursor, selection: doc.selection };
    },
    setView: (a, b) => {
      const doc = shownDoc();
      if (!doc) return;
      const span = Math.max(16, Math.min(Math.max(doc.length, 1), b - a));
      const start = Math.max(0, Math.min(Math.max(0, doc.length - span), a));
      setView(doc, { start, end: start + span });
    },
    viewMax: () => Math.max(1, shownDoc()?.length || 1),
    peaksKey: () => shownDoc()?.state,
    overviewPeaks: (cols, total) => {
      const doc = shownDoc();
      if (!doc?.length) return null;
      const strips = doc.state.channels.map((c) => channelColumns(c, 0, total / cols, cols));
      return strips.length === 1 ? strips[0] : strips;
    },
  });
  overviewRow.append(overview.el);

  // Automatic: for effects that change the length, or for any effect (Preferences > Effects).
  const wanted = () => (current ? Boolean(app.prefs.get('previewEditor') || (app.prefs.get('previewAuto') !== false && (changesLength || app.prefs.get('previewAutoMode') === 'any'))) : Boolean(idleDoc()));
  // While hidden for 'length', the preview still renders offline effects to find out
  // whether they change the length (realtime effects never do).
  const detecting = () => Boolean(current) && !changesLength && app.prefs.get('previewAuto') !== false && app.prefs.get('previewAutoMode') !== 'any' && !isRealtime(current.def);

  const sync = () => {
    zoomSelect.value = independent() ? 'independent' : 'sync';
    const show = wanted();
    if (!current) {
      const doc = idleDoc();
      label.textContent = doc ? doc.name : '';
      status.textContent = doc ? 'Open an effect to preview its result here.' : '';
    }
    if (el.hidden === !show) return show && draw();
    el.hidden = !show;
    if (show && current) {
      schedule(0);
      moveDialogAside();
    } else if (show) draw();
  };

  // The effect's dialog opens in the middle of the window, over the preview: move it aside.
  const powerButton = () => document.querySelector('.fx-dialog .fx-power');
  function syncAB() {
    // Effect dialogs are modal: the preview rises above their backdrop so A/B, zoom and
    // scrolling stay in reach while the dialog is open.
    el.classList.toggle('over-dialog', Boolean(current));
    abBtn.disabled = !current;
    abBtn.setAttribute('aria-pressed', String(Boolean(current) && showOriginal));
    abBtn.classList.toggle('showing-a', Boolean(current) && showOriginal);
    abBtn.setAttribute('aria-label', showOriginal ? 'Showing the original (A). Switch to the processed audio (B)' : 'Showing the processed audio (B). Switch to the original (A)');
  }
  function setOriginal(on) {
    if (!current) return;
    showOriginal = on;
    // The dialog's power button decides what plays: off while comparing with the original.
    const power = powerButton();
    if (power && (power.getAttribute('aria-pressed') === 'true') === on) power.click();
    syncAB();
    draw();
  }
  // Turning the effect off in its dialog shows the original here too.
  document.addEventListener('click', (e) => {
    if (!current || !(e.target instanceof Element) || !e.target.closest('.fx-dialog .fx-power')) return;
    const off = powerButton()?.getAttribute('aria-pressed') === 'false';
    if (off !== showOriginal) {
      showOriginal = off;
      syncAB();
      draw();
    }
  });

  // The settings arrive just before the dialog is on screen, so wait a few frames for it.
  const moveDialogAside = (tries = 10) => {
    requestAnimationFrame(() => {
      if (el.hidden || !current) return;
      const dlg = [...document.querySelectorAll('.dialog')].pop();
      if (dlg?.avoid) dlg.avoid(el.getBoundingClientRect());
      else if (tries > 0) moveDialogAside(tries - 1);
    });
  };

  const schedule = (delay = 250) => {
    clearTimeout(timer);
    timer = setTimeout(compute, delay);
  };

  async function compute() {
    controller?.abort();
    if (!current || !(wanted() || detecting())) return;
    const { def, values, doc, route = null } = current;
    const r = previewRange(doc, PREVIEW_MAX_SECONDS, viewOf(doc));
    label.textContent = `${def.name}`;
    if (!r?.range) {
      result = null;
      status.textContent = r?.tooLong ? 'Zoom in or select less to preview.' : 'Nothing to preview here.';
      draw();
      return;
    }
    const ctrl = (controller = new AbortController());
    status.textContent = 'Rendering...';
    try {
      const [a, b] = r.range;
      const out = await renderEffect({ def, values, state: doc.state, start: a, end: b, mask: doc.channelMask, route, signal: ctrl.signal, doc, app });
      if (ctrl.signal.aborted) return;
      const delta = out.length - (b - a);
      if (delta !== 0 && !changesLength) {
        changesLength = true;
        sync();
        clearTimeout(timer); // this render is the one to show
      }
      if (el.hidden) return;
      // The processed state: show the view range, stretched or shrunk by the effect,
      // at the main editor's scale (a view running past the end of the file stays blank there).
      const [vs, ve] = r.view;
      const v = viewOf(doc);
      result = { channels: out.state.channels.map((c) => c.slice(vs, Math.max(vs + 1, ve + delta))), start: v.start - vs, span: v.end - v.start + delta };
      status.textContent = delta ? `Length ${delta > 0 ? '+' : '-'}${app.formatTime(Math.abs(delta), doc.sampleRate)}` : '';
      draw();
    } catch (err) {
      if (isAbort(err)) return;
      result = null;
      status.textContent = err?.message || 'The preview could not be rendered.';
      draw();
    }
  }

  function draw() {
    if (el.hidden) return;
    const rect = surface.getBoundingClientRect();
    // Line up with the main waveform's lanes (they sit inside a margin and leave room for the dB ruler).
    const wave = app.currentView?.()?.surface?.getBoundingClientRect?.();
    const left = wave && wave.width ? Math.max(0, wave.left - rect.left) : 0;
    const W = Math.max(1, Math.min(rect.width - left, wave?.width || rect.width));
    canvas.style.left = `${left}px`;
    for (const row of [ruler.el, overview.el]) {
      row.style.marginLeft = `${left}px`;
      row.style.width = `${W}px`;
    }
    ruler.resize(W, rulerRow.clientHeight || 20);
    overview.resize(W, overviewRow.clientHeight || 18);
    if (overview.ctx) overview.draw();
    const H = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    renderer.resize(W, H, dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const idle = !current && idleDoc();
    if (idle) {
      // The file as it is, for the preview's view.
      const v = viewOf(idle);
      result = { channels: idle.state.channels, start: v.start, span: v.end - v.start, idle: true };
    } else if (result?.idle) result = null;
    if (ruler.ctx) ruler.draw();
    if (!result || !(current || idle)) {
      renderer.draw({ channels: [], start: 0, fpp: 1, amp: 1, lanes: [], colors: [] });
      return;
    }
    // A: the original audio of the same view.
    const ov = current && showOriginal ? viewOf(current.doc) : null;
    const shown = ov ? { channels: current.doc.state.channels, start: ov.start, span: ov.end - ov.start } : result;
    const n = shown.channels.length;
    const gap = n > 1 ? dpr : 0;
    const lh = (H * dpr - gap * (n - 1)) / n;
    const lanes = shown.channels.map((_, i) => ({ top: i * (lh + gap), bottom: i * (lh + gap) + lh }));
    const color = cssVar(ov ? '--wave-dim' : '--wave');
    const view = (current?.doc || idle).view;
    renderer.draw({ channels: shown.channels, start: shown.start, fpp: Math.max(1e-3, shown.span / (W * dpr)), amp: view.amp || 1, offset: view.ampOffset || 0, lanes, colors: shown.channels.map(() => color) });
    drawAmpRuler(lanes.map((l) => ({ top: l.top / dpr, bottom: l.bottom / dpr })), left + W, Math.min(54, rect.width - left - W), H, view, (current?.doc || idle).info?.bitDepth);
  }

  /** The amplitude ruler beside the preview lanes, in the main editor's units. */
  function drawAmpRuler(lanes, x, w, H, view, bits = 32) {
    const dpr = window.devicePixelRatio || 1;
    ampCanvas.hidden = w < 20;
    if (ampCanvas.hidden) return;
    Object.assign(ampCanvas.style, { left: `${x}px`, width: `${w}px`, height: `${H}px` });
    ampCanvas.width = Math.round(w * dpr);
    ampCanvas.height = Math.round(H * dpr);
    const ctx = ampCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, H);
    ctx.font = CANVAS_FONT;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = cssVar('--text-dim');
    const amp = view.amp || 1;
    const off = view.ampOffset || 0;
    const unit = AMP_UNITS.some((u) => u.id === app.prefs.get('ampUnits')) ? app.prefs.get('ampUnits') : 'db';
    for (const lane of lanes) {
      const mid = (lane.top + lane.bottom) / 2;
      const zero = mid + off * amp * ((lane.bottom - lane.top) / 2);
      const ticks = unit === 'db' ? dbTicks(lane, amp, off).map((t) => ({ ...t, label: t.db === 0 ? '0' : String(t.db) })) : linearTicks(lane, amp, unit, bits, off).map((t) => ({ ...t, label2: `-${t.label}` }));
      for (const t of ticks) {
        for (const [y, label] of [[t.y, t.label], [t.y2, t.label2 ?? t.label]]) {
          if (y === null || y === undefined) continue;
          ctx.fillRect(0, Math.round(y), 4, 1);
          ctx.fillText(label, 6, y);
        }
      }
      if (zero >= lane.top + 10 && zero <= lane.bottom - 4) ctx.fillText(unit === 'db' ? '-\u221e' : '0', 6, zero);
    }
  }

  app.on('effect-values', (payload) => {
    const docChanged = payload?.doc !== current?.doc || payload?.def !== current?.def;
    current = payload && payload.doc?.kind === 'audio' ? payload : null;
    if (!current) {
      controller?.abort();
      clearTimeout(timer);
      result = null;
      changesLength = false;
      showOriginal = false;
      syncAB();
      el.hidden = true;
      sync();
      return;
    }
    if (docChanged) {
      changesLength = false;
      showOriginal = false;
    }
    syncAB();
    sync();
    if (docChanged && !el.hidden) moveDialogAside();
    if (!el.hidden || detecting()) schedule(docChanged ? 0 : 250);
  });
  app.on('doc-change', (doc, e) => {
    if (!current && doc === idleDoc() && !el.hidden) {
      if (e.kind !== 'cursor' && e.kind !== 'selection' && (e.kind !== 'view' || !independent())) draw();
      return;
    }
    if (!current || doc !== current.doc || (el.hidden && !detecting())) return;
    if (e.kind === 'view' || e.kind === 'selection' || e.kind === 'edit' || e.kind === 'history') schedule(e.kind === 'view' ? 120 : 250);
  });
  app.on?.('active', () => !current && sync());
  app.prefs.on('change', (key) => {
    if (key === 'previewEditor' || key === 'previewAuto' || key === 'previewAutoMode') sync();
    else if (key === 'previewZoom') {
      sync();
      if (current) schedule(0);
      else draw();
    }
  });

  // Wheel: zoom around the pointer (Shift or horizontal motion scrolls); in Synchronized
  // mode this moves the main editor too. Double-click shows the whole file.
  const zoomTarget = () => current?.doc || idleDoc();
  const setView = (doc, v) => {
    if (independent()) {
      ownViews.set(doc, v);
      if (current) schedule(120);
      else draw();
    } else doc.setView?.(v.start, v.end);
  };
  surface.addEventListener(
    'wheel',
    (e) => {
      const doc = zoomTarget();
      if (!doc) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const v = viewOf(doc);
      const span = v.end - v.start;
      const max = Math.max(doc.length, 1);
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      if (Math.abs(dx) > Math.abs(e.deltaY) || e.shiftKey) {
        const start = Math.max(0, Math.min(Math.max(0, max - span), v.start + (dx / Math.max(1, rect.width)) * span));
        setView(doc, { start, end: start + span });
        return;
      }
      const at = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      setView(doc, zoomViewAt(v, Math.pow(1.0015, e.deltaY), at, max));
    },
    { passive: false },
  );
  surface.addEventListener('dblclick', () => {
    const doc = zoomTarget();
    if (doc) setView(doc, { start: 0, end: Math.max(1, doc.length) });
  });
  new ResizeObserver(() => draw()).observe(surface);
  installPreviewEditorCommands(app);
}

/** View > Show Preview Editor: a preference, so it is registered with the app, not the editor panel. */
export function installPreviewEditorCommands(app) {
  if (app.commands.get?.('view.previewEditor')) return;
  app.commands.register([
    { id: 'view.previewEditor', label: 'Show Preview Editor', checked: (a) => Boolean(a.prefs.get('previewEditor')), run: () => app.prefs.toggle('previewEditor') },
  ]);
}
