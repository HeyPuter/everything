// Custom properties (ID properties) of imported data-blocks: numbers, booleans, text and short
// number arrays become entries of the data-block's `custom` record.
import type { BStruct } from './reader';
import type { Ctx } from './context';

/** Value of one property, or undefined for kinds that are not imported (groups, ID pointers). */
function value(p: BStruct, ctx: Ctx): unknown {
  const type = p.num('type');
  const data = p.sub('data');
  if (!data) return undefined;
  const off = data.offset + (data.field('val')?.offset ?? 0);
  switch (type) {
    case 0: {
      // text (len counts the closing zero)
      const s = ctx.f.cstringAt(data.ptr('pointer'), Math.max(1, p.num('len')), p.block);
      return s ?? undefined;
    }
    case 1:
      return data.num('val');
    case 2:
      return ctx.f.dv.getFloat32(off, ctx.f.littleEndian);
    case 8:
      return ctx.f.dv.getFloat64(off, ctx.f.littleEndian);
    case 10:
      return data.num('val') !== 0;
    case 5: {
      const len = p.num('len');
      const sub = p.num('subtype');
      if (len < 1 || len > 4096) return undefined;
      const ptr = data.ptr('pointer');
      if (sub === 8) {
        // doubles: read the bytes and decode them in the file's byte order
        const b = ctx.f.bytesAt(ptr, len * 8, p.block);
        if (!b) return undefined;
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        return Array.from({ length: len }, (_, i) => dv.getFloat64(i * 8, ctx.f.littleEndian));
      }
      if (sub === 10) {
        const b = ctx.f.bytesAt(ptr, len, p.block);
        return b ? Array.from(b, (x) => x !== 0) : undefined;
      }
      const arr = sub === 2 ? ctx.f.float32(ptr, len, p.block) : sub === 1 ? ctx.f.int32(ptr, len, p.block) : null;
      return arr ? Array.from(arr) : undefined;
    }
  }
  return undefined;
}

/** The custom properties of an ID (its `properties` group); null when it has none. */
export function importIdProps(id: BStruct | null, ctx: Ctx): { values: Record<string, unknown>; skipped: number } | null {
  const group = id?.ref('properties');
  const items = group?.sub('data')?.list('group', 10000) ?? [];
  if (!items.length) return null;
  const values: Record<string, unknown> = {};
  let skipped = 0;
  for (const p of items) {
    const name = p.str('name');
    // properties scripts keep for their own bookkeeping start with an underscore
    if (!name) continue;
    const v = value(p, ctx);
    if (v === undefined) skipped++;
    else values[name] = v;
  }
  return { values, skipped };
}
