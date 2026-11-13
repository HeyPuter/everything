import { afterEach, expect, it } from 'vitest';
import { promptDialog } from '../src/ui/dialog.js';
import { openProjectSettings } from '../src/dialogs/project-settings.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';

afterEach(() => {
  document.querySelectorAll('.dialog-head button').forEach((button) => button.click());
  document.body.replaceChildren();
});

function key(input, name, isComposing = false) {
  const event = new KeyboardEvent('keydown', { key: name, isComposing, bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  return event;
}

it.each(['Escape', 'Enter'])('leaves composing %s in a rename prompt to the input method', async (pressed) => {
  const done = promptDialog({ title: 'Rename', label: 'Name', value: 'Original' });
  const dialog = document.querySelector('.dialog');
  const input = dialog.querySelector('input');
  input.value = '新しい名前';
  const event = key(input, pressed, true);
  expect(dialog.isConnected).toBe(true);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('新しい名前');
  expect(event.defaultPrevented).toBe(false);
  // The next ordinary Enter still submits the completed name.
  key(input, 'Enter');
  expect(await done).toBe('新しい名前');
});

it('preserves project-settings edits when Escape cancels composition, then allows ordinary cancellation', async () => {
  const store = new Store(newProject());
  const before = store.project;
  const done = openProjectSettings({ store });
  const dialog = document.querySelector('.dlg-project');
  const input = dialog.querySelector('input[type="text"]');
  input.value = '編集中';
  expect(key(input, 'Escape', true).defaultPrevented).toBe(false);
  expect(dialog.isConnected).toBe(true);
  expect(input.value).toBe('編集中');
  expect(store.project).toBe(before);
  key(input, 'Escape');
  await done;
  expect(dialog.isConnected).toBe(false);
  expect(store.project).toBe(before);
  expect(store.undoStack).toHaveLength(0);
});
