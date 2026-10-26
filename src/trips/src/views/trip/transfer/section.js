// The ownership section of the Members tab: offer, withdraw, review, progress, depending on who is looking.
import { el, uid as uniqueId } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { candidates, transferJournal } from '../../../lib/transfer/index.js';
import { available, jobFor, onJob } from './deps.js';
import { cancelOffer, openAcceptDialog, openOfferDialog, openProgressDialog } from './dialog.js';
import { icon } from './icons.js';
import { localDate, viewState } from './logic.js';

/** `{element, update(), destroy()}`; hidden when there is nothing to show this member. */
export function transferSection(context) {
  const element = el('section.members-section.transfer-section');
  if (!available(context)) { element.hidden = true; return { element, update() {}, destroy() {} }; }
  const { space, account } = context;
  const headingId = uniqueId('transfer-head');
  let paused = null;
  let destroyed = false;
  element.setAttribute('aria-labelledby', headingId);

  const heading = () => el('h3', { id: headingId }, icon('transfer', 16), ` ${t('transfer.title')}`);
  const actions = (...nodes) => el('div.transfer-section-actions', {}, ...nodes.filter(Boolean));

  function render() {
    if (destroyed) return;
    const state = viewState(space, account.uuid);
    const owner = state.role === 'owner';
    let body = null;
    if (state.phase === 'moved') body = null;
    else if (state.phase === 'moving') {
      // A move this tab is not running is paused (a reload or a failure): offer to resume it.
      if (state.mine && paused && jobFor(space.ref.s)?.status !== 'running') {
        body = [el('p.members-hint', {}, t('transfer.pausedShort')), actions(button(t('transfer.resume'), { size: 'sm', variant: 'primary', onclick: () => openProgressDialog(context) }))];
      } else if (state.mine) body = [el('p.members-hint', {}, t('transfer.movingMine')), actions(button(t('transfer.progressTitle'), { size: 'sm', onclick: () => openProgressDialog(context) }))];
      else if (owner) {
        body = [el('p.members-hint', {}, t('transfer.movingOwner', { name: state.target })), actions(button(t('transfer.stop'), { size: 'sm', variant: 'danger', onclick: () => void stopAsOwner(state) }))];
      } else body = [el('p.members-hint', {}, t('transfer.moving', { name: state.target }))];
    } else if (state.phase === 'offered') {
      const expires = localDate(state.transfer.exp);
      if (state.mine) {
        body = [el('p.members-hint', {}, t('transfer.offerForYou', { owner: state.owner || t('transfer.someone') })),
          actions(button(t('transfer.decline'), { size: 'sm', variant: 'ghost', onclick: () => void decline() }), button(t('transfer.review'), { size: 'sm', variant: 'primary', onclick: () => openAcceptDialog(context) }))];
      } else if (owner) {
        body = [el('p.members-hint', {}, t('transfer.offeredTo', { name: state.target, date: expires })),
          actions(button(t('transfer.withdraw'), { size: 'sm', onclick: () => void withdraw() }))];
      } else body = [el('p.members-hint', {}, t('transfer.offerOther', { owner: state.owner || t('transfer.someone'), name: state.target }))];
    } else if (paused) {
      body = [el('p.members-hint', {}, t('transfer.pausedShort')), actions(button(t('transfer.resume'), { size: 'sm', variant: 'primary', onclick: () => openProgressDialog(context) }))];
    } else if (owner) {
      const none = !candidates(space.members(), account.uuid).length;
      body = [el('p.members-hint', {}, t(none ? 'transfer.noCandidates' : 'transfer.sectionHint')),
        actions(button(t('transfer.open'), { size: 'sm', disabled: none, onclick: () => openOfferDialog(context) }))];
    }
    element.hidden = !body;
    element.replaceChildren(...(body ? [heading(), ...body] : []));
  }
  async function withdraw() {
    if (await cancelOffer(context)) toast(t('transfer.withdrawn'));
  }
  async function decline() {
    if (await cancelOffer(context)) toast(t('transfer.declined'));
  }
  async function stopAsOwner(state) {
    if (await cancelOffer(context, { confirm: { title: t('transfer.stopTitle'), body: t('transfer.stopOwnerBody', { name: state.target }), label: t('transfer.stop') } })) toast(t('transfer.stopped'));
  }
  async function loadJournal() {
    try { paused = await transferJournal(context.session.db, space.ref.s).get(); } catch { paused = null; }
    render();
  }

  const offs = [space.subscribe({ type: 'meta', id: 'meta' }, render), space.subscribe('member', render), onJob(space.ref.s, () => void loadJournal())];
  render();
  void loadJournal();
  return {
    element,
    update: render,
    destroy() { destroyed = true; for (const off of offs.splice(0)) off(); },
  };
}
