// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { validateEntity } from '../../src/shared/schema/index.js';
import { LARGE, largeTrip } from '../../dev/fixtures/large-trip.js';
import { loadLargeTrip } from '../../dev/fixtures/harness.js';
import { createHarness } from './harness.js';

describe('big-trip fixture (H2)', () => {
  it('generates valid entities in the documented amounts, deterministically', () => {
    const fixture = largeTrip();
    expect(largeTrip().ops.map((op) => op.id)).toEqual(fixture.ops.map((op) => op.id));
    const count = (type) => fixture.ops.filter((op) => op.t === type).length;
    expect([count('day'), count('place'), count('visit'), count('res'), count('exp'), count('pack')])
      .toEqual([LARGE.days, LARGE.places, LARGE.visits, LARGE.bookings, LARGE.expenses, LARGE.packing]);
    expect([fixture.messages.length, fixture.files.length]).toEqual([LARGE.messages, LARGE.files]);
    validateEntity('trip', 'meta', fixture.meta);
    for (const op of fixture.ops) validateEntity('trip', op.t, op.put);
    for (const message of fixture.messages) validateEntity('trip', 'msg', message.put);
    for (const file of fixture.files) validateEntity('trip', 'file', file.put);
  });

  it('seeds through the worker harness with six members', async () => {
    const h = await createHarness({ shareHandles: true });
    const { space } = await loadLargeTrip(h);
    const keys = Object.keys(h.kv());
    const stored = (pattern) => keys.filter((key) => key.startsWith(`shared:${space}:${pattern}`)).length;
    expect(stored('e:member:')).toBe(LARGE.members);
    expect(stored('e:place:')).toBe(LARGE.places);
    expect(stored('e:file:')).toBe(LARGE.files);
    expect(stored('m:')).toBe(LARGE.messages);
  }, 30_000);
});
