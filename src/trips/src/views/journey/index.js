// Journey module: `#/journeys` (the list) and `#/j/<worker>/<space>/<tab>` (one journey).
import '../trip/members/members.css';
import '../../lib/files/files.css';
import './journey.css';
import { bindFiles } from '../../lib/files/index.js';
import { mountJourneys } from './list.js';
import { mountJourney } from './detail.js';

export { openJourneyFromTrip, newJourney } from './command.js';
export { JOURNEY_TABS } from './tabs.js';

export async function mount(container, context) {
  const route = context.route ?? {};
  // Like the Files tab: uploads and downloads need the session's worker client.
  if (context.session?.api) bindFiles({ api: context.session.api, puter: context.puter, account: context.session.account?.uuid });
  if (route.name === 'space' && route.ref?.k === 'journey') return mountJourney(container, context);
  return mountJourneys(container, context);
}
