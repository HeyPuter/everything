// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const puts = [];
const encodes = [];
vi.mock('../src/io/storage.js', () => ({
  recovery: { put: async (r) => (puts.push(r.data), true) },
  errorText: () => '',
}));
vi.mock('../src/io/native.js', async (orig) => ({
  ...(await orig()),
  // Each call resolves when the test says so, with the content of that moment.
  encodeDrawing: (drawing) => {
    const content = drawing.content;
    return new Promise((resolve) => encodes.push(() => resolve(content)));
  },
}));
const { App } = await import('../src/app.js');

const settle = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const app = Object.create(App.prototype);
  const doc = { id: 'd1', name: 'Drawing1', file: null, view: null, drawing: { content: 'old', modified: true } };
  Object.assign(app, { docs: [doc], ownsSession: true, _autosaveTimers: new Map(), _autosaving: new Set() });
  return { app, doc };
}

describe('recovery copies of one drawing', () => {
  beforeEach(() => {
    puts.length = 0;
    encodes.length = 0;
  });

  it('are written in order, so an older copy never lands last', async () => {
    const { app, doc } = setup();
    app.autosave(doc);
    doc.drawing.content = 'new';
    const second = app.autosave(doc);
    await settle();
    // Finish whatever is being encoded, newest first.
    while (encodes.length) {
      encodes.pop()();
      await settle();
    }
    await second;
    expect(puts.at(-1)).toBe('new');
  });

  it('asked for many times while one is written are written once more', async () => {
    const { app, doc } = setup();
    app.autosave(doc);
    for (const c of ['a', 'b', 'c']) {
      doc.drawing.content = c;
      app.autosave(doc);
    }
    const done = app.flushAutosave();
    while (app._autosaving.size) {
      encodes.shift()?.();
      await settle();
    }
    await done;
    expect(puts).toEqual(['old', 'c']);
    expect(app._autosaving.size).toBe(0);
  });
});
