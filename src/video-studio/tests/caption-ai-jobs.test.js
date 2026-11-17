import { it, expect, vi, afterEach } from 'vitest';
import { addEmojis, highlightKeywords } from '../src/ui/panels/captions.js';
import { emojiForLines, keywordsForLines } from '../src/media/transcript.js';
import { EditorStore } from '../src/model/store.js';
import { addTimeline } from '../src/model/timelines.js';
import { makeTrack, makeClip } from '../src/model/project.js';
import { fixture } from './helpers.js';

vi.mock('../src/media/transcript.js', async (orig) => ({ ...(await orig()), emojiForLines: vi.fn(), keywordsForLines: vi.fn() }));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { resolve, promise };
};

function setup() {
  const p = fixture();
  const caption = (text, start) => makeClip('text', { caption: true, text, start, duration: 1_000_000 });
  p.tracks.push(makeTrack('text', { clips: [caption('Hello', 0), caption('World', 1_000_000)] }));
  const store = new EditorStore(p);
  const texts = () => store.project.tracks.flatMap((t) => t.clips).filter((c) => c.caption).map((c) => c.text);
  return { store, ctx: { store }, texts };
}

it('adds each emoji once when the request is made twice', async () => {
  const { store, ctx, texts } = setup();
  const first = deferred();
  emojiForLines.mockReturnValueOnce(first.promise).mockResolvedValue(['🙂', '🌍']);
  const a = addEmojis(ctx);
  const b = addEmojis(ctx);
  first.resolve(['🙂', '🌍']);
  await Promise.all([a, b]);
  expect(emojiForLines).toHaveBeenCalledTimes(1);
  expect(texts()).toEqual(['Hello 🙂', 'World 🌍']);
  expect(store.history.undoStack.length).toBe(1);
  // The next request runs again.
  await addEmojis(ctx);
  expect(emojiForLines).toHaveBeenCalledTimes(2);
});

it('leaves captions edited or switched away from while the answer was out', async () => {
  const { store, ctx, texts } = setup();
  const emoji = deferred();
  emojiForLines.mockReturnValueOnce(emoji.promise);
  const a = addEmojis(ctx);
  store.update('Edit caption', (p) => {
    p.tracks.flatMap((t) => t.clips).find((c) => c.text === 'Hello').text = 'Goodbye';
  });
  emoji.resolve(['🙂', '🌍']);
  await a;
  expect(texts()).toEqual(['Goodbye', 'World 🌍']);

  const words = deferred();
  keywordsForLines.mockReturnValueOnce(words.promise);
  const k = highlightKeywords(ctx, { ai: true });
  const before = JSON.stringify(store.project.tracks);
  const other = addTimeline(store.project);
  const original = store.project.timelineId;
  store.openTimeline(other);
  words.resolve([[0], [0]]);
  await k;
  store.openTimeline(original);
  expect(JSON.stringify(store.project.tracks)).toBe(before);
});
