import { describe, it, expect } from 'vitest';
import { createSearchIndex } from '../src/lib/search.js';
import { memoryStorage } from '../src/lib/readstate.js';
import { mergeContacts, rankContacts } from '../src/lib/contacts.js';
import { mailFilename } from '../src/lib/mailbox.js';

const names = new Map();
const file = (key, seconds) => {
  if (!names.has(key)) names.set(key, mailFilename(key, new Date(seconds * 1000)));
  return names.get(key);
};
const msg = (key, from, to, seconds) => ({
  name: file(key, seconds), from: { name: '', email: from }, to: [{ name: '', email: to }], snippet: '',
  hasAttachments: false, date: new Date(seconds * 1000), messageId: `<${name}@x>`, references: [],
});

/**
 * The header index holds a few thousand entries and trims past that. What it
 * keeps is what is read again first: the newest mail, and the mail this
 * account sent, which the address book ranks on.
 */
describe('header index trimming', () => {
  it('keeps the newest inbox rows and the Sent history after a search indexes a big inbox', () => {
    const index = createSearchIndex('u', memoryStorage());
    // Sent folder browsed: 200 messages to a colleague.
    for (let i = 0; i < 200; i++) {
      index.add(msg(`s${i}`, 'me@puter.com', 'ana@corp.example', 1.79e9 + i), { outgoing: true });
    }
    // The inbox list read its newest page.
    for (let i = 0; i < 60; i++) index.add(msg(`new${i}`, `n${i}@news.example`, 'me@puter.com', 1.79e9 + i));
    // A search over the 4,500-message inbox reads the rest, newest to oldest.
    for (let i = 0; i < 4500; i++) index.add(msg(`old${i}`, `o${i}@list.example`, 'me@puter.com', 1.7e9 - i));
    // The newest rows are what the list shows first after a reload.
    expect(index.has(names.get('new0'))).toBe(true);
    expect(index.has(names.get('new59'))).toBe(true);
    // And who the account writes to is the strongest completion signal.
    const top = rankContacts(mergeContacts(index.addresses()), 'a');
    expect(top[0]?.email).toBe('ana@corp.example');
  });

  it('keeps room for received mail however much was sent', () => {
    const index = createSearchIndex('u', memoryStorage(), { cap: 100 });
    for (let i = 0; i < 300; i++) {
      index.add(msg(`sent${i}`, 'me@puter.com', 'ana@corp.example', 1.6e9 + i), { outgoing: true });
    }
    for (let i = 0; i < 40; i++) index.add(msg(`got${i}`, `g${i}@x.example`, 'me@puter.com', 1.5e9 + i));
    expect(index.has(names.get('got39'))).toBe(true);
  });
});
