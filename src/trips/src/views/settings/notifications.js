// Settings → Notifications: out-of-app channels (webhook, ntfy, email digests), what to send, per-trip choices and a
// test. Secrets are read and written straight to `me:notify:secret` and never cached on the device.
import './settings.css';
import { el, uid } from '../../ui/dom.js';
import { button, iconButton, skeleton } from '../../ui/bits.js';
import { field, segmented } from '../../ui/fields.js';
import { confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatInstant } from '../../lib/format.js';
import { browserTimeZone } from '../../shared/dates.js';
import { newId } from '../../shared/ids.js';
import {
  CATEGORIES, CHANNELS, LEAD_DAYS, LIMITS, WEBHOOK_FORMATS, DIGEST_EVERY, KEYS,
  backgroundAvailable, loadNotify, savePrefs, saveSecret, setNotifyOn, syncNotifyOut, requestTest,
  newSecret, newTopic, urlProblem, validTopic, validEmail,
} from '../../lib/notify-out/index.js';
import { icon } from './icons.js';
import { group, row, alertRegion, busy, errorText, plural } from './ui.js';

const CHANNEL_LABELS = { webhook: 'notifyOut.webhook', ntfy: 'notifyOut.ntfy', email: 'notifyOut.email' };
const FORMAT_LABELS = { json: 'notifyOut.formatJson', slack: 'notifyOut.formatSlack', discord: 'notifyOut.formatDiscord' };
const EVERY_LABELS = { hour: 'notifyOut.everyHour', day: 'notifyOut.everyDay' };
const MODE_LABELS = { all: 'notifyOut.modeAll', reminders: 'notifyOut.modeReminders', off: 'notifyOut.modeOff' };
const REASONS = { ended: 'notifyOut.tripEnded', noAccess: 'notifyOut.tripNoAccess', limit: 'notifyOut.tripNotWatched' };
const TEST_WAIT = 30_000;
const TEST_POLL = 2000;

const urlMessage = (code) => t(`notifyOut.err.${code}`);
const leadLabel = (days) => (days === 0 ? t('notifyOut.leadDay0') : days === 1 ? t('notifyOut.leadDay1') : t('notifyOut.leadDays', { count: days }));

function switchRow(label, hint, checked, onToggle) {
  const control = el('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(checked) }, el('span.switch-thumb'));
  const parts = row({ label, hint, control });
  control.setAttribute('aria-labelledby', parts.labelId);
  if (parts.hintId) control.setAttribute('aria-describedby', parts.hintId);
  control.addEventListener('click', async () => {
    const next = control.getAttribute('aria-checked') !== 'true';
    control.setAttribute('aria-busy', 'true');
    try { if (await onToggle(next) !== false) control.setAttribute('aria-checked', String(next)); }
    finally { control.setAttribute('aria-busy', 'false'); }
  });
  return { node: parts.node, set: (value) => control.setAttribute('aria-checked', String(value)) };
}

export async function mount(container, context) {
  const { puter, signal } = context;
  const session = context.session ?? null;
  const personal = session?.personal ?? context.personal ?? null;
  const account = context.account ?? session?.account ?? null;
  const origin = globalThis.location?.origin;
  const available = backgroundAvailable(puter);
  const alert = alertRegion();
  const stateLine = el('p.pref-hint', { role: 'status' });
  const allow = button(t('notifyOut.allow'), { size: 'sm', variant: 'outline', hidden: true, onclick: async () => {
    const result = await busy(allow, alert, () => setNotifyOn({ ...syncContext }, true));
    if (result) { sync = result; showState(result); drawTrips(); }
  } });
  const body = el('div.settings-stack', { 'aria-busy': 'true', 'aria-label': t('notifyOut.loading') }, skeleton(), skeleton('70%'), skeleton('50%'));
  container.replaceChildren(el('div.settings-stack', {}, el('p.pref-hint', {}, t('notifyOut.intro')), alert.node, body));

  let data;
  let entries = [];
  let sync = null;
  let syncTimer = null;
  let testTimer = null;
  const syncContext = { puter, personal, account, origin };

  function showState(result, error) {
    allow.hidden = !(available && data.prefs.on && personal && account && (error?.code === 'consent_denied' || result?.state === 'consent'));
    if (error) { stateLine.textContent = error.code === 'consent_denied' ? t('notifyOut.consentDenied') : t('notifyOut.syncFailed'); return; }
    if (!available) { stateLine.textContent = t('notifyOut.unavailable'); return; }
    if (!data.prefs.on || !result || result.state === 'off') { stateLine.textContent = ''; return; }
    if (result.state === 'consent') { stateLine.textContent = t('notifyOut.consentDenied'); return; }
    const trips = [...result.watched].filter((key) => key !== 'sched').length;
    stateLine.textContent = [trips ? plural(trips, 'notifyOut.watchingOne', 'notifyOut.watching') : t('notifyOut.watchingNone'),
      result.limit ? t('notifyOut.limitReached') : ''].filter(Boolean).join(' ');
  }
  async function resync() {
    syncTimer = null;
    if (!personal || !account || signal?.aborted) return;
    try { sync = await syncNotifyOut({ ...syncContext, force: true }); showState(sync); drawTrips(); }
    catch (error) { showState(null, error); }
  }
  const resyncSoon = () => { clearTimeout(syncTimer); syncTimer = setTimeout(resync, 1500); };

  async function load() {
    body.setAttribute('aria-busy', 'true');
    try {
      [data, entries] = await Promise.all([loadNotify(puter), personal ? personal.spaces.list() : []]);
      // Digests go only to the account's confirmed address (the handler checks it again before every send).
      const user = await puter.auth?.getUser?.().catch(() => null);
      if (validEmail(user?.email) && user.email_confirmed !== false) data.accountEmail = user.email;
      if (signal?.aborted) return;
      draw();
      if (available && data.prefs.on) void resync(); else showState(null);
    } catch (error) {
      if (signal?.aborted) return;
      body.replaceChildren(el('div.settings-error', {}, el('p', {}, `${t('notifyOut.loadFailed')} ${errorText(error)}`),
        button(t('notifyOut.retry'), { size: 'sm', variant: 'outline', onclick: load })));
    } finally { body.removeAttribute('aria-busy'); }
  }

  const prefPaths = (paths, remove = [], { resubscribe = false } = {}) => busy(null, alert, async () => {
    await savePrefs(puter, paths, remove);
    if (resubscribe) resyncSoon();
    return true;
  });

  // Master switch
  function masterGroup() {
    const control = switchRow(t('notifyOut.master'), t('notifyOut.masterHint'), data.prefs.on, async (on) => {
      alert.clear();
      try {
        const result = personal && account ? await setNotifyOn({ ...syncContext }, on) : (await savePrefs(puter, { on }), null);
        data.prefs.on = on; sync = result; showState(result); drawTrips();
        return true;
      } catch (error) {
        if (error?.code === 'consent_denied') showState(null, error); else alert.show(errorText(error));
        return false;
      }
    });
    return group(t('notifyOut.title'), control.node, stateLine, el('div.settings-actions', {}, allow));
  }

  function channelSwitch(name, labelKey) {
    return switchRow(t(labelKey), null, data.prefs.channels[name].on, async (on) => {
      if (on && name === 'webhook' && !data.secret.webhookSecret) {
        const saved = await busy(null, alert, () => saveSecret(puter, { webhookSecret: newSecret() }));
        if (!saved) return false;
        data.secret = saved; drawWebhookSecret();
      }
      const done = await prefPaths({ [`channels.${name}.on`]: on }, [], { resubscribe: true });
      if (done) data.prefs.channels[name].on = on;
      return Boolean(done);
    });
  }

  // Webhook
  const secretSlot = el('div');
  let secretShown = false;
  function drawWebhookSecret() {
    const value = data.secret.webhookSecret ?? '';
    const shown = el('code.vault-number', {}, secretShown ? value : '••••••••••••');
    const reveal = iconButton('eye', t('notifyOut.signingShow'), { 'aria-pressed': String(secretShown), disabled: !value, onclick: () => { secretShown = !secretShown; drawWebhookSecret(); reveal.focus(); } });
    reveal.replaceChildren(icon(secretShown ? 'eyeOff' : 'eye'));
    const copy = iconButton('copy', t('notifyOut.signingCopy'), { disabled: !value, onclick: async () => {
      try { await navigator.clipboard.writeText(value); toast(t('notifyOut.signingCopied')); } catch { /* clipboard refused */ }
    } });
    copy.replaceChildren(icon('copy'));
    const renew = button(t('notifyOut.signingNew'), { size: 'sm', variant: 'outline', onclick: async () => {
      if (!await confirmDialog({ title: t('notifyOut.signingNewTitle'), body: t('notifyOut.signingNewBody'), confirmLabel: t('notifyOut.signingNew') })) return;
      const saved = await busy(renew, alert, () => saveSecret(puter, { webhookSecret: newSecret() }));
      if (saved) { data.secret = saved; drawWebhookSecret(); }
    } });
    const parts = row({ label: t('notifyOut.signing'), hint: t('notifyOut.signingHint'), control: el('div.settings-actions', {}, shown, reveal, copy, renew), stacked: true });
    secretSlot.replaceChildren(parts.node);
  }
  function webhookGroup() {
    const url = field({ label: t('notifyOut.webhookUrl'), hint: t('notifyOut.webhookUrlHint'), type: 'url', value: data.secret.webhookUrl ?? '', autocomplete: 'off', spellcheck: false, inputMode: 'url' });
    const format = segmented({ label: t('notifyOut.format'), items: WEBHOOK_FORMATS.map((value) => ({ value, label: t(FORMAT_LABELS[value]) })), value: data.prefs.channels.webhook.format,
      onChange: (value) => { void prefPaths({ 'channels.webhook.format': value }).then((done) => { if (done) data.prefs.channels.webhook.format = value; }); } });
    const formatRow = row({ label: t('notifyOut.format'), control: format.element });
    format.element.setAttribute('aria-labelledby', formatRow.labelId);
    const save = button(t('notifyOut.save'), { type: 'submit', variant: 'primary', size: 'sm' });
    const form = el('form.pref-row.stacked', { noValidate: true, onsubmit: async (event) => {
      event.preventDefault();
      const value = url.input.value.trim();
      const problem = value ? urlProblem(value) : null;
      url.setError(problem ? urlMessage(problem) : '');
      if (problem) { url.input.focus(); return; }
      const saved = await busy(save, alert, () => saveSecret(puter, { webhookUrl: value || null, ...(data.secret.webhookSecret ? {} : { webhookSecret: newSecret() }) }));
      if (saved) { data.secret = saved; drawWebhookSecret(); toast(t('notifyOut.saved')); }
    } }, url.element, el('div.settings-actions', {}, save));
    drawWebhookSecret();
    return group(t('notifyOut.webhook'), channelSwitch('webhook', 'notifyOut.webhookOn').node, form, formatRow.node, secretSlot, statusRow('webhook'));
  }

  // ntfy
  function ntfyGroup() {
    const server = field({ label: t('notifyOut.ntfyServer'), type: 'url', value: data.prefs.channels.ntfy.server, autocomplete: 'off', spellcheck: false, inputMode: 'url' });
    const topic = field({ label: t('notifyOut.ntfyTopic'), hint: t('notifyOut.ntfyTopicHint'), value: data.secret.ntfyTopic ?? '', autocomplete: 'off', spellcheck: false, maxLength: LIMITS.topic });
    const token = field({ label: t('notifyOut.ntfyToken'), type: 'password', value: data.secret.ntfyToken ?? '', autocomplete: 'off', maxLength: LIMITS.token });
    const priorityId = uid('ntfy-priority');
    const priority = el('select.select.pref-select', { id: priorityId }, [1, 2, 3, 4, 5].map((level) => el('option', { value: String(level) }, t(`notifyOut.priority${level}`))));
    priority.value = String(data.prefs.channels.ntfy.priority);
    const generate = button(t('notifyOut.ntfyGenerate'), { size: 'sm', variant: 'outline', onclick: () => { topic.input.value = newTopic(); topic.setError(''); } });
    const save = button(t('notifyOut.save'), { type: 'submit', variant: 'primary', size: 'sm' });
    const form = el('form.pref-row.stacked', { noValidate: true, onsubmit: async (event) => {
      event.preventDefault();
      const serverValue = server.input.value.trim().replace(/\/+$/, '');
      const serverProblem = urlProblem(serverValue);
      const topicValue = topic.input.value.trim();
      const tokenValue = token.input.value.trim();
      server.setError(serverProblem ? urlMessage(serverProblem) : '');
      topic.setError(topicValue && !validTopic(topicValue) ? t('notifyOut.err.topic') : '');
      token.setError(tokenValue && !/^[\x21-\x7e]+$/.test(tokenValue) ? t('notifyOut.err.token') : '');
      const invalid = [server, topic, token].find((entry) => entry.input.getAttribute('aria-invalid') === 'true');
      if (invalid) { invalid.input.focus(); return; }
      const done = await busy(save, alert, async () => {
        data.secret = await saveSecret(puter, { ntfyTopic: topicValue || null, ntfyToken: tokenValue || null });
        await savePrefs(puter, { 'channels.ntfy.server': serverValue, 'channels.ntfy.priority': Number(priority.value) });
        data.prefs.channels.ntfy.server = serverValue; data.prefs.channels.ntfy.priority = Number(priority.value);
        return true;
      });
      if (done) toast(t('notifyOut.saved'));
    } }, server.element, topic.element, el('div.settings-actions', {}, generate), token.element,
    el('div.field', {}, el('label.field-label', { htmlFor: priorityId }, t('notifyOut.priority')), priority), el('div.settings-actions', {}, save));
    return group(t('notifyOut.ntfy'), channelSwitch('ntfy', 'notifyOut.ntfyOn').node, form, statusRow('ntfy'));
  }

  // Email digests
  function emailGroup() {
    const address = field({ label: t('notifyOut.emailAddress'), type: 'email', value: data.secret.email ?? data.accountEmail ?? '', autocomplete: 'email', maxLength: LIMITS.email });
    const every = segmented({ label: t('notifyOut.every'), items: DIGEST_EVERY.map((value) => ({ value, label: t(EVERY_LABELS[value]) })), value: data.prefs.channels.email.every,
      onChange: (value) => { void prefPaths({ 'channels.email.every': value }).then((done) => { if (done) data.prefs.channels.email.every = value; }); } });
    const everyRow = row({ label: t('notifyOut.every'), control: every.element });
    every.element.setAttribute('aria-labelledby', everyRow.labelId);
    const save = button(t('notifyOut.save'), { type: 'submit', variant: 'primary', size: 'sm' });
    const form = el('form.pref-row.stacked', { noValidate: true, onsubmit: async (event) => {
      event.preventDefault();
      const value = address.input.value.trim();
      const problem = !value ? '' : !validEmail(value) ? 'notifyOut.err.email'
        : data.accountEmail && value.toLowerCase() !== data.accountEmail.toLowerCase() ? 'notifyOut.err.emailAccount' : '';
      address.setError(problem ? t(problem) : '');
      if (problem) { address.input.focus(); return; }
      const saved = await busy(save, alert, () => saveSecret(puter, { email: value || null }));
      if (saved) { data.secret = saved; toast(t('notifyOut.saved')); }
    } }, address.element, el('div.settings-actions', {}, save));
    return group(t('notifyOut.email'), el('p.pref-hint', {}, t('notifyOut.emailHint')), channelSwitch('email', 'notifyOut.emailOn').node, form, everyRow.node, statusRow('email'));
  }

  // What to send: one row per activity, one checkbox per channel.
  function eventsGroup() {
    const rows = CATEGORIES.map((category) => {
      const label = t(`notifyOut.cat.${category}`);
      const boxes = CHANNELS.filter((channel) => !(channel === 'email' && category === 'reminders')).map((channel) => {
        const input = el('input', { type: 'checkbox', checked: data.prefs.events[category].includes(channel), 'aria-label': t('notifyOut.cellLabel', { category: label, channel: t(CHANNEL_LABELS[channel]) }),
          onchange: async () => {
            const next = CHANNELS.filter((name) => (name === channel ? input.checked : data.prefs.events[category].includes(name)));
            const done = await prefPaths({ [`events.${category}`]: next }, [], { resubscribe: true });
            if (done) data.prefs.events[category] = next; else input.checked = !input.checked;
          } });
        return el('label.check-field', {}, input, el('span', { 'aria-hidden': 'true' }, t(CHANNEL_LABELS[channel])));
      });
      const parts = row({ label, control: el('div.settings-actions', { role: 'group' }, boxes) });
      parts.node.lastChild.setAttribute('aria-labelledby', parts.labelId);
      return parts.node;
    });
    return group(t('notifyOut.events'), el('p.pref-hint', {}, t('notifyOut.eventsHint')), ...rows);
  }

  function leadGroup() {
    const boxes = LEAD_DAYS.map((days) => {
      const input = el('input', { type: 'checkbox', checked: data.prefs.lead.includes(days), onchange: async () => {
        const next = LEAD_DAYS.filter((value) => (value === days ? input.checked : data.prefs.lead.includes(value)));
        const done = await prefPaths({ lead: next }, [], { resubscribe: true });
        if (done) data.prefs.lead = next; else input.checked = !input.checked;
      } });
      return el('label.check-field', {}, input, el('span', {}, leadLabel(days)));
    });
    const hintId = uid('lead-hint');
    return group(t('notifyOut.lead'), el('p.pref-hint', { id: hintId }, t('notifyOut.leadHint')), el('div.settings-actions', { role: 'group', 'aria-label': t('notifyOut.lead'), 'aria-describedby': hintId }, boxes));
  }

  // Trips
  const tripList = el('div');
  function drawTrips() {
    const trips = entries.filter((entry) => entry?.ref?.k === 'trip');
    if (!trips.length) { tripList.replaceChildren(el('p.pref-hint.list-empty', {}, t('notifyOut.tripsEmpty'))); return; }
    tripList.replaceChildren(el('div.card', {}, trips.map((entry) => {
      const id = entry.ref.s;
      const mode = data.prefs.trips[id] ?? 'all';
      const selectId = `notify-trip-${id}`;
      const name = entry.title || t('notifyOut.untitled');
      const select = el('select.select.pref-select', { id: selectId, 'aria-label': t('notifyOut.tripMode', { trip: name }), onchange: async () => {
        const value = select.value;
        const done = value === 'all' ? await prefPaths({}, [`trips.${id}`], { resubscribe: true }) : await prefPaths({ [`trips.${id}`]: value }, [], { resubscribe: true });
        if (done) { if (value === 'all') delete data.prefs.trips[id]; else data.prefs.trips[id] = value; drawTrips(); document.getElementById(selectId)?.focus(); }
        else select.value = mode;
      } }, ['all', 'reminders', 'off'].map((value) => el('option', { value }, t(MODE_LABELS[value]))));
      select.value = mode;
      const reason = sync?.reasons?.get(id);
      const status = !data.prefs.on || mode !== 'all' ? '' : sync?.watched?.has(id) ? t('notifyOut.tripWatched') : reason && REASONS[reason] ? t(REASONS[reason]) : sync ? t('notifyOut.tripNotWatched') : '';
      return el('div.list-row', { dataset: { id } }, el('span.row-text', {}, el('bdi.pref-label', {}, name), status && el('span.pref-hint', {}, status)), select);
    })));
  }
  function tripsGroup() {
    drawTrips();
    return group(t('notifyOut.trips'), el('p.pref-hint', {}, t('notifyOut.tripsHint', { count: LIMITS.trips })), tripList);
  }

  // Last delivery per channel, from the handler's `me:notify:status`.
  function statusText(name) {
    const entry = data.status?.[name];
    if (!entry || !Number.isFinite(entry.at)) return '';
    const time = formatInstant(entry.at, browserTimeZone());
    const known = { plan: 'notifyOut.errPlan', url: 'notifyOut.errUrl', gave_up: 'notifyOut.errGaveUp', unverified: 'notifyOut.errUnverified', limit: 'notifyOut.errLimit' };
    const detail = Object.hasOwn(known, entry.code ?? '') ? t(known[entry.code]) : String(entry.status ?? entry.code ?? '');
    const dropped = Number.isInteger(entry.dropped) && entry.dropped > 0 ? ` ${t('notifyOut.dropped', { count: entry.dropped })}` : '';
    return (entry.ok ? t('notifyOut.lastOk', { time }) : t('notifyOut.lastFailed', { time, detail })) + dropped;
  }
  function statusRow(name) { const text = statusText(name); return text ? el('p.pref-hint', {}, text) : null; }

  // Test
  function testGroup() {
    const results = el('div.pref-hint', { role: 'status' });
    const send = button(t('notifyOut.test'), { variant: 'outline', onclick: async () => {
      results.replaceChildren();
      if (!data.prefs.on || !CHANNELS.some((name) => data.prefs.channels[name].on)) { results.textContent = t('notifyOut.testNeedsChannel'); return; }
      const id = newId();
      const sent = await busy(send, alert, () => requestTest(puter, id));
      if (!sent) return;
      results.textContent = t('notifyOut.testSending');
      send.setAttribute('aria-busy', 'true');
      const started = Date.now();
      const poll = async () => {
        testTimer = null;
        if (signal?.aborted) return;
        let status = null;
        try { status = await puter.kv.get(KEYS.status); } catch { /* keep waiting */ }
        if (status?.test?.id === id) {
          send.setAttribute('aria-busy', 'false');
          data.status = status;
          results.replaceChildren(el('ul', {}, Object.entries(status.test.results ?? {}).map(([channel, verdict]) => el('li', {},
            t(verdict === 'ok' ? 'notifyOut.testOk' : verdict === 'retry' ? 'notifyOut.testQueued' : 'notifyOut.testFailed', { channel: t(CHANNEL_LABELS[channel] ?? channel) })))));
          return;
        }
        if (Date.now() - started >= TEST_WAIT) { send.setAttribute('aria-busy', 'false'); results.textContent = t('notifyOut.testNoAnswer'); return; }
        testTimer = setTimeout(poll, TEST_POLL);
      };
      testTimer = setTimeout(poll, TEST_POLL);
    } });
    return group(null, el('div.settings-actions', {}, send), results);
  }

  function draw() {
    body.replaceChildren(masterGroup(), webhookGroup(), ntfyGroup(), emailGroup(), eventsGroup(), leadGroup(), tripsGroup(), testGroup());
  }

  signal?.addEventListener('abort', () => { clearTimeout(syncTimer); clearTimeout(testTimer); secretShown = false; }, { once: true });
  await load();
  return () => { clearTimeout(syncTimer); clearTimeout(testTimer); };
}
