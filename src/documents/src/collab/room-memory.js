/**
 * The room a document file was shared in, remembered per file path in the
 * owner's Puter KV so that reopening the file rejoins it. The memory follows
 * the file: a rename moves it, and deleting the file, or creating a new file
 * at that path, forgets it, so a later document under the same name never
 * rejoins (and is overwritten by) another document's room.
 */
import { hash } from './protocol.js';
import { DOCUMENT_FOLDER, documentPathKey, documentRoot } from '../lib/document-paths.js';

const ROOM_KEY = 'documents-collab-room:';

/** The SDK, when there is one (the mock SDK in development). */
const sdk = () => (typeof puter !== 'undefined' ? puter : null);

/**
 * The keys a file's room can be remembered under, the one to use first. A file in the app folder is spelled from
 * the folder where the app writes it and from the drive's root in listings (the document list opens it so):
 * both are one file, with one room. Memories kept under the root spelling are still found.
 */
async function keysFor(path) {
  const canonical = documentPathKey(path), root = documentRoot();
  const spellings = new Set([canonical, path]);
  if (root && canonical.startsWith(`${DOCUMENT_FOLDER}/`)) spellings.add(`${root}/${canonical.slice(DOCUMENT_FOLDER.length + 1)}`);
  return Promise.all([...spellings].map(async spelling => ROOM_KEY + await hash(spelling)));
}

/** The room remembered for a document file this account shared, or null. */
export async function rememberedRoom(path) {
  const owner = sdk();
  if (!owner?.kv || !path) return null;
  try { return (await Promise.all((await keysFor(path)).map(key => owner.kv.get(key)))).find(Boolean) ?? null; }
  catch { return null; }
}

/** Remember the room of a file (or forget it, with a null value). */
export async function rememberRoom(path, value) {
  const owner = sdk();
  if (!owner?.kv || !path) return;
  try {
    const [key, ...others] = await keysFor(path);
    if (value) await owner.kv.set(key, value); else await owner.kv.del(key);
    for (const other of others) await owner.kv.del(other);
  }
  catch { /* the owner can share again */ }
}

/** A renamed file keeps its room. */
export async function moveRoom(from, to) {
  if (!from || !to || from === to) return;
  const room = await rememberedRoom(from);
  if (!room) return;
  await rememberRoom(to, room);
  await rememberRoom(from, null);
}

/** A deleted file, or a new file at a path, has no room. */
export const forgetRoom = path => rememberRoom(path, null);
