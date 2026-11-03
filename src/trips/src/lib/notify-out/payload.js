// Notifications as plain data, and their per-channel bodies. `t` is a translate function over `notifyOut.*` strings.
import { TYPE_CATEGORY } from './model.js';

export const MAX_ITEMS = 20;
export const REMINDER_KINDS = Object.freeze(['trip', 'todo', 'booking', 'overdue']);
const SHOWN = 5;
const NAME_CHARS = 80;
// Field changes that alone never notify: ordering, automatic counters and per-user marks.
const NOISE = new Set(['order', 'pos', 'dayCount', 'votes', 'react', 'rating', 'tags', 'visited', 'doneBy', 'bring', 'thumb', 'star']);

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The trip link, only on an https origin. */
export function tripUrl(origin, worker, space) {
  if (typeof origin !== 'string' || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) return null;
  if (!/^trips-[a-z0-9]{10}$/.test(worker ?? '') || !/^[a-z0-9]{16}$/.test(space ?? '')) return null;
  return `${origin}/#/t/${worker}/${space}`;
}

/**
 * Items worth notifying from change records (`{rev, at, by, sum}`), oldest first. The subscriber's own changes are
 * left out, and several changes to one entity collapse into its latest state.
 */
export function changeItems(records, uid) {
  const byKey = new Map();
  for (const record of [...records].filter(plain).sort((a, b) => a.rev - b.rev)) {
    if (!Array.isArray(record.sum) || record.by === uid) continue;
    for (const entry of record.sum) {
      if (!plain(entry) || !Object.hasOwn(TYPE_CATEGORY, entry.t) || typeof entry.id !== 'string') continue;
      const op = entry.op === 'put' ? 'add' : entry.op === 'del' ? 'remove' : 'change';
      const fields = Array.isArray(entry.fields) ? entry.fields.filter((field) => typeof field === 'string').map((field) => field.split('.')[0]) : [];
      if (op === 'change' && (entry.t === 'msg' || (fields.length && fields.every((field) => NOISE.has(field))))) continue;
      const key = `${entry.t}:${entry.id}`;
      const earlier = byKey.get(key);
      const merged = earlier && earlier.op === 'add' && op === 'change' ? 'add' : op;
      if (earlier?.op === 'add' && op === 'remove') { byKey.delete(key); continue; }
      byKey.delete(key);
      byKey.set(key, {
        t: entry.t, id: entry.id, op: merged, cat: TYPE_CATEGORY[entry.t], by: typeof record.by === 'string' ? record.by : null,
        name: text(entry.name, NAME_CHARS) || earlier?.name || '',
        fields: [...new Set([...(earlier?.fields ?? []), ...fields.filter((field) => !NOISE.has(field))])].slice(0, 10),
      });
    }
  }
  return [...byKey.values()];
}

export function changeNote({ space, worker, title, origin, items, rev, at }) {
  return {
    id: `c-${space}-${rev}`, kind: 'change', at,
    trip: { id: space, title: text(title, 200), url: tripUrl(origin, worker, space) },
    items: items.slice(-MAX_ITEMS), more: Math.max(0, items.length - MAX_ITEMS),
  };
}

export function reminderNote(item, { origin, now }) {
  return {
    id: `r-${item.id}`, kind: 'reminder', at: item.at ?? now,
    trip: { id: item.space, title: text(item.trip, 200), url: tripUrl(origin, item.w, item.space) },
    reminder: {
      kind: item.kind, date: item.date, days: Number.isInteger(item.days) ? item.days : null, name: text(item.name, NAME_CHARS),
      ...(item.text ? { text: text(item.text, 200) } : {}), ...(Number.isInteger(item.count) ? { count: item.count } : {}),
    },
    items: [], more: 0,
  };
}

export const testNote = (id, at) => ({ id: `t-${id}`, kind: 'test', at, trip: null, items: [], more: 0 });

/** The category a note is filtered by. */
export const noteCategories = (note) => (note.kind === 'change' ? [...new Set(note.items.map((item) => item.cat))] : note.kind === 'reminder' ? ['reminders'] : []);

/** A copy of `note` with only the items in `categories`, or null when nothing is left. */
export function narrowNote(note, categories) {
  if (note.kind !== 'change') return note;
  const items = note.items.filter((item) => categories.includes(item.cat));
  return items.length ? { ...note, items, more: items.length === note.items.length ? note.more : 0 } : null;
}

function dateLabel(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  try { return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)); } catch { return date; }
}

/** `{title, lines, tag}` in words, for every channel. */
export function describe(note, t) {
  const trip = note.trip?.title || t('notifyOut.untitled');
  if (note.kind === 'test') return { title: t('notifyOut.testTitle'), lines: [t('notifyOut.testBody')], tag: 'white_check_mark' };
  if (note.kind === 'reminder') {
    const { kind, days, date, name, count } = note.reminder;
    let line;
    if (kind === 'overdue') line = t(count === 1 ? 'notifyOut.overdueOne' : 'notifyOut.overdue', { count: count ?? 0 });
    else if (note.reminder.text) line = note.reminder.text;
    else if (kind === 'todo') line = t('notifyOut.todoDue', { date: dateLabel(date), name: name || t('notifyOut.type.todo') });
    else if (days === 0) line = t('notifyOut.tripToday', { trip });
    else if (days === 1) line = t('notifyOut.tripTomorrow', { trip });
    else line = t('notifyOut.tripIn', { trip, days, date: dateLabel(date) });
    return { title: trip, lines: [line], tag: 'alarm_clock' };
  }
  const lines = note.items.slice(-SHOWN).map((item) => {
    const who = text(item.who, NAME_CHARS) || t('notifyOut.someone');
    if (item.t === 'msg') return t('notifyOut.chat', { who, text: item.name });
    const type = t(`notifyOut.type.${item.t}`);
    return t(item.name ? `notifyOut.${item.op}Named` : `notifyOut.${item.op}`, { who, type, name: item.name });
  });
  const rest = note.items.length - Math.min(SHOWN, note.items.length) + note.more;
  if (rest > 0) lines.push(t('notifyOut.more', { count: rest }));
  return { title: trip, lines, tag: 'luggage' };
}

const slackEscape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const discordEscape = (value) => value.replace(/([\\*_~`|>#[\]()-])/g, '\\$1').replace(/@/g, '@\u200b');

/** The JSON body of a webhook delivery in `format` (`json`, `slack` or `discord`). */
export function webhookBody(note, format, t) {
  const { title, lines } = describe(note, t);
  const url = note.trip?.url ?? null;
  if (format === 'slack') {
    const link = url ? `\n<${url}|${slackEscape(t('notifyOut.open'))}>` : '';
    return { text: clip(`*${slackEscape(title)}*\n${lines.map(slackEscape).join('\n')}${link}`, 3000) };
  }
  if (format === 'discord') {
    const link = url ? `\n${url}` : '';
    return { content: clip(`**${discordEscape(title)}**\n${lines.map(discordEscape).join('\n')}`, 2000 - link.length) + link, allowed_mentions: { parse: [] } };
  }
  return {
    v: 1, type: note.kind === 'change' ? 'trip.change' : note.kind, id: note.id, at: new Date(note.at).toISOString(),
    trip: note.trip, title, text: lines.join('\n'),
    ...(note.kind === 'change' ? { changes: note.items.map(({ t: type, id, op, name, fields, who }) => ({ type, id, action: op, name, fields, by: who || null })), more: note.more } : {}),
    ...(note.kind === 'reminder' ? { reminder: note.reminder } : {}),
  };
}

/** The JSON publish body for ntfy (`POST <server>/`). */
export function ntfyBody(note, { topic, priority }, t) {
  const { title, lines, tag } = describe(note, t);
  return {
    topic, title: clip(title, 250), message: clip(lines.join('\n'), 4000), priority, tags: [tag],
    ...(note.trip?.url ? { click: note.trip.url } : {}),
  };
}

const html = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** One email for several notifications, grouped by trip. */
export function digestEmail(notes, t) {
  const groups = new Map();
  for (const note of notes) {
    const key = note.trip?.id ?? '';
    if (!groups.has(key)) groups.set(key, { title: describe(note, t).title, url: note.trip?.url ?? null, lines: [] });
    groups.get(key).lines.push(...describe(note, t).lines);
  }
  const count = notes.length;
  const subject = clip(count === 1 ? t('notifyOut.digestSubjectOne', { trip: [...groups.values()][0].title }) : t('notifyOut.digestSubject', { count }), 200);
  const textParts = [];
  const htmlParts = [];
  for (const group of groups.values()) {
    textParts.push([group.title, ...group.lines.map((line) => `- ${line}`), group.url ? `${t('notifyOut.open')}: ${group.url}` : ''].filter(Boolean).join('\n'));
    htmlParts.push(`<h3>${html(group.title)}</h3><ul>${group.lines.map((line) => `<li>${html(line)}</li>`).join('')}</ul>${group.url ? `<p><a href="${html(group.url)}">${html(t('notifyOut.open'))}</a></p>` : ''}`);
  }
  const footer = t('notifyOut.digestFooter');
  return {
    subject,
    text: `${textParts.join('\n\n')}\n\n${footer}\n`,
    html: `<!doctype html><html><body>${htmlParts.join('')}<p><small>${html(footer)}</small></p></body></html>`,
  };
}

/** A compact copy of a note for the retry and digest keys. */
export function storedNote(note) {
  return { id: note.id, kind: note.kind, at: note.at, trip: note.trip, items: note.items, more: note.more, ...(note.reminder ? { reminder: note.reminder } : {}) };
}

/** A stored note read back from KV, or null when it does not look like one. */
export function readNote(value) {
  if (!plain(value) || typeof value.id !== 'string' || !['change', 'reminder', 'test'].includes(value.kind) || !Number.isFinite(value.at)) return null;
  const items = Array.isArray(value.items) ? value.items.filter((item) => plain(item) && Object.hasOwn(TYPE_CATEGORY, item.t)
    && ['add', 'change', 'remove'].includes(item.op)).slice(0, MAX_ITEMS).map((item) => ({
    t: item.t, id: text(item.id, 64), op: item.op, cat: TYPE_CATEGORY[item.t], by: typeof item.by === 'string' ? item.by.slice(0, 64) : null,
    who: text(item.who, NAME_CHARS), name: text(item.name, NAME_CHARS), fields: Array.isArray(item.fields) ? item.fields.filter((field) => typeof field === 'string').slice(0, 10) : [],
  })) : [];
  const trip = plain(value.trip) ? { id: text(value.trip.id, 64), title: text(value.trip.title, 200), url: typeof value.trip.url === 'string' && /^https:\/\//.test(value.trip.url) ? value.trip.url.slice(0, 300) : null } : null;
  const input = plain(value.reminder) ? value.reminder : null;
  const reminder = input ? {
    kind: REMINDER_KINDS.includes(input.kind) ? input.kind : 'trip', date: text(input.date, 10), days: Number.isInteger(input.days) ? input.days : null, name: text(input.name, NAME_CHARS),
    ...(input.text ? { text: text(input.text, 200) } : {}), ...(Number.isInteger(input.count) ? { count: input.count } : {}),
  } : undefined;
  if (value.kind === 'reminder' && !reminder) return null;
  return { id: value.id.slice(0, 120), kind: value.kind, at: value.at, trip, items, more: Number.isInteger(value.more) && value.more > 0 ? value.more : 0, ...(reminder ? { reminder } : {}) };
}
