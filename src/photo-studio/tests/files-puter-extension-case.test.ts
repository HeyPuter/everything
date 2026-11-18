// Preferences → File Handling → Append file extension applies to files saved
// to Puter (save pickers and folder exports) as it does to downloads.
import { afterEach, expect, it } from 'vitest';
import { cloudSaveAs } from '../src/features/files/cloud';
import { fileNaming } from '../src/persistence/puter';

const g = globalThis as unknown as { window?: unknown };
afterEach(() => {
  delete g.window;
  fileNaming.extensionCase = 'lower';
});

it('suggests the preferred extension case in the Puter save picker', async () => {
  const names: string[] = [];
  g.window = {
    puter: {
      ui: {
        showSaveFilePicker: async (_: Blob, name: string) => (
          names.push(name),
          { path: `/me/${name}`, name }
        ),
      },
    },
  };
  fileNaming.extensionCase = 'upper';
  await cloudSaveAs(new Blob(['x']), 'Poster.png');
  fileNaming.extensionCase = 'lower';
  await cloudSaveAs(new Blob(['x']), 'Poster.PSD');
  expect(names).toEqual(['Poster.PNG', 'Poster.psd']);
});
