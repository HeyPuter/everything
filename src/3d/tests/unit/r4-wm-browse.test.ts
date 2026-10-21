import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/app/app', () => ({ app: {}, registerOperators: () => {} }));
vi.mock('../../src/ui/buttons', () => ({ targetButton: () => undefined }));
vi.mock('../../src/io/native', () => ({ pickFile: async () => null }));

describe('path browse helpers', () => {
  it('turns filter globs into an accept list and names into paths', async () => {
    const { acceptFromGlob, pickedPath } = await import('../../src/ui/browseops');
    expect(acceptFromGlob('*.png;*.jpg, *.exr')).toBe('.png,.jpg,.exr');
    expect(acceptFromGlob('')).toBe('');
    expect(acceptFromGlob('*')).toBe('');
    expect(pickedPath('a.png', true)).toBe('//a.png');
    expect(pickedPath('a.png', false)).toBe('a.png');
    expect(pickedPath('renders/', true, true)).toBe('//renders/');
  });
});
