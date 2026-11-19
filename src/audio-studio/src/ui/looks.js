// Looks: ready-made appearance bundles. Each one sets the theme, interface
// brightness, accent color and editor colors together; afterwards each of
// those can still be changed on its own (the look then shows as "Custom").
// Preferences > Appearance lists them as preview cards.

import { h, announce } from '../lib/dom.js';
import { promptDialog } from './dialog.js';
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

/** Looks the user saved (preference `userLooks`), cleaned of damaged entries. */
export function userLooks(prefs) {
  const list = prefs.get('userLooks');
  if (!Array.isArray(list)) return [];
  return list
    .filter((l) => l && typeof l === 'object' && typeof l.label === 'string' && ['system', 'dark', 'light'].includes(l.theme) && ACCENTS.some((a) => a.id === l.accent))
    .map((l) => ({ ...l, id: String(l.id || `user-${l.label}`), brightness: Math.max(-100, Math.min(100, Number(l.brightness) || 0)), colors: l.colors && typeof l.colors === 'object' ? l.colors : null, user: true }));
}

/** Built-in looks, then the user's. */
export function allLooks(prefs) {
  return [...LOOKS, ...userLooks(prefs)];
}

/** The current settings as a look's fields. */
function currentFields(prefs) {
  const colors = prefs.get('waveColors');
  const out = {};
  for (const k of COLOR_FIELDS) if (cleanColor(colors?.[k])) out[k] = cleanColor(colors[k]);
  return {
    theme: prefs.get('theme') || 'system',
    brightness: Number(prefs.get('uiBrightness')) || 0,
    accent: prefs.get('accentColor') || 'blue',
    colors: Object.keys(out).length ? out : null,
  };
}

/** The look the current preferences match, or null (a custom mix). */
export function lookOf(prefs) {
  const c = currentFields(prefs);
  return allLooks(prefs).find((l) => l.theme === c.theme && l.brightness === c.brightness && l.accent === c.accent && sameColors(l.colors, c.colors)) || null;
}

/** Saves the current settings as a look named `label` (replacing one of the user's with that name). */
export function saveLook(prefs, label) {
  const name = String(label || '').trim();
  if (!name) return null;
  const look = { id: `user-${Date.now().toString(36)}`, label: name, note: 'One of your looks', ...currentFields(prefs) };
  const kept = userLooks(prefs).filter((l) => l.label.toLowerCase() !== name.toLowerCase()).map(({ user, ...l }) => l);
  prefs.set('userLooks', [...kept, look]);
  return look;
}

/** Deletes one of the user's looks. */
export function deleteLook(prefs, id) {
  prefs.set('userLooks', userLooks(prefs).filter((l) => l.id !== id).map(({ user, ...l }) => l));
}

/** Applies a look: theme, brightness, accent and editor colors in one go. */
export function applyLook(prefs, look) {
  const l = typeof look === 'string' ? allLooks(prefs).find((x) => x.id === look) : look;
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
    const looks = allLooks(app.prefs);
    const focused = group.contains(document.activeElement);
    group.replaceChildren(
      ...looks.map((l, i) => {
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
          const n = looks[(i + d + looks.length) % looks.length];
          applyLook(app.prefs, n);
          render();
          group.querySelector(`[data-look="${n.id}"]`)?.focus();
        });
        return card;
      }),
    );
    if (focused && !group.contains(document.activeElement)) group.querySelector('[tabindex="0"]')?.focus();
    status.textContent = current ? current.note || '' : 'Custom: your own mix of the settings below.';
    save.disabled = Boolean(current);
    del.hidden = !current?.user;
  };
  const status = h('p.look-note');
  const save = h('button.btn', { type: 'button' }, 'Save as Look...');
  const del = h('button.btn', { type: 'button' }, 'Delete Look');
  save.addEventListener('click', async () => {
    const taken = LOOKS.map((l) => l.label.toLowerCase());
    const name = await promptDialog({ title: 'Save Look', label: 'Look name:', value: 'My Look', confirm: 'Save', validate: (v) => (!v.trim() ? 'Enter a name.' : taken.includes(v.trim().toLowerCase()) ? 'A built-in look has that name.' : '') });
    if (!name) return;
    const look = saveLook(app.prefs, name);
    render();
    if (look) announce(`Saved look ${look.label}`);
  });
  del.addEventListener('click', () => {
    const current = lookOf(app.prefs);
    if (!current?.user) return;
    deleteLook(app.prefs, current.id);
    render();
    announce(`Deleted look ${current.label}`);
  });
  render();
  row.refresh = render;
  return h('div.look-picker', group, h('div.look-actions', status, h('div.spacer'), save, del));
}
