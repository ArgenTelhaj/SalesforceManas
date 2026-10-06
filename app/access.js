// Access tab: view and edit object permissions and field-level security
// across profiles and permission sets.
//
// Profiles and permission sets both store their permissions on a
// PermissionSet record (a profile owns one), so everything here reads and
// writes ObjectPermissions and FieldPermissions keyed by PermissionSet Id.
//
// The object, fields and field views share the editable grid in this file.
// Bulk, user and compare build their own UI in their own modules.

import { $, el, showError, toast } from '../shared/ui.js';
import {
  FIELD_PERMS,
  FIELD_REQUIRES,
  OBJECT_PERMS,
  OBJECT_REQUIRES,
  applyToggle,
  askToConfirm,
  failureMessage,
  fieldLockReason,
  isReadOnlyField,
  objectLockReason,
  permissionableFields,
  permsetDisplay,
  permsetSetupPath,
  pickValues,
  writePermissions,
} from './access-common.js';
import { renderBulk } from './access-bulk.js';
import { renderCompare } from './access-compare.js';
import { renderUser } from './access-user.js';

const CUSTOM_VIEWS = { bulk: renderBulk, user: renderUser, compare: renderCompare };

const HINTS = {
  object: 'Pick an object to see which profiles and permission sets can access it.',
  fields: 'Pick a profile or permission set to edit field-level security for every field on this object.',
  field: 'Pick a field to see who can read or edit it.',
};

let ctx;
const view = {
  mode: 'object',
  objectName: null,
  permsetId: null,
  fieldName: null,
  sobjects: [],
  permsets: [],
  describe: null,
  grid: null,
  confirming: false,
  loadId: 0,
};

export async function initAccess(context) {
  ctx = context;

  $('access-mode').addEventListener('click', (e) => {
    const mode = e.target.closest('button')?.dataset.mode;
    if (mode && mode !== view.mode && canLeave()) setMode(mode);
  });
  $('access-object').addEventListener('change', onObjectInput);
  $('access-target').addEventListener('change', onTargetInput);
  $('access-filter').addEventListener('input', renderGrid);
  $('access-kind').addEventListener('change', renderGrid);
  $('access-granted').addEventListener('change', renderGrid);
  $('access-discard').addEventListener('click', discard);
  $('access-save').addEventListener('click', save);

  const stored = await chrome.storage.local.get(['accessMode', 'accessObject']);
  const requestedMode = ctx.params.get('mode');
  view.mode = (requestedMode in HINTS || requestedMode in CUSTOM_VIEWS ? requestedMode : null) || stored.accessMode || 'object';
  renderModeButtons();

  try {
    const [sobjects, permsets] = await Promise.all([ctx.client.describeGlobal(), ctx.client.getPermissionSets()]);
    view.sobjects = sobjects.filter((s) => s.layoutable && !s.customSetting && !s.name.endsWith('__mdt'));
    view.permsets = permsets;
  } catch (error) {
    showError('access-error', error);
    return;
  }

  $('access-objects').replaceChildren(...view.sobjects.map((s) => el('option', { value: s.name, label: s.label })));

  const initial =
    findObject(ctx.params.get('object')) || findObject(objectFromUrl(ctx.pageUrl)) || findObject(stored.accessObject);
  if (initial) {
    $('access-object').value = initial.name;
    view.objectName = initial.name;
  }
  reload();
}

// --- Selection ----------------------------------------------------------

function findObject(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  return view.sobjects.find((s) => s.name.toLowerCase() === lower) || null;
}

function objectFromUrl(url) {
  const match =
    url.match(/\/lightning\/[ro]\/([A-Za-z0-9_]+)\//) || url.match(/\/lightning\/setup\/ObjectManager\/([A-Za-z0-9_]+)\//);
  return match?.[1];
}

function canLeave() {
  if (!view.grid || !changedRows().length) return true;
  toast('Save or discard your changes first');
  return false;
}

function onObjectInput() {
  const input = $('access-object');
  const object = findObject(input.value.trim());
  if (!object || object.name === view.objectName || !canLeave()) {
    input.value = view.objectName || (object ? input.value : '');
    if (!object && input.value) toast('Unknown object');
    return;
  }
  input.value = object.name;
  view.objectName = object.name;
  view.describe = null;
  view.fieldName = null;
  chrome.storage.local.set({ accessObject: object.name });
  reload();
}

function setMode(mode) {
  view.mode = mode;
  chrome.storage.local.set({ accessMode: mode });
  const url = new URL(location.href);
  url.searchParams.set('mode', mode);
  history.replaceState(null, '', url);
  renderModeButtons();
  reload();
}

function renderModeButtons() {
  for (const btn of $('access-mode').querySelectorAll('button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.mode === view.mode));
  }
}

function onTargetInput() {
  const input = $('access-target');
  const value = input.value.trim();
  if (view.mode === 'fields') {
    const ps = view.permsets.find((p) => permsetDisplay(p) === value || p.apiName === value || p.label === value);
    if (!ps || ps.id === view.permsetId || !canLeave()) {
      input.value = view.permsetId ? permsetDisplay(permsetById(view.permsetId)) : '';
      if (!ps && value) toast('Pick a profile or permission set from the list');
      return;
    }
    view.permsetId = ps.id;
    input.value = permsetDisplay(ps);
  } else {
    const field = view.describe?.fields.find((f) => f.permissionable && f.name.toLowerCase() === value.toLowerCase());
    if (!field || field.name === view.fieldName || !canLeave()) {
      input.value = view.fieldName || '';
      if (!field && value) toast('Pick a field from the list');
      return;
    }
    view.fieldName = field.name;
    input.value = field.name;
  }
  reload();
}

const permsetById = (id) => view.permsets.find((p) => p.id === id);

async function getDescribe() {
  view.describe ??= await ctx.client.describe(view.objectName);
  return view.describe;
}

// What the bulk, user and compare views get to work with.
function sharedContext(loadId) {
  return {
    client: ctx.client,
    lightning: ctx.lightning,
    getOrg: ctx.getOrg,
    params: ctx.params,
    objectName: view.objectName,
    permsets: view.permsets,
    getDescribe,
    isCurrent: () => loadId === view.loadId,
    // Jump to an editable grid view, e.g. from Compare to edit one side.
    openGrid: (mode, { permsetId, fieldName } = {}) => {
      if (permsetId) view.permsetId = permsetId;
      if (fieldName) view.fieldName = fieldName;
      setMode(mode);
    },
  };
}

// --- Loading ------------------------------------------------------------

async function reload() {
  const loadId = ++view.loadId;
  view.grid = null;
  view.confirming = false;

  const custom = CUSTOM_VIEWS[view.mode];
  $('access-grid-view').hidden = Boolean(custom);
  $('access-custom-view').hidden = !custom;
  if (custom) {
    custom($('access-custom-view'), sharedContext(loadId));
    return;
  }

  $('access-error').hidden = true;
  $('access-table').hidden = true;
  $('access-savebar').hidden = true;
  $('access-hint').textContent = HINTS[view.mode];
  $('access-target-row').hidden = view.mode === 'object' || !view.objectName;
  $('access-filter-row').hidden = true;
  $('access-kind').hidden = view.mode === 'fields';

  if (!view.objectName) return;

  $('access-loading').hidden = false;
  try {
    if (view.mode !== 'object') await prepareTarget();
    if (view.mode === 'fields' && !view.permsetId) return;
    if (view.mode === 'field' && !view.fieldName) return;

    const grid = await (view.mode === 'object' ? loadObjectGrid() : view.mode === 'fields' ? loadFieldsGrid() : loadFieldGrid());
    if (loadId !== view.loadId) return;
    view.grid = grid;
    $('access-filter').placeholder = view.mode === 'fields' ? 'Filter fields…' : 'Filter profiles and permission sets…';
    $('access-filter-row').hidden = false;
    $('access-table').hidden = false;
    renderGrid();
  } catch (error) {
    if (loadId === view.loadId) showError('access-error', error);
  } finally {
    if (loadId === view.loadId) $('access-loading').hidden = true;
  }
}

async function prepareTarget() {
  const input = $('access-target');
  input.setAttribute('list', 'access-targets');
  const describe = await getDescribe();
  if (view.mode === 'fields') {
    input.placeholder = 'Profile or permission set';
    input.value = view.permsetId ? permsetDisplay(permsetById(view.permsetId)) : '';
    $('access-targets').replaceChildren(...view.permsets.map((ps) => el('option', { value: permsetDisplay(ps) })));
  } else {
    input.placeholder = 'Field API name';
    input.value = view.fieldName || '';
    $('access-targets').replaceChildren(
      ...permissionableFields(describe).map((f) => el('option', { value: f.name, label: f.label }))
    );
  }
  if (!input.value) input.focus();
}

function permsetRow(ps, record, perms, lockReason, lockedKeys, createFields) {
  const values = pickValues(record, perms);
  return {
    key: ps.id,
    kind: ps.isProfile ? 'profile' : 'permset',
    label: ps.label,
    sub: ps.isProfile ? 'Profile' : ps.apiName + (ps.namespace ? ` · ${ps.namespace}` : ''),
    link: permsetSetupPath(ps),
    recordId: record?.Id || null,
    original: { ...values },
    values,
    lockReason,
    lockedKeys: lockReason ? new Set(perms.map(([k]) => k)) : new Set(lockedKeys),
    createFields,
    error: null,
  };
}

async function loadObjectGrid() {
  const object = view.objectName;
  const { records } = await ctx.client.query(
    `SELECT Id, ParentId, ${OBJECT_PERMS.map(([k]) => k).join(', ')} FROM ObjectPermissions WHERE SobjectType = '${object}'`,
    { maxRecords: 50000 }
  );
  const byParent = new Map(records.map((r) => [r.ParentId, r]));
  const rows = view.permsets.map((ps) =>
    permsetRow(ps, byParent.get(ps.id), OBJECT_PERMS, objectLockReason(ps), [], { ParentId: ps.id, SobjectType: object })
  );
  const granted = rows.filter((r) => r.values.PermissionsRead).length;
  $('access-hint').textContent = `Object permissions on ${object}: ${granted} of ${rows.length} profiles and permission sets can read it.`;
  return { perms: OBJECT_PERMS, requires: OBJECT_REQUIRES, sobjectType: 'ObjectPermissions', rows };
}

async function loadFieldsGrid() {
  const object = view.objectName;
  const ps = permsetById(view.permsetId);
  const { records } = await ctx.client.query(
    `SELECT Id, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType = '${object}' AND ParentId = '${ps.id}'`,
    { maxRecords: 50000 }
  );
  const byField = new Map(records.map((r) => [r.Field, r]));
  const lockReason = fieldLockReason(ps);
  const rows = permissionableFields(view.describe).map((f) => {
    const record = byField.get(`${object}.${f.name}`);
    const values = pickValues(record, FIELD_PERMS);
    return {
      key: f.name,
      kind: 'field',
      label: f.label,
      sub: `${f.name} · ${f.type}${isReadOnlyField(f) ? ' (read only)' : ''}`,
      link: null,
      recordId: record?.Id || null,
      original: { ...values },
      values,
      lockReason,
      lockedKeys: new Set(lockReason ? ['PermissionsRead', 'PermissionsEdit'] : isReadOnlyField(f) ? ['PermissionsEdit'] : []),
      createFields: { ParentId: ps.id, SobjectType: object, Field: `${object}.${f.name}` },
      error: null,
    };
  });
  $('access-hint').textContent = `Field-level security on ${object} for ${permsetDisplay(ps)}.`;
  return { perms: FIELD_PERMS, requires: FIELD_REQUIRES, sobjectType: 'FieldPermissions', rows };
}

async function loadFieldGrid() {
  const object = view.objectName;
  const field = view.describe.fields.find((f) => f.name === view.fieldName);
  const fieldPath = `${object}.${field.name}`;
  const { records } = await ctx.client.query(
    `SELECT Id, ParentId, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType = '${object}' AND Field = '${fieldPath}'`,
    { maxRecords: 50000 }
  );
  const byParent = new Map(records.map((r) => [r.ParentId, r]));
  const rows = view.permsets.map((ps) =>
    permsetRow(ps, byParent.get(ps.id), FIELD_PERMS, fieldLockReason(ps), isReadOnlyField(field) ? ['PermissionsEdit'] : [], {
      ParentId: ps.id,
      SobjectType: object,
      Field: fieldPath,
    })
  );
  $('access-hint').textContent =
    `Who can see ${field.label} (${fieldPath})` + (isReadOnlyField(field) ? '. This field is read only, so Edit is unavailable.' : '.');
  return { perms: FIELD_PERMS, requires: FIELD_REQUIRES, sobjectType: 'FieldPermissions', rows };
}

// --- Grid ---------------------------------------------------------------

const isChanged = (row) => view.grid.perms.some(([k]) => row.values[k] !== row.original[k]);
const changedRows = () => view.grid.rows.filter(isChanged);
const hasAccess = (row) => view.grid.perms.some(([k]) => row.values[k]);

function visibleRows() {
  const terms = $('access-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const kind = view.mode === 'fields' ? 'all' : $('access-kind').value;
  const grantedOnly = $('access-granted').checked;
  return view.grid.rows.filter(
    (row) =>
      (kind === 'all' || row.kind === kind) &&
      (!grantedOnly || hasAccess(row) || isChanged(row)) &&
      terms.every((t) => `${row.label} ${row.sub}`.toLowerCase().includes(t))
  );
}

function renderGrid() {
  if (!view.grid) return;
  const { perms } = view.grid;
  const rows = visibleRows();

  $('access-table').tHead.replaceChildren(
    el('tr', {},
      el('th', {}, view.mode === 'fields' ? 'Field' : 'Profile / permission set'),
      perms.map(([key, label]) =>
        el('th', { class: 'perm' },
          el('button', { class: 'col-toggle', title: `Toggle ${label} for all ${rows.length} rows shown`, onclick: () => toggleColumn(key) }, label)
        )
      )
    )
  );
  $('access-table').tBodies[0].replaceChildren(
    ...(rows.length ? rows.map(renderRow) : [el('tr', {}, el('td', { colspan: perms.length + 1, class: 'null' }, 'Nothing matches.'))])
  );
  updateSaveBar();
}

function renderRow(row) {
  const { perms, requires } = view.grid;
  const classes = [isChanged(row) && 'changed', row.error && 'failed', row.lockReason && 'locked'].filter(Boolean);
  const tr = el(
    'tr',
    { class: classes.join(' ') || null, title: row.error || row.lockReason || null },
    el('td', {},
      el('div', { class: 'access-name' },
        row.link
          ? el('a', { href: ctx.lightning(row.link), target: '_blank', title: 'Open in Setup' }, row.label)
          : el('span', {}, row.label),
        row.lockReason ? el('span', { class: 'lock-tag', title: row.lockReason }, 'read only') : null
      ),
      el('div', { class: 'access-sub' }, row.sub)
    ),
    perms.map(([key]) => {
      const input = el('input', {
        type: 'checkbox',
        checked: row.values[key],
        disabled: row.lockedKeys.has(key),
        'aria-label': key,
        onchange: (e) => {
          applyToggle(row.values, key, e.target.checked, requires);
          for (const k of row.lockedKeys) row.values[k] = row.original[k] && row.values[k];
          row.error = null;
          row.tr.replaceWith(renderRow(row));
          updateSaveBar();
        },
      });
      return el('td', { class: `perm${row.values[key] !== row.original[key] ? ' dirty' : ''}` }, input);
    })
  );
  row.tr = tr;
  return tr;
}

function toggleColumn(key) {
  const rows = visibleRows().filter((r) => !r.lockedKeys.has(key));
  if (!rows.length) return;
  const turnOn = !rows.every((r) => r.values[key]);
  for (const row of rows) {
    applyToggle(row.values, key, turnOn, view.grid.requires);
    for (const k of row.lockedKeys) row.values[k] = row.original[k] && row.values[k];
  }
  renderGrid();
}

// --- Saving -------------------------------------------------------------

function updateSaveBar() {
  const count = view.grid ? changedRows().length : 0;
  $('access-savebar').hidden = count === 0;
  $('access-savebar').classList.remove('confirm', 'danger');
  view.confirming = false;
  $('access-changes').textContent = `${count} unsaved change${count === 1 ? '' : 's'}`;
  $('access-save').textContent = 'Review & save';
  $('access-discard').textContent = 'Discard';
}

function discard() {
  if (view.confirming) return updateSaveBar();
  for (const row of view.grid.rows) {
    row.values = { ...row.original };
    row.error = null;
  }
  renderGrid();
}

async function save() {
  const rows = changedRows();
  if (!rows.length) return;

  if (!view.confirming) {
    view.confirming = true;
    await askToConfirm(ctx.getOrg, $('access-savebar'), $('access-changes'), rows.length);
    $('access-save').textContent = 'Apply';
    $('access-discard').textContent = 'Cancel';
    return;
  }

  $('access-save').disabled = true;
  $('access-save').textContent = 'Saving…';
  $('access-error').hidden = true;
  let result = { saved: 0, failures: [] };
  try {
    result = await writePermissions(ctx.client, view.grid.sobjectType, view.grid.perms, rows);
  } catch (error) {
    showError('access-error', error);
  } finally {
    $('access-save').disabled = false;
  }

  if (result.failures.length) showError('access-error', failureMessage(result.failures));
  if (result.saved) toast(`Saved ${result.saved} change${result.saved === 1 ? '' : 's'}`);
  renderGrid();
}
