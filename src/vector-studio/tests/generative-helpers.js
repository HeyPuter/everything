// A fake Puter AI client and synthetic pictures for the generative tests.
import { makeImage } from './trace-helpers.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake of puter.ai: txt2img answers with an { src } object and chat with
 * a { message: { content } } object, from the given functions. `calls`
 * records every request; `gate` (a promise) holds answers back until it
 * resolves, for cancellation tests.
 */
export function fakeAI({ image = () => 'data:image/png;base64,AAAA', chat = () => '[]', delay = 0, gate = null, fail = null } = {}) {
  const calls = { txt2img: [], chat: [] };
  return {
    calls,
    async txt2img(prompt, options) {
      calls.txt2img.push({ prompt, options });
      if (gate) await gate;
      if (delay) await wait(delay);
      if (fail?.txt2img) throw fail.txt2img;
      return { src: image(prompt, options) };
    },
    async chat(prompt, img) {
      calls.chat.push({ prompt, image: img });
      if (gate) await gate;
      if (delay) await wait(delay);
      if (fail?.chat) throw fail.chat;
      return { message: { content: chat(prompt, img) } };
    },
  };
}

/** A red disk on white, the kind of picture "a subject" prompts produce. */
export function diskPicture(size = 48, color = [220, 30, 40]) {
  const c = size / 2;
  const r = size * 0.3;
  return makeImage(size, size, (x, y) => (Math.hypot(x - c, y - c) < r ? color : [255, 255, 255]), 2);
}

/** Two vertical color bands (a pattern-ish tile). */
export function stripesPicture(size = 40) {
  return makeImage(size, size, (x) => (Math.floor(x / (size / 4)) % 2 ? [30, 60, 200] : [250, 210, 40]));
}

export const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Wait until fn() is truthy (polling macrotasks). */
export async function until(fn, { tries = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Timed out waiting for condition');
}
