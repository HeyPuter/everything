// Sections load as their own chunks, so the row and group styles travel with the helpers that build them.
import './settings.css';
import { el, uid } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { segmented, choiceGroup } from '../../ui/fields.js';
import { t } from '../../lib/i18n/index.js';
import { prefs, setPrefs, onPrefs, prefsStatus, onPrefsStatus, retryPrefs, displayLocale } from '../../lib/prefs.js';
import { icon } from './icons.js';

/** A titled block of settings rows. */
export function group(title, ...children) {
  if (!title) return el('div.pref-group', {}, ...children);
  const id = uid('settings-group');
  return el('section.pref-group', { 'aria-labelledby': id }, el('h3.pref-group-title', { id }, title), ...children);
}
/** Label and hint at the start, control at the end; `labelFor` uses a real label for form fields. */
export function row({ label, hint, control, labelFor, stacked = false, bare = false }) {
  const labelId = uid('pref-label'); const hintId = hint ? uid('pref-hint') : null;
  const node = el(`div.pref-row${stacked ? '.stacked' : ''}`, {},
    !bare && el('div.pref-text', {}, labelFor ? el('label.pref-label', { id: labelId, htmlFor: labelFor }, label) : el('span.pref-label', { id: labelId }, label),
      hint && el('span.pref-hint', { id: hintId }, hint)),
    control);
  return { node, labelId, hintId: bare ? null : hintId };
}
const describe = (target, { labelId, hintId }, labelled = true) => {
  if (labelled) target.setAttribute('aria-labelledby', labelId);
  if (hintId) target.setAttribute('aria-describedby', hintId);
};

/**
 * Controls bound to one preference key. Each returns `{node, update(prefs)}` so live changes from another session
 * update the control without re-rendering (and without moving focus).
 */
export function prefSwitch(key, label, hint, { on = true, off = false } = {}) {
  const control = el('button.switch', { type: 'button', role: 'switch', 'aria-checked': prefs()[key] === on,
    onclick: () => setPrefs({ [key]: prefs()[key] === on ? off : on }) }, el('span.switch-thumb'));
  const parts = row({ label, hint, control });
  describe(control, parts);
  return { node: parts.node, update: (value) => control.setAttribute('aria-checked', String(value[key] === on)) };
}
export function prefSelect(key, label, options, { hint, toValue = (value) => value, fromValue = (value) => value } = {}) {
  const id = uid('pref-select');
  const control = el('select.select.pref-select', { id, onchange: () => setPrefs({ [key]: toValue(control.value) }) },
    options.map((option) => el('option', { value: option.value }, option.label)));
  control.value = fromValue(prefs()[key]);
  const parts = row({ label, hint, control, labelFor: id });
  if (parts.hintId) control.setAttribute('aria-describedby', parts.hintId);
  return { node: parts.node, update: (value) => { if (document.activeElement !== control) control.value = fromValue(value[key]); } };
}
/** `bare` drops the visible label when a group title already names the choice. */
export function prefChoice(key, label, items, { hint, cards = false, bare = false } = {}) {
  const make = cards ? choiceGroup : segmented;
  const control = make({ label, items, value: prefs()[key], onChange: (value) => setPrefs({ [key]: value }) });
  const parts = row({ label, hint, control: control.element, stacked: cards, bare });
  describe(control.element, parts, false);
  return { node: parts.node, update: (value) => control.setValue(value[key]) };
}
/** Calls `update(prefs)` on each control when preferences change. */
export function keepInSync(controls, signal) {
  const off = onPrefs((value) => { for (const control of controls) control.update?.(value); });
  signal?.addEventListener('abort', off, { once: true });
  return off;
}

const STATUS = {
  saving: 'settings.statusSaving', saved: 'settings.statusSaved', offline: 'settings.statusOffline',
  credit: 'settings.statusCredit', forbidden: 'settings.statusForbidden', conflict: 'settings.statusConflict',
  failed: 'settings.statusFailed', load: 'settings.statusLoad',
};
/** The account save state for preference sections, with Retry when a save or load failed. */
export function statusLine(signal) {
  const node = el('div.settings-status', { role: 'status' });
  function render(status) {
    const key = status.state === 'error' ? STATUS[status.code] ?? STATUS.failed : STATUS[status.state];
    node.replaceChildren();
    node.hidden = !key;
    node.dataset.state = status.state;
    if (!key) return;
    node.append(el('span', {}, t(key)));
    if (status.state === 'error' || status.state === 'offline') {
      node.append(button(t('settings.retry'), { size: 'sm', variant: 'outline', onclick: (event) => {
        const control = event.currentTarget; control.setAttribute('aria-busy', 'true');
        void retryPrefs().finally(() => control.setAttribute('aria-busy', 'false'));
      } }));
    }
  }
  render(prefsStatus());
  const off = onPrefsStatus(render);
  signal?.addEventListener('abort', off, { once: true });
  return node;
}

/** A translated message for a failed personal-data call. */
export function errorText(error, online = globalThis.navigator?.onLine !== false) {
  if (!online || error?.status === 0 || error?.code === 'offline') return t('settings.errorOffline');
  if (error?.status === 402) return t('settings.errorCredit');
  if (error?.status === 401 || error?.status === 403) return t('settings.errorForbidden');
  if (error?.status === 409) return t('settings.errorConflict');
  if (error?.status === 413 || error?.code === 'value_too_large') return t('settings.errorTooLarge');
  return t('settings.errorGeneric');
}
/** An inline alert region; `show(message)` replaces its text, `clear()` hides it. */
export function alertRegion() {
  const node = el('p.settings-alert', { role: 'alert', hidden: true });
  return { node, show(message) { node.textContent = message; node.hidden = false; }, clear() { node.textContent = ''; node.hidden = true; } };
}
/** Runs an async action with a busy control; failures are shown in `alert` and resolve to undefined. */
export async function busy(control, alert, action, describe = errorText) {
  control?.setAttribute('aria-busy', 'true');
  alert?.clear();
  try { return await action(); }
  catch (error) { alert?.show(describe(error)); return undefined; }
  finally { control?.setAttribute('aria-busy', 'false'); }
}
/** `{count}` in the singular or plural string: English plural rules (the strings are English), display-locale digits. */
export function plural(count, one, other) {
  return t(new Intl.PluralRules('en').select(count) === 'one' ? one : other, { count: new Intl.NumberFormat(displayLocale()).format(count) });
}

const focusLost = () => { const active = document.activeElement; return !active || active === document.body || !active.isConnected; };
/**
 * Keeps keyboard focus in a list across redraws. Rows carry `data-id`, their controls `data-focus`. `hold(node)`
 * remembers a row control before an action opens a dialog. `redraw(draw)` puts focus back on the same control, on the
 * next or previous row when the row is gone, or on `fallback()`. `release()` ends an action that did not redraw.
 */
export function listFocus(list, fallback) {
  let held = null;
  function where(node) {
    const row = node instanceof Element && list.contains(node) ? node.closest('[data-id]') : null;
    if (!row || !list.contains(row)) return null;
    return { id: row.dataset.id, control: node.dataset.focus, index: [...list.querySelectorAll('[data-id]')].indexOf(row) };
  }
  function restore(target) {
    const rows = [...list.querySelectorAll('[data-id]')];
    const row = rows.find((node) => node.dataset.id === target.id) ?? rows[Math.min(target.index, rows.length - 1)];
    const controls = row ? [...row.querySelectorAll('[data-focus]')].filter((node) => !node.disabled) : [];
    (controls.find((node) => node.dataset.focus === target.control) ?? controls[0] ?? fallback?.())?.focus();
  }
  return {
    hold(node = document.activeElement) { held = where(node); },
    redraw(draw) {
      const target = where(document.activeElement) ?? (focusLost() ? held : null);
      draw();
      if (target) { held = null; restore(target); }
    },
    release() { if (held && focusLost()) restore(held); held = null; },
  };
}
/** Puts one of the settings icons at the start of a kit button. */
export function withIcon(node, name) { node.prepend(icon(name)); return node; }

/** Opens the browser file picker and resolves with the chosen file, or null when cancelled. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, hidden: true });
    let settled = false;
    const done = (file) => { if (settled) return; settled = true; input.remove(); resolve(file); };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    document.body.append(input); input.click();
  });
}
