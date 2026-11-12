// The progress dialog of long effect operations.
import { describe, it, expect } from 'vitest';
import { withProgress } from '../src/effects/progress.js';
import { fakeApp } from './fx-helpers.js';

const later = (ms) => new Promise((r) => setTimeout(r, ms));

describe('progress dialog', () => {
  it('reports a percentage, or no value at all while the length of the work is unknown', async () => {
    const app = fakeApp();
    for (const indeterminate of [false, true]) {
      let bar = null;
      await withProgress(
        app,
        'Working',
        async (signal, onProgress) => {
          onProgress(0.5);
          await later(5);
          bar = document.querySelector('.fx-progress');
        },
        { delay: 0, indeterminate },
      );
      expect(bar.getAttribute('role')).toBe('progressbar');
      expect(bar.getAttribute('aria-valuenow')).toBe(indeterminate ? null : '50');
      expect(document.querySelector('.fx-progress')).toBeNull();
    }
  });
});
