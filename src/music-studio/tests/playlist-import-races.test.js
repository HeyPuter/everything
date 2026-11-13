import { it, expect, vi } from 'vitest';
import { App } from '../src/app.js';
import * as playlist from '../src/panels/playlist.js';
import { ProjectFiles } from '../src/storage/files.js';
import { newProject } from '../src/model/demo.js';
import { DND_TYPE } from '../src/lib/dnd.js';

it('does not import a playlist cloud drop into a project opened during download', async () => {
  const ctx = new Proxy({}, { get: (t, k) => t[k] || (() => ({ width: 0 })) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((type) => type === '2d' ? ctx : null);
  document.body.innerHTML = '<div id="app"></div>';
  const app = new App(document.getElementById('app'), { project: newProject(), storage: { getItem: () => null, setItem() {} } });
  let release;
  const read = vi.fn(() => new Promise((r) => { release = r; }));
  vi.stubGlobal('puter', { auth: { isSignedIn: () => true }, fs: { read } });
  app.files = new ProjectFiles(app, {});
  app.importAudio = vi.fn(async () => ({}));
  app.reportError = vi.fn();
  try {
    app.start([playlist]);
    const scroller = document.querySelector('.pl-scroller');
    const e = new MouseEvent('drop', { bubbles: true, clientX: 200, clientY: 50 });
    Object.defineProperty(e, 'dataTransfer', { value: { getData: (type) => type === DND_TYPE ? JSON.stringify({ kind: 'file', path: '/tone.wav', name: 'tone.wav' }) : '' } });
    scroller.dispatchEvent(e);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    app.store.load(newProject());
    release(new Blob(['audio']));
    // Drain the drop handler's download/import continuations.
    await new Promise((r) => setTimeout(r, 0));
    expect(app.importAudio).not.toHaveBeenCalled();
    expect(app.reportError).toHaveBeenCalled();
  } finally {
    cancelAnimationFrame(app.raf);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
