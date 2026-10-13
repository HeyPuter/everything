/**
 * Starting, finding and opening shared workbooks, for the app: the owner's worker is deployed (or updated) on
 * the first share, the room is created from the open workbook, and the file remembers its room (in the owner's
 * private app KV) so that opening the file again joins it.
 */

import { RoomClient } from './client.js';
import { collabPuter, deploy, call } from './api.js';
import { browserOutbox } from './outbox.js';
import { shareLink } from './protocol.js';
import { Doc } from '../lib/doc.js';
import { workbookToXlsx } from '../core/io.js';

const fileKey = (file) => `spreadsheet-collab-file-v1:${file.uid || file.path}`;

/** The room the owner's file is shared through, or null. */
export async function roomForFile(file) {
  if (!file?.path && !file?.uid) return null;
  try {
    const p = globalThis.puter;
    if (!p?.kv?.get) return null;
    const saved = await p.kv.get(fileKey(file));
    return saved?.server && saved?.room ? saved : null;
  } catch {
    return null;
  }
}

/** Share the open workbook for editing together: deploy the worker, create the room, remember it for the file. */
export async function startSharing(doc, progress = () => {}) {
  const puter = collabPuter();
  const server = await deploy(puter, progress);
  progress('Sharing the workbook…');
  const file = doc.path ? { path: doc.path, uid: doc.uid || null } : null;
  const room = await RoomClient.create({ puter, server, wb: doc.wb, name: doc.name, file });
  if (file) await puter.kv.set(fileKey(file), { server, room, at: Date.now() });
  return { server, room };
}

/** Join a room and open its workbook as a document. */
export async function openRoom({ server, room, token, path = null, uid = null }) {
  const client = new RoomClient({ puter: collabPuter(), server, room, token, store: browserOutbox(), toXlsx: (wb) => workbookToXlsx(wb) });
  try {
    await client.open();
  } catch (e) {
    client.close();
    throw e;
  }
  return Doc.forRoom(client, { path, uid });
}

/** The address that opens this shared workbook, with an invitation giving `role` (or none: for members only). */
export async function invitationLink(client, role = null) {
  const token = role ? (await client.request({ op: 'invite', role })).token : undefined;
  return shareLink(location.href, { server: client.o.server, room: client.room, token });
}

/** Stop editing together: the room closes for everyone, and the file is the owner's alone again. */
export async function stopSharing(doc) {
  const client = doc.collab;
  await doc.save().catch(() => {});
  await client.request({ op: 'stop' });
  if (doc.path) await globalThis.puter?.kv?.del?.(fileKey({ path: doc.path, uid: doc.uid })).catch?.(() => {});
}

export { call };
