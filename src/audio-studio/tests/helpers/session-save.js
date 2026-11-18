import { expect, vi } from 'vitest';

export async function sessionSaveForm() {
  await vi.waitFor(() => expect(document.querySelector('.session-save-dialog')).not.toBeNull(), { interval: 1 });
  return document.querySelector('.session-save-dialog');
}

export async function confirmSessionSave(name, { folder, replace = false } = {}) {
  const form = await sessionSaveForm();
  form.querySelector('[aria-label="File name"]').value = name;
  if (folder) form.querySelector('[aria-label="Puter folder"]').value = folder;
  form.querySelector('.dialog-foot button[data-value="save"]').click();
  if (replace) {
    await vi.waitFor(() => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2), { interval: 1 });
    [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Replace').click();
  }
}
