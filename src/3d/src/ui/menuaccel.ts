// Menu accelerator letters (pure): each entry of a menu gets one letter of its label, unique in
// the menu, that picks it from the keyboard. Word initials are preferred, then any other letter.

/** Accelerator character index per entry (entries without a free letter get none). */
export function menuAccelerators(labels: (string | null)[]): (number | undefined)[] {
  const out: (number | undefined)[] = labels.map(() => undefined);
  const used = new Set<string>();
  const ok = (c: string) => /[a-z0-9]/i.test(c) && !used.has(c.toLowerCase());
  // pass 1: the first letter of a word
  labels.forEach((l, i) => {
    if (!l) return;
    for (const m of l.matchAll(/(^|[\s\-/(&])([a-z0-9])/gi)) {
      const at = (m.index ?? 0) + m[1].length;
      if (ok(l[at])) {
        out[i] = at;
        used.add(l[at].toLowerCase());
        return;
      }
    }
  });
  // pass 2: any letter of the label
  labels.forEach((l, i) => {
    if (!l || out[i] !== undefined) return;
    for (let at = 0; at < l.length; at++) {
      if (!ok(l[at])) continue;
      out[i] = at;
      used.add(l[at].toLowerCase());
      return;
    }
  });
  return out;
}
