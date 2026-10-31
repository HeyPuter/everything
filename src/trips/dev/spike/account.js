export function accountChanged() { return new Error('spike_account_changed'); }
export const isAccountChange = (error) => error?.message === 'spike_account_changed';

/** Browser tokens stay private; a validated identity pins the starting account too. */
export async function pinBrowserAccount(puter) {
  const auth = puter?.auth;
  const session = puter?.authToken;
  if (!auth?.isSignedIn() || typeof session !== 'string' || !session) throw new Error('spike_sign_in_manually');
  function check() {
    if (puter.auth !== auth || !auth.isSignedIn() || puter.authToken !== session) throw accountChanged();
  }
  const user = await guardedCall({ check }, () => auth.getUser());
  if (typeof user?.uuid !== 'string' || !user.uuid) throw new Error('spike_identity_invalid');
  return { check, owns: (uuid) => uuid === user.uuid, appName: user.app_name };
}

/** me is bound to the deployer; workers need no browser authToken/isSignedIn surface. */
export function pinWorkerAccount(me, owner) {
  const client = me.puter;
  const uuid = owner.uuid;
  return {
    check() { if (me.puter !== client || owner.uuid !== uuid) throw accountChanged(); },
    owns: (value) => value === uuid,
  };
}

export async function guardedCall(account, operation) {
  account.check();
  try {
    const result = await operation();
    account.check();
    return result;
  } catch (error) { account.check(); throw error; }
}
