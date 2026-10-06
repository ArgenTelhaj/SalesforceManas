// The launcher's context tabs: the record you're on, its page layout, and you.
// Each render function fills its pane and is called again when the page changes.

import { to18 } from '../lib/salesforce.js';
import { rememberRecord } from '../shared/recent.js';
import { copy, el } from '../shared/ui.js';

const formatDate = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

const loading = (text = 'Loading…') => el('div', { class: 'loading' }, text);
const errorBox = (error) => el('div', { class: 'error' }, error?.message || String(error));
const empty = (text) => el('p', { class: 'muted l-empty' }, text);

function kv(rows) {
  return el('dl', { class: 'kv l-kv' },
    rows
      .filter(([, value]) => value != null && value !== '')
      .flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, value)])
  );
}

const link = (href, text, title) => el('a', { href, target: '_blank', title }, text);

// --- Record ----------------------------------------------------------------

export async function renderRecordPane(pane, ctx) {
  if (!ctx.record) {
    pane.replaceChildren(empty('Open a record to see its details here, or paste a record Id in the search above.'));
    return;
  }
  pane.replaceChildren(loading());

  const id15 = ctx.record.recordId.slice(0, 15);
  const id18 = to18(id15);
  try {
    const objectName = await ctx.objectName();
    const describe = await ctx.client.describe(objectName);
    const has = (name) => describe.fields.some((f) => f.name === name);
    const nameField = describe.fields.find((f) => f.nameField)?.name;
    const select = [
      'Id',
      nameField,
      has('RecordTypeId') && 'RecordType.Name',
      has('OwnerId') && 'Owner.Name',
      has('LastModifiedDate') && 'LastModifiedDate',
      has('LastModifiedById') && 'LastModifiedBy.Name',
      has('CreatedDate') && 'CreatedDate',
      has('CreatedById') && 'CreatedBy.Name',
    ].filter(Boolean);
    const { records } = await ctx.client.query(
      `SELECT ${[...new Set(select)].join(', ')} FROM ${objectName} WHERE Id = '${id18}'`
    );
    const record = records[0];
    if (!record) throw new Error(`No ${objectName} record with Id ${id18} is visible to you.`);
    if (!ctx.isCurrent()) return;
    rememberRecord(ctx.client.session.orgId, {
      id: id18,
      name: (nameField && record[nameField]) || id18,
      objectName,
      objectLabel: describe.label,
    }).then(ctx.recentChanged, () => {});

    const by = (date, user) => [formatDate(date), user?.Name].filter(Boolean).join(' · by ');
    pane.replaceChildren(
      el('div', { class: 'l-title' },
        el('span', { class: 'l-title-main' }, (nameField && record[nameField]) || id18),
        el('span', { class: 'chip-kind' }, describe.label === objectName ? objectName : `${describe.label} · ${objectName}`)
      ),
      kv([
        ['Record Id', el('span', { class: 'l-id' },
          el('code', { class: 'copyable', title: 'Click to copy', onclick: () => copy(id18, 'Copied 18-char Id') }, id18),
          el('span', { class: 'l-copy' },
            'Copy',
            el('button', { class: 'link-btn', title: 'Copy the 15-character Id', onclick: () => copy(id15, 'Copied 15-char Id') }, '15'),
            el('button', { class: 'link-btn', title: 'Copy the 18-character Id', onclick: () => copy(id18, 'Copied 18-char Id') }, '18')))],
        ['Record type', record.RecordType?.Name],
        ['Owner', record.Owner?.Name],
        ['Last modified', by(record.LastModifiedDate, record.LastModifiedBy)],
        ['Created', by(record.CreatedDate, record.CreatedBy)],
      ]),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => ctx.openWorkspace({ tab: 'record' }) }, 'Show all data'),
        el('button', { class: 'btn secondary', onclick: () => ctx.openWorkspace({ tab: 'access', mode: 'object', object: objectName }) }, 'Who has access')
      )
    );
  } catch (error) {
    if (ctx.isCurrent()) pane.replaceChildren(errorBox(error));
  }
}

// --- Layout ----------------------------------------------------------------

const OBJECT_LINKS = [
  ['Fields', 'FieldsAndRelationships'],
  ['Page layouts', 'PageLayouts'],
  ['Lightning pages', 'LightningPages'],
  ['Record types', 'RecordTypes'],
  ['Validation rules', 'ValidationRules'],
  ['Triggers', 'ApexTriggers'],
  ['Buttons & actions', 'ButtonsLinksActions'],
  ['Compact layouts', 'CompactLayouts'],
];

function objectLinks(ctx, objectName) {
  return el('div', {},
    el('h3', {}, `${objectName} in Object Manager`),
    el('div', { class: 'l-links' },
      OBJECT_LINKS.map(([label, page]) =>
        link(ctx.lightning(`/lightning/setup/ObjectManager/${objectName}/${page}/view`), label)
      )
    )
  );
}

// Fields on a UI API layout, grouped by section.
function layoutSections(layout) {
  return layout.sections
    .map((section) => ({
      heading: section.heading || 'Untitled section',
      fields: section.layoutRows.flatMap((row) =>
        row.layoutItems.flatMap((item) =>
          item.layoutComponents
            .filter((c) => c.componentType === 'Field' && c.apiName)
            .map((c) => ({ apiName: c.apiName, label: item.label || c.label, required: item.required }))
        )
      ),
    }))
    .filter((s) => s.fields.length);
}

export async function renderLayoutPane(pane, ctx) {
  const objectName = ctx.record ? null : ctx.objectFromPage;
  if (!ctx.record && !objectName) {
    pane.replaceChildren(empty('Open a record (or an object list view) to see its layout here.'));
    return;
  }
  pane.replaceChildren(loading());

  try {
    const object = objectName || (await ctx.objectName());
    const parts = [];

    if (ctx.record) {
      const id18 = to18(ctx.record.recordId.slice(0, 15));
      const ui = await ctx.client.request(`${ctx.client.base}/ui-api/record-ui/${id18}?layoutTypes=Full&modes=View`);
      const recordTypes = ui.layouts?.[object] || {};
      const layout = Object.values(recordTypes)[0]?.Full?.View;
      const recordTypeId = Object.keys(recordTypes)[0];

      if (layout?.id) {
        const [meta] = (await ctx.client.query(
          `SELECT Id, Name, LastModifiedDate, LastModifiedById FROM Layout WHERE Id = '${layout.id}'`,
          { tooling: true }
        )).records;
        const modifiedBy = meta?.LastModifiedById
          ? (await ctx.client.query(`SELECT Name FROM User WHERE Id = '${meta.LastModifiedById}'`)).records[0]?.Name
          : null;
        const isMaster = !recordTypeId || recordTypeId === '012000000000000AAA';
        const recordType = isMaster
          ? null
          : (await ctx.client.query(`SELECT Name, DeveloperName FROM RecordType WHERE Id = '${recordTypeId}'`)).records[0];
        const sections = layoutSections(layout);
        const fieldCount = sections.reduce((n, s) => n + s.fields.length, 0);
        const required = sections.flatMap((s) => s.fields.filter((f) => f.required));

        parts.push(
          el('div', { class: 'l-title' },
            el('span', { class: 'l-title-main' }, meta?.Name || 'Page layout'),
            el('span', { class: 'chip-kind' }, 'Page layout')
          ),
          kv([
            ['Layout Id', el('code', { class: 'copyable', title: 'Click to copy', onclick: () => copy(layout.id) }, layout.id)],
            ['Record type', isMaster ? 'Master' : `${recordType?.Name || ''} (${recordType?.DeveloperName || recordTypeId})`],
            ['Last modified', [formatDate(meta?.LastModifiedDate), modifiedBy].filter(Boolean).join(' · by ')],
            ['Contents', `${sections.length} sections · ${fieldCount} fields · ${required.length} required`],
          ]),
          el('div', { class: 'row' },
            el('button', {
              class: 'btn',
              onclick: () => ctx.navigate(ctx.lightning(`/lightning/setup/ObjectManager/${object}/PageLayouts/${layout.id}/view`)),
            }, 'Edit layout')
          ),
          el('details', { class: 'l-details' },
            el('summary', {}, `Fields on this layout (${fieldCount})`),
            sections.map((s) =>
              el('div', { class: 'l-section-fields' },
                el('div', { class: 'l-section-name' }, s.heading),
                s.fields.map((f) =>
                  el('div', { class: 'l-field', title: 'Click to copy the API name', onclick: () => copy(f.apiName) },
                    el('span', {}, f.label, f.required ? el('span', { class: 'l-required', title: 'Required on layout' }, ' *') : null),
                    el('code', {}, f.apiName)
                  )
                )
              )
            )
          )
        );
      } else {
        parts.push(empty("Couldn't read the page layout for this record."));
      }
    }

    // Lightning record pages built for this object in App Builder.
    try {
      const [entity] = (await ctx.client.query(
        `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = '${object}'`,
        { tooling: true }
      )).records;
      if (entity) {
        const { records: pages } = await ctx.client.query(
          `SELECT Id, MasterLabel, DeveloperName, LastModifiedDate FROM FlexiPage
           WHERE EntityDefinitionId = '${entity.DurableId}' AND Type = 'RecordPage' ORDER BY MasterLabel`,
          { tooling: true }
        );
        parts.push(
          el('h3', {}, `Lightning record pages (${pages.length})`),
          pages.length
            ? el('div', { class: 'l-list' },
                pages.map((p) =>
                  el('div', { class: 'l-list-row' },
                    el('span', {}, p.MasterLabel, el('span', { class: 'access-sub' }, ` ${p.DeveloperName}`)),
                    link(ctx.lightning(`/visualEditor/appBuilder.app?id=${p.Id}`), 'App Builder', 'Edit in Lightning App Builder')
                  )
                )
              )
            : empty('None. This object uses the default record page.')
        );
      }
    } catch {
      // Tooling access may be restricted; the rest of the pane still helps.
    }

    parts.push(objectLinks(ctx, object));
    if (ctx.isCurrent()) pane.replaceChildren(...parts);
  } catch (error) {
    if (ctx.isCurrent()) pane.replaceChildren(errorBox(error), ...(ctx.objectFromPage ? [objectLinks(ctx, ctx.objectFromPage)] : []));
  }
}

// --- Me ----------------------------------------------------------------------

export async function renderMePane(pane, ctx) {
  pane.replaceChildren(loading());
  try {
    const { user } = await ctx.info();
    const userPage = (id) => ctx.lightning(`/lightning/setup/ManageUsers/page?address=%2F${id}%3Fnoredirect%3D1`);
    const results = el('div', { class: 'l-list' });
    const search = el('input', { placeholder: 'Search users to log in as…', autocomplete: 'off', spellcheck: 'false' });
    const accessList = el('div', {}, loading('Loading your access…'));

    pane.replaceChildren(
      el('div', { class: 'l-title' },
        link(userPage(user.Id), user.Name, 'Open your user record in Setup'),
        el('span', { class: 'chip-kind' }, user.Username)
      ),
      kv([
        ['Profile', user.Profile?.Name],
        ['Email', user.Email],
        ['Role', user.UserRole?.Name],
        ['User Id', el('code', { class: 'copyable', title: 'Click to copy', onclick: () => copy(user.Id) }, user.Id)],
      ]),
      el('h3', {}, 'Log in as another user'),
      search,
      results,
      el('h3', {}, 'Your profile & permission sets'),
      accessList
    );

    setupUserSearch(search, results, ctx, user, userPage);
    accessList.replaceChildren(await myAccess(ctx, user.Id));
  } catch (error) {
    if (ctx.isCurrent()) pane.replaceChildren(errorBox(error));
  }
}

const escapeLike = (text) => text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[%_]/g, (c) => `\\${c}`);

function setupUserSearch(input, results, ctx, me, userPage) {
  let timer;
  let searchId = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const text = input.value.trim();
    if (text.length < 2) {
      results.replaceChildren();
      return;
    }
    timer = setTimeout(async () => {
      const id = ++searchId;
      try {
        const like = escapeLike(text);
        const { records } = await ctx.client.query(
          `SELECT Id, Name, Username, IsActive, UserType, Profile.Name FROM User
           WHERE Name LIKE '%${like}%' OR Username LIKE '%${like}%' OR Email LIKE '%${like}%'
           ORDER BY IsActive DESC, Name LIMIT 10`
        );
        if (id !== searchId) return;
        results.replaceChildren(
          ...(records.length ? records.map((u) => userRow(u, ctx, me, userPage)) : [empty('No users found.')])
        );
      } catch (error) {
        if (id === searchId) results.replaceChildren(errorBox(error));
      }
    }, 250);
  });
}

function userRow(user, ctx, me, userPage) {
  const reason =
    user.Id === me.Id ? "That's you" :
    !user.IsActive ? 'Inactive users can’t be logged in as' :
    user.UserType !== 'Standard' ? 'Use the contact record to log in as community users' :
    null;
  return el('div', { class: `l-user-row${user.IsActive ? '' : ' dim'}` },
    el('div', { class: 'l-user-main' },
      link(userPage(user.Id), user.Name, 'Open user in Setup'),
      el('span', { class: 'access-sub' }, `${user.Username} · ${user.Profile?.Name || user.UserType}`)
    ),
    el('div', { class: 'l-user-actions' },
      el('button', { class: 'btn small', disabled: Boolean(reason), title: reason || 'Log in as this user in this tab', onclick: () => ctx.loginAs(user, false) }, 'Log in'),
      el('button', { class: 'btn small secondary', disabled: Boolean(reason), title: reason || 'Log in as this user in an incognito window', onclick: () => ctx.loginAs(user, true) }, 'Incognito')
    )
  );
}

async function myAccess(ctx, userId) {
  const { records } = await ctx.client.query(
    `SELECT PermissionSetId, PermissionSetGroupId, PermissionSetGroup.MasterLabel,
            PermissionSet.Label, PermissionSet.Name, PermissionSet.IsOwnedByProfile,
            PermissionSet.ProfileId, PermissionSet.Profile.Name
     FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`
  );
  const order = { Profile: 0, 'Permission set': 1, 'Permission set group': 2 };
  const items = records
    .map((a) => {
      const ps = a.PermissionSet;
      if (ps.IsOwnedByProfile) {
        return { kind: 'Profile', label: ps.Profile?.Name, path: `/lightning/setup/EnhancedProfiles/page?address=%2F${ps.ProfileId}` };
      }
      if (a.PermissionSetGroupId) {
        return { kind: 'Permission set group', label: a.PermissionSetGroup?.MasterLabel || ps.Label, path: `/lightning/setup/PermSetGroups/page?address=%2F${a.PermissionSetGroupId}` };
      }
      return { kind: 'Permission set', label: ps.Label, sub: ps.Name, path: `/lightning/setup/PermSets/page?address=%2F${a.PermissionSetId}` };
    })
    .sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));

  return el('div', { class: 'l-list' },
    items.map((item) =>
      el('div', { class: 'l-list-row' },
        el('span', {}, link(ctx.lightning(item.path), item.label, 'Open in Setup'), item.sub ? el('span', { class: 'access-sub' }, ` ${item.sub}`) : null),
        el('span', { class: 'chip-kind' }, item.kind)
      )
    )
  );
}
