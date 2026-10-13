// Comments of local documents are saved in .photo projects (outside Undo)
// and validated when a project opens.
import { describe, expect, it } from 'vitest';
import { newDocument } from '../src/model/document';
import { Assets } from '../src/model/assets';
import { deserialize, projectExtras, serialize, validateDocument } from '../src/model/serialization';
import { newThread } from '../src/collab/comments';

describe('comments in projects', () => {
  it('saves the session’s comments with its own document only', async () => {
    const assets = new Assets();
    const doc = newDocument(64, 64, 'Commented');
    const thread = newThread({ x: 5, y: 6, width: 10, height: 12 }, { id: 'local:me', name: 'Me' }, 'Brighter here');
    projectExtras.set(assets, (d) => (d.id === doc.id ? { comments: [thread] } : {}));
    const loaded = await deserialize(await serialize(doc, assets));
    expect((loaded.document as { comments?: unknown }).comments).toEqual([thread]);
    // A document made from this one (embedded contents) does not take them along.
    const other = { ...newDocument(32, 32, 'Other') };
    const loadedOther = await deserialize(await serialize(other, assets));
    expect((loadedOther.document as { comments?: unknown }).comments).toBeUndefined();
  });

  it('refuses malformed comments in a project', () => {
    const doc = { ...newDocument(10, 10), comments: [{ id: 'x', anchor: { x: 'a', y: 0 } }] };
    expect(() => validateDocument(doc)).toThrow(/comment/i);
  });
});
