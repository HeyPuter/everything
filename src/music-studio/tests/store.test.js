import { describe, it, expect, vi } from 'vitest';
import { Store } from '../src/model/store.js';
import * as E from '../src/model/edits.js';
import { newProject } from '../src/model/demo.js';

describe('store', () => {
  it('records undo steps and redoes them', () => {
    const s = new Store(newProject());
    const before = s.project;
    s.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 90 }));
    expect(s.project.bpm).toBe(90);
    expect(s.undoLabel).toBe('Tempo');
    s.undo();
    expect(s.project).toBe(before);
    s.redo();
    expect(s.project.bpm).toBe(90);
  });

  it('merges a gesture into one undo step relative to its start', () => {
    const s = new Store(newProject());
    const start = s.project;
    s.begin('Drag tempo');
    for (let i = 1; i <= 5; i++) s.preview((p) => E.setProjectProps(p, { bpm: p.bpm + i }));
    expect(s.project.bpm).toBe(start.bpm + 5);
    s.commit();
    expect(s.undoStack).toHaveLength(1);
    s.undo();
    expect(s.project).toBe(start);
  });

  it('restores the edited channel saved with the project on load', () => {
    const s = new Store(newProject());
    const p = newProject();
    s.load({ ...p, ui: { channel: p.channels[2].id } });
    expect(s.view.channel).toBe(p.channels[2].id);
    expect([...s.view.selectedChannels]).toEqual([p.channels[2].id]);
    s.load({ ...p, ui: { channel: 'gone' } });
    expect(s.view.channel).toBe(p.channels[0].id);
  });

  it('groups several edits into one undo step and amends the last step', () => {
    const s = new Store(newProject());
    const start = s.project;
    s.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 99 }));
    const afterTempo = s.project;
    s.group('Add Bass', () => {
      s.apply('Add pattern', (p) => E.addPattern(p).project);
      s.apply('Swing', (p) => E.setProjectProps(p, { swing: 0.5 }));
    });
    expect(s.undoStack.map((u) => u.label)).toEqual(['Tempo', 'Add Bass']);
    s.undo();
    expect(s.project).toBe(afterTempo);
    s.redo();
    expect(s.project.swing).toBe(0.5);
    // An async follow-up joins the last step.
    s.amend(() => s.apply('Rename', (p) => E.setProjectProps(p, { name: 'X' })));
    expect(s.undoStack.map((u) => u.label)).toEqual(['Tempo', 'Add Bass']);
    s.undo();
    expect(s.project).toBe(afterTempo);
    s.undo();
    expect(s.project).toBe(start);
    // Nothing recorded: the history is unchanged.
    s.group('Nothing', () => {});
    expect(s.undoStack).toHaveLength(0);
  });

  it('ignores edits that change nothing and returns extra fields', () => {
    const s = new Store(newProject());
    const onChange = vi.fn();
    s.on('change', onChange);
    s.apply('Nothing', (p) => p);
    expect(onChange).not.toHaveBeenCalled();
    const r = s.apply('New pattern', (p) => E.addPattern(p));
    expect(typeof r.id).toBe('string');
    expect(s.project.patterns).toHaveLength(2);
  });

  it('keeps the view on existing patterns and channels', () => {
    const s = new Store(newProject());
    const r = s.apply('New pattern', (p) => E.addPattern(p));
    s.setPattern(r.id);
    s.undo();
    expect(s.project.patterns.some((p) => p.id === s.view.pattern)).toBe(true);
  });

  it('cancel keeps the view on things the restored project has', () => {
    const s = new Store(newProject());
    s.begin('Duplicate pattern');
    const r = s.preview((p) => E.addPattern(p));
    s.setPattern(r.id);
    const views = vi.fn();
    s.on('view', views);
    s.cancel();
    expect(s.project.patterns.some((p) => p.id === s.view.pattern)).toBe(true);
    expect(views).toHaveBeenCalled();
  });
});
