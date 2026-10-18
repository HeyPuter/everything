/**
 * The room a document file was shared in, remembered per file path in the
 * owner's Puter KV so that reopening the file rejoins it. The memory follows
 * the file: a rename moves it, and deleting the file, or creating a new file
 * at that path, forgets it, so a later document under the same name never
 * rejoins (and is overwritten by) another document's room.
 */
import { hash } from './protocol.js';

const ROOM_KEY = 'documents-collab-room:';

/** The SDK, when there is one (the mock SDK in development). */
const sdk = () => (typeof puter !== 'undefined' ? puter : null);
const keyFor = async path => ROOM_KEY + await hash(path);

/** The room remembered for a document file this account shared, or null. */
export async function rememberedRoom(path) {
  const owner = sdk();
  if (!owner?.kv || !path) return null;
  try { return await owner.kv.get(await keyFor(path)); } catch { return null; }
}

/** Remember the room of a file (or forget it, with a null value). */
export async function rememberRoom(path, value) {
  const owner = sdk();
  if (!owner?.kv || !path) return;
  try { if (value) await owner.kv.set(await keyFor(path), value); else await owner.kv.del(await keyFor(path)); }
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
