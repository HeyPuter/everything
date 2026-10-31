// Dialogs: the owner's offer, the new owner's review and the move's progress (with resume and stop).
import { el, uid as uniqueId, append, clear } from '../../../ui/dom.js';
import { button, spinner } from '../../../ui/bits.js';
import { checkbox } from '../../../ui/fields.js';
import { confirmDialog, openModal } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { routeHash } from '../../../lib/router.js';
import { STEPS, cancelTransfer, candidates, transferEntry, transferJournal } from '../../../lib/transfer/index.js';
import { ensureShareConsent } from '../../../lib/deploy.js';
import { callFor, jobFor, onJob, runnerDeps, startJob } from './deps.js';
import { icon } from './icons.js';
import { reasonText, viewState } from './logic.js';

const roleText = (role) => t(role === 'viewer' ? 'transfer.roleViewer' : 'transfer.roleEditor');

function errorLine() {
  const node = el('p.transfer-error', { role: 'alert', hidden: true });
  return { node, show(error) { node.textContent = t('transfer.failed', { reason: reasonText(error) }); node.hidden = false; }, hide() { node.hidden = true; } };
}

function howList(name) {
  return el('ul.transfer-how', {},
    el('li', {}, t('transfer.howAccept', { name })), el('li', {}, t('transfer.howFrozen')),
    el('li', {}, t('transfer.howMembers')), el('li', {}, t('transfer.howStub')));
}

/** The owner picks a member and offers them the trip. */
export function openOfferDialog(context) {
  const { space, session, account } = context;
  const people = candidates(space.members(), account.uuid);
  let chosen = people[0]?.uid ?? null;
  const error = errorLine();
  const name = () => people.find((person) => person.uid === chosen)?.name ?? '';
  const how = el('div.transfer-how-host');
  const offerButton = button('', { variant: 'primary', disabled: !chosen });
  const sync = () => {
    offerButton.textContent = chosen ? t('transfer.offer', { name: name() }) : t('transfer.title');
    how.replaceChildren(el('h3.transfer-subhead', {}, t('transfer.howTitle')), howList(name() || t('transfer.someone')));
  };
  const group = uniqueId('transfer-pick');
  const pick = people.length
    ? el('fieldset.transfer-pick', {}, el('legend.field-label', {}, t('transfer.pick')), people.map((person) => el('label.transfer-option', {},
      el('input', { type: 'radio', name: group, value: person.uid, checked: person.uid === chosen, onchange: () => { chosen = person.uid; error.hide(); sync(); } }),
      el('span.transfer-option-name', {}, person.name), el('span.chip', {}, roleText(person.role)))))
    : el('p.transfer-note', {}, t('transfer.noCandidates'));
  const dialog = openModal({
    title: t('transfer.title'),
    content: el('div.transfer', {}, el('p.transfer-lead', {}, t('transfer.sectionHint')), pick, how, error.node),
    actions: [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), offerButton],
  });
  offerButton.addEventListener('click', async () => {
    if (!chosen) return;
    offerButton.setAttribute('aria-busy', 'true'); offerButton.disabled = true;
    try {
      await session.api.call(space.ref, 'transfer.offer', { to: chosen });
      toast(t('transfer.offered', { name: name() }));
      void space.sync?.().catch(() => {});
      dialog.close('done');
    } catch (failure) {
      error.show(failure);
      offerButton.disabled = false;
    } finally { offerButton.removeAttribute('aria-busy'); }
  });
  sync();
  return dialog;
}

/** Withdraws (owner) or declines (offered member) an offer, or stops a move the owner started. */
export async function cancelOffer(context, { confirm = null } = {}) {
  if (confirm && !(await confirmDialog({ title: confirm.title, body: confirm.body, confirmLabel: confirm.label, danger: true }))) return false;
  try {
    await context.session.api.call(context.space.ref, 'transfer.cancel');
    void context.space.sync?.().catch(() => {});
    return true;
  } catch (error) {
    toast(t('transfer.failed', { reason: reasonText(error) }));
    return false;
  }
}

/** The offered member reviews what taking over means, picks who comes along and starts the move. */
export function openAcceptDialog(context) {
  const { space, account } = context;
  const state = viewState(space, account.uuid);
  const others = space.members().filter((member) => member.uid !== account.uuid && member.role);
  const picked = new Set(others.map((member) => member.uid));
  const error = errorLine();
  const people = others.length ? el('fieldset.transfer-bring', {}, el('legend.field-label', {}, t('transfer.bring')),
    el('p.transfer-note', {}, t('transfer.bringHint')),
    others.map((member) => checkbox(member.role === 'owner' ? t('transfer.formerOwner', { name: member.name }) : `${member.name} · ${roleText(member.role)}`, {
      checked: true, onChange: (checked) => { if (checked) picked.add(member.uid); else picked.delete(member.uid); },
    }))) : null;
  const acceptButton = button(t('transfer.accept'), { variant: 'primary' });
  const declineButton = button(t('transfer.decline'), { variant: 'ghost' });
  const dialog = openModal({
    title: t('transfer.acceptTitle'),
    content: el('div.transfer', {},
      el('p.transfer-lead', {}, t('transfer.offerForYou', { owner: state.owner || t('transfer.someone') })),
      el('ul.transfer-how', {}, el('li', {}, t('transfer.acceptCost')), el('li', {}, t('transfer.acceptFrozen')), el('li', {}, t('transfer.acceptWorker')), el('li', {}, t('transfer.howStub'))),
      people, error.node),
    actions: [declineButton, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), acceptButton],
  });
  declineButton.addEventListener('click', async () => {
    if (await cancelOffer(context)) { toast(t('transfer.declined')); dialog.close('declined'); }
  });
  acceptButton.addEventListener('click', () => {
    const meta = space.get('meta', 'meta');
    const entry = transferEntry({ from: space.ref, title: meta?.title ?? '', chosen: others.filter((member) => picked.has(member.uid)).map((member) => member.uid) });
    // Members who come along rejoin through this account's worker, which needs the kvShare consent to give them handles.
    if (picked.size && context.session?.db && context.account?.uuid) void ensureShareConsent({ puter: context.puter ?? globalThis.puter, db: context.session.db, uid: context.account.uuid }).catch(() => {});
    startJob(context, entry);
    dialog.close('accepted');
    openProgressDialog(context);
  });
  return dialog;
}

function stepStatus(entry, step) {
  const at = STEPS.indexOf(entry?.step ?? 'deploy');
  const index = STEPS.indexOf(step);
  return index < at ? 'done' : index === at ? 'now' : 'wait';
}

function stepDetail(entry, step) {
  if (step === 'import') {
    const count = Object.keys(entry?.imported ?? {}).length;
    return count ? t('transfer.itemsCount', { count: new Intl.NumberFormat().format(count) }) : '';
  }
  if (step === 'files' && entry?.fileTotal) {
    const done = Object.keys(entry.files ?? {}).length;
    return t('transfer.filesCount', { done: new Intl.NumberFormat().format(done), total: new Intl.NumberFormat().format(entry.fileTotal) });
  }
  return '';
}

/** The step list with the job's state; `handlers`: `{resume, stop, open}`. */
export function progressView(job, handlers) {
  const entry = job?.entry;
  const status = job?.status ?? 'idle';
  const steps = el('ol.transfer-steps', {}, STEPS.filter((step) => step !== 'done').map((step) => {
    const state = status === 'done' ? 'done' : stepStatus(entry, step);
    const detail = stepDetail(entry, step);
    return el('li.transfer-step', { dataset: { state } },
      el('span.transfer-step-icon', {}, state === 'done' ? icon('done', 18) : state === 'now' && status === 'running' ? spinner() : icon(state === 'now' ? 'alert' : 'wait', 18)),
      el('span.transfer-step-text', {}, t(`transfer.step.${step}`), detail && el('span.transfer-step-detail', {}, detail)),
      el('span.sr-only', {}, t(state === 'done' ? 'transfer.stepDone' : state === 'now' ? 'transfer.stepNow' : 'transfer.stepWaiting')));
  }));
  const footer = el('div.transfer-footer');
  const line = el('p.transfer-status', { role: 'status' });
  if (status === 'running') line.textContent = t('transfer.acceptFrozen');
  else if (status === 'done') {
    const done = job.result?.entry ?? entry;
    const missing = Object.values(done?.files ?? {}).filter((value) => value === 'missing').length;
    append(clear(line), [el('strong', {}, t('transfer.done')),
      missing ? el('span', {}, ` ${t('transfer.doneMissing', { count: missing })}`) : null,
      done?.invalid ? el('span', {}, ` ${t('transfer.doneInvalid', { count: done.invalid })}`) : null,
      done?.sourceGone ? el('span', {}, ` ${t('transfer.doneSourceGone')}`) : null]);
    footer.append(button(t('transfer.openNew'), { variant: 'primary', onclick: () => handlers.open(done) }));
  } else if (status === 'cancelled') line.textContent = t('transfer.cancelledByOwner');
  else if (entry) {
    const error = job?.error;
    line.textContent = error?.code === 'busy' ? t('transfer.busyElsewhere') : error ? t('transfer.paused', { reason: reasonText(error) }) : t('transfer.pausedShort');
    footer.append(button(t('transfer.stop'), { variant: 'danger', onclick: () => handlers.stop(entry) }),
      button(error?.definite ? t('transfer.retry') : t('transfer.resume'), { variant: 'primary', onclick: () => handlers.resume(entry) }));
  }
  return el('div.transfer-progress', {}, steps, line, footer.childElementCount ? footer : null);
}

/** The move's progress for the new owner; also how a paused move (from the journal) is resumed or stopped. */
export function openProgressDialog(context) {
  const { space, session, app } = context;
  const id = space.ref.s;
  const body = el('div.transfer', {}, el('p.transfer-loading', {}, spinner()));
  const dialog = openModal({ title: t('transfer.progressTitle'), content: body });
  let last = jobFor(id);
  const handlers = {
    resume: (entry) => startJob(context, entry),
    async stop(entry) {
      const owner = viewState(space, context.account.uuid).owner || t('transfer.someone');
      if (!(await confirmDialog({ title: t('transfer.stopTitle'), body: t('transfer.stopBody', { owner }), confirmLabel: t('transfer.stop'), danger: true }))) return;
      const deps = runnerDeps(context);
      try {
        await cancelTransfer(entry, { journal: deps.journal, call: callFor(session.api), removeCopy: deps.removeCopy });
        toast(t('transfer.stopped'));
        void space.sync?.().catch(() => {});
        dialog.close('stopped');
      } catch (error) { toast(t('transfer.failed', { reason: reasonText(error.cause ?? error) })); }
    },
    open(entry) {
      dialog.close('open');
      if (entry?.to) app?.navigate(routeHash({ name: 'space', ref: entry.to, tab: 'plan' }));
    },
  };
  const render = (job) => { last = job; body.replaceChildren(progressView(job, handlers)); };
  const off = onJob(id, render);
  void dialog.closed.then(off);
  if (last?.entry) render(last);
  else {
    void transferJournal(session.db, id).get().then((entry) => {
      if (jobFor(id)?.status === 'running') return;
      render(entry ? { entry, status: 'paused', error: entry.error ? { code: entry.error.code, reason: entry.error.code, definite: entry.error.definite } : null } : { entry: null, status: 'idle' });
    }).catch(() => render({ entry: null, status: 'idle' }));
  }
  return dialog;
}
