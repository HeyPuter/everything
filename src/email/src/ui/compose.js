import { el, clear, append } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { createEditor } from './editor.js';
import {
  PUTER_DOMAINS, ADDRESS_RE, parseAddresses, draftProblem, draftProblemField, buildMessage,
  safeFilename, withSignature, isSignatureOnly, MAX_ATTACHMENT_BYTES, mentionsAttachment,
} from '../lib/compose.js';
import { htmlToText, hasFormatting, messageHtml } from '../lib/richtext.js';
import { mergeContacts, rankContacts } from '../lib/contacts.js';
import { formatSize, initialFor, hueFor } from '../lib/format.js';
import { fileSentCopy } from '../lib/mailbox.js';
import { isEmptyDraft } from '../lib/drafts.js';
import { MOD } from './shortcuts.js';

/**
 * Compose dialog, wired to the `useremailtx` backend extension:
 *
 *   POST {APIOrigin}/email/send   content-type: message/rfc822
 *
 * The endpoint takes a whole RFC 822 message, enforces that `From:` is
 * <username>@puter.email — the one address this dialog sends as — and
 * delivers to each To/Cc recipient: into the mailbox of anyone on that
 * domain, over SMTP for everyone else.
 *
 * There is deliberately no Bcc field: the server writes the same bytes to
 * every recipient, so a Bcc header would be delivered to — and readable
 * by — everyone on the message. Rather than ship a Bcc that silently isn't
 * blind, this app doesn't offer one.
 *
 * The message body is written in a small formatting editor (editor.js) rather
 * than a textarea: bold, italic, underline, strikethrough, one of a few fonts,
 * one of a few sizes, a colour, lists and quotes. What that produces is HTML,
 * so what is *sent* is decided here -- a message the writer never formatted
 * goes out as text/plain and nothing else, exactly as it did before there was
 * an editor, and a formatted one goes out as multipart/alternative carrying
 * both the text and the markup. Neither recipient is asked to install
 * anything.
 *
 * Attachments are read into memory as bytes here and composed into a
 * multipart/mixed message at send time. Two sources, because this client
 * lives inside a cloud OS: the local device, and the user's Puter files.
 *
 * A half-written message used to exist only inside this modal: closing it,
 * reloading, or losing the tab lost the text with no way back. The dialog now
 * autosaves to the draft store on a short debounce and again on close, so
 * closing keeps the message and reopening Compose continues it. Discard is the
 * explicit way to throw one away, and a successful send clears it.
 *
 * The extension writes only into the recipients' mailboxes, so the sender's
 * copy is filed by this client: once the POST succeeds the same bytes are
 * written to `.mail/sent/<day>/<uuidv7>--<subject>`. That write can fail on
 * its own, and when it does the send still happened -- so it is reported as a
 * quieter, separate failure rather than making the user think nothing went
 * out.
 */

const readBlob = async (blob) => new Uint8Array(await blob.arrayBuffer());
const pendingDrafts = new Map();
const openDrafts = new Map();

/**
 * Whether a stored draft is a message on its way: held for Undo, or posted
 * and not yet answered. The bare Compose pill continues the newest draft,
 * and for the length of a hold the newest draft is the one that was just
 * sent -- so for those seconds the pill answered "this draft is already
 * sending" and opened nothing at all. A caller choosing a draft to continue
 * asks this first and passes over the ones that are going.
 */
export const isDraftSending = ({ username, mailPath, id }) =>
  pendingDrafts.has(JSON.stringify([username, mailPath, id]));

/**
 * Close the composer of a draft that was discarded somewhere else -- from its
 * row in Drafts, while the dialog for it sat minimized in the dock. Left
 * standing, the dialog went on holding a message the store no longer had,
 * and its next autosave, or simply closing it, put the discarded draft back.
 * The keyboard stays where the discard was made. Returns whether there was a
 * composer to close.
 */
export const discardComposer = ({ username, mailPath, id }) => {
  const key = JSON.stringify([username, mailPath, id]);
  // The row discarded was a message being held for Undo. Discarding it is the
  // plainest way there is of saying "do not send this" -- and the message
  // went anyway: the row left Drafts, and the hold, which knew nothing of
  // that, fired on time. Taking the hold back is what the discard means.
  const held = pendingDrafts.get(key);
  if (held?.cancelHold) {
    held.cancelHold();
    held.discard({ focusOpener: false });
    return true;
  }
  const modal = openDrafts.get(key);
  if (!modal) return false;
  modal.discard({ focusOpener: false });
  return true;
};

/** Signing out must also close minimized drafts from the current account. */
export const closeComposers = () => {
  let allClosed = true;
  for (const modal of [...openDrafts.values()]) {
    modal.close();
    if (modal.panel.isConnected) {
      modal.restore();
      allClosed = false;
    }
  }
  return allClosed;
};

const deliver = async (message) => {
  const response = await fetch(`${puter.APIOrigin}/email/send`, {
    method: 'POST',
    headers: {
      'content-type': 'message/rfc822',
      authorization: `Bearer ${puter.authToken}`,
    },
    body: message,
  });

  if (response.ok) return { ok: true };

  // The endpoint answers errors as JSON, but a 500 from elsewhere in the
  // stack may not be JSON at all.
  const detail = await response.json().catch(() => null);
  return {
    ok: false,
    status: response.status,
    message: detail?.message || detail?.error || `Send failed (${response.status}).`,
  };
};

// `/email/send` rejects with 403 until the user has granted this app write
// access to their mailbox. Asking up front would mean a permission dialog on
// every launch, since the request always prompts — so ask only once the
// server has actually said no. The other 403 this endpoint returns (sending
// from an address that isn't yours) stays an ordinary error.
const needsMailAccess = (result) =>
  result.status === 403 && /write access/i.test(result.message);

/**
 * Whether a separator typed at the end of `text` would fall inside a single
 * address rather than between two. `"Doe, Jane" <jane@example.com>` holds a
 * comma that belongs to the name, and the same is true of anything between
 * angle brackets -- ending the address there would break one address into two
 * halves, neither of which is one.
 */
const midAddress = (text) =>
  (text.match(/"/g)?.length ?? 0) % 2 === 1
  || text.lastIndexOf('<') > text.lastIndexOf('>');

/**
 * How many recipients a field shows before the rest go behind a count. Four
 * is about two rows of chips in this dialog -- enough that most messages are
 * never collapsed at all, and short enough that the twenty-name ones stop
 * pushing the message off the bottom of the screen.
 */
const COLLAPSE_OVER = 4;

const requestMailWrite = (mailPath) => {
  const permission = `fs:${mailPath}:write`;
  return puter.perms?.request
    ? puter.perms.request(permission)
    : puter.ui.requestPermission({ permission });
};

/**
 * openCompose({ username, mailPath, prefill, onFiled }) — prefill carries
 * { to, subject, body } for replies; onFiled runs after the sent copy has
 * been written, so the Sent folder can pick it up. The server checks mailbox
 * write access before anything else in the request, so a 403 there is never a
 * partial send and the same message can safely be posted again once access is
 * granted.
 *
 * `contacts` is a function returning every address the header index has seen,
 * which is what To and Cc complete against. It is optional, and the field is
 * exactly what it was without one — a dialog opened with no address book
 * simply never has anything to offer.
 *
 * `signature` is the text to sign a new message with. It goes in where a mail
 * client puts one -- at the foot of a new message, and between the reply and
 * the quoted text in an answer -- and only into a message that is being
 * started here: a resumed draft already holds whatever it was signed with.
 *
 * `undoSend` is how many seconds a send is held before the message actually
 * goes, with an Undo in a toast for the length of it. Zero -- the default,
 * and what every earlier caller gets -- sends at once.
 */
export function openCompose({
  username, mailPath, prefill: given, onFiled, drafts, draft, onDraftsChanged, contacts,
  signature = '', undoSend = 0,
}) {
  const pendingKey = (id) => JSON.stringify([username, mailPath, id]);
  if (draft?.id && pendingDrafts.has(pendingKey(draft.id))) {
    toast('This draft is already sending. Use Undo if it is still available, or wait for the result.', { iconName: 'info' });
    return pendingDrafts.get(pendingKey(draft.id));
  }
  const existing = draft?.id && openDrafts.get(pendingKey(draft.id));
  if (existing?.panel.isConnected) {
    existing.restore();
    return existing;
  }
  // Everything a second dialog over the same message needs, which is what
  // Undo on a held send opens.
  const reopenWith = {
    username, mailPath, onFiled, drafts, onDraftsChanged, contacts, signature, undoSend,
  };
  // Opening a draft has nothing to prefill, and says so by passing null --
  // which a default parameter does not cover, so it is normalised here rather
  // than left to throw on the first property read.
  const prefill = given ?? {};
  const sendingDomain = PUTER_DOMAINS[0];
  const fromAddress = `${username}@${sendingDomain}`;
  // A resumed draft wins over a prefill: Reply always starts a new draft,
  // and the Compose pill continues the newest one.
  const start = {
    to: '', cc: '', subject: '', body: '', html: '', inReplyTo: '', references: '',
    ...(draft ?? prefill),
  };
  // A message being started is signed; a draft was signed when it was
  // started, or was not, and either way that is what it says now. Only a text
  // body is signed -- a prefill that arrives as markup has been laid out by
  // whoever built it, and a signature spliced into the middle of that is not.
  // Nor is an unsubscribe request: its body is whatever the list asked to
  // see, often a token on its own, and it is read by a machine that may
  // want exactly that and nothing above it.
  if (!draft && !start.html && prefill.kind !== 'unsubscribe') {
    start.body = withSignature(start.body, signature);
  }
  // References travel as a string in the draft store and as an array from a
  // reply; buildMessage takes either.
  const references = Array.isArray(start.references)
    ? start.references.join(' ')
    : start.references;
  const draftId = draft?.id ?? crypto.randomUUID();
  let closed = false;
  let discarded = false;
  let sending = false;
  let restoringFiles = false;
  let filesSaving = false;
  let filesSaved = false;
  let filesRevision = 0;
  let missingFiles = draft?.attachments || 0;
  let warnedOnClose = false;
  let reviewed = null;
  let dockItem = null;
  const removeDockItem = () => {
    const dock = dockItem?.parentElement;
    dockItem?.remove();
    dockItem = null;
    if (dock && !dock.children.length) {
      dock.remove();
      document.documentElement.classList.remove('has-compose-dock');
    }
  };

  /**
   * What the dialog opened with, in the shape a draft is judged in. Set once
   * the prefill is in place -- its attachments included, so a forward's files
   * count as part of what it arrived with -- and only for a message being
   * started here: a resumed draft was written already, by definition.
   */
  let untouchedKey = null;
  const keyOf = (entry) => JSON.stringify([entry.to, entry.cc, entry.subject, entry.body, entry.attachments]);

  // A draft with nothing in it but the signature every message starts with is
  // a draft with nothing in it: opening Compose and closing it again has
  // written nothing, and must not leave a row in Drafts saying who the writer
  // is. The same goes for a reply, a forward or an address clicked in a body
  // that is closed before a word is typed into it: what it holds is the quote
  // of a message nobody answered, and it left a row in Drafts for every reply
  // opened by mistake -- with a "Draft saved" for good measure.
  const blank = (entry) => (untouchedKey !== null && keyOf(entry) === untouchedKey)
    || isEmptyDraft(isSignatureOnly(entry.body, signature) ? { ...entry, body: '' } : entry);

  /**
   * The address book, merged once for the life of the dialog rather than once
   * per keystroke: the index behind it holds thousands of messages carrying
   * tens of thousands of addresses, and the deduped list is a few hundred.
   * Built on the first character typed rather than on open, so a dialog nobody
   * addresses never pays for it -- and left alone afterwards, because a
   * contact learned while this message was being written is not one anybody is
   * waiting to be offered.
   */
  let book = null;
  const addressBook = () => (book ??= contacts ? mergeContacts(contacts()) : []);

  /**
   * The name the address book has for an address, or nothing. A chip shows it
   * in place of the address, because `ana@meridianlabs.example` is who to a
   * machine and "Ana Petrova" is who to the person writing -- the address is
   * still there, in the tooltip and underneath, and is what the message is
   * sent to. Looked up through a map built once, since a reply arrives with
   * its recipients already on it and should not pay a search per chip.
   */
  let byEmail = null;
  const nameFor = (address) => {
    if (!contacts) return '';
    byEmail ??= new Map(addressBook().map((contact) => [contact.email, contact]));
    return byEmail.get(String(address).trim().toLowerCase())?.name || '';
  };

  const field = (id, label, value, placeholder, onEnter) => {
    const input = el('input', {
      id, type: 'text', autocomplete: 'off', value, placeholder,
      // Editing the field the error points at retracts the error, rather
      // than leaving a stale red underline until the next send.
      oninput: () => {
        if (input.getAttribute('aria-invalid')) clearProblem();
        queueSave();
      },
      onkeydown: (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key !== 'Enter' || event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        onEnter?.();
      },
    });
    return { input, row: el('div.compose-field', {}, el('label', { htmlFor: id }, label), input) };
  };

  /**
   * A recipient field: To and Cc.
   *
   * A message can go to any number of people, and the field is a list rather
   * than a line of prose to say so. Each address entered becomes a chip that
   * can be removed on its own -- so taking one name off a message of six is a
   * click, not an exercise in editing a comma-separated string without
   * breaking the addresses either side of it.
   *
   * An address is entered by typing it and pressing Enter, or by typing a
   * comma or semicolon after it, or by pasting a list of them in any of the
   * forms another mail client hands out: `a@b.co, c@d.co`, or names and
   * angle brackets, or a mix. Pasting one address alone leaves it as text,
   * because a half-typed address that turns into a chip the moment it is
   * pasted cannot be corrected without deleting it first. Backspace on an
   * empty input takes the last chip back into it, which is what corrects a
   * typo without retyping the whole address.
   *
   * Whether something is an address is now answered where it is entered:
   * an entry that names no address is chipped as an error immediately,
   * rather than being reported at the end of a send that was refused for it.
   * Duplicates collapse, because two identical chips are two copies of one
   * message to one person.
   *
   * Underneath it is still the single comma-separated string that a draft
   * stores, that `parseAddresses` reads, and that every caller of this field
   * already expects -- `value()` composes the chips and whatever is still
   * being typed back into one.
   *
   * Typing into it completes against the addresses the app has already seen
   * (contacts.js). The list is offered, never applied: nothing is highlighted
   * until an arrow key highlights it, so Enter goes on meaning "the address I
   * typed" rather than "whichever address the app guessed" -- which is the one
   * way an autocomplete can send a message to the wrong person.
   */
  const recipientField = (id, label, value, placeholder) => {
    const recipients = parseAddresses(value);

    // The offered contacts, and which one the keyboard is on (-1 for none).
    const listId = `${id}-suggestions`;
    const optionId = (index) => `${listId}-${index}`;
    const list = el('ul.suggestions', { id: listId, role: 'listbox', hidden: true });
    let offered = [];
    let active = -1;

    const input = el('input', {
      id, type: 'text', autocomplete: 'off', placeholder,
      /**
       * A phone keyboard's defaults are written for prose, and an address is
       * not prose. Left alone, iOS and Android capitalised the first letter of
       * every address typed here, autocorrected the domain of anything that
       * looked like a misspelling, and offered no `@` without a trip to the
       * symbols layer -- so a field whose entire vocabulary is
       * `name@host.tld` was the hardest field in the app to type into.
       *
       * `inputmode` rather than `type="email"`: the field takes a whole list,
       * and names with angle brackets in it, so the browser's own idea of one
       * address per box is not the shape of what goes here.
       */
      inputmode: 'email',
      autocapitalize: 'off',
      autocorrect: 'off',
      // ARIA's combobox: an input that owns a list of options, one of which
      // may be current without focus ever leaving the input.
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
      'aria-controls': listId,
      oninput: () => {
        if (input.getAttribute('aria-invalid')) clearProblem();
        queueSave();
        suggest();
      },
      onkeydown: (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        // The dialog's send chord, wherever in the dialog it is pressed: the
        // completion list must not answer it as "take the highlighted one".
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) return;
        if (!list.hidden && handleSuggestionKey(event)) return;
        const typed = input.value.trim();
        if ((event.key === ',' || event.key === ';') && !midAddress(input.value)) {
          // A separator's whole job is to end an address, so it never
          // reaches the field as a character of one.
          event.preventDefault();
          if (typed) commit();
          return;
        }
        // Enter ends the address being typed, and does nothing else.
        //
        // It used to fall through on an empty field to the form's own
        // meaning for Enter, which is send -- so a second press after
        // entering an address, or one press after removing the last, sent
        // the message. That is the one action in this dialog nobody can take
        // back, one stray keystroke away, in the field where the same key's
        // other meaning is "yes, that address". The chord that sends is
        // ⌘Enter, and it is printed on the button.
        if (event.key === 'Enter') {
          event.preventDefault();
          if (typed) commit();
          return;
        }
        // Backspace on an empty field takes the last chip back to be
        // corrected -- which is what pressing a chip does, to that chip. The
        // same path, so the two say the same thing and mean the same thing.
        if (event.key === 'Backspace' && !input.value && recipients.length) {
          event.preventDefault();
          editChip(recipients[recipients.length - 1]);
        }
      },
      onpaste: (event) => {
        const text = event.clipboardData?.getData('text') ?? '';
        if (!/[,;\n]/.test(text)) return;
        event.preventDefault();
        commit(input.value + text);
      },
      // Moving on ends the address too: clicking Send with a name still in
      // the field is sending to that name, not abandoning it.
      onblur: () => {
        hideSuggestions();
        commit();
      },
    });
    // Set rather than passed: `el` drops a `false` outright, and the string
    // 'false' would come back through the IDL attribute as true.
    input.spellcheck = false;

    /**
     * The rest of a long list, behind a count.
     *
     * A field that grows a row for every second recipient is a field that
     * pushes the subject, the message being written and the Send button under
     * it off the bottom of the dialog -- eighteen names and the writer cannot
     * see the message at all. So a list longer than a couple of rows is shown
     * as its first few and a count of the others, and opens again the moment
     * the field is being used: addressing a message is when the names matter,
     * and writing one is when they are in the way.
     */
    let expanded = false;
    const more = el('button.recipient-more', {
      type: 'button',
      hidden: true,
      // Same reason as the remove buttons: a press inside this field must not
      // blur the input, because the button it landed on is about to be
      // replaced by the chips it stands for.
      onmousedown: (event) => event.preventDefault(),
      onclick: () => {
        expanded = true;
        render();
        input.focus();
      },
    });

    /**
     * What just happened to the list, for someone who cannot see it happen.
     *
     * A line of its own rather than a live region wrapped around the field:
     * the completion list lives inside that field, so every keystroke that
     * offered six names read all six of them back on top of everything the
     * combobox was already saying. What is worth hearing is the change -- one
     * address on, one address off, and how many there are now.
     */
    const spoken = el('span.sr-only', { role: 'status', 'aria-live': 'polite' });
    const held = (count) => `${count} recipient${count === 1 ? '' : 's'}`;
    const announce = (text) => { spoken.textContent = `${text} ${held(recipients.length)}.`; };

    const box = el('div.recipient-box', {
      role: 'group',
      'aria-label': `${label} recipients`,
      // The box is as wide as the row but the input inside it is only as wide
      // as the space left over, so clicking the gap has to reach the input --
      // otherwise most of a half-empty field is dead to the pointer.
      onmousedown: (event) => {
        if (event.target !== box) return;
        event.preventDefault();
        input.focus();
      },
      // Using the field is what opens a collapsed list, and leaving it is what
      // closes it again -- focusin and focusout rather than the input's own
      // focus and blur, because a chip's remove button is inside the field too
      // and reaching for one is not leaving it.
      onfocusin: () => {
        if (expanded) return;
        expanded = true;
        render();
      },
      onfocusout: (event) => {
        if (!expanded || box.contains(event.relatedTarget)) return;
        expanded = false;
        render();
      },
    }, more, input, list);

    const drop = (address) => {
      const at = recipients.indexOf(address);
      if (at < 0) return;
      recipients.splice(at, 1);
      render();
      announce(`${address} removed.`);
      queueSave();
      if (input.getAttribute('aria-invalid')) clearProblem();
      // The control that was pressed has just been removed, so the keyboard
      // has to be handed somewhere -- and the input is where this field is
      // written.
      input.focus();
    };

    /**
     * Take a recipient back into the input to be corrected.
     *
     * `bo@exmaple.com`, second of five, could be deleted and typed again from
     * nothing, and that was all: the field could say an address was wrong and
     * offer no way to fix it short of retyping the whole thing. Backspace
     * already does exactly this for the last chip -- which is the same
     * gesture, and was only ever available at one end of the list.
     *
     * Whatever is half-typed is ended first, so the two never run together
     * into one line that is neither address.
     */
    const editChip = (address) => {
      commit();
      drop(address);
      input.value = address;
      input.focus();
    };

    const chipFor = (address) => {
      const bad = !ADDRESS_RE.test(address);
      // Who this is, where the address book knows: the name is what is shown,
      // and the address is what is meant.
      const name = bad ? '' : nameFor(address);
      const who = name ? `${name} <${address}>` : address;
      // A red chip that says only the address leaves the reader to guess what
      // is wrong with it, and a screen reader hears nothing at all -- the mark
      // was a colour and an icon and no words.
      const why = bad ? `${address} is not an email address` : who;
      return el(`span.chip.recipient-chip${bad ? '.is-error' : ''}${name ? '.is-named' : ''}`, {
        // What the chip stands for, so a rebuild can leave the ones that have
        // not changed exactly where they are.
        dataset: { address },
      },
        // One tab stop per recipient, carrying both of the things there are to
        // do with one. The remove button beside it is the pointer's way to the
        // second, and is out of the tab order rather than doubling the walk
        // through a field of six names.
        el('button.chip-edit', {
          type: 'button',
          'aria-label': `${why}. Press Enter to correct it, Delete to remove it.`,
          title: bad ? `${why} — click to correct it` : `${who} — click to edit`,
          onmousedown: (event) => event.preventDefault(),
          onclick: () => editChip(address),
          onkeydown: (event) => {
            if (event.key !== 'Backspace' && event.key !== 'Delete') return;
            event.preventDefault();
            drop(address);
          },
        },
          bad && el('span.chip-icon', { html: icon('alert', 13) }),
          el('span.chip-name', {}, name || address),
        ),
        el('button.chip-remove', {
          type: 'button', html: icon('x', 13), tabindex: -1,
          'aria-label': `Remove ${address}`, title: `Remove ${address}`,
          // Pressing a control that belongs to this field is not leaving it.
          // Without this the press blurs the input, blurring commits whatever
          // was half-typed, committing rebuilds every chip -- and the button
          // under the pointer is gone before the click it was waiting for.
          // The address was never removed, and a fragment nobody finished
          // typing became a chip of its own instead.
          onmousedown: (event) => event.preventDefault(),
          onclick: () => drop(address),
        }),
      );
    };

    /**
     * How many chips to draw. Always a prefix of the list, which is what lets
     * a rebuild leave the chips it keeps untouched -- and what keeps the count
     * honest, since everything behind it really is the tail.
     *
     * An address that is not one is never hidden behind the count: the field's
     * whole answer to a mistyped address is to mark it where it was entered,
     * and a mark nobody can see is not one. So the list opens as far as the
     * last bad address, however far down it is.
     */
    const shownCount = () => {
      if (expanded || recipients.length <= COLLAPSE_OVER) return recipients.length;
      const lastBad = recipients.reduce(
        (last, address, index) => (ADDRESS_RE.test(address) ? last : index), -1);
      return Math.max(COLLAPSE_OVER, lastBad + 1);
    };

    const render = () => {
      const shown = shownCount();
      const chips = [...box.querySelectorAll('.recipient-chip')];

      // A chip already standing for the right address is left exactly as it
      // is. Replacing one that has not changed would drop the focus a
      // keyboard user has on its remove button, and take the click a pointer
      // user has already started on it.
      let index = 0;
      for (; index < shown; index++) {
        if (chips[index]?.dataset.address === recipients[index]) continue;
        const fresh = chipFor(recipients[index]);
        if (chips[index]) chips[index].replaceWith(fresh);
        else box.insertBefore(fresh, more);
      }
      for (const extra of chips.slice(index)) extra.remove();

      const hidden = recipients.length - shown;
      more.hidden = hidden === 0;
      more.textContent = `+${hidden} more`;
      more.setAttribute('aria-label',
        `Show ${hidden} more recipient${hidden === 1 ? '' : 's'}`);

      // The placeholder is an example of what to put here, so it goes once
      // there are examples on the row already.
      input.placeholder = recipients.length ? '' : placeholder;
    };

    // Returns whether anything was taken out of the input, which is what
    // decides between saving the draft and leaving it alone.
    const commit = (text = input.value) => {
      const added = parseAddresses(text);
      if (!added.length) return false;
      const fresh = [];
      for (const address of added) {
        const key = address.toLowerCase();
        if (recipients.some((already) => already.toLowerCase() === key)) continue;
        recipients.push(address);
        fresh.push(address);
      }
      input.value = '';
      // An address entered is the end of the search for one. Nothing here
      // types, so no fresh list is coming to replace a stale one.
      hideSuggestions();
      render();
      // A duplicate that collapsed is worth saying too: the field looks
      // unchanged, and the reason is that the address was already on it.
      announce(fresh.length ? `${fresh.join(', ')} added.` : 'Already on the message.');
      queueSave();
      if (input.getAttribute('aria-invalid')) clearProblem();
      return true;
    };

    // -- completing against the address book ---------------------------------

    const paintActive = () => {
      [...list.children].forEach((option, index) => {
        option.classList.toggle('is-active', index === active);
        option.setAttribute('aria-selected', String(index === active));
      });
      // Which option is current is said on the input, because that is where
      // focus is and where a screen reader is listening.
      if (active < 0) input.removeAttribute('aria-activedescendant');
      else input.setAttribute('aria-activedescendant', optionId(active));
      list.children[active]?.scrollIntoView?.({ block: 'nearest' });
    };

    const hideSuggestions = () => {
      if (list.hidden) return;
      list.hidden = true;
      offered = [];
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };

    /**
     * Offer what the app has seen that matches what is being typed.
     *
     * Nothing is offered for an empty field, and the reason is the dialog
     * itself: opening Compose focuses To, and a list of names unfurling over
     * the form every time would not be a suggestion but a lid. Nothing is
     * offered mid-address either -- inside quotes or angle brackets the
     * characters being typed are part of a name, not a search for one.
     */
    const suggest = () => {
      const typed = input.value.trim();
      if (!typed || midAddress(input.value)) return hideSuggestions();

      offered = rankContacts(addressBook(), typed, { exclude: recipients });
      if (!offered.length) return hideSuggestions();

      clear(list);
      append(list, offered.map((contact, index) => el('li.suggestion', {
        id: optionId(index),
        role: 'option',
        'aria-selected': 'false',
        // Taking focus off the input would blur it, and blurring commits what
        // is in it and puts this list away -- before the click ever landed on
        // an option. So the press never moves focus at all.
        onmousedown: (event) => event.preventDefault(),
        onclick: () => accept(index),
      },
        el('span.avatar.avatar-sm', {
          'aria-hidden': 'true',
          style: { '--hue': hueFor(contact.email) },
        }, initialFor(contact.name || contact.email)),
        el('span.suggestion-who', {},
          contact.name && el('span.suggestion-name', {}, contact.name),
          el('span.suggestion-address', {}, contact.email),
        ),
      )));

      // Nothing starts highlighted: see the field's own note above. Enter
      // still means the address that was typed until an arrow key says
      // otherwise.
      active = -1;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      paintActive();
    };

    const accept = (index) => {
      const contact = offered[index];
      if (!contact) return false;
      hideSuggestions();
      // The chip holds a bare address -- that is what `parseAddresses` keeps
      // and what a draft stores -- so the name is what the list showed, not
      // something that then has to survive a round trip through the field.
      commit(contact.email);
      input.focus();
      return true;
    };

    /** Returns whether the open list answered this key, and the field must not. */
    const handleSuggestionKey = (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        // From nothing highlighted, Down reaches the first and Up the last.
        active = active < 0
          ? (step > 0 ? 0 : offered.length - 1)
          : (active + step + offered.length) % offered.length;
        paintActive();
        return true;
      }
      if (event.key === 'Escape') {
        // The dialog's own Escape closes it, and this one must not reach
        // that: putting the list away is the whole of what was asked for.
        event.preventDefault();
        event.stopPropagation();
        hideSuggestions();
        return true;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && active >= 0) {
        // Tab is the modal's focus trap as well as this list's accept key, so
        // it is stopped here rather than left to do both.
        event.preventDefault();
        event.stopPropagation();
        accept(active);
        return true;
      }
      // Anything else -- a character, a comma, Backspace -- belongs to the
      // field, which will ask for a fresh list on the way out.
      return false;
    };

    render();
    return {
      input,
      commit,
      value: () => [...recipients, input.value.trim()].filter(Boolean).join(', '),
      row: el('div.compose-field.compose-recipients', {},
        el('label', { htmlFor: id }, label), box, spoken),
    };
  };

  const to = recipientField('compose-to', 'To', start.to, 'someone@example.com');
  const cc = recipientField('compose-cc', 'Cc', start.cc, 'optional');
  // Enter in the subject goes to the message, the way it does in every other
  // mail client -- rather than submitting the form, which on a message with a
  // recipient and a subject and nothing written yet is a send.
  const subject = field('compose-subject', 'Subject', start.subject, '',
    () => focusMessage());
  const editor = createEditor({
    label: 'Message body',
    placeholder: 'Write your message…',
    onInput: () => queueSave(),
    // No inline images here, so a pasted screenshot becomes an attachment.
    // Dropping it on the floor would be the only worse answer.
    onFiles: (files) => addFiles(files),
  });

  // A draft written before there was an editor -- and every reply and forward,
  // whose quoted text is built as text -- arrives with a body and no markup.
  if (start.html) editor.setHtml(start.html);
  else editor.setText(start.body);

  // Where the writing happens. A reply and a forward both arrive with text
  // already in them and are both written above it; everything else is written
  // from the end of what is there.
  const writesAbove = !draft && Boolean(start.body || start.html);
  const focusMessage = () => (writesAbove ? editor.focusStart() : editor.focusEnd());

  // -- autosave --------------------------------------------------------------

  const currentDraft = () => {
    const html = editor.getHtml();
    return {
      id: draftId,
      domain: sendingDomain,
      to: to.value(),
      cc: cc.value(),
      subject: subject.input.value,
      // Both, and not only the markup: `body` is what the drafts folder shows
      // as a preview line and what decides whether a draft counts as empty,
      // and it is what a draft saved before there was an editor holds.
      body: htmlToText(html),
      html,
      inReplyTo: start.inReplyTo,
      references,
      // The count detects missing files if attachment storage is unavailable.
      attachments: attachments.length + missingFiles,
    };
  };

  let saveTimer = null;
  let stored = false;     // whether the store currently holds this draft
  let saveFailed = false; // a quota error: the draft is only in this dialog
  let sent = false;       // a sent message must not come back as a draft
  /**
   * The draft as the store last received it, so a save that would write the
   * same thing again is not made. Every way out of the dialog flushes --
   * close, minimize, the tab going hidden, the page unloading -- and each of
   * them stamped the draft anew whether or not a word had changed: a draft
   * opened to look at and closed again jumped to the top of Drafts with the
   * time of the look, and "Draft saved" was said about a save of nothing.
   */
  let lastSaved = null;
  let wrote = false;      // whether this dialog has stored anything
  const saveState = el('span.compose-save-state', { role: 'status', 'aria-live': 'polite' });
  const updateSaveState = () => {
    saveState.textContent = saveFailed ? 'Draft could not be saved'
      : restoringFiles ? 'Loading attachments…'
      : filesSaving ? 'Saving attachments…'
      : attachments.length && !filesSaved ? (stored ? 'Text saved · attachments not saved' : 'Attachments not saved')
      : stored ? 'Draft saved on this device' : '';
    saveState.classList.toggle('error', saveFailed);
  };

  /**
   * `keep` stores the draft even where nothing was written into it. A message
   * on its way is kept whatever it says: the hold promises that leaving the
   * page keeps the draft, and a reply sent as the bare quote is still a
   * message the writer chose to send.
   *
   * That holds for every flush while the message is going, not only the one
   * the send itself makes: closing the dialog flushes too, and it judged the
   * draft afresh. A reply sent without a word typed above the quote reads as
   * untouched, so the close that follows a held send -- or a close during a
   * send still in flight -- took the draft the send had just stored straight
   * back out, and leaving the page in those seconds lost the message: not
   * sent, not kept.
   */
  const flushSave = (options) => {
    clearTimeout(saveTimer);
    if (sent || discarded || !drafts) return;
    const entry = currentDraft();
    const keep = options?.keep === true || holding || sending;
    if (!keep && blank(entry)) {
      // Emptying every field is a way of discarding it.
      if (stored) {
        drafts.remove(draftId);
        stored = false;
        lastSaved = null;
        onDraftsChanged?.();
      }
      saveFailed = false;
      updateSaveState();
      return;
    }
    const key = JSON.stringify(entry);
    if (stored && !saveFailed && key === lastSaved) {
      updateSaveState();
      return;
    }
    saveFailed = !drafts.save(entry);
    stored = !saveFailed;
    if (stored) {
      lastSaved = key;
      wrote = true;
    }
    updateSaveState();
    onDraftsChanged?.();
  };

  // Typing writes on a debounce rather than per keystroke, and every close
  // path flushes, so what is stored is never more than a moment behind.
  const queueSave = () => {
    if (sent || discarded || sending) return;
    warnedOnClose = false;
    clearTimeout(saveTimer);
    if (drafts) saveState.textContent = 'Saving…';
    saveTimer = setTimeout(flushSave, 600);
  };

  const forget = () => {
    clearTimeout(saveTimer);
    if (!drafts) return;
    const had = stored || Boolean(drafts.get(draftId));
    drafts.remove(draftId);
    stored = false;
    if (had) onDraftsChanged?.();
  };

  // -- attachments -----------------------------------------------------------

  // One entry per attached file: bytes stay null until the read resolves,
  // which is what the "Reading…" chip and the send-time wait are about.
  const attachments = [];
  const saveFiles = () => {
    if (closed || sent || discarded || restoringFiles) return;
    const revision = ++filesRevision;
    filesSaving = false;
    filesSaved = false;
    if (!drafts?.saveAttachments || attachments.some((item) => !item.bytes || item.error)) {
      updateSaveState();
      return;
    }
    filesSaving = true;
    const snapshot = attachments.map(({ filename, type, bytes }) => ({ filename, type, bytes }));
    updateSaveState();
    Promise.resolve(drafts.saveAttachments(draftId, snapshot))
      .then((ok) => { if (revision === filesRevision) filesSaved = ok !== false; })
      .catch(() => { if (revision === filesRevision) filesSaved = false; })
      .finally(() => {
        if (revision !== filesRevision) return;
        filesSaving = false;
        // Closing already saved the text. A late file write must not replace
        // newer edits made after reopening this same draft.
        if (!closed) flushSave();
      });
  };
  let nextId = 0;

  const fileInput = el('input', {
    type: 'file', multiple: true, hidden: true, tabindex: -1,
    onchange: () => {
      addFiles([...fileInput.files]);
      // Without this, picking the same file twice fires no change event.
      fileInput.value = '';
    },
  });

  // What the list adds up to, kept as one node at the end of it rather than
  // rebuilt: everything above it is addressed by position.
  const attachTotal = el('p.attach-total');

  const attachList = el('div.compose-attachments', {
    role: 'group', 'aria-label': 'Attachments', hidden: true,
  }, attachTotal);

  /**
   * One node per file, built once and repainted as its read lands.
   *
   * The list used to be thrown away and rebuilt on every change, and one of
   * the changes is "another file finished reading" -- which happens on its own
   * schedule, while the writer is doing something else. A chip replaced under
   * a pointer takes the click that had already started on it: pressing Remove
   * on one file did nothing at all if a second file's read landed in the
   * moment between the press and its release. Under the keyboard it took the
   * focus instead.
   */
  const attachChip = (item) => {
    const name = safeFilename(item.filename);
    const size = el('span.chip-size');
    const chip = el('span.chip', {},
      el('span.chip-icon'),
      el('span.chip-name', { title: name }, name),
      size,
      el('button.chip-remove', {
        type: 'button', html: icon('x', 14),
        'aria-label': `Remove ${name}`, title: `Remove ${name}`,
        onclick: () => {
          attachments.splice(attachments.indexOf(item), 1);
          renderAttachments();
          saveFiles();
          queueSave();
          if (status.classList.contains('error')) clearProblem();
          attachBtn.focus();
        },
      }),
    );

    item.node = chip;
    item.paint = () => {
      const pending = !item.bytes && !item.error;
      chip.classList.toggle('is-error', Boolean(item.error));
      chip.setAttribute('aria-busy', String(pending));
      size.classList.toggle('loading-delayed', pending && !item.size);
      // Keep the icon container: repainting a different attachment must not
      // restart this pending file's delayed spinner.
      const glyph = item.error ? 'alert' : 'paperclip';
      if (chip.firstChild.dataset.icon !== glyph) {
        chip.firstChild.dataset.icon = glyph;
        chip.firstChild.innerHTML = icon(glyph, 14);
      }
      size.textContent = item.error ? (typeof item.error === 'string' ? item.error : 'Could not be read')
        : item.bytes || item.size ? formatSize(item.bytes?.length ?? item.size)
        : 'Reading…';
    };
    return chip;
  };

  const renderAttachments = () => {
    attachList.hidden = attachments.length === 0;

    attachments.forEach((item, index) => {
      const node = item.node ?? attachChip(item);
      item.paint();
      const at = attachList.children[index];
      if (at !== node) attachList.insertBefore(node, at ?? attachTotal);
    });
    // Whatever is left between the last chip and the running total is a file
    // that has been taken off the message.
    while (attachList.children.length > attachments.length + 1) {
      attachList.children[attachments.length].remove();
    }

    const total = attachments.reduce((sum, a) => sum + (a.bytes?.length ?? 0), 0);
    const over = total > MAX_ATTACHMENT_BYTES;
    attachTotal.className = `attach-total${over ? ' over' : ''}`;
    attachTotal.textContent =
      `${attachments.length} attachment${attachments.length === 1 ? '' : 's'} · ${formatSize(total)}`
      + (over ? ` of ${formatSize(MAX_ATTACHMENT_BYTES)} allowed` : '');
  };

  // `read` is a thunk so a large file is only pulled into memory once, and
  // the same code covers a local File and a Puter FSItem.
  const attach = ({ filename, type, read, size }) => {
    if (closed || sending || sent || discarded) return;
    if (restoringFiles) { setStatus('Wait for draft attachments to load.', 'error'); return; }
    const reserved = attachments.reduce((sum, item) => sum + (item.bytes?.length ?? item.size ?? 0), 0);
    const item = {
      id: ++nextId,
      filename: filename || 'attachment',
      type: type || 'application/octet-stream',
      bytes: null,
      error: null,
      size: Number(size) || 0,
    };
    attachments.push(item);
    renderAttachments();
    queueSave();
    ++filesRevision;
    filesSaving = false;
    filesSaved = false;
    if (size > MAX_ATTACHMENT_BYTES || reserved + (Number(size) || 0) > MAX_ATTACHMENT_BYTES) {
      item.error = 'File exceeds the attachment limit';
      renderAttachments();
      setStatus(`Attachments exceed ${formatSize(MAX_ATTACHMENT_BYTES)}. Remove a file to continue.`, 'error');
      return;
    }
    Promise.resolve().then(read)
      .then((bytes) => { item.bytes = bytes; })
      .catch(() => { item.error = true; })
      .finally(() => {
        if (attachments.includes(item)) {
          renderAttachments();
          saveFiles();
        }
      });
  };

  const addFiles = (files) => {
    for (const file of files) {
      attach({ filename: file.name, type: file.type, size: file.size, read: () => readBlob(file) });
    }
  };

  // Forwarding carries the original attachments over. They are already
  // decoded in the open message, so `read` just hands the bytes across.

  const attachBtn = el('button.icon-btn', {
    type: 'button', html: icon('paperclip', 18),
    'aria-label': 'Attach files from this device', title: 'Attach files',
    onclick: () => fileInput.click(),
  });

  // Inside a cloud OS the other obvious source is the user's own files.
  const puterBtn = window.puter?.ui?.showOpenFilePicker && el('button.icon-btn', {
    type: 'button', html: icon('folder', 18),
    'aria-label': 'Attach files from your Puter files', title: 'Attach from Puter',
    onclick: async () => {
      let picked;
      try {
        picked = await puter.ui.showOpenFilePicker({ multiple: true });
      } catch {
        return; // the picker throws when it is dismissed
      }
      for (const fsItem of (Array.isArray(picked) ? picked : [picked]).filter(Boolean)) {
        attach({
          filename: fsItem.name,
          type: fsItem.type,
          size: fsItem.size,
          read: async () => readBlob(await fsItem.read()),
        });
      }
    },
  });

  const status = el('p.compose-status', { id: 'compose-status', role: 'status' });
  // Whether the reader has already been told what closing would cost. Said
  // once per dialog: the second close is the answer.
  const setStatus = (text, kind = '') => {
    status.textContent = text;
    status.className = `compose-status${kind ? ` ${kind}` : ''}`;
  };

  /**
   * A failure has to land somewhere the writer will see it. The status line
   * goes with the dialog, and the dialog can be gone by the time a slow send
   * comes back -- closing it keeps the draft, so leaving is a reasonable thing
   * to do while waiting. Reported into a toast in that case rather than into a
   * node that is no longer on the page, which is what "the send failed and
   * nothing was said" looked like.
   */
  const reportFailure = (message) => {
    if (status.isConnected) setStatus(message, 'error');
    if (!status.isConnected || dockItem) toast(message, { iconName: 'alert', duration: 15000, action: {
      label: 'Reopen draft',
      onSelect: () => openCompose({ ...reopenWith,
        draft: { ...currentDraft(), attachments: missingFiles },
        prefill: { attachments: attachments.filter((item) => item.bytes).map((item) => ({
          filename: item.filename, type: item.type, read: async () => item.bytes,
        })) },
      }),
    } });
  };

  const clearProblem = () => {
    attachList.classList.remove('invalid');
    for (const f of [to, cc, subject]) {
      f.input.removeAttribute('aria-invalid');
      f.input.removeAttribute('aria-describedby');
      f.row.classList.remove('invalid');
    }
    if (status.classList.contains('error')) setStatus('');
  };

  /**
   * Put the problem on the control that has to change. The message alone,
   * parked next to the Send button at the foot of the dialog, left the user
   * to work out which of three fields it meant. aria-describedby means the
   * field announces the reason when focus lands on it, so the message does
   * not need an assertive live region to be heard.
   */
  const showProblem = (message, fieldName) => {
    clearProblem();
    setStatus(message, 'error');
    if (fieldName === 'attachments') {
      attachList.classList.add('invalid');
      attachBtn.focus();
      return;
    }
    const target = { to, cc, subject }[fieldName];
    if (!target) return;
    target.input.setAttribute('aria-invalid', 'true');
    target.input.setAttribute('aria-describedby', status.id);
    target.row.classList.add('invalid');
    target.input.focus();
  };

  const sendBtn = el('button.btn.btn-primary', {
    type: 'submit',
    title: `Send (${MOD}Enter)`,
  }, el('span.btn-icon', { html: icon('send', 15) }), 'Send');

  /**
   * The send, while it is happening. Nothing on the button said so -- a line
   * of grey text above it was the whole of it -- and Discard sat live beside
   * it the entire time, so a message already on its way could be thrown away
   * underneath itself: the draft went, and a failure afterwards had no draft
   * left to fall back to.
   */
  const setSending = (on) => {
    sending = on;
    for (const control of form.querySelectorAll('input, select, button')) control.disabled = on;
    editor.body.setAttribute('contenteditable', String(!on));
    editor.body.setAttribute('aria-readonly', String(on));
    sendBtn.classList.toggle('is-busy', on);
    sendBtn.setAttribute('aria-busy', String(on));
    if (discardBtn) discardBtn.disabled = on;
  };

  // Closing keeps the draft, so throwing one away needs a control of its own.
  // It is undoable, because a discarded draft is otherwise gone for good.
  const discardBtn = drafts && el('button.icon-btn', {
    type: 'button', html: icon('trash', 18),
    'aria-label': 'Discard draft', title: 'Discard draft',
    onclick: () => {
      const gone = currentDraft();
      const keptFiles = attachments.filter((item) => item.bytes)
        .map(({ filename, type, bytes }) => ({ filename, type, bytes }));
      modal.discard();
      if (blank(gone)) return;
      toast('Draft discarded.', {
        iconName: 'trash',
        action: {
          label: 'Undo',
          onSelect: () => {
            drafts.save(gone);
            if (drafts.saveAttachments) drafts.saveAttachments(gone.id, keptFiles).catch(() => {});
            onDraftsChanged?.();
          },
        },
      });
    },
  });

  // Older drafts and unavailable attachment storage need an explicit warning.
  // It is removed once the asynchronous file restore succeeds.
  const draftNote = draft?.attachments
    ? el('p.compose-note', {}, draft.attachments === 1
      ? 'One attachment was not saved with this draft. Add it again before sending.'
      : `${draft.attachments} attachments were not saved with this draft.`
        + ' Add them again before sending.')
    : null;

  /**
   * Send from the keyboard.
   *
   * Every field in this form except one submits on Enter, and the one that
   * does not is the message -- where Enter is a new line and always will be,
   * and where the writer is standing when the message is finished. So the way
   * out of a finished message was to leave the keyboard, find the pointer and
   * come back: the single most common thing anyone does in this dialog was the
   * only one with no key.
   *
   * The button rather than the form, so a send already in flight -- which is
   * exactly when the button is disabled -- is not started a second time by an
   * impatient second press.
   */
  const onFormKey = (event) => {
    if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    sendBtn.click();
  };

  const form = el('form.compose-form', { onkeydown: onFormKey },
    el('div.compose-content', {},
      el('div.compose-from', {},
        el('span.compose-from-label', {}, 'From'),
        el('strong', {}, fromAddress),
        saveState,
      ),
      to.row, cc.row, subject.row,
      editor.root,
      draftNote,
      attachList,
    ),
    // Outside the scroll area so neither the message nor its focus ring can
    // slide underneath the controls. Errors retain their own full-width row.
    el('div.compose-footer', {},
      status,
      el('div.compose-actions', {}, sendBtn, attachBtn, puterBtn, fileInput, discardBtn)),
    el('div.compose-drop', { 'aria-hidden': 'true' },
      el('span.compose-drop-inner', {},
        el('span', { html: icon('paperclip', 20) }), 'Drop files to attach')),
  );

  // -- drop target -------------------------------------------------------------

  // Only file drags are intercepted: dragging text into the body should still
  // drop text into the body.
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  let dragDepth = 0;
  const endDrag = () => {
    dragDepth = 0;
    form.classList.remove('dropping');
  };

  form.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    form.classList.add('dropping');
  });
  form.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  form.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    if (--dragDepth <= 0) endDrag();
  });
  form.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    endDrag();
    if (status.classList.contains('error')) clearProblem();
    addFiles([...(event.dataTransfer.files ?? [])]);
  });

  const modal = openModal({
    title: draft ? 'Draft'
      : prefill.kind === 'reply' ? 'Reply'
      : prefill.kind === 'replyAll' ? 'Reply all'
      : prefill.kind === 'forward' ? 'Forward'
      : prefill.kind === 'unsubscribe' ? 'Unsubscribe'
      : 'New message',
    content: form,
    /**
     * Closing no longer loses anything, so it no longer asks -- except for
     * what closing really would lose: attachments, whose bytes are not
     * stored, and a draft the store refused to keep.
     *
     * It says so and lets the next close through, rather than asking with
     * `window.confirm`. A Puter app runs in a cross-origin iframe, where
     * Chrome suppresses the native dialogs and answers `false` without showing
     * anything -- which here meant "veto the close": Escape, the scrim and the
     * ✕ all did nothing and the dialog could not be closed at all.
     */
    beforeClose: () => {
      flushSave();
      if (blank(currentDraft())) return true;
      const cost = saveFailed
        ? 'This draft could not be saved, so closing loses it. Close again to discard it.'
        : attachments.length && !filesSaved
          ? filesSaving
            ? 'Attachments are still saving. Wait, or close again to keep just the text.'
            : 'Attachments could not be saved with this draft. Close again to keep just the text.'
          : null;
      if (!cost || warnedOnClose) return true;
      warnedOnClose = true;
      setStatus(cost, 'error');
      return false;
    },
    onClose: () => {
      closed = true;
      openDrafts.delete(pendingKey(draftId));
      removeDockItem();
      flushSave();
      clearTimeout(saveTimer);
      window.removeEventListener('pagehide', flushSave);
      document.removeEventListener('visibilitychange', saveWhenHidden);
      // A message on its way is not a draft that was put down, even though
      // the store still holds it until the send has gone through.
      if (wrote && !sent && !holding && !sending) toast('Draft saved.', { iconName: 'pencil' });
    },
  });
  modal.panel.classList.add('compose-panel');
  modal.restore = () => {
    removeDockItem();
    modal.resume();
  };
  /**
   * Throw the message away: the draft leaves the store and the dialog closes
   * without saving it again on the way out. The Discard button's own path,
   * and the one a discard made from the Drafts folder takes to a composer
   * that is still open for the same draft.
   */
  modal.discard = ({ focusOpener = true } = {}) => {
    discarded = true;
    forget();
    modal.close(true, { focusOpener });
  };
  modal.minimize = () => {
    if (closed || dockItem) return;
    flushSave();
    let dock = document.querySelector('.compose-dock');
    if (!dock) {
      dock = el('div.compose-dock', { role: 'region', 'aria-label': 'Minimized drafts' });
      document.body.append(dock);
    }
    const title = subject.input.value.trim() || 'New message';
    dockItem = el('div.compose-dock-item', {},
      el('button.compose-dock-restore', {
        type: 'button', title: `Restore ${title}`, 'aria-label': `Restore draft: ${title}`,
        onclick: () => modal.restore(),
      }, el('span', { html: icon('pencil', 16) }), el('span.compose-dock-title', {}, title)),
      el('button.icon-btn', {
        type: 'button', html: icon('x', 16), 'aria-label': `Close draft: ${title}`,
        title: 'Close and save draft', onclick: () => { modal.restore(); modal.close(); },
      }),
    );
    dock.append(dockItem);
    // The list and the reader leave room for the dock at their end, so their
    // last row can be scrolled out from under it.
    document.documentElement.classList.add('has-compose-dock');
    modal.suspend();
    if (document.activeElement === document.body) dockItem.querySelector('button').focus();
  };
  openDrafts.set(pendingKey(draftId), modal);
  const minimizeBtn = el('button.icon-btn', {
    type: 'button', html: icon('minimize', 17), title: 'Minimize composer',
    'aria-label': 'Minimize composer',
    onmousedown: (event) => event.preventDefault(),
    onclick: () => modal.minimize(),
  });
  const saveWhenHidden = () => { if (document.visibilityState === 'hidden') flushSave(); };
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', saveWhenHidden);
  const expandBtn = el('button.icon-btn', {
    type: 'button', html: icon('maximize', 17), title: 'Expand composer',
    'aria-label': 'Expand composer', 'aria-pressed': 'false',
    onclick: () => {
      const expanded = modal.panel.classList.toggle('compose-expanded');
      expandBtn.setAttribute('aria-pressed', String(expanded));
      expandBtn.setAttribute('aria-label', expanded ? 'Restore composer size' : 'Expand composer');
      expandBtn.title = expanded ? 'Restore composer size' : 'Expand composer';
    },
  });
  modal.panel.querySelector('.modal-head').insertBefore(minimizeBtn, modal.panel.querySelector('[aria-label="Close dialog"]'));
  modal.panel.querySelector('.modal-head').insertBefore(expandBtn, modal.panel.querySelector('[aria-label="Close dialog"]'));
  for (const attachment of prefill.attachments ?? []) attach(attachment);
  if (!draft) untouchedKey = keyOf(currentDraft());
  if (missingFiles && drafts?.loadAttachments) {
    restoringFiles = true;
    if (draftNote) draftNote.hidden = true;
    updateSaveState();
    drafts.loadAttachments(draftId).then((files) => {
      if (closed) return;
      const valid = files.filter((file) => file.bytes instanceof Uint8Array && typeof file.filename === 'string');
      for (const file of valid) {
        attachments.push({ ...file, id: ++nextId, error: null });
      }
      missingFiles = Math.max(0, missingFiles - valid.length);
      filesSaved = true;
      if (!missingFiles) draftNote?.remove();
      renderAttachments();
    }).catch(() => {}).finally(() => {
      restoringFiles = false;
      if (draftNote) draftNote.hidden = missingFiles === 0;
      updateSaveState();
    });
  }
  if (draft) {
    // The store holds this draft already, as it stands now: a save that finds
    // it unchanged has nothing to write.
    stored = true;
    lastSaved = JSON.stringify(currentDraft());
    // Carry on where the draft left off.
    editor.focusEnd();
  } else if (prefill.kind === 'forward') {
    // A forward has no recipient yet, and that is the first thing to fill in.
    to.input.focus();
  } else if (prefill.to) {
    // Reply-above: the caret goes to the top, over the quoted message.
    focusMessage();
  } else {
    to.input.focus();
  }

  /**
   * Post the message, asking for mailbox access the one time the server says
   * it is missing, and file the copy once it has gone. Reports into the status
   * line while the dialog is up and into a toast once it is not, which is the
   * normal case for a held send. Resolves to whether the message went.
   */
  const send = async (message, outgoing, sentAt) => {
    try {
      let result = await deliver(message);

      if (needsMailAccess(result)) {
        setStatus(`Asking for write access to ${mailPath}…`);
        if (!(await requestMailWrite(mailPath))) {
          reportFailure(
            `Sending needs write access to ${mailPath}. If you did not decline,`
            + ' the folder may not exist yet. It is created when your first'
            + ' message arrives.',
          );
          return false;
        }
        result = await deliver(message);
      }

      if (!result.ok) {
        reportFailure(result.message);
        return false;
      }

      const count = outgoing.to.length + outgoing.cc.length;
      sent = true;
      forget();
      modal.close(true); // idempotent: a held send closed it already
      toast(`Sent to ${count} recipient${count === 1 ? '' : 's'}.`, { iconName: 'send' });

      // The copy is filed after the dialog has gone: the send is already
      // done, and nothing here can undo it.
      try {
        const filed = await fileSentCopy({
          fs: puter.fs, mailPath, raw: message, subject: outgoing.subject, date: sentAt,
        });
        // Told where, so the shell knows the file that has just appeared in
        // Sent is its own rather than another device's.
        onFiled?.(filed);
      } catch {
        toast('Sent, but the copy could not be saved to Sent.', { iconName: 'alert' });
      }
      return true;
    } catch (e) {
      reportFailure(`Could not reach the server: ${e?.message ?? e}`);
      return false;
    } finally {
      pendingDrafts.delete(pendingKey(draftId));
    }
  };

  // Whether the dialog closed on a send that is being held rather than on the
  // writer putting the message down.
  let holding = false;

  /**
   * Hold the message for a moment before it goes.
   *
   * Sending is the one thing in this app nobody can take back, and the moment
   * after pressing Send is when the missing attachment, the wrong name and
   * the typo in the first line are all noticed. So the dialog closes as if
   * the message had gone, and a toast holds it for `undoSend` seconds with
   * the one word that brings it back. Undo reopens the same message --
   * attachments included, even when durable file storage is unavailable.
   *
   * The draft stays stored throughout the hold. Leaving the page cancels
   * delivery and keeps that draft: an unload request cannot guarantee delivery
   * and must not shorten the cancellation period. Success removes the draft.
   */
  const hold = (message, outgoing, sentAt) => {
    flushSave({ keep: true });
    const entry = currentDraft();
    const kept = attachments.filter((item) => item.bytes);
    holding = true;
    pendingDrafts.set(pendingKey(draftId), modal);
    modal.close(true);

    let settled = false;
    let timer = null;
    let dismiss = () => {};
    const fire = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('pagehide', leave);
      dismiss();
      send(message, outgoing, sentAt);
    };
    // A browser cannot guarantee an asynchronous POST while unloading. Keep
    // the draft instead of shortening Undo and risking an ambiguous delivery.
    const leave = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('pagehide', leave);
      pendingDrafts.delete(pendingKey(draftId));
      dismiss();
    };
    // The same way out, for a discard made from the Drafts folder while the
    // message is held: the hold is given up and the draft goes with it.
    modal.cancelHold = leave;
    const count = outgoing.to.length + outgoing.cc.length;
    dismiss = toast(`Sending to ${count} recipient${count === 1 ? '' : 's'}… Keep this tab open.`, {
      iconName: 'send',
      duration: undoSend * 1000 + 400,
      action: {
        label: 'Undo',
        onSelect: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('pagehide', leave);
          pendingDrafts.delete(pendingKey(draftId));
          openCompose({
            ...reopenWith,
            // The store holds the text; the bytes come back from here, so the
            // count that would say they were lost is left off.
            draft: { ...entry, attachments: 0 },
            prefill: {
              attachments: kept.map((item) => ({
                filename: item.filename, type: item.type, read: async () => item.bytes,
              })),
            },
          });
        },
      },
    });
    timer = setTimeout(fire, undoSend * 1000);
    window.addEventListener('pagehide', leave);
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending || holding || sent || closed) return;
    if (restoringFiles) { setStatus('Wait for draft attachments to load.', 'error'); return; }
    // Whatever is still being typed is part of the message: an address left
    // in the field when Send was clicked becomes a recipient here, so it is
    // visibly on the message -- or visibly not an address -- before the draft
    // is judged.
    to.commit();
    cc.commit();
    // `outgoing`, not `draft`: the draft being resumed is a different thing
    // and shadowing it here would be a trap.
    const primary = parseAddresses(to.value());
    const addressed = new Set(primary.map((address) => address.toLowerCase()));
    const outgoing = {
      to: primary,
      cc: parseAddresses(cc.value()).filter((address) => !addressed.has(address.toLowerCase())),
      subject: subject.input.value,
      attachments,
    };

    const problem = draftProblem(outgoing);
    if (problem) {
      showProblem(problem, draftProblemField(outgoing));
      return;
    }
    clearProblem();

    const body = htmlToText(editor.getHtml());
    const reviewKey = JSON.stringify([outgoing.to, outgoing.cc, outgoing.subject, body, attachments.length, missingFiles]);
    if ((missingFiles || (!attachments.length && mentionsAttachment(body))) && reviewed !== reviewKey) {
      reviewed = reviewKey;
      setStatus(missingFiles
        ? 'This draft has missing attachments. Add them again, or press Send again to send without them.'
        : 'Your message mentions an attachment, but no files are attached. Add a file, or press Send again to send anyway.', 'error');
      attachBtn.focus();
      return;
    }

    const sentAt = new Date();
    const html = editor.getHtml();
    let message;
    try { message = buildMessage({
      from: fromAddress,
      ...outgoing,
      body: htmlToText(html),
      // Only where there is something an HTML part would actually carry. A
      // message that was typed and not formatted goes out as one text/plain
      // part, which is smaller, plainer, and what this app always sent.
      html: hasFormatting(html) ? messageHtml(html) : '',
      messageId: `<${crypto.randomUUID()}@${sendingDomain}>`,
      date: sentAt,
      inReplyTo: start.inReplyTo,
      references,
    }); } catch (error) { setStatus(error.message, 'error'); return; }

    if (undoSend > 0) {
      hold(message, outgoing, sentAt);
      return;
    }

    flushSave({ keep: true });
    pendingDrafts.set(pendingKey(draftId), modal);
    setSending(true);
    setStatus('Sending…');
    try {
      await send(message, outgoing, sentAt);
    } finally {
      setSending(false);
    }
  });

  return modal;
}
