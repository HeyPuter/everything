import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from '../src/ui/editor.js';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { createProject } from '../src/model/project.js';

vi.mock('../src/ui/highlights-dialog.js', () => { throw new TypeError('Failed to fetch dynamically imported module'); });
let parent;
const highlightErrors = () => [...document.querySelectorAll('.toast.error')].filter(t => t.textContent.includes("Couldn't open Find highlights"));
afterEach(() => { parent?.dispose(); parent = null; vi.restoreAllMocks(); document.querySelectorAll('.toast').forEach(t => t.remove()); document.body.replaceChildren(); });

it.each(['editor'])('%s reports a current highlights module failure without rejecting the command', async kind => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {}), root = document.createElement('div'); root.id = 'app'; document.body.append(root);
  const library = new Library(memoryBackend(), { cache: null }), project = createProject(); await library.saveProject(project);
  parent = new Editor(root, { library, project, account: {}, onExit() {}, onNewProject() {} });
  let rejected = false;
  try { await parent.ctx.openHighlights(); } catch { rejected = true; }
  expect(rejected).toBe(false); expect(errors).toHaveBeenCalledOnce(); expect(highlightErrors()).toHaveLength(1);
});

it.each(['editor'])('%s ignores a highlights module failure after disposal', async kind => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {}), root = document.createElement('div'); root.id = 'app'; document.body.append(root);
  const library = new Library(memoryBackend(), { cache: null }), project = createProject(); await library.saveProject(project);
  parent = new Editor(root, { library, project, account: {}, onExit() {}, onNewProject() {} });
  const opening = parent.ctx.openHighlights(); parent.dispose();
  let rejected = false; try { await opening; } catch { rejected = true; }
  expect(rejected).toBe(false); expect(errors).not.toHaveBeenCalled(); expect(highlightErrors()).toHaveLength(0);
});
