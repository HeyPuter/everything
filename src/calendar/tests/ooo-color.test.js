/**
 * Out-of-office blocks must honor the color the editor lets you pick.
 *
 * Regression: the "away" look (a muted, hatched fill) was built from a
 * hardcoded grey, so an OOO block rendered identically whatever swatch you
 * chose — even though the color WAS saved, and the details card and the
 * sidebar category filter both showed it. The color has to reach the DOM in
 * every view, and the stylesheet has to build the hatch out of it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderMonth } from '../src/js/views/month.js';
import { renderAgenda } from '../src/js/views/agenda.js';
import { colorHex } from '../src/js/colors.js';

const DAY = new Date(2026, 7, 19); // Wed Aug 19 2026
const at = (h) => new Date(2026, 7, 19, h, 0).getTime();

const oooEvent = {
  id: 'ooo-1',
  title: 'Away',
  start: at(12),
  end: at(13),
  allDay: false,
  ooo: true,
  color: 'red',
};

function makeCtx(events) {
  return {
    store: {
      getEventsInRange: () => events,
      getTasksInRange: () => [],
      getEvent: (id) => events.find((e) => e.id === id) || null,
    },
    settings: { weekStartsOn: 0, hour12: true },
    cursor: DAY,
    now: DAY,
    actions: {},
  };
}

describe('out-of-office color reaches the DOM', () => {
  it('month chip carries the picked color, not a fixed grey', () => {
    const { node } = renderMonth(makeCtx([oooEvent]));
    const chip = node.querySelector('.chip.is-ooo');
    expect(chip).toBeTruthy();
    expect(chip.style.getPropertyValue('--chip-color')).toBe(colorHex('red'));
    // The graphite default must not be what a red block renders with.
    expect(chip.style.getPropertyValue('--chip-color')).not.toBe(colorHex('graphite'));
  });

  it('agenda row colors the plane icon that stands in for the color dot', () => {
    const { node } = renderAgenda(makeCtx([oooEvent]));
    const row = node.querySelector('.agenda__event.is-ooo');
    expect(row).toBeTruthy();
    // An away row has no dot — the plane replaces it, so the plane must carry
    // the color or the row shows none at all.
    expect(row.querySelector('.agenda__event-dot')).toBeNull();
    const icon = row.querySelector('.agenda__event-icon');
    expect(icon.style.getPropertyValue('--chip-color')).toBe(colorHex('red'));
  });
});

describe('out-of-office stylesheet builds the away look from that color', () => {
  // Normalize CRLF → LF so these selectors still match when git checks the
  // stylesheet out with core.autocrlf=true (Windows). Index and CI keep LF;
  // without this, indexOf/toMatch against "\n" find nothing and the suite fails
  // even though the rules themselves are fine.
  const css = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/styles/views.css'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  // The shared rule that paints the hatched "away" fill, up to its closing brace.
  const rule = css.slice(
    css.indexOf('.chip.is-ooo,\n.allday-chip.is-ooo,\n.tevent.is-ooo {'),
  );
  const block = rule.slice(0, rule.indexOf('\n}'));

  it('derives the fill and the stripes from the event color', () => {
    expect(block).toContain('--ooo-color');
    // Both the ground and the hatch, or a red block reads grey with red stripes.
    expect(block).toMatch(/background-color:\s*color-mix\([^;]*--ooo-color/);
    expect(block).toMatch(/repeating-linear-gradient\([^;]*--ooo-color/s);
  });

  it('has no hardcoded grey left in the fill', () => {
    expect(block).not.toMatch(/rgba\(120,\s*130,\s*145/);
    expect(block).not.toMatch(/background-color:\s*var\(--surface-2\)\s*;/);
  });

  it('aliases --ooo-color from whichever name the view injects', () => {
    // Month/all-day chips inject --chip-color; the time grid injects --ev-fill.
    expect(css).toMatch(/\.chip\.is-ooo,\n\.allday-chip\.is-ooo \{\n\s*--ooo-color: var\(--chip-color\);/);
    expect(css).toMatch(/\.tevent\.is-ooo \{\n\s*--ooo-color: var\(--ev-fill\);/);
  });
});
