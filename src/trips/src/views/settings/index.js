import './settings.css';

import * as appearance from './sections/appearance.js';
import * as general from './sections/general.js';
import * as map from './sections/map.js';
import * as dashboard from './sections/dashboard.js';
import * as templates from './sections/templates.js';
import * as categories from './sections/categories.js';
import * as ai from './sections/ai.js';
import * as vault from './sections/vault.js';
import * as account from './sections/account.js';

// One chunk for every section, so moving between sections never waits on (or fails for) another download.
const sections = { appearance, general, map, dashboard, templates, categories, ai, vault, account };

/** Shell entry for every settings section with a `load` in the registry. */
export async function mount(container, context) {
  const id = context.route?.section;
  if (id === 'offline') return (await import('./offline.js')).mount(container, context);
  if (!Object.hasOwn(sections, id)) return undefined;
  return sections[id].render(container, context);
}
