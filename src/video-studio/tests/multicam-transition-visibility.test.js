import { describe, it, expect } from 'vitest';
import { fixture, clip, onMain, s } from './helpers.js';
import { createMulticam } from '../src/model/multicam-edit.js';
import { addClip, setTransition } from '../src/model/timeline.js';
import { normalizeProject } from '../src/model/project.js';
import { evaluate, audibleClips, gainAt } from '../src/engine/scene.js';

const FREE = { ripple: false, linkOverlays: false };
function setup(cuts) {
  const p = fixture();
  const [a] = onMain(p, clip('video', 0, 2, { name: 'A first' }));
  const b = clip('video', 0, 4, { name: 'B' }); addClip(p, b, FREE);
  const c = createMulticam(p, [a.id, b.id], FREE);
  c.sequence.tracks[0].clips.push(clip('video', 2, 2, { name: 'A second' }));
  setTransition(c.sequence, a.id, 'mix', s(1));
  c.multicam.audio = 0;
  c.multicam.cuts = cuts.map(([time, angle]) => ({ t: s(time), angle }));
  return p;
}

describe('transitions on the camera supplying fixed audio', () => {
  it.each([
    { cuts: [[0, 1]], angles: [1, 1, 1, 1] },
    { cuts: [[0, 0], [1.9, 1], [2.1, 0]], angles: [0, 1, 1, 0] },
    { cuts: [[0, 1], [1.9, 0], [2.1, 1]], angles: [1, 0, 0, 1] },
  ])('shows only the selected angle while audio continues ($cuts)', ({ cuts, angles }) => {
    const p = setup(cuts);
    const raw = JSON.stringify(p);
    for (const q of [p, normalizeProject(JSON.parse(raw))]) {
      [1.75, 1.95, 2.05, 2.25].forEach((sec, i) => {
        const t = s(sec);
        const layers = evaluate(q, t);
        expect(layers).toHaveLength(1);
        if (angles[i] === 1) {
          expect(layers[0].kind).toBe('media');
          expect(layers[0].clip.name).toBe('B');
        } else {
          expect(layers[0].kind).toBe('transition');
          expect(layers[0].from.clip.name).toBe('A first');
          expect(layers[0].to.clip.name).toBe('A second');
          expect(layers[0].progress).toBeCloseTo(sec - 1.5);
        }
        const sound = audibleClips(q).filter(({ clip: c }) => c.start <= t && t < c.start + c.duration);
        expect(sound).toHaveLength(1);
        expect(sound[0].clip.name).toBe(sec < 2 ? 'A first' : 'A second');
        expect(gainAt(sound[0].clip, t)).toBe(1);
      });
    }
    expect(JSON.stringify(p)).toBe(raw);
  });
});
