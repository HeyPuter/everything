import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  decodeSummary,
  demoCapture,
  filterFrames,
  hexToBytes,
} from '../src/engine/packets.js';

describe('packet studio', () => {
  it('loads demo frames', () => {
    expect(demoCapture().length).toBeGreaterThanOrEqual(5);
  });

  it('round-trips hex', () => {
    const b = hexToBytes('dead beef');
    expect([...b]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(bytesToHex(b).replace(/\s/g, '')).toBe('deadbeef');
  });

  it('filters by protocol and text', () => {
    const all = demoCapture();
    expect(filterFrames(all, { proto: 'DNS' })).toHaveLength(1);
    expect(filterFrames(all, { text: 'example.com' })[0].proto).toBe('DNS');
  });

  it('summarizes HTTP ascii', () => {
    expect(decodeSummary(hexToBytes('47455420'))).toMatch(/HTTP/);
  });
});
