// Shared pieces for the Access views: permission definitions, the rules
// Salesforce enforces between them, lock rules, the save engine and a few
// small widgets.

import { el } from '../shared/ui.js';

export const OBJECT_PERMS = [
  ['PermissionsRead', 'Read'],
  ['PermissionsCreate', 'Create'],
  ['PermissionsEdit', 'Edit'],
  ['PermissionsDelete', 'Delete'],
  ['PermissionsViewAllRecords', 'View All'],
  ['PermissionsModifyAllRecords', 'Modify All'],
];

// The same dependencies Salesforce enforces in Setup.
export const OBJECT_REQUIRES = {
  PermissionsCreate: ['PermissionsRead'],
  PermissionsEdit: ['PermissionsRead'],
  PermissionsDelete: ['PermissionsRead', 'PermissionsEdit'],
  PermissionsViewAllRecords: ['PermissionsRead'],
  PermissionsModifyAllRecords: ['PermissionsRead', 'PermissionsEdit', 'PermissionsDelete', 'PermissionsViewAllRecords'],
};

export const FIELD_PERMS = [
  ['PermissionsRead', 'Read'],
  ['PermissionsEdit', 'Edit'],
];

export const FIELD_REQUIRES = { PermissionsEdit: ['PermissionsRead'] };

export const permsetDisplay = (ps) => (ps.isProfile ? `${ps.label} (Profile)` : `${ps.label} (${ps.apiName})`);

export const permsetSetupPath = (ps) =>
  ps.isProfile
    ? `/lightning/setup/EnhancedProfiles/page?address=%2F${ps.profileId}`
    : `/lightning/setup/PermSets/page?address=%2F${ps.id}`;

export function objectLockReason(ps) {
  if (ps.namespace) return 'Managed package permission set (read only)';
  if (!ps.isCustom) return ps.isProfile ? "Standard profile: object permissions can't be changed" : 'Standard permission set (read only)';
  return null;
}

export function fieldLockReason(ps) {
  if (ps.namespace) return 'Managed package permission set (read only)';
  if (!ps.isCustom && !ps.isProfile) return 'Standard permission set (read only)';
  return null;
}

// Formula, roll-up and auto-number fields can be read but never edited.
export const isReadOnlyField = (f) => f.calculated || f.autoNumber;

export const permissionableFields = (describe) =>
  describe.fields.filter((f) => f.permissionable).sort((a, b) => a.label.localeCompare(b.label));

export const pickValues = (record, perms) => Object.fromEntries(perms.map(([key]) => [key, Boolean(record?.[key])]));

// Turning a permission on also turns on what it needs; turning one off
// turns off everything that depends on it.
export function applyToggle(values, key, on, requires) {
  values[key] = on;
  if (on) {
    for (const dep of requires[key] || []) if (!values[dep]) applyToggle(values, dep, true, requires);
  } else {
    for (const [other, deps] of Object.entries(requires)) {
      if (deps.includes(key) && values[other]) applyToggle(values, other, false, requires);
    }
  }
}

export const soqlIdList = (ids) => ids.map((id) => `'${id}'`).join(',');

// Runs a query once per chunk of `values`, for IN clauses that could get long.
export async function queryInChunks(client, values, build, size = 150) {
  const records = [];
  for (let i = 0; i < values.length; i += size) {
    records.push(...(await client.query(build(values.slice(i, i + size)), { maxRecords: 50000 })).records);
  }
  return records;
}

// Saves staged permission rows: { values, original, recordId, createFields }.
// A row with nothing granted deletes its record. On success a row's
// `original` and `recordId` are updated; on failure its `error` is set.
export async function writePermissions(client, sobjectType, perms, rows) {
  const permFields = (row) => Object.fromEntries(perms.map(([k]) => [k, row.values[k]]));
  const granted = (row) => perms.some(([k]) => row.values[k]);
  const creates = [];
  const updates = [];
  const deletes = [];
  let saved = 0;
  const failures = [];

  for (const row of rows) {
    if (!granted(row)) {
      if (row.recordId) {
        deletes.push(row);
      } else {
        row.original = { ...row.values };
        saved++;
      }
    } else if (row.recordId) {
      updates.push(row);
    } else {
      creates.push(row);
    }
  }

  const apply = (batch, results, onSuccess) =>
    batch.forEach((row, i) => {
      const result = results[i];
      if (result?.success) {
        row.original = { ...row.values };
        row.error = null;
        onSuccess(row, result);
        saved++;
      } else {
        row.error = result?.errors?.map((e) => e.message).join('; ') || 'Unknown error';
        failures.push(row);
      }
    });

  if (creates.length) {
    const results = await client.createRecords(
      creates.map((row) => ({ attributes: { type: sobjectType }, ...row.createFields, ...permFields(row) }))
    );
    apply(creates, results, (row, result) => (row.recordId = result.id));
  }
  if (updates.length) {
    const results = await client.updateRecords(
      updates.map((row) => ({ attributes: { type: sobjectType }, Id: row.recordId, ...permFields(row) }))
    );
    apply(updates, results, () => {});
  }
  if (deletes.length) {
    const results = await client.deleteRecords(deletes.map((row) => row.recordId));
    apply(deletes, results, (row) => (row.recordId = null));
  }
  return { saved, failures };
}

export function failureMessage(failures, label = (r) => r.label) {
  return (
    `${failures.length} change${failures.length === 1 ? '' : 's'} failed:\n` +
    failures.slice(0, 5).map((r) => `• ${label(r)}: ${r.error}`).join('\n') +
    (failures.length > 5 ? `\n…and ${failures.length - 5} more.` : '')
  );
}

// Shows "Apply N changes to <org>?" in `bar`; red for production.
export async function askToConfirm(getOrg, bar, textNode, count) {
  const { name, env } = await getOrg();
  bar.classList.add('confirm');
  bar.classList.toggle('danger', env.tone === 'prod');
  textNode.textContent = `Apply ${count} change${count === 1 ? '' : 's'} to ${name}${env.tone === 'prod' ? ' (PRODUCTION)' : ` (${env.label})`}?`;
}

// --- Widgets --------------------------------------------------------------

// A text input with suggestions. `items` are matched by their display text.
export function picker({ placeholder, items = [], display, onPick, value = null }) {
  const listId = `picker-${Math.random().toString(36).slice(2)}`;
  const datalist = el('datalist', { id: listId });
  const input = el('input', { list: listId, placeholder, autocomplete: 'off', spellcheck: 'false' });
  let current = value;
  let byText = new Map();

  const setItems = (next) => {
    byText = new Map(next.map((item) => [display(item), item]));
    datalist.replaceChildren(...next.map((item) => el('option', { value: display(item) })));
  };
  setItems(items);
  if (value) input.value = display(value);

  input.addEventListener('change', () => {
    const item = byText.get(input.value.trim());
    if (item) {
      current = item;
      onPick(item);
    } else {
      input.value = current ? display(current) : '';
    }
  });

  return { node: el('span', { class: 'picker' }, input, datalist), input, setItems };
}

// A filterable list of checkboxes with select-all/none for what's visible.
export function checklist({ items, label, sub = () => '', disabledReason = () => null, kindOf = null, placeholder }) {
  const selected = new Set();
  const filter = el('input', { placeholder, autocomplete: 'off' });
  const kind = kindOf
    ? el('select', {},
        el('option', { value: 'all' }, 'All'),
        el('option', { value: 'profile' }, 'Profiles'),
        el('option', { value: 'permset' }, 'Permission sets'))
    : null;
  const count = el('span', { class: 'muted' });
  const list = el('div', { class: 'checklist' });
  let onChange = () => {};

  const visible = () => {
    const terms = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter(
      (item) =>
        (!kind || kind.value === 'all' || kindOf(item) === kind.value) &&
        terms.every((t) => `${label(item)} ${sub(item)}`.toLowerCase().includes(t))
    );
  };

  const render = () => {
    list.replaceChildren(
      ...visible().map((item) => {
        const reason = disabledReason(item);
        const box = el('input', {
          type: 'checkbox',
          checked: selected.has(item),
          disabled: Boolean(reason),
          onchange: (e) => {
            if (e.target.checked) selected.add(item);
            else selected.delete(item);
            updateCount();
          },
        });
        return el('label', { class: `check-item${reason ? ' locked' : ''}`, title: reason },
          box,
          el('span', {}, el('span', {}, label(item)), el('span', { class: 'access-sub' }, sub(item)))
        );
      })
    );
    updateCount();
  };

  const updateCount = () => {
    count.textContent = `${selected.size} selected`;
    onChange();
  };

  const setAll = (on) => {
    for (const item of visible()) {
      if (disabledReason(item)) continue;
      if (on) selected.add(item);
      else selected.delete(item);
    }
    render();
  };

  filter.addEventListener('input', render);
  kind?.addEventListener('change', render);
  render();

  return {
    node: el('div', { class: 'checklist-box' },
      el('div', { class: 'row' }, filter, kind),
      el('div', { class: 'row checklist-actions' },
        el('button', { class: 'link-btn', onclick: () => setAll(true) }, 'Select shown'),
        el('button', { class: 'link-btn', onclick: () => setAll(false) }, 'Clear shown'),
        el('span', { class: 'spacer' }),
        count),
      list),
    selected: () => [...selected],
    set onChange(fn) {
      onChange = fn;
    },
  };
}

export const mark = (on) => el('span', { class: `mark${on ? ' on' : ''}` }, on ? '✓' : '–');
