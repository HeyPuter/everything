/**
 * The documents most recently worked on, for the File menu's "Open recent":
 * the app folder's files, and those saved elsewhere through Puter's Save
 * dialog (made.js), by modification time, newest first, minus the one
 * that is open.
 */

import { documentPathKey } from './document-paths.js';

export const RECENT_LIMIT = 8;

export function recentFiles(files, { exclude = null, limit = RECENT_LIMIT } = {}) {
  const excludedPath = documentPathKey(exclude);
  return [...(files || [])]
    .filter((f) => f && f.path && documentPathKey(f.path) !== excludedPath)
    .sort((a, b) => (b.modified || 0) - (a.modified || 0) || String(a.name).localeCompare(String(b.name)))
    .slice(0, Math.max(0, limit));
}
