// Project files: every field survives a save and load, and hostile or damaged
// input is repaired instead of breaking the editors or the engine.
import { describe, it, expect } from 'vitest';
import { serializeProject, parseProject, KIND } from '../src/model/serialize.js';
import { demoProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { createSlot } from '../src/model/project.js';
import { addMarker } from '../src/playlist/clips.js';

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
