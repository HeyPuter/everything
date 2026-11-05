/**
 * Published events handler behind new-mail notifications, run once per
 * message delivered to the inbox through the `queue` subscription the app
 * makes on NEW_MAIL_SUBJECT (src/lib/notify.js).
 * scripts/publish-notify-handler.mjs publishes it.
 *
 * It runs in the app's events worker, so it must stay one function
 * expression that closes over nothing: no imports, no code outside it, and
 * `user` rather than `puter`.
 *
 * Per run: one key-value read, then, unless the message is held back, a read
 * of the message's head for its sender, the notification, and one write.
 */
async function notifyNewMail({ event, ctx, user }) {
  if (!event || event.op !== 'add' || typeof event.path !== 'string') return;
  // `<uuidv7>--<base64url subject>`, as emailrx names a delivered message.
  const name = event.path.slice(event.path.lastIndexOf('/') + 1);
  const named = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})--([\w-]*)$/i.exec(name);
  if (!named) return;
  const id = named[1].toLowerCase();

  // notify() is capped at 30/min and 1,000/day per user per app, pushed or not;
  // so one notification covers the mail of the next 20 seconds.
  // What it held back is counted into the next one.
  const KEY = 'notify:last';
  const HOLD_MS = 20000;
  const now = Date.now();
  let last = null;
  try {
    last = await user.kv.get(KEY);
    if (typeof last === 'string') last = JSON.parse(last);
  } catch {
    // Without it, every message is announced.
  }
  const seen = Array.isArray(last?.ids) ? last.ids : [];
  // A queue delivers at least once; a redelivery has been counted already.
  if (seen.includes(id)) return;
  const ids = [id, ...seen].slice(0, 20);
  const held = Number(last?.held) || 0;
  const remember = (state) => user.kv.set(KEY, { ...state, ids }).catch(() => {});
  if (last && now - Number(last.at) < HOLD_MS) {
    await remember({ at: last.at, held: held + 1 });
    return;
  }

  const bytesOf = (base64) => {
    const padded = base64.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  };
  const decode = (bytes, charset) => {
    try {
      return new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  };
  // RFC 2047 encoded words, in either encoding.
  const decodeWords = (value) => value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bq])\?([^?]*)\?=/gi, (word, charset, encoding, data) => {
      try {
        if (encoding.toUpperCase() === 'B') return decode(bytesOf(data), charset);
        const bytes = [];
        for (let i = 0; i < data.length; i++) {
          const hex = data.slice(i + 1, i + 3);
          if (data[i] === '_') bytes.push(32);
          else if (data[i] === '=' && /^[0-9a-f]{2}$/i.test(hex)) {
            bytes.push(parseInt(hex, 16));
            i += 2;
          } else bytes.push(data.charCodeAt(i) & 0xff);
        }
        return decode(Uint8Array.from(bytes), charset);
      } catch {
        return word;
      }
    });
  // One line, within the field's limit, never ending on half a surrogate pair.
  const line = (value, max) => value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, max).replace(/[\ud800-\udbff]$/, '');

  let subject = '';
  try {
    subject = line(decodeWords(decode(bytesOf(named[2]))), 200);
  } catch {
    // Not base64 after all; the sender still says something.
  }

  // The sender, from the head alone: a message can be 25 MB.
  let sender = '';
  try {
    const size = 16384;
    const blob = await user.fs.read(event.uid || event.path, { offset: 0, byte_count: size });
    const text = decode(new Uint8Array(await blob.slice(0, size).arrayBuffer()));
    const end = text.search(/\r?\n\r?\n/);
    const unfolded = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
    const from = (/^from:[ \t]*(.*)$/im.exec(unfolded)?.[1] ?? '').trim();
    // `Name <address>`, `"Name" <address>`, `address (Name)` or a bare address.
    const angle = /^(.*?)<([^>]*)>/.exec(from);
    const address = (angle ? angle[2] : from.replace(/\([^)]*\)/g, '')).trim().toLowerCase();
    // Mail to yourself is not news.
    if (address && Array.isArray(ctx.self) && ctx.self.includes(address)) return;
    const display = angle
      ? angle[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1')
      : /\(([^)]*)\)/.exec(from)?.[1] ?? '';
    sender = line(decodeWords(display) || address, 120);
  } catch {
    // Unreadable, or moved already: the subject alone will do.
  }

  const count = held + 1;
  const about = sender && subject ? `${sender}: ${subject}` : sender || subject;
  const notification = {
    title: count > 1 ? `${count} new messages` : sender || 'New message',
    text: line(count > 1 ? about : subject, 240) || '(no subject)',
    target: `/?message=${id}`,
    data: { id },
    // A newer one replaces the one showing, so the inbox is one notification.
    group: 'inbox',
    channel: 'mail',
  };
  // Pushed as a generic line: neither sender nor subject leaves Puter.
  if (ctx.previews === false) notification.sensitive = true;

  try {
    await user.notifications.notify(notification);
  } catch (error) {
    const status = Number(error?.status ?? error?.statusCode);
    const code = error?.code;
    if (code === 'too_many_requests' || code === 'rate_limited' || status === 429) {
      // Over the cap. Retrying only spends more of it, and counts toward the
      // five failures that suspend the subscription.
      await remember({ at: now, held: 0 });
      return;
    }
    const transient = status >= 500
      || ['network_error', 'request_timeout', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(code)
      || error?.name === 'TimeoutError'
      || (error?.name === 'TypeError' && /fetch|network/i.test(error?.message ?? ''));
    if (transient) throw Object.assign(new Error(error?.message || 'notify failed'), { retry: true });
    // Anything else would fail the same way again.
    return;
  }
  await remember({ at: now, held: 0 });
}
