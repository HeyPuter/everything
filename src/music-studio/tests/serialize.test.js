// Project files: every field survives a save and load, and hostile or damaged
// input is repaired instead of breaking the editors or the engine.
import { describe, it, expect } from 'vitest';
import { serializeProject, parseProject, KIND } from '../src/model/serialize.js';
import { demoProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { createSlot, createMixerTrack, createChannel, createPattern, createNote, createClip, MAX_MIXER_TRACKS } from '../src/model/project.js';
import { addMarker, deleteTrack, makeUnique } from '../src/playlist/clips.js';
import { cloneSource } from '../src/playlist/menus.js';
import { Store } from '../src/model/store.js';
import { addPoint } from '../src/automation/points.js';
import { resolveTarget } from '../src/automation/targets.js';
import { compileAutomation } from '../src/engine/compile.js';

function richProject() {
  let p = demoProject();
  const ch = p.channels[0];
  const pat = p.patterns[0];
  p = E.updatePattern(p, pat.id, { length: 384 * 3, color: '#123456' });
  const auto = E.addAutomation(p, { name: 'Cut', target: { kind: 'channel', id: ch.id, param: 'volume' }, points: [{ t: 0, v: 0.2 }, { t: 96, v: 0.9 }], color: '#abcdef' });
  p = auto.project;
  p = E.addClips(p, [{ kind: 'auto', track: 3, start: 0, len: 384, ref: auto.id }]).project;
  p = E.setLoop(p, { start: 96, end: 384 * 2 });
  p = addMarker(p, { pos: 384, name: 'Chorus' }).project;
  p = E.addSample(p, { id: 'smp1', name: 'Kick.wav', path: 'Samples/Kick.wav', duration: 1.5, rate: 44100, channels: 1 }).project;
  p = E.updateMixerTrack(p, 2, { fx: [createSlot('delay')], routes: { 0: 1, 3: 0.5 }, width: 1.4, color: '#00ff00' });
  p = E.setProjectProps(p, { swing: 0.3, masterPitch: 50, sig: [3, 4] });
  return p;
}

describe('project files', () => {
  it.each(['pattern', 'audio', 'auto'])('keeps a cloned long %s name distinct and stable on reopen', (kind) => {
    let p = richProject();
    const name = 'A'.repeat(56) + '🎹zz'; // 60 UTF-16 code units.
    let id;
    if (kind === 'pattern') {
      id = p.patterns[0].id;
      p = E.updatePattern(p, id, { name });
    } else if (kind === 'audio') {
      id = p.channels[0].id;
      p = E.updateChannel(p, id, { name });
    } else {
      const r = E.addAutomation(p, { name, target: { kind: 'tempo' } });
      p = r.project;
      id = r.id;
    }
    const getName = (project, ref) => kind === 'pattern' ? project.patterns.find((x) => x.id === ref).name : kind === 'audio' ? project.channels.find((x) => x.id === ref).name : project.automation[ref].name;
    const store = new Store(p);
    let cloned;
    cloneSource({ store, setSource: (src) => { cloned = src.id; } }, { kind, id });
    const cloneName = getName(store.project, cloned);
    expect(getName(parseProject(serializeProject(store.project)), cloned)).toBe(cloneName);
    expect(cloneName.length).toBeLessThanOrEqual(60);
    expect(cloneName.endsWith(' #2')).toBe(true);
    expect(cloneName).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const added = E.addClips(p, [{ kind, ref: id, track: 0, start: 0, len: 96 }]);
    const unique = makeUnique(added.project, added.ids[0]);
    const uniqueName = getName(unique.project, unique.id);
    expect(uniqueName).toBe(cloneName);
    expect(getName(parseProject(serializeProject(unique.project)), unique.id)).toBe(cloneName);
  });

  it.each(['channels', 'patterns', 'tracks', 'clips', 'notes', 'points', 'markers'])('preserves editor-created %s past the former file-only cutoff', (kind) => {
    let p = richProject();
    let read;
    if (kind === 'channels') {
      p.channels = Array.from({ length: 512 }, () => createChannel());
      p = E.addChannel(p, createChannel({ name: 'Keep this channel' })).project;
      read = (project) => project.channels;
    } else if (kind === 'patterns') {
      p.patterns = Array.from({ length: 999 }, (_, i) => createPattern(i));
      p = E.addPattern(p, { name: 'Keep this pattern' }).project;
      read = (project) => project.patterns;
    } else if (kind === 'tracks') {
      p = E.ensureTracks(p, 501);
      p = E.addClips(p, [{ kind: 'pattern', ref: p.patterns[0].id, track: 500, start: 0, len: 96 }]).project;
      read = (project) => ({ tracks: project.tracks, clips: project.clips });
    } else if (kind === 'clips') {
      p.clips = Array.from({ length: 50000 }, (_, i) => createClip({ kind: 'pattern', ref: p.patterns[0].id, track: 0, start: i * 96, len: 96 }));
      p = E.addClips(p, [{ kind: 'pattern', ref: p.patterns[0].id, track: 0, start: 50000 * 96, len: 96 }]).project;
      read = (project) => project.clips;
    } else if (kind === 'notes') {
      const pid = p.patterns[0].id, cid = p.channels[0].id;
      p = E.setNotes(p, pid, cid, Array.from({ length: 100000 }, (_, i) => ({ ...createNote({ pos: i * 24 }), id: `n${i}` })));
      p = E.addNotes(p, pid, cid, [createNote({ pos: 100000 * 24 })]);
      read = (project) => project.patterns[0].notes[cid];
    } else if (kind === 'points') {
      const points = Array.from({ length: 10000 }, (_, i) => ({ t: i * 24, v: 0.5 }));
      p = E.addAutomation(p, { id: 'large-auto', target: { kind: 'tempo' }, points: addPoint(points, { t: 240000, v: 0.9 }).points }).project;
      read = (project) => project.automation['large-auto'].points;
    } else {
      p.markers = Array.from({ length: 1000 }, (_, i) => ({ id: `m${i}`, pos: i * 384, name: `Marker ${i}` }));
      p = addMarker(p, { pos: 384000, name: 'Keep this marker' }).project;
      read = (project) => project.markers;
    }
    const expected = read(p);
    const actual = read(parseProject(serializeProject(p)));
    // Compare compact JSON to avoid printing thousands of objects on failure.
    expect(JSON.stringify(actual) === JSON.stringify(expected)).toBe(true);
  });

  it('reports unsupported mixer capacity instead of silently deleting tracks', () => {
    const p = richProject();
    p.mixer = Array.from({ length: MAX_MIXER_TRACKS + 1 }, (_, i) => createMixerTrack(i));
    expect(() => parseProject(serializeProject(p))).toThrow(/255 mixer inserts/);
  });

  it.each([129, 256])('preserves all %i mixer tracks, routing and automation on reopen', (count) => {
    let p = richProject();
    while (p.mixer.length < count) p = E.addMixerTrack(p).project;
    const last = count - 1;
    p = E.updateMixerTrack(p, last, { fx: [createSlot('delay')], volume: 0.4 });
    p = E.updateChannel(p, p.channels[0].id, { mixer: last });
    p = E.setRoute(p, 1, last, 0.7);
    p = E.addAutomation(p, { name: 'Insert volume', target: { kind: 'mixer', track: last, param: 'volume' }, points: [{ t: 0, v: 0.4 }] }).project;
    p = E.addAutomation(p, { name: 'Delay wet', target: { kind: 'fx', track: last, slot: p.mixer[last].fx[0].id, param: 'wet' }, points: [{ t: 0, v: 0.8 }] }).project;
    const back = parseProject(serializeProject(p));
    expect(back.mixer).toHaveLength(count);
    expect(back.mixer).toEqual(p.mixer);
    expect(back.channels).toEqual(p.channels);
    expect(back.automation).toEqual(p.automation);
  });

  it.each([1, 15])('preserves a playlist reduced to %i tracks after reopening', (count) => {
    let p = richProject();
    while (p.tracks.length > count) p = deleteTrack(p, p.tracks.length - 1);
    const back = parseProject(serializeProject(p));
    expect(back.tracks).toHaveLength(count);
    expect(back.tracks).toEqual(p.tracks);
    expect(back.clips).toEqual(p.clips);
  });

  it('preserves effect automation addressed by slot index across save and load', () => {
    let p = richProject();
    const added = E.addAutomation(p, { name: 'Delay wet', target: { kind: 'fx', track: 2, slot: 0, param: 'wet' }, points: [{ t: 0, v: 0.2 }, { t: 96, v: 0.8 }] });
    p = E.addClips(added.project, [{ kind: 'auto', track: 3, start: 0, len: 384, ref: added.id }]).project;
    const back = parseProject(serializeProject(p));
    expect(resolveTarget(back, back.automation[added.id].target)).toEqual(resolveTarget(p, p.automation[added.id].target));
    expect(compileAutomation(back, (id) => back.channels.findIndex((c) => c.id === id))).toEqual(compileAutomation(p, (id) => p.channels.findIndex((c) => c.id === id)));
  });

  it.each(['channels', 'effects'])('drops invalid %s types even when they name inherited properties', (collection) => {
    const data = JSON.parse(serializeProject(richProject()));
    const validChannels = data.channels.length;
    const validEffects = data.mixer[2].fx.length;
    const list = collection === 'channels' ? data.channels : data.mixer[2].fx;
    for (const type of ['constructor', 'toString', '__proto__', [list[0].type]]) {
      list.push({ id: 'invalid', type, params: {} });
    }
    const back = parseProject(data);
    expect(back.channels).toHaveLength(validChannels);
    expect(back.mixer[2].fx).toHaveLength(validEffects);
    expect(parseProject(serializeProject(back))).toEqual(back);
  });

  it('round-trips every field', () => {
    const p = richProject();
    const back = parseProject(serializeProject(p));
    const { ui, ...rest } = back;
    const { ui: _ui, ...want } = p;
    expect(rest).toEqual(want);
    expect(ui.pattern).toBe(p.patterns[0].id);
    expect(Object.values(back.automation).at(-1).color).toBe('#abcdef');
  });

  it('ignores ids that collide with Object.prototype members', () => {
    const p = demoProject();
    const data = JSON.parse(serializeProject(p));
    data.samples = JSON.parse('{"__proto__": {"id": "__proto__", "name": "x"}, "a": {"id": "toString", "name": "y"}}');
    data.channels[0].sample = 'toString';
    data.channels[1].sample = 'constructor';
    data.automation = JSON.parse('{"__proto__": {"id": "__proto__", "target": {"kind": "tempo"}, "points": []}}');
    data.clips.push({ id: 'z', kind: 'auto', track: 0, start: 0, len: 96, ref: 'constructor' }, { id: 'y', kind: 'auto', track: 0, start: 0, len: 96, ref: 'hasOwnProperty' });
    data.channels[2].id = '__proto__';
    const back = parseProject(data);
    expect(Object.getPrototypeOf(back.samples)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(back.automation)).toBe(Object.prototype);
    for (const s of Object.values(back.samples)) expect(['__proto__', 'toString']).not.toContain(s.id);
    expect(back.channels[0].sample).toBe(null);
    expect(back.channels[1].sample).toBe(null);
    expect(back.channels[2].id).not.toBe('__proto__');
    for (const c of back.clips) if (c.kind === 'auto') expect(Object.hasOwn(back.automation, c.ref)).toBe(true);
    expect(back.clips.some((c) => c.ref === 'constructor' || c.ref === 'hasOwnProperty')).toBe(false);
  });

  it('repairs wrong types, duplicate ids and bad loops', () => {
    const p = demoProject();
    const data = JSON.parse(serializeProject(p));
    data.loop = { start: 'x', end: 400 };
    data.channels.push({ ...data.channels[0] });
    data.patterns.push({ ...data.patterns[0] });
    data.clips.push({ ...data.clips[0] });
    data.bpm = 'fast';
    data.tracks = 'none';
    data.markers = [null, 5, { pos: -5, name: 7 }];
    const back = parseProject(data);
    expect(back.loop).toEqual({ start: 0, end: 400 });
    expect(back.bpm).toBe(130);
    expect(back.tracks.length).toBe(16);
    expect(back.markers).toEqual([{ id: expect.any(String), pos: 0, name: 'Marker' }]);
    for (const list of [back.channels, back.patterns, back.clips]) expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    expect(() => parseProject('{"kind": "other"}')).toThrow(/not a Music Studio project/);
    expect(() => parseProject({ kind: KIND, version: 99 })).toThrow(/newer version/);
    expect(parseProject({ kind: KIND }).patterns.length).toBe(1);
  });
});
