// Settings → Flight status: the user's own AeroDataBox key, kept in their KV and used only from this browser.
import { el } from '../../ui/dom.js';
import { button, skeleton } from '../../ui/bits.js';
import { field } from '../../ui/fields.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { createFlightKeyStore, validFlightKey } from '../../services/flights.js';
import { alertRegion, busy, errorText, group } from './ui.js';

const PROVIDER_URL = 'https://rapidapi.com/aedbx-aedbx/api/aerodatabox';

export async function mount(container, { puter, signal }) {
  const store = createFlightKeyStore(puter);
  const alert = alertRegion();
  const state = el('p.pref-hint', { role: 'status' });
  const input = field({ label: t('flightStatus.keyLabel'), hint: t('flightStatus.keyHint'), type: 'password', autocomplete: 'off', spellcheck: false, autocapitalize: 'off' });
  const reveal = button(t('flightStatus.show'), { size: 'sm', variant: 'ghost', 'aria-pressed': 'false', onclick: () => {
    const shown = input.input.type === 'text';
    input.input.type = shown ? 'password' : 'text';
    reveal.setAttribute('aria-pressed', String(!shown));
  } });
  const save = button(t('flightStatus.save'), { variant: 'primary', onclick: () => { void submit(); } });
  const remove = button(t('flightStatus.remove'), { variant: 'outline', onclick: () => { void clear(); } });
  const form = el('form.settings-flight-key', { onsubmit: (event) => { event.preventDefault(); void submit(); } },
    input.element, el('div.settings-actions', {}, save, reveal, remove));
  const body = el('div', { 'aria-busy': 'true' }, skeleton(), skeleton('60%'));
  const host = new URL(PROVIDER_URL).host;

  function paint(key) {
    state.textContent = key ? t('flightStatus.keySaved', { last: key.slice(-4) }) : t('flightStatus.keyNone');
    remove.hidden = !key;
  }
  async function load() {
    body.setAttribute('aria-busy', 'true');
    try {
      const key = await store.get({ fresh: true });
      if (signal?.aborted) return;
      paint(key);
      body.replaceChildren(state, form, alert.node);
    } catch (error) {
      if (signal?.aborted) return;
      body.replaceChildren(el('div.settings-error', {}, el('p', {}, t('flightStatus.loadFailed'), ' ', errorText(error)),
        button(t('settings.retry'), { size: 'sm', variant: 'outline', onclick: load })));
    } finally { body.removeAttribute('aria-busy'); }
  }
  async function submit() {
    const value = input.input.value.trim();
    if (!validFlightKey(value)) { input.setError(t('flightStatus.keyInvalid')); input.input.focus(); return; }
    input.setError('');
    const saved = await busy(save, alert, () => store.set(value));
    if (saved === undefined || signal?.aborted) return;
    input.input.value = '';
    paint(saved);
    toast(t('flightStatus.savedToast'));
  }
  async function clear() {
    const done = await busy(remove, alert, () => store.remove().then(() => true));
    if (!done || signal?.aborted) return;
    paint(null);
    save.focus();
    toast(t('flightStatus.removedToast'));
  }

  container.replaceChildren(el('div.settings-stack', {},
    group(t('flightStatus.settingsTitle'),
      el('p.pref-hint', {}, t('flightStatus.settingsHint')),
      el('p.pref-hint', {}, t('flightStatus.privacy')),
      el('p.pref-hint', {}, el('a', { href: PROVIDER_URL, target: '_blank', rel: 'noopener noreferrer' }, t('flightStatus.getKey', { host }))),
      body)));
  await load();
  return undefined;
}
