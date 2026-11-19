// Settings and destination of File → Export → Quick Export, from
// Preferences → Export (also opened by File → Export → Export Preferences…).
import type { Preferences } from '../../model/preferences';
import { defaultSettings, type ExportSettings } from './encode';

type QuickPrefs = Pick<
  Preferences,
  | 'quickExportSettings'
  | 'quickExportQuality'
  | 'quickExportTransparency'
  | 'quickExportMetadata'
  | 'quickExportConvertSrgb'
>;

/** The export settings a quick export uses: the last Export As settings, or
 * the quick export settings at full size. */
export function quickExportSettings(
  p: QuickPrefs,
  format: ExportSettings['format'],
  last: ExportSettings,
): ExportSettings {
  if (p.quickExportSettings !== 'own') return { ...last, format };
  return {
    ...defaultSettings,
    format,
    quality: p.quickExportQuality,
    transparency: p.quickExportTransparency,
    metadata: p.quickExportMetadata,
    convertSrgb: p.quickExportConvertSrgb,
  };
}

/** The Puter folder a quick export goes to for a document stored at
 * `docPath`, or undefined when it downloads instead. */
export function quickExportFolder(
  location: Preferences['quickExportLocation'],
  docPath: string | undefined,
): string | undefined {
  if (location === 'download' || location === 'ask' || !docPath) return undefined;
  const slash = docPath.lastIndexOf('/');
  const dir = slash > 0 ? docPath.slice(0, slash) : '';
  if (location === 'beside') return dir || '/';
  // An assets folder named after the document: "Photo.psd" → "Photo-assets".
  const file = docPath.slice(slash + 1);
  const base = file.replace(/\.[^.]+$/, '') || file || 'Untitled';
  return `${dir}/${base}-assets`;
}
