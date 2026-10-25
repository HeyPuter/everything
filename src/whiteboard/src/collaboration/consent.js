// The worker account's consent for this app to hand its board signals to the
// people it shares with; without it they hear of changes only by polling.
// Only the account the worker runs as can give it, and a join answers that
// account alone with `events.app`. Puter remembers the answer, so this
// prompts at most once.
export async function allowLiveUpdates(session, puter, joined) {
  const own = joined?.events;
  const perms = puter?.perms;
  if (
    !own?.app ||
    !own.owner ||
    own.app !== puter.appID ||
    typeof perms?.request !== "function"
  )
    return false;
  const kvShare = perms.Resource?.KV_SHARE;
  const granted = await (
    kvShare
      ? perms.request(kvShare, { prefix: "wb:", access: "watch" })
      : perms.request("permission", {
          permission: `manage:kv-share:${own.owner}:${own.app}:wb`,
        })
  ).catch(() => false);
  if (granted)
    await session.request("events", { consented: true }).catch(() => {});
  return !!granted;
}
