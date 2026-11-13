import { afterEach, expect, it, vi } from 'vitest';
import { createProject, createClip } from '../src/model/project.js';
import * as E from '../src/model/edits.js';
import * as C from '../src/playlist/clips.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const project = createProject();
  const clip = createClip({ ref: project.patterns[0].id, len: 96 });
  project.clips = [{ ...clip, id: '00000000' }, { ...clip, id: 'source-b', track: 1 }];
  return project;
}

function collide(first = 0) {
  let call = 0;
  // Two allocations collide with the existing clip and each other, then
  // subsequent retries have distinct values. No probabilistic test outcome.
  return vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((bytes) => bytes.fill(first + Math.max(0, call++ - 1)));
}

function verify(project, result) {
  expect(result.ids).toHaveLength(2);
  expect(new Set(result.project.clips.map((c) => c.id)).size).toBe(4);
  expect(result.ids.every((id) => !project.clips.some((c) => c.id === id))).toBe(true);
  expect(result.ids.map((id) => result.project.clips.filter((c) => c.id === id).length)).toEqual([1, 1]);
  const removed = E.removeClips(result.project, [result.ids[0]]);
  expect(removed.clips).toHaveLength(3);
  expect(removed.clips.some((c) => c.id === result.ids[1])).toBe(true);
  expect(project.clips.map((c) => c.id)).toEqual(['00000000', 'source-b']);
}

it.each([0, 1])('keeps duplicated clips independently selectable after collisions starting at %i', (first) => {
  const project = fixture();
  collide(first);
  const result = C.duplicateClips(project, project.clips.map((c) => c.id));
  verify(project, result);
  expect(result.project.clips.slice(0, 2)).toEqual(project.clips);
  expect(result.project.clips.slice(2).map((c) => c.start)).toEqual([96, 96]);
});

it('keeps pasted clips independently selectable after random ID collisions', () => {
  const project = fixture();
  const board = C.copyClips(project, project.clips.map((c) => c.id));
  collide();
  verify(project, C.pasteClips(project, board, 192, 0));
  expect(board.clips.map((c) => c.id)).toEqual(['00000000', 'source-b']);
});

it('reserves IDs for new clips against existing clips and the whole added batch', () => {
  const project = fixture();
  collide();
  verify(project, E.addClips(project, [{ ref: project.patterns[0].id }, { ref: project.patterns[0].id }]));
});

it('remaps supplied clip IDs on collision without modifying the inputs', () => {
  const project = fixture();
  const inputs = project.clips.map((c) => ({ ...c, id: '00000000' }));
  collide();
  verify(project, E.addClips(project, inputs));
  expect(inputs.map((c) => c.id)).toEqual(['00000000', '00000000']);
});

it('keeps sliced halves distinct from existing clips and each other', () => {
  const project = fixture();
  collide();
  const result = C.sliceClips(project, 48);
  verify(project, result);
  expect(result.project.clips.map((c) => [c.start, c.len, c.offset])).toEqual([[0, 48, 0], [48, 48, 48], [0, 48, 0], [48, 48, 48]]);
});

it('does not give a standalone split half the original ID', () => {
  const project = fixture();
  collide();
  const [left, right] = C.splitClip(project.clips[0], 48);
  expect(right.id).not.toBe(left.id);
});

it('preserves supplied unique IDs and object sharing', () => {
  const project = fixture();
  const inputs = project.clips.map((c, i) => ({ ...c, id: `copy-${i}` }));
  const random = collide();
  const result = E.addClips(project, inputs);
  expect(result.ids).toEqual(['copy-0', 'copy-1']);
  expect(result.project.clips[2]).toBe(inputs[0]);
  expect(result.project.clips[3]).toBe(inputs[1]);
  expect(random).not.toHaveBeenCalled();
});

it('reserves IDs of clips that occur later in the slice traversal', () => {
  const project = fixture();
  project.clips[1] = { ...project.clips[1], id: '11111111' };
  collide(1);
  const result = C.sliceClips(project, 48, (c) => c.track === 0);
  expect(result.ids).toHaveLength(1);
  expect(result.ids[0]).not.toBe('11111111');
  expect(result.project.clips[2]).toBe(project.clips[1]);
  expect(new Set(result.project.clips.map((c) => c.id)).size).toBe(3);
});
