import { describe, it, expect, afterEach, vi } from 'vitest';
import { toast } from '../src/ui/toast.js';

/**
 * A toast with an action is the only way back from a move. Someone who has
 * tabbed to its Undo, or is pointing at it, is about to use it: it waits.
 */

afterEach(() => {
  vi.useRealTimers();
  document.querySelectorAll('.toast').forEach((node) => node.remove());
});

const showUndo = () => {
  toast('Archived.', { action: { label: 'Undo', onSelect: () => {} } });
  return document.querySelector('.toast');
};

describe('toast', () => {
  it('goes on its own after a while', async () => {
    vi.useFakeTimers();
    const node = showUndo();
    await vi.advanceTimersByTimeAsync(8500);
    expect(node.isConnected).toBe(false);
  });

  it('stays while its action has keyboard focus, and goes once it is left', async () => {
    vi.useFakeTimers();
    const node = showUndo();
    const undo = node.querySelector('.toast-action');
    await vi.advanceTimersByTimeAsync(7000);
    undo.focus();
    await vi.advanceTimersByTimeAsync(20000);
    expect(node.isConnected).toBe(true);
    expect(document.activeElement).toBe(undo);
    undo.blur();
    await vi.advanceTimersByTimeAsync(4000);
    expect(node.isConnected).toBe(false);
  });

  it('stays while the pointer is on it', async () => {
    vi.useFakeTimers();
    const node = showUndo();
    node.dispatchEvent(new Event('pointerenter'));
    await vi.advanceTimersByTimeAsync(20000);
    expect(node.isConnected).toBe(true);
    node.dispatchEvent(new Event('pointerleave'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(node.isConnected).toBe(false);
  });
});
