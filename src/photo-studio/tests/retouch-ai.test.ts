import { afterEach, describe, expect, it, vi } from 'vitest';
import { mask8, rgba8 } from '../src/imaging/types';
import { AIError, aiCodec, aiExpand, aiFill, describeImage, toAIError } from '../src/imaging/ai/puter-ai';

const g = globalThis as unknown as { puter?: unknown };
afterEach(() => {
  delete g.puter;
});

describe('Puter AI wrapper', () => {
  it('maps Puter error codes to user-facing errors', () => {
    expect(toAIError({ code: 'moderation_flagged', message: 'x' }).code).toBe('moderation');
    expect(toAIError({ code: 'insufficient_funds' }).code).toBe('funds');
    const up = toAIError({ code: 'upstream_failed', message: 'provider down' });
    expect([up.code, up.retryable, up.message]).toEqual(['upstream', true, 'provider down']);
    expect(toAIError({ code: 'upstream_rejected' }).retryable).toBe(false);
    expect(toAIError({ code: 'network_error' }).code).toBe('network');
    expect(toAIError({ code: 'prompt_required' }).code).toBe('bad-request');
    expect(toAIError('boom').message).toBe('boom');
    const e = new AIError('cancelled', 'Cancelled.');
    expect(toAIError(e)).toBe(e);
  });
  it('fails cleanly without Puter and never calls it for empty input', async () => {
    const img = rgba8(8, 8, [1, 2, 3, 255]);
    const m = mask8(8, 8);
    m.data[10] = 255;
    await expect(aiFill(img, m, 'a boat')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(describeImage(img)).rejects.toMatchObject({ code: 'unavailable' });
    const txt2img = vi.fn(), chat = vi.fn();
    g.puter = { ai: { txt2img, chat } };
    await expect(aiFill(img, m, '   ')).rejects.toMatchObject({ code: 'bad-request' });
    const same = await aiFill(img, mask8(8, 8), 'a boat');
    expect([...same.data]).toEqual([...img.data]);
    const noGrow = await aiExpand(img, { left: 0, top: 0, right: 0, bottom: 0 });
    expect(noGrow.width).toBe(8);
    expect(txt2img).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });
  it('honours an already aborted signal before sending anything', async () => {
    const txt2img = vi.fn();
    g.puter = { ai: { txt2img, chat: vi.fn() } };
    const ac = new AbortController();
    ac.abort();
    const m = mask8(4, 4, 255);
    await expect(aiFill(rgba8(4, 4), m, 'sky', { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(txt2img).not.toHaveBeenCalled();
  });
  it('reports a reply without an image as a decode error, not a connection failure', async () => {
    const toDataUri = aiCodec.toDataUri;
    aiCodec.toDataUri = async () => 'data:image/png;base64,iVBORw0KGgo=';
    try {
      const m = mask8(4, 4, 255);
      for (const reply of [undefined, null, {}, { src: '' }, 42]) {
        g.puter = { ai: { txt2img: vi.fn(async () => reply), chat: vi.fn() } };
        const error = await aiFill(rgba8(4, 4), m, 'sky').catch((e) => e);
        expect(error).toBeInstanceOf(AIError);
        expect(toAIError(error)).toMatchObject({ code: 'decode', retryable: true });
      }
    } finally {
      aiCodec.toDataUri = toDataUri;
    }
  });
});
