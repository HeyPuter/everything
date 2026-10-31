// Settings → Integrations: the user's own AirTrail, Immich and Dawarich servers.
import '../integrations/integrations.css';
import { el, uid } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { field } from '../../ui/fields.js';
import { confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { integrationStore } from '../../lib/integrations/store.js';
import { isPlainHttp, normalizeServerUrl } from '../../lib/integrations/client.js';
import { airtrailClient, verifyAirtrail } from '../../lib/integrations/airtrail.js';
import { immichClient, verifyImmich } from '../../lib/integrations/immich.js';
import { dawarichClient, verifyDawarich } from '../../lib/integrations/dawarich.js';
import { errorText, netAvailable, serviceName } from '../integrations/common.js';
import { icon } from '../integrations/icons.js';
import { group } from './ui.js';

const SERVICES = [
  { id: 'airtrail', client: airtrailClient, verify: verifyAirtrail, who: (result) => result.user?.name || null, flag: { name: 'sync', label: 'integrations.airtrail.sync', hint: 'integrations.airtrail.syncHint', initial: true } },
  { id: 'immich', client: immichClient, verify: verifyImmich, who: (result) => result.user?.name || null },
  { id: 'dawarich', client: dawarichClient, verify: verifyDawarich, who: (result) => result.user?.email || null, flag: { name: 'trails', label: 'integrations.dawarich.trails', hint: 'integrations.dawarich.trailsHint', initial: true } },
];

export async function mount(container, context) {
  const { puter, signal } = context;
  const store = integrationStore(puter);
  const available = netAvailable(puter);
  const sections = new Map();
  const root = el('div.settings-stack.int-settings', {},
    el('p.pref-hint', {}, t('integrations.settingsIntro')),
    available ? null : el('p.int-note', { role: 'status' }, icon('warning', 16), t('integrations.unavailable')));
  for (const service of SERVICES) {
    const section = serviceSection(service, { store, puter, context, available, signal });
    sections.set(service.id, section);
    root.append(section.node);
  }
  container.replaceChildren(root);
  const off = store.subscribe((state) => { for (const [id, section] of sections) section.update(state?.[id] ?? null); });
  signal?.addEventListener('abort', off, { once: true });
  try {
    const state = await store.load({ fresh: true });
    if (!signal?.aborted) for (const [id, section] of sections) section.update(state[id]);
  } catch (error) {
    if (!signal?.aborted) for (const section of sections.values()) section.failed(error);
  }
  return off;
}

function serviceSection(service, { store, puter, context, available, signal }) {
  const name = serviceName(service.id);
  let config = null;
  const status = el('p.int-status', { role: 'status' });
  const url = field({ label: t('integrations.url'), type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: false, placeholder: t(`integrations.${service.id}.urlPlaceholder`) });
  const key = field({ label: t('integrations.key'), type: 'password', autocomplete: 'off', spellcheck: false, hint: t(`integrations.${service.id}.keyHint`) });
  const insecure = el('p.int-note.int-warn', { hidden: true }, icon('insecure', 16), t('integrations.insecure'));
  const save = button(t('integrations.save'), { type: 'submit', variant: 'primary', disabled: !available });
  const test = button(t('integrations.test'), { variant: 'outline', hidden: true, disabled: !available, onclick: () => void check() });
  const remove = button(t('integrations.remove'), { variant: 'ghost', hidden: true, onclick: () => void disconnect() });
  const extras = el('div.int-extras');
  let flagControl = null;
  if (service.flag) {
    const id = uid('int-flag');
    const hintId = `${id}-hint`;
    flagControl = el('button.switch', { id, type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': `${id}-label`, 'aria-describedby': hintId, disabled: true,
      onclick: () => void toggleFlag() }, el('span.switch-thumb'));
    extras.append(el('div.pref-row', {}, el('div.pref-text', {}, el('span.pref-label', { id: `${id}-label` }, t(service.flag.label)), el('span.pref-hint', { id: hintId }, t(service.flag.hint))), flagControl));
  }
  const form = el('form.int-form', { noValidate: true, onsubmit: (event) => { event.preventDefault(); void connect(); } },
    url.element, key.element, insecure, el('div.settings-actions', {}, save, test, remove));
  url.input.addEventListener('input', () => { insecure.hidden = !isPlainHttp(normalizeServerUrl(url.input.value)); url.setError(''); });
  const node = group(name, el('p.pref-hint', {}, t(`integrations.${service.id}.about`)), status, form, extras);
  node.classList.add('int-service');
  node.dataset.service = service.id;

  function showStatus(kind, text) {
    status.dataset.state = kind;
    status.replaceChildren(icon(kind === 'ok' ? 'connected' : kind === 'error' ? 'warning' : 'server', 16), el('span', {}, text));
  }
  function update(next) {
    const changed = JSON.stringify(next) !== JSON.stringify(config) || !status.dataset.state;
    config = next;
    remove.hidden = !config; test.hidden = !config;
    key.input.placeholder = config ? t('integrations.keySaved') : '';
    if (config && document.activeElement !== url.input) url.input.value = config.url;
    insecure.hidden = !isPlainHttp(config?.url ?? normalizeServerUrl(url.input.value));
    if (flagControl) {
      flagControl.disabled = !config;
      flagControl.setAttribute('aria-checked', String(Boolean(config && (config[service.flag.name] ?? service.flag.initial))));
    }
    for (const control of extras.querySelectorAll('[data-action]')) control.hidden = !config;
    if (changed && (status.dataset.state !== 'ok' || !config)) showStatus(config ? 'saved' : 'off', config ? t('integrations.statusSaved', { url: config.url }) : t('integrations.statusOff'));
  }
  function failed(error) { showStatus('error', errorText(error, service.id)); }

  async function verify(candidate) {
    const result = await service.verify(service.client(puter, candidate));
    const who = service.who(result);
    showStatus('ok', who ? t('integrations.statusConnectedAs', { who }) : t('integrations.statusConnected'));
    return result;
  }
  async function connect() {
    url.setError(''); key.setError('');
    const base = normalizeServerUrl(url.input.value);
    if (!base) { url.setError(t('integrations.urlInvalid')); url.input.focus(); return; }
    const typed = key.input.value.trim();
    const secret = typed || (config && config.url === base ? config.key : '');
    if (!secret) { key.setError(t('integrations.keyRequired')); key.input.focus(); return; }
    const candidate = { url: base, key: secret, ...(service.flag ? { [service.flag.name]: config?.[service.flag.name] ?? service.flag.initial } : {}) };
    save.setAttribute('aria-busy', 'true');
    try {
      await verify(candidate);
      if (signal?.aborted) return;
      await store.save(service.id, candidate);
      key.input.value = '';
      toast(t('integrations.saved', { service: serviceName(service.id) }));
    } catch (error) { if (!signal?.aborted) failed(error); }
    finally { save.setAttribute('aria-busy', 'false'); }
  }
  async function check() {
    if (!config) return;
    test.setAttribute('aria-busy', 'true');
    try { await verify(config); } catch (error) { if (!signal?.aborted) failed(error); } finally { test.setAttribute('aria-busy', 'false'); }
  }
  async function toggleFlag() {
    if (!config) return;
    const next = !(config[service.flag.name] ?? service.flag.initial);
    flagControl.setAttribute('aria-busy', 'true');
    try { await store.setFlags(service.id, { [service.flag.name]: next }); } catch (error) { failed(error); } finally { flagControl.setAttribute('aria-busy', 'false'); }
  }
  async function disconnect() {
    const ok = await confirmDialog({ title: t('integrations.removeTitle', { service: name }), body: t('integrations.removeBody', { service: name }), confirmLabel: t('integrations.remove'), danger: true });
    if (!ok) return;
    try {
      await store.remove(service.id);
      url.input.value = ''; key.input.value = '';
      showStatus('off', t('integrations.statusOff'));
      toast(t('integrations.removed', { service: name }));
    } catch (error) { failed(error); }
  }
  return { node, update, failed };
}
