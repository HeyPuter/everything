/**
 * Preferences: default lengths for new clips, timeline display, playback,
 * proxy media stored on this device, and theme. Stored per device (prefs.js) and read where clips are made.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { US } from '../lib/time.js';
import { openDialog, confirmDialog } from './dialog.js';
import { formatBytes } from '../model/bins.js';
import { prefs, setPref, getTheme, setTheme } from './prefs.js';

/** Defaults for the preferences below (seconds where it is a length). */
export const PREF_DEFAULTS = {
  imageDuration: 5,
  textDuration: 3,
  transitionDuration: 0.5,
  animDuration: 0.5,
  showThumbs: true,
  showWaves: true,
  followPlayhead: 'page',
  snapPx: 8,
  loopPlayback: false,
};

export function pref(key) {
  const v = prefs()[key];
  return v === undefined || v === null ? PREF_DEFAULTS[key] : v;
}

/** Default lengths in microseconds for new clips. */
export const defaultLength = {
  image: () => Math.round(pref('imageDuration') * US),
  text: () => Math.round(pref('textDuration') * US),
  transition: () => Math.round(pref('transitionDuration') * US),
  animation: () => Math.round(pref('animDuration') * US),
};

const listeners = new Set();
export function onPrefsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function numberRow(label, key, { min, max, step, unit }) {
  const id = `pref-${key}`;
  const input = h('input.input.pref-num', { id, type: 'number', min, max, step, value: String(pref(key)) });
  input.addEventListener('change', () => {
    const v = Math.min(max, Math.max(min, Number(input.value) || PREF_DEFAULTS[key]));
    input.value = String(v);
    setPref(key, v);
    listeners.forEach((fn) => fn(key));
  });
  return h('div.pref-row', h('label.pref-label', { for: id }, label), h('span.pref-ctl', input, unit ? h('span.pref-unit', unit) : null));
}

function switchRow(label, key, hint) {
  const id = `pref-${key}`;
  const sw = h('button.switch', { type: 'button', role: 'switch', id, 'aria-checked': String(Boolean(pref(key))), 'aria-labelledby': `${id}-l` });
  sw.addEventListener('click', () => {
    const v = !pref(key);
    sw.setAttribute('aria-checked', String(v));
    setPref(key, v);
    listeners.forEach((fn) => fn(key));
  });
  return h('div.pref-row', h('span.pref-label', { id: `${id}-l` }, label, hint ? h('span.pref-hint', hint) : null), h('span.pref-ctl', sw));
}

function choiceRow(label, key, options, { get = () => pref(key), set = (v) => setPref(key, v) } = {}) {
  const id = `pref-${key}`;
  const sel = h('select.select', { id }, options.map(([v, l]) => h('option', { value: v }, l)));
  sel.value = get();
  sel.addEventListener('change', () => {
    set(sel.value);
    listeners.forEach((fn) => fn(key));
  });
  return h('div.pref-row', h('label.pref-label', { for: id }, label), h('span.pref-ctl', sel));
}

/** Space used by proxy media on this device, with a button to delete them all. */
function proxyStorageRow(proxies) {
  const usage = h('span.pref-hint.proxy-usage', { 'aria-live': 'polite' }, 'Checking...');
  const del = h('button.btn.small', { type: 'button', disabled: true }, icon('trash', 14), 'Delete all proxies');
  const refresh = () =>
    proxies.usage().then(
      ({ files, bytes }) => {
        usage.textContent = files ? `${files} ${files === 1 ? 'proxy' : 'proxies'}, ${formatBytes(bytes)}` : 'No proxies on this device.';
        del.disabled = !files;
      },
      () => (usage.textContent = 'Could not read the proxy storage.'),
    );
  del.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete all proxies?', message: 'The preview plays the original files until proxies are made again. Your media and projects are not changed.', confirm: 'Delete', danger: true });
    if (!ok) return;
    del.disabled = true;
    const n = await proxies.removeAll();
    announce(n ? 'All proxies deleted' : 'No proxies to delete');
    refresh();
  });
  refresh();
  return h('div.pref-row', h('span.pref-label', 'Proxy media', h('span.pref-hint', 'Small copies of heavy videos for a smooth preview, kept on this device.'), usage), h('span.pref-ctl', del));
}

export function openPreferences(ctx) {
  const section = (title, ...rows) => h('section.pref-section', h('h3', title), rows);
  const body = h('div.prefs',
    section('New clips',
      numberRow('Photo length', 'imageDuration', { min: 0.5, max: 60, step: 0.5, unit: 's' }),
      numberRow('Text and graphic length', 'textDuration', { min: 0.5, max: 60, step: 0.5, unit: 's' }),
      numberRow('Transition length', 'transitionDuration', { min: 0.1, max: 3, step: 0.1, unit: 's' }),
      numberRow('Animation length', 'animDuration', { min: 0.1, max: 3, step: 0.1, unit: 's' }),
    ),
    section('Timeline',
      switchRow('Show filmstrip thumbnails', 'showThumbs'),
      switchRow('Show audio waveforms', 'showWaves'),
      choiceRow('Follow the playhead while playing', 'followPlayhead', [['page', 'Page by page'], ['smooth', 'Keep it centered'], ['off', 'Don’t scroll']]),
      numberRow('Snap distance', 'snapPx', { min: 2, max: 24, step: 1, unit: 'px' }),
    ),
    section('Playback',
      switchRow('Loop playback', 'loopPlayback', 'Start again from the beginning, or from the in point, at the end.'),
    ),
    ctx.proxies ? section('Storage', proxyStorageRow(ctx.proxies)) : null,
    section('Appearance',
      choiceRow('Theme', 'theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match the system']], { get: getTheme, set: setTheme }),
    ),
  );
  const shortcuts = h('button.btn', { type: 'button' }, icon('keyboard', 16), 'Keyboard shortcuts...');
  const done = h('button.btn.primary', { type: 'button' }, 'Done');
  const d = openDialog({ title: 'Preferences', body, actions: [shortcuts, h('span.spacer'), done], className: 'prefs-dialog' });
  shortcuts.addEventListener('click', () => {
    d.close();
    ctx.openShortcuts?.();
  });
  done.addEventListener('click', () => {
    d.close();
    announce('Preferences saved');
  });
  return d;
}
