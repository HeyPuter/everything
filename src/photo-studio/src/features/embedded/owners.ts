// Which content tabs belong to which parent document (Edit Contents).
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';

export type Owner = { parent: DocumentSession; contents?: string; layerId: string; name: string };
export const owners = new WeakMap<DocumentSession, Owner>();

export const ownerOf = (s: DocumentSession) => owners.get(s);
export function detach(s: DocumentSession) {
  owners.delete(s);
  s.saveHandler = undefined;
  s.closeHandler = undefined;
}
/** A closing parent leaves its content tabs open as standalone documents. */
export function parentClosed(e: Editor, closed: DocumentSession) {
  let count = 0;
  for (const s of e.sessions)
    if (owners.get(s)?.parent === closed) {
      detach(s);
      count++;
    }
  if (count) e.message(`${count === 1 ? 'Its contents tab stays' : `${count} contents tabs stay`} open as a separate document; use Save As to keep it.`);
}
/** Tab label suffix for content tabs. */
export const tabBadge = (s: DocumentSession) => (owners.has(s) ? 'Contents' : '');
