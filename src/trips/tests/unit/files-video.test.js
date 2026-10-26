// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_BYTES, blobType, fileType, groupOf, isVideoFile, previewKind, rejectReason } from '../../src/lib/files/types.js';
import { createSha256, sha256Stream } from '../../src/lib/files/sha256.js';

const sized = (name, size, type = '') => ({ name, size, type });
const hex = async (bytes) => [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('video rules', () => {
  it('refuse videos unless the trip takes them, then cap at 500 MB and allow MP4, MOV and WebM only', () => {
    expect(rejectReason(sized('clip.mp4', 10))).toBe('video_direct');
    expect(rejectReason(sized('clip', 10, 'video/mp4'))).toBe('video_direct');
    for (const name of ['clip.mp4', 'clip.MOV', 'clip.webm']) expect(rejectReason(sized(name, 400 * 1024 * 1024), { video: true }), name).toBeNull();
    expect(rejectReason(sized('clip.mp4', MAX_VIDEO_BYTES + 1), { video: true })).toBe('video_too_large');
    expect(rejectReason(sized('clip.mp4', 0), { video: true })).toBe('file_empty');
    expect(rejectReason(sized('clip.mkv', 10), { video: true })).toBe('video_format');
    expect(rejectReason(sized('clip', 10, 'video/mp4'), { video: true })).toBe('video_format');
    expect(rejectReason(sized('page.html', 10), { video: true })).toBe('file_type');
    expect(rejectReason(sized('big.pdf', 60 * 1024 * 1024), { video: true })).toBe('file_too_large');
    expect(isVideoFile(sized('a.avi', 1))).toBe(true);
    expect(isVideoFile(sized('a.pdf', 1, 'application/pdf'))).toBe(false);
  });
  it('type, group and preview stored videos', () => {
    expect(fileType('Clip.mov')).toMatchObject({ ext: 'mov', mime: 'video/quicktime', group: 'video', video: true });
    expect(groupOf({ mime: 'video/mp4' })).toBe('video');
    expect(previewKind({ mime: 'video/webm' })).toBe('video');
    expect(previewKind({ mime: 'video/x-msvideo' })).toBe('none');
    expect(blobType('video/mp4')).toBe('video/mp4');
    expect(blobType('video/x-msvideo')).toBe('application/octet-stream');
  });
});

describe('streaming SHA-256', () => {
  it('matches WebCrypto at every padding boundary and across chunks', async () => {
    for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const bytes = new Uint8Array(size).map((_, i) => (i * 31 + size) & 255);
      expect(await sha256Stream(new Blob([bytes]), { chunk: 997 }), String(size)).toBe(await hex(bytes));
    }
    const hash = createSha256();
    hash.update(new TextEncoder().encode('ab'));
    hash.update(new TextEncoder().encode('c'));
    expect(hash.hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
