# Mailings parity

The Mailings tab sits after References. It covers envelopes, labels and mail
merge from choosing the kind of document to sending the results. The menu bar's
Tools menu offers Envelopes…, Labels… and Mail Merge… (the step-by-step pane).

Code: [mailings.js](../../src/views/mailings.js) (tab, state, preview, finishing),
[mailings-recipients.js](../../src/views/mailings-recipients.js),
[mailings-fields.js](../../src/views/mailings-fields.js),
[mailings-create.js](../../src/views/mailings-create.js),
[mailings-wizard.js](../../src/views/mailings-wizard.js); engine
[merge-fields.js](../../src/engine/merge-fields.js) (evaluation),
[mail-merge-model.js](../../src/engine/mail-merge-model.js) (document edits),
[docx-mail-merge.js](../../src/engine/docx-mail-merge.js) (settings, embedded
list, merged output), [mail-documents.js](../../src/engine/mail-documents.js)
(label sheets, envelopes); [recipient-files.js](../../src/lib/recipient-files.js)
and [mail-messages.js](../../src/lib/mail-messages.js). OOXML details are in
[conformance.md](../conformance.md#mailings-envelopes-labels-and-mail-merge-2026-10-13).

## Implemented

**Create**
- Envelopes: delivery and return address (the return address is remembered on
  this device), omit return address, sizes #10, #9, Monarch, A7, 6¾, DL, C4, C5,
  C6, B5 or custom, font size, delivery address position, live to-scale preview.
  Add to Document makes the envelope the first section (or sets up an empty
  document); New Document opens an envelope document; Print prints the envelope
  on a page of its size. The current selection pre-fills the delivery address.
- Labels: address text (or the return address), full page of the same label or
  one label at a row and column, generic sheets described by their measurements
  (Letter: 30, 20, 14, 10, 6, 80, 8, 2, 1 per sheet; A4: 21, 24, 14, 8, 65 per
  sheet) or custom measurements (page size, label size, margins, pitch, across,
  down), live preview with the text, New Document (an exact table-based sheet)
  and Print.

**Start Mail Merge**
- Letters, Email Messages, Envelopes…, Labels…, Directory and Normal Document.
  Envelopes set up the current empty document (or a new one) with an Address
  Block; Labels opens a new label sheet whose first label holds an Address Block
  and whose other labels start with Next Record, so a labels merge works at once.
- Step-by-Step Mail Merge pane with six steps, explanations and the commands
  for each step.

**Select Recipients**
- Type a New List: an editable grid with Title, First Name, Last Name, Company,
  Address Line 1/2, City, State, ZIP Code, Country, Phone and Email; New/Delete
  Entry, Enter moves down and starts a new entry, find, Customize Columns (add,
  rename, delete, reorder).
- Use an Existing List: .csv, .tsv/.txt (delimiter detected, quoting, line
  breaks in cells, byte order mark) and .xlsx (shared and inline strings, dates,
  booleans, sparse cells; a sheet chooser when there are several) from the
  device, or from Puter when its file picker is available. Export List as CSV
  and Remove Recipient List.
- Edit Recipient List: include/exclude check boxes, click-to-sort columns, Sort
  and Filter (up to three sort keys, and/or conditions), Find Duplicates (choose
  the columns to compare, keep the entries you want), Check Addresses (light
  checks for missing name, street, city or postal code, US ZIP format and
  incomplete email addresses), Edit Entries, search.
- The list, its include flags, sort, filters and field matching are saved in
  the document and come back when it is reopened.

**Write & Insert Fields**
- Highlight Merge Fields (gray shading drawn under field results while on; a
  view setting that is not saved).
- Address Block: name formats, company, postal address, country never/always/
  only when different; live preview through the recipients; Match Fields.
- Greeting Line: salutation, name format, punctuation, text for missing names,
  preview.
- Insert Merge Field: menu of the list's columns, and a dialog with database or
  matched address fields, text before/after and capitalization; stays open for
  several insertions.
- Rules: Ask, Fill-in, If…Then…Else, Merge Record #, Merge Sequence #, Next
  Record, Next Record If, Set Bookmark, Skip Record If. Comparisons include
  "is blank" and "is not blank".
- Match Fields: courtesy title, first/middle/last name, suffix, nickname,
  company, address lines, city, state, postal code, country, phone, email;
  matched automatically from common column names.
- Update Labels: copies the first label to every other label with Next Record.

**Preview Results**
- Preview Results toggle, First/Previous/record number/Next/Last, Find
  Recipient, Check for Errors (simulates the merge: missing columns, empty
  address blocks, missing email addresses, skipped records, no fields). The
  preview state and active record are saved (`viewMergedData`, `activeRecord`).

**Finish & Merge**
- Edit Individual Documents: all, current or a range of records; opens a new
  document with one section per output document (labels: one sheet per section;
  directory: one continuous document).
- Print Documents: prints every merged copy in one print job through the
  document's normal print path (up to 300 recipients at a time).
- Send Email Messages: To column, subject, HTML or plain text, record range.
  Messages are sent from the user's Puter email address with
  `puter.email.send`, the same API the Calendar app uses for replies, after a
  confirmation (the mail permission is requested if needed). Without a signed-in
  Puter session (or by choice) each message is saved as an unsent .eml file
  (several in a .zip) that any mail app opens as a draft.

## Approximations

- Previewing writes recipient values into the field results without adding
  undo steps; saving while previewing keeps those values as the fields' cached
  results (other word processors refresh them).
- One answer per Ask/Fill-in prompt is used for the whole merge (desktop word
  processors can ask per record).
- ADDRESSBLOCK ignores `\d` (country-specific address layouts) and `\l`.
- Envelope delivery address placement uses indent and space before rather than
  a positioned frame; feed direction and printer trays are left to the browser's
  print dialog. Envelope and label Print use a separate print page, not the
  document's renderer.
- Label sheets list generic layouts by measurement, not by vendor product
  numbers.
- Check Addresses is a format check, not address verification.
- The data source is embedded; documents linked to an external data source keep
  the link but it is not opened here (choose a list instead).

## Gaps

- Merge fields in headers, footers, footnotes and text boxes are not merged or
  previewed.
- Fax output, merging to attachments, and recipient lists from address books or
  databases are not available.
- Per-record Ask prompts and the "pause on errors" style of checking.
- Sort/filter by more than three keys; editing the list while previewing
  refreshes the preview but not other open dialogs.
- At 1280 px and narrower the Create group folds into a drop-down first.
