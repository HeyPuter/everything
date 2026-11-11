import { describe, it, expect } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { historySteps, goToStep, createHistoryPanel } from '../src/ui/history-panel.js';
import { fixture } from './helpers.js';

describe('history panel', () => {
  it('lists steps and jumps back and forward', () => {
    const store = new EditorStore(fixture());
    store.update('Rename A', (p) => void (p.name = 'A'), { structural: false });
    store.update('Rename B', (p) => void (p.name = 'B'), { structural: false });
    store.update('Rename C', (p) => void (p.name = 'C'), { structural: false });
    expect(historySteps(store.history).map((s) => s.label)).toEqual(['Opened project', 'Rename A', 'Rename B', 'Rename C']);
    let changes = 0;
    store.on('change', () => changes++);
    expect(goToStep(store, 1)).toBe(2);
    expect(changes).toBe(1);
    expect(store.project.name).toBe('A');
    const steps = historySteps(store.history);
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'undone', 'undone']);
    goToStep(store, 3);
    expect(store.project.name).toBe('C');
    goToStep(store, 0);
    expect(store.project.name).toBe('Test');
  });

  it('renders the current step and responds to clicks', () => {
    const store = new EditorStore(fixture());
    store.update('Rename A', (p) => void (p.name = 'A'), { structural: false });
    const panel = createHistoryPanel({ store });
    document.body.append(panel.el);
    panel.toggle(true);
    const steps = [...panel.el.querySelectorAll('.history-step')];
    expect(steps.length).toBe(2);
    expect(steps[1].classList.contains('current')).toBe(true);
    steps[0].click();
    expect(store.project.name).toBe('Test');
    expect(panel.el.querySelector('.current .history-label').textContent).toBe('Opened project');
    panel.dispose();
    panel.el.remove();
  });

  it('keeps keyboard focus on the chosen step and gives it back on Escape', () => {
    const store = new EditorStore(fixture());
    store.update('Rename A', (p) => void (p.name = 'A'), { structural: false });
    store.update('Rename B', (p) => void (p.name = 'B'), { structural: false });
    const panel = createHistoryPanel({ store });
    const opener = Object.assign(document.createElement('button'), { textContent: 'Edit' });
    document.body.append(opener, panel.el);
    opener.focus();
    panel.toggle(true);
    // Opening puts focus on the current step.
    expect(document.activeElement.classList.contains('current')).toBe(true);
    const steps = () => [...panel.el.querySelectorAll('.history-step')];
    steps()[1].focus();
    steps()[1].click();
    expect(store.project.name).toBe('A');
    // The list was rebuilt; focus stays on the step that was chosen, not the page.
    expect(document.activeElement).toBe(steps()[1]);
    expect(document.activeElement.classList.contains('current')).toBe(true);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.el.hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
    panel.dispose();
    panel.el.remove();
    opener.remove();
  });
});
