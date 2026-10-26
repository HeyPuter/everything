import { afterEach, describe, expect, it } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { mount } from '../../src/views/settings/integrations.js';
import { INTEGRATIONS_KEY } from '../../src/lib/integrations/store.js';
import { immichEntry } from '../../src/views/integrations/entry.js';
import { fakeNet } from './helpers/fake-net.js';

const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

function setup(routes) {
  const runtime = createFakePuter({ now: 1_000_000 });
  const puter = runtime.client('alice');
  const net = fakeNet(routes);
  puter.net = net.puter.net;
  return { puter, net };
}

afterEach(() => { document.body.replaceChildren(); });

describe('Settings → Integrations', () => {
  it('tests the key before saving it and never puts a saved key back into the page', async () => {
    const { puter, net } = setup({ 'GET /api/v1/me': (url, init) => (init.headers.authorization === 'Bearer good-key' ? { json: { data: { id: 'u1', displayName: 'Alice' } } } : { status: 401, json: {} }) });
    const container = document.createElement('div');
    document.body.append(container);
    const controller = new AbortController();
    await mount(container, { puter, signal: controller.signal });
    await flush();
    const section = container.querySelector('[data-service="airtrail"]');
    const [url, key] = section.querySelectorAll('input');
    url.value = 'air.example.com/'; key.value = 'bad-key';
    section.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(section.querySelector('.int-status').dataset.state).toBe('error');
    expect(await puter.kv.get(INTEGRATIONS_KEY)).toBeNull();

    key.value = 'good-key';
    section.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(await puter.kv.get(INTEGRATIONS_KEY)).toEqual({ v: 1, airtrail: { url: 'https://air.example.com', key: 'good-key', sync: true } });
    expect(net.calls.at(-1).url.href).toBe('https://air.example.com/api/v1/me');
    expect(section.querySelector('.int-status').textContent).toContain('Alice');
    expect(key.value).toBe('');
    expect(container.innerHTML).not.toContain('good-key');
    controller.abort();
  });

  it('disconnects after confirmation', async () => {
    const { puter } = setup({});
    await puter.kv.set(INTEGRATIONS_KEY, { v: 1, immich: { url: 'https://photos.example.com', key: 'k' } });
    const container = document.createElement('div');
    document.body.append(container);
    await mount(container, { puter, signal: new AbortController().signal });
    await flush();
    const section = container.querySelector('[data-service="immich"]');
    const remove = [...section.querySelectorAll('button')].find((node) => node.textContent === 'Disconnect');
    expect(remove.hidden).toBe(false);
    remove.click();
    await flush();
    [...document.querySelectorAll('.modal-root button')].find((node) => node.textContent === 'Disconnect').click();
    await flush();
    expect(await puter.kv.get(INTEGRATIONS_KEY)).toBeNull();
  });

  it('shows the Immich entry only when Immich is set up and the view allows uploads', async () => {
    const { puter } = setup({});
    await puter.kv.set(INTEGRATIONS_KEY, { v: 1, immich: { url: 'https://photos.example.com', key: 'k' } });
    const entry = immichEntry({ puter }, { onFiles: () => {} });
    entry.update({ visible: true });
    await flush();
    expect(entry.element.hidden).toBe(false);
    entry.update({ visible: false });
    expect(entry.element.hidden).toBe(true);
    entry.destroy();
    const bare = immichEntry({ puter: { authToken: 'x', kv: puter.kv } }, { onFiles: () => {} });
    bare.update({ visible: true });
    await flush();
    expect(bare.element.hidden).toBe(true);
  });
});
