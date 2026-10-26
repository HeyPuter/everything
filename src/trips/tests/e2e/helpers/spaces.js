import { expect } from '@playwright/test';

const PREFIX = { trip: 't', collection: 'c', journey: 'j' };

/** `{w, s, k}` from a space URL such as `…#/c/<worker>/<space>/places`. */
export function refFromURL(url, k) {
  const [, , w, s] = new URL(url).hash.split('/');
  return { w, s, k };
}

/** The owner's page makes an invite through the mock hook; `member` accepts it on the app's join page. Returns the member's page. */
export async function joinSpace(w, ownerPage, ref, member, role = 'editor') {
  const { token } = await ownerPage.evaluate(async ([target, value]) => {
    await globalThis.trips.deploy();
    return globalThis.trips.invite(target, { role: value });
  }, [ref, role]);
  const page = await w.open(member, `#/join/${ref.w}/${ref.s}/${token}`);
  await page.getByRole('button', { name: 'Join trip', exact: true }).click();
  await page.waitForURL((url) => url.hash.startsWith(`#/${PREFIX[ref.k]}/${ref.w}/${ref.s}`));
  return page;
}

/** Waits for the shell's sync status line. */
export const syncStatus = (page, text) => expect(page.locator('footer.app-sync')).toContainText(text);

/** Live entities of `type` the owner's worker has committed for space `sid`. */
export function committed(world, owner, sid, type) {
  const prefix = `shared:${sid}:e:${type}:`;
  return Object.entries(world.inspectKv(owner)).filter(([key, value]) => key.startsWith(prefix) && !value?.deleted).map(([, value]) => value);
}

/** A toast with this text. */
export const toastText = (page, text) => expect(page.locator('.toast').filter({ hasText: text }).first()).toBeVisible();
