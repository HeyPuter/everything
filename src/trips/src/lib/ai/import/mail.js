// The user's Puter mailbox (<username>@puter.email): read access, recent messages and one message.

export class MailError extends Error {
  constructor(code, cause) { super(code); this.code = code; this.cause = cause; }
}

export const mailAvailable = (puter) => typeof puter?.email?.list === 'function' && typeof puter?.email?.get === 'function';
export const mailAddress = (username) => (username ? `${username}@puter.email` : '');

/** Asks for read access to `~/.mail` (one prompt). Resolves true when granted. */
export async function requestMailAccess(puter) {
  if (!mailAvailable(puter)) throw new MailError('mail_unavailable');
  if (typeof puter.perms?.request !== 'function') return true;
  try { return Boolean(await puter.perms.request('fs', { path: '~/.mail', access: 'read' })); }
  catch (error) { throw new MailError('mail_denied', error); }
}

function mailError(error) {
  const status = error?.status ?? error?.error?.status;
  const code = error?.code ?? error?.error?.code;
  if (status === 401 || status === 403 || code === 'forbidden' || code === 'permission_denied') return new MailError('mail_denied', error);
  if (status === 402 || code === 'insufficient_funds') return new MailError('credit', error);
  if (status === 404 || code === 'not_found' || code === 'subject_does_not_exist') return new MailError('mail_missing', error);
  return new MailError('mail_failed', error);
}

/** One page of inbox summaries, newest first: `{items: [{id, subject, date, size}], cursor}`. */
export async function listMail(puter, { cursor = null, limit = 30 } = {}) {
  if (!mailAvailable(puter)) throw new MailError('mail_unavailable');
  let page;
  try { page = await puter.email.list({ folder: 'inbox', limit, cursor }); } catch (error) { throw mailError(error); }
  const items = (Array.isArray(page?.items) ? page.items : []).filter((item) => item && typeof item.id === 'string').map((item) => ({
    id: item.id, subject: typeof item.subject === 'string' ? item.subject.slice(0, 200) : '', date: typeof item.date === 'string' ? item.date : '', size: Number(item.size) || 0,
  }));
  return { items, cursor: typeof page?.cursor === 'string' && page.cursor ? page.cursor : null };
}

/** A parsed message (`puter.email.get`) in the shape `fromMail` reads. */
export async function readMail(puter, id) {
  if (!mailAvailable(puter)) throw new MailError('mail_unavailable');
  let message;
  try { message = await puter.email.get(id); } catch (error) { throw mailError(error); }
  if (!message || typeof message !== 'object') throw new MailError('mail_missing');
  return {
    id, subject: String(message.subject ?? ''), date: String(message.date ?? ''),
    from: message.from && typeof message.from === 'object' ? { name: String(message.from.name ?? ''), address: String(message.from.address ?? '') } : String(message.from ?? ''),
    text: typeof message.text === 'string' ? message.text : '', html: typeof message.html === 'string' ? message.html : '',
    attachments: (Array.isArray(message.attachments) ? message.attachments : []).map((attachment) => ({
      filename: attachment?.filename ?? null, mimeType: String(attachment?.mimeType ?? ''), related: Boolean(attachment?.related),
      content: attachment?.content instanceof ArrayBuffer || attachment?.content instanceof Uint8Array ? attachment.content : new ArrayBuffer(0),
    })),
  };
}
