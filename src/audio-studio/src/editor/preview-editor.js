// Preview Editor: while an effect dialog is open on an audio file, a second
// waveform under the editor shows the result of the effect with its current
// settings, for the part of the file in view (the effect applies to the
// selection, or to the whole visible range without one). It follows the main
// editor's zoom and scroll and updates a moment after settings change.
//
// View > Show Preview Editor turns it on; independently of that, it also
// appears for effects that change the length of the audio (stretching,
// deleting silence) when Preferences > Effects asks for it (`previewAuto`).

import { h } from '../lib/dom.js';
import { Channel } from '../audio/channel.js';
import { WaveformRenderer } from '../render/waveform-gl.js';
import { renderEffect, isAbort } from '../effects/apply.js';
import { cssVar } from '../ui/theme.js';
import { icon } from '../ui/icons.js';

/** Most audio the preview processes, in seconds of the original. */
export const PREVIEW_MAX_SECONDS = 120;

/**
 * Range the preview processes: the selection clipped to the view, or the
 * view itself. Returns null when nothing of the file is in view or the range
 * is too long to preview.
 */
export function previewRange(doc, maxSeconds = PREVIEW_MAX_SECONDS) {
  const vs = Math.max(0, Math.floor(doc.view.start));
  const ve = Math.min(doc.length, Math.ceil(doc.view.end));
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
  const head = h('div.preview-head', h('span.preview-title', 'Preview'), label, h('div.spacer'), status, close);
  const surface = h('div.preview-surface', canvas);
  const el = h('div.preview-editor', { hidden: true, role: 'region', 'aria-label': 'Preview Editor' }, head, surface);
  host.append(el);
  const renderer = new WaveformRenderer(canvas);
  let current = null; // { def, values, doc }
  let result = null; // { channels, start, lengthDelta }
  let timer = 0;
  let controller = null;
  let changesLength = false;

  // Automatic: for effects that change the length, or for any effect (Preferences > Effects).
  const wanted = () => Boolean(current) && (app.prefs.get('previewEditor') || (app.prefs.get('previewAuto') !== false && (changesLength || app.prefs.get('previewAutoMode') === 'any')));

  const sync = () => {
    const show = wanted();
    if (el.hidden === !show) return show && draw();
    el.hidden = !show;
    if (show) schedule(0);
  };

  const schedule = (delay = 250) => {
    clearTimeout(timer);
    timer = setTimeout(compute, delay);
  };

  async function compute() {
    controller?.abort();
    if (!current || !wanted()) return;
    const { def, values, doc } = current;
    const r = previewRange(doc);
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
      const out = await renderEffect({ def, values, state: doc.state, start: a, end: b, mask: doc.channelMask, signal: ctrl.signal, doc, app });
      if (ctrl.signal.aborted) return;
      const delta = out.length - (b - a);
      if (delta !== 0 && !changesLength) {
        changesLength = true;
        sync();
      }
      // The processed state: show the view range, stretched or shrunk by the effect,
      // at the main editor's scale (a view running past the end of the file stays blank there).
      const [vs, ve] = r.view;
      const v = doc.view;
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
    const H = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    renderer.resize(W, H, dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    if (!result || !current) {
      renderer.draw({ channels: [], start: 0, fpp: 1, amp: 1, lanes: [], colors: [] });
      return;
    }
    const n = result.channels.length;
    const gap = n > 1 ? dpr : 0;
    const lh = (H * dpr - gap * (n - 1)) / n;
    const lanes = result.channels.map((_, i) => ({ top: i * (lh + gap), bottom: i * (lh + gap) + lh }));
    const color = cssVar('--wave');
    renderer.draw({ channels: result.channels, start: result.start, fpp: Math.max(1e-3, result.span / (W * dpr)), amp: current.doc.view.amp || 1, lanes, colors: result.channels.map(() => color) });
  }

  app.on('effect-values', (payload) => {
    const docChanged = payload?.doc !== current?.doc || payload?.def !== current?.def;
    current = payload && payload.doc?.kind === 'audio' ? payload : null;
    if (!current) {
      controller?.abort();
      clearTimeout(timer);
      result = null;
      changesLength = false;
      el.hidden = true;
      return;
    }
    if (docChanged) changesLength = false;
    sync();
    if (!el.hidden) schedule(docChanged ? 0 : 250);
  });
  app.on('doc-change', (doc, e) => {
    if (!current || doc !== current.doc || el.hidden) return;
    if (e.kind === 'view' || e.kind === 'selection' || e.kind === 'edit' || e.kind === 'history') schedule(e.kind === 'view' ? 120 : 250);
  });
  app.prefs.on('change', (key) => (key === 'previewEditor' || key === 'previewAuto' || key === 'previewAutoMode') && sync());
  new ResizeObserver(() => draw()).observe(surface);

  app.commands.register([
    { id: 'view.previewEditor', label: 'Show Preview Editor', checked: (a) => Boolean(a.prefs.get('previewEditor')), run: () => app.prefs.toggle('previewEditor') },
  ]);
}
