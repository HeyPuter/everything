// Invitation and review links (small: loaded at startup to notice a link
// Photo Studio was opened with).
export const ID = /^[a-zA-Z0-9_-]{1,100}$/;

/** The origin of a Puter worker; anything else is refused. */
export function workerURL(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.puter\.work$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Invalid collaboration server address.');
  return url.origin;
}

/** A link that opens a shared document: in the URL hash, so it never reaches
 * a server log. `review` links open the lightweight review view. */
export type RoomLink = { server: string; room: string; token?: string; review?: boolean };
export function shareLink(base: string, link: RoomLink) {
  const url = new URL(base);
  url.hash = new URLSearchParams({
    'ps-server': workerURL(link.server),
    'ps-room': link.room,
    ...(link.token ? { 'ps-invite': link.token } : {}),
    ...(link.review ? { 'ps-review': '1' } : {}),
  }).toString();
  return url.href;
}
export function parseLink(value: string, base?: string): RoomLink | null {
  const url = new URL(value, base);
  const p = new URLSearchParams(url.hash.slice(1));
  const room = p.get('ps-room');
  if (!room) return null;
  if (!ID.test(room)) throw new Error('Invalid invitation link.');
  const token = p.get('ps-invite') ?? undefined;
  if (token !== undefined && !/^[a-zA-Z0-9-]{8,200}$/.test(token)) throw new Error('Invalid invitation link.');
  return { server: workerURL(p.get('ps-server') ?? ''), room, token, review: p.get('ps-review') === '1' };
}

