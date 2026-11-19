// Quick Compare state read by menus and key handling at any time, kept apart
// from the comparison view that loads on first use. Comparing is a way of
// looking at a document: it lives beside the session, never in the document
// or its history.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import type { Orientation } from './geometry';

/** The stored state shown as "before". History states are kept by their
 * document (states are immutable), so the choice survives later edits. */
export type CompareRef =
  | { kind: 'opened' }
  | { kind: 'saved' }
  | { kind: 'snapshot'; id: string }
  | { kind: 'history'; doc: PhotoDocument; label: string };
export type CompareMode = 'split' | 'side' | 'hold';
export type CompareState = {
  ref: CompareRef;
  mode: CompareMode;
  orientation: Orientation;
  // Divider position across the window, 0–1.
  position: number;
  // The stored state is shown whole while a press or key is held.
  holding: boolean;
};

const states = new WeakMap<DocumentSession, CompareState>();
export const compareState = (s: DocumentSession) => states.get(s);
export const compareActive = (e: Editor) => e.hasDocument && states.has(e.session);
export function setCompareState(s: DocumentSession, state: CompareState | undefined) {
  if (state) states.set(s, state);
  else states.delete(s);
}

// The arrangement last used, for the next comparison (a per-viewer convenience).
const KEY = 'photo-studio-quick-compare';
export type CompareLayout = Pick<CompareState, 'mode' | 'orientation' | 'position'>;
export function loadLayout(): CompareLayout {
  const fallback: CompareLayout = { mode: 'split', orientation: 'vertical', position: 0.5 };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!v || typeof v !== 'object') return fallback;
    return {
      mode: ['split', 'side', 'hold'].includes(v.mode) ? v.mode : fallback.mode,
      orientation: v.orientation === 'horizontal' ? 'horizontal' : 'vertical',
      position: Number.isFinite(v.position)
        ? Math.max(0, Math.min(1, v.position))
        : fallback.position,
    };
  } catch {
    return fallback;
  }
}
export function saveLayout(l: CompareLayout) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ mode: l.mode, orientation: l.orientation, position: l.position }),
    );
  } catch {
    /* Optional. */
  }
}
