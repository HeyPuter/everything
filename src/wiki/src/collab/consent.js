/**
 * The account's consent for this app to hand space signals to the people it shares with; without it they hear of
 * changes only by polling. Only the account the server runs as can give it, and a join answers that account alone
 * with `events.app`. Puter remembers the answer, so this prompts at most once.
 */
export async function grantEvents(puter, space) {
  const own = space.eventDescriptor;
  const perms = puter?.perms;
  if (!own?.app || own.app !== puter.appID || !space.ownerUuid || typeof perms?.request !== 'function') return false;
  const kvShare = perms.Resource?.KV_SHARE;
  const granted = await (kvShare
    ? perms.request(kvShare, { prefix: 'wk:', access: 'watch' })
    : perms.request('permission', { permission: `manage:kv-share:${space.ownerUuid}:${own.app}:wk` })
  ).catch(() => false);
  if (granted) await space.request('events', { consented: true }).catch(() => {});
  return !!granted;
}
