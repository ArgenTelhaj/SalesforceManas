// Data import: Insert, Update or Delete records from CSV (a file, or text
// pasted from Excel/Sheets). Steps: pick operation + object, load data, map
// columns to fields, check the preview, then run in batches of 200 with a
// results file at the end.

import { el, toast } from '../shared/ui.js';
import { confirmIn, errorText, inBatches, isWritable, parseValue } from './fields.js';

const BATCH = 200;
const PREVIEW_ROWS = 8;
const OPERATIONS = [
  ['insert', 'Insert', 'Create new records'],
  ['update', 'Update', 'Change existing records by Id'],
  ['delete', 'Delete', 'Delete records by Id (they go to the Recycle Bin)'],
];

export async function initImport(root, ctx) {
  const state = {
    op: 'insert',
    objectName: null,
    describe: null,
    headers: [],
    rows: [],
    mapping: new Map(), // column index -> field name
    blankLeavesUnchanged: true,
    running: false,
    stop: false,
    confirming: false,
    results: null,
    finished: false, // the current data has been run; change something to run again
  };

  // --- Elements -------------------------------------------------------------

  const opButtons = OPERATIONS.map(([op, label, hint]) =>
    el('button', { 'data-op': op, title: hint, onclick: () => setOp(op) }, label)
  );
  const objectInput = el('input', { list: 'import-objects', placeholder: 'Object API name, e.g. Account', autocomplete: 'off', spellcheck: 'false' });
  const objectList = el('datalist', { id: 'import-objects' });
  const fileInput = el('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv' });
  const pasteArea = el('textarea', { class: 'import-paste', spellcheck: 'false', placeholder: 'Or paste CSV here, or cells copied from Excel / Google Sheets (first row = column names)' });
  const dataInfo = el('p', { class: 'hint' });
  const mappingBox = el('div');
  const previewBox = el('div');
  const barText = el('span');
  const stopBtn = el('button', { class: 'link-btn', hidden: true, onclick: () => (state.stop = true) }, 'Stop after this batch');
  const cancelBtn = el('button', { class: 'link-btn', hidden: true, onclick: () => renderRunBar() }, 'Cancel');
  const runBtn = el('button', { class: 'btn', onclick: run }, 'Review & run');
  const runBar = el('div', { class: 'savebar import-bar' }, barText, el('span', { class: 'spacer' }), stopBtn, cancelBtn, runBtn);
  const resultsBox = el('div');

  root.replaceChildren(
    el('div', { class: 'import-step' },
      el('h3', {}, '1 · What to do'),
      el('div', { class: 'row' }, el('div', { class: 'segmented import-ops' }, opButtons), objectInput, objectList)
    ),
    el('div', { class: 'import-step' },
      el('h3', {}, '2 · Data'),
      el('div', { class: 'row' }, fileInput),
      pasteArea,
      dataInfo
    ),
    el('div', { class: 'import-step' }, el('h3', {}, '3 · Map columns to fields'), mappingBox),
    el('div', { class: 'import-step' }, el('h3', {}, '4 · Preview'), previewBox),
    runBar,
    resultsBox
  );

  // --- Step 1: operation and object --------------------------------------------

  let sobjects = [];
  try {
    sobjects = await ctx.client.describeGlobal();
  } catch (error) {
    toast(error.message);
  }

  function setOp(op) {
    if (state.running) return;
    state.op = op;
    opButtons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.op === op)));
    const allowed = sobjects.filter((s) => (op === 'insert' ? s.createable : op === 'update' ? s.updateable : s.deletable));
    objectList.replaceChildren(...allowed.map((s) => el('option', { value: s.name, label: s.label })));
    autoMap();
    refresh();
  }

  objectInput.addEventListener('change', async () => {
    const match = sobjects.find((s) => s.name.toLowerCase() === objectInput.value.trim().toLowerCase());
    if (!match) {
      if (objectInput.value.trim()) toast('Unknown object');
      objectInput.value = state.objectName || '';
      return;
    }
    objectInput.value = match.name;
    state.objectName = match.name;
    state.describe = null;
    try {
      state.describe = await ctx.client.describe(match.name);
    } catch (error) {
      toast(error.message);
    }
    autoMap();
    refresh();
  });

  // --- Step 2: data -----------------------------------------------------------

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    pasteArea.value = await file.text();
    loadText(pasteArea.value, file.name);
  });
  let pasteTimer;
  pasteArea.addEventListener('input', () => {
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => loadText(pasteArea.value, 'pasted data'), 250);
  });

  function loadText(text, source) {
    const { headers, rows, delimiter } = parseCsv(text);
    state.headers = headers;
    state.rows = rows;
    state.results = null;
    dataInfo.textContent = headers.length
      ? `${rows.length.toLocaleString()} rows × ${headers.length} columns from ${source} (${delimiter === '\t' ? 'tab' : delimiter === ';' ? 'semicolon' : 'comma'} separated).`
      : '';
    autoMap();
    refresh();
  }

  // --- Step 3: mapping --------------------------------------------------------

  function fieldChoices() {
    if (!state.describe) return [];
    const fields = state.describe.fields;
    if (state.op === 'delete') return fields.filter((f) => f.name === 'Id');
    if (state.op === 'update') return fields.filter((f) => f.name === 'Id' || isWritable(f));
    return fields.filter((f) => isWritable(f, { creating: true }));
  }

  const normalize = (s) => s.toLowerCase().replace(/[\s_.\-]/g, '').replace(/__c$/, 'c');

  function autoMap() {
    const choices = fieldChoices();
    const byKey = new Map();
    for (const f of choices) {
      byKey.set(normalize(f.name), f.name);
      if (!byKey.has(normalize(f.label))) byKey.set(normalize(f.label), f.name);
    }
    byKey.set('recordid', choices.some((f) => f.name === 'Id') ? 'Id' : undefined);
    state.mapping = new Map();
    state.headers.forEach((h, i) => {
      const match = byKey.get(normalize(h));
      if (match && ![...state.mapping.values()].includes(match)) state.mapping.set(i, match);
    });
  }

  function renderMapping() {
    if (!state.headers.length || !state.describe) {
      mappingBox.replaceChildren(el('p', { class: 'muted' }, 'Pick an object and load some data first.'));
      return;
    }
    const choices = fieldChoices().sort((a, b) => (a.name === 'Id' ? -1 : b.name === 'Id' ? 1 : a.label.localeCompare(b.label)));
    const used = new Set(state.mapping.values());

    const blankOption =
      state.op === 'update'
        ? el('label', { class: 'check' },
            el('input', { type: 'checkbox', checked: state.blankLeavesUnchanged, onchange: (e) => {
              state.blankLeavesUnchanged = e.target.checked;
              refresh();
            } }),
            'Empty cells leave the field unchanged (untick to clear fields with empty cells)')
        : null;
    const parts = [
      el('div', { class: 'table-wrap import-mapping' },
        el('table', { class: 'grid' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Column'), el('th', {}, 'First value'), el('th', {}, 'Field'))),
          el('tbody', {},
            state.headers.map((h, i) =>
              el('tr', { class: state.mapping.has(i) ? null : 'dim' },
                el('td', {}, h || `(column ${i + 1})`),
                el('td', { class: 'access-sub' }, (state.rows[0]?.[i] ?? '').slice(0, 60)),
                el('td', {},
                  el('select', { onchange: (e) => {
                    if (e.target.value) state.mapping.set(i, e.target.value);
                    else state.mapping.delete(i);
                    refresh();
                  } },
                    el('option', { value: '' }, '— skip —'),
                    choices.map((f) =>
                      el('option', { value: f.name, selected: state.mapping.get(i) === f.name, disabled: used.has(f.name) && state.mapping.get(i) !== f.name },
                        `${f.label} (${f.name})`)
                    )
                  )
                )
              )
            )
          )
        )
      ),
      blankOption,
      requiredWarning(),
    ];
    mappingBox.replaceChildren(...parts.filter(Boolean));
  }

  function requiredWarning() {
    if (state.op !== 'insert') return null;
    const mapped = new Set(state.mapping.values());
    const missing = state.describe.fields.filter(
      (f) => f.createable && !f.nillable && !f.defaultedOnCreate && f.type !== 'boolean' && !mapped.has(f.name)
    );
    return missing.length
      ? el('p', { class: 'notice' }, `Required fields not mapped: ${missing.map((f) => f.label).join(', ')}. Rows will fail unless something fills them (e.g. a default or automation).`)
      : null;
  }

  // --- Step 4: build records and preview ----------------------------------------

  function buildRecords() {
    const fields = new Map(state.describe.fields.map((f) => [f.name, f]));
    const mapped = [...state.mapping.entries()].map(([col, name]) => [col, fields.get(name)]);
    return state.rows.map((row, index) => {
      const record = { attributes: { type: state.objectName } };
      const errors = [];
      for (const [col, field] of mapped) {
        const raw = row[col] ?? '';
        if (raw.trim() === '' && (state.op === 'insert' || state.blankLeavesUnchanged)) continue;
        const parsed = parseValue(field.name === 'Id' ? { ...field, type: 'id' } : field, raw);
        if (parsed.error) errors.push(`${field.name}: ${parsed.error}`);
        else record[field.name] = parsed.value;
      }
      if (state.op !== 'insert' && !record.Id) errors.push('Id is missing');
      return { index, record, error: errors.join('; ') || null };
    });
  }

  function problems() {
    if (!state.objectName || !state.describe) return 'Pick an object';
    if (!state.rows.length) return 'Load some data';
    if (!state.mapping.size) return 'Map at least one column';
    if (state.op !== 'insert' && ![...state.mapping.values()].includes('Id')) return `Map a column to Id to ${state.op} records`;
    return null;
  }

  function renderPreview() {
    const issue = problems();
    if (issue) {
      previewBox.replaceChildren(el('p', { class: 'muted' }, `${issue}.`));
      return;
    }
    const built = buildRecords();
    const bad = built.filter((b) => b.error);
    const columns = [...new Set(state.mapping.values())];
    previewBox.replaceChildren(
      el('p', { class: 'hint' },
        `${(built.length - bad.length).toLocaleString()} rows ready` +
        (bad.length ? `, ${bad.length.toLocaleString()} with problems (they'll be skipped and listed in the results)` : '') +
        `. ${calls(built.length - bad.length)}.`),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'grid' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Row'), columns.map((c) => el('th', {}, c)), el('th', {}, 'Problem'))),
          el('tbody', {},
            [...bad.slice(0, PREVIEW_ROWS), ...built.filter((b) => !b.error).slice(0, PREVIEW_ROWS)]
              .sort((a, b) => a.index - b.index)
              .map((b) =>
                el('tr', { class: b.error ? 'failed' : null },
                  el('td', {}, String(b.index + 2)),
                  columns.map((c) => el('td', { class: b.record[c] == null ? 'null' : null }, b.record[c] == null ? (c in b.record ? 'clear' : '') : String(b.record[c]))),
                  el('td', { class: 'access-sub' }, b.error || '')
                )
              )
          )
        )
      )
    );
  }

  // --- Run ----------------------------------------------------------------------

  function renderRunBar() {
    state.confirming = false;
    runBar.classList.remove('confirm', 'danger');
    const issue = problems();
    const ready = issue ? 0 : buildRecords().filter((b) => !b.error).length;
    runBtn.disabled = Boolean(issue) || !ready || state.running || state.finished;
    runBtn.textContent = 'Review & run';
    cancelBtn.hidden = true;
    stopBtn.hidden = true;
    if (state.finished) {
      // Running the same rows twice would insert duplicates, so wait for new input.
      barText.textContent = 'Finished. Load new data or change the mapping to run again.';
      return;
    }
    barText.textContent = issue ? `${issue}.` : `${verb()} ${ready.toLocaleString()} ${state.objectName} record${ready === 1 ? '' : 's'}`;
  }

  const calls = (rows) => {
    const n = Math.ceil(rows / BATCH);
    return `${n} API call${n === 1 ? '' : 's'}`;
  };

  const verb = () => ({ insert: 'Insert', update: 'Update', delete: 'Delete' })[state.op];

  async function run() {
    const built = buildRecords();
    const ready = built.filter((b) => !b.error);
    if (!state.confirming) {
      state.confirming = true;
      await confirmIn(runBar, barText, ctx.getOrg, `${verb()} ${ready.length.toLocaleString()} ${state.objectName} record${ready.length === 1 ? '' : 's'}`);
      runBtn.textContent = state.op === 'delete' ? 'Delete' : 'Run';
      cancelBtn.hidden = false;
      return;
    }

    state.running = true;
    state.stop = false;
    state.confirming = false;
    runBtn.disabled = true;
    cancelBtn.hidden = true;
    stopBtn.hidden = false;
    runBar.classList.remove('confirm', 'danger');

    const outcome = new Map(built.filter((b) => b.error).map((b) => [b.index, { success: false, error: `Not sent: ${b.error}` }]));
    try {
      await inBatches(ready, BATCH, async (chunk) => {
        let results;
        if (state.op === 'insert') results = await ctx.client.createRecords(chunk.map((b) => b.record));
        else if (state.op === 'update') results = await ctx.client.updateRecords(chunk.map((b) => b.record));
        else results = await ctx.client.deleteRecords(chunk.map((b) => b.record.Id));
        chunk.forEach((b, i) => {
          const r = results[i];
          outcome.set(b.index, r?.success ? { success: true, id: r.id || b.record.Id } : { success: false, error: errorText(r) });
        });
        return results;
      }, {
        shouldStop: () => state.stop,
        onProgress: (done, total) => (barText.textContent = `${verb()}: ${done.toLocaleString()} / ${total.toLocaleString()}…`),
      });
    } catch (error) {
      toast(error.message);
    }
    state.running = false;
    stopBtn.hidden = true;
    state.results = { outcome, total: built.length, stopped: state.stop };
    state.finished = true;
    renderResults();
    renderRunBar();
  }

  function renderResults() {
    if (!state.results) {
      resultsBox.replaceChildren();
      return;
    }
    const { outcome, total, stopped } = state.results;
    const ok = [...outcome.values()].filter((o) => o.success).length;
    const failures = [...outcome.entries()].filter(([, o]) => !o.success).sort((a, b) => a[0] - b[0]);
    const notRun = total - outcome.size;

    resultsBox.replaceChildren(
      el('div', { class: 'import-results' },
        el('h3', {}, 'Results'),
        el('p', { class: 'compare-summary' },
          `${ok.toLocaleString()} succeeded, ${failures.length.toLocaleString()} failed` + (notRun ? `, ${notRun.toLocaleString()} not run${stopped ? ' (stopped)' : ''}` : '') + '.'),
        el('div', { class: 'row' }, el('button', { class: 'btn secondary', onclick: downloadResults }, 'Download results CSV')),
        failures.length
          ? el('div', { class: 'table-wrap' },
              el('table', { class: 'grid' },
                el('thead', {}, el('tr', {}, el('th', {}, 'Row'), el('th', {}, 'Error'))),
                el('tbody', {}, failures.slice(0, 200).map(([index, o]) => el('tr', { class: 'failed' }, el('td', {}, String(index + 2)), el('td', {}, o.error))))
              )
            )
          : null
      )
    );
  }

  function downloadResults() {
    const { outcome } = state.results;
    const cell = (v) => {
      const text = v == null ? '' : String(v);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [
      [...state.headers, 'Result Id', 'Result', 'Error'].map(cell).join(','),
      ...state.rows.map((row, i) => {
        const o = outcome.get(i);
        return [...state.headers.map((_, c) => row[c]), o?.id, o ? (o.success ? 'Success' : 'Failed') : 'Not run', o?.error].map(cell).join(',');
      }),
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
    const link = el('a', {
      href: URL.createObjectURL(blob),
      download: `${state.op}-${state.objectName}-results-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`,
    });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function refresh() {
    state.finished = false;
    renderMapping();
    renderPreview();
    renderRunBar();
    renderResults();
  }

  setOp('insert');
  const requested = ctx.params.get('object');
  if (requested) {
    objectInput.value = requested;
    objectInput.dispatchEvent(new Event('change'));
  }
}

// --- CSV --------------------------------------------------------------------------

// RFC 4180-style parser: quoted fields, doubled quotes, newlines inside quotes.
// The delimiter (comma, semicolon or tab) is guessed from the header row.
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  if (!text.trim()) return { headers: [], rows: [], delimiter: ',' };

  const firstLine = text.split(/\r?\n/, 1)[0];
  const count = (ch) => firstLine.split(ch).length - 1;
  const delimiter = ['\t', ';', ','].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ',');

  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    records.push(row);
  }

  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ''));
  const [headers = [], ...rows] = nonEmpty;
  return { headers: headers.map((h) => h.trim()), rows, delimiter };
}
