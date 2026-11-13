import { describe, expect, it } from 'vitest';
import { allLayers, findLayer, layer, newDocument, resizeDocument, type PhotoDocument } from '../src/model/document';
import {
  applyFrame,
  createAnimation,
  deleteFrames,
  duplicateFrames,
  frameAt,
  frameContent,
  frameDocument,
  framesFromLayers,
  gifLoop,
  matchLayersAcrossFrames,
  moveFrames,
  reverseFrames,
  sampleFrames,
  setFrameDelay,
  sharedContent,
  syncAnimation,
  tweenFrames,
  tweenState,
  tweenValue,
  validateAnimation,
  type FrameLayerState,
} from '../src/model/animation';
import { followLinkedMasks } from '../src/model/links';
import { History } from '../src/history/history';
import { newPixelLayer, commitPixelTranslation, pixelTransformKind, syncPixelTransform } from '../src/model/pixel-layer';
import { TileStore, filledMask, gridFromImage, writeRect } from '../src/model/tiles';
import { validateDocument } from '../src/model/serialization';

const store = new TileStore();
function square(color: number, size = 8) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set([color, 0, 0, 255], i);
  return { width: size, height: size, data };
}
/** A history that normalizes like the editor: bake pixel moves, then record frames. */
function session(doc: PhotoDocument) {
  const h = new History(doc);
  h.normalize = (d, before) => {
    followLinkedMasks(before, d, store);
    for (const l of allLayers(d.layers)) if (l.kind === 'pixel' && pixelTransformKind(l) === 'translate') commitPixelTranslation(l);
    syncAnimation(d, before);
  };
  return h;
}
function fixture() {
  const doc = newDocument(100, 80);
  const px = newPixelLayer('Ball', doc, gridFromImage(store, square(200), 10, 10));
  const img = layer('solid', 'Card', 20, 20);
  img.transform.x = 50;
  doc.layers = [px, img];
  doc.animation = createAnimation(doc);
  const h = session(doc);
  return { h, px: px.id, img: img.id };
}
const get = (h: History, id: string) => findLayer(h.document.layers, id)!;
const state = (h: History, frame: number, id: string) => h.document.animation!.frames[frame].layers[id];

describe('frame animation model', () => {
  it('records the document as the first frame and validates in projects', () => {
    const { h, px, img } = fixture();
    const a = h.document.animation!;
    expect(a.frames).toHaveLength(1);
    expect(a.frames[0].layers[px]).toEqual({ visible: true, dx: 0, dy: 0, opacity: 1, blend: 'normal' });
    expect(Object.keys(a.frames[0].layers)).toEqual([px, img]);
    expect(validateDocument(JSON.parse(JSON.stringify(h.document)))).toBeTruthy();
  });

  it('does not record a new frame of an embedded object as a move of the current frame', () => {
    const { h, img } = fixture();
    h.execute('Embed', (d) => {
      const l = findLayer(d.layers, img)!;
      l.kind = 'image';
      l.embed = { contents: 'c' };
    });
    h.execute('New Frame', (d) => duplicateFrames(d, [0]));
    // Flip Canvas: the object gets a mirrored frame at the mirrored place.
    h.execute('Flip Canvas Horizontal', (d) => {
      const l = findLayer(d.layers, img)!;
      l.transform = { ...l.transform, x: 30 };
      l.embed = { contents: 'c', frame: { quad: [[50, 0], [30, 0], [30, 20], [50, 20]], rect: { x: 30, y: 0, width: 20, height: 20 }, source: '' } };
    });
    expect([state(h, 0, img).dx, state(h, 1, img).dx]).toEqual([0, 0]);
    // Moving it afterwards is a move in this frame.
    h.execute('Move', (d) => void (findLayer(d.layers, img)!.transform.x = 35));
    expect([state(h, 0, img).dx, state(h, 1, img).dx]).toEqual([0, 5]);
  });

  it('restoring an earlier state (revert, snapshot, version) is not a move', () => {
    const { h, img } = fixture();
    h.execute('New Frame', (d) => duplicateFrames(d, [0]));
    const saved = h.document;
    h.execute('Move', (d) => void (findLayer(d.layers, img)!.transform.x = 62));
    expect(state(h, 1, img).dx).toBe(12);
    h.execute('Revert', (d) => Object.assign(d, structuredClone(saved)));
    expect(get(h, img).transform.x).toBe(50);
    expect([state(h, 0, img).dx, state(h, 1, img).dx]).toEqual([0, 0]);
  });

  it('keeps visibility and opacity per frame', () => {
    const { h, px, img } = fixture();
    h.execute('New Frame', (d) => duplicateFrames(d, [0]));
    expect(h.document.animation!.current).toBe(1);
    h.execute('Hide', (d) => (findLayer(d.layers, img)!.visible = false));
    h.execute('Opacity', (d) => (findLayer(d.layers, px)!.opacity = 0.5));
    expect(state(h, 0, img).visible).toBe(true);
    expect(state(h, 1, img).visible).toBe(false);
    h.execute('Select Frame', (d) => applyFrame(d, 0));
    expect(get(h, img).visible).toBe(true);
    expect(get(h, px).opacity).toBe(1);
    h.execute('Select Frame', (d) => applyFrame(d, 1));
    expect(get(h, img).visible).toBe(false);
    expect(get(h, px).opacity).toBe(0.5);
  });

  it.each([false, true])('renders non-pixel masks like selecting a frame (unlinked=%s)', (unlinked) => {
    const { h, img } = fixture();
    h.execute('Mask', (d) => {
      const l = findLayer(d.layers, img)!;
      l.maskGrid = filledMask(store, { x: 50, y: 0, width: 10, height: 20 });
      l.maskUnlinked = unlinked;
      l.vectorMask = { unlinked, mask: { paths: [{ open: false, fillRule: 'non-zero', operation: 'combine', knots: [{ linked: false, points: [50, 0, 50, 0, 50, 0] }] }] } };
    });
    h.execute('New Frame', (d) => duplicateFrames(d, [0]));
    h.execute('Move', (d) => {
      const l = findLayer(d.layers, img)!;
      l.transform.x += 12;
      l.transform.y += 7;
    });
    const before = structuredClone(h.document);
    const rendered = frameDocument(h.document, 0);
    expect(h.document).toEqual(before);
    h.execute('Select Frame', (d) => applyFrame(d, 0));
    expect(findLayer(rendered.layers, img)).toEqual(get(h, img));
    // The same comparison in the other direction catches double translations.
    expect(findLayer(frameDocument(h.document, 1).layers, img)).toEqual(findLayer(before.layers, img));
  });

  it('ignores a frame index that is not a frame number', () => {
    const { h } = fixture();
    h.execute('New Frame', (d) => duplicateFrames(d, [0]));
    const before = h.document;
    for (const bad of [NaN, 0.5, -1, 2]) h.execute('Select Frame', (d) => applyFrame(d, bad));
    expect(h.document).toBe(before);
  });

  it('moves layers per frame and shares painted pixels between frames', () => {
    const { h, px, img } = fixture();
    h.execute('New Frame', (d) => duplicateFrames(d, [0]));
    // Move both layers in frame 2 (pixel moves bake into the tile origin).
    h.execute('Move', (d) => {
      findLayer(d.layers, px)!.transform.x += 15;
      findLayer(d.layers, img)!.transform.y += 7;
    });
    expect(get(h, px).pixels!.x).toBe(15);
    expect(state(h, 1, px)).toMatchObject({ dx: 15, dy: 0 });
    expect(state(h, 1, img)).toMatchObject({ dx: 0, dy: 7 });
    expect(state(h, 0, px)).toMatchObject({ dx: 0, dy: 0 });
    // Painting in frame 2 changes the shared content: frame 1 shows the new
    // pixels at its own position.
    h.execute('Paint', (d) => {
      const l = findLayer(d.layers, px)!;
      l.pixels = writeRect(store, l.pixels!, 40, 10, square(90, 4));
      syncPixelTransform(l, d);
    });
    expect(state(h, 1, px).dx).toBe(15);
    const f0 = frameDocument(h.document, 0);
    const l0 = findLayer(f0.layers, px)!;
    expect(l0.pixels!.x).toBe(0);
    expect(l0.pixels!.tiles).toEqual(get(h, px).pixels!.tiles);
    expect(findLayer(f0.layers, img)!.transform.y).toBe(0);
    // Round trip through the frames lands on the same positions.
    h.execute('Select Frame', (d) => applyFrame(d, 0));
    h.execute('Select Frame', (d) => applyFrame(d, 1));
    expect(get(h, px).pixels!.x).toBe(15);
    expect(get(h, img).transform.y).toBe(7);
  });

  it('applies unified properties to every frame', () => {
    const { h, img } = fixture();
    h.execute('Frames', (d) => duplicateFrames(d, [0]));
    h.execute('Unify', (d) => (d.animation!.unify = { position: true, visibility: true }));
    h.execute('Move', (d) => (findLayer(d.layers, img)!.transform.x += 4));
    h.execute('Hide', (d) => (findLayer(d.layers, img)!.visible = false));
    expect(state(h, 0, img)).toMatchObject({ dx: 4, visible: false });
    h.execute('Select Frame', (d) => applyFrame(d, 0));
    expect(get(h, img).transform.x).toBe(54);
  });

  it('adds new layers to every frame and drops deleted ones', () => {
    const { h, px } = fixture();
    h.execute('Frames', (d) => duplicateFrames(d, [0]));
    const extra = layer('solid', 'New', 10, 10);
    h.execute('New Layer', (d) => d.layers.push(extra));
    expect(state(h, 0, extra.id)?.visible).toBe(true);
    h.execute('Delete', (d) => (d.layers = d.layers.filter((l) => l.id !== px)));
    expect(state(h, 0, px)).toBeUndefined();
    expect(state(h, 1, px)).toBeUndefined();
  });

  it('treats canvas size changes as edits to every frame', () => {
    const { h, img } = fixture();
    h.execute('Frames', (d) => duplicateFrames(d, [0]));
    h.execute('Move', (d) => (findLayer(d.layers, img)!.transform.x += 10));
    // Canvas size with an anchor shifts every layer and changes the size.
    h.execute('Canvas Size', (d) => {
      d.width += 20;
      for (const l of d.layers) l.transform.x += 20;
    });
    expect(state(h, 1, img).dx).toBe(10);
    h.execute('Select Frame', (d) => applyFrame(d, 0));
    expect(get(h, img).transform.x).toBe(70);
    // Image size scales the offsets along with the layers.
    h.execute('Select Frame', (d) => applyFrame(d, 1));
    h.execute('Image Size', (d) => resizeDocument(d, d.width * 2, d.height * 2));
    expect(state(h, 1, img).dx).toBe(20);
  });

  it('does not create history entries for edits that change nothing', () => {
    const { h } = fixture();
    h.execute('Frames', (d) => duplicateFrames(d, [0]));
    const before = h.document;
    h.execute('Nothing', () => {});
    expect(h.document).toBe(before);
  });

  it('coalesces repeated frame selection into one history step', () => {
    const { h } = fixture();
    h.execute('Frames', (d) => (duplicateFrames(d, [0]), duplicateFrames(d, [0])));
    const start = h.document;
    expect(h.document.animation!.frames).toHaveLength(3);
    h.execute('Select Frame', (d) => applyFrame(d, 0), true);
    h.execute('Select Frame', (d) => applyFrame(d, 2), true);
    expect(h.labels.filter((l) => l === 'Select Frame')).toHaveLength(1);
    expect(h.document.animation!.current).toBe(2);
    h.execute('Select Frame', (d) => applyFrame(d, 1), true);
    // Back on the frame before the selections: the step disappears.
    expect(h.labels).toEqual(['Frames']);
    expect(h.document).toBe(start);
  });

  it('deletes, reverses, moves and duplicates frames', () => {
    const { h, img } = fixture();
    h.execute('Frames', (d) => duplicateFrames(d, [0]));
    h.execute('Hide', (d) => (findLayer(d.layers, img)!.visible = false));
    h.execute('Frames', (d) => duplicateFrames(d, [1]));
    h.execute('Show', (d) => (findLayer(d.layers, img)!.visible = true));
    h.execute('Delay', (d) => setFrameDelay(d, [0, 1, 2], 250));
    const ids = h.document.animation!.frames.map((f) => f.id);
    h.execute('Reverse', (d) => reverseFrames(d, []));
    expect(h.document.animation!.frames.map((f) => f.id)).toEqual([...ids].reverse());
    expect(h.document.animation!.current).toBe(0);
    h.execute('Move', (d) => moveFrames(d, [0], 2));
    expect(h.document.animation!.frames.map((f) => f.id)).toEqual([ids[1], ids[0], ids[2]]);
    // Deleting the current frame shows the next surviving one.
    h.execute('Select Frame', (d) => applyFrame(d, 0));
    h.execute('Delete Frame', (d) => deleteFrames(d, [0]));
    expect(h.document.animation!.frames.map((f) => f.id)).toEqual([ids[0], ids[2]]);
    expect(get(h, img).visible).toBe(true);
    expect(h.document.animation!.frames.every((f) => f.delay === 250)).toBe(true);
    // The last frame is never deleted.
    expect(deleteFrames(structuredClone(h.document), [0, 1])).toBe(false);
  });

  it('makes one frame per top-level layer', () => {
    const doc = newDocument(50, 50);
    doc.layers = ['A', 'B', 'C'].map((n) => layer('solid', n, 50, 50));
    const h = session(doc);
    h.execute('Make Frames', (d) => framesFromLayers(d, [100, 200, 300], 1));
    const a = h.document.animation!;
    expect(a.frames.map((f) => f.delay)).toEqual([100, 200, 300]);
    expect(a.loop).toBe(1);
    expect(h.document.layers.map((l) => l.visible)).toEqual([true, false, false]);
    a.frames.forEach((f, i) => expect(h.document.layers.map((l) => f.layers[l.id].visible)).toEqual([0, 1, 2].map((k) => k === i)));
    h.execute('Select Frame', (d) => applyFrame(d, 2));
    expect(h.document.layers.map((l) => l.visible)).toEqual([false, false, true]);
    expect(framesFromLayers(newDocument(10, 10))).toBe(false);
  });

  it('copies a layer state to all frames', () => {
    const { h, img } = fixture();
    h.execute('Frames', (d) => (duplicateFrames(d, [0]), duplicateFrames(d, [0])));
    h.execute('Move', (d) => (findLayer(d.layers, img)!.transform.x += 3));
    h.execute('Match', (d) => matchLayersAcrossFrames(d, [img]));
    expect(h.document.animation!.frames.map((f) => f.layers[img].dx)).toEqual([3, 3, 3]);
  });
});

describe('frame render keys', () => {
  it.each(['maskGrid', 'liveSource', 'liveMask'] as const)('invalidates renders when %s moves without changing tiles', (field) => {
    const { h, px } = fixture();
    h.execute('Grid', (d) => {
      findLayer(d.layers, px)![field] = filledMask(store, { x: 10, y: 10, width: 4, height: 4 });
    });
    const before = sharedContent(h.document);
    h.execute('Move grid', (d) => { findLayer(d.layers, px)![field]!.x += 3; });
    expect(sharedContent(h.document)).not.toBe(before);
  });

  it.each([false, true])('keeps mask and live grid keys stable when selecting another frame (unlinked=%s)', (unlinked) => {
    const { h, px, img } = fixture();
    h.execute('Grids', (d) => {
      for (const id of [px, img]) {
        const l = findLayer(d.layers, id)!;
        l.maskGrid = filledMask(store, { x: 10, y: 10, width: 4, height: 4 });
        l.maskUnlinked = unlinked;
      }
      const l = findLayer(d.layers, px)!;
      l.liveSource = structuredClone(l.pixels!);
      l.liveMask = structuredClone(l.maskGrid!);
    });
    h.execute('New Frame', (d) => duplicateFrames(d, [0]));
    h.execute('Move', (d) => {
      findLayer(d.layers, px)!.transform.x += 12;
      findLayer(d.layers, img)!.transform.y += 7.5;
    });
    const before = sharedContent(h.document);
    h.execute('Select Frame', (d) => applyFrame(d, 0));
    expect(sharedContent(h.document)).toBe(before);
  });

  it('identify what each frame shows regardless of the frame selected', () => {
    const { h, px, img } = fixture();
    h.execute('Frames', (d) => duplicateFrames(d, [0]));
    h.execute('Move', (d) => {
      findLayer(d.layers, px)!.transform.x += 5;
      findLayer(d.layers, img)!.visible = false;
    });
    const key = (doc: PhotoDocument, i: number) => sharedContent(doc) + frameContent(doc, i);
    const onSecond = [key(h.document, 0), key(h.document, 1)];
    expect(onSecond[0]).not.toBe(onSecond[1]);
    h.execute('Select Frame', (d) => applyFrame(d, 0));
    expect([key(h.document, 0), key(h.document, 1)]).toEqual(onSecond);
    // Frame documents built for rendering agree.
    expect(sharedContent(frameDocument(h.document, 1)) + frameContent(h.document, 1)).toBe(onSecond[1]);
    // Painting changes the shared content and so every key.
    h.execute('Paint', (d) => {
      const l = findLayer(d.layers, px)!;
      l.pixels = writeRect(store, l.pixels!, 30, 30, square(10, 2));
    });
    expect(key(h.document, 0)).not.toBe(onSecond[0]);
  });
});

describe('tweening', () => {
  const s = (o: Partial<FrameLayerState>): FrameLayerState => ({ visible: true, dx: 0, dy: 0, opacity: 1, blend: 'normal', ...o });
  const all = { position: true, opacity: true, effects: true };
  it('interpolates position, opacity and fill', () => {
    const t = tweenState(s({ dx: 0, dy: 10, opacity: 0.2 }), s({ dx: 40, dy: -10, opacity: 1, fillOpacity: 0 }), 0.25, all);
    expect(t).toMatchObject({ dx: 10, dy: 5, opacity: 0.4, fillOpacity: 0.75, visible: true });
  });
  it('fades layers that are visible in only one frame', () => {
    const fadeIn = tweenState(s({ visible: false, opacity: 1 }), s({ opacity: 0.8 }), 0.5, all);
    expect(fadeIn.visible).toBe(true);
    expect(fadeIn.opacity).toBeCloseTo(0.4);
    // Without opacity tweening visibility switches halfway.
    expect(tweenState(s({ visible: false }), s({}), 0.4, { ...all, opacity: false }).visible).toBe(false);
    expect(tweenState(s({ visible: false }), s({}), 0.6, { ...all, opacity: false }).visible).toBe(true);
  });
  it('interpolates matching style parameters and switches the rest halfway', () => {
    const a = { enabled: true, dropShadow: [{ enabled: true, distance: 0, color: [0, 0, 0], blendMode: 'multiply' }] };
    const b = { enabled: false, dropShadow: [{ enabled: true, distance: 20, color: [255, 0, 100], blendMode: 'normal' }], stroke: [] };
    expect(tweenValue(a, b, 0.25)).toEqual({ enabled: true, dropShadow: [{ enabled: true, distance: 5, color: [63.75, 0, 25], blendMode: 'multiply' }] });
    expect(tweenValue(a, b, 0.75)).toMatchObject({ enabled: false, stroke: [] });
    // Effects off: the first frame's style is kept.
    expect(tweenState(s({ style: a }), s({ style: b }), 0.5, { ...all, effects: false }).style).toEqual(a);
  });
  it('inserts frames between two frames', () => {
    const { h, img } = fixture();
    h.execute('Frames', (d) => duplicateFrames(d, [0]));
    h.execute('Move', (d) => (findLayer(d.layers, img)!.transform.x += 30));
    h.execute('Tween', (d) => tweenFrames(d, 0, 2, all));
    const a = h.document.animation!;
    expect(a.frames.map((f) => f.layers[img].dx)).toEqual([0, 10, 20, 30]);
    expect(a.current).toBe(3);
    h.execute('Select Frame', (d) => applyFrame(d, 1));
    expect(get(h, img).transform.x).toBe(60);
    // Restricted to some layers, others keep the first frame's state.
    h.execute('Tween', (d) => tweenFrames(d, 2, 1, { ...all, layers: new Set() }));
    expect(h.document.animation!.frames[3].layers[img].dx).toBe(20);
  });
});

describe('playback timing and validation', () => {
  it('maps time to frames and samples at a frame rate', () => {
    const { h } = fixture();
    h.execute('Frames', (d) => (duplicateFrames(d, [0]), duplicateFrames(d, [0])));
    h.execute('Delays', (d) => {
      setFrameDelay(d, [0], 100);
      setFrameDelay(d, [1], 0);
      setFrameDelay(d, [2], 200);
    });
    const a = h.document.animation!;
    expect([0, 99, 100, 299, 500].map((t) => frameAt(a, t))).toEqual([0, 0, 2, 2, 2]);
    expect(sampleFrames(a, 10)).toEqual([0, 2, 2]);
    expect(sampleFrames(a, 10, 2)).toEqual([0, 2, 2, 0, 2, 2]);
    expect([0, 1, 3].map(gifLoop)).toEqual([0, -1, 2]);
  });
  it('rejects malformed animations', () => {
    const { h } = fixture();
    const good = JSON.parse(JSON.stringify(h.document.animation));
    expect(() => validateAnimation(good)).not.toThrow();
    for (const mutate of [
      (a: any) => (a.current = 3),
      (a: any) => (a.frames = []),
      (a: any) => (a.loop = -1),
      (a: any) => (a.frames[0].delay = 1.5),
      (a: any) => (Object.values(a.frames[0].layers)[0] as any).opacity = 2,
      (a: any) => ((Object.values(a.frames[0].layers)[0] as any).blend = 'nope'),
      (a: any) => (a.onion = { enabled: true, before: 20, after: 1, opacity: 0.5 }),
      (a: any) => a.frames.push({ ...a.frames[0] }),
    ]) {
      const bad = structuredClone(good);
      mutate(bad);
      expect(() => validateAnimation(bad)).toThrow();
    }
  });
});
