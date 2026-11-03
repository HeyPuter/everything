// "Send to AirTrail" inside the AirTrail review dialog: flights booked here go to AirTrail, and sent ones that were
// edited here go again. Each booking is marked as soon as its flights exist, and flight ids made for a booking that
// failed halfway are kept on this device, so trying again never creates the same flight twice.
import { el } from '../../../ui/dom.js';
import { button, chip } from '../../../ui/bits.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { airtrailClient, verifyAirtrail } from '../../../lib/integrations/airtrail.js';
import { MAX_PUSH, pushBooking, pushPlan } from '../../../lib/integrations/airtrail-push.js';
import { legDetails, legRoute, whenText } from '../../trip/bookings/display.js';
import { errorLine, errorText } from '../common.js';
import { icon } from '../icons.js';

const journalKey = (space) => `trips:airtrail:pushing:${space?.ref?.w ?? ''}:${space?.ref?.s ?? ''}`;
function readJournal(space) {
  try { const value = JSON.parse(localStorage.getItem(journalKey(space)) ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function writeJournal(space, value) {
  try { if (Object.keys(value).length) localStorage.setItem(journalKey(space), JSON.stringify(value)); else localStorage.removeItem(journalKey(space)); } catch { /* kept for this page only */ }
}
const count = (n, key) => t(n === 1 ? `${key}One` : key, { count: new Intl.NumberFormat().format(n) });

/** The section, or null when there is nothing to send. `config` is the user's AirTrail settings. */
export function pushSection({ space, puter, config }) {
  const plan = pushPlan(space.select.res.all());
  if (!plan.add.length && !plan.update.length && !plan.blocked.length) return null;
  const rows = [];
  const error = errorLine('airtrail');
  const status = el('p.int-muted', { role: 'status', 'aria-live': 'polite' });
  const send = button('', { variant: 'primary', onclick: () => void run() });
  const row = (entry, kind) => {
    const input = el('input', { type: 'checkbox', checked: kind === 'update', onchange: () => sync() });
    const leg = entry.res.legs[0];
    rows.push({ entry, input });
    return el('li.int-row', {}, el('label.int-row-main', {}, input, icon('plane', 16),
      el('span.int-row-text', {}, el('span.int-row-name', {}, entry.res.legs.map(legRoute).join(' · ')),
        el('span.int-row-meta', {}, [whenText(entry.res), ...legDetails(leg, 'flight')].filter(Boolean).join(' · '))),
      kind === 'update' ? chip(t('airtrailPush.changedChip'), { status: 'warn' }) : null));
  };
  const group = (label, entries, kind) => (entries.length ? el('section.int-group', {}, el('h4.int-group-title', {}, label), el('ul.int-rows', {}, entries.map((entry) => row(entry, kind)))) : null);
  const codes = plan.blocked.filter((item) => item.reason === 'codes').length;
  const element = el('section.int-group.int-push', {},
    el('h3.int-group-title', {}, t('airtrailPush.title')),
    el('p.int-muted', {}, t('airtrailPush.intro')),
    group(t('airtrailPush.new'), plan.add, 'add'),
    group(t('airtrailPush.changed'), plan.update, 'update'),
    codes || plan.blocked.length ? el('ul.int-notes', {},
      codes ? el('li', {}, count(codes, 'airtrailPush.blockedCodes')) : null,
      ...plan.blocked.filter((item) => item.reason === 'legs').map((item) => el('li', {}, t('airtrailPush.blockedLegs', { title: item.res.title })))) : null,
    status, error.node,
    plan.add.length || plan.update.length ? el('div.modal-actions', {}, send) : null);

  function selected() { return rows.filter((item) => item.input.checked).slice(0, MAX_PUSH); }
  function sync() {
    const n = selected().length;
    send.textContent = n ? count(n, 'airtrailPush.send') : t('airtrailPush.choose');
    send.disabled = !n;
  }

  async function run() {
    error.clear();
    const chosen = selected();
    if (!chosen.length) return;
    send.setAttribute('aria-busy', 'true');
    const client = airtrailClient(puter, config);
    const me = await verifyAirtrail(client).then((result) => result.user?.id ?? null, () => null);
    const journal = readJournal(space);
    let sent = 0;
    try {
      for (const { entry, input } of chosen) {
        status.textContent = t('airtrailPush.sending', { title: entry.res.title });
        const latest = space.get('res', entry.res.id);
        if (!latest) continue;
        const done = Array.isArray(journal[latest.id]) ? journal[latest.id] : [];
        try {
          const src = await pushBooking(client, { ...entry, res: latest }, { me, done });
          journal[latest.id] = done;
          await space.apply([space.ops.patch('res', latest.id, { set: { src } }, { base: true })], { history: t('airtrailPush.history') });
          delete journal[latest.id];
          sent += 1;
          input.checked = false; input.disabled = true;
        } catch (cause) {
          if (done.length) journal[latest.id] = done;
          writeJournal(space, journal);
          error.show(`${t('airtrailPush.failed', { title: latest.title })} ${errorText(cause, 'airtrail')}`, () => void run());
          return;
        }
        writeJournal(space, journal);
      }
      status.textContent = '';
      if (sent) toast(count(sent, 'airtrailPush.done'));
    } finally {
      send.setAttribute('aria-busy', 'false');
      sync();
    }
  }
  sync();
  return element;
}
