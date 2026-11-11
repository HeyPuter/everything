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

describe('prompt dialogs', () => {
  it('label their field with the visible label, which focuses it when clicked', async () => {
    const { promptDialog } = await import('../src/ui/dialog.js');
    const answer = promptDialog({ title: 'Rename project', label: 'Project name', value: 'Holiday' });
    const input = document.querySelector('dialog[open] input');
    const label = document.querySelector('dialog[open] label');
    expect(label.htmlFor).toBe(input.id);
    expect(input.labels[0]).toBe(label);
    expect(document.activeElement).toBe(input);
    document.querySelector('dialog[open] .btn:not(.primary)').click();
    expect(await answer).toBe(null);
  });
});
