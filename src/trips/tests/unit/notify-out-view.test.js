import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../src/views/settings/notifications.js';
import { KEYS } from '../../src/lib/notify-out/model.js';

const SPACE = 'a1b2c3d4e5f6g7h8';
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => { setTimeout(resolve, 0); }); };

function world(stored = {}) {
  const store = new Map(Object.entries(stored));
  const kv = {
    get: vi.fn(async (key) => (Array.isArray(key) ? key.map((k) => store.get(k) ?? null) : store.get(key) ?? null)),
    set: vi.fn(async (key, value) => { store.set(key, value); }),
    update: vi.fn(async (key, paths) => { store.set(key, { ...(store.get(key) ?? {}), ...paths }); }),
    remove: vi.fn(async () => {}),
  };
  const puter = { kv, auth: { getUser: async () => ({ uuid: 'me', email: 'me@example.org' }) } };
  const personal = { spaces: { list: async () => [{ ref: { w: 'trips-abcdefghij', s: SPACE, k: 'trip' }, role: 'owner', title: 'Lisbon', start: '2099-05-01' }] } };
  return { puter, personal, kv, store };
}

afterEach(() => { document.body.replaceChildren(); });

describe('Settings → Notifications', () => {
  it('renders channels, activity choices and trips, and saves path writes', async () => {
    const { puter, personal, kv } = world();
    const container = document.createElement('div');
    document.body.append(container);
    const controller = new AbortController();
    await mount(container, { puter, personal, account: { uuid: 'me' }, signal: controller.signal });
    await flush();
    expect(container.textContent).toContain('Background notifications aren’t available here');
    expect(container.querySelector('input[type=email]').value).toBe('me@example.org');
    expect(container.querySelectorAll('input[type=checkbox][aria-label]')).toHaveLength(29);
    expect(container.querySelector(`#notify-trip-${SPACE}`).value).toBe('all');
    const chat = container.querySelector('input[aria-label="Chat by ntfy"]');
    chat.click();
    await flush();
    expect(kv.update).toHaveBeenCalledWith(KEYS.prefs, { v: 1, 'events.chat': ['ntfy'] });
    const select = container.querySelector(`#notify-trip-${SPACE}`);
    select.value = 'off';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(kv.update).toHaveBeenCalledWith(KEYS.prefs, { v: 1, [`trips.${SPACE}`]: 'off' });
    controller.abort();
  });
  it('refuses a private webhook address before saving', async () => {
    const { puter, personal, kv } = world();
    const container = document.createElement('div');
    document.body.append(container);
    await mount(container, { puter, personal, account: { uuid: 'me' }, signal: new AbortController().signal });
    await flush();
    const input = container.querySelector('input[type=url]');
    input.value = 'https://192.168.1.1/hook';
    input.closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(container.textContent).toContain('Use a public address');
    expect(kv.set).not.toHaveBeenCalled();
    input.value = 'https://hooks.example.org/in';
    input.closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(kv.set).toHaveBeenCalledWith(KEYS.secret, expect.objectContaining({ webhookUrl: 'https://hooks.example.org/in', webhookSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }), { disableSharing: true });
  });
});
