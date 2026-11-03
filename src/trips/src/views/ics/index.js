import './ics.css';
import { el, uid } from '../../ui/dom.js';
import { button, spinner } from '../../ui/bits.js';
import { checkbox } from '../../ui/fields.js';
import { icon } from '../../ui/icons.js';
import { confirmDialog, openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { saveBlob } from '../../lib/download.js';
import { canOpenInCalendar, openInCalendar } from './handoff.js';
import { errorMessage, exportCalendar, feedLinks, feedStore, fileName, isFeedPath } from './model.js';

export { registerCalendarCommand } from './command.js';

async function copy(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('ics.copied'));
  } catch {
    input.focus();
    input.select();
    toast(t('ics.copyManual'));
  }
}

function option(label, hint, { checked, onChange }) {
  const row = checkbox(label, { checked, onChange });
  const hintNode = el('span.field-hint', { id: uid('ics-hint') }, hint);
  row.querySelector('input').setAttribute('aria-describedby', hintNode.id);
  return el('div.ics-option', {}, row, hintNode);
}

function setStatus(node, message, error = false) {
  node.textContent = message;
  node.dataset.state = error ? 'error' : 'normal';
}

/**
 * Calendar export for one trip: a one-off .ics download, the desktop hand-off to Puter Calendar, and the member's
 * own subscription link (create, copy, rotate, turn off). `context` is the trip tab context. Resolves on close.
 */
export function openCalendarExport(context) {
  const { space, session } = context ?? {};
  const ref = context?.ref ?? space?.ref;
  if (!space?.get || !ref) return Promise.resolve('unavailable');
  const puter = context.puter ?? globalThis.puter;
  const member = context.account?.uuid ?? session?.account?.uuid ?? null;
  const api = session?.api;
  const store = feedStore(session?.db, ref);
  const options = { days: true, alarms: true };
  const feed = { loading: true, path: null, elsewhere: false, error: '', busy: false };
  const win = globalThis.window;
  const online = () => globalThis.navigator?.onLine !== false;
  let closed = false;

  const title = () => space.get('meta', 'meta')?.title ?? '';
  const build = () => exportCalendar(space, { member, ...options });

  const fileStatus = el('p.ics-status', { role: 'status' });
  const downloadButton = button(t('ics.download'), { variant: 'primary', icon: 'calendar', dataset: { ics: 'download' }, onclick: () => {
    try {
      saveBlob(new Blob([build()], { type: 'text/calendar;charset=utf-8' }), fileName(title()));
      setStatus(fileStatus, '');
      toast(t('ics.downloaded'));
    } catch { setStatus(fileStatus, t('ics.downloadFailed'), true); }
  } });
  const fileActions = el('div.ics-actions', {}, downloadButton);
  if (canOpenInCalendar(puter)) {
    const calendarButton = button(t('ics.openCalendar'), { variant: 'outline', dataset: { ics: 'calendar' }, onclick: async () => {
      calendarButton.setAttribute('aria-busy', 'true');
      try {
        await openInCalendar(puter, { name: fileName(title()), text: build() });
        setStatus(fileStatus, t('ics.opened'));
      } catch { setStatus(fileStatus, t('ics.openFailed'), true); }
      finally { calendarButton.setAttribute('aria-busy', 'false'); }
    } });
    fileActions.append(calendarButton);
  }

  const feedBody = el('div.ics-feed');
  const feedAlert = el('p.ics-alert', { role: 'alert', hidden: true });

  async function change(input, success) {
    if (feed.busy || !api || !ref) return;
    feed.busy = true;
    feed.error = '';
    renderFeed();
    try {
      const result = await api.call(ref, 'feed.set', input);
      if (input.revoke) {
        await store.clear();
        Object.assign(feed, { path: null, elsewhere: false });
      } else if (isFeedPath(result?.path)) {
        await store.set(result.path);
        Object.assign(feed, { path: result.path, elsewhere: false });
      } else if (result?.exists) feed.elsewhere = true;
      if (success && !closed) toast(success);
    } catch (error) { feed.error = errorMessage(error); }
    finally {
      feed.busy = false;
      if (!closed) renderFeed();
    }
  }
  async function rotate() {
    if (await confirmDialog({ title: t('ics.rotateTitle'), body: t('ics.rotateBody'), confirmLabel: t('ics.rotate') })) await change({ rotate: true }, t('ics.rotated'));
  }
  async function revoke() {
    if (await confirmDialog({ title: t('ics.revokeTitle'), body: t('ics.revokeBody'), confirmLabel: t('ics.revoke'), danger: true })) await change({ revoke: true }, t('ics.revoked'));
  }

  function renderFeed() {
    const focused = feedBody.contains(document.activeElement) ? document.activeElement.dataset?.ics : null;
    const offline = !online();
    const locked = offline || feed.busy;
    const manage = () => el('div.ics-actions.ics-manage', {},
      button(t('ics.rotate'), { size: 'sm', variant: 'ghost', disabled: locked, dataset: { ics: 'rotate' }, onclick: () => rotate() }),
      button(t('ics.revoke'), { size: 'sm', variant: 'ghost', disabled: locked, dataset: { ics: 'revoke' }, onclick: () => revoke() }));
    const nodes = [];
    if (feed.loading) nodes.push(el('div.ics-loading', {}, spinner()));
    else if (feed.path) {
      const links = feedLinks(ref.w, feed.path, options);
      const id = uid('ics-url');
      const input = el('input.input.ics-feed-url', { id, readOnly: true, value: links.https, spellcheck: false, dataset: { ics: 'url' }, onfocus: (event) => event.target.select() });
      nodes.push(
        el('div.field', {}, el('label.field-label', { htmlFor: id }, t('ics.feedLabel')), input),
        el('div.ics-actions', {},
          button(t('ics.copy'), { variant: 'primary', icon: 'copy', dataset: { ics: 'copy' }, onclick: () => copy(links.https, input) }),
          el('a.btn.btn-outline', { href: links.webcal, dataset: { ics: 'webcal' } }, icon('calendar'), t('ics.subscribe')),
          el('a.btn.btn-outline', { href: links.google, target: '_blank', rel: 'noopener noreferrer', dataset: { ics: 'google' } }, t('ics.google'))),
        manage());
    } else if (feed.elsewhere) {
      nodes.push(el('p.ics-note', {}, t('ics.feedElsewhere')), el('div.ics-actions', {},
        button(t('ics.feedNew'), { variant: 'primary', busy: feed.busy, disabled: offline, dataset: { ics: 'renew' }, onclick: () => change({ rotate: true }, t('ics.rotated')) }),
        button(t('ics.revoke'), { variant: 'ghost', disabled: locked, dataset: { ics: 'revoke' }, onclick: () => revoke() })));
    } else {
      nodes.push(el('div.ics-actions', {}, button(t('ics.feedCreate'), {
        variant: 'primary', icon: 'plus', busy: feed.busy, disabled: offline || !api, dataset: { ics: 'create' }, onclick: () => change({}),
      })));
    }
    if (offline && !feed.loading) nodes.push(el('p.ics-note', {}, t('ics.offline')));
    feedBody.replaceChildren(...nodes);
    feedAlert.textContent = feed.error;
    feedAlert.hidden = !feed.error;
    if (focused) (feedBody.querySelector(`[data-ics="${focused}"]:not(:disabled)`) ?? feedBody.querySelector('button:not(:disabled), a[href], input'))?.focus();
  }

  const fileHeading = uid('ics-file');
  const feedHeading = uid('ics-feed');
  const content = el('div.ics-dialog', {},
    el('fieldset.ics-options', {}, el('legend.field-label', {}, t('ics.include')),
      option(t('ics.days'), t('ics.daysHint'), { checked: options.days, onChange: (value) => { options.days = value; renderFeed(); } }),
      option(t('ics.alarms'), t('ics.alarmsHint'), { checked: options.alarms, onChange: (value) => { options.alarms = value; renderFeed(); } })),
    el('section.ics-section', { 'aria-labelledby': fileHeading },
      el('h3', { id: fileHeading }, t('ics.fileHeading')), el('p.ics-note', {}, t('ics.fileBody')), fileActions, fileStatus),
    el('section.ics-section', { 'aria-labelledby': feedHeading },
      el('h3', { id: feedHeading }, t('ics.feedHeading')), el('p.ics-note', {}, t('ics.feedBody')), feedBody, feedAlert,
      el('p.field-hint', {}, t('ics.feedHint'))));

  const connectivity = () => { if (!closed) renderFeed(); };
  const onAbort = () => dialog.close('leave');
  const dialog = openModal({
    title: t('ics.title'), content, initialFocus: downloadButton,
    actions: [button(t('ics.done'), { onclick: () => dialog.close('done') })],
    onClose: () => {
      closed = true;
      win?.removeEventListener('online', connectivity);
      win?.removeEventListener('offline', connectivity);
      context.signal?.removeEventListener?.('abort', onAbort);
    },
  });
  win?.addEventListener('online', connectivity);
  win?.addEventListener('offline', connectivity);
  context.signal?.addEventListener?.('abort', onAbort, { once: true });
  renderFeed();
  void store.get().then((path) => {
    feed.loading = false;
    feed.path = path;
    if (!closed) renderFeed();
  });
  return dialog.closed;
}
