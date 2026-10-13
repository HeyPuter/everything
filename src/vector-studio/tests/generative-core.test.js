import { describe, it, expect, vi, afterEach } from 'vitest';
import { vectorPrompt, palettePrompt, normalizePalettes, normalizeHex, rewritePrompt, promptTitle, cleanPrompt, PROMPT_MAX } from '../src/features/generative/prompts.js';
import { aiStatus, aiClient, requireAI, chatText, parseJsonReply, plainReply, abortable, aiErrorMessage, AIError } from '../src/features/generative/ai.js';
import { ratioFor, fitMatrix, traceOptionsFor, resultToNodes, resultSvg, tracePixels, generateVariations, dataUrlToBlob } from '../src/features/generative/vectorize.js';
import { GenerationHistory, STORAGE_KEY, MAX_ENTRIES, timeAgo } from '../src/features/generative/history.js';
import { paletteRecolorMap } from '../src/features/generative/recolor.js';
import { wordDiff } from '../src/features/generative/text-ai.js';
import { hexToLab } from '../src/features/panels/color-harmony.js';
import { fakeAI, diskPicture } from './generative-helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('prompts', () => {
  it('builds vector-friendly image prompts from the choices', () => {
    const p = vectorPrompt({ prompt: '  a  fox\nasleep ', contentType: 'icon', style: 'line', color: 'mono' });
    expect(p.startsWith('a fox asleep.')).toBe(true);
    expect(p).toMatch(/icon/);
    expect(p).toMatch(/line art/);
    expect(p).toMatch(/black and white/);
    expect(p).toMatch(/no text/);
    const ref = vectorPrompt({ prompt: 'x', reference: { colors: ['#112233', '#445566'], description: 'chunky outlines' } });
    expect(ref).toMatch(/#112233, #445566/);
    expect(ref).toMatch(/chunky outlines/);
    expect(cleanPrompt('a'.repeat(2000)).length).toBe(PROMPT_MAX);
  });

  it('normalizes palettes and colors from chat answers', () => {
    expect(normalizeHex('ABC')).toBe('#aabbcc');
    expect(normalizeHex('#A1b2C3')).toBe('#a1b2c3');
    expect(normalizeHex('red')).toBe(null);
    const list = normalizePalettes([{ name: 'Dusk', colors: ['#112233', 'zzz', '#FFF'] }, { colors: ['#000'] }, ['#010203', '#040506'], 'junk']);
    expect(list).toEqual([
      { name: 'Dusk', colors: ['#112233', '#ffffff'] },
      { name: 'Palette 2', colors: ['#010203', '#040506'] },
    ]);
    expect(palettePrompt('sea glass', { count: 3, colors: 4 })).toMatch(/3 different color palettes[\s\S]*exactly 4 colors[\s\S]*JSON/);
    expect(rewritePrompt('Hello', { tone: 'formal', length: 'shorter' })).toMatch(/formal[\s\S]*shorter[\s\S]*Hello/);
    expect(promptTitle('a very long prompt about many things that goes on and on forever', 20)).toBe('A very long prompt…');
  });
});

describe('AI access', () => {
  it('reports why generating cannot run', () => {
    expect(aiStatus({}).reason).toBe('unavailable');
    expect(aiStatus({ puter: { ai: { chat() {} } }, user: null }).reason).toBe('signedOut');
    expect(aiStatus({ puter: { ai: { chat() {} } }, user: { username: 'a' } }).ok).toBe(true);
    expect(aiStatus({ generativeAI: fakeAI() }).ok).toBe(true);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const st = aiStatus({ generativeAI: fakeAI() });
    expect(st.ok).toBe(false);
    expect(st.reason).toBe('offline');
    expect(st.message).toMatch(/offline/);
  });

  it('wraps puter.ai and asks to sign in when signed out', async () => {
    const ai = { chat: vi.fn(async () => 'hi'), txt2img: vi.fn(async () => ({ src: 'x' })) };
    const app = { puter: { ai }, user: null, onSignIn: vi.fn(async () => (app.user = { username: 'me' })), dialogs: { confirm: vi.fn(async () => true) } };
    const client = await requireAI(app);
    expect(app.dialogs.confirm).toHaveBeenCalled();
    expect(app.onSignIn).toHaveBeenCalled();
    await client.chat('q', 'data:image/png;base64,AA');
    expect(ai.chat).toHaveBeenCalledWith('q', 'data:image/png;base64,AA');
    await aiClient(app).chat('only');
    expect(ai.chat).toHaveBeenLastCalledWith('only');
    // Declining the sign-in resolves to null; no Puter at all is an error with a message.
    app.user = null;
    app.dialogs.confirm = vi.fn(async () => false);
    expect(await requireAI(app)).toBe(null);
    await expect(requireAI({})).rejects.toBeInstanceOf(AIError);
  });

  it('reads chat answers', () => {
    expect(chatText({ message: { content: [{ type: 'text', text: 'a' }, { text: 'b' }] } })).toBe('ab');
    expect(chatText({ message: { content: 'plain' } })).toBe('plain');
    expect(parseJsonReply('Sure! ```json\n["x", "y"]\n```')).toEqual(['x', 'y']);
    expect(parseJsonReply('{"text": "a", "changes": []} thanks', 'object')).toEqual({ text: 'a', changes: [] });
    expect(() => parseJsonReply('no json')).toThrow(/unexpected form/);
    expect(plainReply('"Quoted answer"')).toBe('Quoted answer');
    expect(plainReply('```\ncode\n```')).toBe('code');
    expect(aiErrorMessage({ code: 'moderation_flagged' })).toMatch(/content filter/);
    expect(aiErrorMessage(new TypeError('fetch failed'))).toMatch(/could not be reached/);
  });

  it('abandons a request when cancelled', async () => {
    const c = new AbortController();
    const p = abortable(new Promise(() => {}), c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('vectorizing', () => {
  it('chooses picture shapes, fits and trace options', () => {
    expect(ratioFor(1600, 900)).toEqual({ w: 16, h: 9 });
    expect(ratioFor(100, 100)).toEqual({ w: 1, h: 1 });
    expect(ratioFor(200, 290)).toEqual({ w: 2, h: 3 });
    expect(fitMatrix(100, 50, { x: 10, y: 10, w: 200, h: 200 }, 'contain')).toEqual([2, 0, 0, 2, 10, 60]);
    expect(fitMatrix(100, 50, { x: 0, y: 0, w: 200, h: 200 }, 'cover')).toEqual([4, 0, 0, 4, -100, 0]);
    const icon = traceOptionsFor({ contentType: 'icon', detail: 1 });
    const scene = traceOptionsFor({ contentType: 'scene', detail: 3 });
    expect(icon.ignoreWhite).toBe(true);
    expect(scene.ignoreWhite).toBe(false);
    expect(scene.colors).toBeGreaterThan(icon.colors);
    expect(traceOptionsFor({ color: 'mono' }).mode).toBe('bw');
    expect(traceOptionsFor({ color: 'limited', detail: 3 }).colors).toBeLessThanOrEqual(5);
  });

  it('traces pictures into document nodes and SVG previews', async () => {
    const result = await tracePixels(diskPicture(), traceOptionsFor({ contentType: 'subject', detail: 1 }));
    expect(result.shapes.length).toBeGreaterThan(0);
    const red = result.shapes.find((s) => s.f && hexToLab(s.f).a > 30);
    expect(red).toBeTruthy();
    const { node, descendants } = resultToNodes(result, fitMatrix(result.w, result.h, { x: 0, y: 0, w: 100, h: 100 }), { name: 'Art' });
    expect(node.type).toBe('group');
    expect(node.name).toBe('Art');
    expect(node.children.length).toBe(descendants.filter((d) => d.parent === node.id).length);
    // The disk spans about 60% of the picture, centered.
    const disk = descendants.find((d) => d.parent === node.id && d.fill?.color === red.f);
    const xs = disk.anchors.map((a) => a.x);
    expect(Math.min(...xs)).toBeGreaterThan(15);
    expect(Math.max(...xs)).toBeLessThan(85);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(45);
    const svg = resultSvg(result, { background: '#fff' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(`fill="${red.f}"`);
  });

  it('generates variations with progress, and reports failures', async () => {
    const ai = fakeAI();
    const progress = [];
    const out = await generateVariations({ generativeDecode: async () => diskPicture() }, ai, { prompt: 'a red ball', contentType: 'subject', detail: 1, ratio: { w: 4, h: 3 } }, { count: 2, onProgress: (v) => progress.push(v) });
    expect(out.variations).toHaveLength(2);
    expect(out.failed).toBe(0);
    expect(ai.calls.txt2img).toHaveLength(2);
    expect(ai.calls.txt2img[0].prompt).toMatch(/^a red ball\./);
    expect(ai.calls.txt2img[0].options).toEqual({ ratio: { w: 4, h: 3 } });
    expect(progress[progress.length - 1]).toBe(1);
    const failing = fakeAI({ fail: { txt2img: { code: 'insufficient_funds' } } });
    await expect(generateVariations({ generativeDecode: async () => diskPicture() }, failing, { prompt: 'x' }, { count: 2 })).rejects.toThrow(/balance is too low/);
  });

  it('decodes data URLs', async () => {
    const b = dataUrlToBlob('data:text/plain,hi%20there');
    expect(await b.text()).toBe('hi there');
    expect(dataUrlToBlob('https://example.com/a.png')).toBe(null);
  });
});

describe('generation history', () => {
  const memory = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m };
  };

  it('keeps entries newest first and persists them', () => {
    const storage = memory();
    const hist = new GenerationHistory(storage);
    let changes = 0;
    hist.on('change', () => changes++);
    const a = hist.add({ kind: 'recolor', prompt: 'dusk', items: [{ name: 'A', colors: ['#000000', '#ffffff'] }] });
    const b = hist.add({ kind: 'text', prompt: 'hello', items: [{ text: 'Hi' }, { text: 'Hey' }] });
    expect(hist.entries.map((e) => e.id)).toEqual([b.id, a.id]);
    expect(changes).toBe(2);
    const again = new GenerationHistory(storage);
    expect(again.entries.map((e) => e.prompt)).toEqual(['hello', 'dusk']);
    again.removeItem(b.id, 0);
    expect(again.get(b.id).items).toEqual([{ text: 'Hey' }]);
    again.removeItem(b.id, 0);
    expect(again.get(b.id)).toBe(null);
    again.clear();
    expect(JSON.parse(storage.m.get(STORAGE_KEY))).toEqual([]);
  });

  it('caps the number of entries and survives corrupt storage', () => {
    const storage = memory();
    const hist = new GenerationHistory(storage);
    for (let i = 0; i < MAX_ENTRIES + 5; i++) hist.add({ kind: 'text', prompt: `p${i}`, items: [{ text: 't' }] });
    expect(hist.entries).toHaveLength(MAX_ENTRIES);
    expect(hist.entries[0].prompt).toBe(`p${MAX_ENTRIES + 4}`);
    storage.setItem(STORAGE_KEY, '{oops');
    expect(new GenerationHistory(storage).entries).toEqual([]);
    expect(timeAgo(1000, 1000 + 5 * 60_000)).toBe('5 min ago');
  });
});

describe('palette recoloring', () => {
  it('maps light to light and dark to dark, keeping shading', () => {
    const colors = [
      { color: '#202020', count: 5 },
      { color: '#303030', count: 2 },
      { color: '#e0e0e0', count: 4 },
    ];
    const map = paletteRecolorMap(colors, ['#ffd23f', '#1b3a6b']);
    const L = (h) => hexToLab(h).l;
    expect(map['#202020']).toBe('#1b3a6b');
    expect(map['#e0e0e0']).toBe('#ffd23f');
    // A lighter member of the dark cluster stays a little lighter than its target.
    expect(L(map['#303030'])).toBeGreaterThan(L('#1b3a6b'));
    expect(paletteRecolorMap([], ['#000000'])).toEqual({});
  });
});

describe('word diff', () => {
  it('marks deleted and inserted words', () => {
    expect(wordDiff('the cat sat', 'the dog sat')).toEqual([
      { type: 'same', text: 'the ' },
      { type: 'del', text: 'cat' },
      { type: 'ins', text: 'dog' },
      { type: 'same', text: ' sat' },
    ]);
    expect(wordDiff('same', 'same')).toEqual([{ type: 'same', text: 'same' }]);
  });
});
