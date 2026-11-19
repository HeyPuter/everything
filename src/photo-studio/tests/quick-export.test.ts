import { describe, expect, it } from 'vitest';
import { quickExportFolder, quickExportSettings } from '../src/features/files/quick-export';
import { defaultSettings } from '../src/features/files/encode';
import { defaultPreferences, validatePreferences } from '../src/model/preferences';

describe('quick export preferences', () => {
  const last = {
    ...defaultSettings,
    quality: 40,
    scale: 50,
    metadata: 'all' as const,
    convertSrgb: false,
  };

  it('uses the last Export As settings by default, in the quick export format', () => {
    const p = defaultPreferences();
    expect(p.quickExportSettings).toBe('last');
    expect(quickExportSettings(p, 'jpeg', last)).toEqual({ ...last, format: 'jpeg' });
  });

  it('uses its own quality, transparency, metadata and color conversion at full size', () => {
    const p = {
      ...defaultPreferences(),
      quickExportSettings: 'own' as const,
      quickExportQuality: 72,
      quickExportTransparency: false,
      quickExportMetadata: 'copyright' as const,
      quickExportConvertSrgb: true,
    };
    const s = quickExportSettings(p, 'webp', last);
    expect(s).toMatchObject({
      format: 'webp',
      quality: 72,
      transparency: false,
      metadata: 'copyright',
      convertSrgb: true,
      scale: 100,
      sizeMode: 'percent',
      canvasWidth: 0,
    });
  });

  it('exports beside the document or into an assets folder named after it', () => {
    expect(quickExportFolder('beside', '/user/Pictures/Photo.psd')).toBe('/user/Pictures');
    expect(quickExportFolder('assets', '/user/Pictures/Photo.psd')).toBe(
      '/user/Pictures/Photo-assets',
    );
    expect(quickExportFolder('assets', '/user/Pictures/archive.v2.photo')).toBe(
      '/user/Pictures/archive.v2-assets',
    );
    // Not saved to Puter yet, or not a folder choice: downloads (or asks).
    expect(quickExportFolder('assets', undefined)).toBeUndefined();
    expect(quickExportFolder('download', '/user/Photo.psd')).toBeUndefined();
    expect(quickExportFolder('ask', '/user/Photo.psd')).toBeUndefined();
  });

  it('validates stored values', () => {
    const problems: string[] = [];
    const p = validatePreferences(
      {
        quickExportQuality: 500,
        quickExportLocation: 'assets',
        quickExportMetadata: 'everything',
        quickExportFormat: 'svg',
      },
      problems,
    );
    expect(p.quickExportQuality).toBe(100);
    expect(p.quickExportLocation).toBe('assets');
    expect(p.quickExportFormat).toBe('svg');
    expect(p.quickExportMetadata).toBe('none');
    expect(problems).toEqual(['quickExportMetadata']);
  });
});
