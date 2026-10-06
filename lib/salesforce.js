// Salesforce session discovery and REST/Tooling API client.
//
// The extension reuses the session you already have in the browser: it reads
// the `sid` cookie for the org shown in the tab, then calls the REST API on the
// org's my.salesforce.com domain (Lightning domains don't accept API calls).

const SF_HOST_RE = /\.(salesforce\.com|force\.com|salesforce-setup\.com|visualforce\.com)$/i;

export function isSalesforceUrl(url) {
  try {
    return SF_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export class SalesforceError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Finds an API-capable session for the org open at `pageUrl`.
export async function getSession(pageUrl) {
  const { origin, hostname } = new URL(pageUrl);
  const pageSid = await chrome.cookies.get({ url: origin, name: 'sid' });
  if (!pageSid) {
    throw new SalesforceError('No Salesforce session found. Log in to the org in this tab first.');
  }
  const orgId = pageSid.value.split('!')[0];

  const candidates = (await chrome.cookies.getAll({ name: 'sid', domain: 'salesforce.com', secure: true }))
    .filter((c) => c.value.startsWith(orgId + '!'))
    .map((c) => ({ host: c.domain.replace(/^\./, ''), sessionId: c.value }));

  // Most likely first: the page's own host, then My Domain, then the rest.
  // An old cookie for the same org can outlive its session, so connect()
  // tries these in order until one works.
  const score = (c) => (c.host === hostname ? 0 : c.host.endsWith('.my.salesforce.com') ? 1 : 2);
  const sessions = [...candidates]
    .sort((a, b) => score(a) - score(b))
    .map((c) => ({
      orgId,
      instanceUrl: `https://${c.host}`,
      lightningUrl: toLightningUrl(c.host, origin),
      sessionId: c.sessionId,
    }));

  if (!sessions.length) {
    throw new SalesforceError(
      'Found a session for this org but not an API session. Open any Setup page once, then try again.'
    );
  }
  return sessions;
}

export const SESSION_EXPIRED =
  'Your Salesforce session has expired or was logged out. Reload the Salesforce tab (log in again if asked), then try again.';

// The Lightning Experience origin for an org, used to open UI pages.
function toLightningUrl(apiHost, pageOrigin) {
  if (/\.lightning\.force\.com$/.test(new URL(pageOrigin).hostname)) return pageOrigin;
  if (apiHost.endsWith('.my.salesforce.com')) {
    return 'https://' + apiHost.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
  }
  return `https://${apiHost}`;
}

export class SalesforceClient {
  constructor(session) {
    this.session = session;
    this.instanceUrl = session.instanceUrl;
    this.apiVersion = null;
  }

  async init() {
    const versions = await this.request('/services/data/');
    this.apiVersion = versions.at(-1).version;
    // The versions list needs no login, so check the session itself too.
    await this.request(`${this.base}/`);
    return this;
  }

  get base() {
    return `/services/data/v${this.apiVersion}`;
  }

  // `text: true` returns the body as text (e.g. Apex log bodies).
  async request(path, { method = 'GET', body, text = false } = {}) {
    const url = path.startsWith('http') ? path : this.instanceUrl + path;
    const headers = {
      Authorization: `Bearer ${this.session.sessionId}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    if (text && res.ok) return res.text();

    const data = await res.json().catch(() => null);
    if (res.status === 401) throw new SalesforceError(SESSION_EXPIRED, 401, data);
    if (!res.ok) {
      const message = Array.isArray(data)
        ? data.map((e) => e.message).join('\n')
        : data?.message || `${res.status} ${res.statusText}`;
      throw new SalesforceError(message, res.status, data);
    }
    return data;
  }

  // Runs a SOQL query, following nextRecordsUrl until done or maxRecords.
  async query(soql, { tooling = false, all = false, maxRecords = 5000 } = {}) {
    const endpoint = tooling ? 'tooling/query' : all ? 'queryAll' : 'query';
    let page = await this.request(`${this.base}/${endpoint}?q=${encodeURIComponent(soql)}`);
    const totalSize = page.totalSize;
    const records = [...page.records];
    while (!page.done && page.nextRecordsUrl && records.length < maxRecords) {
      page = await this.request(page.nextRecordsUrl);
      records.push(...page.records);
    }
    return { records, totalSize, truncated: !page.done };
  }

  async getCurrentUserId() {
    const resources = await this.request(`${this.base}/`);
    if (resources.identity) return resources.identity.split('/').pop();
    const info = await this.request('/services/oauth2/userinfo');
    return info.user_id;
  }

  async getOrgInfo() {
    const userId = await this.getCurrentUserId();
    const [org, user, limits] = await Promise.all([
      this.query(
        'SELECT Id, Name, IsSandbox, OrganizationType, InstanceName, NamespacePrefix, TrialExpirationDate FROM Organization'
      ),
      this.query(
        `SELECT Id, Name, Username, Email, Profile.Name, UserRole.Name, TimeZoneSidKey FROM User WHERE Id = '${userId}'`
      ),
      this.request(`${this.base}/limits`).catch(() => null),
    ]);
    return { org: org.records[0], user: user.records[0], limits };
  }

  // Describes are cached per client (REST and Tooling separately); a failed
  // describe is dropped from the cache so it can be retried.
  describeGlobal({ tooling = false } = {}) {
    return this._cached(`global:${tooling}`, async () =>
      (await this.request(`${this.base}/${tooling ? 'tooling/' : ''}sobjects/`)).sobjects
    );
  }

  describe(objectName, { tooling = false } = {}) {
    return this._cached(`describe:${tooling}:${objectName.toLowerCase()}`, () =>
      this.request(`${this.base}/${tooling ? 'tooling/' : ''}sobjects/${objectName}/describe`)
    );
  }

  _cached(key, load) {
    this._describeCache ??= new Map();
    if (!this._describeCache.has(key)) {
      this._describeCache.set(
        key,
        load().catch((error) => {
          this._describeCache.delete(key);
          throw error;
        })
      );
    }
    return this._describeCache.get(key);
  }

  async objectForId(recordId) {
    const prefix = recordId.slice(0, 3);
    const sobjects = await this.describeGlobal();
    return sobjects.find((s) => s.keyPrefix === prefix)?.name || null;
  }

  // sObject Collections: each returns one { id, success, errors } per input, in order.
  async createRecords(records) {
    return this._collections('POST', records);
  }

  async updateRecords(records) {
    return this._collections('PATCH', records);
  }

  async deleteRecords(ids) {
    const results = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200).join(',');
      results.push(...(await this.request(`${this.base}/composite/sobjects?ids=${chunk}&allOrNone=false`, { method: 'DELETE' })));
    }
    return results;
  }

  async _collections(method, records) {
    const results = [];
    for (let i = 0; i < records.length; i += 200) {
      const body = { allOrNone: false, records: records.slice(i, i + 200) };
      results.push(...(await this.request(`${this.base}/composite/sobjects`, { method, body })));
    }
    return results;
  }

  // Every profile and permission set that holds its own permissions
  // (permission set groups are computed, so they're left out).
  async getPermissionSets() {
    this._permissionSets ??= this.query(
      `SELECT Id, Name, Label, IsOwnedByProfile, IsCustom, NamespacePrefix, ProfileId, Profile.Name
       FROM PermissionSet WHERE PermissionSetGroupId = null ORDER BY Label`,
      { maxRecords: 20000 }
    ).then(({ records }) =>
      records.map((p) => ({
        id: p.Id,
        isProfile: p.IsOwnedByProfile,
        label: p.IsOwnedByProfile ? p.Profile?.Name || p.Label : p.Label,
        apiName: p.Name,
        profileId: p.ProfileId,
        namespace: p.NamespacePrefix,
        isCustom: p.IsCustom,
      }))
    ).catch((error) => {
      this._permissionSets = null;
      throw error;
    });
    return this._permissionSets;
  }

  async getRecordWithFields(objectName, recordId) {
    const [describe, result] = await Promise.all([
      this.describe(objectName),
      this.query(`SELECT FIELDS(ALL) FROM ${objectName} WHERE Id = '${recordId}' LIMIT 1`),
    ]);
    const record = result.records[0];
    if (!record) throw new SalesforceError(`No ${objectName} record found with Id ${recordId}.`);
    const fields = describe.fields
      .filter((f) => f.name in record)
      .map((f) => ({ name: f.name, label: f.label, type: f.type, value: record[f.name], meta: f }));
    return { describe, fields };
  }

  updateRecord(objectName, recordId, values) {
    return this.request(`${this.base}/sobjects/${objectName}/${recordId}`, { method: 'PATCH', body: values });
  }
}

// Picks the org edition label and colour from the Organization record.
export function environmentOf(org, host = '') {
  if (org.IsSandbox) {
    return host.includes('.scratch.') ? { label: 'Scratch', tone: 'scratch' } : { label: 'Sandbox', tone: 'sandbox' };
  }
  if (org.OrganizationType === 'Developer Edition') return { label: 'Developer', tone: 'dev' };
  if (org.TrialExpirationDate) return { label: 'Trial', tone: 'dev' };
  return { label: 'Production', tone: 'prod' };
}

// --- Record Id helpers --------------------------------------------------

const ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

export function isSalesforceId(value) {
  return ID_RE.test(value);
}

export function to18(id) {
  if (id.length !== 15) return id;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  let suffix = '';
  for (let block = 0; block < 3; block++) {
    let flags = 0;
    for (let i = 0; i < 5; i++) {
      const c = id[block * 5 + i];
      if (c >= 'A' && c <= 'Z') flags |= 1 << i;
    }
    suffix += chars[flags];
  }
  return id + suffix;
}

// Pulls the object name and record Id out of a Lightning or Classic URL.
export function parseRecordFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const lightning = u.pathname.match(/\/lightning\/r\/(?:([A-Za-z0-9_]+)\/)?([a-zA-Z0-9]{15,18})\//);
  if (lightning && isSalesforceId(lightning[2])) {
    return { objectName: lightning[1] || null, recordId: lightning[2] };
  }
  const classic = u.pathname.match(/^\/([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})(?:\/|$)/);
  if (classic) return { objectName: null, recordId: classic[1] };
  const param = u.searchParams.get('id');
  if (param && isSalesforceId(param)) return { objectName: null, recordId: param };
  return null;
}
