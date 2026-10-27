// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { openModal } from '../src/ui/modal.js';

// A dialog finishes closing 200 ms after close(): it leaves the page and gives focus back to its opener.
// That step used the global document, which is gone once a test environment has been torn down (or
// in a frame that has been removed), and threw "document is not defined" from the timer.
it('finishes closing without the global document', () => {
  vi.useFakeTimers();
  try {
    window.matchMedia = () => ({ matches: true, addEventListener() {} });
    document.body.innerHTML = '<div id="app"><button id="opener">Open</button></div>';
    const opener = document.getElementById('opener');
    opener.focus();
    const { close } = openModal({ title: 'Probe', content: document.createElement('div') });
    const root = document.querySelector('.modal-root');
    close();
    const saved = globalThis.document;
    delete globalThis.document;
    try { expect(() => vi.advanceTimersByTime(250)).not.toThrow(); }
    finally { globalThis.document = saved; }
    expect(root.isConnected).toBe(false);
    expect(document.activeElement).toBe(opener);
  } finally { vi.useRealTimers(); }
});
