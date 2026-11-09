// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderDocTabs } from '../src/ui/shell.js';

function setup() {
  const mk = (name) => ({ name, drawing: { modified: false }, file: null });
  const docs = [mk('A'), mk('B'), mk('C')];
  const el = document.createElement('div');
  document.body.append(el);
  const app = {
    docs,
    doc: docs[1],
    activate(d) {
      app.doc = d;
    },
    closeDrawing(d) {
      // As App.closeDrawing for an unmodified drawing.
      docs.splice(docs.indexOf(d), 1);
      app.doc = docs[1] ?? docs[0];
      renderDocTabs(app, el);
    },
  };
  renderDocTabs(app, el);
  return { app, el };
}

describe('drawing tabs', () => {
  it('keep keyboard focus on the active tab when a tab is closed with Delete', () => {
    const { el } = setup();
    el.querySelector('.doctab.active .doctab-btn').focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(document.activeElement.textContent).toBe('C');
    el.remove();
  });
  it('keep keyboard focus when they re-render', () => {
    const { app, el } = setup();
    el.querySelector('.doctab.active .doctab-btn').focus();
    renderDocTabs(app, el);
    expect(document.activeElement.textContent).toBe('B');
    el.remove();
  });
  it('do not take focus from elsewhere', () => {
    const { app, el } = setup();
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    renderDocTabs(app, el);
    expect(document.activeElement).toBe(other);
    el.remove();
    other.remove();
  });
});
