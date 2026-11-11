// Amplitude Statistics panel: scans the selection or the whole file in an
// analysis worker (Rust kernels) and reports per channel peak and true peak
// levels, clipping, DC offset, sample extremes, RMS levels, measured bit
// depth, dynamic range and BS.1770-4 loudness (General tab, copyable), how
// often each RMS level occurs (RMS Histogram tab), and the RMS window width
// and 0 dB reference the scan uses (RMS Settings tab).

import { h, announce } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { cssVar, CANVAS_FONT } from '../ui/theme.js';
import { subTabs } from '../panels/subtabs.js';
import { analysisPool } from './pool.js';
import { fmtDb, gainToDb, fitCanvas } from './common.js';
import { HIST_BINS, binDb } from './rms-histogram.js';

/** RMS settings: window width in ms and the 0 dB reference (full-scale square or sine wave). */
export const RMS_DEFAULTS = { windowMs: 50, ref: 'square' };
// A full-scale sine has an RMS 3.01 dB below a full-scale square wave.
const SINE_OFFSET = 20 * Math.log10(Math.SQRT2);
export const rmsOffset = (settings) => (settings?.ref === 'sine' ? SINE_OFFSET : 0);

const CHUNK = 1 << 18;
const NAMES = ['Left', 'Right', 'Center', 'LFE', 'Left Surround', 'Right Surround'];

/** Streams frames [start, end) of channels through a worker stats session. */
export async function scanStats(channels, rate, start, end, { onProgress, signal, windowMs = RMS_DEFAULTS.windowMs } = {}) {
  const pool = analysisPool();
  const session = await pool.session('stats', { rate, channels: channels.length, windowMs });
  const win = Math.max(1, Math.round(rate * (windowMs / 1000)));
  const chunk = Math.max(win, Math.floor(CHUNK / win) * win);
  try {
    for (let at = start; at < end; at += chunk) {
      if (signal?.aborted) throw new Error('Cancelled');
      const n = Math.min(chunk, end - at);
      await session.push(channels.map((c) => c.toArray(at, at + n)));
      onProgress?.((at + n - start) / Math.max(1, end - start));
    }
  } catch (err) {
    session.close().catch(() => {});
    throw err;
  }
  return session.close();
}

/** Report rows from a stats result: [label, perChannel[] | single value]. */
export function statsRows(result, channelCount, settings = RMS_DEFAULTS) {
  const ch = result.channels;
  const L = result.loudness;
  const per = (fn) => ch.slice(0, channelCount).map(fn);
  const frames = (c) => Math.max(1, c.frames);
  const off = rmsOffset(settings);
  const rmsDb = (g) => fmtDb(gainToDb(g) + off);
  // A range shorter than the RMS window is measured as one window.
  const total = (c) => Math.sqrt(c.sq / frames(c));
  const win = (c) => (c.rmsCount ? null : c.frames ? total(c) : 0);
  return [
    ['Peak Amplitude', per((c) => `${fmtDb(gainToDb(Math.max(Math.abs(c.min), Math.abs(c.max))))} dB`)],
    ['True Peak Amplitude', per((c, i) => `${fmtDb(gainToDb(L.truePeak[i]))} dBTP`)],
    ['Possibly Clipped Samples', per((c) => String(c.clipped))],
    ['DC Offset', per((c) => `${((c.sum / frames(c)) * 100).toFixed(3)} %`)],
    ['Minimum Sample Value', per((c) => (c.frames ? c.min.toFixed(5) : '0'))],
    ['Maximum Sample Value', per((c) => (c.frames ? c.max.toFixed(5) : '0'))],
    ['Minimum RMS Amplitude', per((c) => `${rmsDb(win(c) ?? c.rmsMin)} dB`)],
    ['Maximum RMS Amplitude', per((c) => `${rmsDb(win(c) ?? c.rmsMax)} dB`)],
    ['Average RMS Amplitude', per((c) => `${rmsDb(win(c) ?? c.rmsSum / c.rmsCount)} dB`)],
    ['Total RMS Amplitude', per((c) => `${rmsDb(total(c))} dB`)],
    ['Dynamic Range', per((c) => (c.rmsCount && c.rmsMin > 0 ? `${(gainToDb(c.rmsMax) - gainToDb(c.rmsMin)).toFixed(2)} dB` : win(c) > 0 ? '0.00 dB' : '∞ dB'))],
    ['Measured Bit Depth', per((c) => (c.bits === 0 ? 'Silent' : c.bits === 32 ? '32 (float)' : String(c.bits)))],
    ['Integrated Loudness', `${fmtDb(L.integrated)} LUFS`],
    ['Loudness Range', `${L.range.toFixed(2)} LU`],
    ['Maximum Momentary Loudness', `${fmtDb(L.maxMomentary)} LUFS`],
    ['Maximum Short-Term Loudness', `${fmtDb(L.maxShortTerm)} LUFS`],
  ];
}

/** Percent of windows per bin, per channel, trimmed to the bins in use (with a little margin). */
export function histogramSeries(result, channelCount) {
  const hists = result.channels.slice(0, channelCount).map((c) => c.hist || new Uint32Array(HIST_BINS));
  let lo = HIST_BINS;
  let hi = -1;
  for (const hst of hists) {
    for (let i = 0; i < HIST_BINS; i++) {
      if (!hst[i]) continue;
      lo = Math.min(lo, i);
      hi = Math.max(hi, i);
    }
  }
  if (hi < 0) return { lo: 0, hi: HIST_BINS - 1, series: hists.map(() => new Float32Array(HIST_BINS)) };
  lo = Math.max(0, lo - 3);
  hi = Math.min(HIST_BINS - 1, hi + 3);
  const series = hists.map((hst) => {
    const total = hst.reduce((a, b) => a + b, 0) || 1;
    return Float32Array.from(hst, (v) => (v / total) * 100);
  });
  return { lo, hi, series };
}

export function amplitudePanel(app) {
  const settings = () => ({ ...RMS_DEFAULTS, ...(app.prefs.get('amplitudeStats') || {}) });
  const scanSel = h('button.btn', { type: 'button', onclick: () => scan(true) }, 'Scan Selection');
  const scanAll = h('button.btn', { type: 'button', onclick: () => scan(false) }, 'Scan File');
  const cancelBtn = h('button.btn', { type: 'button', hidden: true, onclick: () => abort?.abort() }, 'Cancel');
  const copyBtn = h('button.btn', { type: 'button', title: 'Copy the statistics as tab-separated text', disabled: true, onclick: () => copy() }, icon('copy', 13), 'Copy All');
  const footer = h('div.panel-toolbar.analysis-toolbar.amplitude-actions', scanSel, scanAll, cancelBtn, h('div.spacer'), copyBtn);
  const progress = h('div.analysis-progress', { role: 'progressbar', 'aria-label': 'Scan progress', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true }, h('div.analysis-progress-bar'));
  const caption = h('div.analysis-caption', { 'aria-live': 'polite' });
  const head = h('thead');
  const body = h('tbody');
  const table = h('table.data-table.stats-table', { 'aria-label': 'Amplitude statistics' }, head, body);

  // RMS Histogram.
  const histCanvas = h('canvas', { 'aria-hidden': 'true' });
  const histPlot = h('div.rms-hist', { tabindex: '0', role: 'img', 'aria-label': 'RMS histogram' }, histCanvas);
  const histReadout = h('div.analysis-readout');
  const histLegend = h('div.freq-legend');
  const histEmpty = h('div.empty-state', 'Scan to see how often each RMS level occurs.');
  const histPane = h('div.rms-hist-pane', histEmpty, histPlot, h('div.analysis-foot', histReadout, histLegend));

  // RMS Settings.
  const s0 = settings();
  const widthInput = h('input.input', { type: 'number', min: '1', max: '1000', step: '1', value: String(s0.windowMs), id: 'amp-rms-width', 'aria-describedby': 'amp-rms-note' });
  widthInput.addEventListener('keydown', (e) => e.stopPropagation());
  widthInput.addEventListener('change', () => {
    const v = Math.round(Number(widthInput.value));
    const ms = Number.isFinite(v) ? Math.max(1, Math.min(1000, v)) : RMS_DEFAULTS.windowMs;
    widthInput.value = String(ms);
    app.prefs.set('amplitudeStats', { ...settings(), windowMs: ms });
    settingsChanged();
  });
  const refRadios = [
    ['square', 'Full-scale square wave'],
    ['sine', 'Full-scale sine wave'],
  ].map(([value, label]) => {
    const r = h('input', { type: 'radio', name: `amp-ref-${Math.random().toString(36).slice(2)}`, value, checked: s0.ref === value });
    r.addEventListener('change', () => {
      if (!r.checked) return;
      app.prefs.set('amplitudeStats', { ...settings(), ref: value });
      settingsChanged();
    });
    return h('label.check', r, label);
  });
  const settingsNote = h('p.muted.rms-note', { id: 'amp-rms-note' }, '');
  const settingsPane = h(
    'div.rms-settings',
    h('div.form-grid', h('label', { for: 'amp-rms-width' }, 'Window Width:'), h('div.rms-width', widthInput, h('span.muted', 'ms'))),
    h('fieldset.rms-ref', h('legend', '0 dB reference:'), ...refRadios),
    settingsNote,
  );

  const generalPane = h('div.amplitude-general', caption, h('div.table-scroll', table));
  const tabs = subTabs(
    [
      { id: 'general', label: 'General', pane: generalPane },
      { id: 'histogram', label: 'RMS Histogram', pane: histPane },
      { id: 'settings', label: 'RMS Settings', pane: settingsPane },
    ],
    { label: 'Amplitude statistics views', value: app.prefs.get('amplitudeTab') || 'general', onChange: (id) => {
      app.prefs.set('amplitudeTab', id);
      drawHist();
    } },
  );
  const el = h('div.analysis-panel.amplitude-panel', tabs.el, progress, footer);

  let abort = null;
  let last = null; // { result, rows, names, title, settings }
  let hoverBin = null;

  function settingsChanged() {
    const s = settings();
    if (last && (last.settings.windowMs !== s.windowMs || last.settings.ref !== s.ref)) {
      // The 0 dB reference only shifts levels; a new window width needs a new scan.
      if (last.settings.windowMs === s.windowMs) {
        last = { ...last, rows: statsRows(last.result, last.names.length, s), settings: s };
        render();
        drawHist();
      } else settingsNote.textContent = 'Scan again to apply the new window width.';
    }
    if (!last || last.settings.windowMs === s.windowMs) settingsNote.textContent = '';
  }

  const refresh = () => {
    const doc = app.active?.kind === 'audio' ? app.active : null;
    const busy = Boolean(abort);
    scanSel.disabled = busy || !doc?.hasSelection;
    scanAll.disabled = busy || !doc?.length;
    cancelBtn.hidden = !busy;
    copyBtn.disabled = !last;
    histEmpty.hidden = Boolean(last);
    histPlot.hidden = !last;
    if (!last) {
      head.replaceChildren();
      body.replaceChildren(h('tr', h('td.empty-row', h('span.empty-text', doc ? 'Scan the selection or the whole file to measure its levels.' : 'Open an audio file to measure its levels.'))));
      histLegend.replaceChildren();
      histReadout.textContent = '';
    }
  };

  const render = () => {
    const { rows, names } = last;
    head.replaceChildren(h('tr', h('th', { scope: 'col' }, ''), ...names.map((n) => h('th.num', { scope: 'col' }, n))));
    body.replaceChildren(
      ...rows.map(([label, v]) =>
        h('tr', h('th', { scope: 'row' }, label), ...(Array.isArray(v) ? v.map((x) => h('td.num', x)) : [h('td.num', { colspan: String(names.length) }, v)])),
      ),
    );
  };

  const channelColor = (i) => (i === 0 ? cssVar('--wave') : i === 1 ? cssVar('--accent-strong') : ['#e2c400', '#c25bd6', '#f08a24', '#29c4d6'][(i - 2) % 4]);

  function drawHist() {
    if (!last || tabs.value !== 'histogram') return;
    const fit = fitCanvas(histCanvas, histPlot);
    if (!fit) return;
    const { ctx, W, H } = fit;
    const { lo, hi, series } = histogramSeries(last.result, last.names.length);
    const off = rmsOffset(last.settings);
    const g = { left: 36, right: W - 8, top: 8, bottom: H - 18 };
    const maxPct = Math.max(1, ...series.map((s) => Math.max(...s.subarray(lo, hi + 1))));
    const top = Math.ceil(maxPct / 5) * 5;
    const n = hi - lo + 1;
    const bw = (g.right - g.left) / n;
    const xOf = (bin) => g.left + (bin - lo) * bw;
    const yOf = (pct) => g.bottom - (pct / top) * (g.bottom - g.top);
    ctx.fillStyle = cssVar('--bg-editor');
    ctx.fillRect(g.left, g.top, g.right - g.left, g.bottom - g.top);
    ctx.font = CANVAS_FONT;
    // Percent grid.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const pctStep = top <= 10 ? 2 : top <= 30 ? 5 : 10;
    for (let p = 0; p <= top; p += pctStep) {
      const y = Math.round(yOf(p)) + 0.5;
      ctx.fillStyle = cssVar('--grid');
      ctx.fillRect(g.left, y, g.right - g.left, 1);
      ctx.fillStyle = cssVar('--text-dim');
      ctx.fillText(`${p}%`, g.left - 4, y);
    }
    // dB labels.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const every = [1, 2, 3, 6, 12, 24].find((e) => e * bw >= 30) || 24;
    for (let b = lo; b <= hi; b++) {
      const db = Math.round(binDb(b) + off);
      if (db % every) continue;
      const x = xOf(b) + bw / 2;
      ctx.fillStyle = cssVar('--grid');
      ctx.fillRect(Math.round(x), g.top, 1, g.bottom - g.top);
      ctx.fillStyle = cssVar('--text-dim');
      ctx.fillText(String(db), x, g.bottom + 4);
    }
    // Bars: channels side by side within a bin.
    series.forEach((s, c) => {
      ctx.fillStyle = channelColor(c);
      ctx.globalAlpha = 0.85;
      const w = Math.max(1, bw / series.length - (bw > 6 ? 1 : 0));
      for (let b = lo; b <= hi; b++) {
        if (!s[b]) continue;
        const y = yOf(s[b]);
        ctx.fillRect(xOf(b) + c * (bw / series.length), y, w, g.bottom - y);
      }
      ctx.globalAlpha = 1;
    });
    if (hoverBin !== null && hoverBin >= lo && hoverBin <= hi) {
      ctx.fillStyle = cssVar('--text-strong');
      ctx.globalAlpha = 0.15;
      ctx.fillRect(xOf(hoverBin), g.top, bw, g.bottom - g.top);
      ctx.globalAlpha = 1;
      const db = binDb(hoverBin) + off;
      histReadout.textContent = `${db.toFixed(0)} dB  ${last.names.map((nm, c) => `${nm} ${series[c][hoverBin].toFixed(1)} %`).join('  ')}`;
    } else {
      // Most common level of the first channel.
      let best = lo;
      for (let b = lo; b <= hi; b++) if (series[0][b] > series[0][best]) best = b;
      histReadout.textContent = `Most common RMS level: ${(binDb(best) + off).toFixed(0)} dB (${last.names[0]})`;
    }
    histPlot.setAttribute('aria-label', `RMS histogram. ${histReadout.textContent}`);
    histLegend.replaceChildren(...last.names.map((nm, c) => h('span.legend-item', h('span.swatch', { style: { background: channelColor(c) } }), nm)));
    histPlot._geom = { g, lo, hi, bw };
  }

  histPlot.addEventListener('pointermove', (e) => {
    const geom = histPlot._geom;
    if (!geom) return;
    const x = e.clientX - histPlot.getBoundingClientRect().left;
    const b = geom.lo + Math.floor((x - geom.g.left) / geom.bw);
    hoverBin = b >= geom.lo && b <= geom.hi ? b : null;
    drawHist();
  });
  histPlot.addEventListener('pointerleave', () => {
    hoverBin = null;
    drawHist();
  });
  histPlot.addEventListener('keydown', (e) => {
    const geom = histPlot._geom;
    if (!geom) return;
    if (e.key === 'ArrowLeft') hoverBin = Math.max(geom.lo, (hoverBin ?? geom.hi + 1) - 1);
    else if (e.key === 'ArrowRight') hoverBin = Math.min(geom.hi, (hoverBin ?? geom.lo - 1) + 1);
    else if (e.key === 'Escape') hoverBin = null;
    else return;
    e.preventDefault();
    e.stopPropagation();
    drawHist();
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => drawHist()).observe(histPlot);

  async function scan(selectionOnly) {
    const doc = app.active;
    if (!doc || doc.kind !== 'audio' || abort) return;
    const [start, end] = selectionOnly && doc.hasSelection ? [doc.selection.start, doc.selection.end] : [0, doc.length];
    const s = settings();
    abort = new AbortController();
    progress.hidden = false;
    const bar = progress.firstChild;
    bar.style.width = '0%';
    caption.textContent = `Scanning ${doc.name}...`;
    settingsNote.textContent = '';
    refresh();
    try {
      const result = await scanStats(doc.state.channels, doc.sampleRate, start, end, {
        signal: abort.signal,
        windowMs: s.windowMs,
        onProgress: (f) => {
          bar.style.width = `${Math.round(f * 100)}%`;
          progress.setAttribute('aria-valuenow', String(Math.round(f * 100)));
        },
      });
      const n = doc.channelCount;
      const names = n === 1 ? ['Mono'] : doc.state.channels.map((_, i) => NAMES[i] || `Channel ${i + 1}`);
      const title = `${doc.name}, ${selectionOnly && doc.hasSelection ? `selection ${app.formatTime(start)} to ${app.formatTime(end)}` : 'entire file'}`;
      last = { result, rows: statsRows(result, n, s), names, title, settings: s };
      caption.textContent = `Statistics for ${title}`;
      render();
      announce('Amplitude statistics ready');
    } catch (err) {
      caption.textContent = err.message === 'Cancelled' ? 'Scan cancelled.' : `Scan failed: ${err.message}`;
    } finally {
      abort = null;
      progress.hidden = true;
      refresh();
      drawHist();
    }
  }

  async function copy() {
    if (!last) return;
    const lines = [last.title, ['', ...last.names].join('\t'), ...last.rows.map(([label, v]) => [label, ...(Array.isArray(v) ? v : [v])].join('\t'))];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      app.notify('Statistics copied.');
    } catch {
      app.notify('Copying is not allowed here.', { error: true });
    }
  }

  app.on('active', () => {
    last = null;
    caption.textContent = '';
    refresh();
  });
  app.on('doc-change', (doc, e) => doc === app.active && (e.kind === 'selection' || e.kind === 'edit' || e.kind === 'history') && refresh());
  refresh();
  return {
    el,
    show() {
      refresh();
      drawHist();
    },
    focus: () => (scanAll.disabled ? scanSel : scanAll).focus(),
    scan: (selectionOnly) => scan(Boolean(selectionOnly)),
    /** For tests: the latest scan. */
    get result() {
      return last;
    },
  };
}
