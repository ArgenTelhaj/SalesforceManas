// Compare: two profiles or permission sets side by side for one object,
// object permissions and field-level security, highlighting differences.

import { el } from '../shared/ui.js';
import { OBJECT_PERMS, mark, permissionableFields, permsetDisplay, permsetSetupPath, picker } from './access-common.js';

const pair = [null, null];

export function renderCompare(container, shared) {
  const body = el('div');
  const pickers = pair.map((value, side) =>
    picker({
      placeholder: side === 0 ? 'First profile or permission set' : 'Second profile or permission set',
      items: shared.permsets,
      display: permsetDisplay,
      value,
      onPick: (ps) => {
        pair[side] = ps;
        load();
      },
    })
  );

  container.replaceChildren(
    el('p', { class: 'hint' }, 'Compare two profiles or permission sets on one object.'),
    el('div', { class: 'row compare-pickers' }, pickers[0].node, el('span', { class: 'muted' }, 'vs'), pickers[1].node),
    body
  );
  load();

  async function load() {
    const [a, b] = pair;
    if (!shared.objectName) {
      body.replaceChildren(el('p', { class: 'hint' }, 'Pick an object above.'));
      return;
    }
    if (!a || !b) {
      body.replaceChildren();
      pickers[a ? 1 : 0].input.focus();
      return;
    }

    body.replaceChildren(el('div', { class: 'loading' }, 'Comparing…'));
    try {
      const object = shared.objectName;
      const ids = `'${a.id}','${b.id}'`;
      const [objectPerms, fieldPerms, describe] = await Promise.all([
        shared.client.query(
          `SELECT ParentId, ${OBJECT_PERMS.map(([k]) => k).join(', ')} FROM ObjectPermissions WHERE SobjectType = '${object}' AND ParentId IN (${ids})`
        ),
        shared.client.query(
          `SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType = '${object}' AND ParentId IN (${ids})`,
          { maxRecords: 50000 }
        ),
        shared.getDescribe(),
      ]);
      if (!shared.isCurrent() || pair[0] !== a || pair[1] !== b) return;
      body.replaceChildren(...render(shared, object, a, b, objectPerms.records, fieldPerms.records, describe));
    } catch (error) {
      body.replaceChildren(el('div', { class: 'error' }, error.message));
    }
  }
}

function render(shared, object, a, b, objectRecords, fieldRecords, describe) {
  const objA = objectRecords.find((r) => r.ParentId === a.id);
  const objB = objectRecords.find((r) => r.ParentId === b.id);
  const objectDiffs = OBJECT_PERMS.filter(([k]) => Boolean(objA?.[k]) !== Boolean(objB?.[k])).length;

  const fieldMap = new Map(fieldRecords.map((r) => [`${r.ParentId}|${r.Field}`, r]));
  const fields = permissionableFields(describe).map((f) => {
    const ra = fieldMap.get(`${a.id}|${object}.${f.name}`);
    const rb = fieldMap.get(`${b.id}|${object}.${f.name}`);
    const values = [Boolean(ra?.PermissionsRead), Boolean(ra?.PermissionsEdit), Boolean(rb?.PermissionsRead), Boolean(rb?.PermissionsEdit)];
    return { field: f, values, differs: values[0] !== values[2] || values[1] !== values[3] };
  });
  const fieldDiffs = fields.filter((f) => f.differs).length;

  const sideHeader = (ps) =>
    el('th', { class: 'perm compare-side', colspan: 2 },
      el('a', { href: shared.lightning(permsetSetupPath(ps)), target: '_blank', title: 'Open in Setup' }, ps.label),
      el('div', {}, el('button', { class: 'link-btn', onclick: () => shared.openGrid('fields', { permsetId: ps.id }) }, 'Edit fields'))
    );

  const filter = el('input', { placeholder: 'Filter fields…', autocomplete: 'off' });
  const diffOnly = el('input', { type: 'checkbox', checked: fieldDiffs > 0 });
  const tbody = el('tbody');
  const renderFields = () => {
    const terms = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = fields.filter(
      (r) => (!diffOnly.checked || r.differs) && terms.every((t) => `${r.field.label} ${r.field.name}`.toLowerCase().includes(t))
    );
    tbody.replaceChildren(
      ...(shown.length
        ? shown.map((r) =>
            el('tr', { class: r.differs ? 'diff' : null },
              el('td', {}, el('div', {}, r.field.label), el('div', { class: 'access-sub' }, r.field.name)),
              r.values.map((v) => el('td', { class: 'perm' }, mark(v)))
            )
          )
        : [el('tr', {}, el('td', { colspan: 5, class: 'null' }, diffOnly.checked ? 'No differences.' : 'Nothing matches.'))])
    );
  };
  filter.addEventListener('input', renderFields);
  diffOnly.addEventListener('change', renderFields);
  renderFields();

  return [
    el('p', { class: 'compare-summary' },
      `${objectDiffs} difference${objectDiffs === 1 ? '' : 's'} in object access, ${fieldDiffs} field${fieldDiffs === 1 ? '' : 's'} with different field-level security.`),
    el('h3', {}, `Object access on ${object}`),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'grid access-grid compare-object' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Permission'), el('th', { class: 'perm' }, a.label), el('th', { class: 'perm' }, b.label))),
        el('tbody', {},
          OBJECT_PERMS.map(([k, label]) =>
            el('tr', { class: Boolean(objA?.[k]) !== Boolean(objB?.[k]) ? 'diff' : null },
              el('td', {}, label),
              el('td', { class: 'perm' }, mark(objA?.[k])),
              el('td', { class: 'perm' }, mark(objB?.[k]))
            )
          )
        )
      )
    ),
    el('h3', {}, `Field access on ${object}`),
    el('div', { class: 'row' }, filter, el('label', { class: 'check' }, diffOnly, 'Only differences')),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'grid access-grid' },
        el('thead', {},
          el('tr', {}, el('th', { rowspan: 2 }, 'Field'), sideHeader(a), sideHeader(b)),
          el('tr', {}, ['Read', 'Edit', 'Read', 'Edit'].map((l) => el('th', { class: 'perm' }, l)))
        ),
        tbody
      )
    ),
  ];
}
