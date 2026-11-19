// Lens Correction batch results: saved to a Puter folder, the closing
// message still names the images that failed, as the download does.
import { describe, expect, it, vi } from 'vitest';
import type { Editor } from '../src/editor';

const saved: unknown[][] = [];
vi.mock('../src/features/files/layers-export', () => ({
  saveToCloudFolder: (...args: unknown[]) => void saved.push(args),
}));
vi.mock('../src/persistence/puter', () => ({ download: () => {} }));

describe('deliverLensResults', () => {
  const files = Object.assign([{ name: 'a.jpg', blob: new Blob(['a']), crc: 0xe8b7be43 }], {
    failed: ['b.tif: The file is damaged.'],
  });
  const editor = () => {
    const messages: string[] = [];
    return { messages, e: { message: (m: string) => messages.push(m) } as unknown as Editor };
  };
  it('passes the failed images to the Puter folder save', async () => {
    const { deliverLensResults } = await import('../src/features/scripting/lens-batch');
    const { e } = editor();
    deliverLensResults(e, files, 'puter');
    expect(saved).toHaveLength(1);
    expect(saved[0][2]).toBe('1 file failed. b.tif: The file is damaged.');
  });
  it('names them after a download too', async () => {
    const { deliverLensResults } = await import('../src/features/scripting/lens-batch');
    const { e, messages } = editor();
    deliverLensResults(e, files, 'zip');
    expect(messages.at(-1)).toMatch(
      /^Corrected 1 image \(.+\)\. 1 file failed\. b\.tif: The file is damaged\.$/,
    );
  });
});
