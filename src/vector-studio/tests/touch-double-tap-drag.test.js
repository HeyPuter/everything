// A second touch press that turns into a drag before lifting is a drag, not a
// double-tap, except where a tool drags from a double-tap (word selection in type).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { caretPosition } from '../src/model/text-layout.js';
import { nodeBounds } from '../src/model/geometry.js';

describe('touch: tap then drag', () => {
  let app;
  let ed;
  beforeEach(async () => {
    vi.useFakeTimers();
    app = await bootAppWithFeatures();
    ed = app.newDocument();
    ed.view.set({ width: 800, height: 600, zoom: 1, panX: 0, panY: 0, rotation: 0 });
    app.canvasHost.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
    });
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  let clock = 1000;
  const ev = (pointerType, x, y, extra = {}) => ({
    pointerId: pointerType === 'touch' ? 7 : 1,
    pointerType,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    pressure: 0.5,
    timeStamp: clock,
    ...extra,
  });
  const at = (ms) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };
  const addRect = () => {
    const r = createPath(rectangle(100, 100, 200, 200), true, {
      fill: { type: 'solid', color: '#3366ff' },
    });
    ed.doc.transact('add', () => ed.doc.insert(r, ed.targetLayer().id));
    return r;
  };
  const left = (id) => nodeBounds(ed.doc, ed.doc.get(id)).x;

  it('a tap followed by a quick touch drag moves the object instead of isolating it', () => {
    const r = addRect();
    app.setTool('selection');
    const input = app.input;
    input.down(ev('touch', 200, 200));
    at(40);
    input.up(ev('touch', 200, 200));
    expect([...ed.selection]).toEqual([r.id]);
    at(200);
    input.down(ev('touch', 200, 200));
    at(30);
    input.move(ev('touch', 210, 200));
    at(16);
    input.move(ev('touch', 260, 200));
    at(16);
    input.up(ev('touch', 260, 200));
    expect(ed.isolation).toBeFalsy();
    expect(left(r.id)).toBeCloseTo(160, 0);
  });

  it('a second touch press held still before dragging also drags', () => {
    const r = addRect();
    app.setTool('selection');
    const input = app.input;
    input.down(ev('touch', 200, 200));
    at(40);
    input.up(ev('touch', 200, 200));
    at(150);
    input.down(ev('touch', 200, 200));
    at(200); // the finger rests past the settle time before it moves
    input.move(ev('touch', 210, 200));
    input.move(ev('touch', 260, 200));
    input.up(ev('touch', 260, 200));
    expect(ed.isolation).toBeFalsy();
    expect(left(r.id)).toBeCloseTo(160, 0);
  });

  it('keeps a drag that starts after settling when the long-press deadline passes', () => {
    const r = addRect();
    app.setTool('selection');
    app.showContextMenu = vi.fn();
    const input = app.input;
    input.down(ev('touch', 200, 200));
    at(120); // settle the first press before the finger starts moving
    input.move(ev('touch', 220, 200));
    input.move(ev('touch', 260, 200));
    at(500); // a continuing drag must not become a long press
    expect(app.showContextMenu).not.toHaveBeenCalled();
    input.up(ev('touch', 260, 200));
    expect(left(r.id)).toBe(160);
    expect(ed.doc.undoLabel).toBe('Move');
    ed.doc.undo();
    expect(left(r.id)).toBe(100);
  });

  it('a double-tap still isolates', () => {
    const r = addRect();
    app.setTool('selection');
    const input = app.input;
    input.down(ev('touch', 200, 200));
    at(40);
    input.up(ev('touch', 200, 200));
    at(150);
    input.down(ev('touch', 200, 200));
    at(150); // a slow second tap still counts
    input.up(ev('touch', 200, 200));
    expect(ed.isolation).toBeTruthy();
    expect(left(r.id)).toBe(100);
  });

  it('mouse double-click and drag keeps double-click semantics', () => {
    const r = addRect();
    app.setTool('selection');
    const input = app.input;
    input.down(ev('mouse', 200, 200));
    at(40);
    input.up(ev('mouse', 200, 200));
    at(150);
    input.down(ev('mouse', 200, 200));
    input.move(ev('mouse', 210, 200));
    input.move(ev('mouse', 260, 200));
    input.up(ev('mouse', 260, 200, { buttons: 0 }));
    expect(ed.isolation).toBeTruthy();
    expect(left(r.id)).toBe(100);
  });

  it('double-tap and drag in type being edited selects whole words', () => {
    const t = createText('one two three', 100, 100, { char: { fontSize: 20 } });
    ed.doc.transact('Add', () => ed.doc.insert(t, ed.targetLayer().id));
    app.setTool('type');
    const s = app.getTool('type').editText(t.id, null);
    s.setSelection(0, 0);
    const pt = (i) => {
      const c = caretPosition(s.layout(), i);
      return ed.view.toScreen(c.x + 1, c.y - 5);
    };
    const input = app.input;
    const a = pt(5);
    const b = pt(10);
    input.down(ev('touch', a.x, a.y));
    at(40);
    input.up(ev('touch', a.x, a.y));
    at(150);
    input.down(ev('touch', a.x, a.y));
    at(30);
    input.move(ev('touch', a.x + 8, a.y));
    input.move(ev('touch', b.x, b.y));
    expect(s.range()).toEqual([4, 13]);
    input.up(ev('touch', b.x, b.y));
    expect(s.range()).toEqual([4, 13]);
  });
});
