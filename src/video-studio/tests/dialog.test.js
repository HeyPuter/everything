// Shared dialogs: which button Enter presses, and focus.
import { describe, it, expect, afterEach } from 'vitest';
import { confirmDialog } from '../src/ui/dialog.js';

afterEach(() => {
  document.querySelectorAll('dialog').forEach((d) => d.remove());
});

const buttons = () => [...document.querySelectorAll('dialog[open] .dialog-actions .btn')];

describe('confirm dialogs', () => {
  it('focus the confirm button for an ordinary question', async () => {
    const answer = confirmDialog({ title: 'Reset shortcuts?', message: 'Every shortcut goes back.', confirm: 'Reset' });
    expect(document.activeElement.textContent).toBe('Reset');
    document.activeElement.click();
    expect(await answer).toBe(true);
  });

  it('focus Cancel when confirming destroys something, so Enter keeps it', async () => {
    const answer = confirmDialog({ title: 'Delete forever?', message: 'This can not be undone.', confirm: 'Delete forever', danger: true });
    expect(document.activeElement.textContent).toBe('Cancel');
    expect(buttons().map((b) => b.textContent)).toEqual(['Cancel', 'Delete forever']);
    document.activeElement.click();
    expect(await answer).toBe(false);
  });
});
