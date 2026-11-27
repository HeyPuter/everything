import { describe, expect, it } from 'vitest';
import { isTwoOfClubs } from '../src/game/cards.js';
import {
  acknowledgeTrick,
  advanceAi,
  createMatch,
  legalCardsFor,
  playCard,
  selectHumanPass,
  startHand,
} from '../src/game/engine.js';

/** Deterministic RNG cycling through fixed values. */
function rngFrom(seq) {
  let i = 0;
  return () => {
    const v = seq[i % seq.length];
    i += 1;
    return v;
  };
}

describe('engine', () => {
  it('starts in passing for hand 0 (pass left) and AI fills seats 1–3', () => {
    const game = createMatch({ random: rngFrom([0.1, 0.2, 0.3, 0.4, 0.5]) });
    expect(game.passDir).toBe('left');
    expect(game.phase).toBe('passing');
    expect(game.passSelections[1]?.length).toBe(3);
    expect(game.passSelections[2]?.length).toBe(3);
    expect(game.passSelections[3]?.length).toBe(3);
    expect(game.passSelections[0]).toBeNull();
  });

  it('resolves a human pass and starts play with the 2♣ holder', () => {
    const game = createMatch({ random: rngFrom([0.11, 0.22, 0.33, 0.44]) });
    const ids = game.hands[0].slice(0, 3).map((c) => c.id);
    expect(selectHumanPass(game, ids)).toBe(true);
    expect(game.phase).toBe('play');
    expect(game.hands.every((h) => h.length === 13)).toBe(true);
    const holder = game.hands.findIndex((h) => h.some(isTwoOfClubs));
    expect(holder).toBe(game.leader);
  });

  it('rejects illegal human plays and accepts a legal one on a hold hand', () => {
    const game = createMatch({ random: () => 0.42 });
    game.handIndex = 3;
    startHand(game, () => 0.42);
    expect(game.passDir).toBe('hold');
    expect(game.phase).toBe('play');

    let guard = 0;
    while (game.toPlay !== 0 && game.phase === 'play' && guard < 8) {
      guard += 1;
      advanceAi(game);
      if (game.phase === 'trick_end') acknowledgeTrick(game);
    }

    if (game.phase === 'play' && game.toPlay === 0) {
      const legal = legalCardsFor(game, 0);
      expect(legal.length).toBeGreaterThan(0);
      const illegal = game.hands[0].find((c) => !legal.some((l) => l.id === c.id));
      if (illegal) expect(playCard(game, illegal.id, 0)).toBe(false);
      expect(playCard(game, legal[0].id, 0)).toBe(true);
    }
  });

  it('plays a full hold hand to completion with AI-assisted human', () => {
    const game = createMatch({ random: () => 0.37, threshold: 1000 });
    game.handIndex = 3;
    startHand(game, () => 0.37);
    expect(game.passDir).toBe('hold');

    let guard = 0;
    while (game.phase !== 'hand_end' && game.phase !== 'match_end' && guard < 200) {
      guard += 1;
      if (game.phase === 'play') {
        if (game.toPlay === 0) {
          const legal = legalCardsFor(game, 0);
          expect(legal.length).toBeGreaterThan(0);
          playCard(game, legal[0].id, 0);
        } else {
          advanceAi(game);
        }
      }
      if (game.phase === 'trick_end') acknowledgeTrick(game);
    }
    expect(['hand_end', 'match_end']).toContain(game.phase);
    expect(game.lastHandScores?.reduce((a, b) => a + b, 0)).toBe(26);
  });
});
