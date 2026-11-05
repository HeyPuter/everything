import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEventModal } from '../src/js/modal.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

/**
 * The details card's send action: what it offers to do, and what it asks
 * invites.js to do when pressed. Both modules are stubbed — this is about the
 * card's reading of a plan, not about sending.
 */

const HOST = 'host@example.com';
const LINK = 'https://cal-rsvp-abc.puter.work/rsvp/' + 'a'.repeat(40);

const HOUR = 3_600_000;

function makeEvent(guests) {
  const start = Date.now() + 24 * HOUR;
  return {
    id: 'e1',
    title: 'Team offsite',
    start,
    end: start + HOUR,
    organizer: { email: HOST },
    guests: [{ email: HOST, status: 'accepted' }, ...guests],
    reminders: [],
  };
}

function makeStore(event) {
  return {
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    getEvent: (id) => (id === event.id ? event : null),
    getTask: () => null,
    saveEvent: async (e) => e,
    saveTask: async (t) => t,
    deleteTask: async () => {},
    applyOutOfOffice: async () => ({ declined: [], undo() {} }),
  };
}

function makeRsvp() {
  return {
    isHosted: () => true,
    linkableGuests: (ev) => ev.guests.filter((g) => g.email !== HOST),
    linksFor: () => ({ 'ada@example.com': LINK, 'bob@example.com': LINK }),
    refreshEvent: vi.fn(),
    onUpdate: vi.fn(() => () => {}),
  };
}

/** A plan in the shape invites.planFor() returns. */
function makePlan(ready) {
  return {
    eventId: 'e1',
    ready,
    pending: ready.filter((r) => !r.current),
    waiting: 0,
    lastSentAt: ready.reduce((max, r) => Math.max(max, r.sentAt || 0), 0),
  };
}

function guest(email, { sentAt = 0, current = false } = {}) {
  return { email, name: '', rsvpUrl: LINK, version: 'v1', sentAt, current };
}

function makeInvites(plan, { result = { sent: 1, skipped: 0, failed: 0 }, error = null } = {}) {
  return {
    available: () => true,
    planFor: vi.fn(() => plan),
    sendWhenReady: vi.fn(),
    send: vi.fn(async () => {
      if (error) throw error;
      return result;
    }),
  };
}

function open(plan, opts = {}) {
  const guests = plan.ready.map((r) => ({ email: r.email, status: 'needs-action' }));
  const event = makeEvent(guests);
  const invites = makeInvites(plan, opts);
  const modal = createEventModal({
    store: makeStore(event),
    user: { email: HOST },
    rsvp: makeRsvp(),
    invites,
    requestEmail: async () => HOST,
  });
  modal.openView(event);
  return { modal, invites, event };
}

/** Open the EDITOR on an event and save it, the way a host would. */
function openEditorAndSave(plan) {
  const guests = plan.ready.map((r) => ({ email: r.email, status: 'needs-action' }));
  const event = makeEvent(guests);
  const store = makeStore(event);
  const invites = makeInvites(plan);
  const modal = createEventModal({
    store,
    user: { email: HOST },
    rsvp: makeRsvp(),
    invites,
    requestEmail: async () => HOST,
  });
  modal.openEdit(event);
  document.querySelector('.modal-scrim form.modal').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
  return { invites, event };
}

const inviteDialog = () => document.querySelector('form.invite-ask');
const dialogButton = (label) =>
  [...(inviteDialog() ? inviteDialog().querySelectorAll('button') : [])].find(
    (b) => b.textContent.trim() === label,
  );

const buttons = () => [...document.querySelectorAll('.modal-scrim button')];
const sendButton = () =>
  buttons().find((b) => /invitation|new guest/i.test(b.textContent) && !b.title);
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
/** The most recent toast (toast.js keeps one container for the whole page). */
const lastToast = (sel = '.toast') => [...document.querySelectorAll(sel)].pop();

describe('details card: the send action', () => {
  // Cards and toasts only — never the whole body: toast.js holds a reference to
  // the container it appended, and wiping it would leave later toasts detached.
  const reset = () => {
    for (const node of document.querySelectorAll('.modal-scrim, .toast')) node.remove();
  };
  beforeEach(reset);
  afterEach(reset);

  it('offers a first invitation when nobody has been emailed', () => {
    open(makePlan([guest('ada@example.com')]));
    expect(sendButton().textContent).toContain('Email invitation');
  });

  it('names the number of new guests once others have been emailed', () => {
    open(
      makePlan([
        guest('ada@example.com', { sentAt: Date.now(), current: true }),
        guest('bob@example.com'),
      ]),
    );
    expect(sendButton().textContent).toContain('Email 1 new guest');
  });

  it('offers an update when the event moved under guests who were emailed', () => {
    open(makePlan([guest('ada@example.com', { sentAt: Date.now(), current: false })]));
    expect(sendButton().textContent).toContain('Send updated invitations');
  });

  it('counts both when some guests are new and some are out of date', () => {
    open(
      makePlan([
        guest('ada@example.com', { sentAt: Date.now(), current: false }),
        guest('bob@example.com'),
      ]),
    );
    expect(sendButton().textContent).toContain('Send 2 invitations');
  });

  it('falls back to a deliberate resend once everyone is current', async () => {
    const { invites } = open(
      makePlan([
        guest('ada@example.com', { sentAt: Date.now(), current: true }),
        guest('bob@example.com', { sentAt: Date.now(), current: true }),
      ]),
      { result: { sent: 2, skipped: 0, failed: 0 } },
    );
    const button = sendButton();
    expect(button.textContent).toContain('Resend invitations');

    button.click();
    await flush();
    expect(invites.send).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), {
      emails: ['ada@example.com', 'bob@example.com'],
      force: true,
    });
    expect(lastToast('.toast__msg').textContent).toBe('Invitations sent to 2 guests');
  });

  it('sends to the pending guests, and says so', async () => {
    const { invites } = open(makePlan([guest('ada@example.com')]));
    sendButton().click();
    await flush();
    expect(invites.send).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), {});
    expect(lastToast('.toast__msg').textContent).toBe('Invitation sent');
  });

  it('does not send twice while a send is in flight', async () => {
    const { invites } = open(makePlan([guest('ada@example.com')]));
    const button = sendButton();
    button.click();
    button.click();
    await flush();
    expect(invites.send).toHaveBeenCalledTimes(1);
  });

  it('surfaces a refusal as it was worded', async () => {
    open(makePlan([guest('ada@example.com')]), {
      error: new Error("You've reached today's invitation limit. Try again tomorrow."),
    });
    sendButton().click();
    await flush();
    expect(lastToast('.toast--danger .toast__msg').textContent).toContain(
      "today's invitation limit",
    );
  });

  it('reports a partial delivery failure as a failure', async () => {
    open(makePlan([guest('ada@example.com'), guest('bob@example.com')]), {
      result: { sent: 1, skipped: 0, failed: 1 },
    });
    sendButton().click();
    await flush();
    expect(lastToast('.toast--danger .toast__msg').textContent).toBe(
      'Sent 1, but 1 could not be delivered.',
    );
  });

  it('reports an unsubscribed guest as their choice, not as a failure', async () => {
    open(makePlan([guest('ada@example.com')]), {
      result: { sent: 0, skipped: 0, failed: 0, suppressed: 1 },
    });
    sendButton().click();
    await flush();
    expect(lastToast('.toast--danger')).toBeUndefined();
    expect(lastToast('.toast__msg').textContent).toBe(
      'That guest has opted out of these emails.',
    );
  });

  it('marks each guest row with what they were sent', () => {
    open(
      makePlan([
        guest('ada@example.com', { sentAt: Date.now(), current: true }),
        guest('bob@example.com', { sentAt: Date.now(), current: false }),
      ]),
    );
    const rows = [...document.querySelectorAll('.view__guest')];
    const rowFor = (email) => rows.find((r) => r.textContent.includes(email));
    expect(rowFor('ada@example.com').textContent).toContain('Invited');
    expect(rowFor('bob@example.com').textContent).toContain('Update pending');
    // The organizer's own row is never marked.
    expect(rowFor(HOST).textContent).not.toContain('Invited');
  });

  it('leaves the card as it was when there is nothing to send through', () => {
    const event = makeEvent([{ email: 'ada@example.com', status: 'needs-action' }]);
    const modal = createEventModal({
      store: makeStore(event),
      user: { email: HOST },
      rsvp: makeRsvp(),
      invites: null,
      requestEmail: async () => HOST,
    });
    modal.openView(event);
    expect(sendButton()).toBeUndefined();
    // The copy-the-links action, which predates sending, is still there.
    expect(buttons().some((b) => /Copy RSVP links/.test(b.textContent))).toBe(true);
  });
});

describe('saving an event: the invitation question', () => {
  const reset = () => {
    for (const node of document.querySelectorAll('.modal-scrim, .toast')) node.remove();
  };
  beforeEach(reset);
  afterEach(reset);

  it('asks after a save, counting the guests whose links are still being made', async () => {
    // A freshly saved event: nobody has a link yet, so every guest is `waiting`
    // — and every one of them is who the question is about.
    const { invites } = openEditorAndSave({
      eventId: 'e1', ready: [], pending: [], waiting: 2, lastSentAt: 0,
    });
    await flush();
    expect(inviteDialog()).toBeTruthy();
    expect(inviteDialog().textContent).toContain('Send invitations?');
    expect(inviteDialog().textContent).toContain('2 guests will get an email');
    expect(invites.sendWhenReady).not.toHaveBeenCalled(); // not until they say so
  });

  it('sends only when the host presses Send', async () => {
    const { invites } = openEditorAndSave({
      eventId: 'e1', ready: [], pending: [], waiting: 1, lastSentAt: 0,
    });
    await flush();
    expect(inviteDialog().textContent).toContain('1 guest will get an email');
    dialogButton('Send').click();
    expect(invites.sendWhenReady).toHaveBeenCalledWith({ id: 'e1' });
    expect(inviteDialog()).toBeNull();
  });

  it('sends nothing on "Don\'t send"', async () => {
    const { invites } = openEditorAndSave({
      eventId: 'e1', ready: [], pending: [], waiting: 1, lastSentAt: 0,
    });
    await flush();
    dialogButton("Don't send").click();
    expect(invites.sendWhenReady).not.toHaveBeenCalled();
    expect(inviteDialog()).toBeNull();
  });

  it('sends nothing when the question is dismissed with Escape', async () => {
    const { invites } = openEditorAndSave({
      eventId: 'e1', ready: [], pending: [], waiting: 1, lastSentAt: 0,
    });
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(invites.sendWhenReady).not.toHaveBeenCalled();
    expect(inviteDialog()).toBeNull();
  });

  it('calls it an update when everyone in line has been invited before', async () => {
    const { invites } = openEditorAndSave(
      makePlan([guest('ada@example.com', { sentAt: Date.now(), current: false })]),
    );
    await flush();
    expect(inviteDialog().textContent).toContain('Send updated invitations?');
    expect(inviteDialog().textContent).toContain('this event changed');
    expect(invites.sendWhenReady).not.toHaveBeenCalled();
  });

  it('does not ask when every guest already holds what the event says', async () => {
    openEditorAndSave(
      makePlan([guest('ada@example.com', { sentAt: Date.now(), current: true })]),
    );
    await flush();
    expect(inviteDialog()).toBeNull();
  });

  it('does not ask for an event with no guests to write to', async () => {
    openEditorAndSave({ eventId: '', ready: [], pending: [], waiting: 0, lastSentAt: 0 });
    await flush();
    expect(inviteDialog()).toBeNull();
  });
});

describe('deleting an invited event: the cancellation offer', () => {
  const reset = () => {
    for (const node of document.querySelectorAll('.modal-scrim, .toast')) node.remove();
  };
  beforeEach(reset);
  afterEach(reset);

  const cancelDialog = () => document.querySelector('form.cancel-ask');
  const cancelButton = (label) =>
    [...(cancelDialog() ? cancelDialog().querySelectorAll('button') : [])].find(
      (b) => b.textContent.trim() === label,
    );
  const chooseScope = (value) => {
    const scopeForm = document.querySelector('form.rr-scope');
    const radio = scopeForm.querySelector(`input[value="${value}"]`);
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    scopeForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  };

  const CANCEL = () => ({
    eventId: 'e1',
    event: { id: 'e1' },
    details: { title: 'Team offsite', when: 'Tuesday at 9 AM' },
    recipients: [{ email: 'ada@example.com', name: 'Ada', version: 'aaaa1111' }],
  });

  /** A card open on an invited event (or an occurrence of one), ready to be
   *  deleted. `live.exists` is the store's truth — flipping it back on is the
   *  test's stand-in for the Undo toast. */
  function makeDeleteWorld({ cancel = CANCEL(), series = false, futureKeepsMaster = false } = {}) {
    const event = makeEvent([{ email: 'ada@example.com', status: 'needs-action' }]);
    const live = { exists: true };
    const store = makeStore(event);
    const master = series
      ? { ...event, recurrence: { freq: 'weekly', interval: 1, byWeekday: [2] } }
      : event;
    store.getEvent = (id) => (live.exists && id === 'e1' ? master : null);
    store.deleteEvent = vi.fn(async () => {
      live.exists = false;
      return master;
    });
    store.deleteOccurrence = vi.fn(async (_, rid) => {
      master.exdates = [rid];
      return { event: master, undo: () => {} };
    });
    store.deleteFuture = vi.fn(async () => {
      if (futureKeepsMaster) return { event: master, truncated: 1, undo: () => {} };
      live.exists = false;
      return { undo: () => {} };
    });
    const invites = {
      available: () => true,
      planFor: vi.fn(() => makePlan([])),
      sendWhenReady: vi.fn(),
      send: vi.fn(),
      cancellationFor: vi.fn((item, opts) => cancel && ({ ...cancel,
        ...(opts?.future ? { recurrenceRange: 'THISANDFUTURE' } : {}),
        ...(item.seriesId ? { recurrenceId: item.recurrenceId } : {}),
      })),
      sendCancellation: vi.fn(async () => ({ ok: true, sent: 1, failed: 0, suppressed: 0 })),
    };
    const modal = createEventModal({
      store,
      user: { email: HOST },
      rsvp: makeRsvp(),
      invites,
      requestEmail: async () => HOST,
    });
    modal.openView(
      series ? { ...event, id: 'e1::occ', seriesId: 'e1', recurrenceId: event.start } : event,
    );
    return { modal, store, invites, live };
  }

  const deleteButton = () => document.querySelector('[aria-label="Delete event"]');

  it('offers the cancellation after the delete, and sends only on a yes', async () => {
    const world = makeDeleteWorld();
    deleteButton().click();
    await flush();
    expect(world.store.deleteEvent).toHaveBeenCalled();
    expect(world.invites.cancellationFor).toHaveBeenCalled();
    expect(cancelDialog().textContent).toContain('1 guest will get an email saying “Team offsite” was cancelled.');

    cancelButton('Send').click();
    await flush();
    expect(world.invites.sendCancellation).toHaveBeenCalledTimes(1);
    expect(lastToast().textContent).toContain('Cancellation sent');
  });

  it('sends nothing on "Don\'t send"', async () => {
    const world = makeDeleteWorld();
    deleteButton().click();
    await flush();
    cancelButton("Don't send").click();
    await flush();
    expect(world.invites.sendCancellation).not.toHaveBeenCalled();
  });

  it('sends nothing when Undo restored the event before the answer', async () => {
    const world = makeDeleteWorld();
    deleteButton().click();
    await flush();
    world.live.exists = true; // the Undo toast was pressed while the ask was up
    cancelButton('Send').click();
    await flush();
    expect(world.invites.sendCancellation).not.toHaveBeenCalled();
    expect(lastToast().textContent).toContain('The event was restored');
  });

  it('never asks when nobody was emailed an invitation', async () => {
    const world = makeDeleteWorld({ cancel: null });
    deleteButton().click();
    await flush();
    expect(world.store.deleteEvent).toHaveBeenCalled();
    expect(cancelDialog()).toBeNull();
  });

  it('asks for a whole-series delete, from the master the guests live on', async () => {
    const world = makeDeleteWorld({ series: true });
    deleteButton().click();
    chooseScope('all');
    await flush();
    expect(world.store.deleteEvent).toHaveBeenCalledWith('e1');
    expect(world.invites.cancellationFor).toHaveBeenCalledWith({ id: 'e1' });
    expect(cancelDialog()).toBeTruthy();
  });

  it('asks when this-and-following removed the whole series', async () => {
    const world = makeDeleteWorld({ series: true });
    deleteButton().click();
    chooseScope('future');
    await flush();
    expect(world.store.deleteFuture).toHaveBeenCalled();
    expect(cancelDialog()).toBeTruthy();
  });

  it('offers and sends a cancellation for just the deleted occurrence', async () => {
    const one = makeDeleteWorld({ series: true });
    deleteButton().click();
    chooseScope('one');
    await flush();
    expect(one.store.deleteOccurrence).toHaveBeenCalled();
    expect(one.invites.cancellationFor).toHaveBeenCalledWith(expect.objectContaining({ seriesId: 'e1' }));
    expect(cancelDialog().textContent).toContain('this occurrence');
    expect(one.invites.sendCancellation).not.toHaveBeenCalled();
    cancelButton('Send').click();
    await flush();
    expect(one.invites.sendCancellation).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'e1', recurrenceId: expect.any(Number),
    }));
    one.modal.close();
  });

  it('offers a range cancellation for a trim that preserves the series', async () => {
    const trimmed = makeDeleteWorld({ series: true, futureKeepsMaster: true });
    deleteButton().click();
    chooseScope('future');
    await flush();
    expect(trimmed.store.deleteFuture).toHaveBeenCalled();
    expect(trimmed.invites.cancellationFor).toHaveBeenCalledWith(expect.objectContaining({ seriesId: 'e1' }), { future: true });
    expect(cancelDialog().textContent).toContain('this and all following occurrences');
  });
});

describe('a mail invitation addressed to the Puter mailbox', () => {
  const MAILBOX = 'nariman@puter.email';
  const ACCOUNT = 'nariman@work.example';
  const reset = () => {
    for (const node of document.querySelectorAll('.modal-scrim, .toast')) node.remove();
  };
  beforeEach(reset);
  afterEach(reset);

  function mailEvent() {
    return {
      id: 'mail-evt-1',
      title: 'Design review',
      start: Date.now() + 3_600_000,
      end: Date.now() + 7_200_000,
      allDay: false,
      color: 'blue',
      reminders: [],
      organizer: { email: 'alice@example.com' },
      // The invitation named us by the mailbox address, not the account one.
      guests: [{ email: MAILBOX, status: 'needs-action' }],
      invite: { uid: 'ext-uid-1', from: 'alice@example.com', attendee: MAILBOX },
    };
  }

  function openMail({ reply, respond } = {}) {
    const event = mailEvent();
    const rsvped = [];
    const store = {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      getEvent: (id) => (id === event.id ? event : null),
      getTask: () => null,
      saveEvent: async (e) => e,
      saveTask: async (t) => t,
      deleteTask: async () => {},
      applyOutOfOffice: async () => ({ declined: [], undo() {} }),
      rsvpEvent: async (id, status, email) => {
        rsvped.push({ id, status, email });
        return { ...event, guests: [{ email: MAILBOX, status }] };
      },
    };
    const modal = createEventModal({
      store,
      user: { email: ACCOUNT },
      rsvp: makeRsvp(),
      mail: reply ? { reply } : null,
      requestEmail: async () => ACCOUNT,
    });
    modal.openView(event, { respond });
    return { modal, event, rsvped };
  }

  it('shows the Going? chips even though the account email differs', () => {
    openMail();
    const chips = [...document.querySelectorAll('.view__going-chip')].map((b) => b.textContent);
    expect(chips).toEqual(['Yes', 'No', 'Maybe']);
  });

  it('answers as the address the invitation used, not the account address', async () => {
    const { rsvped } = openMail();
    const yes = [...document.querySelectorAll('.view__going-chip')].find((b) => b.textContent === 'Yes');
    yes.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(rsvped).toHaveLength(1);
    expect(rsvped[0].email).toBe(MAILBOX);
    expect(rsvped[0].status).toBe('accepted');
  });

  it('answers on opening when Yes or No was pressed on the notification', async () => {
    const offerReply = vi.fn();
    const { rsvped } = openMail({ reply: { offerReply, available: () => true }, respond: 'accepted' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(rsvped).toEqual([{ id: 'mail-evt-1', status: 'accepted', email: MAILBOX }]);
    expect(offerReply).toHaveBeenCalledTimes(1);
  });

  it('then offers to email the reply', async () => {
    const offerReply = vi.fn();
    openMail({ reply: { offerReply, available: () => true } });
    const no = [...document.querySelectorAll('.view__going-chip')].find((b) => b.textContent === 'No');
    no.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(offerReply).toHaveBeenCalledTimes(1);
    expect(offerReply.mock.calls[0][1]).toBe('declined');
  });
});
