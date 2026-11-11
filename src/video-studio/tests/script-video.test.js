import { describe, it, expect, vi } from 'vitest';
import { US } from '../src/lib/time.js';
import { normalizeAsset, normalizeProject } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { evaluate } from '../src/engine/scene.js';
import {
  chatText, extractJson, scriptPrompt, cleanScript, splitSentences, splitScenes, picturesPrompt, parsePictures,
  pictureText, projectName, estimateSpeech, sceneTimes, alignWords, layoutScenes, musicBed, scriptProject,
  insertScenes, generateScenes, problemSummary, LEAD, TAIL, CROSSFADE, MIN_SCENE,
} from '../src/media/script-video.js';
import { fixture, s, onMain, clip, noOverlaps } from './helpers.js';

describe('script to video: writing and splitting', () => {
  it('reads chat replies in their different shapes', () => {
    expect(chatText('hi')).toBe('hi');
    expect(chatText({ message: { content: [{ text: 'a' }, { text: 'b' }] } })).toBe('ab');
    expect(chatText({ message: { content: 'c' } })).toBe('c');
    expect(chatText(null)).toBe('');
  });

  it('pulls JSON out of chatter and code fences', () => {
    expect(extractJson('Sure!\n```json\n["a","b"]\n```\nEnjoy [really]')).toEqual(['a', 'b']);
    expect(extractJson('{"x": 1} and more }')).toEqual({ x: 1 });
    expect(extractJson('no json here')).toBe(null);
  });

  it('builds a script prompt with topic, tone and length', () => {
    const p = scriptPrompt({ topic: 'how bees make honey', tone: 'Calm', length: 'short' });
    expect(p).toMatch(/how bees make honey/);
    expect(p).toMatch(/calm/);
    expect(p).toMatch(/about 75 words/);
    expect(p).toMatch(/short paragraphs/);
  });

  it('cleans headings, labels and stage directions out of a script', () => {
    const text = '# My video\n\nScene 1: Bees are busy. [upbeat music]\n\n**Narrator:** They visit flowers.\n- Then they fly home.';
    expect(cleanScript(text)).toBe('Bees are busy.\n\nThey visit flowers.\nThen they fly home.');
  });

  it('splits sentences keeping their punctuation', () => {
    expect(splitSentences('One. Two? Three! "Four." five')).toEqual(['One.', 'Two?', 'Three!', '"Four."', 'five']);
  });

  it('makes one scene per paragraph and splits long ones between sentences', () => {
    const long = Array.from({ length: 6 }, (_, i) => `Sentence number ${i} has exactly seven words here.`).join(' ');
    const scenes = splitScenes(`A short opening line that has enough words.\n\n${long}`, { maxWords: 20 });
    expect(scenes[0].narration).toBe('A short opening line that has enough words.');
    expect(scenes.slice(1).every((x) => x.narration.split(' ').length <= 20)).toBe(true);
    expect(scenes.slice(1).map((x) => x.narration).join(' ')).toBe(long);
    expect(scenes.every((x) => x.picture === '')).toBe(true);
  });

  it('joins very short scenes to their neighbor and caps the count', () => {
    const scenes = splitScenes('Hi.\n\nThis is a longer paragraph about something good.');
    expect(scenes).toHaveLength(1);
    expect(scenes[0].narration).toBe('Hi. This is a longer paragraph about something good.');
    const many = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} is long enough to stand alone.`).join('\n\n');
    expect(splitScenes(many, { maxScenes: 10 }).length).toBeLessThanOrEqual(10);
    expect(splitScenes('   ')).toEqual([]);
  });

  it('asks for picture descriptions and reads them back to the scene count', () => {
    const scenes = [{ narration: 'Bees fly.' }, { narration: 'Honey drips.' }];
    const p = picturesPrompt({ scenes, topic: 'bees', style: 'watercolor' });
    expect(p).toMatch(/exactly 2 strings/);
    expect(p).toMatch(/"Bees fly\."/);
    expect(p).toMatch(/watercolor/);
    expect(parsePictures('["a bee on a flower", 5, "x"]', 2)).toEqual(['a bee on a flower', '']);
    expect(parsePictures({ message: { content: '{"pictures":[{"picture":"hive"}]}' } }, 3)).toEqual(['hive', '', '']);
    expect(parsePictures('nonsense', 2)).toEqual(['', '']);
    expect(pictureText({ narration: 'Bees fly.', picture: ' ' })).toBe('Bees fly.');
    expect(pictureText({ narration: 'Bees fly.', picture: 'a bee' })).toBe('a bee');
  });

  it('names the project from the first line', () => {
    expect(projectName('How bees make honey, and why it matters so much to us all')).toBe('How bees make honey, and why it');
    expect(projectName('')).toBe('Script video');
  });
});

describe('script to video: timing', () => {
  it('estimates speech from the word count', () => {
    expect(estimateSpeech('one two three four five')).toBe(2 * US);
    expect(estimateSpeech('hi')).toBe(US);
  });

  it('lays scenes end to end with lead and tail around the narration', () => {
    const t = sceneTimes([s(3), s(0.5), s(4)]);
    expect(t[0]).toEqual({ start: 0, duration: LEAD + s(3) + TAIL, voiceStart: LEAD });
    expect(t[1].start).toBe(t[0].duration);
    expect(t[1].duration).toBe(MIN_SCENE);
    expect(t[2].start).toBe(t[1].start + MIN_SCENE);
    expect(t[2].voiceStart).toBe(t[2].start + LEAD);
    // The crossfade sits around the cut, inside the silence on both sides.
    expect(CROSSFADE / 2).toBeLessThan(LEAD);
    expect(CROSSFADE / 2).toBeLessThan(TAIL);
  });

  it('uses heard word times one to one when the counts match', () => {
    const heard = [{ text: 'hello', start: 0.1, end: 0.5 }, { text: 'world', start: 0.6, end: 1 }];
    expect(alignWords('Hello world.', heard, s(1.2))).toEqual({ timing: 'speech', words: [{ text: 'Hello', start: 0.1, end: 0.5 }, { text: 'world.', start: 0.6, end: 1 }] });
  });

  it('maps narration words through heard words when the counts differ', () => {
    const heard = [{ text: 'it', start: 0, end: 0.2 }, { text: 'costs', start: 0.3, end: 0.6 }, { text: 'twenty', start: 0.7, end: 1 }, { text: 'dollars', start: 1.1, end: 1.5 }];
    const { words, timing } = alignWords('It costs $20.', heard, s(2));
    expect(timing).toBe('speech');
    expect(words.map((w) => w.text)).toEqual(['It', 'costs', '$20.']);
    expect(words[0].start).toBe(0);
    expect(words[2].end).toBeCloseTo(1.5);
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start);
  });

  it('spreads words over the voice when nothing was heard', () => {
    const { words, timing } = alignWords('one two three', null, s(3));
    expect(timing).toBe('estimate');
    expect(words).toHaveLength(3);
    expect(words[0].start).toBe(0);
    expect(words[2].end).toBeCloseTo(3);
  });
});

const voiceAsset = (id, sec) => normalizeAsset({ id, kind: 'audio', name: `${id}.mp3`, duration: s(sec), hasAudio: true });
const imageAsset = (id) => normalizeAsset({ id, kind: 'image', name: `${id}.png`, width: 1920, height: 1080 });

function madeScenes() {
  return [
    { narration: 'Bees are busy all day.', words: alignWords('Bees are busy all day.', null, s(2)).words, voice: { assetId: 'v1', duration: s(2) }, image: { assetId: 'i1', name: 'i1.png' } },
    { narration: 'They make honey.', words: alignWords('They make honey.', null, s(1.5)).words, voice: { assetId: 'v2', duration: s(1.5) }, image: { assetId: 'i2', name: 'i2.png' } },
    { narration: 'And we love it.', words: alignWords('And we love it.', null, s(1.6)).words, voice: null, image: { assetId: 'i3', name: 'i3.png' } },
  ];
}

describe('script to video: layout', () => {
  it('times pictures to their narration with crossfades, motion and captions', () => {
    const lay = layoutScenes(madeScenes(), { width: 1920, captions: 'clean-caption' });
    expect(lay.pictures).toHaveLength(3);
    expect(lay.pictures[0]).toMatchObject({ type: 'image', assetId: 'i1', start: 0, duration: LEAD + s(2) + TAIL });
    expect(lay.pictures[1].start).toBe(lay.pictures[0].duration);
    expect(lay.pictures.map((c) => c.transition?.id ?? null)).toEqual(['mix', 'mix', null]);
    expect(lay.pictures.every((c) => c.animLoop && c.animLoop.duration === c.duration)).toBe(true);
    expect(new Set(lay.pictures.map((c) => c.animLoop.id)).size).toBe(3);
    // The scene without a voice is timed by its word count.
    expect(lay.voices.map((v) => [v.assetId, v.start])).toEqual([['v1', LEAD], ['v2', lay.pictures[1].start + LEAD]]);
    expect(lay.pictures[2].duration).toBe(LEAD + estimateSpeech('And we love it.') + TAIL);
    expect(lay.duration).toBe(lay.pictures[2].start + lay.pictures[2].duration);
    // Captions follow the speech and never cross into the next scene.
    expect(lay.captions.length).toBeGreaterThanOrEqual(3);
    expect(lay.captions.every((c) => c.caption && c.type === 'text')).toBe(true);
    expect(lay.captions[0].start).toBeGreaterThanOrEqual(LEAD - 1);
    for (const c of lay.captions) {
      const pic = lay.pictures.find((p) => c.start >= p.start && c.start < p.start + p.duration);
      expect(c.start + c.duration).toBeLessThanOrEqual(pic.start + pic.duration);
    }
    expect(lay.captions.map((c) => c.text.replace(/\n/g, ' ')).join(' ')).toBe('Bees are busy all day. They make honey. And we love it.');
  });

  it('leaves captions out when switched off', () => {
    expect(layoutScenes(madeScenes(), { captions: '' }).captions).toEqual([]);
  });

  it('repeats the music to cover the video and turns it down under speech', () => {
    const clips = musicBed({ assetId: 'm', duration: s(10) }, s(25), [[1, 4], [12, 20]], { volume: 0.5, duckDb: 12 });
    expect(clips.map((c) => [c.start / US, c.duration / US])).toEqual([[0, 10], [10, 10], [20, 5]]);
    expect(clips[0].fadeIn).toBeGreaterThan(0);
    expect(clips[2].fadeOut).toBeGreaterThan(0);
    const keys = clips[0].keyframes.volume;
    const at = (t) => keys.reduce((v, k) => (k.t <= s(t) ? k.v : v), 0.5);
    expect(at(0)).toBe(0.5);
    expect(at(2)).toBeCloseTo(0.5 * 10 ** (-12 / 20), 3);
    // The second loop starts ducked: speech runs 12..20 s, which is 2..10 s into it.
    expect(clips[1].keyframes.volume.some((k) => k.v < 0.2)).toBe(true);
  });

  it('builds a new project with pictures on the base track, captions above and sound below', () => {
    const lay = layoutScenes(madeScenes(), { width: 1080, captions: 'yellow-caption', music: { assetId: 'm', duration: s(30), name: 'Bed' } });
    const assets = [voiceAsset('v1', 2), voiceAsset('v2', 1.5), imageAsset('i1'), imageAsset('i2'), imageAsset('i3'), voiceAsset('m', 30)];
    const p = normalizeProject(scriptProject(lay, assets, { name: 'Bees', ratio: '9:16' }));
    expect(p.name).toBe('Bees');
    expect(p.settings).toMatchObject({ width: 1080, height: 1920, ratio: '9:16' });
    expect(p.tracks.map((t) => (t.main ? 'main' : t.kind))).toEqual(['text', 'main', 'audio', 'audio']);
    expect(p.tracks[1].clips).toHaveLength(3);
    expect(p.tracks[1].clips[0].transition).toEqual({ id: 'mix', duration: CROSSFADE });
    expect(p.tracks[3].clips[0].keyframes.volume.length).toBeGreaterThan(2);
    expect(noOverlaps(p)).toBe(true);
    // The compositor crossfades at the first cut.
    const cut = p.tracks[1].clips[0].duration;
    const layers = evaluate(p, cut);
    expect(layers.some((l) => l.kind === 'transition' && l.id === 'mix')).toBe(true);
  });

  it('inserts at the playhead above existing clips as one undo step', () => {
    const p = fixture();
    onMain(p, clip('video', 0, 10));
    const store = new EditorStore(p);
    const lay = layoutScenes(madeScenes(), { captions: 'clean-caption' });
    const assets = [voiceAsset('v1', 2), voiceAsset('v2', 1.5), imageAsset('i1'), imageAsset('i2'), imageAsset('i3')];
    const before = store.history.undoStack.length;
    let ids;
    store.update('Script to video', (proj) => {
      ids = insertScenes(proj, lay, assets, s(4));
    });
    expect(store.history.undoStack.length).toBe(before + 1);
    const proj = store.project;
    expect(proj.tracks.map((t) => (t.main ? 'main' : t.kind))).toEqual(['text', 'video', 'main', 'audio']);
    expect(proj.tracks[1].clips[0].start).toBe(s(4));
    expect(proj.tracks[2].clips).toHaveLength(1);
    expect(ids.length).toBe(lay.pictures.length + lay.captions.length + lay.voices.length);
    expect(proj.assets.i1).toBeTruthy();
    store.undo();
    expect(store.project.tracks).toHaveLength(1);
    expect(store.project.assets.i1).toBeUndefined();
  });

  it('uses the empty base track when there is one', () => {
    const p = fixture();
    const lay = layoutScenes(madeScenes(), { captions: '' });
    insertScenes(p, lay, [], 0);
    expect(p.tracks.find((t) => t.main).clips).toHaveLength(3);
  });
});

/** Fake services: media is "stored" as assets whose duration comes from the blob's size. */
function fakeServices({ failImage = new Set(), failVoice = new Set(), heard = true } = {}) {
  let n = 0;
  const calls = { image: [], speech: [], words: 0, backdrop: [] };
  return {
    calls,
    image: vi.fn(async (prompt) => {
      calls.image.push(prompt);
      if (failImage.has(calls.image.length)) throw new Error('declined');
      return new Blob(['png'], { type: 'image/png' });
    }),
    speech: vi.fn(async (text) => {
      calls.speech.push(text);
      if (failVoice.has(calls.speech.length)) throw new Error('voice down');
      // One second of "speech" per three words.
      return new Blob([text], { type: 'audio/mpeg' });
    }),
    words: vi.fn(async (asset, blob) => {
      calls.words++;
      if (!heard) return null;
      const text = await blob.text();
      const toks = text.split(/\s+/);
      const per = asset.duration / US / toks.length;
      return toks.map((t, i) => ({ text: t.toLowerCase().replace(/[^a-z]/g, ''), start: i * per, end: (i + 0.8) * per }));
    }),
    backdrop: vi.fn(async (i) => {
      calls.backdrop.push(i);
      return new File(['bd'], `Backdrop ${i}.png`, { type: 'image/png' });
    }),
    music: vi.fn(async () => new Blob(['wav'], { type: 'audio/wav' })),
    addMedia: vi.fn(async (file, origin) => {
      n++;
      const kind = file.type.startsWith('image/') ? 'image' : 'audio';
      const text = kind === 'audio' && origin === 'speech' ? await file.text() : '';
      const duration = origin === 'music' ? s(20) : kind === 'audio' ? s(text.split(/\s+/).length / 3) : 0;
      return normalizeAsset({ id: `a${n}`, kind, name: file.name, duration, hasAudio: kind === 'audio', width: 1920, height: 1080, origin });
    }),
  };
}

const SCENES = [
  { narration: 'Bees visit thousands of flowers every single day.', picture: 'a bee on a sunflower' },
  { narration: 'Back at the hive they turn nectar into honey.', picture: '' },
  { narration: 'A single spoonful is the work of many bees.', picture: 'a spoon of honey' },
];

describe('script to video: generating', () => {
  it('makes voices, pictures and timed captions for every scene', async () => {
    const svc = fakeServices();
    const progress = [];
    const res = await generateScenes(SCENES, { voice: 'polly', style: 'photo', aspect: '16:9', width: 1920, height: 1080, captions: 'clean-caption' }, svc, { onProgress: (p) => progress.push(p) });
    expect(svc.calls.image).toEqual(['a bee on a sunflower', 'Back at the hive they turn nectar into honey.', 'a spoon of honey']);
    expect(svc.calls.speech).toHaveLength(3);
    expect(svc.calls.words).toBe(3);
    expect(res.problems).toEqual([]);
    expect(res.timing).toBe('speech');
    expect(res.assets).toHaveLength(6);
    expect(res.layout.pictures).toHaveLength(3);
    expect(res.layout.voices).toHaveLength(3);
    // Each picture lasts as long as its narration plus the padding.
    res.layout.pictures.forEach((pic, i) => expect(pic.duration).toBe(LEAD + res.layout.voices[i].duration + TAIL));
    expect(res.layout.captions.length).toBeGreaterThan(3);
    expect(progress.at(-1).done).toBe(progress.at(-1).total);
  });

  it('keeps going when a picture fails, with a backdrop in its place', async () => {
    const svc = fakeServices({ failImage: new Set([2]) });
    const res = await generateScenes(SCENES, { voice: 'polly', captions: 'clean-caption' }, svc);
    expect(svc.calls.backdrop).toEqual([1]);
    expect(res.layout.pictures).toHaveLength(3);
    expect(res.assets.find((a) => a.id === res.layout.pictures[1].assetId).origin).toBe('backdrop');
    expect(res.problems).toEqual([{ scene: 2, what: 'picture', message: 'declined' }]);
    expect(problemSummary(res.problems)).toBe('No picture could be made for scene 2, so a plain backdrop stands in.');
  });

  it('times a scene by its words when its voice fails, and falls back to estimates without speech to text', async () => {
    const svc = fakeServices({ failVoice: new Set([1]), heard: false });
    const res = await generateScenes(SCENES, { voice: 'polly', captions: 'clean-caption' }, svc);
    expect(res.layout.voices).toHaveLength(2);
    expect(res.layout.pictures[0].duration).toBe(LEAD + estimateSpeech(SCENES[0].narration) + TAIL);
    expect(res.timing).toBe('estimate');
    expect(problemSummary(res.problems)).toBe('No narration could be made for scene 1.');
  });

  it('adds ducked music when asked', async () => {
    const svc = fakeServices();
    const res = await generateScenes(SCENES, { voice: 'polly', captions: '', music: 'bright-side', musicName: 'Bright Side' }, svc);
    expect(svc.music).toHaveBeenCalledWith('bright-side');
    expect(res.layout.music.length).toBeGreaterThan(0);
    expect(res.layout.music[0].keyframes.volume.length).toBeGreaterThan(2);
    expect(res.layout.captions).toEqual([]);
    expect(svc.calls.words).toBe(0);
  });

  it('takes what an earlier run made from reuse, one picture and voice per scene', async () => {
    const svc = fakeServices();
    const reuse = new Map();
    const twins = [SCENES[0], { ...SCENES[0] }];
    const first = await generateScenes(twins, { voice: 'polly', captions: 'clean-caption' }, svc, { reuse });
    expect(svc.calls.image).toHaveLength(2);
    expect(svc.calls.speech).toHaveLength(2);
    const again = await generateScenes(twins, { voice: 'polly', captions: 'clean-caption' }, svc, { reuse });
    expect(svc.calls.image).toHaveLength(2);
    expect(svc.calls.speech).toHaveLength(2);
    expect(again.assets.map((a) => a.id)).toEqual(first.assets.map((a) => a.id));
    expect(new Set(again.layout.pictures.map((c) => c.assetId)).size).toBe(2);
    // Another voice is made anew.
    await generateScenes(twins, { voice: 'nova', captions: 'clean-caption' }, svc, { reuse });
    expect(svc.calls.speech).toHaveLength(4);
    expect(svc.calls.image).toHaveLength(2);
  });

  it('stops when cancelled and fails when nothing could be made', async () => {
    const ac = new AbortController();
    const svc = fakeServices();
    svc.speech.mockImplementation(async () => {
      ac.abort();
      return new Blob(['x'], { type: 'audio/mpeg' });
    });
    await expect(generateScenes(SCENES, { voice: 'polly' }, svc, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const broken = fakeServices({ failImage: new Set([1, 2, 3]), failVoice: new Set([1, 2, 3]) });
    await expect(generateScenes(SCENES, { voice: 'polly' }, broken)).rejects.toThrow('declined');
    await expect(generateScenes([{ narration: ' ' }], {}, fakeServices())).rejects.toThrow(/at least one scene/);
  });
});
