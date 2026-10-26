import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { mount } from '../../src/views/vacay/index.js';
import { parseRoute } from '../../src/lib/router.js';
import { t } from '../../src/lib/i18n/index.js';

const ALICE = { uuid: '00000000-0000-4000-8000-000000000001', username: 'alice' };
const BOB = { uuid: '00000000-0000-4000-8000-000000000002', username: 'bob' };
// Each step waits on several fake KV round trips; a loaded machine stretches them past waitFor's 1 s default.
const WAIT = { timeout: 10_000 };
const byText = (root, text) => [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === text);

async function open(fake, user) {
  const container = document.createElement('div');
  document.body.append(container);
  const controller = new AbortController();
  // Stub services so tests never reach a holiday provider.
  const holidays = {
    public: vi.fn(async (code, year) => ({ data: year === 2026 ? [{ date: '2026-03-05', name: 'Test Day', localName: 'Test Day', global: true, regions: [] }] : [] })),
    school: vi.fn(async () => ({ data: [] })), subdivisions: vi.fn(async () => ({ data: [] })),
  };
  const session = { services: { holidays }, personal: { spaces: { list: async () => [{ ref: { w: 'trips-abcdefghij', s: '0123456789abcdef', k: 'trip' }, title: 'Lisbon', start: '2026-03-10', end: '2026-03-12' }] }, subscribe: () => () => {} } };
  const cleanup = await mount(container, { puter: fake.client(user.uuid), account: user, signal: controller.signal, session });
  return { container, cleanup };
}

describe('vacay page', () => {
  afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

  it('is a page route', () => {
    expect(parseRoute('#/vacay')).toEqual({ name: 'page', id: 'vacay' });
  });

  it('renders the leave year, toggles days and shows a shared calendar', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-04T10:00:00Z') });
    const fake = createFakePuter({ shareHandles: true, users: [ALICE, BOB] });
    const alice = await open(fake, ALICE);
    await vi.waitFor(() => expect(alice.container.querySelectorAll('.vacay-month')).toHaveLength(12), WAIT);
    const day = alice.container.querySelector('button.vacay-day[data-date="2026-03-04"]');
    expect(day.getAttribute('aria-current')).toBe('date');
    day.click();
    await vi.waitFor(() => expect(fake.inspectKv(ALICE.uuid)['vacay:e:2026-03-04']).toEqual({ fraction: 1, kind: 'vacation' }), WAIT);
    await vi.waitFor(() => expect(alice.container.querySelector('button.vacay-day[data-date="2026-03-04"]').getAttribute('aria-pressed')).toBe('true'), WAIT);
    alice.container.querySelector('button.vacay-day[data-date="2026-03-07"]').click(); // Saturday
    expect(fake.inspectKv(ALICE.uuid)['vacay:e:2026-03-07']).toBeUndefined();
    await vi.waitFor(() => expect(alice.container.querySelector('button.vacay-day[data-date="2026-03-05"]').classList.contains('is-holiday')).toBe(true), WAIT);
    alice.container.querySelector('button.vacay-day[data-date="2026-03-05"]').click();
    expect(fake.inspectKv(ALICE.uuid)['vacay:e:2026-03-05']).toBeUndefined();
    expect(alice.container.querySelector('button.vacay-day[data-date="2026-03-11"] .vacay-trip')).toBeTruthy();

    byText(alice.container, t('vacay.inviteButton')).click();
    const dialog = await vi.waitFor(() => { const node = document.querySelector('[role=dialog]'); expect(node).toBeTruthy(); return node; }, WAIT);
    dialog.querySelector('input').value = 'bob';
    [...dialog.querySelectorAll('button')].find((node) => node.textContent.startsWith(t('vacay.modeView'))).click();
    byText(dialog, t('vacay.inviteSend')).click();
    await vi.waitFor(() => expect(document.querySelector('[role=dialog]')).toBe(null), WAIT);

    const bob = await open(fake, BOB);
    await vi.waitFor(() => expect(bob.container.textContent).toContain(t('vacay.invite.view', { name: 'alice' })), WAIT);
    byText(bob.container, t('vacay.accept')).click();
    await vi.waitFor(() => expect(bob.container.querySelector('button.vacay-day[data-date="2026-03-04"] .vacay-ring')).toBeTruthy(), WAIT);
    expect(bob.container.querySelector('button.vacay-day[data-date="2026-03-04"]').getAttribute('aria-label')).toContain(t('vacay.cell.peerOff', { name: 'alice' }));
    alice.cleanup(); bob.cleanup();
  }, 30_000);
});
