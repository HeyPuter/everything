// Looks: ready-made appearance bundles. Each one sets the theme, interface
// brightness, accent color and editor colors together; afterwards each of
// those can still be changed on its own (the look then shows as "Custom").
// Preferences > Appearance lists them as preview cards.

import { h } from '../lib/dom.js';
import { ACCENTS, WAVE_PRESETS, COLOR_FIELDS, cleanColor, brighten } from './appearance.js';

const preset = (name) => {
  const p = WAVE_PRESETS.find((x) => x.name === name) || {};
  const out = {};
  for (const k of COLOR_FIELDS) if (cleanColor(p[k])) out[k] = cleanColor(p[k]);
  return Object.keys(out).length ? out : null;
};

/** Built-in looks. `colors: null` keeps the theme's own editor colors. */
export const LOOKS = [
  { id: 'studio', label: 'Studio', note: 'The default dark or light look, following the system', theme: 'system', brightness: 0, accent: 'blue', colors: null },
  { id: 'low-light', label: 'Low Light', note: 'Dimmer panels and warm colors for long evening sessions', theme: 'dark', brightness: -45, accent: 'amber', colors: preset('Ember') },
  { id: 'deep-sea', label: 'Deep Sea', note: 'Cool blue editor on slightly darker panels', theme: 'dark', brightness: -20, accent: 'teal', colors: preset('Deep Sea') },
  { id: 'slate', label: 'Slate', note: 'Lighter gray panels with the standard editor', theme: 'dark', brightness: 40, accent: 'violet', colors: null },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    note: 'Black surfaces, bright waveform and markers',
    theme: 'dark',
    brightness: -100,
    accent: 'blue',
    colors: { wave: '#7dffc4', background: '#000000', selection: '#ffffff', playhead: '#ff4a3d', cue: '#ffffff', subclip: '#7cc0ff', cart: '#a6ffa6', cd: '#ffa6f2' },
  },
  { id: 'paper', label: 'Paper', note: 'Light panels with dark ink on a paper-white editor', theme: 'light', brightness: 0, accent: 'graphite', colors: preset('Ink on Paper') },
];

const sameColors = (a, b) => COLOR_FIELDS.every((k) => (cleanColor(a?.[k]) || null) === (cleanColor(b?.[k]) || null));

/** The look the current preferences match, or null (a custom mix). */
export function lookOf(prefs) {
  const theme = prefs.get('theme') || 'system';
  const brightness = Number(prefs.get('uiBrightness')) || 0;
  const accent = prefs.get('accentColor') || 'blue';
  const colors = prefs.get('waveColors') || null;
  return LOOKS.find((l) => l.theme === theme && l.brightness === brightness && l.accent === accent && sameColors(l.colors, colors)) || null;
}

/** Applies a look: theme, brightness, accent and editor colors in one go. */
export function applyLook(prefs, look) {
  const l = typeof look === 'string' ? LOOKS.find((x) => x.id === look) : look;
  if (!l) return;
  prefs.set('theme', l.theme);
  prefs.set('uiBrightness', l.brightness);
  prefs.set('accentColor', l.accent);
  prefs.set('waveColors', l.colors ? { ...l.colors } : null);
}

// Surfaces the preview cards draw, per theme, before brightness.
const SURFACES = {
  dark: { app: '#161616', panel: '#232323', editor: '#000000', wave: '#3fe0a5', text: '#d6d6d6' },
  light: { app: '#d4d4d4', panel: '#ececec', editor: '#fbfbfb', wave: '#0f9e6c', text: '#2a2a2a' },
};

/** The colors a look's preview card shows (in `systemTheme` when the look follows the system). */
export function lookSwatch(look, systemTheme = 'dark') {
  const theme = look.theme === 'system' ? systemTheme : look.theme;
  const s = SURFACES[theme] || SURFACES.dark;
  const accent = ACCENTS.find((a) => a.id === look.accent) || ACCENTS[0];
  return {
    app: brighten(s.app, look.brightness, theme),
    panel: brighten(s.panel, look.brightness, theme),
    editor: look.colors?.background || s.editor,
    wave: look.colors?.wave || s.wave,
    playhead: look.colors?.playhead || '#e8483c',
    accent: theme === 'light' ? accent.light : accent.dark,
    text: s.text,
  };
}

const WAVE_PATH = 'M2 12h3l2-6 2 12 2-9 2 6 2-10 2 13 2-8 2 4h3';

/** Preferences > Appearance: the looks as radio cards with a small preview of each. */
export function lookPicker({ app, row }) {
  const group = h('div.look-cards', { role: 'radiogroup', 'aria-label': 'Look' });
  const system = () => (typeof matchMedia === 'function' && !matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
  const render = () => {
    const current = lookOf(app.prefs);
    const focused = group.contains(document.activeElement);
    group.replaceChildren(
      ...LOOKS.map((l, i) => {
        const on = current === l;
        const c = lookSwatch(l, system());
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 30 24');
        svg.setAttribute('preserveAspectRatio', 'none');
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', WAVE_PATH);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', c.wave);
        path.setAttribute('stroke-width', '1.6');
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        const head = document.createElementNS(NS, 'path');
        head.setAttribute('d', 'M9 0v24');
        head.setAttribute('stroke', c.playhead);
        head.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.append(path, head);
        const preview = h(
          'span.look-preview',
          { 'aria-hidden': 'true', style: { background: c.app } },
          h('span.look-preview-panel', { style: { background: c.panel } }, h('span.look-preview-tab', { style: { background: c.accent } })),
          h('span.look-preview-editor', { style: { background: c.editor } }, svg),
        );
        const card = h('button.look-card', { type: 'button', role: 'radio', 'aria-checked': String(on), 'aria-label': l.label, title: l.note, tabindex: on || (!current && i === 0) ? '0' : '-1', dataset: { look: l.id } }, preview, h('span.look-name', l.label));
        card.addEventListener('click', () => {
          applyLook(app.prefs, l);
          render();
          group.querySelector(`[data-look="${l.id}"]`)?.focus();
        });
        card.addEventListener('keydown', (e) => {
          const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          const n = LOOKS[(i + d + LOOKS.length) % LOOKS.length];
          applyLook(app.prefs, n);
          render();
          group.querySelector(`[data-look="${n.id}"]`)?.focus();
        });
        return card;
      }),
    );
    if (focused && !group.contains(document.activeElement)) group.querySelector('[tabindex="0"]')?.focus();
    status.textContent = current ? current.note : 'Custom: your own mix of the settings below.';
  };
  const status = h('p.look-note');
  render();
  row.refresh = render;
  return h('div.look-picker', group, status);
}
