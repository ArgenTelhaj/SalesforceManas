// Bulk field access: set Read/Edit on many fields for many profiles and
// permission sets in one go, e.g. right after creating new fields.

import { el, toast } from '../shared/ui.js';
import {
  FIELD_PERMS,
  askToConfirm,
  checklist,
  failureMessage,
  fieldLockReason,
  isReadOnlyField,
  permissionableFields,
  queryInChunks,
  soqlIdList,
  writePermissions,
} from './access-common.js';

const LEVELS = [
  ['edit', 'Read & Edit'],
  ['read', 'Read only'],
  ['none', 'No access'],
];

export async function renderBulk(container, shared) {
  const { client, objectName } = shared;
  if (!objectName) {
    container.replaceChildren(
      el('p', { class: 'hint' }, 'Pick an object, then choose fields and profiles or permission sets to update together.')
    );
    return;
  }

  container.replaceChildren(el('div', { class: 'loading' }, 'Loading fields…'));
  let describe;
  try {
    describe = await shared.getDescribe();
  } catch (error) {
    container.replaceChildren(el('div', { class: 'error' }, error.message));
    return;
  }
  if (!shared.isCurrent()) return;

  const fieldList = checklist({
    items: permissionableFields(describe),
    label: (f) => f.label,
    sub: (f) => `${f.name}${isReadOnlyField(f) ? ' · read only' : ''}`,
    placeholder: 'Filter fields…',
  });
  const setList = checklist({
    items: shared.permsets,
    label: (ps) => ps.label,
    sub: (ps) => (ps.isProfile ? 'Profile' : ps.apiName),
    disabledReason: fieldLockReason,
    kindOf: (ps) => (ps.isProfile ? 'profile' : 'permset'),
    placeholder: 'Filter profiles and permission sets…',
  });

  const levelInputs = LEVELS.map(([value, label], i) =>
    el('label', { class: 'check' }, el('input', { type: 'radio', name: 'bulk-level', value, checked: i === 0, onchange: () => invalidate() }), label)
  );
  const status = el('p', { class: 'hint' });
  const error = el('div', { class: 'error', hidden: true });
  const barText = el('span');
  const cancel = el('button', { class: 'link-btn', hidden: true, onclick: () => invalidate() }, 'Cancel');
  const action = el('button', { class: 'btn', onclick: () => (plan ? apply() : preview()) });
  const bar = el('div', { class: 'savebar' }, barText, el('span', { class: 'spacer' }), cancel, action);

  container.replaceChildren(
    el('p', { class: 'hint' }, `Set field-level security on ${objectName} for many fields and profiles or permission sets at once.`),
    el('div', { class: 'bulk-columns' },
      el('div', {}, el('h3', {}, 'Fields'), fieldList.node),
      el('div', {}, el('h3', {}, 'Profiles & permission sets'), setList.node)
    ),
    el('div', { class: 'row bulk-level' }, el('strong', {}, 'Give them:'), levelInputs),
    status,
    error,
    bar
  );

  let plan = null;

  function invalidate() {
    plan = null;
    status.textContent = '';
    renderBar();
  }
  fieldList.onChange = invalidate;
  setList.onChange = invalidate;

  function renderBar() {
    bar.classList.remove('confirm', 'danger');
    cancel.hidden = !plan;
    action.disabled = false;
    if (!plan) {
      const f = fieldList.selected().length;
      const s = setList.selected().length;
      barText.textContent = `${f} field${f === 1 ? '' : 's'} × ${s} profile${s === 1 ? '' : 's'} / permission set${s === 1 ? '' : 's'}`;
      action.textContent = 'Preview changes';
      action.disabled = !f || !s;
    } else if (!plan.rows.length) {
      barText.textContent = 'Everything already matches. Nothing to change.';
      action.textContent = 'Apply';
      action.disabled = true;
    } else {
      action.textContent = 'Apply';
      askToConfirm(shared.getOrg, bar, barText, plan.rows.length);
    }
  }

  async function preview() {
    const level = levelInputs.map((l) => l.querySelector('input')).find((i) => i.checked).value;
    const fields = fieldList.selected();
    const sets = setList.selected();
    error.hidden = true;
    action.disabled = true;
    action.textContent = 'Checking…';

    try {
      const records = await queryInChunks(
        client,
        sets.map((s) => s.id),
        (ids) =>
          `SELECT Id, ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType = '${objectName}' AND ParentId IN (${soqlIdList(ids)})`,
        100
      );
      const existing = new Map(records.map((r) => [`${r.ParentId}|${r.Field}`, r]));

      const rows = [];
      let unchanged = 0;
      let editSkipped = 0;
      for (const ps of sets) {
        for (const f of fields) {
          const fieldPath = `${objectName}.${f.name}`;
          const record = existing.get(`${ps.id}|${fieldPath}`);
          const original = { PermissionsRead: Boolean(record?.PermissionsRead), PermissionsEdit: Boolean(record?.PermissionsEdit) };
          const values = { PermissionsRead: level !== 'none', PermissionsEdit: level === 'edit' };
          if (values.PermissionsEdit && isReadOnlyField(f)) {
            values.PermissionsEdit = false;
            editSkipped++;
          }
          if (values.PermissionsRead === original.PermissionsRead && values.PermissionsEdit === original.PermissionsEdit) {
            unchanged++;
            continue;
          }
          rows.push({
            label: `${ps.label} · ${f.label}`,
            values,
            original,
            recordId: record?.Id || null,
            createFields: { ParentId: ps.id, SobjectType: objectName, Field: fieldPath },
            error: null,
          });
        }
      }

      plan = { rows };
      const added = rows.filter((r) => !r.recordId).length;
      const removed = rows.filter((r) => r.recordId && !r.values.PermissionsRead).length;
      status.textContent =
        `${rows.length} change${rows.length === 1 ? '' : 's'}: ${added} new, ${rows.length - added - removed} updated, ${removed} removed. ` +
        `${unchanged} already match.` +
        (editSkipped ? ` Edit left off for ${editSkipped} read-only field combination${editSkipped === 1 ? '' : 's'}.` : '');
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
    renderBar();
  }

  async function apply() {
    action.disabled = true;
    action.textContent = 'Saving…';
    error.hidden = true;
    try {
      const { saved, failures } = await writePermissions(client, 'FieldPermissions', FIELD_PERMS, plan.rows);
      if (failures.length) {
        error.textContent = failureMessage(failures);
        error.hidden = false;
      }
      if (saved) toast(`Saved ${saved} change${saved === 1 ? '' : 's'}`);
      status.textContent = `Saved ${saved} of ${plan.rows.length} changes.`;
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
    plan = null;
    renderBar();
  }

  renderBar();
}
