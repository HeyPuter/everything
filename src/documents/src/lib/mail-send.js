/**
 * Mail from the user's own Puter address (`<username>@puter.email`), as the
 * Calendar app in this repository sends replies: `puter.email.send` resolves
 * the service's answer instead of throwing on a refusal, so every outcome is
 * read from that answer. A first 'forbidden' asks for the mail permission once
 * and tries again. Nothing is sent without the person pressing Send.
 */
const sdk = () => (typeof puter !== 'undefined' ? puter : null);

export const canEmail = () => typeof sdk()?.email?.send === 'function';

/** Base64 of bytes, for attachments. */
export function base64Bytes(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/**
 * Send one message. `attachments`: [{ filename, bytes, contentType }].
 * Resolves { ok: true } or { ok: false, message }.
 */
export async function sendMail({ to, subject, text, attachments = [], username = '' }) {
  const p = sdk();
  if (!canEmail()) return { ok: false, message: 'Email is not available here. Download the file and attach it in your mail app instead.' };
  const payload = { to, subject, text, attachments: attachments.map(a => ({ filename: a.filename, content: base64Bytes(a.bytes), contentType: a.contentType })) };
  const attempt = async (retried) => {
    let body;
    try { body = await p.email.send(payload); } catch { return { ok: false, message: 'The message could not be sent. Check your connection and try again.' }; }
    const delivered = Array.isArray(body?.delivered) && body.delivered.some(a => String(a).toLowerCase() === String(to).toLowerCase());
    if (delivered || body?.ok === true) return { ok: true };
    if (body?.code === 'forbidden' && !retried && username) {
      try { await p.perms?.request?.('permission', { permission: `fs:/${username}/.mail:write`, create: true }); } catch { /* refused */ }
      return attempt(true);
    }
    if (body?.code === 'too_many_requests') return { ok: false, message: "You've reached today's email limit. Try again tomorrow." };
    return { ok: false, message: body?.message || 'The message could not be sent.' };
  };
  return attempt(false);
}
