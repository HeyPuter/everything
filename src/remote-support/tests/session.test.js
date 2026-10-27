import { describe, expect, it } from 'vitest';
import {
  connectionSummary,
  createSession,
  denyConsent,
  enableControl,
  endSession,
  grantConsent,
  inviteGuest,
  mockScreenFrame,
} from '../src/engine/session.js';

describe('remote support session', () => {
  it('starts idle and invites with awaiting consent', () => {
    let s = createSession();
    expect(s.state).toBe('idle');
    s = inviteGuest(s, 'Laptop');
    expect(s.state).toBe('awaiting_consent');
    expect(s.viewEnabled).toBe(false);
  });

  it('requires consent before view; control is a second opt-in', () => {
    let s = inviteGuest(createSession());
    expect(() => enableControl(s)).toThrow(/consent/i);
    s = grantConsent(s);
    expect(s.viewEnabled).toBe(true);
    expect(s.controlEnabled).toBe(false);
    s = enableControl(s);
    expect(s.controlEnabled).toBe(true);
  });

  it('denies and ends with audit trail', () => {
    let s = inviteGuest(createSession());
    s = denyConsent(s);
    expect(s.state).toBe('denied');
    s = inviteGuest(createSession());
    s = grantConsent(s);
    s = endSession(s);
    expect(s.state).toBe('ended');
    expect(s.audit.some((a) => a.kind === 'end')).toBe(true);
  });

  it('summarizes connections and mock frames are labeled demo', () => {
    const s = grantConsent(inviteGuest(createSession()));
    const row = connectionSummary(s);
    expect(row.view).toBe(true);
    expect(mockScreenFrame(1).documented).toMatch(/DEMO/);
  });
});
