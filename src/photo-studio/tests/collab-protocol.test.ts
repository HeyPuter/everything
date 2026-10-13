// Collaboration building blocks: links, signatures, peer topology, person
// colors, tile codec, and the comment model with its authorship rules.
import { describe, expect, it } from 'vitest';
import { colorFor, decode, encode, hash, keyPair, parseLink, PERSON_COLORS, shareLink, sign, topology, verify, workerURL, initials } from '../src/collab/protocol';
import { packAsset, unpackAsset } from '../src/collab/asset-codec';
import { checkCommentChange, filterThreads, mentions, newMessage, newThread, normalizeAnchor, validateComments, type CommentThread } from '../src/collab/comments';
import { LocalComments } from '../src/collab/comment-store';
import { deflate } from 'pako';

const alice = { id: 'u-alice', name: 'alice' },
  bob = { id: 'u-bob', name: 'bob' };

describe('collaboration protocol', () => {
  it('builds and parses invitation and review links in the URL hash only', () => {
    const link = shareLink('https://photo.example/app?x=1', { server: 'https://photo-abc.puter.work', room: 'room1', token: 'a'.repeat(72), review: true });
    const url = new URL(link);
    expect(url.search).toBe('?x=1');
    expect(parseLink(link)).toEqual({ server: 'https://photo-abc.puter.work', room: 'room1', token: 'a'.repeat(72), review: true });
    expect(parseLink('https://photo.example/#other=1')).toBeNull();
    expect(() => parseLink('https://photo.example/#ps-room=r&ps-server=https://evil.example')).toThrow();
    expect(() => workerURL('https://x.puter.work/path')).toThrow();
    expect(() => parseLink('https://p/#ps-room=r&ps-server=https://a.puter.work&ps-invite=%3Cscript%3E')).toThrow();
  });

  it('signs and verifies, and rejects tampering', async () => {
    const keys = await keyPair();
    const s = await sign(keys.privateKey, { a: 1 });
    expect(await verify(keys.publicKey, { a: 1 }, s)).toBe(true);
    expect(await verify(keys.publicKey, { a: 2 }, s)).toBe(false);
    expect(await verify(keys.publicKey, { a: 1 }, 'garbage')).toBe(false);
    expect(decode(encode(new Uint8Array([1, 2, 255])))).toEqual(new Uint8Array([1, 2, 255]));
    expect(() => decode('a')).toThrow();
  });

  it('forms a full mesh for small rooms and relay groups for large ones', () => {
    const small = topology(Array.from({ length: 5 }, (_, i) => ({ session: `s${i}` })));
    expect(small.edges.get('s0')!.size).toBe(4);
    const large = topology(Array.from({ length: 70 }, (_, i) => ({ session: `s${String(i).padStart(2, '0')}` })));
    expect(large.relays.size).toBe(6);
    // Ordinary members link only to their group's two relays.
    expect(large.edges.get('s10')!.size).toBe(2);
  });

  it('gives people stable colors that keep white text readable', () => {
    expect(colorFor('x')).toBe(colorFor('x'));
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    for (const c of PERSON_COLORS) expect(1.05 / (lum(c) + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(initials('jane doe')).toBe('JD');
    expect(initials('')).toBe('?');
  });

  it('packs tiles by content and refuses mismatches and expansion bombs', async () => {
    const bytes = new Uint8Array(256 * 256 * 4).fill(7);
    const h = await hash(bytes);
    expect(await unpackAsset(packAsset(bytes), h)).toEqual(bytes);
    await expect(unpackAsset(packAsset(bytes), 'f'.repeat(64))).rejects.toThrow();
    const bomb = encode(deflate(new Uint8Array(50_000_000)));
    await expect(unpackAsset(bomb, h)).rejects.toThrow();
  });
});

describe('comment model', () => {
  it('validates threads and normalizes anchors', () => {
    const t = newThread({ x: 10.4, y: 5, width: -40, height: 30 }, alice, 'Hi');
    expect(t.anchor).toEqual({ x: -30, y: 5, width: 40, height: 30 });
    expect(normalizeAnchor({ x: 1, y: 2, width: 2, height: 2 })).toEqual({ x: 1, y: 2 });
    expect(validateComments([t])).toEqual([t]);
    expect(() => validateComments([{ ...t, anchor: { x: NaN, y: 0 } }])).toThrow();
    expect(() => validateComments([t, t])).toThrow();
    expect(() => validateComments([{ ...t, messages: [{ ...t.messages[0], text: 'x'.repeat(5000) }] }])).toThrow();
  });

  it('finds mentions and filters threads', () => {
    expect(mentions('Hey @bob and @alice.smith, not me@example.com')).toEqual(['bob', 'alice.smith']);
    const a = newThread({ x: 0, y: 0 }, alice, 'one');
    const b = { ...newThread({ x: 0, y: 0 }, bob, 'two @alice'), resolved: { by: bob, at: 1 } };
    const c = { ...newThread({ x: 0, y: 0 }, bob, 'gone'), deleted: true };
    expect(filterThreads([a, b, c], 'open')).toEqual([a]);
    expect(filterThreads([a, b, c], 'resolved')).toEqual([b]);
    expect(filterThreads([a, b, c], 'mine', alice)).toEqual([a, b]);
    expect(filterThreads([a, b, c], 'mine', bob)).toEqual([b]);
    expect(filterThreads([a, b, c], 'all')).toEqual([a, b]);
  });

  it('allows only authorship-preserving changes', () => {
    const t = newThread({ x: 0, y: 0 }, alice, 'Original');
    const before: CommentThread[] = [t];
    const me = { uuid: 'u-bob' };
    // A reply of one's own, and resolving in one's own name: accepted.
    expect(checkCommentChange(before, [{ ...t, messages: [...t.messages, newMessage(bob, 'Reply')] }], me, 'editor')).toBeNull();
    expect(checkCommentChange(before, [{ ...t, resolved: { by: bob, at: 5 } }], me, 'commenter')).toBeNull();
    // Editing or removing someone else's words, or forging authors: refused.
    expect(checkCommentChange(before, [{ ...t, messages: [{ ...t.messages[0], text: 'Changed' }] }], me, 'editor')).toMatch(/author/);
    expect(checkCommentChange(before, [{ ...t, messages: [{ ...t.messages[0], deleted: true }] }], me, 'editor')).toMatch(/author/);
    expect(checkCommentChange(before, [], me, 'editor')).toMatch(/removed/);
    expect(checkCommentChange(before, [t, newThread({ x: 1, y: 1 }, alice, 'Forged')], me, 'editor')).toMatch(/own/);
    expect(checkCommentChange(before, [{ ...t, resolved: { by: alice, at: 5 } }], me, 'editor')).toMatch(/own name/);
    // Owners may remove anyone's comment (a soft removal).
    expect(checkCommentChange(before, [{ ...t, deleted: true }], me, 'owner')).toBeNull();
  });

  it('keeps local comments with replies, edits, resolution and removal', () => {
    let changes = 0;
    const store = new LocalComments([], () => alice, () => changes++);
    const t = store.add({ x: 5, y: 6 }, 'First');
    store.reply(t.id, 'Second');
    store.edit(t.id, store.threads()[0].messages[1].id, 'Second, edited');
    store.resolve(t.id, true);
    store.move(t.id, { x: 50, y: 60, width: 20, height: 10 });
    const thread = store.threads()[0];
    expect(thread.messages.map((m) => m.text)).toEqual(['First', 'Second, edited']);
    expect(thread.messages[1].edited).toBeGreaterThan(0);
    expect(thread.resolved?.by).toEqual(alice);
    expect(thread.anchor).toEqual({ x: 50, y: 60, width: 20, height: 10 });
    store.remove(t.id, thread.messages[1].id);
    expect(store.threads()[0].messages).toHaveLength(1);
    store.remove(t.id);
    expect(store.threads()).toEqual([]);
    expect(changes).toBe(7);
    expect(store.version).toBe(7);
  });
});
