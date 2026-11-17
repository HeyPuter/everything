// Shared dialogs: which button Enter presses, and focus.
import { describe, it, expect, afterEach, vi } from 'vitest';
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

describe('toasts', () => {
  it('stay while their button has keyboard focus, and errors stay longer', async () => {
    const { vi } = await import('vitest');
    const { toast } = await import('../src/ui/dialog.js');
    vi.useFakeTimers();
    try {
      const onClick = vi.fn();
      toast('Clip deleted', { action: { label: 'Undo', onClick } });
      const t = document.querySelector('.toast:last-child');
      const btn = t.querySelector('.toast-action');
      btn.focus();
      vi.advanceTimersByTime(20000);
      expect(t.isConnected).toBe(true);
      btn.blur();
      vi.advanceTimersByTime(3800 + 200);
      expect(t.isConnected).toBe(false);
      toast("Couldn't save", { kind: 'error' });
      const err = document.querySelector('.toast:last-child');
      vi.advanceTimersByTime(5000);
      expect(err.isConnected).toBe(true);
      vi.advanceTimersByTime(3000 + 200);
      expect(err.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dialogs that load before they open', () => {
  it('open once however often they are asked for while loading', async () => {
    const { oneAtATime } = await import('../src/ui/dialog.js');
    let finish;
    let opened = 0;
    const open = oneAtATime(async () => {
      await new Promise((r) => (finish = r));
      opened++;
    });
    const first = open();
    const second = open();
    expect(second).toBe(first);
    expect(document.documentElement.classList.contains('opening-dialog')).toBe(true);
    finish();
    await first;
    expect(opened).toBe(1);
    expect(document.documentElement.classList.contains('opening-dialog')).toBe(false);
    // Once it has settled (even by failing), it opens again.
    const failing = oneAtATime(async () => { throw new Error('no frame'); });
    await expect(failing()).rejects.toThrow('no frame');
    await expect(failing()).rejects.toThrow('no frame');
    expect(document.documentElement.classList.contains('opening-dialog')).toBe(false);
  });
});

describe('messages while a dialog is open', () => {
  it('show inside the dialog, where they can be seen and are read out, and stay after it closes', async () => {
    const { openDialog, toast } = await import('../src/ui/dialog.js');
    const { announce } = await import('../src/lib/dom.js');
    const live = document.getElementById('live-region') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'live-region' }));
    const d = openDialog({ title: 'Share for review', body: document.createElement('p') });
    toast("Couldn't create the link.", { kind: 'error' });
    expect(d.el.querySelector('.toast')?.textContent).toContain("Couldn't create the link.");
    announce('Link copied');
    await new Promise((r) => setTimeout(r, 50));
    expect(d.el.querySelector('.dialog-live').textContent).toBe('Link copied');
    expect(live.textContent).not.toBe('Link copied');
    // Announced as the dialog closes: spoken by the page's region, the dialog's is gone.
    announce('Crop applied');
    d.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(live.textContent).toBe('Crop applied');
    expect(document.body.querySelector(':scope > .toasts .toast')?.textContent).toContain("Couldn't create the link.");
    document.querySelectorAll('.toast').forEach((t) => t.remove());
  });
});

describe('a dialog the browser closes on its own', () => {
  it('runs its cleanup, or opens again when it may not close yet', async () => {
    const { openDialog } = await import('../src/ui/dialog.js');
    const onClose = vi.fn();
    const d = openDialog({ title: 'Record', body: document.createElement('p'), onClose });
    d.el.close();
    d.el.dispatchEvent(new Event('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(d.el.isConnected).toBe(false);
    await expect(d.result).resolves.toBeUndefined();

    let busy = true;
    const saving = openDialog({ title: 'Voiceover', body: document.createElement('p'), beforeClose: () => !busy, onClose });
    saving.el.close();
    saving.el.dispatchEvent(new Event('close'));
    expect(saving.el.isConnected).toBe(true);
    expect(saving.el.open).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    busy = false;
    saving.close();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

