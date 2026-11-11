// Frame animations keep a record per layer per frame. A 420-frame GIF opened
// as an animation (420 layers × 420 frames) used to exceed the 16 MB project
// metadata limit, so it could not be saved; large animations now store each
// distinct record once. More frames than a project may hold are refused.
import { describe, expect, it, vi } from 'vitest';
import { layer, newDocument, type PhotoDocument } from '../src/model/document';
import { framesFromLayers, maxFrames } from '../src/model/animation';
import { Assets } from '../src/model/assets';
import { deserialize, serialize } from '../src/model/serialization';

function animated(n: number): PhotoDocument {
  const doc = newDocument(8, 8, 'Long');
  doc.layers = Array.from({ length: n }, (_, i) => layer('solid', `Frame ${i + 1}`, 8, 8));
  framesFromLayers(doc, doc.layers.map((_, i) => 40 + (i % 3)), 0);
  return doc;
}

describe('frame animation projects', () => {
  it('saves and reopens a 450-frame animation with every record intact', async () => {
    const doc = animated(450);
    const a = doc.animation!;
    // Some records that differ from the rest, including a style.
    a.frames[7].layers[doc.layers[3].id] = { visible: true, dx: 5, dy: -2, opacity: 0.5, blend: 'multiply', fillOpacity: 0.25, style: { enabled: true, colorOverlay: [{ enabled: true, blendMode: 'normal', opacity: 1, color: [1, 2, 3] }] } };
    delete a.frames[9].layers[doc.layers[5].id];
    const back = (await deserialize(await serialize(doc, new Assets()))).document;
    expect(back.animation).toEqual(a);
    // Reopened records are separate objects (frames are edited in place).
    const [f0, f1] = back.animation!.frames;
    expect(f0.layers[doc.layers[2].id]).not.toBe(f1.layers[doc.layers[2].id]);
  });

  it('keeps small animations in the plain form', async () => {
    const doc = animated(3);
    const blob = await serialize(doc, new Assets());
    const json = JSON.parse(await blob.slice(12, 12 + new DataView(await blob.slice(0, 12).arrayBuffer()).getUint32(8, true)).text());
    expect(json.document.animation.frames[0].layers).toBeTruthy();
    expect((await deserialize(blob)).document.animation).toEqual(doc.animation);
  });

  it('refuses to make more frames than a project can hold', () => {
    expect(() => animated(maxFrames + 1)).toThrow(/up to 2000 frames/);
  });
});

describe('opening long animations', () => {
  it('keeps as many frames as a frame animation holds, and says so', async () => {
    vi.resetModules();
    vi.doMock('../src/model/animation', async (importOriginal) => ({ ...(await importOriginal<object>()), maxFrames: 3 }));
    const { decodeFile } = await import('../src/features/files/open');
    // A 16 × 16 GIF of five one-pixel frames.
    const b = [...new TextEncoder().encode('GIF89a'), 16, 0, 16, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
    for (let i = 0; i < 5; i++) b.push(0x2c, i, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0);
    b.push(0x3b);
    const gif = new Blob([new Uint8Array(b)]);
    const anim = await decodeFile(gif, 'long.gif', { pages: 'animation' });
    expect(anim.animation!.delays).toHaveLength(3);
    expect(anim.layers).toHaveLength(2);
    expect(anim.notice).toMatch(/first 3 of 5 frames/);
    const layers = await decodeFile(gif, 'long.gif', { pages: 'layers' });
    expect(layers.layers).toHaveLength(4);
    expect(layers.notice ?? '').not.toMatch(/first/);
    vi.doUnmock('../src/model/animation');
  });
});
