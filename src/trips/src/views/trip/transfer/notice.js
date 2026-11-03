// The trip-wide notice for a transfer: an offer waiting for this member, a move in progress, or a moved trip, which
// this module follows (rejoin, swap the trip index, re-apply refused edits) before taking the member to the new home.
import { el } from '../../../ui/dom.js';
import { button, spinner } from '../../../ui/bits.js';
import { confirmDialog } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { routeHash } from '../../../lib/router.js';
import { deleteStub, followMove, movedRef, replayInto, replayStash } from '../../../lib/transfer/index.js';
import { available, callFor, followDeps } from './deps.js';
import { cancelOffer, openAcceptDialog, openProgressDialog } from './dialog.js';
import { icon } from './icons.js';
import { reasonText, viewState } from './logic.js';

// Workers may hold the frozen meta this long after a move is stopped.
const UNFROZEN_DELAY = 7000;
// One follow and one replay per space, however many notices are mounted.
const follows = new Map();
const replays = new Map();

function follow(context, state) {
  const key = `${context.space.ref.w}/${context.space.ref.s}`;
  if (!follows.has(key)) {
    const meta = context.space.get('meta', 'meta') ?? {};
    const promise = followMove({ from: context.space.ref, movedTo: state.movedTo, meta, role: state.role }, followDeps(context))
      .catch((error) => { follows.delete(key); throw error; });
    follows.set(key, promise);
  }
  return follows.get(key);
}

function replay(context) {
  const { space, session } = context;
  const key = `${space.ref.w}/${space.ref.s}`;
  if (!replays.has(key)) replays.set(key, replayInto(space, replayStash(session.db, space.ref.s)).catch(() => ({ applied: 0, failed: 0 })));
  return replays.get(key);
}

/** Test hook. */
export function resetNotices() { follows.clear(); replays.clear(); }

/**
 * `{element, destroy()}`: mount once per trip view. `onChange` runs after the notice is shown, changed or hidden, for
 * layouts that measure it.
 */
export function watchTransfer(context, { onChange } = {}) {
  const element = el('div.transfer-notice', { role: 'status', hidden: true });
  if (!available(context)) return { element, destroy() {} };
  const { space, account } = context;
  let destroyed = false;
  let outcome = null;
  let failure = null;
  let pending = false;
  let resendTimer = 0;

  const show = (tone, ...children) => {
    element.hidden = false;
    element.dataset.tone = tone;
    element.replaceChildren(icon(tone === 'warn' ? 'alert' : 'transfer', 18), el('span.transfer-notice-text', {}, ...children.filter((node) => typeof node === 'string')),
      el('div.transfer-notice-actions', {}, ...children.filter((node) => node && typeof node !== 'string')));
  };
  const open = (ref) => context.app?.navigate(routeHash({ name: 'space', ref, tab: context.route?.tab ?? 'plan' }), { replace: true });

  async function startFollow(state) {
    failure = null;
    pending = true;
    render();
    try {
      outcome = await follow(context, state);
      if (destroyed) return;
      if (outcome.status === 'joined' && state.role !== 'owner') { toast(t('transfer.followed')); open(outcome.ref); return; }
    } catch (error) { failure = error; } finally { pending = false; }
    render();
  }
  async function removeStub(state) {
    const ok = await confirmDialog({ title: t('transfer.deleteStubTitle'), body: t('transfer.deleteStubBody', { name: state.movedName }), confirmLabel: t('transfer.deleteStub'), danger: true });
    if (!ok) return;
    try {
      await deleteStub(space.ref, { call: callFor(context.session.api) });
      try { await (context.session.personal ?? context.personal)?.spaces?.remove(space.ref); } catch { /* the index is a cache */ }
      toast(t('transfer.stubDeleted'));
      open(movedRef(state.movedTo, space.ref.k));
    } catch (error) { toast(t('transfer.failed', { reason: reasonText(error) })); }
  }

  // Edits refused while the trip was frozen go out again once a stopped move has unfrozen it everywhere.
  function resendRefused() {
    if (resendTimer || typeof space.conflicts !== 'function' || !space.conflicts().some((item) => item.code === 'space_moving')) return;
    resendTimer = setTimeout(() => {
      resendTimer = 0;
      if (destroyed || viewState(space, account.uuid).phase === 'moving') return;
      for (const item of space.conflicts().filter((conflict) => conflict.code === 'space_moving')) void space.resolveConflict(item.op.opId, { keep: 'mine' }).catch(() => {});
    }, UNFROZEN_DELAY);
  }

  function render() {
    if (destroyed) return;
    paint();
    if (['none', 'offered'].includes(viewState(space, account.uuid).phase)) resendRefused();
    try { onChange?.(); } catch { /* layout only */ }
  }
  function paint() {
    const state = viewState(space, account.uuid);
    if (state.phase === 'moved') {
      const target = movedRef(state.movedTo, space.ref.k);
      if (!outcome && !failure && !pending) { void startFollow(state); return; }
      if (failure) {
        show('warn', `${t('transfer.moved', { name: state.movedName })} ${t('transfer.paused', { reason: reasonText(failure) })}`,
          button(t('transfer.retry'), { size: 'sm', onclick: () => void startFollow(state) }));
      } else if (outcome?.status === 'no_seat') {
        const key = outcome.reason === 'used' ? 'transfer.noSeatUsed' : outcome.reason === 'expired' ? 'transfer.noSeatExpired' : 'transfer.noSeat';
        show('warn', `${t('transfer.moved', { name: state.movedName })} ${t(key, { name: state.movedName })}`);
      } else if (outcome?.status === 'joined') {
        show('info', t('transfer.moved', { name: state.movedName }),
          state.role === 'owner' && button(t('transfer.deleteStub'), { size: 'sm', variant: 'ghost', onclick: () => void removeStub(state) }),
          button(t('transfer.goNew'), { size: 'sm', variant: 'primary', onclick: () => open(target) }));
      } else {
        element.hidden = false;
        element.dataset.tone = 'info';
        element.replaceChildren(spinner(), el('span.transfer-notice-text', {}, t('transfer.following')));
      }
      return;
    }
    if (state.phase === 'moving') {
      if (state.mine) show('info', t('transfer.movingMine'), button(t('transfer.progressTitle'), { size: 'sm', onclick: () => openProgressDialog(context) }));
      else show('warn', state.role === 'owner' ? t('transfer.movingOwner', { name: state.target }) : t('transfer.moving', { name: state.target }));
      return;
    }
    if (state.phase === 'offered' && state.mine) {
      show('info', t('transfer.offerForYou', { owner: state.owner || t('transfer.someone') }),
        button(t('transfer.decline'), { size: 'sm', variant: 'ghost', onclick: async () => { if (await cancelOffer(context)) toast(t('transfer.declined')); } }),
        button(t('transfer.review'), { size: 'sm', variant: 'primary', onclick: () => openAcceptDialog(context) }));
      return;
    }
    element.hidden = true;
    element.replaceChildren();
  }

  const offs = [space.subscribe({ type: 'meta', id: 'meta' }, render), space.subscribe('member', render)];
  if (typeof space.onState === 'function') offs.push(space.onState(() => { if (['none', 'offered'].includes(viewState(space, account.uuid).phase)) resendRefused(); }));
  render();
  void replay(context).then((result) => {
    if (destroyed) return;
    if (result.applied) toast(t('transfer.replayed', { count: result.applied }));
    if (result.failed) toast(t('transfer.replayFailed', { count: result.failed }));
  });
  return { element, destroy() { destroyed = true; clearTimeout(resendTimer); for (const off of offs.splice(0)) off(); } };
}
