// Debug logs: turn on a USER_DEBUG trace flag for yourself in one click,
// list Apex logs and read them with quick filters (debug statements, errors,
// SOQL, DML) and text search.
//
// The trace flag uses a debug level called SFManas (Apex FINEST, the rest at
// INFO/DEBUG), created the first time. An existing trace flag on you is
// reused and keeps its own debug level.

import { getOrgInfo } from '../shared/context.js';
import { copy, el, toast } from '../shared/ui.js';
import { friendlyValue } from './fields.js';

const LEVEL_NAME = 'SFManas';
const LEVEL = {
  ApexCode: 'FINEST', ApexProfiling: 'INFO', Callout: 'INFO', Database: 'INFO',
  System: 'DEBUG', Validation: 'INFO', Visualforce: 'INFO', Workflow: 'INFO',
};
const TRACE_MINUTES = 30;
const MAX_LIST = 200;
const MAX_LINES = 5000;
const AUTO_REFRESH_MS = 5000;

const ERROR_RE = /\|(EXCEPTION_THROWN|FATAL_ERROR|VALIDATION_FAIL|FLOW_ELEMENT_ERROR)\|/;
const FILTERS = [
  ['all', 'All', () => true],
  ['debug', 'Debug', (line) => line.includes('|USER_DEBUG|')],
  ['errors', 'Errors', (line) => ERROR_RE.test(line)],
  ['soql', 'SOQL', (line) => line.includes('|SOQL_EXECUTE_BEGIN|')],
  ['dml', 'DML', (line) => line.includes('|DML_BEGIN|')],
];

// Salesforce sends "+0000" offsets; Date.parse wants "+00:00".
const parseSf = (iso) => Date.parse(String(iso).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
const timeOf = (iso) => new Date(parseSf(iso)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const isActive = (t) => Boolean(t) && parseSf(t.ExpirationDate) > Date.now() && (!t.StartDate || parseSf(t.StartDate) <= Date.now());
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

export async function initLogs(root, { client, lightning }) {
  const state = {
    me: null,
    trace: null,
    logs: [],
    selectedId: null,
    lines: [],
    filter: 'all',
    timer: null,
    deleteArmed: false,
  };
  let disarmTimer;

  // --- Elements -------------------------------------------------------------

  const traceText = el('span');
  const traceBtn = el('button', { class: 'btn small', onclick: traceMe });
  const traceBar = el('div', { class: 'trace-bar' },
    el('span', { class: 'trace-dot' }), traceText, el('span', { class: 'spacer' }),
    el('a', { href: lightning('/lightning/setup/ApexDebugLogs/home'), target: '_blank', class: 'link-btn' }, 'Trace flags in Setup'),
    traceBtn
  );

  const scope = el('select', { onchange: () => refresh() },
    el('option', { value: 'mine' }, 'My logs'),
    el('option', { value: 'all' }, 'All users'));
  const listFilter = el('input', { placeholder: 'Filter by operation, user or status…', autocomplete: 'off', oninput: renderList });
  const auto = el('input', { type: 'checkbox', onchange: setAuto });
  const deleteBtn = el('button', { class: 'btn small secondary danger-btn', onclick: deleteShown });
  const listError = el('div', { class: 'error', hidden: true });
  const listBody = el('tbody');
  const listTable = el('table', { class: 'grid logs-table' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Operation'), el('th', {}, 'Status'), el('th', { class: 'num' }, 'Duration'), el('th', { class: 'num' }, 'Size'))),
    listBody);

  const viewer = el('div', { class: 'log-viewer' });
  const search = el('input', { placeholder: 'Search this log…', autocomplete: 'off', oninput: () => renderLines() });
  const filterBar = el('div', { class: 'segmented log-filters' });
  const linesBox = el('div', { class: 'log-body', tabindex: '0' });
  const lineInfo = el('span', { class: 'muted' });
  let current = null;

  root.replaceChildren(
    traceBar,
    el('div', { class: 'row' },
      scope,
      listFilter,
      el('label', { class: 'check', title: `Check for new logs every ${AUTO_REFRESH_MS / 1000} seconds` }, auto, 'Auto-refresh'),
      el('button', { class: 'btn small secondary', onclick: () => refresh() }, 'Refresh'),
      deleteBtn),
    listError,
    el('div', { class: 'logs-columns' },
      el('div', { class: 'table-wrap logs-list' }, listTable),
      viewer)
  );
  renderViewer();

  try {
    state.me = (await getOrgInfo(client)).user.Id;
  } catch (error) {
    showListError(error);
    return;
  }
  await Promise.all([loadTrace(), refresh()]);

  // --- Trace flag -----------------------------------------------------------

  async function loadTrace() {
    try {
      const { records } = await client.query(
        `SELECT Id, StartDate, ExpirationDate, DebugLevelId, DebugLevel.DeveloperName FROM TraceFlag
         WHERE TracedEntityId = '${state.me}' AND LogType = 'USER_DEBUG' ORDER BY ExpirationDate DESC`,
        { tooling: true }
      );
      state.trace = records[0] || null;
    } catch (error) {
      state.trace = null;
      traceText.textContent = `Couldn't read your trace flag: ${error.message}`;
      traceBtn.hidden = true;
      return;
    }
    renderTrace();
  }

  function renderTrace() {
    const active = isActive(state.trace);
    traceBar.classList.toggle('on', Boolean(active));
    traceBtn.hidden = false;
    traceBtn.disabled = false;
    traceText.textContent = active
      ? `Tracing you until ${timeOf(state.trace.ExpirationDate)} (debug level ${state.trace.DebugLevel?.DeveloperName || '?'}).`
      : 'Not tracing you. Your Apex logs are only saved while a trace flag is on.';
    traceBtn.textContent = active ? `Extend ${TRACE_MINUTES} min` : `Trace me for ${TRACE_MINUTES} min`;
  }

  async function debugLevelId() {
    const { records } = await client.query(`SELECT Id FROM DebugLevel WHERE DeveloperName = '${LEVEL_NAME}'`, { tooling: true });
    if (records[0]) return records[0].Id;
    const created = await client.request(`${client.base}/tooling/sobjects/DebugLevel`, {
      method: 'POST',
      body: { DeveloperName: LEVEL_NAME, MasterLabel: LEVEL_NAME, ...LEVEL },
    });
    return created.id;
  }

  async function traceMe() {
    traceBtn.disabled = true;
    traceBtn.textContent = 'Saving…';
    const now = Date.now();
    const trace = state.trace;
    const active = isActive(trace);
    // Extend from the current end when it's on; Salesforce allows at most 24 hours.
    const from = active ? parseSf(trace.ExpirationDate) : now;
    const end = new Date(Math.min(from + TRACE_MINUTES * 60_000, now + 24 * 3_600_000 - 60_000)).toISOString();
    try {
      if (trace) {
        await client.request(`${client.base}/tooling/sobjects/TraceFlag/${trace.Id}`, {
          method: 'PATCH',
          body: active ? { ExpirationDate: end } : { StartDate: new Date(now).toISOString(), ExpirationDate: end },
        });
      } else {
        await client.request(`${client.base}/tooling/sobjects/TraceFlag`, {
          method: 'POST',
          body: {
            TracedEntityId: state.me,
            LogType: 'USER_DEBUG',
            DebugLevelId: await debugLevelId(),
            StartDate: new Date(now).toISOString(),
            ExpirationDate: end,
          },
        });
      }
      toast(`Tracing you until ${timeOf(end)}`);
    } catch (error) {
      toast(error.message);
    }
    await loadTrace();
  }

  // --- Log list -------------------------------------------------------------

  async function refresh({ quiet = false } = {}) {
    if (!state.me) return;
    try {
      const where = scope.value === 'mine' ? `WHERE LogUserId = '${state.me}'` : '';
      const { records } = await client.query(
        `SELECT Id, LogUser.Name, Operation, Request, Status, LogLength, StartTime, DurationMilliseconds
         FROM ApexLog ${where} ORDER BY StartTime DESC LIMIT ${MAX_LIST}`,
        { tooling: true }
      );
      state.logs = records;
      listError.hidden = true;
    } catch (error) {
      if (!quiet) showListError(error);
    }
    if (state.trace) renderTrace();
    renderList();
  }

  function shownLogs() {
    const terms = listFilter.value.toLowerCase().split(/\s+/).filter(Boolean);
    return state.logs.filter((log) =>
      terms.every((t) => `${log.Operation} ${log.LogUser?.Name} ${log.Status} ${log.Request}`.toLowerCase().includes(t))
    );
  }

  function renderList() {
    const logs = shownLogs();
    disarmDelete();
    listBody.replaceChildren(
      ...(logs.length
        ? logs.map((log) =>
            el('tr', { class: `log-row${log.Id === state.selectedId ? ' selected' : ''}`, onclick: () => openLog(log) },
              el('td', { class: 'mono', title: friendlyValue(log.StartTime, 'datetime') }, timeOf(log.StartTime)),
              el('td', {},
                el('div', {}, log.Operation),
                scope.value === 'all' ? el('div', { class: 'access-sub' }, log.LogUser?.Name || '') : null),
              el('td', { class: log.Status === 'Success' ? null : 'status-bad', title: log.Status }, log.Status === 'Success' ? 'OK' : log.Status.split(':')[0]),
              el('td', { class: 'num' }, `${log.DurationMilliseconds.toLocaleString()} ms`),
              el('td', { class: 'num' }, `${Math.max(1, Math.round(log.LogLength / 1024)).toLocaleString()} KB`)
            )
          )
        : [el('tr', {}, el('td', { colspan: 5, class: 'null' },
            state.logs.length ? 'Nothing matches the filter.' : isActive(state.trace) ? 'No logs yet. Do something in the org, then refresh.' : 'No logs. Turn on tracing above, then do something in the org.'))])
    );
  }

  function showListError(error) {
    listError.textContent = error?.message || String(error);
    listError.hidden = false;
  }

  function setAuto() {
    clearInterval(state.timer);
    if (!auto.checked) return;
    state.timer = setInterval(() => {
      // Only while you can see it: the tab is in front and Logs is the open panel.
      if (document.visibilityState === 'visible' && root.offsetParent) refresh({ quiet: true });
    }, AUTO_REFRESH_MS);
  }

  // Deleting asks for a second click; the button arms for a few seconds.
  function disarmDelete() {
    clearTimeout(disarmTimer);
    state.deleteArmed = false;
    const n = shownLogs().length;
    deleteBtn.textContent = `Delete ${n === state.logs.length ? 'all' : 'shown'} (${n})`;
    deleteBtn.disabled = n === 0;
    deleteBtn.classList.remove('armed');
  }

  async function deleteShown() {
    const logs = shownLogs();
    if (!logs.length) return;
    if (!state.deleteArmed) {
      state.deleteArmed = true;
      deleteBtn.textContent = `Click again to delete ${plural(logs.length, 'log')}`;
      deleteBtn.classList.add('armed');
      disarmTimer = setTimeout(disarmDelete, 4000);
      return;
    }
    clearTimeout(disarmTimer);
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    try {
      const results = await client.deleteRecords(logs.map((l) => l.Id));
      const failed = results.filter((r) => !r.success).length;
      toast(failed ? `Deleted ${logs.length - failed}, ${failed} failed` : `Deleted ${plural(logs.length, 'log')}`);
      if (logs.some((l) => l.Id === state.selectedId)) {
        state.selectedId = null;
        state.lines = [];
        renderViewer();
      }
    } catch (error) {
      showListError(error);
    }
    await refresh();
  }

  // --- Viewer ---------------------------------------------------------------

  async function openLog(log) {
    state.selectedId = log.Id;
    current = log;
    renderList();
    viewer.replaceChildren(el('div', { class: 'loading' }, 'Loading log…'));
    try {
      const body = await client.request(`${client.base}/tooling/sobjects/ApexLog/${log.Id}/Body`, { text: true });
      if (state.selectedId !== log.Id) return;
      state.lines = body.split(/\r?\n/);
      renderViewer();
    } catch (error) {
      if (state.selectedId === log.Id) viewer.replaceChildren(el('div', { class: 'error' }, error.message));
    }
  }

  function renderViewer() {
    if (!current || !state.selectedId) {
      viewer.replaceChildren(el('div', { class: 'empty' },
        el('p', { class: 'empty-title' }, 'Pick a log to read it'),
        el('p', { class: 'muted' }, 'Filter to debug statements, errors, SOQL or DML, or search the text.')));
      return;
    }
    viewer.replaceChildren(
      el('div', { class: 'log-head' },
        el('div', {},
          el('div', { class: 'log-title' }, current.Operation),
          el('div', { class: 'access-sub' },
            [friendlyValue(current.StartTime, 'datetime'), current.LogUser?.Name, `${current.DurationMilliseconds.toLocaleString()} ms`, current.Status].filter(Boolean).join(' · '))),
        el('span', { class: 'spacer' }),
        el('button', { class: 'link-btn', onclick: () => copy(visibleLines().join('\n'), 'Copied lines shown') }, 'Copy shown'),
        el('button', { class: 'link-btn', onclick: download }, 'Download')),
      el('div', { class: 'row' }, filterBar, search),
      linesBox,
      lineInfo
    );
    renderFilters();
    renderLines();
  }

  function renderFilters() {
    filterBar.replaceChildren(
      ...FILTERS.map(([key, label, test]) => {
        const count = key === 'all' ? state.lines.length : state.lines.filter(test).length;
        return el('button', {
          'aria-selected': String(state.filter === key),
          class: key === 'errors' && count ? 'has-errors' : null,
          onclick: () => {
            state.filter = key;
            renderFilters();
            renderLines();
          },
        }, label, el('span', { class: 'count' }, count.toLocaleString()));
      })
    );
  }

  function visibleLines() {
    const test = FILTERS.find(([key]) => key === state.filter)[2];
    const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    return state.lines.filter((line) => test(line) && terms.every((t) => line.toLowerCase().includes(t)));
  }

  function renderLines() {
    const lines = visibleLines();
    linesBox.replaceChildren(
      ...(lines.length
        ? lines.slice(0, MAX_LINES).map((line) =>
            el('div', {
              class: `log-line${line.includes('|USER_DEBUG|') ? ' debug' : ERROR_RE.test(line) ? ' error' : line.includes('|SOQL_EXECUTE_BEGIN|') || line.includes('|DML_BEGIN|') ? ' query' : ''}`,
            }, line)
          )
        : [el('div', { class: 'null' }, 'No lines match.')])
    );
    lineInfo.textContent =
      `${plural(lines.length, 'line')} shown` + (lines.length > MAX_LINES ? `, first ${MAX_LINES.toLocaleString()} drawn. Download for the rest.` : '.');
  }

  function download() {
    const link = el('a', {
      href: URL.createObjectURL(new Blob([state.lines.join('\n')], { type: 'text/plain' })),
      download: `apex-${state.selectedId}.log`,
    });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
}
