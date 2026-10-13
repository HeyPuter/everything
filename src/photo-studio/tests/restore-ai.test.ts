// Portrait & Restore AI options with a mocked Puter SDK: what is sent, the
// instructions and the size of the result.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rgba8, type RGBA8 } from '../src/imaging/types';
import { aiCodec, transformImage } from '../src/imaging/ai/puter-ai';
import { normalizeRestore } from '../src/imaging/restore/defs';
import { aiInstruction, aiSummary } from '../src/features/restore/ai';

const g = globalThis as unknown as { puter?: unknown };
const codec = { ...aiCodec };
let encoded: { width: number; height: number }[] = [];
beforeEach(() => {
  encoded = [];
  aiCodec.toDataUri = async (img: RGBA8) => {
    encoded.push({ width: img.width, height: img.height });
    return `data:image/png;base64,${img.width}x${img.height}`;
  };
  aiCodec.decode = async (_res, w, h) => rgba8(w ?? 512, h ?? 512, [200, 100, 50, 255]);
});
afterEach(() => {
  delete g.puter;
  Object.assign(aiCodec, codec);
});
const entry = (id: string, extra: Record<string, unknown> = {}) => normalizeRestore({ filters: [{ id, enabled: true, ...extra }] }).filters.find((f) => f.id === id)!;

describe('Portrait & Restore AI', () => {
  it('writes complete instructions for each AI option and needs a prompt where it has none', () => {
    expect(aiInstruction(entry('colorize'))).toMatch(/Colorize this black-and-white photograph/);
    expect(aiInstruction(entry('scene', { params: { preset: 'winter' } }))).toMatch(/snow/);
    expect(aiInstruction(entry('scene', { params: { preset: 'custom' } }))).toBeUndefined();
    expect(aiInstruction(entry('scene', { params: { preset: 'custom' }, prompt: 'a misty morning.' }))).toContain('a misty morning. Change only');
    expect(aiInstruction(entry('style', { params: { style: 'ai' } }))).toBeUndefined();
    expect(aiInstruction(entry('style', { params: { style: 'ai' }, prompt: 'a woodcut print' }))).toContain('Restyle this photo as a woodcut print');
    expect(aiInstruction(entry('skin'))).toBeUndefined();
    expect(aiSummary(entry('scene', { params: { preset: 'night' } }))).toBe('Scene: Night');
  });
  it('sends the image (and a reference) reduced to 1024 pixels and returns the input size', async () => {
    const txt2img = vi.fn(async () => ({ src: 'x' }));
    g.puter = { ai: { txt2img, chat: vi.fn() } };
    const out = await transformImage(rgba8(2048, 1024), 'Edit this photo to show night.', { reference: rgba8(3000, 3000) });
    expect(txt2img).toHaveBeenCalledTimes(1);
    const [prompt, opts] = txt2img.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(prompt).toBe('Edit this photo to show night.');
    expect(opts.input_images).toEqual(['data:image/png;base64,1024x512', 'data:image/png;base64,1024x1024']);
    expect(encoded).toEqual([
      { width: 1024, height: 512 },
      { width: 1024, height: 1024 },
    ]);
    expect([out.width, out.height]).toEqual([2048, 1024]);
    await transformImage(rgba8(100, 80), 'Colorize.');
    const opts2 = (txt2img.mock.calls[1] as unknown as [string, Record<string, unknown>])[1];
    expect(opts2.input_image).toBe('data:image/png;base64,100x80');
    await expect(transformImage(rgba8(10, 10), '  ')).rejects.toThrow(/Describe/);
  });
  it('reports a missing Puter SDK as unavailable', async () => {
    await expect(transformImage(rgba8(10, 10), 'Colorize.')).rejects.toThrow(/Puter/);
  });
});
