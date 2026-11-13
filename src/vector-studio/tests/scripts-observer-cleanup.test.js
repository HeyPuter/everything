import { describe, expect, it, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { runScript } from '../src/features/scripts/runner.js';

describe('script command observer cleanup', () => {
  it.each(['timeout', 'completion'])('disconnects pending command observers on script %s', async (reason) => {
    const app = bootApp();
    app.newDocument();
    let finishCommand;
    const command = new Promise((resolve) => { finishCommand = resolve; });
    app.commands.register({ id: 'test.pending', label: 'Pending', run: () => command });
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    vi.useFakeTimers();
    try {
      const run = runScript(app, '', { timeoutMs: 100 });
      const frame = document.querySelector('iframe[sandbox]');
      const send = (data) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
      send({ __vs: 'call', id: 1, method: 'command', args: ['test.pending'] });
      expect(disconnect).not.toHaveBeenCalled();
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(101);
      else send({ __vs: 'done', value: 'finished' });
      expect(await run).toMatchObject({ ok: reason === 'completion' });
      expect(frame.isConnected).toBe(false);
      expect(disconnect).toHaveBeenCalledTimes(1);
      finishCommand();
      await vi.advanceTimersByTimeAsync(0);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finishCommand();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      disconnect.mockRestore();
    }
  });
});
