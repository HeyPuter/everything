import './move.css';
import { el, uid, append, clear } from '../../../../ui/dom.js';
import { button, spinner } from '../../../../ui/bits.js';
import { checkbox } from '../../../../ui/fields.js';
import { openModal } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatDate } from '../../../../lib/format.js';
import { openSpace, registerDomainAdapter } from '../../../../lib/store/index.js';
import { fileBlob, hasFileLink, trashFile, uploadFile } from '../../../../lib/files/index.js';
import { linkedExpenses } from '../../../../lib/res/index.js';
import { newId } from '../../../../shared/ids.js';
import { isCurrency } from '../../../../shared/money.js';
import moveToTrip from '../../../../../worker/ops/trip/domain/res.moveToTrip.js';
import { icon } from '../icons.js';
import { bookingDates, newTripDates, planMove } from './plan.js';
import { createTrip } from '../../settings/actions.js';
import { moveEntry, moveJournal, runMove, undoMove } from './run.js';

// The worker's plan runs on the local replica when the op is queued through a space.
registerDomainAdapter('res.moveToTrip', (args, { get }) => moveToTrip.plan({ args: { ...args, base: undefined }, get: (type, id) => get(type, id) ?? null, can: () => true }));

const NEW = 'new';
const sameRef = (a, b) => a?.w === b?.w && a?.s === b?.s;
const tripTitle = (entry) => entry?.title || t('resMove.untitled');
const plural = (count, key, values = {}) => t(count === 1 ? `${key}One` : `${key}Many`, { count, ...values });
const currencyOf = (space) => { const value = space.get('meta', 'meta')?.currency; return isCurrency(value) ? value : 'EUR'; };

async function absorb(space, response) {
  const ents = Array.isArray(response?.ents) ? response.ents : [];
  const del = (Array.isArray(response?.del) ? response.del : []).map((item) => ({ ...item, deleted: true, rev: response.rev }));
  if (!ents.length && !del.length) return;
  try { await space.store.merge(ents, del, { lenient: true }); } catch { void Promise.resolve(space.sync?.()).catch(() => {}); }
}

/** What a failed step means for the user, as a string key. */
function failureKey(error) {
  const reason = error?.reason ?? error?.code;
  if (error?.status === 402 || ['owner_credit', 'caller_credit', 'insufficient_funds'].includes(reason)) return 'resMove.errorCredit';
  if (error?.status === 403 || ['forbidden', 'not_member'].includes(reason)) return 'resMove.errorForbidden';
  if (reason === 'space_not_found' || error?.status === 404) return 'resMove.errorGone';
  if (reason === 'worker_outdated') return 'resMove.errorOutdated';
  if (reason === 'email_unverified') return 'resMove.errorEmail';
  if (error?.status === 0 || ['network', 'timeout', 'offline'].includes(reason) || globalThis.navigator?.onLine === false) return 'resMove.errorOffline';
  if (error?.status === 429) return 'resMove.errorBusy';
  return 'resMove.errorGeneric';
}

/**
 * Commits, file copies and checks for moves out of `space`. Target trips are opened on demand (without presence or
 * handle minting) and closed by `close()`.
 */
function createMoveDeps({ space, session, puter, personal }) {
  const journal = moveJournal(session.db, space.ref.s);
  const opened = new Map();
  async function entryFor(ref) {
    try { return (await personal?.spaces?.list())?.find((item) => sameRef(item.ref, ref)) ?? null; } catch { return null; }
  }
  async function targetSpace(ref, { fresh = false } = {}) {
    const known = opened.get(`${ref.w}/${ref.s}`);
    if (known) return known;
    const entry = await entryFor(ref);
    let own = null;
    try { own = (await session.deployer?.current?.())?.name ?? null; } catch { own = null; }
    const target = await openSpace({ ref, db: session.db, api: session.api, puter, personal, handles: entry?.handles ?? null, role: entry?.role ?? (ref.w === own ? 'owner' : null),
      ownWorker: own, view: 'bookings', autoStart: false, open: false });
    opened.set(`${ref.w}/${ref.s}`, target);
    if (fresh || !target.state.rev) await target.start();
    return target;
  }
  async function commit(ref, ops) {
    const response = await session.api.commit(ref, JSON.stringify({ op: 'commit', space: ref.s, ops }));
    if (!ops.every((op) => Number.isSafeInteger(response?.done?.[op.opId]))) throw Object.assign(new Error('invalid_commit_response'), { status: 502, code: 'invalid_commit_response' });
    const local = sameRef(ref, space.ref) ? space : opened.get(`${ref.w}/${ref.s}`);
    if (local) await absorb(local, response);
    return response;
  }
  async function copyFile(file, entry) {
    const target = await targetSpace(entry.to);
    const blob = await fileBlob(space, file.id, { download: true, api: session.api });
    const copy = new File([blob], file.name, { type: file.mime || blob.type || 'application/octet-stream' });
    return uploadFile(target, copy, { link: { t: 'res', id: entry.resId }, api: session.api, puter });
  }
  /** The mover's private expenses: copies go into the target trip's private items, the rest drop the link. */
  async function movePrivate(entry) {
    const mine = space.privateItems('exp');
    for (const item of entry.private ?? []) {
      try {
        if (item.fields) {
          await personal.privateItems(entry.to.s, 'exp').put(item.fields, item.id);
          await mine.remove(item.from);
        } else await mine.patch(item.from, { links: item.links.length ? item.links : undefined });
      } catch { /* left as it was; readers ignore links to missing bookings */ }
    }
  }
  async function placeInUse(entry, id) {
    const target = await targetSpace(entry.to, { fresh: true });
    await target.sync?.();
    return target.select.visit.all().some((visit) => visit.placeId === id) || target.select.res.all().some((res) => res.placeId === id && res.id !== entry.resId);
  }
  return {
    journal, commit, copyFile, targetSpace, movePrivate, placeInUse,
    trash: async (entry, id) => trashFile(await targetSpace(entry.to), id, { api: session.api }),
    async sourceHas(entry) {
      await space.sync?.();
      return Boolean(space.get('res', entry.sourceRes));
    },
    async close() {
      for (const target of opened.values()) {
        try { await target.flush(); } catch { /* queued link changes are sent the next time the trip opens */ }
        target.close();
      }
      opened.clear();
    },
  };
}

/** Creates a trip on the user's own worker for a booking; its days come with the copy commit. Retries reuse `sid`. */
async function createTripFor(res, { session, personal, title, currency, sid }) {
  const dates = newTripDates(res);
  const fields = { title, currency, ...(dates.length ? { start: dates[0], end: dates.at(-1) } : { dayCount: 1 }) };
  const owner = { ensureWorker: session.ensureWorker, deployer: session.deployer, api: session.api, personal: session.personal ?? personal };
  const ref = await createTrip(owner, fields, { space: sid, layout: false });
  return { ref, role: 'owner', title, newDays: dates.length ? dates : [null] };
}

function finishedToast(result, { navigate }) {
  const { entry } = result;
  const open = navigate ? { label: t('resMove.openTrip'), onClick: () => navigate(`#/t/${entry.to.w}/${entry.to.s}/bookings`) } : undefined;
  toast(t('resMove.moved', { title: entry.title, trip: entry.toTitle }), { action: open });
  if (entry.failedFiles?.length) toast(plural(entry.failedFiles.length, 'resMove.filesFailed'));
}

/**
 * Move a booking to another trip the user can edit, or to a new trip. Needs `res.edit` here and in the target. The
 * copy is created first; the booking is removed here only once the copy exists.
 */
export function openMoveDialog({ space, session, puter, personal, res, track, navigate, onChange }) {
  const deps = createMoveDeps({ space, session, puter, personal });
  const selectId = uid('move-trip');
  const select = el('select.select', { id: selectId, onchange: () => choose(select.value) });
  const titleId = uid('move-title');
  const titleInput = el('input.input', { id: titleId, value: res.title, maxLength: 500, autocomplete: 'off' });
  const titleField = el('div.field', { hidden: true }, el('label.field-label', { htmlFor: titleId }, t('resMove.newTripTitle')), titleInput,
    el('span.field-hint', {}, t('resMove.newTripHint')));
  const preview = el('div.move-preview', { 'aria-live': 'polite' });
  const status = el('div.move-status', { role: 'status', 'aria-live': 'polite' });
  const moveButton = button(t('resMove.confirm'), { variant: 'primary', disabled: true, onclick: () => void start() });
  const cancelButton = button(t('ui.cancel'), { onclick: () => dialog.close('cancel') });
  const actions = el('div.costs-actions.move-actions', {}, cancelButton, moveButton);
  let trips = [];
  let chosen = null;
  let target = null;
  let options = { copyFiles: true, moveExpenses: true };
  let entry = null;
  let running = false;
  let dismissed = false;
  // One id per dialog, so retrying a create whose answer was lost does not make a second trip.
  const newSid = newId();
  let request = 0;

  const content = el('div.move', {},
    el('p.field-hint', {}, t('resMove.intro', { title: res.title })),
    el('div.field', {}, el('label.field-label', { htmlFor: selectId }, t('resMove.target')), select),
    titleField, preview, status);
  const dialog = track(openModal({ title: t('resMove.title'), content, actions: [actions], wide: true, onClose: () => {
    dismissed = true;
    if (!running) void deps.close();
    onChange?.();
  } }));

  const privateExps = () => { try { return space.privateItems('exp').list(); } catch { return []; } };
  const sourceData = () => ({
    currency: currencyOf(space), files: space.select.file?.all() ?? [], exps: space.select.exp?.all() ?? [], privateExps: privateExps(), visits: space.select.visit?.all() ?? [],
    reservations: space.select.res?.all() ?? [], places: space.select.place?.all() ?? [], guests: space.select.guest?.all() ?? [], days: space.select.day?.all() ?? [],
    can: (action) => space.can(action),
  });
  const targetData = (opened, newDays) => ({
    currency: opened ? currencyOf(opened) : currencyOf(space),
    members: opened ? opened.select.member.all().map((member) => member.id) : [session.account?.uuid].filter(Boolean),
    guests: opened?.select.guest.all() ?? [], places: opened?.select.place.all() ?? [], days: opened?.select.day.all() ?? [],
    can: (action) => (opened ? opened.can(action) : true), newDays,
  });
  const nameOf = (who) => space.members().find((member) => member.uid === who)?.name ?? space.get('guest', who)?.name ?? t('resMove.someone');

  void (async () => {
    try { trips = ((await personal?.spaces?.list()) ?? []).filter((item) => item.ref?.k === 'trip' && !sameRef(item.ref, space.ref) && ['owner', 'editor'].includes(item.role)); } catch { trips = []; }
    trips.sort((a, b) => (b.opened ?? 0) - (a.opened ?? 0));
    append(clear(select), [el('option', { value: '' }, t('resMove.choose')),
      ...trips.map((item) => el('option', { value: `${item.ref.w}/${item.ref.s}` }, tripTitle(item))),
      session.deployer ? el('option', { value: NEW }, t('resMove.newTrip')) : null]);
    if (!trips.length) preview.replaceChildren(el('p.field-hint', {}, t('resMove.noTrips')));
  })();

  async function choose(value) {
    const run = ++request;
    chosen = value === NEW ? { kind: NEW } : trips.find((item) => `${item.ref.w}/${item.ref.s}` === value) ?? null;
    titleField.hidden = chosen?.kind !== NEW;
    target = null;
    moveButton.disabled = true;
    if (!chosen) { preview.replaceChildren(); return; }
    if (chosen.kind === NEW) { renderPreview(null); return; }
    preview.replaceChildren(el('p.move-loading', {}, spinner(), el('span', {}, t('resMove.loading', { trip: tripTitle(chosen) }))));
    try {
      const opened = await deps.targetSpace(chosen.ref, { fresh: true });
      if (run !== request) return;
      target = opened;
      renderPreview(opened);
    } catch (error) {
      if (run === request) preview.replaceChildren(el('p.move-error', { role: 'alert' }, t(failureKey(error))));
    }
  }

  function renderPreview(opened) {
    const trip = chosen.kind === NEW ? (titleInput.value.trim() || res.title) : tripTitle(chosen);
    const items = [];
    const note = (key, values) => items.push(el('li', {}, t(key, { trip, ...values })));
    if (opened && !opened.can('res.edit')) {
      preview.replaceChildren(el('p.move-error', { role: 'alert' }, t('resMove.cannotEdit', { trip })));
      return;
    }
    let plan;
    try { plan = planMove({ res, source: sourceData(), target: targetData(opened, chosen.kind === NEW ? newTripDates(res) : undefined), options: { copyFiles: true, moveExpenses: true } }); } catch (error) {
      preview.replaceChildren(el('p.move-error', { role: 'alert' }, t(error?.code === 'invalid_booking' ? 'resMove.errorInvalid' : 'resMove.errorGeneric')));
      return;
    }
    if (plan.dropped.length) note('resMove.dropped', { names: plan.dropped.map(nameOf).join(', ') });
    if (plan.place?.reused) note('resMove.placeReused', { place: plan.place.name });
    else if (plan.place) note('resMove.placeCopied', { place: plan.place.name });
    if (plan.notes.includes('place_skipped')) note('resMove.placeSkipped');
    const meta = opened?.get('meta', 'meta');
    const { start, end } = bookingDates(res);
    if (start && meta?.start && meta?.end && (start < meta.start || (end ?? start) > meta.end)) note('resMove.outsideDates', { start: formatDate(meta.start), end: formatDate(meta.end) });
    const attached = (space.select.file?.all() ?? []).filter((file) => file.kind === 'user' && !file.trashed && hasFileLink(file, { t: 'res', id: res.id }));
    const linked = linkedExpenses(space.select.exp?.all() ?? [], res.id);
    const controls = [];
    if (attached.length) {
      if (plan.files.length) controls.push(checkbox(plural(attached.length, 'resMove.copyFiles', { trip }), { checked: options.copyFiles, onChange: (value) => { options.copyFiles = value; } }));
      else note('resMove.filesStay');
      note('resMove.filesHint');
    }
    if (linked.length) {
      if (plan.expenses.length) {
        controls.push(checkbox(plural(plan.expenses.length, 'resMove.moveExpense', { trip }), { checked: options.moveExpenses, onChange: (value) => { options.moveExpenses = value; } }));
        if (plan.expenses.some((item) => item.fields.rate === null)) note('resMove.ratesPending');
      }
      const staying = linked.length - plan.expenses.length;
      if (staying) items.push(el('li', {}, plural(staying, space.can('costs.edit') && (!opened || opened.can('costs.edit')) ? 'resMove.expensesStay' : 'resMove.expensesStayPermission', { trip })));
    }
    append(clear(preview), [...controls, items.length ? el('ul.move-notes', {}, items) : null]);
    moveButton.disabled = false;
  }
  titleInput.addEventListener('input', () => { if (chosen?.kind === NEW) renderPreview(null); });

  function lock(on) {
    running = on;
    // A dialog closed while the move ran still owns the trips it opened.
    if (!on && dismissed) { void deps.close(); onChange?.(); }
    for (const node of [select, titleInput, ...preview.querySelectorAll('input')]) node.disabled = on;
    moveButton.setAttribute('aria-busy', String(on));
    moveButton.disabled = on;
  }

  function showStage(stage) {
    status.replaceChildren(spinner(), el('span', {}, t(`resMove.stage.${stage}`, { trip: entry?.toTitle ?? '' })));
  }

  async function start() {
    if (!chosen || running) return;
    if (globalThis.navigator?.onLine === false) { status.replaceChildren(el('p.move-error', { role: 'alert' }, t('resMove.errorOffline'))); return; }
    lock(true);
    try {
      // Edits still queued for this booking would land after the delete; send them first.
      await space.flush();
      if (space.overlay('res', res.id)?.pending) throw Object.assign(new Error('pending'), { code: 'pending' });
      const latest = space.get('res', res.id);
      if (!latest) throw Object.assign(new Error('gone'), { code: 'gone', status: 409 });
      let opened = target;
      let newDays;
      let toRef = chosen.ref;
      let toTitle = tripTitle(chosen);
      if (chosen.kind === NEW) {
        showStage('create');
        const title = titleInput.value.trim() || res.title;
        const created = await createTripFor(latest, { session, personal, title, currency: currencyOf(space), sid: newSid });
        toRef = created.ref; toTitle = title;
        opened = await deps.targetSpace(created.ref, { fresh: true });
        if (!opened.select.day.all().length) newDays = created.newDays;
      }
      const plan = planMove({ res: latest, base: space.store?.serverVersion?.('res', latest.id) ?? latest.v, source: sourceData(), target: targetData(opened, newDays), options });
      entry = moveEntry({ plan, from: space.ref, fromTitle: space.get('meta', 'meta')?.title ?? '', to: toRef, toTitle, title: latest.title });
      await deps.journal.put(entry);
      await finish();
    } catch (error) {
      lock(false);
      const key = error?.code === 'pending' ? 'resMove.errorPending' : error?.code === 'gone' ? 'resMove.errorBookingGone'
        : error?.code === 'invalid_booking' ? 'resMove.errorInvalid' : failureKey(error);
      status.replaceChildren(el('p.move-error', { role: 'alert' }, t(key)));
    }
  }

  async function finish() {
    lock(true);
    try {
      const result = await runMove(entry, { journal: deps.journal, commit: deps.commit, copyFile: deps.copyFile, movePrivate: deps.movePrivate, onStage: showStage });
      running = false;
      await deps.close();
      dialog.close('moved');
      finishedToast(result, { navigate });
    } catch (error) {
      lock(false);
      showFailure(error);
    }
  }

  function showFailure(error) {
    const code = error?.code;
    if (code === 'target_failed') { status.replaceChildren(el('p.move-error', { role: 'alert' }, t('resMove.targetFailed', { reason: t(failureKey(error.cause)) }))); entry = null; return; }
    const message = code === 'target_pending' ? t('resMove.targetPending', { trip: entry.toTitle, reason: t(failureKey(error.cause)) })
      : code === 'copy_gone' ? t('resMove.copyGone', { trip: entry.toTitle })
        : code === 'busy' ? t('resMove.busy')
          : t('resMove.sourcePending', { trip: entry.toTitle, reason: t(failureKey(error.cause)) });
    status.replaceChildren(el('p.move-error', { role: 'alert' }, message));
    select.disabled = true;
    const once = (action) => () => { if (!running) void action(); };
    actions.replaceChildren(
      button(code === 'target_pending' ? t('resMove.cancelMove') : t('resMove.undo'), { onclick: once(undo) }),
      code === 'copy_gone' ? null : button(t('resMove.keepBoth'), { onclick: once(keepBoth) }),
      code === 'copy_gone' ? button(t('ui.close'), { variant: 'primary', onclick: once(keepBoth) }) : button(t('resMove.retry'), { variant: 'primary', onclick: once(finish) }));
  }

  async function undo() {
    lock(true);
    showStage('undo');
    try {
      const result = await undoMove(entry, { journal: deps.journal, commit: deps.commit, trash: (id) => deps.trash(entry, id), sourceHas: () => deps.sourceHas(entry),
        placeInUse: (id) => deps.placeInUse(entry, id) });
      running = false;
      await deps.close();
      dialog.close('undone');
      toast(result.status === 'finished' ? t('resMove.alreadyMoved', { title: entry.title, trip: entry.toTitle }) : t('resMove.undone', { title: entry.title }));
    } catch (error) {
      lock(false);
      status.replaceChildren(el('p.move-error', { role: 'alert' }, t('resMove.undoFailed', { reason: t(failureKey(error.cause ?? error)) })));
    }
  }

  async function keepBoth() {
    try { await deps.journal.remove(entry.id); } catch { /* the notice offers it again */ }
    running = false;
    await deps.close();
    dialog.close('kept');
  }

  return dialog;
}

/**
 * Notices for moves out of this trip that did not finish (another tab, a lost connection, a closed app), with
 * finish, undo and keep-both actions. Unfinished moves are retried once when the tab opens online.
 */
export function moveNotices({ space, session, puter, personal, navigate }) {
  const element = el('div.bookings-notes.move-notices', { hidden: true });
  if (!session?.db || !session?.api) return { element, refresh: () => {}, destroy: () => {} };
  const journal = moveJournal(session.db, space.ref.s);
  const busy = new Set();
  let destroyed = false;
  let entries = [];

  async function refresh() {
    try { entries = await journal.list(); } catch { entries = []; }
    if (!destroyed) render();
  }

  async function act(entry, action) {
    if (busy.has(entry.id)) return;
    busy.add(entry.id);
    render();
    const deps = createMoveDeps({ space, session, puter, personal });
    try {
      if (action === 'finish' || action === 'auto') finishedToast(await runMove(entry, { journal, commit: deps.commit, copyFile: deps.copyFile, movePrivate: deps.movePrivate }), { navigate });
      else if (action === 'undo') {
        const result = await undoMove(entry, { journal, commit: deps.commit, trash: (id) => deps.trash(entry, id), sourceHas: () => deps.sourceHas(entry),
          placeInUse: (id) => deps.placeInUse(entry, id) });
        toast(result.status === 'finished' ? t('resMove.alreadyMoved', { title: entry.title, trip: entry.toTitle }) : t('resMove.undone', { title: entry.title }));
      } else await journal.remove(entry.id);
      return true;
    } catch (error) {
      if (action !== 'auto' || error?.code === 'target_failed') toast(error?.code === 'target_failed' ? t('resMove.targetFailed', { reason: t(failureKey(error.cause)) }) : t('resMove.stillUnfinished', { reason: t(failureKey(error.cause ?? error)) }));
      return false;
    } finally {
      await deps.close();
      busy.delete(entry.id);
      await refresh();
    }
  }

  function render() {
    element.replaceChildren(...entries.map((entry) => {
      const working = busy.has(entry.id);
      const text = entry.stage === 'target' ? t('resMove.noticeTarget', { title: entry.title, trip: entry.toTitle }) : t('resMove.noticeSource', { title: entry.title, trip: entry.toTitle });
      return el('div.bookings-note.warn.move-notice', { role: 'status', dataset: { move: entry.id } }, icon('alert', 16), el('span', {}, text),
        el('div.move-notice-actions', {},
          button(t('resMove.retry'), { size: 'sm', variant: 'outline', disabled: working, onclick: () => void act(entry, 'finish') }),
          button(entry.stage === 'target' ? t('resMove.cancelMove') : t('resMove.undo'), { size: 'sm', variant: 'ghost', disabled: working, onclick: () => void act(entry, 'undo') }),
          button(t('resMove.keepBoth'), { size: 'sm', variant: 'ghost', disabled: working, onclick: () => void act(entry, 'keep') })));
    }));
    element.hidden = !entries.length;
  }

  void (async () => {
    await refresh();
    if (globalThis.navigator?.onLine === false) return;
    // Entries changed in the last minute are probably still running in a dialog.
    for (const entry of entries.filter((item) => Date.now() - (item.at ?? 0) > 60_000)) {
      if (destroyed) return;
      await act({ ...entry }, 'auto');
    }
  })();
  return { element, refresh, destroy: () => { destroyed = true; } };
}
