import { describe, expect, it } from 'vitest';
import { slotTools } from '../src/app/toolbar-layout';

const t = (id: string, group: string) => ({ id, group });

describe('tool order inside a toolbar slot', () => {
  it('puts the most used tool of a slot first, whatever the registration order', () => {
    const tools = [
      t('magic-wand', 'select'),
      t('object-selection', 'select'),
      t('quick-selection', 'select'),
      t('bucket', 'fill'),
      t('gradient', 'fill'),
    ];
    expect(slotTools(tools, 'select', {}).map((x) => x.id)).toEqual([
      'object-selection',
      'quick-selection',
      'magic-wand',
    ]);
    expect(slotTools(tools, 'fill', {}).map((x) => x.id)).toEqual(['gradient', 'bucket']);
  });
  it('keeps unlisted tools and tools moved in from other slots after the listed ones', () => {
    const tools = [
      t('lasso', 'lasso'),
      t('new-tool', 'fill'),
      t('bucket', 'fill'),
      t('gradient', 'fill'),
    ];
    const layout = { assign: { lasso: 'fill' } };
    expect(slotTools(tools, 'fill', layout).map((x) => x.id)).toEqual([
      'gradient',
      'bucket',
      'lasso',
      'new-tool',
    ]);
  });
  it('leaves slots without an order as registered', () => {
    const tools = [t('b', 'pen'), t('a', 'pen')];
    expect(slotTools(tools, 'pen', {}).map((x) => x.id)).toEqual(['b', 'a']);
  });
});
