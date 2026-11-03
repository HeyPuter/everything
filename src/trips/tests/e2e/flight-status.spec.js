import { test, expect } from '@playwright/test';
import { audit, noOverflow } from './helpers/bridge-world.js';
import { patientWorld, seed, setOnline, tripFor } from './helpers/trip-flows.js';
import { addDays } from '../../src/shared/dates.js';

const KEY = 'test-rapidapi-key-5678';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Lisbon' });
const row = (page, title) => page.locator('.res-row').filter({ has: page.getByRole('button', { name: title, exact: true }) });

function flight(key, title, number, date, [from, to], [dep, arr], arrDate = date) {
  return { key, type: 'res', fields: {
    type: 'flight', title, status: 'confirmed', start: { date, time: dep }, end: { date: arrDate, time: arr },
    legs: [{ from: { code: from, tz: 'Europe/Lisbon' }, to: { code: to, tz: 'Europe/Lisbon' }, dep: { date, time: dep }, arr: { date: arrDate, time: arr }, number }],
  } };
}
const at = (date, time) => ({ utc: `${date} ${time}Z`, local: `${date} ${time}+00:00` });
const side = (iata, scheduled, revised, extra = {}) => ({ airport: { iata, shortName: iata, timeZone: 'Europe/Lisbon' }, scheduledTime: scheduled, ...(revised ? { revisedTime: revised } : {}), quality: ['Basic', 'Live'], ...extra });

/** AeroDataBox through RapidAPI, answered per flight number; returns the request log. */
async function fakeAeroDataBox(context) {
  const calls = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  await context.route((url) => url.hostname === 'aerodatabox.p.rapidapi.com', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    const [, , number, date] = new URL(request.url()).pathname.split('/').filter(Boolean);
    calls.push({ number, date, key: request.headers()['x-rapidapi-key'] });
    const json = (body, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (number === 'TP1946') {
      await json([{ number: 'TP 1946', status: 'Delayed', airline: { name: 'TAP Air Portugal', iata: 'TP' }, aircraft: { model: 'Airbus A320' },
        departure: side('LIS', at(date, '22:00'), at(date, '22:25'), { terminal: '1', gate: 'A12' }),
        arrival: side('OPO', at(date, '23:50'), at(addDays(date, 1), '00:15'), { baggageBelt: '4' }) }]);
    } else if (number === 'IB3101') {
      await json([{ number: 'IB 3101', status: 'Expected', departure: side('LIS', at(date, '08:00')), arrival: side('MAD', at(date, '10:15')) }]);
    } else if (number === 'UX1158') await route.fulfill({ status: 204, headers: cors });
    else if (number === 'KL1695') await json({ message: 'Invalid API key' }, 401);
    else await json({ message: 'Too many requests' }, 429);
  });
  return calls;
}

test.describe('flight status', () => {
  test('the AeroDataBox key is saved, shown and removed, with invalid, credit and offline errors', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const alice = await w.open('alice', '#/settings/flight-status');
      await expect(alice.getByText('No key saved.')).toBeVisible();
      await audit(alice);
      const input = alice.getByLabel('AeroDataBox API key');
      await input.fill('short');
      await alice.getByRole('button', { name: 'Save key' }).click();
      await expect(alice.getByText('Paste the key as RapidAPI shows it: 8 to 256 characters, no spaces.')).toBeVisible();

      w.world.failNext({ method: 'kv.set', as: 'alice', status: 402 });
      await input.fill(KEY);
      await alice.getByRole('button', { name: 'Save key' }).click();
      await expect(alice.locator('.settings-alert')).toHaveText('Your Puter credit has run out. Add credit, then try again.');
      await alice.getByRole('button', { name: 'Save key' }).click();
      await expect(alice.getByText('A key ending in 5678 is saved.')).toBeVisible();
      await expect(input).toHaveValue('');
      await input.fill('typed-but-not-saved');
      await alice.getByRole('button', { name: 'Show key' }).click();
      await expect(input).toHaveAttribute('type', 'text');
      await expect(alice.getByRole('button', { name: 'Show key' })).toHaveAttribute('aria-pressed', 'true');
      await audit(alice);
      await noOverflow(alice);

      const context = await w.context('alice');
      await setOnline(context, false);
      await alice.getByRole('button', { name: 'Remove key' }).click();
      await expect(alice.locator('.settings-alert')).toHaveText('You are offline. Reconnect and try again.');
      await setOnline(context, true);
      await alice.getByRole('button', { name: 'Remove key' }).click();
      await expect(alice.getByText('No key saved.')).toBeVisible();
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('live status, provider errors and the early window show on bookings for the key holder only', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, { start: today, end: addDays(today, 6) });
      await seed(w, 'alice', trip.ref, [
        flight('tp', 'Lisbon to Porto', 'TP 1946', today, ['LIS', 'OPO'], ['22:00', '23:50']),
        flight('ux', 'Lisbon to Madrid', 'UX 1158', addDays(today, 1), ['LIS', 'MAD'], ['07:00', '09:15']),
        flight('kl', 'Lisbon to Amsterdam', 'KL 1695', addDays(today, 1), ['LIS', 'AMS'], ['06:00', '10:00']),
        flight('ba', 'Lisbon to London', 'BA 501', addDays(today, 2), ['LIS', 'LHR'], ['09:00', '11:40']),
        flight('ib', 'Lisbon to Madrid later', 'IB 3101', addDays(today, 5), ['LIS', 'MAD'], ['08:00', '10:15']),
      ]);
      const aliceContext = await w.context('alice');
      const calls = await fakeAeroDataBox(aliceContext);
      const setter = await w.open('alice', '#/settings/flight-status');
      await setter.getByLabel('AeroDataBox API key').fill(KEY);
      await setter.getByRole('button', { name: 'Save key' }).click();
      await expect(setter.getByText('A key ending in 5678 is saved.')).toBeVisible();
      await setter.close();

      const alice = await w.open('alice', trip.hash('bookings'));
      await expect(row(alice, 'Lisbon to Porto').locator('.fstatus-chip')).toHaveText('Flight status: Delayed 25 min', { timeout: 15_000 });
      await row(alice, 'Lisbon to Porto').getByRole('button', { name: 'Lisbon to Porto', exact: true }).click();
      const details = alice.getByRole('dialog', { name: 'Lisbon to Porto' });
      await expect(details.locator('.fstatus-details')).toContainText('TP 1946 · LIS → OPO');
      await expect(details.locator('.fstatus-details')).toContainText('Airbus A320');
      await expect(details.locator('.fstatus-side').nth(1)).toContainText('+1');
      await expect(details.locator('.fstatus-side').nth(1)).toContainText('4');
      await audit(alice);
      await noOverflow(alice);
      await alice.keyboard.press('Escape');
      expect(calls.every((call) => call.key === KEY)).toBe(true);

      const open = async (title) => {
        await row(alice, title).getByRole('button', { name: title, exact: true }).click();
        return alice.getByRole('dialog', { name: title });
      };
      let dialog = await open('Lisbon to Madrid');
      await expect(dialog).toContainText(`AeroDataBox has no flight UX1158 on`);
      await alice.keyboard.press('Escape');
      dialog = await open('Lisbon to Amsterdam');
      await expect(dialog).toContainText('AeroDataBox refused your API key. Check it in settings.');
      await expect(dialog.getByRole('link', { name: 'Flight status settings' })).toHaveAttribute('href', '#/settings/flight-status');
      await alice.keyboard.press('Escape');
      dialog = await open('Lisbon to London');
      await expect(dialog).toContainText('Your AeroDataBox plan has no calls left for now.');
      await alice.keyboard.press('Escape');

      dialog = await open('Lisbon to Madrid later');
      await expect(dialog).toContainText('Status updates start three days before departure.');
      expect(calls.some((call) => call.number === 'IB3101')).toBe(false);
      await setOnline(aliceContext, false);
      await dialog.getByRole('button', { name: 'Check now' }).click();
      await expect(dialog).toContainText('You’re offline. Flight status loads when you reconnect.');
      await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
      await setOnline(aliceContext, true);
      await expect(dialog.locator('.fstatus-details .fstatus-chip')).toHaveText('Flight status: On time');
      await alice.keyboard.press('Escape');

      const bob = await w.open('bob', trip.hash('bookings'));
      await row(bob, 'Lisbon to Porto').getByRole('button', { name: 'Lisbon to Porto', exact: true }).click();
      const bobDetails = bob.getByRole('dialog', { name: 'Lisbon to Porto' });
      await expect(bobDetails).toContainText('Add your AeroDataBox API key to see live status for this flight.');
      await expect(row(bob, 'Lisbon to Porto').locator('.fstatus-chip')).toHaveCount(0);
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });
});
