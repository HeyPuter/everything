import { describe, it, expect, afterEach, vi } from 'vitest';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Boots main.js on a #view= link whose fetch returns `data`. */
async function openShared(data) {
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="app" class="app" aria-busy="true"></div><div id="live-region"></div>';
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => data }));
  window.location.hash = `#view=${encodeURIComponent('https://example.com/shared.json')}`;
  vi.resetModules();
  await import('../src/main.js');
  for (let i = 0; i < 20 && !document.querySelector('.shared-view .page'); i++) await tick(5);
  await tick(20);
  return document.getElementById('app');
}

const PAGE = { format: 'notes-shared-page', v: 2, title: 'Trip', created: '2026-10-20T10:00:00.000Z', published: '2026-10-20T10:00:00.000Z', outlines: [{ x: 40, y: 120, w: 300, html: '<p>Pack the tent</p>' }], ink: [] };

describe('shared page view', () => {
  afterEach(() => {
    window.location.hash = '';
    delete globalThis.fetch;
  });

  it('shows the page on phones, where the app hides it unless the page level is current', async () => {
    const root = await openShared(PAGE);
    expect(root.querySelector('.outline-body').textContent).toBe('Pack the tent');
    expect(root.dataset.mobileView).toBe('page');
  });
});
