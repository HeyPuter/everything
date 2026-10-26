import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinkPreviews, firstLink, resetLinkPreviews } from '../../src/views/trip/collab/unfurl/index.js';

const space = { ref: { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' } };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => resetLinkPreviews());

describe('firstLink', () => {
  it('finds the first http(s) link and trims sentence punctuation', () => {
    expect(firstLink('See https://example.org/guide. Nice!')).toBe('https://example.org/guide');
    expect(firstLink('[guide](https://example.org/a) and http://b.example.org')).toBe('https://example.org/a');
    expect(firstLink('Wiki https://en.wikipedia.org/wiki/Tram_(Lisbon) here')).toBe('https://en.wikipedia.org/wiki/Tram_(Lisbon)');
    expect(firstLink('(https://example.org/x)')).toBe('https://example.org/x');
    expect(firstLink('javascript:alert(1) or ftp://x.example')).toBeNull();
    expect(firstLink('no links')).toBeNull();
  });
});

describe('createLinkPreviews', () => {
  it('renders a preview card as text, caches it and skips messages without links', async () => {
    const api = { call: vi.fn(async () => ({ preview: { title: '<b>Lisbon</b>', desc: 'Trams', image: 'https://cdn.example.org/a.jpg' } })) };
    const previews = createLinkPreviews({ api, space });
    expect(previews.node({ id: 'm1', text: 'hello' })).toBeNull();
    const holder = previews.node({ id: 'm2', text: 'look https://www.example.org/lisbon' });
    document.body.append(holder);
    await flush(); await flush();
    expect(api.call).toHaveBeenCalledWith(space.ref, 'link.unfurl', { url: 'https://www.example.org/lisbon' });
    expect(holder.hidden).toBe(false);
    const link = holder.querySelector('a.chat-preview-card');
    expect(link.getAttribute('href')).toBe('https://www.example.org/lisbon');
    expect(link.rel).toContain('noopener');
    expect(holder.querySelector('.chat-preview-title').textContent).toBe('<b>Lisbon</b>');
    expect(holder.querySelector('b')).toBeNull();
    expect(holder.querySelector('.chat-preview-host').textContent).toBe('example.org');
    const img = holder.querySelector('img');
    expect(img.referrerPolicy || img.getAttribute('referrerpolicy')).toBe('no-referrer');
    const again = previews.node({ id: 'm3', text: 'https://www.example.org/lisbon' });
    expect(again.hidden).toBe(false);
    expect(api.call).toHaveBeenCalledTimes(1);
    previews.destroy();
  });

  it('stops asking a worker that lacks the op', async () => {
    const api = { call: vi.fn(async () => { throw Object.assign(new Error('unknown_op'), { status: 400, code: 'unknown_op' }); }) };
    const previews = createLinkPreviews({ api, space });
    document.body.append(previews.node({ id: 'm1', text: 'https://a.example.org/' }));
    await flush(); await flush();
    expect(previews.node({ id: 'm2', text: 'https://b.example.org/' })).toBeNull();
    expect(api.call).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a worker client', () => {
    expect(createLinkPreviews({ api: null, space }).node({ id: 'm1', text: 'https://a.example.org/' })).toBeNull();
  });
});
