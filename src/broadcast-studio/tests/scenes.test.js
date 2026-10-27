import { describe, expect, it } from 'vitest';
import {
  addLayer,
  compositeLayers,
  createShow,
  cutToProgram,
  previewScene,
  programScene,
  setPreview,
} from '../src/engine/scenes.js';

describe('broadcast scenes', () => {
  it('creates preview scenes', () => {
    const show = createShow();
    expect(show.scenes.length).toBeGreaterThanOrEqual(2);
    expect(previewScene(show)?.name).toBe('Interview');
  });

  it('cuts preview to program', () => {
    let show = createShow();
    show = setPreview(show, 'scene-b');
    show = cutToProgram(show);
    expect(programScene(show)?.id).toBe('scene-b');
  });

  it('composites overlays by z', () => {
    const show = createShow();
    const layers = compositeLayers(show, previewScene(show));
    expect(layers[layers.length - 1].z).toBeGreaterThanOrEqual(layers[0].z);
  });

  it('adds layers to a scene', () => {
    let show = createShow();
    show = addLayer(show, 'scene-a', {
      kind: 'image',
      label: 'Logo',
      x: 10,
      y: 10,
      w: 80,
      h: 40,
      z: 8,
    });
    expect(previewScene(show).layers.some((l) => l.label === 'Logo')).toBe(true);
  });
});
