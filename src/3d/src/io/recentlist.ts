// Recently used files list (pure helpers, shared by the session store and tests).
export interface RecentEntry {
  name: string;
  time: number;
  size: number;
}

export const MAX_RECENT = 10;

/** Insert or move an entry to the front of a recent list; returns the names that fell off. */
export function bumpRecent(list: RecentEntry[], e: RecentEntry, max = MAX_RECENT): { list: RecentEntry[]; dropped: string[] } {
  const rest = list.filter((x) => x.name !== e.name);
  const next = [e, ...rest];
  return { list: next.slice(0, max), dropped: next.slice(max).map((x) => x.name) };
}
