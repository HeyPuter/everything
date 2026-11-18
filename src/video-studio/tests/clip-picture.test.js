import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/engine/exporter.js', () => ({ renderStill: vi.fn(async () => ({ width: 64, height: 36, close: vi.fn() })) }));
import { renderStill } from '../src/engine/exporter.js';
import { clipPicture } from '../src/ui/inspector/stylize.js';
import { createCompound, breakApart } from '../src/model/compound.js';
import { normalizeProject } from '../src/model/project.js';
import { setTransition } from '../src/model/timeline.js';
import { evaluate, clipLayer } from '../src/engine/scene.js';
import { fixture, clip, onMain, s } from './helpers.js';

beforeEach(() => {
  renderStill.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['picture'], { type: 'image/png' })));
});
afterEach(() => vi.restoreAllMocks());

async function capture(p, c, time) {
  const before = structuredClone(p);
  const result = await clipPicture({ store: { project: p }, library: {} }, c, time);
  expect(result.blob.type).toBe('image/png');
  expect(p).toEqual(before);
  const [project, , at] = renderStill.mock.lastCall;
  return evaluate(project, at);
}

describe('isolated pictures for AI restyling', () => {
  it.each(['unequal axes', 'animated'])('omits inherited %s after flattening and reopening', async (motion) => {
    const p = fixture();
    const [c] = onMain(p, clip('video', 0, 4, { in: s(1), crop: { l: 0.1, t: 0, r: 0, b: 0 }, adjust: { exposure: 20 } }));
    const group = createCompound(p, [c.id]);
    Object.assign(group.transform, { x: 0.3, y: -0.2, scale: 0.5, rotation: 35 });
    group.opacity = 0.4;
    if (motion === 'unequal axes') Object.assign(group.transform, { sx: 0.6, sy: 1.5 });
    else group.animLoop = { id: 'float', duration: s(2) };
    breakApart(p, group.id);
    const reopened = normalizeProject(JSON.parse(JSON.stringify(p)));
    const flat = reopened.tracks.flatMap((t) => t.clips).find((c) => c.assetId);
    expect(flat.inherited?.length).toBeGreaterThan(0);
    const [layer] = await capture(reopened, flat, s(0.75));
    expect(layer).toMatchObject({ kind: 'media', x: 0, y: 0, scale: 1, sx: 1, sy: 1, rotation: 0, opacity: 1 });
    expect(layer.sourceTime).toBe(s(1.75));
    expect(layer.crop).toEqual(flat.crop);
    expect(layer.adjust.exposure).toBe(20);
  });

  it.each(['image', 'video'])('captures only the selected %s source inside a retained transition', async (type) => {
    const p = fixture();
    const [a, b] = onMain(p, clip(type, 0, 2), clip(type, 2, 2, { assetId: 'silent', in: s(1) }));
    setTransition(p, a.id, 'mix', s(1));
    const group = createCompound(p, [a.id, b.id]);
    Object.assign(group, { start: s(3), in: s(1.6), duration: s(0.3) });
    const [flat] = breakApart(p, group.id);
    expect(flat.transitionSlices).toHaveLength(1);
    const at = s(3.15), expectedTime = clipLayer(p, flat, at, 0).sourceTime;
    const layers = await capture(p, flat, at);
    expect(layers).toHaveLength(1);
    expect(layers[0].kind).toBe('media');
    expect(layers[0].asset.id).toBe(flat.assetId);
    expect(layers[0].sourceTime).toBe(expectedTime);
  });
});
