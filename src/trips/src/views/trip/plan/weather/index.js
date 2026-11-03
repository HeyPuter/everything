import './weather.css';
import { el } from '../../../../ui/dom.js';
import { displayLocale, onPrefs } from '../../../../lib/prefs.js';
import { registerPlanHooks } from '../hooks.js';
import { createWeatherStore } from './store.js';
import { renderChip, renderHead, renderInfo, renderPanel } from './view.js';
import { openRegionDialog } from './dialog.js';

const TAGS = { head: 'span.wx-head', chip: 'span.wx-chip', info: 'div.wx-info', panel: 'div.wx-panel' };

/**
 * Weather and holidays in the planner, through the plan hooks: the day header, badges under it, the day chips and the
 * day panel. Takes the Plan tab context (`space`, `session.services`) and returns the cleanup. Nodes it hands out stay
 * live: they update in place as data arrives, so the planner does not re-render for it.
 */
export function mountWeather({ space, session, services = session?.services }) {
  if (!space || !services?.weather || !services?.holidays) return () => {};
  const live = new Map();
  const locale = displayLocale();
  let store = null;
  const actions = { retry: () => store.retry(), chooseRegions: (countries) => openRegionDialog({ store, countries }) };
  const render = { head: renderHead, chip: renderChip, info: renderInfo, panel: (node, model) => renderPanel(node, model, actions) };
  const fill = (node, item) => { try { render[item.kind](node, store.day(item.dayId)); } catch { node.replaceChildren(); } };
  function refresh() {
    const now = Date.now();
    for (const [node, item] of live) {
      if (node.isConnected) fill(node, item);
      else if (now - item.born > 1000) live.delete(node);
    }
  }
  store = createWeatherStore({ space, services, lang: /^[a-zA-Z]{2}(?:-|$)/.test(locale) ? locale : 'en', onChange: refresh });
  function make(kind, entry) {
    const node = el(TAGS[kind]);
    const item = { kind, dayId: entry.day.id, born: Date.now() };
    live.set(node, item);
    fill(node, item);
    return node;
  }
  const offs = [
    registerPlanHooks({
      dayHeader: ({ entry }) => make('head', entry),
      dayInfo: ({ entry }) => make('info', entry),
      dayChip: ({ entry }) => make('chip', entry),
      dayPanel: ({ entry }) => make('panel', entry),
    }),
    onPrefs(refresh),
  ];
  return () => {
    for (const off of offs) off();
    store.destroy();
    live.clear();
  };
}
