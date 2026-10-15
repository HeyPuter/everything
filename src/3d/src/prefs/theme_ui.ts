// Preferences ▸ Themes: the active theme (a preset plus the user's colour edits), saved user
// themes, JSON import / export and the per-editor colour groups.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators } from '../app/app';
import { prefs } from '../app/prefs';
import { colorSwatch, enumMenu, numberField, panel, type EnumItem } from '../ui/widgets';
import { splitRow } from '../ui/props';
import { promptText } from '../ui/menu';
import { download, pickFile } from '../io/native';
import { registerPrefSection } from './editor';
import { registerPrefStore, prefsChanged, onPrefsApply } from './store';
import { THEME_GROUPS, BUILTIN_THEMES, presetValues, applyThemeValues, parseHex, toHex, themeItem, type ThemeValues } from './themes';

const STATE_KEY = 'p3d.theme.v1';
const USER_KEY = 'p3d.themes.user.v1';

interface ThemeState {
  /** built-in preset id or `user:<name>` */
  preset: string;
  /** colours changed on top of the preset */
  edits: ThemeValues;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // storage unavailable
  }
}

/** Keep only known items with well-formed values (imported files are untrusted). */
export function cleanValues(raw: unknown): ThemeValues {
  const out: ThemeValues = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const it = themeItem(k);
    if (!it || typeof v !== 'string') continue;
    if (it.number ? /^-?\d+(\.\d+)?$/.test(v) : /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) out[k] = v.toLowerCase();
  }
  return out;
}

export function userThemes(): Record<string, ThemeValues> {
  const all = read<Record<string, unknown>>(USER_KEY) ?? {};
  return Object.fromEntries(Object.entries(all).map(([n, v]) => [n, cleanValues(v)]));
}

function initialState(): ThemeState {
  const s = read<ThemeState>(STATE_KEY);
  if (s && typeof s.preset === 'string') return { preset: s.preset, edits: cleanValues(s.edits) };
  // older builds only stored the theme name in the preferences
  return { preset: BUILTIN_THEMES.some((t) => t.id === prefs.theme) ? prefs.theme : 'DEFAULT', edits: {} };
}

export const themeState: ThemeState = initialState();
let dirty = false;

function baseValues(preset = themeState.preset): ThemeValues {
  if (preset.startsWith('user:')) {
    const u = userThemes()[preset.slice(5)];
    if (u) return presetValues({ id: preset, label: preset, values: u });
  }
  const b = BUILTIN_THEMES.find((t) => t.id === preset) ?? BUILTIN_THEMES[0];
  return presetValues(b);
}

export function currentThemeValues(): ThemeValues {
  return { ...baseValues(), ...themeState.edits };
}

export function applyTheme() {
  applyThemeValues(currentThemeValues());
}

function persist() {
  prefs.theme = themeState.preset;
  if (prefs.use_preferences_save) {
    write(STATE_KEY, themeState);
    dirty = false;
  } else dirty = true;
  prefsChanged();
}

export function setThemePreset(id: string) {
  themeState.preset = id;
  themeState.edits = {};
  applyTheme();
  persist();
}

export function setThemeColor(id: string, value: string) {
  if (baseValues()[id] === value) delete themeState.edits[id];
  else themeState.edits[id] = value;
  applyTheme();
  persist();
}

export function exportThemeText(name: string) {
  return JSON.stringify({ format: 'p3d-theme', version: 1, name, values: currentThemeValues() }, null, 2);
}

/** Import a theme file as a user theme and make it active; returns its name. */
export function importThemeText(text: string, fallbackName: string): string {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON');
  }
  if (!raw || raw.format !== 'p3d-theme') throw new Error('Not a theme file');
  const values = cleanValues(raw.values);
  if (!Object.keys(values).length) throw new Error('The theme has no colours');
  const name = (typeof raw.name === 'string' && raw.name.trim()) || fallbackName;
  saveUserTheme(name, values);
  setThemePreset(`user:${name}`);
  return name;
}

export function saveUserTheme(name: string, values = currentThemeValues()) {
  const all = userThemes();
  all[name] = values;
  write(USER_KEY, all);
}

export function removeUserTheme(name: string) {
  const all = userThemes();
  delete all[name];
  write(USER_KEY, all);
  if (themeState.preset === `user:${name}`) setThemePreset('DEFAULT');
}

registerPrefStore({
  save: () => {
    write(STATE_KEY, themeState);
    dirty = false;
  },
  revert: () => {
    Object.assign(themeState, initialState());
    dirty = false;
    applyTheme();
  },
  factory: () => {
    themeState.preset = 'DEFAULT';
    themeState.edits = {};
    write(STATE_KEY, null);
    dirty = false;
    applyTheme();
  },
});

let applied = false;
// apply a stored theme right away so the interface never flashes the default colours
if (typeof document !== 'undefined' && (themeState.preset !== 'DEFAULT' || Object.keys(themeState.edits).length)) {
  applyTheme();
  applied = true;
}
onPrefsApply(() => {
  // the theme only needs applying once at startup; changes apply as they are made
  if (applied) return;
  applied = true;
  applyTheme();
});

export function themeDirty() {
  return dirty;
}

// ---------------------------------------------------------------------------
// UI

let filter = '';

function presetChoices(): EnumItem[] {
  return [...BUILTIN_THEMES.map((t) => ({ value: t.id, label: t.label })), ...Object.keys(userThemes()).map((n) => ({ value: `user:${n}`, label: n, description: 'Saved theme' }))];
}

function itemRow(id: string): Child {
  const it = themeItem(id)!;
  const cur = currentThemeValues()[id] ?? it.def;
  const edited = id in themeState.edits;
  const control = it.number
    ? numberField({ id: `th-${id}`, value: Number(cur) || 0, min: it.number.min, max: it.number.max, int: true, unit: 'pixel', set: (v, f) => f && setThemeColor(id, String(Math.round(v))) })
    : colorSwatch(`th-${id}`, parseHex(cur).slice(0, it.alpha ? 4 : 3), (v, final) => final && setThemeColor(id, toHex(v[0], v[1], v[2], it.alpha ? (v[3] ?? 1) : 1)), { linear: false, alpha: it.alpha });
  return h(
    'div',
    { key: id, class: { 'th-row': true, edited } },
    splitRow(it.label, control),
    h('button', { class: 'hdr-toggle th-reset', disabled: !edited, 'data-tip': 'Reset\nUse the colour of the theme preset', 'aria-label': `Reset ${it.label}`, onclick: () => setThemeColor(id, baseValues()[id]) }, icon('km_restore')),
  );
}

function themesBody(redraw: () => void): Child {
  const cur = themeState.preset;
  const isUser = cur.startsWith('user:');
  const nEdits = Object.keys(themeState.edits).length;
  const q = filter.trim().toLowerCase();
  return [
    h(
      'div',
      { class: 'km-toolbar th-presets' },
      enumMenu('th-preset', presetChoices(), cur, (v) => (setThemePreset(v), redraw()), { tip: 'Theme\nChoose a built-in or saved theme' }),
      h(
        'button',
        {
          class: 'btn icon-btn',
          'data-tip': 'Save Theme\nSave the current colours as a named theme',
          'aria-label': 'Save theme',
          onclick: (e: MouseEvent) =>
            promptText(
              'Theme Name',
              isUser ? cur.slice(5) : 'My Theme',
              (name) => {
                const n = name.trim();
                if (!n) return;
                saveUserTheme(n);
                setThemePreset(`user:${n}`);
                app.report('INFO', `Saved theme "${n}"`);
                redraw();
              },
              { x: e.clientX, y: e.clientY },
            ),
        },
        icon('add'),
      ),
      h('button', { class: 'btn icon-btn', disabled: !isUser, 'data-tip': 'Remove Theme\nDelete the selected saved theme', 'aria-label': 'Remove theme', onclick: () => (removeUserTheme(cur.slice(5)), redraw()) }, icon('remove')),
      h('button', { class: 'btn', disabled: !nEdits, 'data-tip': 'Reset\nDiscard colour changes made on top of the theme', onclick: () => (setThemePreset(cur), redraw()) }, 'Reset'),
      h('div', { class: 'hdr-spacer' }),
      h('button', { class: 'btn', 'data-tip': 'Import\nLoad a theme from a JSON file', onclick: () => app.run('preferences.theme_install') }, icon('import'), 'Import…'),
      h('button', { class: 'btn', 'data-tip': 'Export\nSave the current theme as a JSON file', onclick: () => app.run('preferences.theme_export') }, icon('export'), 'Export…'),
    ),
    nEdits ? h('div', { class: 'prefs-note' }, `${nEdits} colour(s) changed from the preset. Save them as a theme with +, or Reset.`) : null,
    h('label', { class: 'text-field th-search' }, icon('search'), h('input', { value: filter, placeholder: 'Filter colours', spellcheck: 'false', 'aria-label': 'Filter theme colours', oninput: (e: Event) => ((filter = (e.target as HTMLInputElement).value), redraw()) })),
    THEME_GROUPS.map((g) => {
      const items = g.items.filter((i) => !q || i.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q));
      if (!items.length) return null;
      return panel(`pf-th-${g.id}`, g.label, () => h('div', { class: 'th-list' }, items.map((i) => itemRow(i.id))), { closed: !q && g.id !== 'ui' });
    }),
  ];
}

registerPrefSection({ id: 'THEMES', label: 'Themes', group: 0, draw: (c) => themesBody(c.redraw) });

registerOperators([
  {
    idname: 'preferences.theme_install',
    label: 'Install Theme…',
    description: 'Load a theme from a JSON file and make it active',
    undo: false,
    exec: () => {
      void pickFile('.json,application/json').then(async (f) => {
        if (!f) return;
        try {
          const name = importThemeText(await f.text(), f.name.replace(/\.json$/i, ''));
          app.report('INFO', `Theme "${name}" installed`);
        } catch (e) {
          app.report('ERROR', `Could not install ${f.name}: ${(e as Error).message}`);
        }
        app.changed('ui');
      });
    },
  },
  {
    idname: 'preferences.theme_export',
    label: 'Export Theme…',
    description: 'Save the current theme colours as a JSON file',
    undo: false,
    exec: () => {
      const name = themeState.preset.startsWith('user:') ? themeState.preset.slice(5) : (BUILTIN_THEMES.find((t) => t.id === themeState.preset)?.label ?? 'theme');
      download(exportThemeText(name), `${name.replace(/[^\w.-]+/g, '_')}.json`, 'application/json');
    },
  },
]);
