import { afterEach, describe, it, expect, vi } from 'vitest';
import { fileNameForPrompt, parseDataUrl, imageFileFromSource, generationError } from '../src/lib/imagegen.js';

// A 1x1 PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

afterEach(() => vi.restoreAllMocks());

describe('image from a description', () => {
  it('names the file after the description', () => {
    expect(fileNameForPrompt('A red fox, in snow!')).toBe('a-red-fox-in-snow.png');
    expect(fileNameForPrompt('   ', 'jpg')).toBe('picture.jpg');
    expect(fileNameForPrompt('x'.repeat(80))).toBe(`${'x'.repeat(40)}.png`);
  });

  it('parses data URLs', () => {
    const p = parseDataUrl(`data:image/png;base64,${PNG_B64}`);
    expect(p.type).toBe('image/png');
    expect(p.bytes.length).toBe(70);
    expect(parseDataUrl('data:text/plain,hello%20there').bytes.length).toBe(11);
    expect(parseDataUrl('https://example.com/a.png')).toBeNull();
    expect(() => parseDataUrl('data:image/png;base64,not*valid*base64')).toThrow('The answer was not a picture');
  });

  it('imports percent-encoded binary images without treating bytes as UTF-8 text', async () => {
    const expected = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
    const src = `data:image/png,${[...expected].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')}`;
    const file = await imageFileFromSource(src, 'tiny image', { maxBytes: expected.length });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(expected);
    expect(file.name).toBe('tiny-image.png');
    await expect(imageFileFromSource(src, 'too large', { maxBytes: expected.length - 1 })).rejects.toThrow('15 MB');
  });

  it.each(['plain+text%20here', '✓%E2%9C%93😊', '%00%80%FF', 'literal%bad%GG%'])('decodes %j like the platform data-URL reader', async (payload) => {
    const src = `data:image/svg+xml,${payload}`;
    const expected = new Uint8Array(await (await fetch(src)).arrayBuffer());
    expect(parseDataUrl(src, { maxBytes: expected.length }).bytes).toEqual(expected);
    expect(() => parseDataUrl(src, { maxBytes: expected.length - 1 })).toThrow('15 MB');
  });

  it('turns an image element into a File, from a data URL or by fetching', async () => {
    const img = { src: `data:image/png;base64,${PNG_B64}` };
    const f = await imageFileFromSource(img, 'a red fox');
    expect(f.name).toBe('a-red-fox.png');
    expect(f.type).toBe('image/png');
    expect(f.size).toBe(70);
    const fetched = await imageFileFromSource('https://api.example/out.jpg', 'sunset', { fetchFn: async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(3)], { type: 'image/jpeg' }) }) });
    expect(fetched.name).toBe('sunset.jpg');
    await expect(imageFileFromSource('https://api.example/out', 'x', { fetchFn: async () => ({ ok: false, status: 500 }) })).rejects.toThrow('500');
    await expect(imageFileFromSource('https://api.example/out', 'x', { fetchFn: async () => ({ ok: true, blob: async () => new Blob(['nope'], { type: 'text/plain' }) }) })).rejects.toThrow('not a picture');
    await expect(imageFileFromSource(null, 'x')).rejects.toThrow('No picture');
    await expect(imageFileFromSource(img, 'x', { maxBytes: 10 })).rejects.toThrow('15 MB');
  });

  it('rejects oversized inline images before allocating their decoded data', async () => {
    const decode = vi.spyOn(globalThis, 'atob');
    await expect(imageFileFromSource(`data:image/png;base64,${PNG_B64}`, 'image', { maxBytes: 10 })).rejects.toThrow('15 MB');
    expect(decode).not.toHaveBeenCalled();
  });

  it('stops a generated image download at the byte limit even without a Content-Length', async () => {
    const read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(6) });
    const cancel = vi.fn(async () => {}), releaseLock = vi.fn();
    const response = { ok: true, headers: new Headers({ 'content-type': 'image/png' }),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
      blob: vi.fn(async () => new Blob([new Uint8Array(100)], { type: 'image/png' })),
    };
    await expect(imageFileFromSource('https://example.com/image', 'image', { fetchFn: async () => response, maxBytes: 10 })).rejects.toThrow('15 MB');
    expect(read).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(response.blob).not.toHaveBeenCalled();
  });

  it('accepts images at the size boundary and rejects an oversized declared response before reading', async () => {
    const src = `data:image/png;base64,${PNG_B64}`;
    expect((await imageFileFromSource(src, 'exact', { maxBytes: 70 })).size).toBe(70);
    const file = await imageFileFromSource('https://example.com/image', 'stream', {
      maxBytes: 70, fetchFn: async () => new Response(parseDataUrl(src).bytes, { headers: { 'content-type': 'image/png' } }),
    });
    expect(file.size).toBe(70); expect(file.type).toBe('image/png');
    const cancel = vi.fn(async () => {}), blob = vi.fn();
    await expect(imageFileFromSource('https://example.com/image', 'large', {
      maxBytes: 70, fetchFn: async () => ({ ok: true, headers: new Headers({ 'content-length': '71' }), body: { cancel }, blob }),
    })).rejects.toThrow('15 MB');
    expect(cancel).toHaveBeenCalledOnce(); expect(blob).not.toHaveBeenCalled();
    expect(parseDataUrl('data:image/svg+xml,%E2%9C%93', { maxBytes: 3 }).bytes).toHaveLength(3);
    expect(() => parseDataUrl('data:image/svg+xml,%E2%9C%93', { maxBytes: 2 })).toThrow('15 MB');
  });
});

describe('a picture that could not be made', () => {
  it('is explained in plain words, whatever shape the SDK rejected with', () => {
    // Puter's SDK rejects with its own { error: { code, message } } object, not an Error: "[object Object]" before.
    const sdkError = { success: false, error: { code: 'insufficient_funds', message: 'Insufficient funds' } };
    expect(generationError(sdkError).message).toBe('Your Puter AI allowance has run out for now.');
    expect(generationError(sdkError).cause).toBe(sdkError);
    expect(generationError({ error: { code: 'unauthorized' } }).message).toBe('Sign in to Puter to generate pictures.');
    expect(generationError(new TypeError('Failed to fetch')).message).toBe('The AI service could not be reached. Check your connection.');
    expect(generationError({ error: { message: 'Your request was rejected by the safety system.' } }).message).toMatch(/Try describing it differently/);
    for (const other of [new Error('Request failed with status code 500'), 'oops', undefined, {}]) expect(generationError(other).message).toBe('The picture could not be generated. Try again in a moment.');
  });
});
