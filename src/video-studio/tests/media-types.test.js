import { describe, it, expect } from 'vitest';
import { MEDIA_ACCEPT, ACCEPT_FOR } from '../src/media/media-types.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Home } from '../src/ui/home.js';

describe('media file pickers', () => {
  it('Home offers the same files as the media panel', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const home = new Home(root, { library: new Library(memoryBackend()), account: {}, onOpen() {}, onCreate() {}, onImportFiles() {} });
    const input = [...root.querySelectorAll('input[type=file]')].find((i) => !i.accept.includes('zip'));
    expect(input.accept).toBe(MEDIA_ACCEPT);
    expect(MEDIA_ACCEPT.split(',')).toEqual(expect.arrayContaining(['video/*', 'audio/*', 'image/*', '.mkv', '.mov', '.flac', '.opus']));
    home.dispose();
    root.remove();
  });

  it('a replacement file is picked from the same kind', () => {
    expect(ACCEPT_FOR.video.split(',')).toEqual(expect.arrayContaining(['video/*', '.mkv']));
    expect(ACCEPT_FOR.audio.split(',')).toEqual(expect.arrayContaining(['audio/*', '.flac']));
    expect(ACCEPT_FOR.image).toBe('image/*');
  });
});
