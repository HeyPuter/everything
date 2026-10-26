// Short in-app help, written for Trips. A page module (`mount`) and a drawer (`openHelp`) share one component.
import './help.css';
import { el, uid, append, clear } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button } from '../../ui/bits.js';
import { openDrawer } from '../../ui/sheet.js';
import { t } from '../../lib/i18n/index.js';
import { TOPICS, topicIds } from './topics.js';

const STORAGE_KEY = 'trips:help:topic';
const stored = () => { try { const value = globalThis.localStorage?.getItem(STORAGE_KEY); return topicIds.includes(value) ? value : null; } catch { return null; } };
const store = (id) => { try { globalThis.localStorage?.setItem(STORAGE_KEY, id); } catch { /* per-device convenience only */ } };

/** All words of a topic, for search. */
export function topicText(topic) {
  return [t(`help.${topic.id}.title`), t(`help.${topic.id}.intro`), ...Array.from({ length: topic.steps }, (_, i) => t(`help.${topic.id}.${i + 1}`))].join(' ');
}
const fold = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
export const matchTopics = (query) => (query.trim() ? TOPICS.filter((topic) => fold(topicText(topic)).includes(fold(query.trim()))) : TOPICS);

/**
 * The help browser: a searchable topic list and the selected topic. `compact` shows one pane at a time (drawers and
 * phones). `onLink(hash)` runs before an in-app link is followed.
 */
export function createHelp({ topic = stored() ?? TOPICS[0].id, compact = false, onLink } = {}) {
  let current = topicIds.includes(topic) ? topic : TOPICS[0].id;
  let showing = compact && !topicIds.includes(topic) ? 'list' : 'article';
  const searchId = uid('help-search');
  const listId = uid('help-list');
  const search = el('input.input', { id: searchId, type: 'search', autocomplete: 'off', placeholder: t('help.searchPlaceholder'), 'aria-controls': listId, oninput: () => renderList() });
  const list = el('ul.help-topics', { id: listId });
  const none = el('p.help-none', { hidden: true }, t('help.noMatch'));
  const nav = el('nav.help-nav', { 'aria-label': t('help.topics') },
    el('div.input-prefix.help-search', {}, el('label.sr-only', { htmlFor: searchId }, t('help.search')), icon('search', 16), search), list, none);
  const article = el('article.help-article', { 'aria-live': 'polite' });
  const element = el(`div.help${compact ? '.help-compact' : ''}`, {}, nav, article);

  function renderList() {
    const shown = matchTopics(search.value);
    none.hidden = shown.length > 0;
    list.replaceChildren(...shown.map((item) => el('li', {}, el('button.help-topic', {
      type: 'button', 'aria-current': item.id === current ? 'true' : null, dataset: { topic: item.id }, onclick: () => select(item.id, { focus: true }),
    }, icon(item.icon, 16), el('span', {}, t(`help.${item.id}.title`))))));
  }

  function renderArticle() {
    const item = TOPICS.find((entry) => entry.id === current);
    const title = el('h2.help-title', { tabIndex: -1 }, t(`help.${item.id}.title`));
    const back = compact ? button(t('help.back'), { size: 'sm', variant: 'ghost', icon: 'arrowLeft', onclick: () => { showing = 'list'; layout(); list.querySelector(`[data-topic="${current}"]`)?.focus(); } }) : null;
    back?.classList.add('help-back');
    append(clear(article), [
      back,
      title,
      el('p.help-intro', {}, t(`help.${item.id}.intro`)),
      el('ol.help-steps', {}, Array.from({ length: item.steps }, (_, index) => el('li', {}, t(`help.${item.id}.${index + 1}`)))),
      item.links?.length && el('div.help-links', {}, el('span.help-links-label', {}, t('help.related')), item.links.map((link) => el('a.help-link', {
        href: link.hash, onclick: () => onLink?.(link.hash),
      }, t(link.key))))]);
    return title;
  }

  function layout() {
    nav.hidden = compact && showing === 'article';
    article.hidden = compact && showing === 'list';
  }

  function select(id, { focus = false } = {}) {
    if (!topicIds.includes(id)) return;
    current = id;
    store(id);
    showing = 'article';
    renderList();
    const title = renderArticle();
    layout();
    if (focus) title.focus({ preventScroll: !compact });
  }

  renderList();
  renderArticle();
  layout();
  return { element, select, get topic() { return current; } };
}

/** Page entry (when the shell mounts `#/help`). */
export function mount(container) {
  const help = createHelp({ compact: globalThis.matchMedia?.('(max-width: 719px)').matches ?? false });
  container.replaceChildren(el('section.help-page', {}, help.element));
  return undefined;
}

/** Opens help in a drawer, optionally at a topic id (see topics.js). Returns the drawer handle. */
export function openHelp({ topic } = {}) {
  let drawer;
  const help = createHelp({ topic: topic ?? stored() ?? undefined, compact: true, onLink: () => drawer?.close('navigation') });
  drawer = openDrawer({ title: t('help.title'), content: help.element });
  drawer.panel.classList.add('help-drawer');
  return drawer;
}
