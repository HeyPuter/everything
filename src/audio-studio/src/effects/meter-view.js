// Live display of the Loudness Meter effect, in two tabs.
//   Levels: short-term, integrated, loudness range and true peak as large
//     numbers (with a reset), then bars on tick scales for the input peak
//     (dBTP) and the short-term, integrated and momentary loudness around the
//     target, the maxima, a scrolling history of the last minute, and
//     "Scan Selection" / "Scan File", which measures offline with the same
//     BS.1770-4 meter (analysis/loudness.js) without playing and shows the
//     result in the same readouts (short-term as its maximum).
//   Settings: the loudness standard (target and true peak ceiling), units
//     (LUFS or LU relative to the target) and the bar scale.
// It is fed by the effect's readout (wasm/dsp/src/fx/special/meter.rs) while
// audio plays through the effect: a dialog preview, the Effects Rack or a
// track's effects.

import { h, announce } from '../lib/dom.js';
import { cssVar } from '../ui/theme.js';
import { icon } from '../ui/icons.js';
import { plot, gridLines, labelText } from './editors.js';
import { tabPanels, controlsFor } from './layout.js';
import { measureLoudness } from '../analysis/loudness.js';
import { beginBusy } from '../ui/busy.js';
import { LOUDNESS_STANDARDS } from './defs/loudness-standards.js';

const HISTORY_SECONDS = 60;
const STALE_MS = 700;
const INPUT_FLOOR = -60;
const CUSTOM = LOUDNESS_STANDARDS.length - 1;

/** Readout array to named readings (see meter.rs). */
export function readLoudness(v) {
  const tp = Math.max(v[4] || 0, v[5] || 0);
  const pk = Math.max(v[9] || 0, v[10] || 0);
  return {
    momentary: v[0],
    shortTerm: v[1],
    integrated: v[2],
    range: v[3],
    truePeakDb: tp > 0 ? 20 * Math.log10(tp) : -Infinity,
    maxMomentary: v[6],
    maxShortTerm: v[7],
    seconds: v[8],
    inputDb: pk > 0 ? 20 * Math.log10(pk) : -Infinity,
  };
}

/** Display range of the bars in LUFS: target -18/+9 LU or -36/+18 LU. */
export function meterRange(values) {
  const wide = Number(values.scale) === 1;
  return { lo: values.target - (wide ? 36 : 18), hi: values.target + (wide ? 18 : 9) };
}

/** The standard whose target and ceiling match the values, else Custom. */
export function standardFor(values) {
  const i = LOUDNESS_STANDARDS.findIndex((s) => s.target === values.target && s.peakCeiling === values.peakCeiling);
  return i < 0 ? CUSTOM : i;
}

const fmt = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '-∞');

/** A loudness value in the chosen units: LUFS, or LU relative to the target (signed). */
export function loudnessText(v, values) {
  if (!Number.isFinite(v)) return Number(values.units) === 1 ? '--' : '-∞';
  if (Number(values.units) !== 1) return v.toFixed(1);
  const d = v - values.target;
  return `${d > 0 ? '+' : ''}${d.toFixed(1)}`;
}
const unitOf = (values) => (Number(values.units) === 1 ? 'LU' : 'LUFS');

function formatTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Tick ruler under a bar from lo to hi: a tick every `step`, labels every other tick. */
function ruler(lo, hi, step, label) {
  const el = h('div.lm-ruler', { 'aria-hidden': 'true' });
  const first = Math.ceil(lo / step) * step;
  for (let v = first, i = 0; v <= hi + 1e-9; v += step, i++) {
    const x = `${((v - lo) / (hi - lo)) * 100}%`;
    el.append(h(`span.lm-tick${i % 2 === 0 ? '.major' : ''}`, { style: { left: x } }));
    if (i % 2 === 0) el.append(h('span.lm-tick-label', { style: { left: x } }, label(v)));
  }
  return el;
}

/** Editor factory for definitions with display: 'loudness'. */
export function loudnessMeterEditor() {
  const editor = (ctx) => {
    let reading = null;
    let staleTimer = 0;
    // Short-term and momentary history: [{ t (s), m, s }], over the last minute
    // while playing, or across everything a scan measured (`span` seconds).
    const history = [];
    let span = HISTORY_SECONDS;
    // A scan's result: { label } of what it measured; cleared when live readings arrive.
    let scanned = null;

    // ------------------------------------------------------ header numbers
    const big = (label, cls) => {
      const value = h('span.lm-big-value.tabular', '--');
      const unit = h('span.lm-unit');
      const name = h('span.lm-big-label', label);
      return { el: h(`div.lm-big.${cls}`, name, h('span.lm-big-line', value, unit)), value, unit, name };
    };
    const head = {
      shortTerm: big('Short-Term', 'st'),
      integrated: big('Integrated', 'int'),
      range: big('Loudness Range', 'lra'),
      truePeak: big('True Peak', 'tp'),
    };
    const resetBtn = h('button.icon-btn.lm-reset', {
      type: 'button',
      'aria-label': 'Reset the measurement',
      title: 'Start the measurement over (while playing, from the playhead)',
      onclick: () => reset(),
    }, icon('rotate-ccw', 15));

    // ----------------------------------------------------------------- bars
    const bar = (key, label, unitLabel) => {
      const fill = h('div.lm-fill');
      const target = h('div.lm-target', { title: 'Target' });
      const value = h('span.lm-value.tabular', '-∞');
      const unit = h('span.lm-bar-unit', unitLabel);
      const track = h('div.lm-track', { role: 'meter', 'aria-label': `${label} loudness`, 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill, target);
      const scale = h('div.lm-scale', track);
      return { key, el: h('div.lm-row', { dataset: { meter: key } }, h('span.lm-label', label), scale, h('span.lm-readout', value, unit)), fill, target, value, track, scale, unit };
    };
    const input = bar('input', 'Input', 'dBTP');
    input.el.classList.add('lm-input');
    input.target.remove();
    input.scale.append(ruler(INPUT_FLOOR, 0, 3, (v) => String(v)));
    const bars = [bar('shortTerm', 'Short-Term', 'LUFS'), bar('integrated', 'Integrated', 'LUFS'), bar('momentary', 'Momentary', 'LUFS')];
    let rulerKey = '';
    const syncRulers = () => {
      const { lo, hi } = meterRange(ctx.values);
      const key = `${lo}:${hi}:${ctx.values.units}`;
      if (key === rulerKey) return;
      rulerKey = key;
      const step = hi - lo > 30 ? 6 : 3;
      for (const b of bars) {
        b.scale.querySelector('.lm-ruler')?.remove();
        b.scale.append(ruler(lo, hi, step, (v) => (Number(ctx.values.units) === 1 ? String(Math.round(v - ctx.values.target)) : String(Math.round(v)))));
      }
    };

    const stat = (label) => {
      const value = h('span.lm-stat-value.tabular', '-');
      return { el: h('div.lm-stat', h('span.lm-stat-label', `${label}:`), value), value };
    };
    const stats = { maxMomentary: stat('Max Momentary'), maxShortTerm: stat('Max Short-Term'), time: stat('Measured') };

    const graph = plot('lm-history', 'Loudness history', (g, W, H) => {
      const { lo, hi } = meterRange(ctx.values);
      const yOf = (v) => H - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * H;
      const ticks = [];
      for (let v = Math.ceil(lo / 6) * 6; v <= hi; v += 6) ticks.push(v);
      gridLines(g, W, H, [], ticks.map(yOf));
      ticks.forEach((v) => labelText(g, Number(ctx.values.units) === 1 ? `${v - ctx.values.target > 0 ? '+' : ''}${Math.round(v - ctx.values.target)}` : String(v), 3, yOf(v) + 1));
      g.strokeStyle = cssVar('--accent');
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(0, Math.round(yOf(ctx.values.target)) + 0.5);
      g.lineTo(W, Math.round(yOf(ctx.values.target)) + 0.5);
      g.stroke();
      g.setLineDash([]);
      if (history.length < 2) return;
      const end = history[history.length - 1].t;
      const xOf = (t) => W - ((end - t) / span) * W;
      // A scan labels its time axis (start, middle, end).
      if (scanned) {
        for (const f of [0, 0.5, 1]) labelText(g, formatTime(end - span * (1 - f)), Math.min(W - 40, Math.max(2, f * W - 18)), H - 3);
      }
      const line = (key, color, width) => {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        let on = false;
        for (const p of history) {
          if (!Number.isFinite(p[key])) {
            on = false;
            continue;
          }
          const x = xOf(p.t);
          const y = yOf(p[key]);
          if (on) g.lineTo(x, y);
          else g.moveTo(x, y);
          on = true;
        }
        g.stroke();
      };
      line('m', cssVar('--wave-dim'), 1);
      line('s', cssVar('--wave'), 2);
    });

    const hint = h('div.lm-hint.faint');
    // Offline scan: the selection (or the whole file) measured without playing it.
    const offlineBtn = h('button.btn.lm-scan', { type: 'button', disabled: !ctx.doc, title: 'Measure the selection, or the whole file, without playing it' }, icon('activity', 14), h('span.lm-scan-label', 'Scan File'));
    const offlineText = h('span.lm-offline-text.faint', { 'aria-live': 'polite' });
    offlineBtn.addEventListener('click', () => measureOffline());
    const syncScanLabel = () => (offlineBtn.lastChild.textContent = ctx.doc?.hasSelection ? 'Scan Selection' : 'Scan File');
    const offSel = ctx.doc?.on?.('change', (e) => e?.kind === 'selection' && syncScanLabel());
    if (offSel) ctx.onClose?.(offSel);
    syncScanLabel();

    const levels = h(
      'div.lm-view',
      h('div.lm-head', Object.values(head).map((x) => x.el), resetBtn),
      h('div.lm-offline', offlineBtn, offlineText),
      h('div.lm-bars', input.el, bars.map((b) => b.el)),
      h('div.lm-stats', Object.values(stats).map((s) => s.el)),
      graph.el,
      hint,
    );

    // ------------------------------------------------------------- settings
    const settings = h(
      'div.lm-settings',
      controlsFor(ctx, ['standard', 'target', 'peakCeiling', 'units', 'scale'], { labels: { standard: 'Standard', target: 'Target', units: 'Units', scale: 'Bar Scale' } }),
      h('p.faint.lm-settings-note', 'Loudness is measured to ITU-R BS.1770-4 with gating; the standard only sets the target and the true peak ceiling the readings are compared with.'),
    );
    // A chosen standard sets the target and ceiling; editing those by hand selects Custom.
    let seen = { ...ctx.values };
    ctx.subscribe?.((v) => {
      const prev = seen;
      seen = { ...v };
      if (v.standard !== prev.standard && v.standard !== CUSTOM) {
        const s = LOUDNESS_STANDARDS[v.standard];
        if (v.target !== s.target) ctx.set('target', s.target);
        if (ctx.values.peakCeiling !== s.peakCeiling) ctx.set('peakCeiling', s.peakCeiling);
      } else if ((v.target !== prev.target || v.peakCeiling !== prev.peakCeiling) && v.standard !== standardFor(v)) {
        ctx.set('standard', standardFor(v));
      }
    });

    const tabs = tabPanels([
      { label: 'Levels', content: levels },
      { label: 'Settings', content: settings },
    ], { label: 'Loudness Meter' });

    function render() {
      syncRulers();
      const values = ctx.values;
      const { lo, hi } = meterRange(values);
      const frac = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0);
      const unit = unitOf(values);
      for (const b of bars) {
        const v = reading ? reading[b.key] : -Infinity;
        b.fill.style.transform = `scaleX(${frac(v)})`;
        b.fill.classList.toggle('over', Number.isFinite(v) && v > values.target + 1);
        b.target.style.left = `${frac(values.target) * 100}%`;
        b.value.textContent = loudnessText(v, values);
        b.unit.textContent = unit;
        b.track.setAttribute('aria-valuenow', String(Math.round(frac(v) * 100)));
        b.track.setAttribute('aria-valuetext', `${loudnessText(v, values)} ${unit}`);
      }
      const inDb = reading ? reading.inputDb : -Infinity;
      input.fill.style.transform = `scaleX(${Number.isFinite(inDb) ? Math.min(1, Math.max(0, (inDb - INPUT_FLOOR) / -INPUT_FLOOR)) : 0})`;
      input.fill.classList.toggle('over', inDb > values.peakCeiling);
      input.value.textContent = fmt(inDb);
      const r = reading;
      for (const k of ['shortTerm', 'integrated']) {
        head[k].value.textContent = r && Number.isFinite(r[k]) ? loudnessText(r[k], values) : '--';
        head[k].unit.textContent = unit;
      }
      // A scan has no "now": its short-term reading is the loudest 3 s.
      head.shortTerm.name.textContent = scanned ? 'Short-Term Max' : 'Short-Term';
      head.range.value.textContent = r && r.seconds > 0 ? fmt(r.range) : '--';
      head.range.unit.textContent = 'LU';
      head.truePeak.value.textContent = r ? fmt(r.truePeakDb) : '-∞';
      head.truePeak.unit.textContent = 'dBTP';
      head.truePeak.el.classList.toggle('over', Boolean(r && r.truePeakDb > values.peakCeiling));
      stats.maxMomentary.value.textContent = r ? `${loudnessText(r.maxMomentary, values)} ${unit}` : '-';
      stats.maxShortTerm.value.textContent = r ? `${loudnessText(r.maxShortTerm, values)} ${unit}` : '-';
      stats.time.value.textContent = r ? formatTime(r.seconds) : '-';
      hint.textContent = scanned
        ? `Scanned ${scanned.label} without playing it. Integrated loudness is ${Number.isFinite(r.integrated) ? `${fmt(Math.abs(r.integrated - values.target))} LU ${r.integrated > values.target ? 'above' : 'below'} the target` : 'not measurable (too short or too quiet)'}.`
        : reading
        ? `Measuring since playback started. Integrated loudness is ${Number.isFinite(r.integrated) ? `${fmt(Math.abs(r.integrated - values.target))} LU ${r.integrated > values.target ? 'above' : 'below'} the target` : 'not available yet'}.`
        : 'Play audio through the effect (Preview, the Effects Rack or a track) to measure it. Measurement restarts when playback starts.';
      graph.el.dataset.points = String(history.length);
      graph.el.setAttribute('aria-label', scanned && history.length ? `Short-term loudness across ${scanned.label} (${formatTime(span)})` : 'Loudness history');
      graph.redraw();
    }

    function reset() {
      reading = null;
      scanned = null;
      offlineText.textContent = '';
      history.length = 0;
      span = HISTORY_SECONDS;
      const engine = ctx.app?.engine;
      // Seeking in place restarts every meter on the playback path.
      if (engine?.playing) engine.seek(engine.position);
      render();
      announce('Loudness measurement reset');
    }

    ctx.onReadout?.((v) => {
      if (v.length < 9) return;
      reading = readLoudness(v);
      if (scanned) {
        scanned = null;
        offlineText.textContent = '';
        history.length = 0;
        span = HISTORY_SECONDS;
      }
      if (history.length && reading.seconds < history[history.length - 1].t) history.length = 0; // restarted
      history.push({ t: reading.seconds, m: reading.momentary, s: reading.shortTerm });
      while (history.length && history[0].t < reading.seconds - HISTORY_SECONDS) history.shift();
      clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        // Playback stopped: keep the last values, only the hint changes.
        hint.textContent = 'Stopped. Start playback to measure again.';
        if (reading) {
          reading = { ...reading, inputDb: -Infinity };
          input.fill.style.transform = 'scaleX(0)';
          input.value.textContent = '-∞';
        }
      }, STALE_MS);
      render();
    });
    ctx.onClose?.(() => clearTimeout(staleTimer));
    ctx.subscribe?.(() => render());

    async function measureOffline() {
      const doc = ctx.doc;
      if (!doc) return;
      const [start, end] = doc.editRange();
      if (end <= start) return;
      const where = doc.hasSelection ? 'the selection' : 'the file';
      offlineBtn.disabled = true;
      offlineText.textContent = 'Scanning...';
      const endBusy = beginBusy();
      try {
        const state = { sampleRate: doc.sampleRate, channels: doc.state.channels.map((c) => c.slice(start, end)) };
        const m = await measureLoudness(state, (f) => (offlineText.textContent = `Scanning ${Math.round(f * 100)}%`));
        const seconds = (end - start) / doc.sampleRate;
        // Momentary shows where the scan ended (its last 400 ms).
        reading = { momentary: m.momentary, shortTerm: m.maxShortTerm, integrated: m.integrated, range: m.range, truePeakDb: m.truePeakDb, maxMomentary: m.maxMomentary, maxShortTerm: m.maxShortTerm, seconds, inputDb: -Infinity };
        history.length = 0;
        const hs = m.history;
        if (hs?.shortTerm?.length) {
          hs.shortTerm.forEach((sv, i) => history.push({ t: (i + 1) * hs.step, m: hs.momentary[i] ?? -Infinity, s: sv }));
          span = Math.max(hs.step, history[history.length - 1].t);
        }
        scanned = { label: where };
        offlineText.textContent = `${where === 'the selection' ? 'Selection' : 'File'} scanned (${formatTime(seconds)}).`;
        render();
        announce(`${offlineText.textContent} Integrated ${fmt(m.integrated)} LUFS, maximum short-term ${fmt(m.maxShortTerm)} LUFS, loudness range ${fmt(m.range)} LU, true peak ${fmt(m.truePeakDb)} dBTP.`);
      } catch (err) {
        offlineText.textContent = `Could not scan: ${err?.message || err}`;
      } finally {
        endBusy();
        offlineBtn.disabled = false;
      }
    }

    render();
    return tabs;
  };
  editor.hides = true;
  return editor;
}
