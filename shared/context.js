// Shared startup for the launcher and the workspace: find the Salesforce page
// we're working with, connect to its org, and open workspace tabs.

import { SalesforceClient, environmentOf, getSession } from '../lib/salesforce.js';

const ORG_INFO_TTL_MS = 10 * 60 * 1000;

// The tab hosting this page: the Salesforce tab for the side panel, the
// workspace tab itself, or (in the toolbar popup) the active tab.
export async function currentTab() {
  return (await chrome.tabs.getCurrent()) || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

// Tries each session cookie for the org until one is accepted.
export async function connect(pageUrl) {
  let lastError;
  for (const session of await getSession(pageUrl)) {
    try {
      return await new SalesforceClient(session).init();
    } catch (error) {
      lastError = error;
      if (error.status !== 401) break;
    }
  }
  throw lastError;
}

// Org, user and limits, cached per org for the session so the launcher opens fast.
export async function getOrgInfo(client, { fresh = false } = {}) {
  const key = `orgInfo:${client.session.orgId}`;
  if (!fresh) {
    const cached = (await chrome.storage.session.get(key))[key];
    if (cached && Date.now() - cached.at < ORG_INFO_TTL_MS) return withEnv(client, cached.info);
  }
  const info = await client.getOrgInfo();
  await chrome.storage.session.set({ [key]: { at: Date.now(), info } });
  return withEnv(client, info);
}

function withEnv(client, info) {
  return { ...info, env: environmentOf(info.org, new URL(client.instanceUrl).hostname) };
}

// Opens the full-tab workspace for the org at `pageUrl`, next to the current tab.
// `params` picks the starting tab and its state, e.g. { tab: 'access', mode: 'user' }.
export async function openWorkspace(pageUrl, params = {}) {
  const query = new URLSearchParams({ page: pageUrl });
  for (const [key, value] of Object.entries(params)) if (value != null) query.set(key, value);
  const tab = await currentTab();
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`app/app.html?${query}`),
    index: tab ? tab.index + 1 : undefined,
    openerTabId: tab?.id,
  });
}

export function renderOrgChip({ org, env }) {
  const name = document.getElementById('org-name');
  const badge = document.getElementById('env-badge');
  name.textContent = org.Name;
  name.title = org.Name;
  badge.textContent = env.label;
  badge.className = `badge ${env.tone}`;
  document.getElementById('org-chip').hidden = false;
  document.body.dataset.env = env.tone;
}
