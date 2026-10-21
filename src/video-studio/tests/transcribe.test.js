import { describe, it, expect, afterEach } from 'vitest';
import { transcribePiece } from '../src/media/transcribe.js';

const RATE = 16000;

describe('speech to text', () => {
  const real = globalThis.puter;
  afterEach(() => {
    globalThis.puter = real;
  });

  /** A Puter stand-in answering each speech2txt call with the next of answers (an Error is thrown). */
  function answering(...answers) {
    const calls = [];
    globalThis.puter = { ai: { speech2txt: async (...args) => {
      calls.push(args);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a;
    } } };
    return calls;
  }

  it('asks once for a piece with no speech in it', async () => {
    const calls = answering({ text: '', words: [] });
    expect(await transcribePiece(new Float32Array(RATE * 2), RATE)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ provider: 'xai' });
  });

  it('asks the default model only when the first one fails', async () => {
    const calls = answering(new Error('busy'), { words: [{ text: 'hi', start: 0.5, end: 0.8 }] });
    expect(await transcribePiece(new Float32Array(RATE * 2), RATE)).toEqual([{ text: 'hi', start: 0.5, end: 0.8 }]);
    expect(calls).toHaveLength(2);
    answering(new Error('busy'), new Error('down'));
    await expect(transcribePiece(new Float32Array(RATE), RATE)).rejects.toThrow('down');
  });
});
