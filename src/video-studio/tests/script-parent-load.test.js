import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from '../src/ui/editor.js';
import { Home } from '../src/ui/home.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { createProject } from '../src/model/project.js';

vi.mock('../src/ui/script-video.js', () => { throw new TypeError('Failed to fetch dynamically imported module'); });
let parent;
const scriptErrors = () => [...document.querySelectorAll('.toast.error')].filter(t => t.textContent.includes("Couldn't open Script to video"));
afterEach(() => { parent?.dispose(); parent = null; vi.restoreAllMocks(); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); });

it.each(['editor', 'home'])('%s reports a current script module failure without rejecting the command', async kind => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {}), root = document.createElement('div'); root.id = 'app'; document.body.append(root);
  const library = new Library(memoryBackend(), { cache: null }), project = createProject(); await library.saveProject(project);
  parent = kind === 'editor' ? new Editor(root, { library, project, account: {}, onExit() {}, onNewProject() {} }) : new Home(root, { library, account: {}, onOpen() {}, onCreate() {}, onImportFiles() {} });
  let rejected = false;
  try { await (kind === 'editor' ? parent.ctx.openScriptVideo() : parent.scriptToVideo()); } catch { rejected = true; }
  expect(rejected).toBe(false); expect(errors).toHaveBeenCalledOnce(); expect(scriptErrors()).toHaveLength(1);
});

it.each(['editor', 'home'])('%s ignores a script module failure after disposal', async kind => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {}), root = document.createElement('div'); root.id = 'app'; document.body.append(root);
  const library = new Library(memoryBackend(), { cache: null }), project = createProject(); await library.saveProject(project);
  parent = kind === 'editor' ? new Editor(root, { library, project, account: {}, onExit() {}, onNewProject() {} }) : new Home(root, { library, account: {}, onOpen() {}, onCreate() {}, onImportFiles() {} });
  const opening = kind === 'editor' ? parent.ctx.openScriptVideo() : parent.scriptToVideo(); parent.dispose();
  let rejected = false; try { await opening; } catch { rejected = true; }
  expect(rejected).toBe(false); expect(errors).not.toHaveBeenCalled(); expect(scriptErrors()).toHaveLength(0);
});
