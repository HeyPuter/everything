/** Runs `task(item, index)` over `items` with at most `limit` at once; resolves the results in input order. */
export async function pool(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => { while (next < items.length) { const index = next++; results[index] = await task(items[index], index); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
