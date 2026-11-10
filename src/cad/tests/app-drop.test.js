// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/io/storage.js', () => ({ recovery: {}, errorText: () => '' }));
const { App } = await import('../src/app.js');

const fire = (type, dataTransfer) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.dataTransfer = dataTransfer;
  document.body.dispatchEvent(e);
  return e;
};
const file = (name) => ({ name, arrayBuffer: async () => new TextEncoder().encode(name).buffer });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('files dropped on the window', () => {
  const app = Object.create(App.prototype);
  app.openBuffer = vi.fn(async () => null);
  app.fileError = vi.fn();
  app.bindDrop();

  it('open as drawings instead of replacing the app', async () => {
    const handle = { kind: 'file', name: 'a.dxf' };
    const transfer = {
      types: ['Files'],
      items: [
        { kind: 'file', getAsFile: () => file('a.dxf'), getAsFileSystemHandle: async () => handle },
        { kind: 'file', getAsFile: () => file('b.dwg') },
        { kind: 'string', getAsFile: () => null },
      ],
    };
    expect(fire('dragover', transfer).defaultPrevented).toBe(true);
    expect(fire('drop', transfer).defaultPrevented).toBe(true);
    await settle();
    await settle();
    expect(app.openBuffer.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['a.dxf', { source: 'device', handle, path: null }],
      ['b.dwg', { source: 'device', handle: null, path: null }],
    ]);
  });

  it('leave dragged text to the field it is dropped on', () => {
    app.openBuffer.mockClear();
    const transfer = { types: ['text/plain'], items: [{ kind: 'string' }] };
    expect(fire('dragover', transfer).defaultPrevented).toBe(false);
    expect(fire('drop', transfer).defaultPrevented).toBe(false);
    expect(app.openBuffer).not.toHaveBeenCalled();
  });

  it('are not opened behind an open dialog', async () => {
    app.openBuffer.mockClear();
    const dlg = document.createElement('dialog');
    dlg.setAttribute('open', '');
    document.body.append(dlg);
    const transfer = { types: ['Files'], items: [{ kind: 'file', getAsFile: () => file('a.dxf') }] };
    expect(fire('drop', transfer).defaultPrevented).toBe(true);
    await settle();
    expect(app.openBuffer).not.toHaveBeenCalled();
    dlg.remove();
  });
});
