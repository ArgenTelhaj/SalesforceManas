// SOQL results table, with an edit mode for changing many records at once:
// edit cells in place, set a field on selected (or all) rows, delete rows,
// then save everything in batches of 200.
//
// Edit mode needs a plain query on one object that includes Id. Only that
// object's own (non-dotted) writable fields are editable.

import { isSalesforceId } from '../lib/salesforce.js';
import { $, copy, el, showError, toast } from '../shared/ui.js';
import { confirmIn, displayValue, editCell, editorFor, errorText, friendlyValue, inBatches, isWritable, parseValue, sameValue } from './fields.js';

const BATCH = 200;

let ctx = null;
let view = null;

export function initSoqlResults(context) {
  ctx = context;
  $('soql-copy').addEventListener('click', () => copy(toCsv(), 'Copied CSV'));
  $('soql-download').addEventListener('click', downloadCsv);
  $('soql-edit').addEventListener('click', toggleEdit);
  $('soql-select-all').addEventListener('change', (e) => {
    for (const row of view.rows) row.selected = e.target.checked;
    renderTable();
  });
  $('soql-bulk-field').addEventListener('change', renderBulkEditor);
  $('soql-apply-selected').addEventListener('click', () => applyBulk(view.rows.filter((r) => r.selected)));
  $('soql-apply-all').addEventListener('click', () => applyBulk(view.rows));
  $('soql-delete-selected').addEventListener('click', toggleDeleteSelected);
  $('soql-discard').addEventListener('click', discard);
  $('soql-save').addEventListener('click', save);
}

export const hasUnsavedSoqlEdits = () => Boolean(view?.rows.some((r) => r.changes.size || r.del));

export function showSoqlResults({ records, tooling }) {
  const { columns, rows } = flattenRecords(records);
  const types = new Set(records.map((r) => r.attributes?.type));
  const objectType = types.size === 1 ? [...types][0] : null;

  let editBlock = null;
  if (tooling) editBlock = 'Tooling API results are read only here';
  else if (!records.length) editBlock = 'No rows to edit';
  else if (!objectType || objectType === 'AggregateResult') editBlock = 'Only plain queries on one object can be edited';
  else if (!columns.includes('Id')) editBlock = 'Add Id to the SELECT list to edit or delete rows';

  view = {
    columns,
    objectType,
    editBlock,
    editing: false,
    describe: null,
    fields: new Map(), // column -> writable field describe
    rows: rows.map((data) => ({ data, id: data.Id, changes: new Map(), del: false, selected: false, error: null })),
    confirming: false,
  };

  $('soql-edit').disabled = Boolean(editBlock);
  $('soql-edit').title = editBlock || 'Edit cells, set a field on many rows, or delete rows';
  $('soql-edit').textContent = 'Edit';
  $('soql-edit-bar').hidden = true;
  $('soql-error').hidden = true;
  renderTable();
}

// Turns nested query results into flat rows with dotted column names.
function flattenRecords(records) {
  const columns = [];
  const seen = new Set();
  const addColumn = (name) => {
    if (!seen.has(name)) {
      seen.add(name);
      columns.push(name);
    }
  };
  const flatten = (record, prefix, out) => {
    for (const [key, value] of Object.entries(record)) {
      if (key === 'attributes') continue;
      const name = prefix + key;
      if (value && typeof value === 'object' && value.attributes) {
        flatten(value, name + '.', out);
      } else if (value && typeof value === 'object' && Array.isArray(value.records)) {
        addColumn(name);
        out[name] = `[${value.totalSize} records]`;
      } else {
        addColumn(name);
        out[name] = value;
      }
    }
    return out;
  };
  return { columns, rows: records.map((r) => flatten(r, '', {})) };
}

const valueOf = (row, col) => (row.changes.has(col) ? row.changes.get(col) : row.data[col]);

// --- Edit mode --------------------------------------------------------------

async function toggleEdit() {
  if (view.editing) {
    if (hasUnsavedSoqlEdits()) return toast('Save or discard your changes first');
    view.editing = false;
  } else {
    $('soql-edit').disabled = true;
    try {
      view.describe ??= await ctx.client.describe(view.objectType);
    } catch (error) {
      showError('soql-error', error);
      return;
    } finally {
      $('soql-edit').disabled = false;
    }
    const byName = new Map(view.describe.fields.map((f) => [f.name.toLowerCase(), f]));
    view.fields = new Map(
      view.columns
        .filter((c) => !c.includes('.'))
        .map((c) => [c, byName.get(c.toLowerCase())])
        .filter(([, f]) => f && isWritable(f))
    );
    view.editing = true;

    // Bulk "set field" can target any writable field, even ones not in the query.
    const writable = view.describe.fields.filter((f) => isWritable(f)).sort((a, b) => a.label.localeCompare(b.label));
    $('soql-bulk-field').replaceChildren(
      el('option', { value: '' }, 'Choose a field…'),
      ...writable.map((f) => el('option', { value: f.name }, `${f.label} (${f.name})`))
    );
    renderBulkEditor();
  }
  $('soql-edit').textContent = view.editing ? 'Done editing' : 'Edit';
  $('soql-edit-bar').hidden = !view.editing;
  renderTable();
}

let bulkEditor = null;
function renderBulkEditor() {
  const field = view.describe?.fields.find((f) => f.name === $('soql-bulk-field').value);
  bulkEditor = field ? { field, ...editorFor(field, null) } : null;
  $('soql-bulk-value').replaceChildren(bulkEditor ? bulkEditor.node : el('span', { class: 'muted' }, '—'));
}

function applyBulk(rows) {
  if (!bulkEditor) return toast('Choose a field first');
  if (!rows.length) return toast('Select some rows first');
  const parsed = parseValue(bulkEditor.field, bulkEditor.read());
  if (parsed.error) return toast(parsed.error);

  const { field } = bulkEditor;
  if (!view.columns.includes(field.name)) view.columns.push(field.name);
  view.fields.set(field.name, field);
  for (const row of rows) {
    if (row.del) continue;
    if (sameValue(parsed.value, row.data[field.name]) && field.name in row.data) row.changes.delete(field.name);
    else row.changes.set(field.name, parsed.value);
    row.error = null;
  }
  toast(`Set ${field.label} on ${rows.length} row${rows.length === 1 ? '' : 's'}`);
  renderTable();
}

function toggleDeleteSelected() {
  const selected = view.rows.filter((r) => r.selected);
  if (!selected.length) return toast('Select some rows first');
  const mark = !selected.every((r) => r.del);
  for (const row of selected) row.del = mark;
  renderTable();
}

// --- Table ------------------------------------------------------------------

function renderTable() {
  const table = $('soql-table');
  const editing = view.editing;
  table.classList.toggle('editing-grid', editing);

  table.tHead.replaceChildren(
    el('tr', {},
      editing ? el('th', { class: 'select-col' }) : null,
      view.columns.map((c) => el('th', { title: view.fields.has(c) && editing ? 'Editable' : null }, c, editing && view.fields.has(c) ? ' ✎' : ''))
    )
  );
  table.tBodies[0].replaceChildren(...view.rows.map(renderRow));
  table.hidden = false;

  const selected = view.rows.filter((r) => r.selected).length;
  $('soql-selected-count').textContent = `${selected} selected`;
  $('soql-select-all').checked = selected > 0 && selected === view.rows.length;
  $('soql-select-all').indeterminate = selected > 0 && selected < view.rows.length;
  $('soql-select-all-wrap').hidden = !editing;
  updateSaveBar();
}

function renderRow(row) {
  const editing = view.editing;
  const tr = el('tr', {
    class: [row.del && 'deleted', row.changes.size && 'changed', row.error && 'failed'].filter(Boolean).join(' ') || null,
    title: row.error || (row.del ? 'Will be deleted when you save' : null),
  },
    editing
      ? el('td', { class: 'select-col' },
          el('input', { type: 'checkbox', checked: row.selected, onchange: (e) => {
            row.selected = e.target.checked;
            renderTable();
          } }))
      : null,
    view.columns.map((col) => renderCell(row, col))
  );
  row.tr = tr;
  return tr;
}

function renderCell(row, col) {
  const value = valueOf(row, col);
  const text = displayValue(value);
  const field = view.editing && !row.del ? view.fields.get(col) : null;
  const dirty = row.changes.has(col);

  let content;
  if (text == null) content = el('span', { class: 'null' }, 'null');
  else if (/Id$/.test(col) && isSalesforceId(text)) content = el('a', { href: ctx.lightning(`/${text}`), target: '_blank' }, text);
  else {
    const shown = friendlyValue(value, view.describe?.fields.find((f) => f.name === col)?.type);
    const hint = shown === text ? '' : `${text} · `;
    content = el('span', { class: field ? null : 'copyable', title: field ? text : `${hint}Click to copy`, onclick: field ? null : () => copy(text) }, shown);
  }

  const td = el('td', { class: [field && 'editable', dirty && 'dirty'].filter(Boolean).join(' ') || null, title: field ? 'Double-click to edit' : null }, content);
  if (field) {
    td.addEventListener('dblclick', () =>
      editCell(td, field, value, {
        onCommit: (next) => {
          if (sameValue(next, row.data[col]) && col in row.data) row.changes.delete(col);
          else row.changes.set(col, next);
          row.error = null;
          row.tr.replaceWith(renderRow(row));
          updateSaveBar();
        },
      })
    );
  }
  return td;
}

// --- Saving -------------------------------------------------------------------

function pending() {
  return {
    updates: view.rows.filter((r) => !r.del && r.changes.size),
    deletes: view.rows.filter((r) => r.del),
  };
}

function summary({ updates, deletes }) {
  const parts = [];
  if (updates.length) parts.push(`update ${updates.length} record${updates.length === 1 ? '' : 's'}`);
  if (deletes.length) parts.push(`delete ${deletes.length} record${deletes.length === 1 ? '' : 's'}`);
  const text = parts.join(' and ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function updateSaveBar() {
  const work = pending();
  const any = work.updates.length + work.deletes.length;
  view.confirming = false;
  $('soql-savebar').hidden = !any;
  $('soql-savebar').classList.remove('confirm', 'danger');
  $('soql-changes').textContent = any ? `Unsaved: ${summary(work).toLowerCase()}` : '';
  $('soql-save').textContent = 'Review & save';
  $('soql-discard').textContent = 'Discard';
}

function discard() {
  if (view.confirming) return updateSaveBar();
  for (const row of view.rows) {
    row.changes.clear();
    row.del = false;
    row.error = null;
  }
  renderTable();
}

async function save() {
  const work = pending();
  if (!work.updates.length && !work.deletes.length) return;
  if (!view.confirming) {
    view.confirming = true;
    await confirmIn($('soql-savebar'), $('soql-changes'), ctx.getOrg, summary(work));
    $('soql-save').textContent = 'Apply';
    $('soql-discard').textContent = 'Cancel';
    return;
  }

  const button = $('soql-save');
  button.disabled = true;
  $('soql-error').hidden = true;
  const total = work.updates.length + work.deletes.length;
  let done = 0;
  let failed = 0;
  const progress = (n) => {
    done += n;
    button.textContent = `Saving ${done}/${total}…`;
  };

  try {
    await inBatches(work.updates, BATCH, async (chunk) => {
      const results = await ctx.client.updateRecords(
        chunk.map((r) => ({ attributes: { type: view.objectType }, Id: r.id, ...Object.fromEntries(r.changes) }))
      );
      chunk.forEach((row, i) => {
        if (results[i]?.success) {
          for (const [col, value] of row.changes) row.data[col] = value;
          row.changes.clear();
          row.error = null;
        } else {
          row.error = errorText(results[i]);
          failed++;
        }
      });
      progress(chunk.length);
      return results;
    });

    const deleted = new Set();
    await inBatches(work.deletes, BATCH, async (chunk) => {
      const results = await ctx.client.deleteRecords(chunk.map((r) => r.id));
      chunk.forEach((row, i) => {
        if (results[i]?.success) deleted.add(row);
        else {
          row.error = errorText(results[i]);
          failed++;
        }
      });
      progress(chunk.length);
      return results;
    });
    view.rows = view.rows.filter((r) => !deleted.has(r));
  } catch (error) {
    showError('soql-error', error);
  } finally {
    button.disabled = false;
  }

  if (failed) showError('soql-error', `${failed} record${failed === 1 ? '' : 's'} failed. Hover the red rows to see why; they stay unsaved.`);
  if (done - failed > 0) toast(`Saved ${done - failed} of ${total}`);
  renderTable();
}

// --- CSV --------------------------------------------------------------------

function toCsv() {
  const cell = (v) => {
    const text = displayValue(v) ?? '';
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    view.columns.map(cell).join(','),
    ...view.rows.filter((r) => !r.del).map((r) => view.columns.map((c) => cell(valueOf(r, c))).join(',')),
  ].join('\r\n');
}

function downloadCsv() {
  const blob = new Blob([toCsv()], { type: 'text/csv' });
  const link = el('a', {
    href: URL.createObjectURL(blob),
    download: `soql-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
