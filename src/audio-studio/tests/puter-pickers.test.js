import { afterEach, expect, it, vi } from 'vitest';
import { pickSave } from '../src/storage/puter.js';

afterEach(() => { delete window.puter; vi.restoreAllMocks(); });

it.each([
  ['cancel-aware', 'saved'],
  ['cancel-aware', 'failed'],
  ['legacy', 'failed'],
])('preserves the %s save picker result when it is %s', async (api, outcome) => {
  const item = { path: '/u/Other.asesx', name: 'Other.asesx' };
  const error = new Error('Picker failed');
  const pending = outcome === 'saved' ? Promise.resolve(item) : Promise.reject(error);
  pending.catch(() => {});
  if (api === 'cancel-aware') {
    pending.undefinedOnCancel = outcome === 'saved' ? Promise.resolve(item) : Promise.reject(error);
    pending.undefinedOnCancel.catch(() => {});
  }
  window.puter = { ui: { showSaveFilePicker: vi.fn(() => pending) } };
  const content = new Blob(['session']);
  const saving = pickSave(content, 'Song.asesx');
  if (outcome === 'saved') expect(await saving).toBe(item);
  else await expect(saving).rejects.toBe(error);
  expect(window.puter.ui.showSaveFilePicker).toHaveBeenCalledWith(content, 'Song.asesx');
});

it('reports save-picker setup failure when its cancellation companion stays pending', async () => {
  const pending = Promise.reject(new Error('Picker setup failed'));
  pending.catch(() => {});
  pending.undefinedOnCancel = new Promise(() => {});
  window.puter = { ui: { showSaveFilePicker: () => pending } };
  await expect(pickSave(new Blob(), 'Song.asesx')).rejects.toThrow('Picker setup failed');
});

it('settles a cancelled SDK save picker while its primary promise stays pending', async () => {
  const pending = new Promise(() => {});
  pending.undefinedOnCancel = Promise.resolve(undefined);
  window.puter = { ui: { showSaveFilePicker: () => pending } };
  expect(await pickSave(new Blob(), 'Song.asesx')).toBeUndefined();
});
