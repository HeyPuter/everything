import { describe, it, expect, vi, afterEach } from 'vitest';
import { US } from '../src/lib/time.js';
import { normalizeAsset } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { createCommands } from '../src/ui/commands.js';
import { openScriptDialog, aiReady } from '../src/ui/script-video.js';
import { openHighlightsDialog, highlightSource } from '../src/ui/highlights-dialog.js';
import { fixture, s, onMain, clip } from './helpers.js';

afterEach(() => {
  document.querySelectorAll('dialog').forEach((d) => d.remove());
});

const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text) && !b.hidden);

function services() {
  let n = 0;
  return {
    chat: vi.fn(async (p) => (/JSON array/.test(p) ? '["a bee on a flower", "a jar of honey"]' : 'Bees are tiny but they work very hard every day.\n\nTheir honey keeps for many years in a sealed jar.')),
    speech: vi.fn(async (text) => new Blob([text], { type: 'audio/mpeg' })),
    image: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
    words: vi.fn(async () => null),
    backdrop: vi.fn(async (i) => new File(['b'], `b${i}.png`, { type: 'image/png' })),
    music: vi.fn(async () => new Blob(['w'], { type: 'audio/wav' })),
    addMedia: vi.fn(async (file, origin) => {
      n++;
      const kind = file.type.startsWith('image/') ? 'image' : 'audio';
      return normalizeAsset({ id: `g${n}`, kind, name: file.name, duration: kind === 'audio' ? s(origin === 'music' ? 30 : 3) : 0, hasAudio: kind === 'audio', width: 1920, height: 1080, origin });
    }),
  };
}

describe('script to video dialog', () => {
  it('writes a script, suggests pictures and adds the video at the playhead as one undo step', async () => {
    const store = new EditorStore(fixture());
    const svc = services();
    const d = openScriptDialog({ library: {}, store }, { services: svc });
    const el = d.el;
    el.querySelector('.aic-script').value = 'honey bees';
    button(el, 'Write the script').click();
    await vi.waitFor(() => expect(el.querySelector('.aic-script').value).toMatch(/^Bees are tiny/));
    button(el, 'Next').click();
    expect(el.querySelectorAll('.aic-scene')).toHaveLength(2);
    button(el, 'Suggest pictures').click();
    await vi.waitFor(() => expect(el.querySelectorAll('.aic-picture')[1].value).toBe('a jar of honey'));
    const before = store.history.undoStack.length;
    button(el, 'Create').click();
    await vi.waitFor(() => expect(el.isConnected).toBe(false));
    expect(svc.image.mock.calls.map((c) => c[0])).toEqual(['a bee on a flower', 'a jar of honey']);
    expect(store.history.undoStack.length).toBe(before + 1);
    const p = store.project;
    const main = p.tracks.find((t) => t.main);
    expect(main.clips.map((c) => c.type)).toEqual(['image', 'image']);
    expect(main.clips[0].transition?.id).toBe('mix');
    expect(p.tracks.some((t) => t.kind === 'text' && t.clips.every((c) => c.caption))).toBe(true);
    expect(p.tracks.filter((t) => t.kind === 'audio').length).toBe(2); // narration and music
    expect(main.clips[0].duration).toBe(main.clips[0].animLoop.duration);
    store.undo();
    expect(store.project.tracks.find((t) => t.main).clips).toHaveLength(0);
  });

  it('does not pay again for what was made before Stop when Create is pressed again', async () => {
    const store = new EditorStore(fixture());
    const svc = services();
    const d = openScriptDialog({ library: {}, store }, { services: svc });
    const el = d.el;
    el.querySelector('.aic-script').value = 'First scene has quite a few words in it.\n\nSecond scene also has enough words.';
    button(el, 'Next').click();
    // Stop while the second scene's picture is being made.
    svc.image.mockImplementationOnce(async () => new Blob(['png'], { type: 'image/png' })).mockImplementationOnce(async () => {
      button(el, 'Stop').click();
      return new Blob(['png'], { type: 'image/png' });
    });
    button(el, 'Create').click();
    await vi.waitFor(() => expect(button(el, 'Create')).toBeTruthy());
    expect(svc.image).toHaveBeenCalledTimes(2);
    expect(svc.speech).toHaveBeenCalledTimes(1);
    button(el, 'Create').click();
    await vi.waitFor(() => expect(el.isConnected).toBe(false));
    // The first scene's picture and voice and the second's picture were made (and paid for) already.
    expect(svc.image).toHaveBeenCalledTimes(2);
    expect(svc.speech).toHaveBeenCalledTimes(2);
    expect(store.project.tracks.find((t) => t.main).clips).toHaveLength(2);
    // Another dialog makes its own.
    const again = openScriptDialog({ library: {}, store }, { services: svc });
    again.el.querySelector('.aic-script').value = 'First scene has quite a few words in it.\n\nSecond scene also has enough words.';
    button(again.el, 'Next').click();
    button(again.el, 'Create').click();
    await vi.waitFor(() => expect(again.el.isConnected).toBe(false));
    expect(svc.image).toHaveBeenCalledTimes(4);
  });

  it('makes a new project from the home screen', async () => {
    const saved = [];
    const library = { saveProject: vi.fn(async (p) => saved.push(p)) };
    const onProject = vi.fn();
    const d = openScriptDialog({ library }, { services: services(), onProject });
    d.el.querySelector('.aic-script').value = 'First scene has quite a few words in it.\n\nSecond scene also has enough words.';
    d.el.querySelectorAll('.segmented [role=radio]')[1].click(); // 9:16
    button(d.el, 'Next').click();
    button(d.el, 'Create').click();
    await vi.waitFor(() => expect(onProject).toHaveBeenCalled());
    expect(saved[0].settings).toMatchObject({ width: 1080, height: 1920, ratio: '9:16' });
    expect(saved[0].name).toBe('First scene has quite a few words');
    expect(onProject).toHaveBeenCalledWith(saved[0].id);
  });

  it('only offers AI where Puter is signed in or stubbed for development', () => {
    expect(aiReady({ library: { backend: { kind: 'local' } } })).toBe(false);
    globalThis.__vsAiStub = true;
    expect(aiReady({ library: { backend: { kind: 'local' } } })).toBe(true);
    delete globalThis.__vsAiStub;
  });
});

describe('find highlights dialog', () => {
  function project() {
    const p = fixture();
    p.assets.vid.duration = s(200);
    const [c] = onMain(p, clip('video', 0, 120));
    // 240 words over two minutes, a sentence every 10 words.
    p.transcript = { language: 'en', words: Array.from({ length: 240 }, (_, i) => ({ text: `w${i}${i % 10 === 9 ? '.' : ''}`, start: i * 500_000, end: i * 500_000 + 400_000 })) };
    return { p, c };
  }

  it('picks the selected video, else the longest one with sound', () => {
    const { p, c } = project();
    const [other] = onMain(p, clip('video', 120, 5));
    expect(highlightSource(p, [other.id]).id).toBe(other.id);
    expect(highlightSource(p, []).id).toBe(c.id);
  });

  it('finds moments from the transcript and adds the chosen ones as compound clips in one step', async () => {
    const { p } = project();
    const store = new EditorStore(p);
    const ctx = { store, library: {}, player: { play: vi.fn(), pause: vi.fn(), on: () => () => {} } };
    const chat = vi.fn(async () => '{"highlights":[{"title":"First","start":20,"end":59},{"title":"Second","start":100,"end":139},{"title":"Third","start":180,"end":219}]}');
    const d = openHighlightsDialog(ctx, { chat });
    button(d.el, 'Find highlights').click();
    await vi.waitFor(() => expect(d.el.querySelectorAll('.aic-cand')).toHaveLength(3));
    expect(chat.mock.calls[0][0]).toMatch(/\[20-29\]/);
    // Preview seeks the player to the moment.
    button(d.el.querySelectorAll('.aic-cand')[1], 'Preview').click();
    expect(store.time).toBe(d.found[1].start);
    expect(ctx.player.play).toHaveBeenCalled();
    d.el.querySelectorAll('.aic-cand input[type=checkbox]')[2].click();
    const target = [...d.el.querySelectorAll('select')].find((x) => x.getAttribute('aria-label') === 'Make');
    target.value = 'here';
    target.dispatchEvent(new Event('change'));
    expect(button(d.el, 'Make').textContent).toMatch(/Make 2 clips/);
    const before = store.history.undoStack.length;
    button(d.el, 'Make').click();
    expect(store.history.undoStack.length).toBe(before + 1);
    const main = store.project.tracks.find((t) => t.main);
    expect(main.clips.map((c) => c.type)).toEqual(['video', 'compound', 'compound']);
    expect(main.clips[1]).toMatchObject({ name: 'First', start: s(120) });
    expect(main.clips[1].sequence.tracks[0].clips.every((c) => c.caption)).toBe(true);
    expect(main.clips[2].start).toBe(main.clips[1].start + main.clips[1].duration);
  });

  it('saves a short project for each chosen moment', async () => {
    const { p } = project();
    const store = new EditorStore(p);
    const saved = [];
    const ctx = { store, library: { saveProject: async (x) => saved.push(x) }, player: { play() {}, pause() {} } };
    const chat = async () => '{"highlights":[{"title":"Only one","start":20,"end":59}]}';
    const d = openHighlightsDialog(ctx, { chat });
    await d.search();
    const target = [...d.el.querySelectorAll('select')].find((x) => x.getAttribute('aria-label') === 'Make');
    target.value = 'projects';
    target.dispatchEvent(new Event('change'));
    const shape = [...d.el.querySelectorAll('select')].find((x) => x.getAttribute('aria-label') === 'Frame shape');
    shape.value = 'keep';
    shape.dispatchEvent(new Event('change'));
    await d.make();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('Only one');
    expect(saved[0].tracks.find((t) => t.main).clips[0].duration).toBeGreaterThan(15 * US * 0.6);
  });
});

describe('commands', () => {
  it('lists both tools', () => {
    const ctx = { store: new EditorStore(fixture()), actions: {}, openScriptVideo: vi.fn(), openHighlights: vi.fn() };
    const cmds = createCommands(ctx);
    expect(cmds.run('scriptToVideo')).toBe(true);
    expect(cmds.run('findHighlights')).toBe(true);
    expect(ctx.openScriptVideo).toHaveBeenCalled();
    expect(ctx.openHighlights).toHaveBeenCalled();
  });
});
