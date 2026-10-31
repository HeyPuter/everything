import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { errorKey, uploadFile } from '../../../../lib/files/index.js';

/** Whether receipts can be uploaded now: shared expenses only, with `files.upload` and a connection. */
export const canAttachReceipts = (space, session) => space.can('files.upload') && Boolean(session?.api) && globalThis.navigator?.onLine !== false;

/** Uploads receipt files into the trip and links them to a saved expense, with toasts for progress and failures. */
export async function attachReceipts({ space, id, files, session, puter }) {
  if (!files.length) return;
  // A private expense lives in the member's own storage; a trip file linked to it would be visible to everyone.
  if (!space.get('exp', id)) { toast(t('receipt.attachPrivate')); return; }
  toast(t('receipt.attaching'));
  let failure = null;
  for (const file of files) {
    try { await uploadFile(space, file, { link: { t: 'exp', id }, api: session?.api, puter }); } catch (error) { failure = error; }
  }
  toast(failure ? t('receipt.attachFailed', { reason: t(errorKey(failure)) }) : t('receipt.attached'));
}
