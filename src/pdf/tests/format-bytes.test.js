import { describe, expect, it } from 'vitest';
import { formatBytes } from '../src/lib/ui.js';

describe('formatBytes', () => {
  it('names small files in whole kilobytes and large ones in megabytes', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(10)).toBe('1 KB');
    expect(formatBytes(123456)).toBe('121 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
  it('never shows 1024 KB for a file just under a megabyte', () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1023.6)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1023.4)).toBe('1023 KB');
  });
});
