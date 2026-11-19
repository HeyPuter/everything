// What of the image file a document was opened from was not opened (other
// pages or frames, metadata, CMYK colors): Save asks before writing the
// document back over that file. Kept apart from open.ts so recovery can
// carry it without loading the open code.
import type { DocumentSession } from '../../app/session';

export type LeftOut = { name: string; path?: string; what: string[] };
export const leftOutOfFile = new WeakMap<DocumentSession, LeftOut>();
