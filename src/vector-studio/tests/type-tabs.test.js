// Tabs panel: adding, moving, aligning and removing stops; indents; on-canvas ruler.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';
import { layoutText } from '../src/model/text-layout.js';
import { tickSteps } from '../src/features/type/tabs-panel.js';

const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 40 };
let app;
let doc;
let panel;

beforeEach(async () => {
  app = await bootAppWithFeatures();
  if (!app.editor) app.newDocument();
  doc = app.editor.doc;
  app.openPanel('tabs');
  panel = app.dock.panels.get('tabs');
  panel.shown();
});

function addArea() {
  const t = createText('a\tb\tc', 100, 100, { kind: 'area', width: 300, height: 200, char: { ...CHAR } });
  doc.transact('Add', () => doc.insert(t, app.editor.targetLayer().id));
  app.editor.select([t.id]);
  panel.update();
  return t;
}

describe('Tabs panel', () => {
  it('is registered with Shift+Mod+T and explains itself without type', () => {
    expect(app.commands.get('panel.tabs').shortcut).toBe('Shift+Mod+T');
    panel.update();
    expect(panel.el.textContent).toContain('tab stops');
  });

  it('adds, aligns, moves, repeats and removes stops; layout follows', () => {
    const t = addArea();
    const i = panel.addTab(50);
    expect(doc.get(t.id).para.tabs).toEqual([{ pos: 50, align: 'left' }]);
    expect(layoutText(doc.get(t.id)).lines[0].xs[2]).toBeCloseTo(150);
    panel.select(i);
    panel.setAlign('right');
    expect(doc.get(t.id).para.tabs[0].align).toBe('right');
    panel.setLeader('.');
    expect(doc.get(t.id).para.tabs[0].leader).toBe('.');
    panel.moveTab(0, 80);
    expect(doc.get(t.id).para.tabs[0].pos).toBe(80);
    panel.setAlign('left');
    panel.repeatTab();
    const tabs = doc.get(t.id).para.tabs;
    expect(tabs.map((x) => x.pos)).toEqual([80, 160, 240]);
    panel.removeTab(1);
    expect(doc.get(t.id).para.tabs.map((x) => x.pos)).toEqual([80, 240]);
    app.commands.run('edit.undo');
    expect(doc.get(t.id).para.tabs).toHaveLength(3);
  });

  it('indent markers set the first-line and left indents', () => {
    const t = addArea();
    panel.moveIndent('left', 20);
    expect(doc.get(t.id).para.indentLeft).toBe(20);
    expect(doc.get(t.id).para.indentFirst).toBe(-20);
    panel.moveIndent('first', 30);
    expect(doc.get(t.id).para.indentFirst).toBe(10);
  });

  it('renders stops on the panel ruler and above the frame on the canvas', () => {
    addArea();
    panel.addTab(60);
    panel.refresh();
    const stops = panel.ruler.el.querySelectorAll('.tab-stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].getAttribute('aria-label')).toContain('Left tab at 60');
    const canvasRuler = app.canvasHost.querySelector('.tab-ruler.on-canvas');
    expect(canvasRuler).toBeTruthy();
    expect(canvasRuler.hidden).toBe(false);
    expect(parseFloat(canvasRuler.style.width)).toBeCloseTo(300 * app.editor.view.zoom, 0);
    panel.hidden();
    expect(canvasRuler.hidden).toBe(true);
  });

  it('snaps to ruler ticks when snapping is on', () => {
    addArea();
    panel.toggleSnap();
    const { minor } = tickSteps(panel.ruler.scale, 'pt');
    const v = panel.snap(minor * 3.4);
    expect(v / minor).toBeCloseTo(3);
  });

  it('applies to the paragraphs of the text selection while editing', () => {
    const t = createText('one\ttwo\nthree\tfour', 0, 0, { kind: 'area', width: 300, height: 200, char: { ...CHAR } });
    doc.transact('Add', () => doc.insert(t, app.editor.targetLayer().id));
    app.setTool('type');
    const s = app.tool.editText(t.id);
    s.setSelection(10, 10);
    panel.update();
    panel.addTab(100);
    const n = doc.get(t.id);
    expect(n.paras?.[1]?.tabs).toEqual([{ pos: 100, align: 'left' }]);
    expect(n.para.tabs ?? null).toBeNull();
  });
});

describe('Tabs ruler drags', () => {
  const ev = (type, x, y) => new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });

  it('a cancelled tab drag ends without removing the stop, and later moves leave it alone', () => {
    const t = addArea();
    panel.addTab(50);
    panel.update();
    const marker = panel.ruler.el.querySelector('.tab-stop');
    const scale = panel.ruler.scale;
    marker.dispatchEvent(ev('pointerdown', 50 * scale, 0));
    window.dispatchEvent(ev('pointermove', 80 * scale, 0));
    expect(doc.get(t.id).para.tabs[0].pos).toBe(80);
    // Dragged off the ruler (it would be removed on release), then the system cancels the pointer.
    window.dispatchEvent(ev('pointermove', 80 * scale, 200));
    expect(panel.ruler.el.classList.contains('removing')).toBe(true);
    window.dispatchEvent(ev('pointercancel', 80 * scale, 200));
    expect(panel.ruler.el.classList.contains('removing')).toBe(false);
    expect(doc.get(t.id).para.tabs).toEqual([{ pos: 80, align: 'left' }]);
    window.dispatchEvent(ev('pointermove', 120 * scale, 0));
    window.dispatchEvent(ev('pointerup', 120 * scale, 0));
    expect(doc.get(t.id).para.tabs).toEqual([{ pos: 80, align: 'left' }]);
  });

  it('a cancelled indent drag stops following the pointer', () => {
    const t = addArea();
    panel.update();
    const marker = panel.ruler.el.querySelector('.tab-indent.left');
    const scale = panel.ruler.scale;
    marker.dispatchEvent(ev('pointerdown', 0, 0));
    window.dispatchEvent(ev('pointermove', 20 * scale, 0));
    expect(doc.get(t.id).para.indentLeft).toBe(20);
    window.dispatchEvent(ev('pointercancel', 20 * scale, 0));
    window.dispatchEvent(ev('pointermove', 60 * scale, 0));
    expect(doc.get(t.id).para.indentLeft).toBe(20);
  });
});
