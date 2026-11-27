/**
 * Multi-page scan session: ordered list of processed page bitmaps + JPEG exports.
 */

let idSeq = 1;

export function createSession() {
  return { pages: [], name: 'Scan' };
}

export function addPage(session, page) {
  const entry = {
    id: `page_${idSeq++}`,
    width: page.width,
    height: page.height,
    rgba: page.rgba,
    filter: page.filter || 'document',
    createdAt: new Date().toISOString(),
  };
  session.pages.push(entry);
  return entry;
}

export function removePage(session, id) {
  session.pages = session.pages.filter((p) => p.id !== id);
}

export function reorderPage(session, id, toIndex) {
  const i = session.pages.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [page] = session.pages.splice(i, 1);
  session.pages.splice(Math.max(0, Math.min(toIndex, session.pages.length)), 0, page);
}

export function serializeSession(session) {
  return {
    name: session.name,
    pages: session.pages.map(({ id, width, height, filter, createdAt }) => ({
      id,
      width,
      height,
      filter,
      createdAt,
    })),
  };
}
