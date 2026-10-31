import './collab.css';
import { el } from '../../../ui/dom.js';
import { tabs } from '../../../ui/tabs.js';
import { conflictList, openConflictDialog } from '../../../ui/conflict.js';
import { t, strings } from '../../../lib/i18n/index.js';
import { createCollabContext } from './common.js';
import { COLLAB_TYPES } from './model.js';
import { mountChat } from './chat.js';
import { mountNotes } from './notes.js';
import { mountPolls } from './polls.js';
import { mountLinks } from './links.js';
import { mountFeed } from './feed/index.js';
import { createLinkPreviews } from './unfurl/index.js';

export { unreadBadge } from './badge.js';

const SECTIONS = Object.freeze({ chat: mountChat, notes: mountNotes, polls: mountPolls, links: mountLinks, activity: mountFeed });
const STORAGE_KEY = 'trips:collab:section';
// The read marker moves while the tab is open, at most every 20 s.
const SEEN_DELAY = 3000;
const SEEN_GAP = 20_000;

const typeLabel = (type) => t(Object.hasOwn(strings, `collab.type.${type}`) ? `collab.type.${type}` : 'collab.type.item');
const fieldLabel = (_type, name) => (Object.hasOwn(strings, `collab.field.${name}`) ? t(`collab.field.${name}`) : name);

function storedSection() {
  try { const value = globalThis.localStorage?.getItem(STORAGE_KEY); return Object.hasOwn(SECTIONS, value) ? value : 'chat'; } catch { return 'chat'; }
}
function storeSection(value) {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, value); } catch { /* per-device convenience only */ }
}

/** Collab tab: chat, notes, polls, links and activity for one open trip. */
export function mount(container, context) {
  const { space } = context;
  const uid = context.account.uuid;
  const doc = globalThis.document;
  // Read before the marker moves, so the feed can highlight what was new on arrival.
  const unreadAtOpen = Promise.resolve().then(() => space.unread()).catch(() => 0);
  let closed = false;

  const ctx = createCollabContext({ space, uid, route: context.route });
  ctx.previews = createLinkPreviews({ api: context.session?.api, space });
  const cleanups = new Map();
  // Each panel starts with a hidden h2, so the cards' h3 headings sit under the trip's h1 in order.
  const hosts = Object.fromEntries(Object.keys(SECTIONS).map((id) => [id, el('div.collab-panel-body')]));
  const panels = Object.fromEntries(Object.keys(SECTIONS).map((id) => [id, el('div.collab-panel', {}, el('h2.sr-only', {}, t(`collab.tab.${id}`)), hosts[id])]));
  function open(id) {
    if (cleanups.has(id)) return;
    const cleanup = SECTIONS[id](hosts[id], ctx, { unreadAtOpen });
    cleanups.set(id, typeof cleanup === 'function' ? cleanup : () => {});
  }
  const initial = storedSection();
  const control = tabs({
    label: t('collab.sections'), value: initial,
    items: Object.keys(SECTIONS).map((id) => ({ id, label: t(`collab.tab.${id}`), content: panels[id] })),
    onChange: (id) => { open(id); cleanups.get(id)?.show?.(); storeSection(id); },
  });
  control.element.classList.add('collab-tabs');

  const conflictsBox = el('section.collab-conflicts', { hidden: true, 'aria-labelledby': 'collab-conflicts-title' });
  let conflictsSig = '';
  function renderConflicts() {
    const list = space.conflicts().filter((conflict) => !conflict.op.do && COLLAB_TYPES.includes(conflict.op.t));
    const sig = list.map((conflict) => `${conflict.op.opId}:${conflict.code}`).join(',');
    if (sig === conflictsSig) return;
    conflictsSig = sig;
    conflictsBox.hidden = !list.length;
    if (!list.length) { conflictsBox.replaceChildren(); return; }
    conflictsBox.replaceChildren(el('h2.collab-conflicts-title', { id: 'collab-conflicts-title' }, t('collab.conflicts.title')), conflictList({
      conflicts: list,
      describe: (conflict) => {
        const entity = conflict.local ?? conflict.server ?? conflict.op.put ?? {};
        const name = entity.title ?? entity.question ?? (typeof entity.text === 'string' ? entity.text.slice(0, 80) : '');
        return { type: typeLabel(conflict.op.t), name };
      },
      onOpen: (conflict) => ctx.track(openConflictDialog({ conflict, typeLabel, fieldLabel, onResolve: (choice) => space.resolveConflict(conflict.op.opId, choice) })),
      formatTime: (at) => ctx.dateTime(at),
    }));
  }

  let lastSeen = 0;
  let seenTimer;
  function markSeen() {
    clearTimeout(seenTimer);
    seenTimer = undefined;
    if (closed || doc?.visibilityState === 'hidden') return;
    lastSeen = Date.now();
    try { void Promise.resolve(space.markSeen()).catch(() => {}); } catch { /* retried on the next change */ }
  }
  function queueSeen() {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(markSeen, Math.max(SEEN_DELAY, lastSeen + SEEN_GAP - Date.now()));
  }
  const onVisibility = () => { if (doc.visibilityState === 'visible') queueSeen(); };
  doc?.addEventListener('visibilitychange', onVisibility);
  const offFeed = space.subscribe((event) => { if (event.feed) queueSeen(); });
  const offState = space.onState(renderConflicts);

  container.replaceChildren(el('div.collab', {}, conflictsBox, control.element));
  open(control.value);
  renderConflicts();
  void unreadAtOpen.then(() => { if (!closed) markSeen(); });

  return () => {
    if (seenTimer !== undefined) markSeen();
    closed = true;
    clearTimeout(seenTimer);
    doc?.removeEventListener('visibilitychange', onVisibility);
    offFeed(); offState();
    for (const cleanup of cleanups.values()) { try { cleanup(); } catch { /* keep unmounting the rest */ } }
    cleanups.clear();
    ctx.previews.destroy();
    ctx.destroy();
  };
}
