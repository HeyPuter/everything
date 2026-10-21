import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createProject, makeClip, normalizeClip, normalizeProject } from '../src/model/project.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { textTab as textAssets } from '../src/ui/panels/text.js';
import { TEXT_TEMPLATES, templateClips, insertTemplate, addTextTemplate, templateScale } from '../src/model/text-templates.js';
import { COLOR_KEYS } from '../src/model/text-style.js';
import { importFontFile, fontNameOf, familyFor } from '../src/media/fonts.js';
import * as T from '../src/model/timeline.js';
import { US } from '../src/lib/time.js';

HTMLCanvasElement.prototype.getContext = () => null;

let env;

function setup({ backendKind } = {}) {
  const p = createProject();
  p.assets.a1 = { id: 'a1', kind: 'video', name: 'clip.mp4', duration: 20 * US, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true };
  const v1 = makeClip('video', { assetId: 'a1', start: 0, duration: 10 * US });
  T.mainTrack(p).clips.push(v1);
  const text = makeClip('text', { start: 1 * US, duration: 4 * US, text: 'Hello world' });
  T.addClip(p, text);
  const store = new EditorStore(p);
  const ctx = { store, library: backendKind ? { backend: { kind: backendKind } } : undefined, account: { onSignIn: vi.fn() } };
  ctx.actions = createActions(ctx);
  const insp = createInspector(ctx);
  ctx.inspector = insp;
  document.body.append(insp.el);
  store.select(text.id);
  return { p, store, ctx, el: insp.el, text };
}

const clip = (id = env.text.id) => T.findClip(env.store.project, id).clip;
const tab = (name, root = env.el) => [...root.querySelectorAll('[role=tab]')].find((t) => t.textContent === name);
const button = (label, root = env.el) => [...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent.trim() === label);
const radio = (label, root = env.el) => [...root.querySelectorAll('[role=radio]')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label);
const field = (label) => [...env.el.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.textContent === label);

beforeEach(() => {
  env = setup();
});

afterEach(() => {
  document.body.replaceChildren();
  delete globalThis.puter;
});

describe('text details', () => {
  it('has Text, Animation, Effects and Speech tabs and Basic, Bubble, Word art sub-tabs', () => {
    expect([...env.el.querySelectorAll('.top-tabs [role=tab]')].map((t) => t.textContent)).toEqual(['Text', 'Animation', 'Effects', 'Speech']);
    expect([...env.el.querySelectorAll('.text-tab .subtabs [role=tab]')].map((t) => t.textContent)).toEqual(['Basic', 'Bubble', 'Word art']);
    // The text box stays above the sub-tabs and in sync.
    tab('Bubble').click();
    env.store.update('x', (p) => {
      T.findClip(p, env.text.id).clip.text = 'Changed';
    }, { structural: false });
    expect(env.el.querySelector('.insp-textarea').value).toBe('Changed');
  });

  it('sets case and drops the old uppercase switch', () => {
    env.store.update('legacy', (p) => {
      T.findClip(p, env.text.id).clip.style.uppercase = true;
    }, { structural: false });
    expect(radio('Uppercase').getAttribute('aria-checked')).toBe('true');
    radio('Title case').click();
    expect(clip().style.case).toBe('title');
    expect('uppercase' in clip().style).toBe(false);
  });

  it('switches fill to a gradient seeded from the text color', () => {
    env.store.update('c', (p) => {
      T.findClip(p, env.text.id).clip.style.color = '#ff0000';
    }, { structural: false });
    expect(field('Color 1').hidden).toBe(true);
    radio('Gradient').click();
    expect(clip().style).toMatchObject({ fillType: 'linear', grad1: '#ff0000' });
    expect(field('Color 1').hidden).toBe(false);
    expect(field('Angle').hidden).toBe(false);
    button('Third color').click();
    expect(clip().style.grad3).toBe(clip().style.grad2);
  });

  it('wraps text in a fixed box with vertical alignment', () => {
    expect(field('Box width').hidden).toBe(true);
    radio('Fixed width, wrap lines').click();
    expect(clip().style.boxWidth).toBeGreaterThan(0);
    expect(field('Box width').hidden).toBe(false);
    radio('Fit the text').click();
    expect(clip().style.boxWidth).toBe(0);
  });

  it('turns glow on and resets a section', () => {
    const before = env.store.history.undoStack.length;
    button('Show glow').click();
    expect(clip().style.glowStrength).toBe(50);
    env.store.update('glow', (p) => {
      Object.assign(T.findClip(p, env.text.id).clip.style, { glowColor: '#00ff00', glowRadius: 70 });
    }, { structural: false });
    button('Reset glow').click();
    expect(clip().style).toMatchObject({ glowColor: '#4fd8ff', glowRadius: 20, glowStrength: 50 });
    button('Show glow').click();
    expect(clip().style.glowStrength).toBe(0);
    expect(env.store.history.undoStack.length).toBe(before + 4);
    for (const label of ['Show stroke', 'Show outer stroke', 'Show background', 'Show shadow', 'Show 3d depth', 'Show color split']) expect(button(label)).toBeTruthy();
  });

  it('keys the text color at the playhead', () => {
    env.store.seek(2 * US);
    button('Add keyframe for color').click();
    for (const k of COLOR_KEYS) expect(clip().keyframes[k]).toHaveLength(1);
    expect(clip().keyframes[COLOR_KEYS[0]][0]).toMatchObject({ t: 1 * US, v: 255 });
    env.store.seek(4 * US);
    const hex = field('Color').querySelector('.hex-input');
    hex.value = '#000000';
    hex.dispatchEvent(new Event('change'));
    expect(clip().keyframes[COLOR_KEYS[1]].map((k) => k.v)).toEqual([255, 0]);
    // The base color is untouched while keys exist.
    expect(clip().style.color).toBe('#ffffff');
    expect(normalizeClip(structuredClone(clip())).keyframes[COLOR_KEYS[2]]).toHaveLength(2);
  });

  it('clearing highlights keeps keyboard focus in the section', () => {
    env.el.querySelectorAll('.section-toggle[aria-expanded=false]').forEach((x) => x.click());
    env.el.querySelector('.mark-chip').click();
    const clear = button('Clear');
    clear.focus();
    clear.click();
    expect(clip().marks).toBeUndefined();
    expect(clear.disabled).toBe(true);
    expect(document.activeElement).toBe(button('Pick key words'));
  });

  it('a keyed text color does not change with the playhead off the clip', () => {
    env.store.seek(2 * US);
    button('Add keyframe for color').click();
    env.store.seek(8 * US);
    const before = JSON.stringify(clip());
    const steps = env.store.history.undoStack.length;
    const hex = field('Color').querySelector('.hex-input');
    for (const v of ['#FF0000', '#00FF00']) {
      hex.focus();
      hex.value = v;
      hex.dispatchEvent(new Event('change'));
    }
    expect(JSON.stringify(clip())).toBe(before);
    expect(env.store.history.undoStack.length).toBe(steps);
    // The field goes back to the color shown, and a note says why (once).
    expect(hex.value).toBe('#FFFFFF');
    const notes = [...document.querySelectorAll('.toast')].filter((t) => t.textContent.includes('Move the playhead over the clip'));
    expect(notes).toHaveLength(1);
  });

  it('removing the only color key keeps its color', () => {
    env.store.seek(2 * US);
    button('Add keyframe for color').click();
    const hex = field('Color').querySelector('.hex-input');
    hex.value = '#FF0000';
    hex.dispatchEvent(new Event('change'));
    expect(clip().style.color).toBe('#ffffff');
    button('Remove color keyframe').click();
    for (const k of COLOR_KEYS) expect(clip().keyframes[k]).toBeUndefined();
    expect(clip().style.color).toBe('#ff0000');
    expect(hex.value).toBe('#FF0000');
  });

  it('picks a bubble and a word-art effect', () => {
    tab('Bubble').click();
    expect(env.el.querySelectorAll('.bubble-grid [role=radio]').length).toBeGreaterThanOrEqual(21);
    radio('Speech').click();
    expect(clip().style.bubble).toBe('speech');
    expect(clip().style.color).toBe('#111111'); // readable on the white bubble
    expect(env.el.querySelector('.text-bubbles .prop-section').hidden).toBe(false);
    radio('None').click();
    expect(clip().style.bubble).toBe('');
    tab('Word art').click();
    radio('Glitch').click();
    expect(clip().style).toMatchObject({ effect: 'glitch', glitch: 5 });
    expect(radio('Glitch').getAttribute('aria-checked')).toBe('true');
    radio('Gold').click();
    expect(clip().style).toMatchObject({ effect: 'gold', glitch: 0, fillType: 'linear' });
    radio('None').click();
    expect(clip().style).toMatchObject({ effect: '', fillType: 'solid' });
  });

  it('lists letter animations first and gives karaoke a highlight color', () => {
    tab('Animation').click();
    const names = [...env.el.querySelectorAll('.anim-grid [role=radio]')].map((b) => b.textContent);
    expect(names.slice(0, 3)).toEqual(['None', 'Typewriter', 'Letters rise']);
    expect(names).toContain('Fade in');
    tab('Loop').click();
    radio('Karaoke').click();
    expect(clip().animLoop.id).toBe('karaoke');
    const sections = [...env.el.querySelectorAll('.prop-section')];
    expect(sections.find((s) => s.querySelector('.section-title').textContent === 'Duration').hidden).toBe(true);
    expect(sections.find((s) => s.querySelector('.section-title').textContent === 'Highlight').hidden).toBe(false);
  });

  it('shows the sign-in state for speech when signed out', () => {
    tab('Speech').click();
    expect(env.el.querySelector('.text-speech').textContent).toContain('Sign in to use text to speech');
    button('Sign in to Puter').click();
    expect(env.ctx.account.onSignIn).toHaveBeenCalled();
  });
});

describe('text speech', () => {
  it('adds speech aligned to the text clip and fits the clip to it', async () => {
    document.body.replaceChildren();
    globalThis.puter = { ai: { txt2speech: vi.fn(async () => ({ src: 'blob:speech' })) } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('abc', { headers: { 'content-type': 'audio/mpeg' } }));
    env = setup({ backendKind: 'puter' });
    const asset = { id: 'sp', kind: 'audio', name: 'Speech', duration: 2.5 * US, hasAudio: true, width: 0, height: 0, fps: 0 };
    env.ctx.actions.importFiles = vi.fn(async () => {
      env.store.update('import', (p) => {
        p.assets.sp = asset;
      }, { structural: false });
      return [asset];
    });
    tab('Speech').click();
    expect(env.el.querySelector('.speech-quote').textContent).toBe('Hello world');
    button('Add as audio clip').click();
    await vi.waitFor(() => expect(T.allClips(env.store.project).some((c) => c.type === 'audio')).toBe(true));
    const audio = T.allClips(env.store.project).find((c) => c.type === 'audio');
    expect(audio.start).toBe(1 * US);
    await vi.waitFor(() => expect(clip().duration).toBe(2.5 * US));
    expect(globalThis.puter.ai.txt2speech).toHaveBeenCalledWith('Hello world', expect.any(Object));
    expect(env.store.selected.clip.id).toBe(env.text.id);
    fetchSpy.mockRestore();
  });
});

describe('title templates', () => {
  it('has about a dozen templates with valid layers', () => {
    expect(TEXT_TEMPLATES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(TEXT_TEMPLATES.map((t) => t.id)).size).toBe(TEXT_TEMPLATES.length);
    for (const tpl of TEXT_TEMPLATES) {
      expect(tpl.layers.length).toBeGreaterThan(0);
      for (const { clip: c } of templateClips(tpl, { width: 1920, height: 1080 }, 2 * US)) {
        expect(c.start).toBeGreaterThanOrEqual(2 * US);
        const n = normalizeClip(structuredClone(c));
        expect(n).toMatchObject({ type: c.type, start: c.start, duration: c.duration });
        if (c.type === 'text') expect(n.style).toEqual(c.style);
        for (const k of ['animIn', 'animOut']) if (c[k]) expect(c[k].duration).toBeLessThanOrEqual(c.duration / 2);
        expect(Math.abs(c.transform.x)).toBeLessThanOrEqual(0.6);
        expect(Math.abs(c.transform.y)).toBeLessThanOrEqual(0.6);
      }
    }
  });

  it('inserts on new tracks at the playhead as one undo step', () => {
    env.store.seek(3 * US);
    const tracksBefore = env.store.project.tracks.length;
    const undoBefore = env.store.history.undoStack.length;
    const made = addTextTemplate(env.store, 'lower-third');
    expect(made.clips).toHaveLength(4);
    expect(env.store.project.tracks.length).toBe(tracksBefore + 4);
    expect(env.store.history.undoStack.length).toBe(undoBefore + 1);
    expect(made.clips.every((c) => c.start >= 3 * US)).toBe(true);
    // Layer order: the bar is lowest, the role text on top.
    const idx = (c) => env.store.project.tracks.findIndex((t) => t.clips.some((x) => x.id === c.id));
    expect(idx(made.clips[0])).toBeGreaterThan(idx(made.clips[3]));
    expect(env.store.selected.clip.text).toBe('Your Name');
    env.store.undo();
    expect(env.store.project.tracks.length).toBe(tracksBefore);
    expect(T.allClips(env.store.project)).toHaveLength(2);
  });

  it('keeps layers that share a track together', () => {
    const p = createProject();
    const { tracks, clips } = insertTemplate(p, TEXT_TEMPLATES.find((t) => t.id === 'countdown'), 0);
    expect(tracks).toHaveLength(2);
    expect(tracks[1].clips.map((c) => c.text)).toEqual(['3', '2', '1', 'GO!']);
    expect(clips[0].type).toBe('sticker');
    expect(normalizeProject(structuredClone(p)).tracks.filter((t) => t.kind === 'text')).toHaveLength(2);
  });

  it('scales designs to the project frame', () => {
    expect(templateScale({ width: 1920, height: 1080 })).toBe(1);
    expect(templateScale({ width: 1080, height: 1920 })).toBeCloseTo(0.675);
    const p = createProject({ ratio: '9:16' });
    const { clips } = insertTemplate(p, TEXT_TEMPLATES[0], 0);
    expect(clips[0].transform.scale).toBeCloseTo(0.675);
  });
});

describe('text assets panel', () => {
  it('has categories, searches all of them and inserts templates', () => {
    const panel = textAssets(env.ctx);
    document.body.append(panel.el);
    const cats = [...panel.el.querySelectorAll('.asset-cat')].map((b) => b.textContent);
    expect(cats).toEqual(['Default text', 'Styles', 'Effects', 'Templates', 'Write with AI']);
    expect(panel.el.querySelector('.tile-label').textContent).toBe('Default text');
    const search = panel.el.querySelector('.asset-search');
    search.value = 'neon';
    search.dispatchEvent(new Event('input'));
    expect([...panel.el.querySelectorAll('.asset-group-title')].map((x) => x.textContent)).toEqual(['Styles', 'Effects', 'Templates']);
    search.value = '';
    search.dispatchEvent(new Event('input'));
    [...panel.el.querySelectorAll('.asset-cat')].find((b) => b.textContent === 'Effects').click();
    [...panel.el.querySelectorAll('.tile')].find((t) => t.textContent.includes('Chrome')).click();
    expect(env.store.selected.clip.style.effect).toBe('chrome');
    [...panel.el.querySelectorAll('.asset-cat')].find((b) => b.textContent === 'Templates').click();
    const before = env.store.history.undoStack.length;
    [...panel.el.querySelectorAll('.tile')].find((t) => t.textContent.includes('Quote card')).click();
    expect(env.store.history.undoStack.length).toBe(before + 1);
    expect(env.store.selected.clip.text).toContain('Simplicity');
  });
});

describe('uploaded fonts', () => {
  it('names fonts from files', () => {
    expect(fontNameOf('My-Font_Bold.ttf')).toBe('My Font Bold');
    expect(familyFor('My Font', 'abcdef123')).toBe('My Font abcdef');
  });

  it('registers, stores and dedupes a font file', async () => {
    const added = [];
    vi.stubGlobal('FontFace', class {
      constructor(family) {
        this.family = family;
      }

      load() {
        return Promise.resolve(this);
      }
    });
    const fonts = document.fonts;
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add: (f) => added.push(f.family), check: () => true, load: () => Promise.resolve() } });
    const writes = [];
    const library = { backend: { writeBlob: async (path, blob) => writes.push([path, blob.size]), readBlob: async () => null } };
    const file = new File([new Uint8Array([0, 1, 0, 0, 9, 9])], 'Cool Font.ttf', { type: 'font/ttf' });
    const entry = await importFontFile(library, file, []);
    expect(entry).toMatchObject({ name: 'Cool Font', ext: 'ttf', mime: 'font/ttf', size: 6 });
    expect(writes).toEqual([[`fonts/${entry.hash}.ttf`, 6]]);
    expect(added).toEqual([entry.family]);
    expect(await importFontFile(library, file, [entry])).toBe(entry);
    await expect(importFontFile(library, new File(['x'], 'notes.txt'), [])).rejects.toThrow(/TTF, OTF, WOFF/);
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  });
});
