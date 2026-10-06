// Full-tab workspace: Record inspector, Access manager, SOQL and Org details.
// Opened from the launcher (toolbar popup or the side tab on Salesforce pages)
// with ?page=<Salesforce URL>&tab=<panel> plus panel-specific params.

import { isSalesforceId, isSalesforceUrl, parseRecordFromUrl, to18 } from '../lib/salesforce.js';
import { connect, getOrgInfo, renderOrgChip } from '../shared/context.js';
import { rememberRecord } from '../shared/recent.js';
import { $, copy, el, showError, toast } from '../shared/ui.js';
import { initAccess } from './access.js';
import { confirmIn, displayValue, editCell, friendlyValue, isWritable, sameValue } from './fields.js';
import { initImport } from './import.js';
import { initLogs } from './logs.js';
import { attachSoqlAutocomplete } from './soql-complete.js';
import { hasUnsavedSoqlEdits, initSoqlResults, showSoqlResults } from './soql-results.js';

const params = new URLSearchParams(location.search);

const state = {
  pageUrl: params.get('page'),
  client: null,
  loaded: new Set(),
};

const lightning = (path) => state.client.session.lightningUrl + path;

async function getOrg() {
  const { org, env } = await getOrgInfo(state.client);
  return { name: org.Name, env };
}

async function start() {
  if (!state.pageUrl || !isSalesforceUrl(state.pageUrl)) {
    $('no-org').hidden = false;
    return;
  }
  try {
    state.client = await connect(state.pageUrl);
  } catch (error) {
    $('no-org').hidden = false;
    $('no-org-detail').textContent = error.message;
    return;
  }

  $('app').hidden = false;
  document.querySelectorAll('.tabs button').forEach((btn) => btn.addEventListener('click', () => selectTab(btn.dataset.tab)));
  selectTab(params.get('tab') in loaders ? params.get('tab') : parseRecordFromUrl(state.pageUrl) ? 'record' : 'access');

  try {
    const info = await getOrgInfo(state.client);
    renderOrgChip(info);
    document.title = `SalesforceManas · ${info.org.Name}`;
  } catch {
    // The Org tab shows the error.
  }
}

// --- Tabs -----------------------------------------------------------------

const loaders = {
  record: loadRecord,
  access: () =>
    initAccess({
      client: state.client,
      pageUrl: state.pageUrl,
      params,
      lightning,
      getOrg,
    }),
  soql: loadSoql,
  import: () => initImport($('import-root'), { client: state.client, getOrg, lightning, params }),
  logs: () => initLogs($('logs-root'), { client: state.client, lightning }),
  org: loadOrg,
};

function selectTab(name) {
  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  const url = new URL(location.href);
  url.searchParams.set('tab', name);
  history.replaceState(null, '', url);
  if (!state.loaded.has(name)) {
    state.loaded.add(name);
    loaders[name]();
  }
  if (name === 'soql') $('soql-input').focus();
}

// --- Org tab --------------------------------------------------------------

function kvRows(container, rows) {
  container.replaceChildren(
    ...rows.flatMap(([label, value, copyable]) => [
      el('dt', {}, label),
      el(
        'dd',
        copyable && value ? { class: 'copyable', title: 'Click to copy', onclick: () => copy(value) } : {},
        value ?? '—'
      ),
    ])
  );
}

async function loadOrg() {
  try {
    const { org, user, limits } = await getOrgInfo(state.client, { fresh: true });
    const { session, instanceUrl, apiVersion } = state.client;

    kvRows($('org-kv'), [
      ['Name', org.Name],
      ['Org Id', to18(session.orgId), true],
      ['Edition', org.OrganizationType],
      ['Instance', org.InstanceName],
      ['My Domain', instanceUrl.replace('https://', ''), true],
      ['API version', `v${apiVersion}`],
      ['Namespace', org.NamespacePrefix],
      ['Trial expires', org.TrialExpirationDate?.slice(0, 10)],
    ]);
    kvRows($('user-kv'), [
      ['Name', user.Name],
      ['Username', user.Username, true],
      ['User Id', user.Id, true],
      ['Email', user.Email],
      ['Profile', user.Profile?.Name],
      ['Role', user.UserRole?.Name],
      ['Time zone', user.TimeZoneSidKey],
    ]);
    renderLimits(limits);

    $('org-details').hidden = false;
  } catch (error) {
    showError('org-error', error);
  } finally {
    $('org-loading').hidden = true;
  }
}

const LIMITS = [
  ['DailyApiRequests', 'API requests (24h)'],
  ['DataStorageMB', 'Data storage (MB)'],
  ['FileStorageMB', 'File storage (MB)'],
  ['DailyAsyncApexExecutions', 'Async Apex (24h)'],
  ['SingleEmail', 'Single emails (24h)'],
];

function renderLimits(limits) {
  if (!limits) {
    $('limits').replaceChildren(el('p', { class: 'muted' }, 'Your user cannot view org limits.'));
    return;
  }
  $('limits').replaceChildren(
    ...LIMITS.filter(([key]) => limits[key]).map(([key, label]) => {
      const { Max, Remaining } = limits[key];
      const used = Max - Remaining;
      const pct = Max ? Math.min(100, (used / Max) * 100) : 0;
      return el(
        'div',
        { class: 'limit' },
        el('div', { class: 'limit-head' },
          el('span', {}, label),
          el('span', {}, `${used.toLocaleString()} / ${Max.toLocaleString()} (${pct.toFixed(0)}%)`)
        ),
        el('div', { class: `meter${pct >= 80 ? ' warn' : ''}` }, el('span', { style: `width:${pct}%` }))
      );
    })
  );
}

// --- Record tab -----------------------------------------------------------

// The record being inspected and any unsaved inline edits (field name -> new value).
const rec = { objectName: null, id: null, fields: [], changes: new Map(), errorFields: new Set(), confirming: false };

function loadRecord() {
  $('goto-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('goto-id').value.trim();
    if (!isSalesforceId(id)) return toast('That is not a valid record Id');
    if (rec.changes.size) return toast('Save or discard your changes first');
    inspectRecord(id, null);
  });
  $('field-filter').addEventListener('input', renderFields);
  $('hide-empty').addEventListener('change', renderFields);
  $('only-editable').addEventListener('change', renderFields);
  $('record-discard').addEventListener('click', () => {
    if (rec.confirming) return updateRecordBar();
    rec.changes.clear();
    rec.errorFields.clear();
    $('record-error').hidden = true;
    renderFields();
  });
  $('record-save').addEventListener('click', saveRecord);
  window.addEventListener('beforeunload', (e) => {
    if (rec.changes.size) e.preventDefault();
  });

  const parsed = parseRecordFromUrl(state.pageUrl);
  const id = params.get('record') || parsed?.recordId;
  if (id) inspectRecord(id, params.get('record') ? null : parsed.objectName);
}

async function inspectRecord(recordId, objectName) {
  $('record-none').hidden = true;
  $('record-view').hidden = false;
  $('record-error').hidden = true;
  $('field-table').hidden = true;
  $('record-loading').hidden = false;
  rec.changes.clear();
  rec.errorFields.clear();
  updateRecordBar();

  const id15 = recordId.slice(0, 15);
  const id18 = to18(id15);
  $('goto-id').value = id18;
  $('record-id').textContent = id18;
  $('record-object').textContent = '';
  $('copy-id15').onclick = () => copy(id15, 'Copied 15-char Id');
  $('copy-id18').onclick = () => copy(id18, 'Copied 18-char Id');
  $('open-record').onclick = () => window.open(lightning(`/${id18}`), '_blank');

  try {
    objectName ||= await state.client.objectForId(recordId);
    if (!objectName) throw new Error(`Couldn't work out which object Id ${recordId} belongs to.`);
    $('record-object').textContent = objectName;
    $('open-object-manager').onclick = () =>
      window.open(lightning(`/lightning/setup/ObjectManager/${objectName}/FieldsAndRelationships/view`), '_blank');

    const { describe, fields } = await state.client.getRecordWithFields(objectName, id18);
    $('record-object').textContent = `${describe.label} (${objectName})`;
    document.title = `${describe.label} ${id18} · SalesforceManas`;
    Object.assign(rec, { objectName, id: id18, fields });
    const name = fields.find((f) => f.meta.nameField)?.value;
    rememberRecord(state.client.session.orgId, { id: id18, name: name || id18, objectName, objectLabel: describe.label }).catch(() => {});
    $('field-table').hidden = false;
    renderFields();
  } catch (error) {
    showError('record-error', error);
  } finally {
    $('record-loading').hidden = true;
  }
}

function renderFields() {
  const terms = $('field-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const hideEmpty = $('hide-empty').checked;
  const onlyEditable = $('only-editable').checked;

  const rows = rec.fields
    .map((f) => {
      const changed = rec.changes.has(f.name);
      const value = changed ? rec.changes.get(f.name) : f.value;
      return { ...f, changed, current: value, text: displayValue(value), shown: friendlyValue(value, f.type), writable: isWritable(f.meta) };
    })
    .filter((f) => f.changed || !(hideEmpty && f.text == null))
    .filter((f) => f.changed || !onlyEditable || f.writable)
    .filter((f) => {
      const haystack = `${f.label} ${f.name} ${f.text ?? ''} ${f.shown ?? ''}`.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    })
    .map((f) => {
      let content;
      if (f.text == null) content = el('span', { class: 'null' }, 'empty');
      else if (f.type === 'reference' && isSalesforceId(f.text)) content = el('a', { href: lightning(`/${f.text}`), target: '_blank' }, f.text);
      else content = el('span', { class: 'copyable', title: f.shown === f.text ? 'Click to copy' : `${f.text} · click to copy`, onclick: () => copy(f.text) }, f.shown);

      const classes = ['value-cell', f.writable && 'editable', f.changed && 'dirty', rec.errorFields.has(f.name) && 'cell-error'];
      const td = el('td', { class: classes.filter(Boolean).join(' '), title: f.writable ? 'Double-click to edit' : 'Read only' },
        content,
        f.writable ? el('button', { class: 'edit-btn', title: 'Edit', 'aria-label': `Edit ${f.label}`, onclick: () => startEdit(td, f) }, '✎') : null
      );
      if (f.writable) td.addEventListener('dblclick', () => startEdit(td, f));

      return el('tr', { class: f.changed ? 'changed' : null },
        el('td', {}, f.label),
        el('td', { class: 'copyable mono', title: 'Click to copy', onclick: () => copy(f.name) }, f.name),
        td
      );
    });

  $('field-table').tBodies[0].replaceChildren(...rows);
  updateRecordBar();
}

function startEdit(td, f) {
  editCell(td, f.meta, f.current, {
    onCommit: (value) => {
      if (sameValue(value, f.value)) rec.changes.delete(f.name);
      else rec.changes.set(f.name, value);
      rec.errorFields.delete(f.name);
      renderFields();
    },
  });
}

function updateRecordBar() {
  const count = rec.changes.size;
  rec.confirming = false;
  $('record-savebar').hidden = count === 0;
  $('record-savebar').classList.remove('confirm', 'danger');
  $('record-changes').textContent = `${count} unsaved change${count === 1 ? '' : 's'}`;
  $('record-save').textContent = 'Save';
  $('record-discard').textContent = 'Discard';
}

async function saveRecord() {
  if (!rec.changes.size) return;
  const { env } = await getOrg();
  // Production gets a second click; sandboxes save straight away.
  if (env.tone === 'prod' && !rec.confirming) {
    rec.confirming = true;
    await confirmIn($('record-savebar'), $('record-changes'), getOrg, `Save ${rec.changes.size} field change${rec.changes.size === 1 ? '' : 's'} on this record`);
    $('record-save').textContent = 'Save';
    $('record-discard').textContent = 'Cancel';
    return;
  }

  $('record-save').disabled = true;
  $('record-save').textContent = 'Saving…';
  $('record-error').hidden = true;
  try {
    await state.client.updateRecord(rec.objectName, rec.id, Object.fromEntries(rec.changes));
    toast(`Saved ${rec.changes.size} change${rec.changes.size === 1 ? '' : 's'}`);
    const { fields } = await state.client.getRecordWithFields(rec.objectName, rec.id);
    rec.fields = fields;
    rec.changes.clear();
    rec.errorFields.clear();
  } catch (error) {
    rec.errorFields = new Set((Array.isArray(error.details) ? error.details : []).flatMap((e) => e.fields || []));
    showError('record-error', error);
  } finally {
    $('record-save').disabled = false;
    renderFields();
  }
}

// --- SOQL tab -------------------------------------------------------------

const HISTORY_LIMIT = 25;

async function loadSoql() {
  const input = $('soql-input');
  const { soqlDraft, soqlHistory = [] } = await chrome.storage.local.get(['soqlDraft', 'soqlHistory']);
  if (soqlDraft) input.value = soqlDraft;
  renderHistory(soqlHistory);

  input.addEventListener('input', () => chrome.storage.local.set({ soqlDraft: input.value }));
  attachSoqlAutocomplete(input, { client: state.client, isTooling: () => $('soql-tooling').checked });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runSoql();
    }
  });
  $('soql-run').addEventListener('click', runSoql);
  $('soql-history').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const entry = JSON.parse(e.target.value);
    input.value = entry.q;
    $('soql-tooling').checked = entry.tooling;
    chrome.storage.local.set({ soqlDraft: entry.q });
    e.target.value = '';
    input.focus();
  });
  initSoqlResults({ client: state.client, getOrg, lightning });
}

function renderHistory(history) {
  $('soql-history').replaceChildren(
    el('option', { value: '' }, history.length ? 'History…' : 'No history yet'),
    ...history.map((entry) =>
      el('option', { value: JSON.stringify(entry) }, (entry.tooling ? '[Tooling] ' : '') + entry.q.replace(/\s+/g, ' ').slice(0, 80))
    )
  );
}

async function saveHistory(entry) {
  const { soqlHistory = [] } = await chrome.storage.local.get('soqlHistory');
  const next = [entry, ...soqlHistory.filter((h) => h.q !== entry.q || h.tooling !== entry.tooling)].slice(
    0,
    HISTORY_LIMIT
  );
  await chrome.storage.local.set({ soqlHistory: next });
  renderHistory(next);
}

async function runSoql() {
  const q = $('soql-input').value.trim();
  if (!q) return;
  if (hasUnsavedSoqlEdits()) return toast('Save or discard your edits before running another query');
  const tooling = $('soql-tooling').checked;
  const all = $('soql-all').checked;

  $('soql-error').hidden = true;
  $('soql-run').disabled = true;
  $('soql-run').textContent = 'Running…';
  const started = performance.now();

  try {
    const { records, totalSize, truncated } = await state.client.query(q, { tooling, all });
    const ms = Math.round(performance.now() - started);
    showSoqlResults({ records, tooling });
    $('soql-summary').textContent =
      `${records.length.toLocaleString()} of ${totalSize.toLocaleString()} rows · ${ms} ms` +
      (truncated ? ' · stopped at 5,000 rows' : '');
    $('soql-bar').hidden = false;
    saveHistory({ q, tooling });
  } catch (error) {
    showError('soql-error', error);
  } finally {
    $('soql-run').disabled = false;
    $('soql-run').textContent = 'Run';
  }
}

start();
