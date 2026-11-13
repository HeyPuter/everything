// Levels panel: peak meters for the master output (or the input while
// recording or input metering). Horizontal when the panel is wide, vertical
// when tall, unless the panel menu fixes the orientation. Peak-hold ticks (dynamic: they fall back after a moment; static:
// they stay until reset), optional valley ticks, clip indicators (click to
// reset) and a dB scale. The bar is drawn as solid color zones, a smooth
// gradient, or LED segments; the zone boundaries come from preferences.
// View > Metering and the panel menu run the same `meter.*` commands.

import { h } from '../lib/dom.js';
import { cssVar, CANVAS_FONT } from '../ui/theme.js';

export const METER_RANGES = [120, 96, 72, 60, 48, 24];

/** Whether to draw horizontally for a panel W x H and the orientation preference ('auto' | 'horizontal' | 'vertical'). */
export function meterHorizontal(W, H, orientation = 'auto') {
  if (orientation === 'horizontal') return true;
  if (orientation === 'vertical') return false;
  return W >= H;
}

/** Zone boundaries in dB: below caution is green, up to warning yellow, above red. */
export function meterZones(prefs) {
  const warning = Math.min(0, Number(prefs.get('meterWarning') ?? -3));
  const caution = Math.min(warning, Number(prefs.get('meterCaution') ?? -12));
  return { caution, warning };
}

/** Scale step and label spacing for a range and meter length in px, so labels never collide. */
export function scaleSteps(range, len) {
  const step = range <= 60 ? 3 : range <= 72 ? 6 : 12;
  let labelEvery = step;
  while ((labelEvery / range) * len < 22 && labelEvery < range) labelEvery += step;
  return { step, labelEvery };
}

export function levelsPanel(app) {
  // The canvas is the meter: a meter's children are hidden from assistive
  // technology, and the clip indicators beside it are buttons.
  const canvas = h('canvas', {
    role: 'meter',
    'aria-label': 'Output level',
    'aria-valuemin': '-60',
    'aria-valuemax': '0',
  });
  const clipL = h('button.clip-led', { type: 'button', 'aria-label': 'Left channel clip indicator. Click to reset.' });
  const clipR = h('button.clip-led', { type: 'button', 'aria-label': 'Right channel clip indicator. Click to reset.' });
  const readout = h('div.sr-only', { 'aria-live': 'off' });
  const el = h('div.levels-panel', canvas, h('div.clip-leds', clipL, clipR), readout);
  const state = { level: [0, 0], hold: [0, 0], holdAt: [0, 0], valley: [1, 1], valleyAt: [0, 0], clip: [false, false], last: 0 };
  let raf = 0;
  let visible = false;
  let input = false;
  const prefs = app.prefs;

  const reset = () => {
    state.clip = [false, false];
    state.hold = [0, 0];
    state.valley = [1, 1];
    clipL.classList.remove('on');
    clipR.classList.remove('on');
    schedule();
  };
  clipL.addEventListener('click', reset);
  clipR.addEventListener('click', reset);

  const feed = (peaks) => {
    const now = performance.now();
    const dynamic = prefs.get('meterPeaks') !== 'static';
    for (let c = 0; c < 2; c++) {
      const p = peaks[c] ?? peaks[0] ?? 0;
      state.level[c] = Math.max(p, state.level[c]);
      if (p >= state.hold[c] || (dynamic && now - state.holdAt[c] > 1500)) {
        state.hold[c] = p;
        state.holdAt[c] = now;
      }
      // Valleys: the quietest recent block, ignoring digital silence between takes.
      if (p > 1e-5 && (p <= state.valley[c] || now - state.valleyAt[c] > 1500)) {
        state.valley[c] = p;
        state.valleyAt[c] = now;
      }
      if (p >= 0.999) {
        state.clip[c] = true;
        (c ? clipR : clipL).classList.add('on');
      }
    }
    schedule();
  };
  app.engine.on('meters', (m) => !input && feed(m.master));
  app.engine.on('input-meter', (p) => input && feed(p));
  app.meterInput = (on) => {
    input = on;
  };
  app.resetMeters = reset;

  const schedule = () => {
    if (!raf && visible) raf = requestAnimationFrame(draw);
  };

  const draw = (now) => {
    raf = 0;
    const W = el.clientWidth;
    const H = el.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const range = prefs.get('meterRange') || 60;
    const horizontal = meterHorizontal(W, H, prefs.get('meterOrientation'));
    const scale = 18;
    const len = horizontal ? W - 30 : H - 24;
    const pos = (db) => Math.max(0, Math.min(1, (db + range) / range)) * len;
    const toDb = (v) => (v <= 0 ? -Infinity : 20 * Math.log10(v));
    const bars = 2;
    const thick = horizontal ? Math.max(4, Math.min(24, (H - scale - 10) / bars - 2)) : Math.max(4, Math.min(24, (W - 34) / bars - 2));
    // The scale sits right under the bars (horizontal) so a tall panel has no dead gap.
    const scaleY = Math.min(H - 4, 6 + bars * (thick + 2) + 13);
    ctx.font = CANVAS_FONT;
    ctx.fillStyle = cssVar('--text-dim');
    const { step, labelEvery } = scaleSteps(range, len);
    for (let db = -Math.floor(range / step) * step; db <= 0; db += step) {
      const p = pos(db);
      if (horizontal) {
        const x = 4 + p;
        ctx.fillRect(Math.round(x), scaleY - 13, 1, 3);
        if (db % labelEvery === 0 && x > 24) ctx.fillText(String(db), x - (db === 0 ? 3 : 7), scaleY);
        else if (db % labelEvery === 0) ctx.fillText('dB', 4, scaleY);
      } else {
        const y = H - 18 - p;
        ctx.fillRect(4 + bars * (thick + 2), Math.round(y), 3, 1);
        if (db % labelEvery === 0) ctx.fillText(String(db), 10 + bars * (thick + 2), y + 3);
      }
    }
    const green = cssVar('--meter-green');
    const yellow = cssVar('--meter-yellow');
    const red = cssVar('--meter-red');
    const { caution, warning } = meterZones(prefs);
    const yellowAt = pos(caution);
    const redAt = pos(warning);
    const gradient = Boolean(prefs.get('meterGradient'));
    const led = Boolean(prefs.get('meterLed'));
    const zoneColor = (p) => (p >= redAt ? red : p >= yellowAt ? yellow : green);
    // One gradient across the whole meter, so a bar's color depends on where it ends.
    let grad = null;
    if (gradient) {
      grad = horizontal ? ctx.createLinearGradient(4, 0, 4 + len, 0) : ctx.createLinearGradient(0, H - 18, 0, H - 18 - len);
      grad.addColorStop(0, green);
      grad.addColorStop(Math.max(0, Math.min(1, yellowAt / len)), yellow);
      grad.addColorStop(Math.max(0, Math.min(1, redAt / len)), red);
      grad.addColorStop(1, red);
    }
    const rect = (c, from, to) => {
      if (horizontal) ctx.fillRect(4 + from, 6 + c * (thick + 2), to - from, thick);
      else ctx.fillRect(4 + c * (thick + 2), H - 18 - to, thick, to - from);
    };
    const fillBar = (c, p) => {
      if (p <= 0) return;
      if (led) {
        // LED segments: fixed cells with a 1 px gap, each lit in its zone color.
        const cell = Math.max(3, Math.min(6, len / 60));
        for (let at = 0; at < p; at += cell) {
          ctx.fillStyle = grad || zoneColor(at);
          rect(c, at, Math.min(p, at + cell - 1));
        }
        return;
      }
      if (grad) {
        ctx.fillStyle = grad;
        rect(c, 0, p);
        return;
      }
      const seg = (from, to, color) => {
        if (to <= from) return;
        ctx.fillStyle = color;
        rect(c, from, to);
      };
      seg(0, Math.min(p, yellowAt), green);
      seg(yellowAt, Math.min(p, redAt), yellow);
      seg(redAt, p, red);
    };
    const tick = (c, p, color, width = 2) => {
      ctx.fillStyle = color;
      if (horizontal) ctx.fillRect(4 + p - width, 6 + c * (thick + 2), width, thick);
      else ctx.fillRect(4 + c * (thick + 2), H - 18 - p, thick, width);
    };
    const showValleys = Boolean(prefs.get('meterValleys'));
    for (let c = 0; c < bars; c++) {
      const p = pos(toDb(state.level[c]));
      const hp = pos(toDb(state.hold[c]));
      ctx.fillStyle = cssVar('--meter-bg');
      rect(c, 0, len);
      fillBar(c, p);
      if (hp > 1) tick(c, hp, zoneColor(hp));
      if (showValleys && state.valley[c] < 1 && app.engine.playing) {
        const vp = pos(toDb(state.valley[c]));
        if (vp > 1) tick(c, vp, cssVar('--text-dim'));
      }
    }
    // Decay towards silence so meters fall smoothly after playback stops.
    const dt = state.last ? Math.min(100, now - state.last) : 16;
    state.last = now;
    const decay = Math.pow(10, (-20 * dt) / 1000 / 20); // 20 dB per second
    const dynamic = prefs.get('meterPeaks') !== 'static';
    let active = false;
    for (let c = 0; c < 2; c++) {
      state.level[c] *= decay;
      if (state.level[c] < 1e-4) state.level[c] = 0;
      else active = true;
      if (dynamic && performance.now() - state.holdAt[c] > 2500) state.hold[c] *= decay;
      if (dynamic && state.hold[c] > 1e-4) active = true;
    }
    if (!app.engine.playing) state.valley = [1, 1];
    const peakDb = toDb(Math.max(state.hold[0], state.hold[1]));
    canvas.setAttribute('aria-valuemin', String(-range));
    const shown = Number.isFinite(peakDb) ? Math.max(-range, Math.round(peakDb)) : -range;
    canvas.setAttribute('aria-valuenow', String(shown));
    if (active || app.engine.playing) schedule();
    else state.last = 0;
  };

  const ro = new ResizeObserver(() => schedule());
  ro.observe(el);
  prefs.on('change', (key) => /^meter/.test(key) && schedule());
  // Theme, accent and brightness changes recolor the meter while playback is stopped too.
  window.addEventListener('themechange', () => schedule());
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    app.openMenu(app.levelsMenu(), { x: e.clientX, y: e.clientY, label: 'Levels' });
  });
  return {
    el,
    show() {
      visible = true;
      schedule();
    },
    hide() {
      visible = false;
    },
  };
}

/** Commands behind View > Metering and the Levels panel menu. */
export function installMeterCommands(app) {
  const prefs = app.prefs;
  app.commands.register([
    { id: 'meter.reset', label: 'Reset Indicators', run: () => app.resetMeters?.() },
    { id: 'meter.valleys', label: 'Show Valleys', checked: () => Boolean(prefs.get('meterValleys')), run: () => prefs.toggle('meterValleys') },
    { id: 'meter.gradient', label: 'Show Color Gradient', checked: () => Boolean(prefs.get('meterGradient')), run: () => prefs.toggle('meterGradient') },
    { id: 'meter.led', label: 'Show LED Meters', checked: () => Boolean(prefs.get('meterLed')), run: () => prefs.toggle('meterLed') },
    ...[
      ['Auto', 'auto', 'Automatic Orientation'],
      ['Horizontal', 'horizontal', 'Horizontal'],
      ['Vertical', 'vertical', 'Vertical'],
    ].map(([key, value, label]) => ({ id: `meter.orient${key}`, label, checked: () => (prefs.get('meterOrientation') || 'auto') === value, run: () => prefs.set('meterOrientation', value) })),
    ...METER_RANGES.map((r) => ({ id: `meter.range${r}`, label: `${r} dB Range`, checked: () => prefs.get('meterRange') === r, run: () => prefs.set('meterRange', r) })),
    { id: 'meter.dynamicPeaks', label: 'Dynamic Peaks', checked: () => prefs.get('meterPeaks') !== 'static', run: () => prefs.set('meterPeaks', 'dynamic') },
    {
      id: 'meter.staticPeaks',
      label: 'Static Peaks',
      checked: () => prefs.get('meterPeaks') === 'static',
      run: () => {
        prefs.set('meterPeaks', 'static');
        app.resetMeters?.();
      },
    },
  ]);
  app.meterMenuIds = ['transport.meterInput', '-', 'meter.reset', 'meter.valleys', 'meter.gradient', 'meter.led', '-', ...METER_RANGES.map((r) => `meter.range${r}`), '-', 'meter.dynamicPeaks', 'meter.staticPeaks', '-', 'meter.orientAuto', 'meter.orientHorizontal', 'meter.orientVertical'];
  app.levelsMenu = () =>
    app.meterMenuIds
      .filter((id) => id === '-' || app.commands.commands.has(id))
      .map((id) => (id === '-' ? { type: 'sep' } : { type: 'cmd', label: app.commands.label(id), enabled: app.commands.isEnabled(id), checked: app.commands.isChecked(id), run: () => app.commands.run(id) }));
}
