/**
 * Short unique ids: a random prefix per session plus a counter. The prefix
 * has a fixed length (so a prefix and a counter can never run together into
 * another session's id) and 36^8 values, so two sessions practically never
 * share one: a shared prefix would make a session's new objects reuse ids
 * already in a document it opens, or a collaborator's, and overwrite them.
 */
const PREFIX_LENGTH = 8;

function randomPrefix() {
  const bytes = new Uint8Array(PREFIX_LENGTH);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += (b % 36).toString(36);
  return s;
}

const prefix = randomPrefix();
let counter = 0;

export function uid(kind = 'n') {
  counter++;
  return `${kind}${prefix}${counter.toString(36)}`;
}
