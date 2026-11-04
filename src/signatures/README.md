# Signatures

**Live app:** [sign.puter.com](https://sign.puter.com/)

Send documents for signature and manage them. A DocHub-style signing app built with vanilla JavaScript and [Puter](https://puter.com) as the only backend: your documents live in your own Puter cloud, and signers get private links that work without any account.

## What it does

- **Build**: one document from several files — PDFs merged in the order you give them, images (JPEG, PNG, and HEIC where the browser can decode it) one per page scaled to fit US Letter. Add more pages to a draft later, and fix up what came out wrong: reorder, rotate, or delete a page from a thumbnail strip, with the fields on it following along.
- **Prepare**: upload a PDF, add signers, and place signature, initials, date, text, and checkbox fields by tapping the page or dragging to draw them to size. Drag to move, corner handle to resize, arrow keys to nudge, Escape to cancel. Each field can carry a label, help text, an accepted input type (text / number / email / date), and a value you fill in yourself — optionally read-only, so the signer sees it but cannot change it.
- **Place fields fast**: copy one field onto every page or a page range (initials on a 20-page agreement in one action), duplicate with ⌘/Ctrl+D, copy and paste, shift-click to select several and move, align, resize, or reassign them together. Dragging snaps to nearby field edges and a light grid, with the size shown in points, and the page rail jumps you around.
- **Send**: each external signer gets an unguessable capability link, delivered by email (composed and sent server-side) or copied by hand. Optionally protect a link with an **access code** you share out of band: only its salted hash is stored, attempts lock out, and the email says a code is needed without ever carrying it. You can be a signer too and sign in the app. Optionally **sign in order**: each link opens only once the signer before it has signed. If you emailed the requests, each next one goes out as its turn comes; if you handed out links yourself, the app tells you whose turn it is instead of emailing behind your back.
- **Sign**: signers agree to an electronic-signature disclosure, then land on a focused signing page: draw, type, or upload a signature, fill the fields, finish or decline. No account, no install.
- **Get told**: choose which events reach you by email — a completion, a decline, every signature — and they arrive even with the app closed, sent by your own sign worker from your own account.
- **Time-box it**: an optional deadline (with a default in settings) after which every link stops working and the document reads *Expired* — extend it and they come back. Plus automatic reminders on a schedule, and one last call before the deadline.
- **Correct**: fix a pending signer's name or address, put a different person in their place, and reissue their link so the old one dies server-side. A reissued link starts clean: the view and the electronic-signature agreement belonged to whoever held the revoked one, so the new holder is asked for their own. Signatures already collected are untouched.
- **Track**: live statuses per signer (pending, viewed, signed, declined), reminders, a full activity trail, and void when plans change. Each signature carries its own record: consent and its disclosure version, IP address, browser, and the signer's own clock offset.
- **Complete**: when everyone has signed, the app builds the final PDF with every signature flattened in and a signature certificate page appended, and notifies signers with a link to their copy.
- **Reuse**: save any document's PDF and field layout as a template whose fields belong to *roles* ("Client", "Contractor"), then start a document from it by naming the real people. Or duplicate a document into a fresh draft in one action. Either way the layout arrives with its signing order intact.
- Onboarding with generated sample documents, light/dark/system theme, responsive app-like UI on desktop, tablet, and phone.

## Architecture

No servers of ours anywhere. Three pieces:

```
The app (this repo, static files)
  Puter KV   sig:doc:<id>          document records: signers, fields, statuses,
                                   consent + evidence, fingerprint, audit
             sig:tpl:<id>          templates: roles + field layout
             sig:settings:v1       theme, name, onboarding flags
             sig:worker:cfg:v1     the user's sign worker (url + admin secret)
             sig:signature:v1      the user's reusable signature
  Puter FS   signatures-data/<id>/original.pdf   the uploaded file
             signatures-data/<id>/sigdata.json   field values incl. signature images
             signatures-data/<id>/signed.pdf     flattened copy, written on completion
             signatures-data/templates/<id>/original.pdf   a template's own PDF

Sign worker (src/workers/sign-worker.js), ONE PER USER
  Deployed automatically into the user's own Puter account on first send.
  Serves capability URLs (/sign/<160-bit token>) and a JSON API the signing
  page (sign.html) renders from. Stores only token HASHES; managed by the app
  over /admin/* routes with a bearer secret whose hash is baked into the
  deployed source. Also mails the OWNER about their own document (signature,
  decline, completion), since it is the only piece awake when the app is
  closed; every attempt is recorded, so the app can send what it could not.

Email worker (src/workers/email-worker.js), ONE FOR THE APP
  Deployed once by the app owner (npm run deploy:email-worker). Called via
  puter.workers.exec(), so every send is authorized by the worker but billed
  to the signed-in user. Composes all mail itself, only ever links to
  *.puter.work sign capabilities, dedupes by content digest, and enforces
  per-request and per-day caps. Without it, the app falls back to copy-link
  sharing.
```

The signing page never sees Puter: it talks only to the sign worker, and the worker origin plus token travel in the URL fragment so they stay out of server logs and referrer headers. Where an access code is set, unlocking it buys a short-lived per-tab session that every later call carries in a header.

PDF rendering is pdf.js; the flattened copy and the certificate page are built client-side with pdf-lib. No UI framework, no CSS framework; icons are Lucide.

## Development

```sh
npm install
npm run dev          # http://localhost:5173
```

Two ways to run it:

- **Real Puter**: open the dev URL and sign in. Everything works, including worker deployment and (if the email worker is deployed) email.
- **Mock mode**: open `http://localhost:5173/?mock=1`. An in-memory Puter mock (dev/puter-mock.js) backs the whole app, and the sign worker actually runs in-page, so the full send and sign flow works offline. Email always "succeeds". Data resets on reload.

## Tests

```sh
npm test             # vitest, 314 tests
npm run coverage
```

The suite covers the document model, field geometry and snapping, templates and duplicates, the store on a fake Puter SDK, both workers instantiated the way the Puter runtime runs them (routes called as real HTTP, sequential signing included), the signlinks client talking to a real worker instantiation end to end, the email module, owner notifications on both channels, PDF merging, page plans and flattening with pdf-lib, and theming. Six suites drive DOM: the field editor's selection, the signing surface, the document list's rows and their action menu, the page rail, the add-pages dialog, and the signature pad's lifecycle, through real pointer and keyboard events. Where a screen reader is the only thing that would notice - a role=img field box whose label is the whole of what it gets - the label itself is asserted. The flattening tests measure every string the PDF draws against the box or column it belongs in, so text that escapes its bounds fails a test rather than only looking wrong in a viewer.

## Deploying

```sh
npm run build        # dist/
```

Host `dist/` anywhere (Puter hosting works). Two notes:

- The sign worker embeds the URL of `sign.html` at deploy time, taken from the origin the app runs on. Users who first send from the production origin get links pointing there.
- Email needs the shared worker deployed once by the app owner (redeploy after an upgrade: the app asks `/health` which message kinds a deployment can compose, and skips the ones it cannot):

  ```sh
  npm run deploy:email-worker    # -> https://signatures-email.puter.work
  ```

## Scope notes

- Fields are not auto-detected from a PDF's own AcroForm fields or from text cues like "Signature: ______".

- Page fixes are for drafts only: once links exist, signers have been served that exact file, and the certificate's fingerprint says which one.
- No .docx/.xlsx conversion, no OCR, no camera capture, and no editing the page content itself.
- Expiry is per document, not per signer, and counted in calendar days: no business-day calendars, no timezone-aware send windows.

- A document everyone signed before its deadline stays open to its signers afterwards: completion outranks the clock, in the worker as in the app, so the completed copy the signing page offers can still be fetched.

- Anything the sign worker has to enforce — a new deadline, a corrected signer and their reissued link, your own signature on a document whose links are already out — is pushed to it *before* the app records it. A push that fails changes nothing and says so, rather than leaving the app and the links disagreeing about a document nothing would ever push again.

- One document carries at most 20 signers and 200 fields (what the sign worker accepts), and each signer needs their own email address: one address gets one link and one message per send.
- Signing is parallel by default; "sign in order" makes it sequential (one chain, no parallel stages or groups).
- The certificate page records what this app observed (consent, views, signatures, declines, timestamps, IP, browser) plus a SHA-256 fingerprint of the file that was served to signers. It is an audit record, not a qualified electronic signature: no eIDAS QES, no RFC-3161 timestamping, no identity proofing.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
