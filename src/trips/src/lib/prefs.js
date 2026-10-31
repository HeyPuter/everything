import { applyTheme, currentTheme, onThemeChange } from '../ui/theme.js';
import { isCurrency } from '../shared/money.js';
import { intlLocale, localePinned, requestedLocale, setLocale } from './i18n/index.js';
import { isLocale } from './i18n/locales.js';
import '../views/settings/appearance.css';

/**
 * Account preferences (`me:prefs`). `prefs()` is the effective value: defaults, then this device's appearance, then
 * the account, then unsaved local changes. Local changes apply at once and stay in localStorage (shared by the
 * account's tabs) until the account write succeeds. Dismissed `tips` only accumulate.
 */
export const TEXT_SIZE = Object.freeze({ min: 0.8, max: 1.6, step: 0.1 });
export const DASHBOARD_WIDGETS = Object.freeze(['upcoming', 'fx', 'clocks', 'collections', 'atlas']);
export const AI_MODELS = Object.freeze({
  main: Object.freeze(['claude-sonnet-5-5', 'claude-opus-5-5']),
  quick: Object.freeze(['claude-haiku-5-5', 'claude-sonnet-5-5']),
});
export const ACCENTS = Object.freeze(['blue', 'teal', 'green', 'purple', 'orange', 'rose']);
const DEVICE_KEY = 'trips:appearance';
// Copied to this device so index.html can apply them before the first paint.
const DEVICE_APPEARANCE = ['textSize', 'contrast', 'motion', 'density', 'accent'];
const MILES = new Set(['US', 'GB', 'LR', 'MM']);
const FAHRENHEIT = new Set(['US', 'LR', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH']);
const POUNDS = new Set(['US', 'LR', 'MM']);

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const oneOf = (...values) => (value) => (values.includes(value) ? value : undefined);
const bool = (value) => (typeof value === 'boolean' ? value : undefined);
const slug = (value) => (typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : undefined);
const model = (value) => (typeof value === 'string' && /^[a-z0-9][a-z0-9.:/_-]{0,79}$/i.test(value) ? value : undefined);
function textSize(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value * 10) / 10;
  return rounded >= TEXT_SIZE.min && rounded <= TEXT_SIZE.max ? rounded : undefined;
}
function ids(value, max = 20) {
  return Array.isArray(value) ? [...new Set(value.filter((id) => slug(id)))].slice(0, max) : [];
}
// Unknown widget ids are kept so an older build never drops a newer build's widgets.
function widgets(value) {
  if (!plain(value)) return undefined;
  const order = ids(value.order);
  return { order: [...order, ...DASHBOARD_WIDGETS.filter((id) => !order.includes(id))], hidden: ids(value.hidden) };
}
function tips(value) {
  if (!plain(value)) return undefined;
  return Object.fromEntries(Object.keys(value).filter((key) => slug(key) && value[key] === true).slice(0, 200).map((key) => [key, true]));
}

const SANITIZE = Object.freeze({
  theme: oneOf('system', 'light', 'dark'),
  textSize,
  contrast: oneOf('normal', 'more'),
  motion: oneOf('system', 'reduce'),
  density: oneOf('comfortable', 'compact'),
  accent: oneOf(...ACCENTS),
  tabOrder: (value) => (Array.isArray(value) ? ids(value) : undefined),
  distanceUnit: oneOf('km', 'mi'),
  tempUnit: oneOf('c', 'f'),
  weightUnit: oneOf('kg', 'lb'),
  dateFormat: oneOf('auto', 'dmy', 'mdy', 'iso'),
  timeFormat: oneOf('auto', '24', '12'),
  weekStart: oneOf('auto', 'mon', 'sun', 'sat'),
  currency: (value) => (value === null || isCurrency(value) ? value : undefined),
  startPage: oneOf('trips', 'last', 'current'),
  tripTab: slug,
  placeDescriptions: bool,
  blurCodes: bool,
  mapStyle: oneOf('auto', 'light', 'dark', 'satellite'),
  mapPlaceLabels: bool,
  mapEndpointLabels: bool,
  mapExplorePills: bool,
  mapAlwaysRoutes: bool,
  mapOptimizeFromHotel: bool,
  widgetsDesktop: widgets,
  widgetsPhone: widgets,
  aiModel: model,
  aiQuickModel: model,
  assistantApproval: oneOf('always', 'destructive', 'never'),
  tips,
  lang: (value) => (value === 'auto' || isLocale(value) ? value : undefined),
});
export const PREF_KEYS = Object.freeze(Object.keys(SANITIZE));

/** The locale dates and numbers use: the UI language, with the browser's region when it has one (i18n `formatLocale`). */
export function displayLocale(nav = globalThis.navigator) {
  return intlLocale(nav);
}
export function localeRegion(locale) {
  try { return new Intl.Locale(locale).maximize().region; } catch { return undefined; }
}

export function defaultPrefs(locale = displayLocale()) {
  const region = localeRegion(locale);
  return {
    theme: 'system', textSize: 1, contrast: 'normal', motion: 'system', density: 'comfortable', accent: 'blue', tabOrder: [],
    distanceUnit: MILES.has(region) ? 'mi' : 'km', tempUnit: FAHRENHEIT.has(region) ? 'f' : 'c', weightUnit: POUNDS.has(region) ? 'lb' : 'kg',
    dateFormat: 'auto', timeFormat: 'auto', weekStart: 'auto', currency: null,
    startPage: 'trips', tripTab: 'plan', placeDescriptions: true, blurCodes: false,
    mapStyle: 'auto', mapPlaceLabels: true, mapEndpointLabels: true, mapExplorePills: true, mapAlwaysRoutes: false, mapOptimizeFromHotel: true,
    widgetsDesktop: { order: [...DASHBOARD_WIDGETS], hidden: [] }, widgetsPhone: { order: [...DASHBOARD_WIDGETS], hidden: [] },
    aiModel: AI_MODELS.main[0], aiQuickModel: AI_MODELS.quick[0], assistantApproval: 'destructive', tips: {}, lang: 'auto',
  };
}

/** Known keys with valid values only; anything else reads as absent. */
export function cleanPrefs(value) {
  if (!plain(value)) return {};
  const result = {};
  for (const key of PREF_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const cleaned = SANITIZE[key](value[key]);
    if (cleaned !== undefined) result[key] = cleaned;
  }
  return result;
}
function checked(patch) {
  if (!plain(patch)) throw new TypeError('Preferences must be an object');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    const cleaned = Object.hasOwn(SANITIZE, key) ? SANITIZE[key](value) : undefined;
    if (cleaned === undefined) throw new TypeError(`Invalid preference: ${key}`);
    result[key] = cleaned;
  }
  return result;
}

function storage() { try { return globalThis.localStorage ?? null; } catch { return null; } }
function readJSON(key) { try { return JSON.parse(storage()?.getItem(key) ?? 'null'); } catch { return null; } }
function writeJSON(key, value) {
  try { if (value === undefined) storage()?.removeItem(key); else storage()?.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
// Key order is not significant (KV need not keep it).
const stable = (value) => (Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : plain(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : String(JSON.stringify(value)));
const same = (a, b) => stable(a) === stable(b);
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
const freeze = (value) => deepFreeze(structuredClone(value));
const unwrap = (sent) => Object.fromEntries(Object.entries(sent ?? {}).map(([key, entry]) => [key, entry.value]));

const listeners = new Set();
const statusListeners = new Set();
let active = null;
let status = Object.freeze({ state: 'idle' });

function deviceAppearance() {
  const stored = cleanPrefs(readJSON(DEVICE_KEY));
  const result = { theme: currentTheme() };
  for (const key of DEVICE_APPEARANCE) if (Object.hasOwn(stored, key)) result[key] = stored[key];
  return result;
}
function compute() {
  const layers = [defaultPrefs(), deviceAppearance(), active?.cloud ?? {}, unwrap(active?.sent), active?.pending ?? {}];
  return freeze({ ...Object.assign({}, ...layers), tips: Object.assign({}, ...layers.map((layer) => layer.tips)) });
}
let effective = compute();
onThemeChange(() => recompute());

/** Sets the pre-paint attributes for text size, contrast, motion, density and accent (theme is `applyTheme`). */
export function applyAppearance(value, root = globalThis.document?.documentElement) {
  if (!root) return;
  if (value.textSize === 1) root.style.removeProperty('--text-scale'); else root.style.setProperty('--text-scale', String(value.textSize));
  if (value.contrast === 'more') root.dataset.contrast = 'more'; else delete root.dataset.contrast;
  if (value.motion === 'reduce') root.dataset.motion = 'reduce'; else delete root.dataset.motion;
  if (value.density === 'compact') root.dataset.density = 'compact'; else delete root.dataset.density;
  if (ACCENTS.includes(value.accent) && value.accent !== 'blue') root.dataset.accent = value.accent; else delete root.dataset.accent;
}
function recompute({ theme = false } = {}) {
  const previous = effective;
  const next = compute();
  const changed = new Set(PREF_KEYS.filter((key) => !same(previous[key], next[key])));
  // Unchanged values keep their identity so consumers can compare by reference.
  if (changed.size) effective = next;
  const appearance = Object.fromEntries(DEVICE_APPEARANCE.map((key) => [key, effective[key]]));
  applyAppearance(appearance);
  if (!same(readJSON(DEVICE_KEY), appearance)) writeJSON(DEVICE_KEY, appearance);
  if (theme && effective.theme !== currentTheme()) applyTheme(effective.theme);
  // A language saved in the account wins once read (unless `?lang=` chose one); a change made here always does.
  const chosen = active && (Object.hasOwn(active.pending, 'lang') || (active.cloud && Object.hasOwn(active.cloud, 'lang') && !localePinned()));
  if (chosen && effective.lang !== requestedLocale()) void setLocale(effective.lang);
  if (!changed.size) return;
  for (const listener of [...listeners]) { try { listener(effective, changed); } catch { /* One listener must not stop the rest. */ } }
}
function setStatus(next) {
  status = Object.freeze(next);
  for (const listener of [...statusListeners]) { try { listener(status); } catch { /* Ignored. */ } }
}
function errorCode(error) {
  const code = error?.status;
  return code === 402 ? 'credit' : code === 401 || code === 403 ? 'forbidden' : code === 409 ? 'conflict' : 'failed';
}
const offlineError = (error) => error?.status === 0 || error?.code === 'offline' || (error instanceof TypeError && /fetch|network/i.test(error.message));

export function prefs() { return effective; }
export function onPrefs(listener) { listeners.add(listener); return () => listeners.delete(listener); }
/** `{state: idle|saving|saved|offline|error, code?: credit|forbidden|conflict|failed|load}`. */
export function prefsStatus() { return status; }
export function onPrefsStatus(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener); }
export function prefsBound() { return Boolean(active); }
export function setPrefs(patch) {
  if (!active) throw Object.assign(new Error('Preferences are not connected'), { code: 'prefs_unbound' });
  return active.set(patch);
}
export function retryPrefs() { return active?.retry() ?? Promise.resolve(); }

/** `phone` below the shell's 900px breakpoint, otherwise `desktop`. */
export function currentDevice(win = globalThis.window) {
  return win?.matchMedia?.('(max-width: 899px)').matches ? 'phone' : 'desktop';
}
/** Ordered dashboard widgets for a device: `[{id, visible}]`. */
export function dashboardWidgets(device = currentDevice(), value = effective) {
  const entry = value[device === 'phone' ? 'widgetsPhone' : 'widgetsDesktop'];
  return entry.order.map((id) => ({ id, visible: !entry.hidden.includes(id) }));
}
/** Primary routes in the phone tab-bar order: ids named in `tabOrder` first, the rest in registry order. */
export function orderTabs(items, value = effective) {
  const order = value.tabOrder ?? [];
  const rank = (item) => { const index = order.indexOf(item.id); return index < 0 ? order.length + items.indexOf(item) : index; };
  return [...items].sort((a, b) => rank(a) - rank(b));
}
/** `theme` is null when the map follows the app theme. */
export function mapPrefs(value = effective) {
  return {
    basemap: value.mapStyle === 'satellite' ? 'satellite' : 'map',
    theme: ['light', 'dark'].includes(value.mapStyle) ? value.mapStyle : null,
    placeLabels: value.mapPlaceLabels, endpointLabels: value.mapEndpointLabels, explorePills: value.mapExplorePills,
    alwaysRoutes: value.mapAlwaysRoutes, optimizeFromHotel: value.mapOptimizeFromHotel,
  };
}
export function aiPrefs(value = effective) {
  return { model: value.aiModel, quickModel: value.aiQuickModel, approval: value.assistantApproval };
}
export function prefersReducedMotion(value = effective, win = globalThis.window) {
  return value.motion === 'reduce' || Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

// Unsaved changes live in localStorage so every tab of the account sees and sends the same set.
function pendingStore(key) {
  let memory = cleanPrefs(readJSON(key));
  let shared = Boolean(storage());
  return {
    read() { if (shared) memory = cleanPrefs(readJSON(key)); return { ...memory }; },
    write(value) {
      memory = { ...value };
      if (shared && !writeJSON(key, Object.keys(value).length ? value : undefined)) shared = false;
    },
  };
}

/**
 * Connects `me:prefs` for one signed-in account. Returns `{ready, set, flush, retry, localTheme, close}`; `ready`
 * settles once the account value has been read or has failed to load. `personal` is the store from
 * `createPersonalStore`; `subscribe`, `refresh` and `watch` are optional.
 */
export function bindPrefs({ personal, account, window: target = globalThis.window, debounce = 400 }) {
  if (!personal?.get || !personal?.patchPreferences) throw new TypeError('A personal store is required');
  active?.close();
  const pendingKey = `trips:prefs:pending:${typeof account === 'string' ? account : 'unknown'}`;
  const unsaved = pendingStore(pendingKey);
  const offs = [];
  let closed = false;
  let timer; let backoff; let watchTimer;
  let attempts = 0; let watchAttempts = 0;
  let flushing = null; let again = false;
  let loaded = false; let watching = false;
  let saves = 0; let verifying = false;
  const online = () => target?.navigator?.onLine !== false;
  const unsent = () => Object.keys(binding.pending).length > 0;
  const loadFailed = () => status.state === 'error' && status.code === 'load';
  const stale = () => Object.entries(binding.sent).some(([key, entry]) => !same(binding.cloud?.[key], entry.value));
  const binding = {
    cloud: null,
    pending: unsaved.read(),
    // Saved keys that no account read begun after the save has confirmed yet: `{key: {value, save}}`.
    sent: {},
    ready: null,
    set(patch) {
      if (closed) throw new Error('Preferences binding is closed');
      const changes = checked(patch);
      const stored = unsaved.read();
      if (changes.tips) changes.tips = { ...stored.tips, ...changes.tips };
      binding.pending = { ...stored, ...changes };
      unsaved.write(binding.pending);
      recompute({ theme: true });
      setStatus({ state: online() ? 'saving' : 'offline' });
      clearTimeout(timer); timer = setTimeout(() => { void binding.flush(); }, debounce);
    },
    flush() {
      clearTimeout(timer); clearTimeout(backoff);
      if (closed) return Promise.resolve();
      if (flushing) { again = true; return flushing; }
      adopt(unsaved.read());
      if (!unsent()) return Promise.resolve();
      if (!online()) { setStatus({ state: 'offline' }); return Promise.resolve(); }
      const sent = { ...binding.pending };
      setStatus({ state: 'saving' });
      flushing = (async () => {
        let failed = false;
        try {
          const payload = { ...sent };
          // Tips dismissed on another device since this one last read are kept.
          if (payload.tips && personal.refresh) payload.tips = { ...cleanPrefs(await personal.refresh('me:prefs')).tips, ...payload.tips };
          await personal.patchPreferences(payload);
          if (closed) return;
          saves += 1;
          for (const [key, value] of Object.entries(payload)) binding.sent[key] = { value, save: saves };
          // Another tab may have changed a key meanwhile; only keys still holding the sent value are done.
          const stored = unsaved.read();
          for (const [key, value] of Object.entries(sent)) if (same(stored[key], value)) delete stored[key];
          unsaved.write(stored); binding.pending = stored;
          binding.cloud = { ...(binding.cloud ?? {}), ...payload };
          recompute();
          if (!unsent()) setStatus(loaded ? { state: 'saved' } : { state: 'error', code: 'load' });
          attempts = 0;
          if (!loaded) void load();
        } catch (error) {
          failed = true;
          if (!closed) {
            setStatus(online() && !offlineError(error) ? { state: 'error', code: errorCode(error) } : { state: 'offline' });
            // Connectivity right after an `online` event and server errors are often transient.
            if (online() && (offlineError(error) || [408, 429].includes(error?.status) || error?.status >= 500)) {
              clearTimeout(backoff); backoff = setTimeout(() => { void binding.flush(); }, Math.min(60_000, 1000 * 3 ** attempts++));
            }
          }
        } finally { flushing = null; }
        if (!closed && !failed && (again || unsent())) { again = false; await binding.flush(); }
        again = false;
      })();
      return flushing;
    },
    async retry() {
      if (closed) return;
      if (loadFailed()) await load();
      await binding.flush();
    },
    /** A theme chosen on this device that the account has not stored yet. */
    localTheme() { return binding.pending.theme; },
    close() {
      if (closed) return;
      closed = true; clearTimeout(timer); clearTimeout(backoff); clearTimeout(watchTimer);
      for (const off of offs.splice(0)) { try { off?.(); } catch { /* Ignored. */ } }
      target?.removeEventListener?.('online', reconnect);
      target?.removeEventListener?.('pagehide', leave);
      target?.removeEventListener?.('storage', shared);
      if (active === binding) { active = null; setStatus({ state: 'idle' }); recompute(); }
    },
  };
  function settled() { loaded = true; if (loadFailed()) setStatus({ state: 'idle' }); }
  // The unsaved set changed in another tab, or another tab sent it.
  function adopt(next) {
    if (same(next, binding.pending)) return;
    binding.pending = next;
    recompute({ theme: true });
    if (!unsent() && ['saving', 'offline', 'error'].includes(status.state) && !loadFailed()) setStatus({ state: 'saved' });
  }
  // A read begun before a save here can carry the old values, so they show only after a fresh read confirms them.
  function verify() {
    if (verifying || !personal.refresh) return;
    verifying = true;
    const before = saves;
    void (async () => {
      try {
        const value = await personal.refresh('me:prefs');
        if (closed) return;
        for (const [key, entry] of Object.entries(binding.sent)) if (entry.save <= before) delete binding.sent[key];
        binding.cloud = cleanPrefs(value);
        settled();
        recompute({ theme: true });
      } catch { /* The saved values keep showing until a later read. */ } finally { verifying = false; }
    })();
  }
  async function load() {
    try {
      const value = await personal.get('me:prefs');
      if (closed) return;
      binding.cloud = cleanPrefs(value);
      settled();
      if (stale()) verify();
      // The shell applies the boot theme itself, so only appearance attributes change here.
      recompute();
    } catch (error) {
      if (closed || error?.code === 'account_changed') return;
      setStatus({ state: 'error', code: 'load' });
    }
    if (!closed && unsent()) void binding.flush();
  }
  // Live updates from other sessions; a failed start is retried with backoff and on reconnect.
  function watch() {
    if (closed || watching || typeof personal.watch !== 'function') return;
    watching = true; clearTimeout(watchTimer);
    Promise.resolve().then(() => personal.watch()).then((stop) => {
      watchAttempts = 0;
      if (typeof stop === 'function') { if (closed) stop(); else offs.push(stop); }
    }, (error) => {
      watching = false;
      if (closed || error?.code === 'account_changed') return;
      watchTimer = setTimeout(watch, Math.min(60_000, 2000 * 2 ** watchAttempts++));
    });
  }
  function reconnect() { watch(); if (unsent()) void binding.flush(); }
  function leave() { if (unsent()) void binding.flush(); }
  function shared(event) { if (!closed && (event.key === pendingKey || event.key === null)) adopt(unsaved.read()); }
  active = binding;
  setStatus({ state: 'idle' });
  recompute();
  const off = personal.subscribe?.('me:prefs', (value) => {
    if (closed) return;
    binding.cloud = cleanPrefs(value);
    if (stale()) verify();
    recompute({ theme: true });
  });
  if (off) offs.push(off);
  watch();
  target?.addEventListener?.('online', reconnect);
  target?.addEventListener?.('pagehide', leave);
  target?.addEventListener?.('storage', shared);
  binding.ready = load();
  return binding;
}
