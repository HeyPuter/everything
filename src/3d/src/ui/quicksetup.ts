// Splash screen extras: the hero illustration and the Quick Setup page shown on the first run
// (theme, interface size and what the spacebar does), all of it saved with the preferences.
import { h, type Child } from './h';
import { prefs } from '../app/prefs';
import { setPref } from '../prefs/store';
import { BUILTIN_THEMES } from '../prefs/themes';
import { setThemePreset, themeState } from '../prefs/theme_ui';
import { keyconfig, keyconfigChanged } from '../prefs/keyconfig';
import { enumRow } from './widgets';
import { app } from '../app/app';

const SETUP_KEY = '3d.quick_setup_done';

/** Whether the Quick Setup page still has to be shown (first run in this browser). */
export function quickSetupPending(): boolean {
  try {
    return localStorage.getItem(SETUP_KEY) !== '1';
  } catch {
    return false;
  }
}

export function finishQuickSetup() {
  try {
    localStorage.setItem(SETUP_KEY, '1');
  } catch {
    /* private mode: the page shows again next time */
  }
}

/** Swatch colours of a theme card: window, header, accent, text. */
const THEME_SWATCH: Record<string, [string, string, string, string]> = {
  DEFAULT: ['#303030', '#232323', '#4772b3', '#e6e6e6'],
  GRAPHITE: ['#2b2c2e', '#202123', '#7d8590', '#e0e0e0'],
  MIDNIGHT: ['#1c2130', '#141824', '#5b7bd8', '#dfe4f2'],
  LIGHT: ['#e4e4e4', '#cfcfcf', '#4772b3', '#1a1a1a'],
  HIGH_CONTRAST: ['#000000', '#141414', '#ffcc00', '#ffffff'],
};

function themeCard(id: string, label: string): Child {
  const [bg, hdr, acc, fg] = THEME_SWATCH[id] ?? THEME_SWATCH.DEFAULT;
  const on = themeState.preset === id;
  return h(
    'button',
    { key: id, class: { 'qs-theme': true, on }, 'aria-pressed': on ? 'true' : 'false', onclick: () => (setThemePreset(id), app.changed('ui')) },
    h(
      'svg',
      { viewBox: '0 0 64 40', width: 64, height: 40, 'aria-hidden': 'true' },
      h('rect', { x: 0, y: 0, width: 64, height: 40, rx: 4, fill: bg }),
      h('rect', { x: 0, y: 0, width: 64, height: 8, rx: 4, fill: hdr }),
      h('rect', { x: 0, y: 4, width: 64, height: 4, fill: hdr }),
      h('rect', { x: 6, y: 14, width: 24, height: 4, rx: 2, fill: fg, opacity: 0.8 }),
      h('rect', { x: 6, y: 22, width: 34, height: 4, rx: 2, fill: fg, opacity: 0.45 }),
      h('rect', { x: 44, y: 14, width: 14, height: 12, rx: 2, fill: acc }),
      h('rect', { x: 6, y: 30, width: 52, height: 4, rx: 2, fill: hdr }),
    ),
    h('span', null, label),
  );
}

const SCALES: [number, string][] = [
  [0.9, 'Compact'],
  [1, 'Normal'],
  [1.15, 'Large'],
  [1.3, 'Larger'],
];

/** Quick Setup page of the splash screen. */
export function quickSetupBody(done: () => void): Child {
  const o = keyconfig.data.options;
  const scale = SCALES.reduce((best, s) => (Math.abs(s[0] - prefs.resolution_scale) < Math.abs(best[0] - prefs.resolution_scale) ? s : best), SCALES[1]);
  return h(
    'div',
    { class: 'qs' },
    h('div', { class: 'splash-head' }, 'Quick Setup'),
    h('p', { class: 'qs-lead' }, 'Pick a look and a few habits. Everything here can be changed later in Preferences.'),
    h('div', { class: 'qs-label' }, 'Theme'),
    h('div', { class: 'qs-themes' }, BUILTIN_THEMES.map((t) => themeCard(t.id, t.label))),
    h('div', { class: 'qs-row' }, h('div', { class: 'qs-label' }, 'Interface Size'), enumRow('qs-scale', SCALES.map(([v, l]) => ({ value: String(v), label: l })), String(scale[0]), (v) => (setPref('resolution_scale', Number(v)), app.changed('ui')))),
    h(
      'div',
      { class: 'qs-row' },
      h('div', { class: 'qs-label' }, 'Spacebar'),
      enumRow(
        'qs-space',
        [
          { value: 'PLAY', label: 'Play', description: 'Space plays the animation' },
          { value: 'TOOL', label: 'Tools', description: 'Space opens the tool menu' },
          { value: 'SEARCH', label: 'Search', description: 'Space searches commands' },
        ],
        o.spacebar_action,
        (v) => {
          keyconfig.data.options = { ...keyconfig.data.options, spacebar_action: v as typeof o.spacebar_action };
          keyconfig.apply();
          keyconfigChanged();
          app.changed('ui');
        },
      ),
    ),
    h('div', { class: 'qs-foot' }, h('span', { class: 'grow' }), h('button', { class: 'btn primary qs-next', onclick: () => (finishQuickSetup(), done()) }, 'Continue')),
  );
}

/** Original illustration of the splash header: a lit cube, a ring and a floor grid. */
export function splashArt(): Child {
  const grid: Child[] = [];
  // floor lines converging on a horizon point
  for (let i = -10; i <= 10; i++) grid.push(h('line', { key: `v${i}`, x1: 400 + i * 4, y1: 96, x2: 400 + i * 90, y2: 200 }));
  for (let j = 0; j < 7; j++) {
    const y = 96 + Math.pow(j / 6, 1.8) * 104;
    grid.push(h('line', { key: `h${j}`, x1: 0, y1: y, x2: 560, y2: y }));
  }
  return h(
    'svg',
    { class: 'splash-art', viewBox: '0 0 560 190', preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true' },
    h(
      'defs',
      null,
      h('linearGradient', { id: 'sa-top', x1: 0, y1: 0, x2: 1, y2: 1 }, h('stop', { offset: 0, 'stop-color': '#f0f2f7' }), h('stop', { offset: 1, 'stop-color': '#b9c2d6' })),
      h('linearGradient', { id: 'sa-left', x1: 0, y1: 0, x2: 0, y2: 1 }, h('stop', { offset: 0, 'stop-color': '#7d8aa8' }), h('stop', { offset: 1, 'stop-color': '#4a5470' })),
      h('linearGradient', { id: 'sa-right', x1: 0, y1: 0, x2: 0, y2: 1 }, h('stop', { offset: 0, 'stop-color': '#3a4360' }), h('stop', { offset: 1, 'stop-color': '#242a3d' })),
      h('radialGradient', { id: 'sa-ball', cx: 0.35, cy: 0.3, r: 0.75 }, h('stop', { offset: 0, 'stop-color': '#ffd9a3' }), h('stop', { offset: 0.45, 'stop-color': '#e2802c' }), h('stop', { offset: 1, 'stop-color': '#5a2a0c' })),
      h('linearGradient', { id: 'sa-fade', x1: 0, y1: 0, x2: 0, y2: 1 }, h('stop', { offset: 0, 'stop-color': '#000', 'stop-opacity': 0 }), h('stop', { offset: 1, 'stop-color': '#000', 'stop-opacity': 0.35 })),
    ),
    h('g', { class: 'splash-grid' }, grid),
    // contact shadows
    h('ellipse', { cx: 420, cy: 160, rx: 70, ry: 12, fill: '#000', opacity: 0.35 }),
    h('ellipse', { cx: 318, cy: 158, rx: 22, ry: 5, fill: '#000', opacity: 0.3 }),
    // back half of the orbit ring, behind the cube
    h('ellipse', { cx: 420, cy: 104, rx: 96, ry: 30, fill: 'none', stroke: 'rgba(160, 190, 255, 0.3)', 'stroke-width': 1.2, transform: 'rotate(-12 420 104)' }),
    // cube: top, left and right faces with a selection outline
    h('path', { d: 'M420 52 L476 80 L420 108 L364 80 Z', fill: 'url(#sa-top)' }),
    h('path', { d: 'M364 80 L420 108 L420 160 L364 132 Z', fill: 'url(#sa-left)' }),
    h('path', { d: 'M476 80 L420 108 L420 160 L476 132 Z', fill: 'url(#sa-right)' }),
    h('path', { d: 'M420 52 L476 80 L476 132 L420 160 L364 132 L364 80 Z', fill: 'none', stroke: '#f5a33a', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }),
    // front half of the orbit ring
    h('path', { d: 'M324 104 A96 30 0 0 0 516 104', fill: 'none', stroke: 'rgba(160, 190, 255, 0.55)', 'stroke-width': 1.3, transform: 'rotate(-12 420 104)' }),
    h('circle', { cx: 330, cy: 128, r: 3, fill: '#a0beff' }),
    // a glossy sphere in front
    h('circle', { cx: 318, cy: 138, r: 20, fill: 'url(#sa-ball)' }),
    h('ellipse', { cx: 311, cy: 130, rx: 6, ry: 4, fill: '#fff', opacity: 0.55 }),
    h('rect', { x: 0, y: 0, width: 560, height: 190, fill: 'url(#sa-fade)' }),
  );
}
