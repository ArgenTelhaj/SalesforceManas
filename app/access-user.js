// User access: what one user can do with an object and its fields, combined
// from their profile, permission sets and permission set groups, and which
// of those grants each permission. Answers "why can't Jane see this field?"

import { el } from '../shared/ui.js';
import { OBJECT_PERMS, mark, permissionableFields, picker, soqlIdList } from './access-common.js';

let currentUser = null;

const escapeLike = (text) => text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[%_]/g, (c) => `\\${c}`);

export async function renderUser(container, shared) {
  const { client } = shared;
  const body = el('div');

  const userPicker = picker({
    placeholder: 'Search users by name or username…',
    display: (u) => `${u.Name} · ${u.Username}${u.IsActive ? '' : ' (inactive)'}`,
    value: currentUser,
    onPick: (u) => load(u),
  });

  let searchTimer;
  let searchId = 0;
  userPicker.input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const text = userPicker.input.value.trim();
    if (text.length < 2 || text.includes(' · ')) return;
    searchTimer = setTimeout(async () => {
      const id = ++searchId;
      const like = escapeLike(text);
      const { records } = await client.query(
        `SELECT Id, Name, Username, IsActive, Profile.Name FROM User
         WHERE Name LIKE '%${like}%' OR Username LIKE '%${like}%'
         ORDER BY IsActive DESC, Name LIMIT 25`
      );
      if (id === searchId) userPicker.setItems(records);
    }, 250);
  });

  container.replaceChildren(
    el('p', { class: 'hint' }, "See a user's combined access and where each permission comes from."),
    el('div', { class: 'row' }, userPicker.node),
    body
  );

  const requestedId = shared.params.get('user');
  if (!currentUser && requestedId) {
    const { records } = await client.query(`SELECT Id, Name, Username, IsActive, Profile.Name FROM User WHERE Id = '${requestedId}'`);
    currentUser = records[0] || null;
    if (currentUser) userPicker.input.value = `${currentUser.Name} · ${currentUser.Username}`;
  }
  if (currentUser) load(currentUser);
  else userPicker.input.focus();

  async function load(user) {
    currentUser = user;
    const url = new URL(location.href);
    url.searchParams.set('user', user.Id);
    history.replaceState(null, '', url);

    body.replaceChildren(el('div', { class: 'loading' }, 'Loading access…'));
    try {
      const sources = await loadSources(client, user.Id);
      if (!shared.isCurrent() || currentUser !== user) return;
      const parts = [userHeader(user, sources, shared)];

      if (!shared.objectName) {
        parts.push(el('p', { class: 'hint' }, 'Pick an object above to see what this user can do with it.'));
      } else {
        const ids = soqlIdList(sources.map((s) => s.id));
        const [objectPerms, fieldPerms, describe] = await Promise.all([
          client.query(
            `SELECT ParentId, ${OBJECT_PERMS.map(([k]) => k).join(', ')} FROM ObjectPermissions
             WHERE SobjectType = '${shared.objectName}' AND ParentId IN (${ids})`
          ),
          client.query(
            `SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions
             WHERE SobjectType = '${shared.objectName}' AND ParentId IN (${ids})`,
            { maxRecords: 50000 }
          ),
          shared.getDescribe(),
        ]);
        if (!shared.isCurrent() || currentUser !== user) return;
        parts.push(objectSection(shared.objectName, sources, objectPerms.records));
        parts.push(fieldSection(shared.objectName, sources, fieldPerms.records, describe));
      }
      body.replaceChildren(...parts);
    } catch (error) {
      body.replaceChildren(el('div', { class: 'error' }, error.message));
    }
  }
}

async function loadSources(client, userId) {
  const { records } = await client.query(
    `SELECT PermissionSetId, PermissionSetGroupId, PermissionSetGroup.MasterLabel,
            PermissionSet.Label, PermissionSet.Name, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name,
            PermissionSet.PermissionsViewAllData, PermissionSet.PermissionsModifyAllData
     FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`
  );
  const order = { Profile: 0, 'Permission set': 1, Group: 2 };
  return records
    .map((a) => {
      const ps = a.PermissionSet;
      const kind = ps.IsOwnedByProfile ? 'Profile' : a.PermissionSetGroupId ? 'Group' : 'Permission set';
      return {
        id: a.PermissionSetId,
        kind,
        label: kind === 'Profile' ? ps.Profile?.Name : kind === 'Group' ? a.PermissionSetGroup?.MasterLabel || ps.Label : ps.Label,
        viewAllData: ps.PermissionsViewAllData,
        modifyAllData: ps.PermissionsModifyAllData,
      };
    })
    .sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
}

function userHeader(user, sources, shared) {
  const modifyAll = sources.filter((s) => s.modifyAllData);
  const viewAll = sources.filter((s) => s.viewAllData && !s.modifyAllData);
  const userLink = `/lightning/setup/ManageUsers/page?address=%2F${user.Id}%3Fnoredirect%3D1`;

  return el('div', { class: 'user-card' },
    el('div', { class: 'user-name' },
      el('a', { href: shared.lightning(userLink), target: '_blank', title: 'Open user in Setup' }, user.Name),
      !user.IsActive && el('span', { class: 'badge' }, 'Inactive')
    ),
    el('div', { class: 'access-sub' }, `${user.Username} · ${user.Profile?.Name || ''}`),
    el('h3', {}, `Access comes from ${sources.length} source${sources.length === 1 ? '' : 's'}`),
    el('div', { class: 'chips' },
      sources.map((s) => {
        const editable = s.kind !== 'Group' && shared.permsets.some((p) => p.id === s.id);
        return el('span', { class: 'chip', title: editable ? 'Edit its field access' : null },
          editable
            ? el('button', { class: 'link-btn', onclick: () => shared.openGrid('fields', { permsetId: s.id }) }, s.label)
            : el('span', {}, s.label),
          el('span', { class: 'chip-kind' }, s.kind)
        );
      })
    ),
    modifyAll.length > 0 &&
      el('p', { class: 'notice' },
        `Has Modify All Data (from ${modifyAll.map((s) => s.label).join(', ')}): can read, edit and delete every record of every object, whatever the object permissions below say.`),
    viewAll.length > 0 &&
      el('p', { class: 'notice' },
        `Has View All Data (from ${viewAll.map((s) => s.label).join(', ')}): can read every record of every object.`)
  );
}

function objectSection(objectName, sources, records) {
  const byParent = new Map(records.map((r) => [r.ParentId, r]));
  const effective = Object.fromEntries(OBJECT_PERMS.map(([k]) => [k, records.some((r) => r[k])]));

  return el('div', {},
    el('h3', {}, `Object access on ${objectName}`),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'grid access-grid' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Source'), OBJECT_PERMS.map(([, label]) => el('th', { class: 'perm' }, label)))),
        el('tbody', {},
          el('tr', { class: 'effective' },
            el('td', {}, el('strong', {}, 'Effective access')),
            OBJECT_PERMS.map(([k]) => el('td', { class: 'perm' }, mark(effective[k])))
          ),
          sources.map((s) => {
            const r = byParent.get(s.id);
            return el('tr', { class: r ? null : 'dim' },
              el('td', {}, el('div', {}, s.label), el('div', { class: 'access-sub' }, s.kind)),
              OBJECT_PERMS.map(([k]) => el('td', { class: 'perm' }, mark(r?.[k])))
            );
          })
        )
      )
    )
  );
}

function fieldSection(objectName, sources, records, describe) {
  const labelOf = new Map(sources.map((s) => [s.id, s.label]));
  const byField = new Map();
  for (const r of records) {
    if (!byField.has(r.Field)) byField.set(r.Field, []);
    byField.get(r.Field).push(r);
  }

  const rows = permissionableFields(describe).map((f) => {
    const grants = byField.get(`${objectName}.${f.name}`) || [];
    return {
      field: f,
      read: grants.some((g) => g.PermissionsRead),
      edit: grants.some((g) => g.PermissionsEdit),
      grantedBy: grants
        .filter((g) => g.PermissionsRead)
        .map((g) => `${labelOf.get(g.ParentId)}${g.PermissionsEdit ? ' (edit)' : ''}`),
    };
  });

  const filter = el('input', { placeholder: 'Filter fields…', autocomplete: 'off' });
  const hiddenOnly = el('input', { type: 'checkbox' });
  const tbody = el('tbody');
  const summary = el('span', { class: 'muted' });

  const render = () => {
    const terms = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = rows.filter(
      (r) =>
        (!hiddenOnly.checked || !r.read) &&
        terms.every((t) => `${r.field.label} ${r.field.name}`.toLowerCase().includes(t))
    );
    tbody.replaceChildren(
      ...shown.map((r) =>
        el('tr', { class: r.read ? null : 'dim' },
          el('td', {}, el('div', {}, r.field.label), el('div', { class: 'access-sub' }, r.field.name)),
          el('td', { class: 'perm' }, mark(r.read)),
          el('td', { class: 'perm' }, mark(r.edit)),
          el('td', { class: 'access-sub' }, r.grantedBy.join(', ') || 'No source grants access')
        )
      )
    );
  };
  filter.addEventListener('input', render);
  hiddenOnly.addEventListener('change', render);
  render();

  const readable = rows.filter((r) => r.read).length;
  summary.textContent = `Can read ${readable} of ${rows.length} fields, edit ${rows.filter((r) => r.edit).length}.`;

  return el('div', {},
    el('h3', {}, `Field access on ${objectName}`),
    el('div', { class: 'row' }, filter, el('label', { class: 'check' }, hiddenOnly, "Only fields they can't read"), el('span', { class: 'spacer' }), summary),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'grid access-grid' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Field'), el('th', { class: 'perm' }, 'Read'), el('th', { class: 'perm' }, 'Edit'), el('th', {}, 'Granted by'))),
        tbody
      )
    )
  );
}
