import { describe, it, expect, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createAssistantRunner, styleWords } from '../src/ui/assistant-actions.js';
import { mainTrack, allClips, findClip } from '../src/model/timeline.js';
import {
  TOOLS, toolSpecs, validateCall, resolveClips, askForEdits, parseActionList, toolCallsFrom, summarize,
  projectBrief, catalogBrief, buildMessages, assistState, normColor, textStyle, stepLabel, HISTORY_LIMIT,
} from '../src/media/edit-assistant.js';
import { fixture, clip, onMain, s } from './helpers.js';

function setup(...mainClips) {
  const p = fixture();
  onMain(p, ...mainClips);
  const store = new EditorStore(p);
  const ctx = { store, player: null, library: null };
  ctx.actions = createActions(ctx);
  return { store, ctx, main: () => mainTrack(store.project) };
}

/** A chat stand-in answering with OpenAI-style tool calls. */
const toolReply = (...calls) => ({
  message: { role: 'assistant', content: null, tool_calls: calls.map(([name, args], i) => ({ id: `call_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) },
});

const twoClips = () => setup(clip('video', 0, 4), clip('video', 4, 4));

describe('edit assistant tools', () => {
  it('describes every tool as an OpenAI-style function', () => {
    const specs = toolSpecs();
    expect(specs).toHaveLength(TOOLS.length);
    for (const t of specs) {
      expect(t.type).toBe('function');
      expect(t.function.name).toMatch(/^[a-z_]+$/);
      expect(t.function.parameters.type).toBe('object');
    }
    expect(specs.map((t) => t.function.name)).toEqual(expect.arrayContaining(['split', 'remove_time_range', 'set_speed', 'add_text', 'edit_text', 'set_filter', 'add_captions', 'remove_silences', 'set_aspect_ratio']));
  });

  it('resolves clip ids and clip words, leaving out locked and unsuitable clips', () => {
    const { store, main } = twoClips();
    const [a, b] = main().clips;
    store.select(b.id);
    const st = assistState(store);
    expect(resolveClips(['selected'], st).ids).toEqual([b.id]);
    expect(resolveClips('first', st).ids).toEqual([a.id]);
    expect(resolveClips(['last'], st).ids).toEqual([b.id]);
    expect(resolveClips(['all_video'], st).ids).toEqual([a.id, b.id]);
    expect(resolveClips([a.id, 'nope'], st).unknown).toEqual(['nope']);
    expect(resolveClips(['all'], st, (c) => c.type === 'audio').ids).toEqual([]);
    main().locked = true;
    expect(resolveClips(['all'], assistState(store)).ids).toEqual([]);
  });

  it('clamps numbers to what the editor allows', () => {
    const { store, main } = twoClips();
    const st = assistState(store);
    const id = main().clips[0].id;
    expect(validateCall({ name: 'set_speed', args: { clips: [id], speed: 500 } }, st).args.speed).toBe(100);
    expect(validateCall({ name: 'set_speed', args: { clips: [id], speed: '0.01' } }, st).args.speed).toBe(0.1);
    expect(validateCall({ name: 'split', args: { time: 99 } }, st).args.time).toBe(s(8));
    expect(validateCall({ name: 'split', args: { time: -3 } }, st).args.time).toBe(0);
    const range = validateCall({ name: 'remove_time_range', args: { start: 5, end: -1 } }, st).args;
    expect(range).toEqual({ start: 0, end: s(5) });
    expect(validateCall({ name: 'set_audio', args: { clips: [id], volume: 5000, fade_out: 60 } }, st).args).toMatchObject({ volume: 10, fadeOut: s(10) });
    expect(validateCall({ name: 'set_filter', args: { clips: ['all'], filter: 'Warm', intensity: 400 } }, st).args).toMatchObject({ filter: 'warm', intensity: 100 });
    expect(validateCall({ name: 'set_transition', args: { transition: 'Dissolve', all: true, duration: 30 } }, st).args).toMatchObject({ transition: 'mix', all: true, duration: s(5) });
    expect(validateCall({ name: 'adjust_color', args: { clips: ['all'], temperature: 400, nonsense: 3 } }, st).args.adjust).toEqual({ temperature: 100 });
  });

  it('turns unusable calls into short reasons instead of throwing', () => {
    const { store, main } = twoClips();
    const st = assistState(store);
    expect(validateCall({ name: 'teleport', args: {} }, st)).toMatchObject({ ok: false, error: expect.stringMatching(/unknown edit/) });
    expect(validateCall({ name: 'set_speed', args: { clips: ['ghost'], speed: 2 } }, st).ok).toBe(false);
    expect(validateCall({ name: 'set_filter', args: { clips: ['all'], filter: 'sparkly-purple' } }, st).error).toMatch(/no filter called/);
    expect(validateCall({ name: 'add_text', args: { text: '   ' } }, st).ok).toBe(false);
    expect(validateCall({ name: 'trim_clip', args: { clip: main().clips[0].id } }, st).error).toMatch(/nothing to trim/);
    expect(validateCall({ name: 'set_animation', args: { clips: ['all'], kind: 'sideways', animation: 'fade-in' } }, st).ok).toBe(false);
    expect(validateCall({ name: 'set_aspect_ratio', args: { ratio: '7:3' } }, st).ok).toBe(false);
    expect(validateCall({ name: 'set_aspect_ratio', args: { ratio: '9/16' } }, st).args.ratio).toBe('9:16');
    expect(validateCall(null, st).ok).toBe(false);
  });

  it('reads colors and text styles leniently', () => {
    expect(normColor('Red')).toBe('#e5322d');
    expect(normColor('#ABC')).toBe('#aabbcc');
    expect(normColor('0f0f0f')).toBe('#0f0f0f');
    expect(normColor('chartreuse-ish')).toBe(null);
    expect(textStyle({ color: 'yellow', size: 9999, size_scale: 1.5, font: 'anton', outline_color: 'black', bold: 'true', align: 'diagonal' }))
      .toEqual({ color: '#ffd23f', size: 400, sizeScale: 1.5, font: 'Anton', strokeColor: '#000000', strokeWidth: 6, bold: true });
  });
});

describe('reading replies', () => {
  it('reads OpenAI-style tool calls and tool_use blocks', () => {
    expect(toolCallsFrom(toolReply(['split', { time: 2 }]))).toEqual([{ name: 'split', args: { time: 2 } }]);
    const blocks = { message: { content: [{ type: 'text', text: 'Sure.' }, { type: 'tool_use', id: 't1', name: 'set_speed', input: { clips: ['selected'], speed: 2 } }] } };
    expect(toolCallsFrom(blocks)).toEqual([{ name: 'set_speed', args: { clips: ['selected'], speed: 2 } }]);
    expect(toolCallsFrom('just words')).toEqual([]);
  });

  it('parses JSON action lists in several shapes', () => {
    const fenced = 'Here you go:\n```json\n{"actions":[{"tool":"split","args":{"time":3}}],"reply":"Split it."}\n```';
    expect(parseActionList(fenced)).toEqual({ calls: [{ name: 'split', args: { time: 3 } }], reply: 'Split it.' });
    expect(parseActionList('[{"name":"set_speed","arguments":"{\\"clips\\":[\\"all\\"],\\"speed\\":2}"}]').calls).toEqual([{ name: 'set_speed', args: { clips: ['all'], speed: 2 } }]);
    expect(parseActionList('{"tool":"move_playhead","time":4}').calls).toEqual([{ name: 'move_playhead', args: { time: 4 } }]);
    expect(parseActionList('{"steps":[{"function":{"name":"add_marker","arguments":{"time":1}}}]}').calls).toEqual([{ name: 'add_marker', args: { time: 1 } }]);
    expect(parseActionList('{"actions":[],"reply":"Which clip?"}')).toEqual({ calls: [], reply: 'Which clip?' });
    expect(parseActionList('No JSON at all')).toBe(null);
  });

  it('asks again for a JSON action list when no tool calls come back', async () => {
    const { store } = twoClips();
    const chat = vi.fn()
      .mockResolvedValueOnce({ message: { content: 'I would split it at 2 seconds.' } })
      .mockResolvedValueOnce('{"actions":[{"tool":"split","args":{"time":2}}],"reply":"Split at 2s."}');
    const r = await askForEdits({ request: 'split at 2s', state: assistState(store), chat });
    expect(r).toEqual({ calls: [{ name: 'split', args: { time: 2 } }], text: 'Split at 2s.', via: 'json' });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[0][1].tools.length).toBe(TOOLS.length);
    expect(chat.mock.calls[1][1]).toBeUndefined();
    expect(chat.mock.calls[1][0][0].content).toMatch(/reply with only a JSON object/);
  });

  it('falls back to JSON when tool calling fails, and keeps a plain answer when there is nothing to do', async () => {
    const { store } = twoClips();
    const failing = vi.fn().mockRejectedValueOnce(new Error('tools not supported')).mockResolvedValueOnce('[{"tool":"move_playhead","args":{"time":1}}]');
    expect((await askForEdits({ request: 'go to 1s', state: assistState(store), chat: failing })).calls).toEqual([{ name: 'move_playhead', args: { time: 1 } }]);
    const chatty = vi.fn().mockResolvedValueOnce({ message: { content: 'Which clip do you mean?' } }).mockResolvedValueOnce('{"actions":[]}');
    expect(await askForEdits({ request: 'make it pop', state: assistState(store), chat: chatty })).toEqual({ calls: [], text: 'Which clip do you mean?', via: 'none' });
  });

  it('stops waiting as soon as the request is cancelled', async () => {
    const { store } = twoClips();
    const ac = new AbortController();
    const chat = () => new Promise(() => {});
    const p = askForEdits({ request: 'x', state: assistState(store), chat, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('summarizes the project and keeps recent conversation', () => {
    const { store, ctx, main } = twoClips();
    const t = ctx.actions.addText('plain', { text: 'Hello there', start: s(1) });
    store.select(t.id);
    store.seek(s(2));
    const brief = projectBrief(assistState(store));
    expect(brief).toMatch(/1920x1080 \(16:9\), 30 fps, length 8\.0s\. Playhead at 2\.0s/);
    expect(brief).toContain(`Selected: ${t.id}`);
    expect(brief).toContain(`${main().clips[0].id} video 0.0s-4.0s`);
    expect(brief).toMatch(/text 1\.0s-4\.0s "Hello there"/);
    expect(catalogBrief()).toMatch(/Filters: .*warm/);
    expect(catalogBrief()).toMatch(/Transitions: mix \(Dissolve\)/);
    const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const msgs = buildMessages(assistState(store), history, 'now');
    expect(msgs[0].role).toBe('system');
    expect(msgs).toHaveLength(HISTORY_LIMIT + 2);
    expect(msgs.at(-1)).toEqual({ role: 'user', content: 'now' });
  });
});

describe('store batches', () => {
  it('folds the steps of a batch into one, even when the history drops old steps meanwhile', () => {
    const store = new EditorStore(fixture());
    store.history.limit = 3;
    const edit = (n) => store.update(`Rename ${n}`, (p) => {
      p.name = `n${n}`;
    }, { structural: false });
    edit(1);
    edit(2);
    const mark = store.beginBatch();
    for (let i = 3; i <= 7; i++) edit(i);
    const onHistory = vi.fn();
    store.on('history', onHistory);
    const entry = store.endBatch(mark, 'Batch');
    expect(store.history.undoStack.map((e) => e.label)).toEqual(['Batch']);
    // The oldest state still kept: steps past the limit are gone either way.
    expect(entry.snapshot.name).toBe('n4');
    expect(onHistory).toHaveBeenCalledWith({ label: 'Batch' });
    expect(store.endBatch(store.beginBatch(), 'Empty')).toBe(null);
  });
});

describe('performing edits', () => {
  it('dispatches tool calls to the editor and makes them one undo step', async () => {
    const { store, ctx, main } = twoClips();
    const before = structuredClone(store.project);
    const runner = createAssistantRunner(ctx);
    const first = main().clips[0].id;
    const { results, entry, summary } = await runner.run([
      { name: 'set_filter', args: { clips: ['all_video'], filter: 'warm' } },
      { name: 'add_text', args: { text: 'Big news', start: 0, position: 'top', style: { size_scale: 2, color: 'red' } } },
      { name: 'set_speed', args: { clips: [first], speed: 2 } },
      { name: 'set_transition', args: { transition: 'mix', all: true } },
    ], { label: stepLabel('make it warm and add a title') });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(summary.done).toBe(4);
    expect(main().clips.map((c) => c.filter?.id)).toEqual(['warm', 'warm']);
    expect(findClip(store.project, first).clip.speed).toBe(2);
    expect(findClip(store.project, first).clip.transition?.id).toBe('mix');
    const text = allClips(store.project).find((c) => c.type === 'text');
    expect(text.text).toBe('Big news');
    expect(text.style.size).toBe(128);
    expect(text.style.color).toBe('#e5322d');
    expect(text.transform.y).toBeLessThan(0);
    // One step, labeled after the request; the new text is selected.
    expect(store.history.undoStack).toHaveLength(1);
    expect(store.history.undoLabel).toBe('Assistant: make it warm and add a title');
    expect(entry).toBe(store.history.undoStack[0]);
    expect(store.selectedIds).toEqual([text.id]);
    expect(runner.undo(entry)).toBe(true);
    expect(store.project.tracks).toEqual(before.tracks);
    expect(store.history.canUndo()).toBe(false);
  });

  it('keeps earlier undo steps apart and only undoes its own step while it is the latest', async () => {
    const { store, ctx, main } = twoClips();
    ctx.actions.addMarkerAt(s(1));
    const runner = createAssistantRunner(ctx);
    const { entry } = await runner.run([{ name: 'remove_time_range', args: { start: 0, end: 2 } }, { name: 'add_marker', args: { time: 0.5, label: 'Start' } }]);
    expect(store.history.undoStack).toHaveLength(2);
    expect(main().clips.map((c) => c.duration)).toEqual([s(2), s(4)]);
    ctx.actions.addMarkerAt(s(3));
    expect(runner.canUndo(entry)).toBe(false);
    expect(runner.undo(entry)).toBe(false);
    store.undo();
    expect(runner.undo(entry)).toBe(true);
    expect(main().clips.map((c) => c.duration)).toEqual([s(4), s(4)]);
    expect(store.project.markers).toHaveLength(1);
  });

  it('reports skipped calls, ignores unknown tools and records nothing when nothing changed', async () => {
    const { store, ctx } = twoClips();
    const runner = createAssistantRunner(ctx);
    const { results, entry, summary } = await runner.run([
      { name: 'fly_to_moon', args: {} },
      { name: 'set_speed', args: { clips: ['all_audio'], speed: 2 } },
      { name: 'split', args: { time: 8 } },
    ]);
    expect(results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(summary.lines[0].text).toMatch(/fly_to_moon: unknown edit/);
    expect(summary.lines[1].text).toMatch(/^Speed: /);
    expect(entry).toBe(null);
    expect(store.history.canUndo()).toBe(false);
  });

  it('checks each call against the project as earlier calls left it', async () => {
    const { store, ctx, main } = twoClips();
    const [a, b] = main().clips.map((c) => c.id);
    const runner = createAssistantRunner(ctx);
    const { results } = await runner.run([
      { name: 'delete_clips', args: { clips: [a] } },
      { name: 'set_speed', args: { clips: [a], speed: 2 } },
      { name: 'set_speed', args: { clips: ['first'], speed: 0.5 } },
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(main().clips.map((c) => [c.id, c.speed])).toEqual([[b, 0.5]]);
  });

  it('runs captions and silence removal through their analysis steps', async () => {
    const { store, ctx, main } = setup(clip('video', 0, 10));
    const findSilences = vi.fn(async () => [{ start: s(2), end: s(3) }, { start: s(6), end: s(7) }]);
    const prepareCaptions = vi.fn(async (c, opts, { mode }) => () => {
      c.store.update('Generate captions', (p) => {
        p.tracks.unshift({ id: 'tc', kind: 'text', locked: false, hidden: false, muted: false, clips: [] });
      }, { keepEmptyTracks: true });
      return mode === 'replace' ? 7 : 3;
    });
    const runner = createAssistantRunner(ctx, { findSilences, prepareCaptions });
    const progress = [];
    const { results } = await runner.run([
      { name: 'remove_silences', args: { min_silence: 0.01, threshold_db: -5 } },
      { name: 'add_captions', args: { language: 'German', style: 'word-pop', replace_existing: true, max_words: 40 } },
    ], { onProgress: (t) => progress.push(t) });
    expect(findSilences.mock.calls[0][1]).toMatchObject({ minSilence: 0.2, thresholdDb: -10, scope: 'main' });
    expect(main().clips.reduce((t, c) => t + c.duration, 0)).toBe(s(8));
    expect(prepareCaptions.mock.calls[0][1]).toMatchObject({ language: 'de', captionStyle: 'word-pop', preset: 'yellow-caption', maxWords: 12, scope: 'main' });
    expect(results.map((r) => r.text)).toEqual(['Removed 2 silent parts (2.0s in all)', 'Added 7 captions']);
    expect(progress).toContain('Listening for silences...');
    expect(store.history.undoStack).toHaveLength(1);
  });

  it('keeps edits and undos the user makes while captions are being made out of the request\'s undo step', async () => {
    const { store, ctx } = twoClips();
    const mark = (id) => (p) => { p.markers.push({ id, time: 0, label: '', color: 'red' }); };
    store.update('Edit A', mark('a'));
    store.update('Edit B', mark('b'));
    let open;
    const gate = () => new Promise((r) => (open = r));
    const prepareCaptions = vi.fn(async () => {
      await gate();
      return () => (store.update('Generate captions', mark('cap')), 1);
    });
    const runner = createAssistantRunner(ctx, { prepareCaptions });
    let running = runner.run([{ name: 'add_captions', args: {} }], { label: 'AI: captions' });
    await vi.waitFor(() => expect(open).toBeTypeOf('function'));
    store.update('User marker', mark('user'));
    open();
    let { entry } = await running;
    expect(store.history.undoStack.map((e) => e.label)).toEqual(['Edit A', 'Edit B', 'User marker', 'AI: captions']);
    expect(runner.undo(entry)).toBe(true);
    expect(store.project.markers.map((m) => m.id)).toEqual(['a', 'b', 'user']);

    // An undo meanwhile: the earlier steps stay as they were.
    open = null;
    running = runner.run([{ name: 'set_speed', args: { clips: ['first'], speed: 2 } }, { name: 'add_captions', args: {} }], { label: 'AI: speed and captions' });
    await vi.waitFor(() => expect(open).toBeTypeOf('function'));
    expect(store.history.undoLabel).toBe('AI: speed and captions');
    store.undo();
    open();
    ({ entry } = await running);
    expect(store.history.undoStack.map((e) => e.label)).toEqual(['Edit A', 'Edit B', 'User marker', 'AI: speed and captions']);
    expect(mainTrack(store.project).clips[0].speed).toBe(1);
    expect(runner.undo(entry)).toBe(true);
    expect(store.project.markers.map((m) => m.id)).toEqual(['a', 'b', 'user']);
  });

  it('summarizes what was done for the chat and for follow-up requests', () => {
    const sum = summarize([
      { ok: true, text: 'Added text "Hi" at 0.0s', ids: ['c1'] },
      { ok: false, text: 'Speed: no clips matched' },
      { ok: true, text: 'Cut out 0.0s to 2.0s' },
    ]);
    expect(sum.done).toBe(2);
    expect(sum.skipped).toBe(1);
    expect(sum.lines.map((l) => l.ok)).toEqual([true, true, false]);
    expect(sum.note).toBe('Done: Added text "Hi" at 0.0s [c1]; Cut out 0.0s to 2.0s. Skipped: Speed: no clips matched.');
    expect(summarize([]).note).toBe('Nothing was changed.');
    expect(stepLabel('x'.repeat(80))).toHaveLength('Assistant: '.length + 40);
  });
});

describe('edit assistant wording', () => {
  it('describes text style changes in a few words', () => {
    expect(styleWords({ sizeScale: 1.5, color: '#e5322d', bold: true, strokeColor: '#000000', strokeWidth: 6 })).toBe('bigger, color #e5322d, bold, outline');
  });
});
