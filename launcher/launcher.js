// The launcher: a small panel with context tabs (the record you're on, its
// layout, and you), quick navigation and shortcuts into the workspace. It runs
// as the toolbar popup and, with ?embedded=1, inside the side tab that the
// content script adds to Salesforce pages.

import { isSalesforceId, isSalesforceUrl, parseRecordFromUrl } from '../lib/salesforce.js';
import { SETUP_LINKS } from '../lib/setup-links.js';
import { recentRecords } from '../shared/recent.js';
import { connect, currentTab, getOrgInfo, openWorkspace, renderOrgChip } from '../shared/context.js';
import { $, el, toast } from '../shared/ui.js';
import { renderLayoutPane, renderMePane, renderRecordPane } from './panels.js';

const params = new URLSearchParams(location.search);
const embedded = params.has('embedded');

const state = {
  pageUrl: params.get('page'),
  client: null,
  record: null,
  sobjects: null,
  recent: [],
  ctxTab: null,
  rendered: new Set(),
  pageVersion: 0,
};

// --- Talking to the host page (side tab only) ------------------------------

function closeLauncher() {
  if (embedded) parent.postMessage({ type: 'sfm-close' }, '*');
  else window.close();
}

window.addEventListener('message', (e) => {
  if (!embedded || e.source !== parent || e.data?.type !== 'sfm-url') return;
  if (isSalesforceUrl(e.data.url) && e.data.url !== state.pageUrl) {
    state.pageUrl = e.data.url;
    if (state.client) pageChanged();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented) closeLauncher();
});

// --- Startup --------------------------------------------------------------

async function start() {
  document.body.classList.toggle('embedded', embedded);
  $('close').hidden = !embedded;
  $('close').addEventListener('click', closeLauncher);
  setupSideTabToggle();

  if (!state.pageUrl) state.pageUrl = (await currentTab())?.url;
  if (!state.pageUrl || !isSalesforceUrl(state.pageUrl)) {
    $('no-org').hidden = false;
    $('footer').hidden = false;
    return;
  }

  try {
    state.client = await connect(state.pageUrl);
  } catch (error) {
    $('no-org').hidden = false;
    $('no-org-detail').textContent = error.message;
    $('footer').hidden = false;
    return;
  }

  $('launcher').hidden = false;
  $('footer').hidden = false;
  document.querySelectorAll('[data-open]').forEach((btn) => btn.addEventListener('click', () => openFromButton(btn.dataset.open)));
  document.querySelectorAll('[data-ctx]').forEach((btn) => btn.addEventListener('click', () => selectCtxTab(btn.dataset.ctx)));
  setupNavigation();
  pageChanged();

  getOrgInfo(state.client).then(renderOrgChip, () => {});
}

async function setupSideTabToggle() {
  const { sideTab = true } = await chrome.storage.local.get('sideTab');
  $('side-tab-toggle').checked = sideTab;
  $('side-tab-toggle').addEventListener('change', (e) => chrome.storage.local.set({ sideTab: e.target.checked }));
}

// --- Context tabs ---------------------------------------------------------

const PANES = { record: renderRecordPane, layout: renderLayoutPane, me: renderMePane };

function objectFromPage(url) {
  const match =
    url.match(/\/lightning\/[ro]\/([A-Za-z0-9_]+)\//) || url.match(/\/lightning\/setup\/ObjectManager\/([A-Za-z0-9_]+)\//);
  return match && match[1] !== 'home' ? match[1] : null;
}

// The page in the tab changed (or we just opened): refresh record and layout.
function pageChanged() {
  state.pageVersion++;
  state.record = parseRecordFromUrl(state.pageUrl);
  state.rendered.delete('record');
  state.rendered.delete('layout');
  const first = state.ctxTab === null;
  if (first) selectCtxTab(state.record ? 'record' : objectFromPage(state.pageUrl) ? 'layout' : 'me');
  else selectCtxTab(state.ctxTab);
}

function selectCtxTab(name) {
  state.ctxTab = name;
  document.querySelectorAll('[data-ctx]').forEach((btn) => btn.setAttribute('aria-selected', String(btn.dataset.ctx === name)));
  document.querySelectorAll('[data-pane]').forEach((pane) => (pane.hidden = pane.dataset.pane !== name));
  if (state.rendered.has(name)) return;
  state.rendered.add(name);
  PANES[name](document.querySelector(`[data-pane="${name}"]`), paneContext());
}

function paneContext() {
  const version = state.pageVersion;
  let objectNamePromise;
  return {
    client: state.client,
    record: state.record,
    objectFromPage: objectFromPage(state.pageUrl),
    isCurrent: () => version === state.pageVersion,
    objectName: () =>
      (objectNamePromise ??= state.record.objectName
        ? Promise.resolve(state.record.objectName)
        : state.client.objectForId(state.record.recordId).then((name) => {
            if (!name) throw new Error(`Couldn't work out which object ${state.record.recordId} belongs to.`);
            return name;
          })),
    info: () => getOrgInfo(state.client),
    lightning: (path) => state.client.session.lightningUrl + path,
    openWorkspace: (target) => openWorkspaceAndClose(target),
    navigate: (url) => navigate(url, false),
    loginAs,
    recentChanged: loadRecent,
  };
}

// --- Login as -----------------------------------------------------------------

// Salesforce's own "Login" link from the user detail page; needs the
// "Administrators Can Log in as Any User" setting or user-granted access.
function loginAsPath(user) {
  const target = new URL(state.pageUrl);
  const back = target.pathname + target.search;
  const query = new URLSearchParams({
    oid: state.client.session.orgId,
    suorgadminid: user.Id,
    retURL: back,
    targetURL: back,
  });
  return `/servlet/servlet.su?${query}`;
}

async function loginAs(user, incognito) {
  const { instanceUrl, session } = state.client;
  if (!incognito) {
    await navigate(instanceUrl + loginAsPath(user), true);
    return;
  }
  // An incognito window has no Salesforce session, so frontdoor.jsp signs it in
  // with the current session first and then continues to the login-as link.
  const url = `${instanceUrl}/secur/frontdoor.jsp?${new URLSearchParams({ sid: session.sessionId, retURL: loginAsPath(user) })}`;
  try {
    await chrome.windows.create({ url, incognito: true });
    closeLauncher();
  } catch {
    toast('Turn on "Allow in Incognito" for SalesforceManas in chrome://extensions, then try again.');
  }
}

// --- Workspace shortcuts --------------------------------------------------

async function openWorkspaceAndClose(target) {
  try {
    await openWorkspace(state.pageUrl, target);
    closeLauncher();
  } catch (error) {
    toast(error.message);
  }
}

function openFromButton(action) {
  const object = state.record?.objectName || objectFromPage(state.pageUrl) || undefined;
  const targets = {
    access: { tab: 'access', mode: 'object', object },
    user: { tab: 'access', mode: 'user', object },
    bulk: { tab: 'access', mode: 'bulk', object },
    compare: { tab: 'access', mode: 'compare', object },
    soql: { tab: 'soql' },
    org: { tab: 'org' },
    logs: { tab: 'logs' },
    import: { tab: 'import', object },
    record: { tab: 'record' },
  };
  openWorkspaceAndClose(targets[action]);
}

// --- Search ---------------------------------------------------------------
//
// One box for everything: Setup pages, objects, workspace tools and record
// Ids. The input keeps focus; arrow keys move the highlighted result.

const MAX_RESULTS = 8;

// Workspace tools, also reachable by typing their name.
const TOOLS = [
  ['access', 'Object & field access', 'permissions fls profile crud'],
  ['user', 'User access', 'why cant see permission'],
  ['bulk', 'Bulk field access', 'fls many fields'],
  ['compare', 'Compare profiles / permission sets', 'diff'],
  ['soql', 'SOQL query', 'export csv mass edit'],
  ['import', 'Data import', 'insert update delete csv load'],
  ['record', 'Record inspector', 'all fields inline edit'],
  ['logs', 'Debug logs', 'apex trace flag log debug'],
  ['org', 'Org & limits', 'storage api usage'],
];

const nav = { items: [], active: 0, showRecent: false };

function setupNavigation() {
  const input = $('nav-search');
  input.addEventListener('input', () => {
    nav.showRecent = false;
    renderResults();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !input.value && !nav.showRecent) {
      // ↓ in an empty search lists the records you looked at recently.
      e.preventDefault();
      nav.showRecent = true;
      renderResults();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!nav.items.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((nav.active + step + nav.items.length) % nav.items.length);
    } else if (e.key === 'Enter' && nav.items.length) {
      e.preventDefault();
      nav.items[nav.active].run(e.shiftKey);
    } else if (e.key === 'Escape' && (input.value || nav.showRecent)) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      nav.showRecent = false;
      renderResults();
    }
  });
  // Focus the search so you can type straight away. The side tab focuses the
  // iframe first, so this also works there.
  input.focus();
  loadObjects();
  loadRecent();
}

async function loadRecent() {
  try {
    state.recent = await recentRecords(state.client.session.orgId);
    if (nav.showRecent) renderResults();
  } catch {
    // Recent records are a bonus.
  }
}

async function loadObjects() {
  try {
    state.sobjects = (await state.client.describeGlobal()).filter((s) => s.layoutable || s.name.endsWith('__mdt'));
    renderResults();
  } catch {
    // Object search is a bonus; setup links still work.
  }
}

async function navigate(url, sameTab) {
  if (!sameTab) {
    const tab = await currentTab();
    await chrome.tabs.create({ url, index: tab ? tab.index + 1 : undefined });
  } else if (embedded) {
    parent.postMessage({ type: 'sfm-navigate', url }, '*');
  } else {
    await chrome.tabs.update((await currentTab()).id, { url });
  }
  closeLauncher();
}

function setActive(index) {
  nav.active = index;
  nav.items.forEach((item, i) => item.node.setAttribute('aria-selected', String(i === index)));
  nav.items[index]?.node.scrollIntoView({ block: 'nearest' });
}

function renderResults() {
  const input = $('nav-search');
  const text = input.value.trim();
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0 || nav.showRecent;
  $('home').hidden = searching;
  $('nav-panel').hidden = !searching;
  input.setAttribute('aria-expanded', String(searching));
  nav.items = [];
  if (!searching) {
    $('nav-results').replaceChildren();
    return;
  }

  const lightning = state.client.session.lightningUrl;
  const matches = (value) => terms.length > 0 && terms.every((t) => value.toLowerCase().includes(t));
  const results = [];
  const link = (label, kind, url) => ({ label, kind, run: (sameTab) => navigate(url, sameTab) });

  const recent = state.recent || [];
  const recentLink = (r) => link(r.name, `Recent · ${r.objectLabel}`, `${lightning}/${r.id}`);
  for (const r of recent) {
    if (!terms.length || matches(`${r.name} ${r.objectLabel} ${r.objectName} ${r.id}`)) results.push(recentLink(r));
  }

  if (isSalesforceId(text)) {
    results.push(link(`Open record ${text}`, 'Record', `${lightning}/${text}`));
    results.push({ label: `Inspect ${text}`, kind: 'Record inspector', run: () => openWorkspaceAndClose({ tab: 'record', record: text }) });
  }
  for (const [key, label, keywords] of TOOLS) {
    if (matches(`${label} ${keywords}`)) results.push({ label, kind: 'Tool', run: () => openFromButton(key) });
  }
  for (const s of SETUP_LINKS) {
    if (matches(`${s.group} ${s.label}`)) results.push(link(s.label, s.group, (s.api ? state.client.instanceUrl : lightning) + s.path));
  }
  for (const s of state.sobjects || []) {
    if (matches(`${s.label} ${s.name}`)) {
      results.push(link(s.label, `Object · ${s.name}`, `${lightning}/lightning/setup/ObjectManager/${s.name}/FieldsAndRelationships/view`));
    }
  }

  // Labels that start with what you typed come first, then labels with a word
  // starting with it, then everything else; ties keep the order above.
  const lowered = text.toLowerCase();
  const rank = ({ label }) => {
    const l = label.toLowerCase();
    return l.startsWith(lowered) ? 0 : l.split(/[\s&/]+/).some((w) => w.startsWith(terms[0])) ? 1 : 2;
  };
  if (terms.length) results.sort((a, b) => rank(a) - rank(b));

  nav.items = results.slice(0, nav.showRecent ? 20 : MAX_RESULTS).map((result, i) => ({
    ...result,
    node: el('div', {
      class: 'setup-item',
      role: 'option',
      onclick: (e) => result.run(e.shiftKey),
      onmousemove: () => nav.active !== i && setActive(i),
    },
      el('span', {}, result.label),
      el('span', { class: 'sub' }, result.kind)
    ),
  }));
  $('nav-results').replaceChildren(
    ...(nav.showRecent && nav.items.length ? [el('p', { class: 'l-group-label l-results-title' }, 'Recent records')] : []),
    ...(nav.items.length
      ? nav.items.map((item) => item.node)
      : [el('p', { class: 'muted l-empty' }, nav.showRecent ? 'No recent records yet. Records you open here show up in this list.' : 'No matches.')])
  );
  setActive(0);
}

start();
