// Records you looked at recently, per org, so the launcher search can take
// you back to them. Filled by the launcher's Record tab and the record
// inspector; kept in chrome.storage.local.

const LIMIT = 20;
const key = (orgId) => `recent:${orgId.slice(0, 15)}`;

export async function recentRecords(orgId) {
  return (await chrome.storage.local.get(key(orgId)))[key(orgId)] || [];
}

// `record`: { id, name, objectName, objectLabel }
export async function rememberRecord(orgId, record) {
  const list = await recentRecords(orgId);
  const next = [{ ...record, at: Date.now() }, ...list.filter((r) => r.id !== record.id)].slice(0, LIMIT);
  await chrome.storage.local.set({ [key(orgId)]: next });
}
