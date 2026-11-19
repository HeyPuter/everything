// Files written to a Puter folder after its picker closes: they are written
// even when another task started while the picker was open, and the closing
// message names what was not saved.
import { afterEach, describe, expect, it } from 'vitest';
import { saveToCloudFolder } from '../src/features/files/layers-export';
import type { Editor } from '../src/editor';

const g = globalThis as unknown as { window?: unknown };

/** An editor with Editor.run's busy rule: a task asked for while another runs is not run. */
function fakeEditor() {
  const messages: string[] = [];
  const e = {
    busy: false,
    idle: Promise.resolve(),
    settle: () => {},
    messages,
    message: (m: string) => messages.push(m),
    release() {
      e.busy = false;
      e.settle();
    },
    async run(task: () => Promise<void>) {
      if (e.busy) return;
      e.busy = true;
      e.idle = new Promise<void>((r) => (e.settle = r));
      try {
        await task();
      } catch (error) {
        e.message((error as Error).message);
      } finally {
        e.release();
      }
    },
  };
  return e;
}

function drive(fail?: string) {
  const written: string[] = [];
  let pick!: (v: { path: string; name: string }) => void;
  g.window = {
    puter: {
      ui: { showDirectoryPicker: () => new Promise((r) => (pick = r)) },
      fs: {
        write: async (path: string) => {
          if (fail && path.endsWith(fail))
            throw { code: 'storage_limit_reached', message: 'Not enough storage.' };
          written.push(path);
          return { path, name: path.split('/').pop() };
        },
      },
    },
  };
  return { written, pick: (path: string) => pick({ path, name: path.split('/').pop()! }) };
}
const settled = () => new Promise((r) => setTimeout(r, 0));
const files = ['a.png', 'b.png', 'c.png'].map((name) => ({ name, blob: new Blob([name]) }));

describe('saveToCloudFolder', () => {
  afterEach(() => delete g.window);

  it('writes the files once a task started while the picker was open finishes', async () => {
    const d = drive();
    const e = fakeEditor();
    saveToCloudFolder(e as unknown as Editor, files, '1 file failed. x.tif: damaged');
    // Another command runs while the folder picker is open.
    let finish!: () => void;
    void e.run(() => new Promise<void>((r) => (finish = r)));
    d.pick('/me/out');
    await settled();
    expect(d.written).toEqual([]);
    finish();
    await settled();
    await settled();
    expect(d.written).toEqual(['/me/out/a.png', '/me/out/b.png', '/me/out/c.png']);
    expect(e.messages.at(-1)).toBe('Saved 3 files to /me/out. 1 file failed. x.tif: damaged');
  });

  it('says which file could not be written and how many were', async () => {
    const d = drive('b.png');
    const e = fakeEditor();
    saveToCloudFolder(e as unknown as Editor, files);
    d.pick('/me/out');
    await settled();
    await settled();
    expect(d.written).toEqual(['/me/out/a.png']);
    expect(e.messages.at(-1)).toBe(
      'b.png could not be saved: Not enough storage. 1 of 3 files were saved to /me/out.',
    );
  });
});
