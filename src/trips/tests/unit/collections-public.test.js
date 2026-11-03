import { describe, expect, it } from 'vitest';
import { cleanCollectionProjection } from '../../src/views/collections/public.js';

const saved = (fields) => ({ t: 'saved', id: '1m5sabcdefgh0001', name: 'Prado', status: 'want', order: 'V', ...fields });

describe('cleanCollectionProjection', () => {
  it('keeps schema-valid saved places and labels only', () => {
    const result = cleanCollectionProjection({
      kind: 'collection',
      meta: { name: 'Madrid', desc: 'Museums', cover: { url: 'javascript:alert(1)' } },
      ents: [
        saved({ labels: ['1m5sabcdefgh0002'] }),
        { t: 'label', id: '1m5sabcdefgh0002', name: 'Art', order: 'V' },
        saved({ id: '1m5sabcdefgh0003', status: 'nope' }),
        { t: 'place', id: '1m5sabcdefgh0004', name: 'Trip place' },
        { t: 'member', id: '00000000-0000-4000-8000-000000000001', name: 'alice', role: 'owner' },
        saved({ id: 'not-an-id' }),
      ],
    });
    expect(result.meta).toMatchObject({ name: 'Madrid', desc: 'Museums' });
    expect(result.meta.cover).toBeUndefined();
    expect(result.saved.map((item) => item.id)).toEqual(['1m5sabcdefgh0001']);
    expect([...result.labels.keys()]).toEqual(['1m5sabcdefgh0002']);
  });

  it('accepts an https cover and survives junk', () => {
    expect(cleanCollectionProjection({ meta: { name: 'X', cover: { url: 'https://example.com/a.jpg', credit: 'Me' } } }).meta.cover).toEqual({ url: 'https://example.com/a.jpg', credit: 'Me' });
    expect(cleanCollectionProjection(null)).toMatchObject({ meta: { name: '' }, saved: [] });
  });
});
