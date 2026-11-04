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
/** The other way round: the file a room this account shared belongs to (room id → path), checked against ROOM_KEY when read. */
const FILE_KEY = 'documents-collab-file:';

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
    if (value?.room) await rememberFile(value, path);
  }
  catch { /* the owner can share again */ }
}

/** Remember which file a room belongs to (a rename moves it along: moveRoom remembers the room under the new path). */
export async function rememberFile(link, path) {
  const owner = sdk();
  if (!owner?.kv || !link?.room || !path) return;
  try { await owner.kv.set(FILE_KEY + link.room, path); } catch { /* best effort */ }
}

/**
 * The file a room this account shared belongs to, or null: the room is still remembered for that file (a file deleted,
 * renamed elsewhere or shared again since leaves a memory that no longer matches, and is not followed).
 */
export async function fileOfRoom(link) {
  const owner = sdk();
  if (!owner?.kv || !link?.room) return null;
  try {
    const path = await owner.kv.get(FILE_KEY + link.room);
    if (typeof path !== 'string' || !path) return null;
    const room = await rememberedRoom(path);
    return room?.room === link.room && room?.server === link.server ? path : null;
  } catch { return null; }
}

/** A renamed file keeps its room, and only its own: a room left under the new name (a file shared there, then deleted elsewhere) is forgotten. */
export async function moveRoom(from, to) {
  if (!from || !to || from === to) return;
  const room = await rememberedRoom(from);
  await rememberRoom(to, room);
  if (room) await rememberRoom(from, null);
}

/** A deleted file, or a new file at a path, has no room. */
export const forgetRoom = path => rememberRoom(path, null);

/**
 * A shared file was deleted: nobody saves its room any more. Sharing stops, so the people still in it are told
 * and can keep a copy of their own rather than go on editing a document that is saved nowhere. Best effort.
 */
export async function endRoom(path) {
  const room = await rememberedRoom(path);
  if (room?.server && room?.room) {
    try {
      const { call } = await import('./api.js');
      await call(sdk(), room.server, { op: 'stop', room: room.room });
    } catch (e) { console.warn('[documents] sharing of the deleted document could not be stopped', e); }
  }
  await forgetRoom(path);
}
