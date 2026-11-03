// Ownership transfer UI: the dialogs, the Members tab section, the trip notice and the palette command.
import './transfer.css';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { transferJournal } from '../../../lib/transfer/index.js';
import { available, jobFor } from './deps.js';
import { openAcceptDialog, openOfferDialog, openProgressDialog } from './dialog.js';
import { localDate, viewState } from './logic.js';

export { transferSection } from './section.js';
export { watchTransfer } from './notice.js';
export { openAcceptDialog, openOfferDialog, openProgressDialog } from './dialog.js';

/** Opens what this member can do about ownership right now; resolves to the dialog, or null when there is nothing. */
export async function openTransfer(context) {
  if (!available(context)) { toast(t('members.unavailable')); return null; }
  const { space, account, session } = context;
  const state = viewState(space, account.uuid);
  const running = jobFor(space.ref.s)?.status === 'running';
  let journal = null;
  try { journal = await transferJournal(session.db, space.ref.s).get(); } catch { journal = null; }
  if (running || journal || (state.phase === 'moving' && state.mine)) return openProgressDialog(context);
  if (state.phase === 'offered' && state.mine) return openAcceptDialog(context);
  if (state.phase === 'none' && state.role === 'owner') return openOfferDialog(context);
  if (state.phase === 'offered' && state.role === 'owner') toast(t('transfer.offeredTo', { name: state.target, date: localDate(state.transfer.exp) }));
  else if (state.phase === 'moving') toast(t('transfer.moving', { name: state.target }));
  else if (state.phase === 'moved') toast(t('transfer.moved', { name: state.movedName }));
  return null;
}

/** Palette command "Transfer trip ownership" for the open trip; returns its unregister. */
export function registerTransferCommand(context) {
  try {
    return context.app?.commands?.register({ id: 'trip-transfer', labelKey: 'transfer.command', run: () => void openTransfer(context) }) ?? (() => {});
  } catch { return () => {}; }
}
