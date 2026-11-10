/**
 * The prepare view for drafts: recipients, field placement, and send.
 */

import { el, clear, append, fieldId } from '../ui/dom.js';
import { icon, FIELD_ICONS } from '../ui/icons.js';
import { store } from '../lib/store.js';
import { openPdf, pagePoints } from '../lib/pdfdoc.js';
import {
  FIELD_TYPES, fieldLabel, signerColor, TEXT_INPUT_TYPES, FIELD_LIMITS, isValidInput, inputTypeHint,
  copyFieldToPages, duplicateField, alignFields, matchFieldSizes, DOC_LIMITS,
} from '../lib/model.js';
import { uid, debounce, normalizeEmail } from '../lib/util.js';
import { mountFieldEditor } from '../ui/fieldeditor.js';
import { pageRail } from '../ui/pagerail.js';
import { openAddPages } from '../ui/addpages.js';
import { pagesError } from '../ui/pages.js';
import { applyPagePlan, remapFields, fieldsLostBy } from '../lib/pdfedit.js';
import { openSendFlow, sendBlockers } from '../ui/sendflow.js';
import { deleteDocFlow } from '../ui/actions.js';
import { saveAsTemplateFlow } from '../ui/templates.js';
import { confirmDialog, openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

export function editorView({ navigate, docId }) {
  const doc = store.getDoc(docId);
  const root = el('div.main-inner');

  if (!doc) {
    root.append(notFound(navigate));
    return root;
  }
  if (doc.status !== 'draft') {
    // Sent documents are immutable; the detail view owns them.
    queueMicrotask(() => navigate(`#/doc/${doc.id}`));
    return root;
  }

  let armedType = null;
  let placeSignerId = doc.signers[0]?.id || null;
  let editor = null;

  /**
   * Is there room for `count` more fields? The sign worker keeps the first
   * DOC_LIMITS.fields of them and drops the rest, so a document is stopped at
   * the limit here rather than losing fields quietly on the way out.
   */
  function roomFor(count) {
    if (doc.fields.length + count <= DOC_LIMITS.fields) return true;
    toast(`That would be ${doc.fields.length + count} fields. The limit is ${DOC_LIMITS.fields} on one document`, {
      icon: 'circleAlert', duration: 4000,
    });
    return false;
  }

  const save = debounce(() => {
    store.persistDoc(doc).catch(() => toast('Could not save. Check your connection', { icon: 'wifiOff' }));
  }, 700);

  /* ---- Header ----------------------------------------------------------- */

  const titleInput = el('input.title-input', {
    value: doc.title,
    'aria-label': 'Document title',
    maxLength: 200,
    oninput: () => {
      doc.title = titleInput.value;
      save();
    },
    onblur: () => {
      // The title goes into email subjects and onto the certificate as typed,
      // so stray spaces around it (or a blank) are settled here.
      const trimmed = titleInput.value.trim() || 'Untitled document';
      if (trimmed !== titleInput.value) {
        titleInput.value = trimmed;
        doc.title = trimmed;
        save();
      }
    },
  });

  const headMeta = el('div.small.faint', { style: { padding: '0 6px' } });
  function renderHeadMeta() {
    headMeta.textContent = `Draft · ${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}`;
  }
  renderHeadMeta();

  const sendBtn = el('button.btn.btn-primary', {
    type: 'button', html: icon('send', 15, 2.2),
    onclick: () => openSendFlow(doc, { navigate }),
  }, ' Send');

  const head = el('div.view-head', {},
    el('button.icon-btn', {
      type: 'button', html: icon('arrowLeft', 20), 'aria-label': 'Back to documents',
      onclick: () => navigate('#/'),
    }),
    el('div.grow', {}, titleInput, headMeta),
    el('button.icon-btn', {
      type: 'button', html: icon('trash', 18), 'aria-label': 'Delete draft',
      onclick: async () => {
        if (await deleteDocFlow(doc)) navigate('#/');
      },
    }),
    sendBtn
  );

  /* ---- Recipients card -------------------------------------------------------- */

  const recipientsWrap = el('div');

  function addSigner({ isMe = false } = {}) {
    if (isMe && doc.signers.some((s) => s.isMe)) return;
    doc.signers.push({
      id: uid(),
      name: isMe ? (store.settings.fullName || store.user?.username || 'Me') : '',
      email: isMe ? (store.user?.email || '') : '',
      isMe,
      status: 'pending',
    });
    if (!placeSignerId) placeSignerId = doc.signers[doc.signers.length - 1].id;
    save();
    renderRecipients();
    renderPalette();
    renderReady();
    // Straight into typing the new signer's name.
    if (!isMe) {
      const rows = recipientsWrap.querySelectorAll('.recipient-row');
      rows[rows.length - 1]?.querySelector('input')?.focus();
    }
  }

  async function removeSigner(signer) {
    const fieldCount = doc.fields.filter((f) => f.signerId === signer.id).length;
    if (fieldCount) {
      const ok = await confirmDialog({
        title: 'Remove signer?',
        message: `Removing ${signer.name || signer.email || 'this signer'} also removes their ${fieldCount} field${fieldCount === 1 ? '' : 's'} from the document.`,
        confirmLabel: 'Remove signer',
      });
      if (!ok) return;
    }
    doc.signers = doc.signers.filter((s) => s.id !== signer.id);
    doc.fields = doc.fields.filter((f) => f.signerId !== signer.id);
    if (placeSignerId === signer.id) placeSignerId = doc.signers[0]?.id || null;
    save();
    renderRecipients();
    renderPalette();
    renderReady();
    editor?.refreshAll();
    // Keep the toolbar when the selected field survived the removal.
    renderToolbar(editor?.selectedField || null);
  }

  /** Move a signer up or down the signing order (the array IS the order). */
  function moveSigner(index, delta) {
    const next = index + delta;
    if (next < 0 || next >= doc.signers.length) return;
    const [signer] = doc.signers.splice(index, 1);
    doc.signers.splice(next, 0, signer);
    save();
    renderRecipients();
    renderPalette();
    // Signer colors follow position, so every field box restyles.
    editor?.refreshAll();
    renderToolbar(editor?.selectedField || null);
    // The button just pressed was rebuilt at the row's new position; keep the
    // keyboard on it so a second press keeps moving the same signer. At the
    // end of the list that button is now disabled (so unfocusable): hand
    // focus to its partner instead of dropping it on the page.
    const row = recipientsWrap.querySelectorAll('.recipient-row')[next];
    const same = row?.querySelector(delta < 0 ? '.order-up' : '.order-down');
    const partner = row?.querySelector(delta < 0 ? '.order-down' : '.order-up');
    (same && !same.disabled ? same : partner)?.focus();
  }

  function renderRecipients() {
    clear(recipientsWrap);
    const ordered = doc.signOrder === true;
    const rows = doc.signers.map((signer, index) => {
      const nameId = fieldId('rn');
      const emailId = fieldId('re');
      const errorId = fieldId('ree');
      // Flag on blur, clear the moment the address becomes valid.
      const emailError = el('p.field-error', { id: errorId, hidden: true },
        'Enter a valid email address, like alex@example.com');
      const setEmailValidity = (input, invalid) => {
        emailError.hidden = !invalid;
        if (invalid) {
          input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-describedby', errorId);
          input.style.borderColor = 'var(--danger)';
        } else {
          input.removeAttribute('aria-invalid');
          input.removeAttribute('aria-describedby');
          input.style.borderColor = '';
        }
      };
      return el('div.recipient-row', {},
        ordered
          ? el('span.order-badge', { 'aria-hidden': 'true' }, String(index + 1))
          : el('span.recipient-dot', { className: `recipient-dot c${signerColor(signer, doc.signers)}`, 'aria-hidden': 'true' }),
        el('div.inputs', {},
          el('input.input', {
            id: nameId, value: signer.name, placeholder: signer.isMe ? 'Your name' : 'Full name',
            'aria-label': 'Signer name', maxLength: 100,
            oninput: (e) => { signer.name = e.target.value; save(); renderPalette(); renderReady(); },
          }),
          el('input.input', {
            id: emailId, value: signer.email, type: 'email',
            placeholder: 'email@example.com', 'aria-label': 'Signer email',
            disabled: signer.isMe, maxLength: 254,
            oninput: (e) => {
              signer.email = e.target.value.trim();
              save();
              renderReady();
              if (!e.target.value || normalizeEmail(e.target.value)) setEmailValidity(e.target, false);
            },
            onblur: (e) => {
              setEmailValidity(e.target, Boolean(e.target.value) && !normalizeEmail(e.target.value));
            },
          }),
          emailError,
          signer.isMe && el('span.small.faint', {}, 'You sign in this app, no email needed')
        ),
        ordered && doc.signers.length > 1 && el('div.order-arrows', {},
          el('button.icon-btn.order-up', {
            type: 'button', html: icon('chevD', 15), disabled: index === 0,
            title: 'Move earlier',
            'aria-label': `Move ${signer.name || 'this signer'} earlier in the signing order`,
            onclick: () => moveSigner(index, -1),
          }),
          el('button.icon-btn.order-down', {
            type: 'button', html: icon('chevD', 15), disabled: index === doc.signers.length - 1,
            title: 'Move later',
            'aria-label': `Move ${signer.name || 'this signer'} later in the signing order`,
            onclick: () => moveSigner(index, 1),
          })),
        el('button.icon-btn', {
          type: 'button', html: icon('x', 17), 'aria-label': `Remove ${signer.name || 'signer'}`,
          onclick: () => removeSigner(signer),
        })
      );
    });
    const orderId = fieldId('order');
    append(recipientsWrap, [
      rows,
      el('div.row', { style: { marginTop: '10px' } },
        el('button.btn.btn-soft.btn-sm', {
          type: 'button', html: icon('userPlus', 14, 2.2),
          onclick: () => addSigner(),
        }, ' Add signer'),
        !doc.signers.some((s) => s.isMe) && el('button.btn.btn-ghost.btn-sm', {
          type: 'button', html: icon('penLine', 14, 2.2),
          onclick: () => addSigner({ isMe: true }),
        }, ' I sign too')
      ),
      // Off by default: parallel signing stays the behaviour you get without
      // asking for anything.
      doc.signers.length > 1 && el('div.order-toggle', {},
        el('label.check-row', { for: orderId },
          el('input', {
            type: 'checkbox', id: orderId, checked: ordered,
            onchange: (e) => {
              doc.signOrder = e.target.checked;
              save();
              renderRecipients();
              renderReady();
            },
          }), 'Sign in order'),
        el('p.small.faint', { style: { margin: '4px 0 0 26px' } }, ordered
          ? `Each signer's link opens only once the one before them has signed. ${doc.signers[0]?.name || 'The first signer'} goes first.`
          : 'Everyone can sign as soon as the document goes out.')),
    ]);
  }

  /* ---- Palette card ---------------------------------------------------------- */

  const paletteWrap = el('div');

  function renderPalette() {
    clear(paletteWrap);
    if (!doc.signers.length) {
      paletteWrap.append(el('p.small.muted', {}, 'Add a signer first, then place their fields on the document.'));
      editor?.setArmedCursor(false);
      return;
    }
    if (!doc.signers.some((s) => s.id === placeSignerId)) placeSignerId = doc.signers[0].id;

    const assignees = el('div.assignee-row', { role: 'group', 'aria-label': 'Place fields for' },
      doc.signers.map((s) => el('button.assignee-chip', {
        type: 'button',
        'aria-pressed': s.id === placeSignerId ? 'true' : 'false',
        onclick: () => { placeSignerId = s.id; renderPalette(); },
      },
        el('span.recipient-dot', { className: `recipient-dot c${signerColor(s, doc.signers)}`, 'aria-hidden': 'true' }),
        el('span.truncate', {}, s.name || s.email || 'Signer')
      )));

    const palette = el('div.palette', { role: 'group', 'aria-label': 'Field types' },
      FIELD_TYPES.map((f) => el('button.palette-btn', {
        type: 'button',
        html: icon(FIELD_ICONS[f.type], 17, 1.9),
        'aria-pressed': armedType === f.type ? 'true' : 'false',
        onclick: () => {
          armedType = armedType === f.type ? null : f.type;
          renderPalette();
        },
      }, el('span', {}, f.label))));

    append(paletteWrap, [
      assignees,
      palette,
      el('p.palette-hint', {}, armedType
        ? `Tap the document to place a ${fieldLabel(armedType).toLowerCase()} field, or drag to draw it to size. Esc or tapping the button again stops.`
        : 'Pick a field type, then tap the document to place it. Shift-click to select several, ⌘/Ctrl+D to duplicate.'),
    ]);
    editor?.setArmedCursor(Boolean(armedType));
  }

  /* ---- Selected-field toolbar --------------------------------------------------- */

  const toolbarWrap = el('div');
  // Sticky across selections: someone labelling a form wants the details open
  // for every field they touch, not once per field.
  let detailsOpen = false;

  /**
   * The extra options for the selected field: what the signer is being asked
   * for (label, help), what the sender already knows (a filled-in value), and
   * whether they may change it. Kept behind a disclosure so the default
   * toolbar stays one line over the document.
   */
  function fieldDetails(field) {
    const labelId = fieldId('flab');
    const helpId = fieldId('fhelp');
    const typeId = fieldId('ftype');
    const valueId = fieldId('fval');
    const roId = fieldId('fro');
    const canPrefill = field.type === 'text' || field.type === 'checkbox';

    const presetError = el('p.field-error', { hidden: true });
    const presetInput = canPrefill && field.type === 'text' && el('input.input.input-sm', {
      id: valueId, type: 'text', maxLength: FIELD_LIMITS.text,
      value: typeof field.preset === 'string' ? field.preset : '',
      placeholder: 'Leave empty for the signer to fill',
      oninput: (e) => {
        const value = e.target.value;
        field.preset = value;
        const bad = Boolean(value) && !isValidInput(field.inputType, value);
        presetError.hidden = !bad;
        presetError.textContent = bad ? inputTypeHint(field.inputType) : '';
        e.target.style.borderColor = bad ? 'var(--danger)' : '';
        save();
        // A read-only field with nothing in it blocks the send; filling it
        // in is what clears that, so the checklist follows the typing.
        renderReady();
        editor?.refreshAll();
      },
    });

    return el('div.ft-details', {},
      el('div.ft-field', {},
        el('label', { for: labelId }, 'Label'),
        el('input.input.input-sm', {
          id: labelId, type: 'text', maxLength: FIELD_LIMITS.label,
          value: field.label || '',
          placeholder: fieldLabel(field.type),
          oninput: (e) => {
            field.label = e.target.value;
            save();
            // The label is what the box shows, so redraw it as it is typed.
            editor?.refreshAll();
          },
        }),
        el('p.small.faint', {}, 'Shown in the field and read out to screen readers')),
      el('div.ft-field', {},
        el('label', { for: helpId }, 'Help text'),
        el('input.input.input-sm', {
          id: helpId, type: 'text', maxLength: FIELD_LIMITS.help,
          value: field.help || '',
          placeholder: 'Optional. e.g. As it appears on your ID',
          oninput: (e) => { field.help = e.target.value; save(); },
        })),
      field.type === 'text' && el('div.ft-field', {},
        el('label', { for: typeId }, 'Accepts'),
        el('div.select-wrap', {},
          el('select.select.input-sm', {
            id: typeId,
            onchange: (e) => {
              field.inputType = e.target.value;
              save();
              // Re-check the sender's own value against the new type.
              presetInput?.dispatchEvent(new Event('input'));
            },
          }, TEXT_INPUT_TYPES.map((t) =>
            el('option', { value: t.id, selected: (field.inputType || 'text') === t.id }, t.label))))),
      canPrefill && el('div.ft-field', {},
        el('label', { for: field.type === 'checkbox' ? roId : valueId },
          field.type === 'checkbox' ? 'Sender-filled' : 'Sender-filled value'),
        field.type === 'checkbox'
          ? el('label.check-row', {},
            el('input', {
              type: 'checkbox', checked: field.preset === true,
              onchange: (e) => { field.preset = e.target.checked; save(); editor?.refreshAll(); },
            }), 'Start checked')
          : presetInput,
        presetError,
        el('label.check-row', { for: roId, style: { marginTop: '7px' } },
          el('input', {
            type: 'checkbox', id: roId, checked: field.readOnly === true,
            onchange: (e) => {
              field.readOnly = e.target.checked;
              save();
              renderReady();
              editor?.refreshAll();
            },
          }), 'Read-only for the signer'),
        field.readOnly === true && el('p.small.faint', {},
          'Shown filled in, not editable, and not counted as work for the signer.'))
    );
  }

  /** The size of the selected field in PDF points, once its page is known. */
  const pointCache = new Map();
  function sizeLabel(field) {
    const points = pointCache.get(field.page);
    if (!points) return `${Math.round(field.w * 100)}% × ${Math.round(field.h * 100)}%`;
    return `${Math.round(field.w * points.w)} × ${Math.round(field.h * points.h)} pt`;
  }
  let sizeNode = null;

  function renderToolbar(fields) {
    const list = Array.isArray(fields) ? fields.filter(Boolean) : (fields ? [fields] : []);
    clear(toolbarWrap);
    sizeNode = null;
    // The wrapper is a ZERO-HEIGHT anchor inside the sticky column header, so
    // the toolbar floats over the pages instead of taking layout space:
    // appearing or disappearing must never shift the document under the
    // pointer mid-placement.
    toolbarWrap.className = list.length ? 'field-toolbar-anchor' : '';
    if (!list.length) return;
    if (list.length > 1) {
      toolbarWrap.append(groupToolbar(list));
      return;
    }
    const [field] = list;
    const reqId = fieldId('req');
    sizeNode = el('span.small.faint.ft-size', { title: 'Width × height' }, sizeLabel(field));
    toolbarWrap.append(el('div.field-toolbar', {},
      el('div.ft-row', {},
        el('span.small', { style: { fontWeight: 650 } }, fieldLabel(field.type)),
        sizeNode,
        el('div.select-wrap', {},
          el('select.select', {
            'aria-label': 'Assigned signer',
            onchange: (e) => {
              field.signerId = e.target.value;
              save();
              renderReady();
              editor?.refreshAll();
            },
          }, doc.signers.map((sx) =>
            el('option', { value: sx.id, selected: sx.id === field.signerId }, sx.name || sx.email || 'Signer')))),
        field.type !== 'date' && field.readOnly !== true && el('label.check-row', { for: reqId },
          el('input', {
            type: 'checkbox', id: reqId, checked: field.required !== false,
            onchange: (e) => { field.required = e.target.checked; save(); },
          }), 'Required'),
        el('span.grow'),
        // The two that turn a 20-page document from the worst job in the app
        // into one action.
        doc.pageCount > 1 && el('button.btn.btn-soft.btn-sm', {
          type: 'button', html: icon('copy', 14, 2), title: 'Put a copy of this field on other pages',
          onclick: () => openApplyToPages(field),
        }, ' To pages…'),
        el('button.btn.btn-soft.btn-sm', {
          type: 'button', html: icon('copyPlus', 14, 2), title: 'Duplicate (Ctrl+D)',
          onclick: () => duplicateSelection(),
        }, ' Duplicate'),
        el('button.btn.btn-ghost.btn-sm', {
          type: 'button',
          'aria-expanded': detailsOpen ? 'true' : 'false',
          html: icon('chevD', 14, 2.2),
          onclick: () => {
            detailsOpen = !detailsOpen;
            renderToolbar([field]);
          },
        }, ' Details'),
        el('button.btn.btn-danger.btn-sm', {
          type: 'button',
          onclick: () => removeSelection(),
        }, 'Remove')),
      detailsOpen && fieldDetails(field)
    ));
  }

  /** With several fields selected, the toolbar is about the group. */
  function groupToolbar(list) {
    const reqId = fieldId('greq');
    const allRequired = list.every((f) => f.required !== false);
    return el('div.field-toolbar', {},
      el('div.ft-row', {},
        el('span.small', { style: { fontWeight: 650 } }, `${list.length} fields`),
        el('div.select-wrap', {},
          el('select.select', {
            'aria-label': 'Assign all selected fields to',
            onchange: (e) => {
              for (const field of list) field.signerId = e.target.value;
              save();
              renderReady();
              editor?.refreshAll();
              // Same group, same reference: only the toolbar is rebuilt, so
              // the select drops back to "Assign to…".
              editor?.selectMany(list.map((f) => f.id), { primary: list[0]?.id });
            },
          },
            el('option', { value: '', selected: true }, 'Assign to…'),
            doc.signers.map((sx) => el('option', { value: sx.id }, sx.name || sx.email || 'Signer')))),
        el('label.check-row', { for: reqId },
          el('input', {
            type: 'checkbox', id: reqId, checked: allRequired,
            onchange: (e) => {
              for (const field of list) field.required = e.target.checked;
              save();
              renderReady();
            },
          }), 'Required'),
        el('span.grow'),
        // Lined up and sized from the FIRST of them, which is the one that was
        // selected first: a reference the user chose, not one we picked.
        el('button.btn.btn-soft.btn-sm', {
          type: 'button', title: 'Line up the left edges with the first selected field',
          onclick: () => applyToGroup(list, (group) => alignFields(group, 'left'), 'Left edges lined up'),
        }, 'Align left'),
        el('button.btn.btn-soft.btn-sm', {
          type: 'button', title: 'Line up the top edges with the first selected field',
          onclick: () => applyToGroup(list, (group) => alignFields(group, 'top'), 'Top edges lined up'),
        }, 'Align top'),
        el('button.btn.btn-soft.btn-sm', {
          type: 'button', title: 'Make them all the size of the first selected field',
          onclick: () => applyToGroup(list, matchFieldSizes, 'Sizes matched'),
        }, 'Same size'),
        el('button.btn.btn-soft.btn-sm', {
          type: 'button', html: icon('copyPlus', 14, 2),
          onclick: () => duplicateSelection(),
        }, ' Duplicate'),
        el('button.btn.btn-danger.btn-sm', {
          type: 'button', onclick: () => removeSelection(),
        }, 'Remove')));
  }

  /** Live during a resize: the numbers change without rebuilding the toolbar. */
  function updateSize(field) {
    if (sizeNode) sizeNode.textContent = sizeLabel(field);
  }

  function applyToGroup(list, transform, message) {
    const next = transform(list.map((f) => ({ ...f })));
    for (const updated of next) {
      const target = doc.fields.find((f) => f.id === updated.id);
      if (target) Object.assign(target, updated);
    }
    save();
    editor?.refreshAll();
    // The reference stays the field the user picked first, so a second
    // action (align, then match sizes) lines the group up on the same one.
    editor?.selectMany(list.map((f) => f.id), { primary: list[0]?.id });
    toast(message, { icon: 'check' });
  }

  /* ---- Working fast: duplicate, copy, paste, apply to pages ------------- */

  let clipboard = null;

  function selectionFields() {
    return editor?.selectedFields || [];
  }

  function duplicateSelection() {
    const list = selectionFields();
    if (!list.length) return;
    if (!roomFor(list.length)) return;
    const copies = list.map((field) => duplicateField(field));
    doc.fields.push(...copies);
    save();
    renderReady();
    editor?.refreshAll();
    editor?.selectMany(copies.map((f) => f.id));
  }

  function copySelection() {
    const list = selectionFields();
    if (!list.length) return;
    clipboard = list.map((field) => ({ ...field }));
    toast(`${list.length} field${list.length === 1 ? '' : 's'} copied`, { icon: 'copy' });
  }

  /** Paste onto the page being looked at, keeping the fields' relative layout. */
  function pasteClipboard() {
    if (!clipboard || !clipboard.length) return;
    if (!roomFor(clipboard.length)) return;
    const page = editor?.activePage ?? 0;
    const samePage = clipboard.every((f) => f.page === page);
    const copies = clipboard.map((field) => (samePage
      ? duplicateField({ ...field, page })
      : { ...field, id: uid(), page }));
    doc.fields.push(...copies);
    save();
    renderReady();
    editor?.refreshAll();
    editor?.selectMany(copies.map((f) => f.id));
    toast(`Pasted onto page ${page + 1}`, { icon: 'clipboard' });
  }

  function removeSelection() {
    const list = selectionFields();
    if (!list.length) return;
    const doomed = new Set(list.map((f) => f.id));
    doc.fields = doc.fields.filter((f) => !doomed.has(f.id));
    save();
    renderReady();
    editor?.refreshAll();
    if (editor) editor.select(null);
    else renderToolbar(null);
  }

  /**
   * The initials-on-every-page job. A range rather than only "all", because
   * the pages that need initialling are usually the ones after the cover.
   */
  function openApplyToPages(field) {
    const fromId = fieldId('apf');
    const toId = fieldId('apt');
    const fromInput = el('input.input', {
      id: fromId, type: 'number', min: 1, max: doc.pageCount, value: 1, style: { width: '90px' },
    });
    const toInput = el('input.input', {
      id: toId, type: 'number', min: 1, max: doc.pageCount, value: String(doc.pageCount), style: { width: '90px' },
    });
    const status = el('p.small.faint', { style: { marginTop: '10px' } });

    const run = (from, to) => {
      const first = Math.max(1, Math.min(doc.pageCount, from)) - 1;
      const last = Math.max(1, Math.min(doc.pageCount, to)) - 1;
      const pages = [];
      for (let page = Math.min(first, last); page <= Math.max(first, last); page++) pages.push(page);
      const copies = copyFieldToPages(field, pages);
      if (!copies.length) {
        toast('That is the page this field is already on', { icon: 'info' });
        return;
      }
      if (doc.fields.length + copies.length > DOC_LIMITS.fields) {
        status.textContent = `That would be ${doc.fields.length + copies.length} fields. The limit is ${DOC_LIMITS.fields} on one document.`;
        return;
      }
      doc.fields.push(...copies);
      save();
      renderReady();
      editor?.refreshAll();
      editor?.selectMany([field.id, ...copies.map((f) => f.id)], { primary: field.id });
      modal.close();
      toast(`Copied onto ${copies.length} page${copies.length === 1 ? '' : 's'}`, { icon: 'check' });
    };

    const content = el('div', {},
      el('p.modal-message', {},
        `A copy of this ${fieldLabel(field.type).toLowerCase()} field, same size and same signer, on the pages you choose.`),
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } },
        el('button.btn.btn-soft.btn-block', {
          type: 'button', onclick: () => run(1, doc.pageCount),
        }, `Every page (1–${doc.pageCount})`),
        field.page + 2 <= doc.pageCount && el('button.btn.btn-soft.btn-block', {
          type: 'button', onclick: () => run(field.page + 2, doc.pageCount),
        }, `This page to the end (${field.page + 2}–${doc.pageCount})`)),
      el('div.row', { style: { marginTop: '14px', alignItems: 'flex-end' } },
        el('div.field', { style: { margin: '0' } }, el('label', { for: fromId }, 'From page'), fromInput),
        el('div.field', { style: { margin: '0' } }, el('label', { for: toId }, 'To page'), toInput),
        el('button.btn.btn-primary', {
          type: 'button', onclick: () => run(Number(fromInput.value), Number(toInput.value)),
        }, 'Copy')),
      status);
    const modal = openModal({ title: 'Copy to pages', content });
  }

  /* ---- Checklist / send readiness -------------------------------------------------- */

  const readyWrap = el('div');

  function renderReady() {
    clear(readyWrap);
    const problems = sendBlockers(doc);
    if (!problems.length) {
      readyWrap.append(el('p.small', { style: { color: 'var(--ok)', display: 'flex', gap: '6px', alignItems: 'center' }, html: icon('circleCheck', 15, 2.2) },
        el('span', {}, 'Ready to send.')));
      return;
    }
    append(readyWrap, problems.map((p) =>
      el('p.small.muted', { style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '0 0 6px' }, html: icon('circleAlert', 15, 2) },
        el('span', {}, p))));
  }

  /* ---- Pages ------------------------------------------------------------------ */

  const railWrap = el('div');
  const pagesWrap = el('div');
  // The rail and the field toolbar share one sticky block, so the toolbar
  // always lands just under the rail without either measuring the other.
  const stickyHead = el('div.editor-sticky', {}, railWrap, toolbarWrap);
  let rail = null;
  let busyPages = false;

  /**
   * A page fix: rewrite the file to match the plan, move the fields with it,
   * and remount. Doing both from one plan is what keeps a field on the page it
   * was placed on (see lib/pdfedit.js).
   */
  async function applyPlan(plan, label) {
    if (busyPages) return;
    const lost = fieldsLostBy(doc.fields, plan);
    if (lost) {
      const ok = await confirmDialog({
        title: 'Delete this page?',
        message: `${lost} field${lost === 1 ? '' : 's'} placed on it ${lost === 1 ? 'is' : 'are'} removed with the page. Everything on the other pages stays put.`,
        confirmLabel: 'Delete page',
      });
      if (!ok) return;
    }
    busyPages = true;
    try {
      const current = await store.readPdf(doc.id);
      const { bytes, pageCount } = await applyPagePlan(current, plan);
      await store.replacePdf(doc.id, bytes, pageCount, {
        fields: remapFields(doc.fields, plan),
        audit: { type: 'pages_changed', detail: label },
      });
      // The record is the source of truth for both; re-read it before drawing.
      Object.assign(doc, store.getDoc(doc.id));
      renderHeadMeta();
      renderReady();
      await loadPages();
      toast(`Saved: ${label}`, { icon: 'check' });
    } catch (err) {
      console.error(err);
      toast('Could not change the pages. Check your connection', { icon: 'wifiOff' });
    } finally {
      busyPages = false;
    }
  }

  async function loadPages() {
    // A page fix, an add-pages, or a retry mounts a whole new surface. The
    // old one's observers watch a container that OUTLIVES it, so without
    // this each pass left another ResizeObserver firing over detached
    // frames, and another pdf.js document open.
    editor?.destroy();
    editor = null;
    clear(pagesWrap);
    clear(railWrap);
    rail?.destroy();
    rail = null;
    pagesWrap.append(el('p.small.faint', { style: { textAlign: 'center', padding: '30px 0' } }, 'Loading document…'));
    try {
      const bytes = await store.readPdf(doc.id);
      const pdf = await openPdf(bytes);
      // mountFieldEditor clears the container, loading line included.
      editor = mountFieldEditor({
        container: pagesWrap,
        pdf,
        doc,
        onChange: () => {
          save();
          renderReady();
        },
        onSelect: renderToolbar,
        getArmed: () => armedType,
        getSigner: () => placeSignerId,
        canPlace: () => roomFor(1),
        onPlaced: () => {
          if (!doc.signers.length) return;
          renderReady();
        },
        onPageEnter: (index) => rail?.setActive(index),
        onGeometry: updateSize,
      });
      // Page sizes, for showing a field's size in points rather than percent.
      pointCache.clear();
      for (let page = 0; page < doc.pageCount; page++) {
        pagePoints(pdf, page + 1)
          .then((points) => {
            pointCache.set(page, points);
            const selected = editor?.selectedField;
            if (selected && selected.page === page) updateSize(selected);
          })
          .catch(() => {});
      }
      editor.setArmedCursor(Boolean(armedType));
      // One rail, two jobs: getting around a long document, and fixing up its
      // pages while it is still a draft.
      rail = pageRail({
        pdf,
        pageCount: doc.pageCount,
        editable: true,
        // Clear whatever is stuck to the top of the column, measured now
        // rather than guessed at: the rail collapses and the toolbar comes
        // and goes.
        onJump: (index) => editor.scrollToPage(index, stickyHead.getBoundingClientRect().height + 12),
        onPlan: applyPlan,
        onAddPages: () => openAddPages(doc, {
          onDone: async () => {
            Object.assign(doc, store.getDoc(doc.id));
            renderHeadMeta();
            renderReady();
            await loadPages();
          },
        }),
      });
      railWrap.append(rail);
    } catch (err) {
      console.error(err);
      clear(pagesWrap);
      pagesWrap.append(pagesError('Check your connection, then try again.', loadPages));
    }
  }
  loadPages();

  /* ---- Layout ------------------------------------------------------------------- */

  // The side tools come first in the DOM: on one-column widths they render
  // above the pages (add signers, arm a field, then tap the document),
  // instead of below every rendered page. Desktop places them explicitly
  // into the right-hand grid column.
  const grid = el('div.editor-grid', {},
    el('div.editor-side', {},
      el('div.card', {}, el('div.card-title', {}, 'Signers'), recipientsWrap),
      el('div.card', {}, el('div.card-title', {}, 'Fields'), paletteWrap),
      el('div.card', {}, el('div.card-title', {}, 'Send'), readyWrap,
        el('button.btn.btn-primary.btn-block', {
          type: 'button', style: { marginTop: '10px' }, html: icon('send', 15, 2.2),
          onclick: () => openSendFlow(doc, { navigate }),
        }, ' Review and send'),
        // Right where the layout was just finished: keep it for next time.
        el('button.btn.btn-ghost.btn-block', {
          type: 'button', style: { marginTop: '9px' }, html: icon('template', 15, 2),
          onclick: () => saveAsTemplateFlow(doc),
        }, ' Save as template'))
    ),
    el('div.editor-main', {}, stickyHead, pagesWrap)
  );

  renderRecipients();
  renderPalette();
  renderReady();
  root.append(head, grid);

  /**
   * A draft can stop being one while this view is on screen: the send dialog
   * lives outside it and can be dismissed without navigating. Sent documents
   * are immutable — signers have been served that exact file, and the
   * certificate's fingerprint says which one — so leave for the detail view
   * rather than letting the autosave write edits onto it. A draft that is gone
   * altogether is the delete flow's business, and it navigates itself.
   */
  const onStoreChange = () => {
    const fresh = store.getDoc(docId);
    if (!fresh || fresh.status === 'draft') return;
    save.cancel();
    navigate(`#/doc/${docId}`);
  };
  store.addEventListener('change', onStoreChange);

  /**
   * Editor keys. Escape backs out one step at a time (an in-progress draw, then
   * the armed field type, then the selection); the rest are the shortcuts that
   * make placing fields on a long document bearable. None of them fire while
   * typing, and dialogs own Escape while they are open.
   */
  const onKey = (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '');
    const inDialog = Boolean(document.querySelector('.modal-root:not(.closing)'));
    // A key pressed inside puter.js's account menu (usermenu.js) is that
    // menu's: it arrives here from the element itself, and its Escape must
    // not drop the selection nor a Delete there remove the selected fields.
    if (e.target.closest?.('puter-user-menu')) return;
    if (e.key === 'Escape') {
      if (inDialog || typing) return;
      if (editor?.cancelPlacement()) return;
      if (armedType) {
        armedType = null;
        renderPalette();
        return;
      }
      editor?.select(null);
      return;
    }
    if (typing || inDialog) return;
    const accel = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (accel && key === 'd') {
      e.preventDefault();
      duplicateSelection();
    } else if (accel && key === 'c') {
      if (selectionFields().length) {
        e.preventDefault();
        copySelection();
      }
    } else if (accel && key === 'v') {
      if (clipboard) {
        e.preventDefault();
        pasteClipboard();
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectionFields().length
      && !e.target.classList?.contains('field-box')) {
      // The box handles its own Delete when it has focus; this covers the
      // selection surviving a click somewhere else.
      e.preventDefault();
      removeSelection();
    }
  };
  document.addEventListener('keydown', onKey);

  root.destroy = () => {
    rail?.destroy();
    document.removeEventListener('keydown', onKey);
    store.removeEventListener('change', onStoreChange);
    save.cancel();
    // Flush the pending autosave, unless the draft was just deleted — or has
    // gone out, in which case the edit it holds must not land at all.
    if (store.getDoc(doc.id)?.status === 'draft') store.persistDoc(doc).catch(() => {});
    editor?.destroy();
  };
  return root;
}

function notFound(navigate) {
  return el('div.empty', {},
    el('div.empty-icon', { html: icon('fileText', 26) }),
    el('h3', {}, 'Document not found'),
    el('p', {}, 'It may have been deleted on another device.'),
    el('button.btn.btn-soft', { type: 'button', style: { marginTop: '16px' }, onclick: () => navigate('#/') }, 'Back to documents')
  );
}
