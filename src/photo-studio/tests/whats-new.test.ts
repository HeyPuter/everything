import { describe, expect, it } from 'vitest';
import { WHATS_NEW } from '../src/features/help/whats-new-data';
import { tutorialInfo } from '../src/features/help/tutorial-list';
import { hasIcon } from '../src/app/icons';

describe("What's New data", () => {
  it('has unique entries with written descriptions', () => {
    const ids = WHATS_NEW.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of WHATS_NEW) {
      expect(w.title.length).toBeGreaterThan(3);
      expect(w.text.length).toBeGreaterThan(30);
      expect(w.text).not.toMatch(/\.\.\./);
      expect(w.release.length).toBeGreaterThan(0);
    }
  });

  it('points every action at a command, tool, panel or tutorial ID', () => {
    for (const w of WHATS_NEW) {
      const a = w.action;
      if (!a) continue;
      if ('tutorial' in a) expect(tutorialInfo(a.tutorial), w.id).toBeTruthy();
      else if ('commands' in a) {
        expect(a.commands.length).toBeGreaterThan(0);
        for (const c of a.commands) expect(c).toMatch(/^[a-z]+\.[a-z0-9.-]+$/);
      } else if ('tool' in a) expect(a.tool).toMatch(/^[a-z][a-z0-9-]*$/);
      else expect(a.panel).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('lists the newest release first', () => {
    expect(WHATS_NEW[0].release).toBe('October 2026');
    const releases = WHATS_NEW.map((w) => w.release);
    // Entries of one release are grouped together.
    const firstIndex = new Map<string, number>();
    releases.forEach((r, i) => !firstIndex.has(r) && firstIndex.set(r, i));
    for (const [i, r] of releases.entries()) expect(releases.slice(firstIndex.get(r)!, i + 1).every((x) => x === r)).toBe(true);
  });

  it('uses icons that exist', () => {
    for (const name of ['sparkles', 'play', 'clock', 'x', 'check']) expect(hasIcon(name), name).toBe(true);
  });
});
