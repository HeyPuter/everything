import { expect } from '@playwright/test';
import { bridgeWorld } from './bridge-world.js';
import { routeProviders } from './providers.js';

/** Changes reach the other account on its next poll or event. */
export const SYNC = { timeout: 25_000 };

/** A bridge world whose contexts already answer map and provider requests from fixtures. `traffic[as]` counts them. */
export async function planWorld(browser, testInfo, baseURL, { providers = {}, ...options } = {}) {
  const w = await bridgeWorld(browser, testInfo, baseURL, options);
  const traffic = {};
  for (const as of options.users ?? ['alice', 'bob']) traffic[as] = await routeProviders(await w.context(as), typeof providers === 'function' ? providers(as) : providers);
  return Object.assign(w, { traffic });
}

export const isNarrow = (testInfo) => testInfo.project.use.viewport.width < 1024;

/** Sets a member's role through the owner's worker (the mock hook), for trips that need an editor and a viewer. */
export async function setRole(w, trip, as, role, owner = 'alice') {
  const page = await w.open(owner);
  await page.evaluate(([ref, uuid, value]) => globalThis.trips.call(ref, 'member.role', { uuid, role: value }), [trip.ref, w.world.user(as).uuid, role]);
  await page.close();
}

/** Opens a trip tab and waits for the Plan tab's layout. */
export async function openPlan(w, as, trip) {
  const page = await w.open(as, trip.hash('plan'));
  await expect(page.locator('.plan')).toBeVisible();
  await expect(page.locator('.plan-col')).toBeVisible();
  return page;
}

/** At phone width the panes switch; wider layouts show the pane already (or, at 1024–1279 px, switch map and places). */
export async function showPane(page, name) {
  const button = page.locator('.plan-switch').getByRole('button', { name, exact: true });
  if (await button.isVisible()) await button.click();
}

export const day = (page, id) => page.locator(`.plan-day[data-day="${id}"]`);
export const rowTitles = (page, dayId) => day(page, dayId).locator(':scope .plan-rows > .plan-row .plan-row-title');
export const grip = (page, key) => page.locator(`[data-focus="grip:${key}"]`);

/** Dragging with the mouse: press, move past the threshold, then move to the target point in steps and release. */
export async function mouseDrag(page, from, to, { release = true } = {}) {
  const a = await from.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 2 });
  await expect(page.locator('body')).toHaveClass(/dnd-active/);
  // Lists change height while the slot moves between them, so the target is measured again after each approach.
  for (const steps of [10, 4, 2]) {
    const point = typeof to === 'function' ? await to() : to;
    await page.mouse.move(point.x, point.y, { steps });
  }
  if (release) await page.mouse.up();
}

/** The point a quarter of the way down a locator's box, where a drop lands before it. */
export async function above(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 4 };
}
export async function center(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A long press with touch pointer events, then a drag to `to` and release. Synthetic events, since Playwright's
 * touchscreen only taps; the drag code reads `pointerType` and the coordinates.
 */
export async function touchDrag(page, from, to) {
  const start = await center(from);
  await page.evaluate(({ x, y }) => {
    const init = { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', isPrimary: true, pointerId: 41, button: 0, buttons: 1, clientX: x, clientY: y };
    document.elementFromPoint(x, y).dispatchEvent(new PointerEvent('pointerdown', init));
  }, start);
  await expect(page.locator('body')).toHaveClass(/dnd-active/);
  const end = typeof to === 'function' ? await to() : to;
  await page.evaluate(([a, b]) => {
    const init = (x, y) => ({ bubbles: true, cancelable: true, composed: true, pointerType: 'touch', isPrimary: true, pointerId: 41, button: 0, buttons: 1, clientX: x, clientY: y });
    for (let step = 1; step <= 8; step++) {
      const x = a.x + ((b.x - a.x) * step) / 8; const y = a.y + ((b.y - a.y) * step) / 8;
      document.dispatchEvent(new PointerEvent('pointermove', init(x, y)));
    }
    document.dispatchEvent(new PointerEvent('pointerup', { ...init(b.x, b.y), buttons: 0 }));
  }, [start, end]);
  await expect(page.locator('body')).not.toHaveClass(/dnd-active/);
}

/** Opens a row's or day's "more" menu and picks an item. */
export async function menuPick(page, trigger, item) {
  await trigger.click();
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click();
}
