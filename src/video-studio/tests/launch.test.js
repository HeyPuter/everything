// Files handed over by the Puter desktop: launched with (double-click, "Open
// with") or dragged onto the window from the desktop (src/ui/launch.js).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readDriveItems, installLaunchOpen } from '../src/ui/launch.js';

const toastTexts = () => [...document.querySelectorAll('.toast .toast-text')].map((t) => t.textContent);

/** A stubbed SDK whose drive holds `files` (path → Blob); `launch` lists the launch items. */
function sdk(files, launch = []) {
  const read = vi.fn(async (path) => {
    if (!files[path]) throw new Error('No such file');
    return files[path];
  });
  return {
    read,
    puter: {
      fs: { read },
      ui: {
        onLaunchedWithItems(fn) {
          if (launch.length) fn(launch);
        },
      },
    },
  };
}

const item = (path, extra = {}) => ({ path, name: path.split('/').pop(), ...extra });

beforeEach(() => {
  document.body.replaceChildren();
});

describe('readDriveItems', () => {
  it('reads media files from their drive paths, typed by extension when the drive gives no type', async () => {
    const { puter } = sdk({ '/me/Videos/clip.mp4': new Blob(['v']), '/me/Music/song.mp3': new Blob(['a'], { type: 'audio/mpeg' }) });
    const files = await readDriveItems(puter, [item('/me/Videos/clip.mp4'), item('/me/Music/song.mp3')]);
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ['clip.mp4', ''],
      ['song.mp3', 'audio/mpeg'],
    ]);
  });

  it("uses the item's own read when it has one, and takes a single item", async () => {
    const { puter, read } = sdk({});
    const files = await readDriveItems(puter, { ...item('/me/a.png'), read: async () => new Blob(['p'], { type: 'image/png' }) });
    expect(files.map((f) => f.name)).toEqual(['a.png']);
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps project files', async () => {
    const { puter } = sdk({ '/me/Trip.zip': new Blob(['z'], { type: 'application/zip' }) });
    const files = await readDriveItems(puter, [item('/me/Trip.zip')]);
    expect(files.map((f) => f.name)).toEqual(['Trip.zip']);
  });

  it('refuses folders with a message', async () => {
    const { puter, read } = sdk({});
    expect(await readDriveItems(puter, [item('/me/Videos', { is_dir: true })])).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(toastTexts().join(' ')).toContain('Folders cannot be opened');
  });

  it('leaves out files that are not media without reading them, and says so', async () => {
    const { puter, read } = sdk({ '/me/notes.txt': new Blob(['t']), '/me/clip.webm': new Blob(['v']) });
    const files = await readDriveItems(puter, [item('/me/notes.txt'), item('/me/clip.webm')]);
    expect(files.map((f) => f.name)).toEqual(['clip.webm']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(toastTexts().join(' ')).toContain("notes.txt isn't video, audio, a picture");
  });

  it('skips files that cannot be read and opens the rest', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { puter } = sdk({ '/me/b.mov': new Blob(['v']) });
    const files = await readDriveItems(puter, [item('/me/gone.mp4'), item('/me/b.mov')]);
    expect(files.map((f) => f.name)).toEqual(['b.mov']);
    expect(toastTexts().join(' ')).toContain("Couldn't read gone.mp4 from Puter.");
    err.mockRestore();
  });
});

describe('installLaunchOpen', () => {
  it('hands launch items over as files, not as a drop', async () => {
    const { puter } = sdk({ '/me/Desktop/clip.mp4': new Blob(['v']) }, [item('/me/Desktop/clip.mp4')]);
    const onFiles = vi.fn();
    installLaunchOpen(puter, onFiles);
    await vi.waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    const [files, opts] = onFiles.mock.calls[0];
    expect(files.map((f) => f.name)).toEqual(['clip.mp4']);
    expect(opts).toEqual({ dropped: false });
  });

  it("takes the SDK's own drop of desktop files, one hand-over at a time, and ignores browser drops", async () => {
    const { puter } = sdk({ '/me/a.mp4': new Blob(['a']), '/me/b.png': new Blob(['b']) });
    const seen = [];
    let release;
    const first = new Promise((r) => (release = r));
    const onFiles = vi.fn(async (files) => {
      seen.push(files.map((f) => f.name));
      if (seen.length === 1) await first;
    });
    installLaunchOpen(puter, onFiles);
    const drop = (path) => {
      const e = new CustomEvent('drop', { cancelable: true, detail: { items: [item(path)] } });
      window.dispatchEvent(e);
      return e;
    };
    expect(drop('/me/a.mp4').defaultPrevented).toBe(true);
    drop('/me/b.png');
    // A drop from the device carries a dataTransfer and is left to the page's own handlers.
    const browserDrop = new Event('drop', { cancelable: true });
    Object.defineProperty(browserDrop, 'dataTransfer', { value: { files: [] } });
    window.dispatchEvent(browserDrop);
    expect(browserDrop.defaultPrevented).toBe(false);

    await vi.waitFor(() => expect(seen).toEqual([['a.mp4']]));
    release();
    await vi.waitFor(() => expect(seen).toEqual([['a.mp4'], ['b.png']]));
    expect(onFiles.mock.calls.map((c) => c[1])).toEqual([{ dropped: true }, { dropped: true }]);
  });

  it('works without launch items in the SDK', () => {
    expect(() => installLaunchOpen({ fs: { read: async () => new Blob() }, ui: {} }, () => {})).not.toThrow();
    expect(() => installLaunchOpen({ fs: {}, ui: { onLaunchedWithItems: () => { throw new Error('no'); } } }, () => {})).not.toThrow();
  });
});
