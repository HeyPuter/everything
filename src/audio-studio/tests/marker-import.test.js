import { describe, it, expect, vi } from 'vitest';

// The file picker resolves the file the test hands it.
const picked = vi.hoisted(() => ({ file: null }));
vi.mock('../src/storage/files.js', async (importOriginal) => ({
  ...(await importOriginal()),
  pickLocalFiles: async () => [picked.file],
}));

const { importMarkers } = await import('../src/features/io.js');
const { AudioFile } = await import('../src/model/audio-file.js');

function fakeApp(doc) {
  return {
    active: doc,
    notify: vi.fn(),
    prefs: { get: () => undefined },
    timeOptions: () => ({}),
    dock: { openPanel: vi.fn() },
  };
}

describe('File > Import > Markers', () => {
  it('says plainly why a file with no readable markers imported nothing', async () => {
    const doc = AudioFile.blank({ name: 'Song.wav', sampleRate: 8000, channels: 1, seconds: 1 });
    const app = fakeApp(doc);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [text, why] of [
      ['', 'The marker file is empty.'],
      ['Name,Length\nA,1\n', 'The marker file has no Start column.'],
      ['Name\tStart\nIntro\tsoon\n', 'None of its lines has a start time that could be read.'],
    ]) {
      picked.file = new File([text], 'notes.csv', { type: 'text/csv' });
      app.notify.mockClear();
      await expect(importMarkers(app)).resolves.toBeUndefined();
      expect(app.notify).toHaveBeenCalledTimes(1);
      const [message, opts] = app.notify.mock.calls[0];
      expect(message).toContain(`No markers were imported from "notes.csv". ${why}`);
      expect(message).toContain('Name and Start columns');
      expect(opts).toEqual({ error: true });
    }
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    expect(doc.state.markers).toEqual([]);
    // A readable file still imports.
    picked.file = new File(['Name\tStart\nIntro\t0.5\n'], 'm.txt');
    await importMarkers(app);
    expect(doc.state.markers.map((m) => [m.name, m.start])).toEqual([['Intro', 4000]]);
    expect(app.notify).toHaveBeenLastCalledWith('Imported 1 marker.');
  });
});
