// Small original drawings for the instrument editor: waveform glyphs for
// shape selectors and a live ADSR envelope display. Plain SVG, stroked with
// currentColor so they follow the theme.

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

const WAVE_PATHS = {
  sine: 'M1 8C4 -1 8 -1 12 8S20 17 23 8',
  triangle: 'M1 8 6.5 2 17.5 14 23 8',
  saw: 'M1 12 12 4V12L23 4',
  square: 'M1 12V4H12V12H23V4',
  pulse: 'M1 12V4H6V12H17V4H22',
  noise: 'M1 8 3 4 5 11 7 6 9 13 11 3 13 10 15 5 17 12 19 7 21 10 23 6',
  random: 'M1 10H5V4H9V12H13V6H17V9H21V3H23',
};

/** Glyph name for an option label ("Saw" -> 'saw'), or null when there is none. */
export function waveGlyphName(label) {
  const k = String(label).toLowerCase();
  return WAVE_PATHS[k] ? k : null;
}

/** A 24x16 waveform glyph. */
export function waveGlyph(name, width = 24, height = 16) {
  const svg = svgEl('svg', { viewBox: '0 0 24 16', width, height, 'aria-hidden': 'true', focusable: 'false', class: 'wave-glyph' });
  svg.append(svgEl('path', { d: WAVE_PATHS[name] || WAVE_PATHS.sine, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

/**
 * Geometry of an ADSR shape in a `w` x `h` box. Times (ms) map through a
 * square root so short envelopes stay readable; sustain holds a fixed width.
 * Returns the outline points [[x, y], ...] from note on to the end of release.
 */
export function adsrPoints({ attack, decay, sustain, release }, w = 160, h = 48, max = 10000) {
  const pad = 2;
  const hold = w * 0.16;
  const seg = (w - hold - pad * 2) / 3;
  const span = (t) => Math.max(1.5, Math.sqrt(Math.min(1, Math.max(0, t) / max)) * seg);
  const top = pad;
  const bottom = h - pad;
  const sy = bottom - (bottom - top) * Math.min(1, Math.max(0, sustain));
  const x0 = pad;
  const xa = x0 + span(attack);
  const xd = xa + span(decay);
  const xs = xd + hold;
  const xr = xs + span(release);
  return [[x0, bottom], [xa, top], [xd, sy], [xs, sy], [xr, bottom]];
}

/** A live envelope display: call update(values) whenever a stage changes. */
export function createAdsrView({ width = 168, height = 52, label = 'Envelope' } = {}) {
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'adsr-view', role: 'img', 'aria-label': label });
  const grid = svgEl('path', { class: 'adsr-grid', d: `M0 ${height - 2}H${width}`, fill: 'none' });
  const area = svgEl('path', { class: 'adsr-area' });
  const line = svgEl('path', { class: 'adsr-line', fill: 'none' });
  const dots = [0, 1, 2, 3].map(() => svgEl('circle', { class: 'adsr-dot', r: 2.2 }));
  svg.append(grid, area, line, ...dots);
  return {
    el: svg,
    update(v) {
      const pts = adsrPoints(v, width, height);
      const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
      line.setAttribute('d', d);
      area.setAttribute('d', `${d}Z`);
      pts.slice(1).forEach(([x, y], i) => {
        dots[i].setAttribute('cx', x.toFixed(1));
        dots[i].setAttribute('cy', y.toFixed(1));
      });
      svg.setAttribute('aria-label', `${label}: attack ${Math.round(v.attack)} ms, decay ${Math.round(v.decay)} ms, sustain ${Math.round(v.sustain * 100)}%, release ${Math.round(v.release)} ms`);
    },
  };
}
