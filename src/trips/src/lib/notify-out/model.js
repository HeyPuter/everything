// Out-of-app notification settings (`me:notify`) and secrets (`me:notify:secret`), shared by the app and the
// events handler. Both read values defensively: personal KV is editable by its user outside the app.
import { urlProblem } from './guard.js';

export const KEYS = Object.freeze({
  prefs: 'me:notify',
  secret: 'me:notify:secret',
  sched: 'me:notify:sched',
  rev: 'me:notify:rev',
  retry: 'me:notify:retry',
  digest: 'me:notify:digest',
  status: 'me:notify:status',
  bucket: (hour) => `me:notify:d:${hour}`,
});
export const HANDLER_NAME = 'tripsNotify';
export const CHANNELS = Object.freeze(['webhook', 'ntfy', 'email']);
export const PUSH_CHANNELS = Object.freeze(['webhook', 'ntfy']);
export const CATEGORIES = Object.freeze(['reminders', 'bookings', 'members', 'trip', 'plan', 'costs', 'lists', 'files', 'collab', 'chat']);
export const WEBHOOK_FORMATS = Object.freeze(['json', 'slack', 'discord']);
export const TRIP_MODES = Object.freeze(['all', 'reminders', 'off']);
export const DIGEST_EVERY = Object.freeze(['hour', 'day']);
export const LEAD_DAYS = Object.freeze([0, 1, 3, 7, 14, 30]);
export const DEFAULT_NTFY = 'https://ntfy.sh';
export const LIMITS = Object.freeze({ trips: 20, topic: 64, token: 200, email: 254, secret: 128, leadDays: 6 });

/** Change-record entity types by preference category; unlisted types never notify. */
export const TYPE_CATEGORY = Object.freeze({
  meta: 'trip', member: 'members', guest: 'members',
  day: 'plan', visit: 'plan', dayNote: 'plan', place: 'plan', cat: 'plan',
  res: 'bookings',
  exp: 'costs', settle: 'costs', splitPreset: 'costs', costCat: 'costs',
  pack: 'lists', bag: 'lists', todo: 'lists', listMeta: 'lists',
  file: 'files', msg: 'chat', note: 'collab', link: 'collab', poll: 'collab',
});

const DEFAULT_EVENTS = Object.freeze({
  reminders: ['webhook', 'ntfy'], bookings: ['webhook', 'ntfy', 'email'], members: ['webhook', 'ntfy', 'email'], trip: ['webhook', 'ntfy', 'email'],
  plan: ['email'], costs: ['email'], lists: [], files: [], collab: ['email'], chat: [],
});

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const idLike = (value) => typeof value === 'string' && /^[a-z0-9]{16}$/.test(value);

export function defaultNotifyPrefs() {
  return {
    v: 1, on: false,
    channels: { webhook: { on: false, format: 'json' }, ntfy: { on: false, server: DEFAULT_NTFY, priority: 3 }, email: { on: false, every: 'day' } },
    events: Object.fromEntries(CATEGORIES.map((category) => [category, [...DEFAULT_EVENTS[category]]])),
    trips: {},
    lead: [1],
  };
}

/** `me:notify` with every invalid or unknown value replaced by its default. */
export function cleanNotifyPrefs(value) {
  const result = defaultNotifyPrefs();
  if (!plain(value)) return result;
  result.on = value.on === true;
  const channels = plain(value.channels) ? value.channels : {};
  for (const name of CHANNELS) {
    const input = plain(channels[name]) ? channels[name] : {};
    result.channels[name].on = input.on === true;
  }
  if (WEBHOOK_FORMATS.includes(channels.webhook?.format)) result.channels.webhook.format = channels.webhook.format;
  if (typeof channels.ntfy?.server === 'string' && !urlProblem(channels.ntfy.server)) result.channels.ntfy.server = channels.ntfy.server.replace(/\/+$/, '');
  if (Number.isInteger(channels.ntfy?.priority) && channels.ntfy.priority >= 1 && channels.ntfy.priority <= 5) result.channels.ntfy.priority = channels.ntfy.priority;
  if (DIGEST_EVERY.includes(channels.email?.every)) result.channels.email.every = channels.email.every;
  if (plain(value.events)) {
    for (const category of CATEGORIES) {
      const list = value.events[category];
      if (Array.isArray(list)) result.events[category] = CHANNELS.filter((name) => list.includes(name));
    }
  }
  if (plain(value.trips)) {
    for (const [id, mode] of Object.entries(value.trips)) if (idLike(id) && TRIP_MODES.includes(mode) && mode !== 'all') result.trips[id] = mode;
  }
  if (Array.isArray(value.lead)) result.lead = [...new Set(value.lead.filter((day) => LEAD_DAYS.includes(day)))].sort((a, b) => a - b).slice(0, LIMITS.leadDays);
  return result;
}

/** `me:notify:secret`: fields that fail their checks read as absent. */
export function cleanSecret(value) {
  const input = plain(value) ? value : {};
  const result = {};
  if (typeof input.webhookUrl === 'string' && !urlProblem(input.webhookUrl)) result.webhookUrl = input.webhookUrl;
  if (typeof input.webhookSecret === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(input.webhookSecret)) result.webhookSecret = input.webhookSecret;
  if (typeof input.ntfyTopic === 'string' && validTopic(input.ntfyTopic)) result.ntfyTopic = input.ntfyTopic;
  const token = text(input.ntfyToken, LIMITS.token);
  if (token && /^[\x21-\x7e]+$/.test(token)) result.ntfyToken = token;
  if (typeof input.email === 'string' && validEmail(input.email)) result.email = input.email.trim();
  return result;
}

export const validTopic = (topic) => typeof topic === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(topic);
export const validEmail = (email) => typeof email === 'string' && email.trim().length <= LIMITS.email && /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/.test(email.trim());

/** Channels that are switched on and have what they need to send. */
export function readyChannels(prefs, secret) {
  const ready = [];
  if (!prefs.on) return ready;
  if (prefs.channels.webhook.on && secret.webhookUrl && secret.webhookSecret) ready.push('webhook');
  if (prefs.channels.ntfy.on && secret.ntfyTopic) ready.push('ntfy');
  if (prefs.channels.email.on && secret.email) ready.push('email');
  return ready;
}

/** Channels a notification of `category` for trip `spaceId` goes to. */
export function channelsFor(prefs, ready, category, spaceId) {
  const mode = spaceId ? prefs.trips[spaceId] ?? 'all' : 'all';
  if (mode === 'off' || (mode === 'reminders' && category !== 'reminders')) return [];
  // Reminders are time-based; email waits for platform scheduled triggers (spec §20).
  return (prefs.events[category] ?? []).filter((name) => ready.includes(name) && !(name === 'email' && category === 'reminders'));
}

/** A fresh webhook signing secret: 32 random bytes, base64url. */
export function newSecret(crypto = globalThis.crypto) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A hard-to-guess ntfy topic; anyone who knows a topic on a public server can read it. */
export function newTopic(crypto = globalThis.crypto) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `trips-${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join('')}`;
}
