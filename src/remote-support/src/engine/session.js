/**
 * Remote Support session model (original). TeamViewer/AnyDesk-inspired UI —
 * consent-first local demo only. No unauthorized access tooling (DOCUMENTED).
 *
 * LIVE peer WebRTC is out of scope for v0; this uses an explicit mock loopback
 * so both “helper” and “guest” stay in the same browser tab.
 */

/** @typedef {'idle'|'awaiting_consent'|'connected'|'ended'|'denied'} SessionState */
/** @typedef {{ id:string, role:'helper'|'guest', label:string }} Peer */
/** @typedef {{ at:number, kind:string, detail:string }} AuditEntry */
/** @typedef {{
 *   id:string,
 *   state:SessionState,
 *   helper:Peer,
 *   guest:Peer|null,
 *   consentGranted:boolean,
 *   controlEnabled:boolean,
 *   viewEnabled:boolean,
 *   audit:AuditEntry[],
 * }} Session */

/** @returns {Session} */
export function createSession() {
  return {
    id: `rs-${Date.now().toString(36)}`,
    state: 'idle',
    helper: { id: 'helper', role: 'helper', label: 'Support agent' },
    guest: null,
    consentGranted: false,
    controlEnabled: false,
    viewEnabled: false,
    audit: [],
  };
}

/** @param {Session} s @param {string} kind @param {string} detail */
function audit(s, kind, detail) {
  return {
    ...s,
    audit: [...s.audit, { at: Date.now(), kind, detail }],
  };
}

/** Helper invites guest into a consent prompt (never auto-connects). */
export function inviteGuest(session, guestLabel = 'Local device') {
  if (session.state !== 'idle' && session.state !== 'ended' && session.state !== 'denied') {
    throw new Error('Session already active');
  }
  let next = {
    ...session,
    state: /** @type {SessionState} */ ('awaiting_consent'),
    guest: { id: 'guest', role: /** @type {const} */ ('guest'), label: guestLabel },
    consentGranted: false,
    controlEnabled: false,
    viewEnabled: false,
  };
  return audit(next, 'invite', `Invited ${guestLabel} — waiting for explicit consent`);
}

/** Guest must explicitly accept before any view/control. */
export function grantConsent(session) {
  if (session.state !== 'awaiting_consent') throw new Error('No pending consent request');
  let next = {
    ...session,
    state: /** @type {SessionState} */ ('connected'),
    consentGranted: true,
    viewEnabled: true,
    controlEnabled: false,
  };
  return audit(next, 'consent', 'Guest granted screen view (control still off)');
}

export function denyConsent(session) {
  if (session.state !== 'awaiting_consent') throw new Error('No pending consent request');
  let next = {
    ...session,
    state: /** @type {SessionState} */ ('denied'),
    consentGranted: false,
    viewEnabled: false,
    controlEnabled: false,
  };
  return audit(next, 'deny', 'Guest denied remote support');
}

/** Control requires a second explicit opt-in after view consent. */
export function enableControl(session) {
  if (!session.consentGranted || session.state !== 'connected') {
    throw new Error('Control requires an active consented session');
  }
  return audit({ ...session, controlEnabled: true }, 'control_on', 'Guest allowed remote control');
}

export function disableControl(session) {
  return audit({ ...session, controlEnabled: false }, 'control_off', 'Remote control disabled');
}

export function endSession(session) {
  let next = {
    ...session,
    state: /** @type {SessionState} */ ('ended'),
    viewEnabled: false,
    controlEnabled: false,
  };
  return audit(next, 'end', 'Session ended by either party');
}

/** Connection list row derived from session. */
export function connectionSummary(session) {
  return {
    id: session.id,
    peer: session.guest?.label || '—',
    state: session.state,
    view: session.viewEnabled,
    control: session.controlEnabled,
  };
}

/** Demo “frame” for local loopback preview (not a LIVE capture). */
export function mockScreenFrame(t = 0) {
  return {
    width: 640,
    height: 360,
    label: 'Mock local loopback screen',
    hue: (t * 20) % 360,
    documented: 'DEMO — not a LIVE remote desktop stream',
  };
}
