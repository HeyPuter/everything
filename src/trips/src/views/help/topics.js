// Help topics. Text lives in i18n/en/help.js as `help.<topic>.<n>`; each topic is a title, an intro and steps.
// `links` are in-app routes shown under the steps.
export const TOPICS = Object.freeze([
  { id: 'start', icon: 'map', steps: 4, links: [{ key: 'help.link.trips', hash: '#/' }] },
  { id: 'plan', icon: 'pin', steps: 5 },
  { id: 'bookings', icon: 'plane', steps: 4 },
  { id: 'costs', icon: 'wallet', steps: 5 },
  { id: 'lists', icon: 'backpack', steps: 4 },
  { id: 'files', icon: 'file', steps: 4 },
  { id: 'collab', icon: 'users', steps: 4 },
  { id: 'sharing', icon: 'users', steps: 5 },
  { id: 'reminders', icon: 'clock', steps: 4, links: [{ key: 'help.link.week', hash: '#/week' }] },
  { id: 'offline', icon: 'offline', steps: 4, links: [{ key: 'help.link.offline', hash: '#/settings/offline' }] },
  { id: 'data', icon: 'globe', steps: 5, links: [{ key: 'help.link.data', hash: '#/settings/data' }, { key: 'help.link.delete', hash: '#/settings/delete' }] },
  { id: 'keys', icon: 'search', steps: 5 },
]);
export const topicIds = TOPICS.map((topic) => topic.id);
