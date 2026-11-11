// Home's on-demand screens whose code can't load (offline, or a new version
// deployed meanwhile) say so instead of doing nothing.
import { it, expect, vi, afterEach } from 'vitest';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Home } from '../src/ui/home.js';

vi.mock('../src/ui/script-video.js', () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});

let home;
afterEach(() => {
  home?.dispose();
  document.body.replaceChildren();
});

it('says Script to video could not open when its code fails to load', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const root = document.createElement('div');
  document.body.append(root);
  home = new Home(root, { library: new Library(memoryBackend()), account: {}, onOpen() {}, onCreate() {}, onImportFiles() {} });
  await home.scriptToVideo();
  expect([...document.querySelectorAll('.toast')].map((t) => t.textContent).join()).toContain("Couldn't open Script to video");
});
