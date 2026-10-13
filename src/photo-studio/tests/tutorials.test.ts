import { describe, expect, it } from 'vitest';
import { layer, newDocument, type Layer, type PhotoDocument } from '../src/model/document';
import { checks, isAction, stepDone, TourMachine, type Step, type TourView } from '../src/features/help/tour';
import { TUTORIALS } from '../src/features/help/tutorial-list';
import { TUTORIAL_STEPS, tutorial } from '../src/features/help/tutorials';
import { makeSample, SAMPLE_IDS, SKIN_SPOTS } from '../src/features/help/samples';
import { cardPosition } from '../src/features/help/tour-ui';

// A grid whose content is one tile; new content means a new tile ID.
const grid = (id: string) => ({ tiles: { '0,0': id }, channels: 4, x: 0, y: 0, bounds: null }) as never;
function docWith(layers: Layer[]): PhotoDocument {
  return { ...newDocument(100, 80, 'Test'), layers };
}
function view(doc: PhotoDocument, extra: Partial<TourView> = {}): TourView {
  return { doc, tool: 'move', zoom: 1, selected: doc.layers.at(-1)?.id ?? '', hasDocument: true, ...extra };
}

describe('tutorial steps', () => {
  const bg = { ...layer('pixel', 'Background', 100, 80), id: 'bg', pixels: grid('a') };
  const base = view(docWith([bg]));

  it('completes command steps only when the command runs', () => {
    const step: Step = { title: 't', text: 'x', commands: ['file.export-as'] };
    expect(isAction(step)).toBe(true);
    expect(stepDone(step, base, base)).toBe(false);
    expect(stepDone(step, base, base, { kind: 'command', id: 'file.save' })).toBe(false);
    expect(stepDone(step, base, base, { kind: 'command', id: 'file.export-as' })).toBe(true);
  });

  it('completes tool steps when the tool is active', () => {
    const step: Step = { title: 't', text: 'x', tool: 'brush' };
    expect(stepDone(step, base, base)).toBe(false);
    expect(stepDone(step, { ...base, tool: 'brush' }, base, { kind: 'tool', id: 'brush' })).toBe(true);
  });

  it('treats steps without an action as reading steps', () => {
    const step: Step = { title: 't', text: 'x' };
    expect(isAction(step)).toBe(false);
    expect(stepDone(step, base, base, { kind: 'command', id: 'anything' })).toBe(false);
  });

  it('compares document state with the start of the step', () => {
    const added = { ...layer('pixel', 'Layer 1', 100, 80), id: 'l1', pixels: grid('b') };
    const two = view(docWith([bg, added]));
    expect(checks.layerAdded(two, base)).toBe(true);
    expect(checks.layerAdded(base, base)).toBe(false);
    // Painting replaces the selected layer's tiles.
    const painted = view(docWith([bg, { ...added, pixels: grid('c') }]));
    expect(checks.pixelsChanged(painted, two)).toBe(true);
    expect(checks.pixelsChanged(two, two)).toBe(false);
    expect(checks.opacityLowered(view(docWith([bg, { ...added, opacity: 0.5 }])), two)).toBe(true);
    expect(checks.layerHidden(view(docWith([bg, { ...added, visible: false }])), two)).toBe(true);
    expect(checks.kindAdded('adjustment')(two, base)).toBe(false);
    expect(checks.kindAdded('pixel')(two, base)).toBe(true);
    // Masks: added, then edited.
    const masked = view(docWith([bg, { ...added, maskGrid: grid('m1') }]));
    expect(checks.maskAdded(masked, two)).toBe(true);
    expect(checks.maskEdited(masked, two)).toBe(false);
    expect(checks.maskEdited(view(docWith([bg, { ...added, maskGrid: grid('m2') }])), masked)).toBe(true);
    // Selection and zoom.
    const selected = view({ ...docWith([bg]), selection: { x: 0, y: 0, width: 10, height: 10 } });
    expect(checks.selectionMade(selected, base)).toBe(true);
    expect(checks.selectionMade(base, base)).toBe(false);
    expect(checks.zoomedIn({ ...base, zoom: 2 }, base)).toBe(true);
    expect(checks.zoomedIn({ ...base, zoom: 1.01 }, base)).toBe(true);
    expect(checks.zoomedIn({ ...base, zoom: 0.5 }, base)).toBe(false);
  });

  it('does not take a copied history state for an edit', () => {
    // History states are deep copies: every grid is a new object with the same tiles.
    const added = { ...layer('pixel', 'Layer 1', 100, 80), id: 'l1', pixels: grid('b'), maskGrid: grid('m1') };
    const start = view({ ...docWith([bg, added]), selection: { x: 0, y: 0, width: 10, height: 10 }, selectionMask: grid('s1') });
    const renamed = structuredClone(start.doc);
    renamed.layers[1].name = 'Sky';
    renamed.layers[1].blend = 'multiply';
    const now = view(renamed);
    expect(checks.pixelsChanged(now, start)).toBe(false);
    expect(checks.maskEdited(now, start)).toBe(false);
    expect(checks.selectionMade(now, start)).toBe(false);
    // Moving a layer keeps its tiles; painting replaces them.
    const moved = structuredClone(start.doc);
    moved.layers[1].pixels = { ...moved.layers[1].pixels!, x: 30 };
    expect(checks.pixelsChanged(view(moved), start)).toBe(false);
    const painted = structuredClone(start.doc);
    painted.layers[1].pixels = { ...painted.layers[1].pixels!, tiles: { '0,0': 'b', '1,0': 'b2' } };
    expect(checks.pixelsChanged(view(painted), start)).toBe(true);
    // A moved selection is a different selection.
    const shifted = structuredClone(start.doc);
    shifted.selectionMask = { ...shifted.selectionMask!, x: 5 };
    expect(checks.selectionMade(view(shifted), start)).toBe(true);
  });

  it('notices edited adjustment settings and new effects', () => {
    const adj = { ...layer('adjustment', 'Levels 1', 100, 80), id: 'adj', adjustment: { kind: 'levels', params: { black: 0 } } };
    const before = view(docWith([bg, adj]));
    const after = view(docWith([bg, { ...adj, adjustment: { kind: 'levels', params: { black: 20 } } }]));
    expect(checks.adjustmentEdited(after, before)).toBe(true);
    expect(checks.adjustmentEdited(before, before)).toBe(false);
    const styled = view(docWith([{ ...bg, style: { enabled: true, dropShadow: [{}] } }, adj]));
    expect(checks.styleAdded(styled, before)).toBe(true);
    expect(checks.any(checks.zoomedIn, checks.styleAdded)(styled, before)).toBe(true);
  });

  it('never throws from a check', () => {
    const step: Step = { title: 't', text: 'x', check: () => { throw new Error('boom'); } };
    expect(stepDone(step, base, base)).toBe(false);
  });
});

describe('tour state machine', () => {
  it('completes, skips, goes back and restarts', () => {
    const m = new TourMachine(3);
    expect(m.progress()).toEqual({ step: 1, of: 3, completed: 0 });
    m.complete();
    expect(m.index).toBe(1);
    m.next(); // skip
    expect(m.index).toBe(2);
    expect(m.progress().completed).toBe(1);
    m.back();
    expect(m.index).toBe(1);
    m.complete();
    m.complete();
    expect(m.finished).toBe(true);
    expect(m.progress()).toEqual({ step: 3, of: 3, completed: 3 });
    // Back from the finished card returns to the last step.
    m.back();
    expect(m.finished).toBe(false);
    expect(m.index).toBe(2);
    m.restart();
    expect(m.state).toEqual({ index: 0, done: [false, false, false], finished: false });
    m.back();
    expect(m.index).toBe(0);
  });

  it('ignores actions after the end', () => {
    const m = new TourMachine(1);
    m.complete();
    m.complete();
    m.next();
    expect(m.finished).toBe(true);
    expect(m.state.done).toEqual([true]);
  });
});

describe('tutorial content', () => {
  it('has six tutorials with steps and at least one real action each', () => {
    expect(TUTORIALS.map((t) => t.id)).toEqual(['layers', 'masking', 'adjustments', 'retouch', 'text-shapes', 'exporting']);
    for (const t of TUTORIALS) {
      const full = tutorial(t.id)!;
      expect(full.steps.length).toBeGreaterThanOrEqual(4);
      expect(full.steps.some(isAction)).toBe(true);
      for (const s of full.steps) {
        expect(s.title.length).toBeGreaterThan(3);
        expect(s.text.length).toBeGreaterThan(20);
        for (const id of s.commands ?? []) expect(id).toMatch(/^[a-z]+\.[a-z0-9.-]+$/);
        if (s.tool) expect(s.tool).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    }
    expect(Object.keys(TUTORIAL_STEPS).sort()).toEqual(TUTORIALS.map((t) => t.id).sort());
    expect(tutorial('missing')).toBeUndefined();
  });
});

describe('sample images', () => {
  it('are deterministic and opaque', () => {
    for (const id of SAMPLE_IDS) {
      const a = makeSample(id, 48, 32),
        b = makeSample(id, 48, 32);
      expect(a.layers.length).toBeGreaterThan(0);
      expect(a.layers[0].background).toBe(true);
      for (const [i, l] of a.layers.entries()) {
        expect(l.image.width).toBe(48);
        expect(l.image.height).toBe(32);
        expect(l.image.data).toEqual(b.layers[i].image.data);
        for (let p = 3; p < l.image.data.length; p += 4) expect(l.image.data[p]).toBe(255);
      }
    }
  });

  it('differ from each other', () => {
    const sums = SAMPLE_IDS.map((id) => makeSample(id, 32, 24).layers.at(-1)!.image.data.reduce((s, v) => s + v, 0));
    expect(new Set(sums).size).toBe(SAMPLE_IDS.length);
  });

  it('draw the skin spots darker than the skin around them', () => {
    const s = makeSample('skin', 400, 300).layers[0].image;
    const lum = (u: number, v: number) => {
      const o = (Math.round(v * s.height) * s.width + Math.round(u * s.width)) * 4;
      return s.data[o] + s.data[o + 1] + s.data[o + 2];
    };
    for (const [u, v] of SKIN_SPOTS) expect(lum(u, v)).toBeLessThan(lum(u, v + 0.08) - 60);
  });

  it('puts the masking subject on its own layer above a backdrop', () => {
    const s = makeSample('subject', 120, 80);
    expect(s.layers.map((l) => l.name)).toEqual(['Backdrop', 'Photo']);
  });
});

describe('step card placement', () => {
  const screen = { width: 1280, height: 720 };
  const card = { width: 320, height: 200 };
  it('goes beside a small control and stays on screen', () => {
    // A toolbar button on the left: the card goes to its right.
    expect(cardPosition({ left: 4, top: 100, width: 32, height: 32 }, card, screen)).toEqual([50, 100]);
    // A panel button on the right edge: the card goes to its left.
    const [x] = cardPosition({ left: 1200, top: 600, width: 30, height: 30 }, card, screen);
    expect(x).toBe(1200 - 14 - 320);
    // Never past the bottom.
    const [, y] = cardPosition({ left: 1200, top: 650, width: 30, height: 30 }, card, screen);
    expect(y + card.height).toBeLessThanOrEqual(screen.height - 12);
  });
  it('sits inside a large target such as the canvas', () => {
    const [x, y] = cardPosition({ left: 40, top: 70, width: 900, height: 600 }, card, screen);
    expect(x).toBe(64);
    expect(y).toBe(70 + 600 - 200 - 24);
  });
});
