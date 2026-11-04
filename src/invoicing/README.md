# Invoicing & Estimates

**Live app:** [invoicing.puter.com](https://invoicing.puter.com/)

Create quotes, invoices, recurring invoices, receipts, and payment links. Deliberately simpler than a full accounting app, and built to feed one: every payment you record can be exported straight into the [Personal Finance](https://github.com/HeyPuter/accountant) app.

Everything is stored in the user's own [Puter](https://developer.puter.com) cloud. There is no server of ours, no database of ours, and no tracking.

## Features

- **Estimates (quotes)**: send, mark accepted or declined, and convert to an invoice in one tap. Expiry derives from the valid-until date.
- **Invoices**: draft, send, and track. Paid, partly paid, and overdue states derive from recorded payments and the due date, so there is no status to keep in sync by hand. **New from last** starts the next invoice from the most recent one — everything copied onto today's dates and fully editable, nothing saved (not even a number) until Create is pressed.
- **Send by email**: one action publishes the online copy, fills your template, and shows you the message with To, Subject, and body still editable. Send it from the app — the invoice rides along as a PDF, and the document keeps a record of what went to whom — or hand the text to your own mail client, or copy it for webmail. Sending a draft marks it as sent. See [Sending email](#sending-email).
- **Payment reminders**: chase an unpaid invoice with wording that matches how late it is, and every nudge is recorded on the document, so "have I already chased this?" has an answer.
- **Recurring invoices**: retainers and subscriptions draft themselves on schedule (weekly, monthly, quarterly, yearly), ready to review and send. Missed periods are capped so a long-paused schedule never floods the account, and a schedule can end on a date or after a set number of invoices.
- **Receipts and refunds**: every recorded payment gets a numbered, printable receipt, and money can flow back out — a refund is capped at what was actually paid, reopens the balance, and prints as its own refund receipt.
- **Reports**: invoiced against collected for any year, quarter, or month, tax collected prorated by what was actually paid, clients ranked by revenue, and **outstanding by age** (not yet due, 1–30, 31–60, 61–90, 90+) with every figure a link to the invoices behind it — per currency, with a CSV for your accountant.
- **One total across currencies**: bill in someone else's money and record what it was worth in yours that day; reports add a consolidated block converted per document, and say out loud what carried no rate. Nothing is fetched from the internet.
- **Payment schedules**: split an invoice into installments with their own dates and shares; payments fill them in date order, and the invoice is overdue as soon as the earliest unpaid part is — while only that part counts as overdue on Home, in the aging table, on the client's statement, and in a percentage late fee.
- **Units and a price list**: bill in hours, days, or words, and correct what the app has learned — Saved items keeps the descriptions, rates, units, and tax treatments the editor fills in for you. A saved item can just as well be a **timekeeper** — a person's name with their hourly rate — and every line can carry its own **work description**, printed under the name on the paper, the PDF, and the share page.
- **Write-offs**: give up on an uncollectible invoice without pretending it was never billed. It leaves Outstanding and aging, stays in invoiced, and reports what it cost you.
- **Tax notes**: reverse charge, zero-rated export, an exemption certificate — the sentence a zero-tax invoice is required to carry, defaulted per account or per client and printed in the document's own language.
- **Attachments**: keep the signed estimate or the timesheet beside the invoice in your own cloud, and optionally offer them on the shared page or send them with the email.
- **A trash, not a void**: deleting anything — a document, a client, a payment, a schedule — is recoverable for 30 days, with Undo right in the toast.
- **Clients**: each client has a page with their whole history, per-currency totals, optional billing defaults (currency, terms, tax rate, notes, tax note) that new documents start from, and a printable statement of account.
- **Branding**: a logo and an accent color on every invoice, estimate, receipt, and statement. Logos are resized and embedded, so a shared page needs nothing from the internet.
- **Payment links**: attach a PayPal.me handle or any custom checkout URL template, and each invoice carries a "pay online" link pre-filled with its balance.
- **Public share pages**: publish an invoice or estimate as an unlisted page on a `*.puter.site` subdomain in the user's own account, with Pay and Download PDF buttons. Un-share deletes the page.
- **PDF and print**: documents, receipts, and statements save as real PDF files with selectable text — or print as the same clean paper.
- **Personal Finance integration**: one click exports all payments as income rows in a CSV shaped for the accountant app's import wizard; refunds export as negative income.
- **Backup and restore**: download the whole account as JSON, and put it back — validated before anything is written.
- **CSV import**: arrive from another app with your clients and your unpaid invoices. Map the columns, see exactly what will be created (and what will be skipped, and why), then write. And inside the editor, **Fill from a spreadsheet** turns a CSV or an Excel workbook (.xlsx, read by a small dependency-free reader in `src/lib/xlsx.js`) of line items — a timesheet of timekeepers, hours, and work descriptions — into the document's lines; a description that matches a saved item fills its rate from the price list.
- **Installable and readable offline**: a service worker precaches the shell, and an opt-in copy on the device opens your last-loaded data read-only when the cloud is out of reach — PDFs included, because the writer is local.
- Dark/light/system theme, responsive app-like layout with a bottom tab bar on mobile.

## Stack

- Vanilla JavaScript (no framework), [Vite](https://vitejs.dev) for dev/build, [Lucide](https://lucide.dev) for icons.
- [Puter.js](https://docs.puter.com) for auth, key-value store, file storage, static hosting, and — through one shared worker — outbound email.
- [Vitest](https://vitest.dev) for unit tests over the pure logic (money math, statuses, schedules, reports, aging, message templates, backups, the PDF writer, CSV import and export, the offline snapshot, the email worker).
- PDFs are written by a small generator in `src/lib/pdf.js` — no dependency, base-14 fonts, loaded only when someone asks for one.

## Storage design

KV holds the small, hot documents (settings, clients, saved items, recurring rules, and an index of years). Full documents live in one JSON file per issue year at `invoicing-data/docs-YYYY.json`, so reads scale with the years you have, not lifetime volume. Attachments sit beside them in `invoicing-data/attachments/<document>/`. Share pages are written to `invoicing-data/public/` and served through a hosting subdomain created once per account. The business logo lives in settings as a downscaled data URI, so every document — including a published page — carries its own copy.

Deleting is a flag, not a removal: `deletedAt` keeps a document in its year file (and a client or schedule in its KV list) for 30 days, out of every list, report, and total, until a boot-time purge takes it for good. The only data ever kept on the device is the optional offline snapshot, which is off by default and cleared on sign-out.

## Sending email

The app has no server, and this feature does not give it one. Sending goes
through a single Puter worker — `src/workers/email-worker.js` — deployed **once,
by the app owner**, because outbound mail has to be authorized by a worker's own
token and that capability has to live somewhere the app controls.

The cost does not live there. `src/lib/mailer.js` calls the worker with
`puter.workers.exec()`, which forwards the signed-in user's own Puter token, and
every message is sent with that token in hand: each send is **billed to, and
rate-limited as, the person who pressed Send**, never the app owner. Nobody's
mail passes through a server of ours, and nothing about a document is stored on
the worker's side — its records are SHA-256 hashes of (user, document, address)
triples with a message digest against them, so a dump of that storage reveals no
address, no document number, and no amount.

**What the worker will and will not do.** The wording is the product here — you
edit the templates in Settings and edit the filled-in result again on the compose
sheet — so unlike an invitation service the worker cannot compose the whole
message itself. It takes the subject and body as **text**, escapes them, and lays
them out itself, so nothing can inject markup, an image, or a tracking pixel. The
only clickable links in a sent message are the two it validates: the document's
own share page (https, on the `*.puter.site` subdomain in your account, the exact
`<token>.html` shape the app publishes) and its pay-online link, which is always
shown as its own URL so the recipient reads where it goes. Recipients are capped
per message and per user per day, attachments are capped in count and size, and a
message a recipient already received is skipped rather than re-sent — pressing
Send twice costs one email, and the button offers "Send it again" for when you
mean it.

**What it adds over `mailto:`.** A mail client cannot be handed a file, cannot be
asked whether it sent anything, and does not exist at all on plenty of machines.
Sending from the app attaches the invoice as a PDF (and any of the document's own
files you tick), and writes what actually went out onto the document — the
**Delivered** card on its page is the answer to "did the client ever get this?".
Both older paths are still there, unchanged, for anyone who prefers them: **Open
email app** hands the wording to `mailto:`, and **Copy message** puts it on the
clipboard. Offline, those two are all the sheet offers, because they are the only
two that can work.

### Deploying the email worker

Users of the hosted app need nothing; this is for anyone running their own copy.

```sh
npm install -g puter-cli          # if you don't have it
puter login
npm run deploy:email-worker       # puter worker deploy src/workers/email-worker.js invoicing-email
curl https://invoicing-email.puter.work/health    # {"ok":true,"version":"6"}
```

`GET /whoami` is the self-test for "why am I getting a 401": call it through the
app's own `puter.workers.exec()` and it reports what the worker can see of your
session — names and presence only, never a token.

Until it is deployed, the compose sheet still offers Send — the app cannot know
whether a worker is there without asking, and asking on every compose would cost
a round trip to answer a question that is the same all day. Pressing it reports
that the email service is unavailable and leaves the sheet open on the mail app
and the clipboard; nothing is silently dropped. To run the worker under a name of
your own, deploy it under that name and point `EMAIL_WORKER_URL` in
`src/lib/mailer.js` at it.

## Development

```sh
npm install
npm run dev          # served with the real Puter SDK (requires sign-in)
```

Open `/mock.html` on the dev server to run against an in-memory mock of the Puter SDK instead: no account needed, and onboarding plus the sample dataset are exercised from scratch on every reload.

```sh
npm test             # unit tests
npm run build        # production build to dist/
```

## Notes

- When running inside the Puter desktop (`puter.env === 'app'`), the sign-out control is hidden; sessions belong to the OS shell there.
- Sample data is available from onboarding and can be wiped from the banner at any time.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
