/**
 * Published as mail-snooze-v1. Keep one self-contained function expression:
 * the events worker supplies only event, ctx, user and fetch.
 */
async function wakeSnooze({ event, ctx, user }) {
  if (event?.op !== 'tick' || !ctx?.id || !ctx.token || !ctx.mailPath) return;
  const key = `snooze:${ctx.id}`;
  const parse = (value) => typeof value === 'string' ? JSON.parse(value) : value;
  const missing = (error) => ['subject_does_not_exist', 'not_found'].includes(error?.code);
  const throttled = (error) => Number(error?.status ?? error?.statusCode) === 429
    || ['too_many_requests', 'rate_limited'].includes(error?.code);
  try {
    const record = parse(await user.kv.get(key));
    if (!record || record.token !== ctx.token || record.until > Date.now()) return;
    if (!record.path?.startsWith(`${ctx.mailPath}/snoozed/`) || record.name?.includes('/')) return;
    const woken = parse(await user.kv.get(`woken:${ctx.id}`));
    const now = Date.now();
    const dir = `${ctx.mailPath}/objects/${new Date(now).toISOString().slice(0, 10)}`;
    try {
      await user.fs.mkdir(dir, { createMissingParents: true });
    } catch (error) {
      if (!['item_with_same_name_exists', 'already_exists', 'conflict'].includes(error?.code)) throw error;
    }
    if (parse(await user.kv.get(key))?.token !== ctx.token) return;
    if (!woken) await user.kv.set(`woken:${ctx.id}`, { at: now, path: `${dir}/${record.name}` });
    try {
      // FS moves emit :move, never :add; only this handler announces a wake.
      await user.fs.move(record.path, dir, { newName: record.name });
    } catch (error) {
      if (!missing(error)) throw error;
      // A prior attempt moved it but could not announce it.
      if (!woken || parse(await user.kv.get(key))?.token !== ctx.token) return;
    }
    let subject = '';
    try {
      const encoded = record.name.slice(record.name.indexOf('--') + 2).replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)), (c) => c.charCodeAt(0));
      subject = new TextDecoder().decode(bytes).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 240)
        .replace(/[\ud800-\udbff]$/, '');
    } catch {}
    try {
      await user.notifications.notify({
        title: 'Snoozed message', text: subject || '(no subject)',
        target: `/?message=${ctx.id}`, data: { id: ctx.id }, channel: 'mail', group: `snooze-${ctx.id}`,
        ...(record.previews === false ? { sensitive: true } : {}),
      });
    } catch (error) {
      if (!throttled(error)) throw error;
    }
    if (parse(await user.kv.get(key))?.token === ctx.token) await user.kv.del(key);
  } catch (error) {
    const status = Number(error?.status ?? error?.statusCode);
    const transient = throttled(error) || status >= 500
      || ['network_error', 'request_timeout', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error?.code)
      || error?.name === 'TimeoutError'
      || (error?.name === 'TypeError' && /fetch|network/i.test(error?.message ?? ''));
    if (transient) throw Object.assign(new Error(error?.message || 'wake failed'), { retry: true });
  }
}
