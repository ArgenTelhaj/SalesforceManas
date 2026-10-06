# SalesforceManas

A Chrome extension (Manifest V3) for day-to-day Salesforce admin and developer work.
It uses the session you're already logged in with, so there's no Connected App or extra login.

## How it's organised

**Launcher** (small, for info and navigation). Open it from either:
- the toolbar icon, or **⌘+Shift+M** / **Ctrl+Shift+M**
- the **side tab** on the right edge of every Salesforce page. Drag it up or down to move it, and turn it off from the launcher footer.

The org's environment colour runs along the top (red for production, blue for sandboxes, green for developer orgs), in the launcher and the workspace.

**Search** is first and already focused when the launcher opens. One box finds Setup pages, objects (opens Object Manager), workspace tools, records you looked at recently, and pasted record Ids (open the record or inspect it). Press ↓ in the empty box to list your recent records (the last 20 per org, remembered from the launcher's Record tab and the record inspector). ↑/↓ moves, Enter opens in a new tab, Shift+Enter in the current tab, Esc clears (Esc again closes).

Below the search are three tabs about where you are:
- **Record**: name, 18-character Id (click to copy, or copy 15/18), record type, owner, last modified and created (date and user). **Show all data** opens every field in the workspace, and **Who has access** opens the access view for the object.
- **Layout**: the page layout this record uses (name, Id, record type, last modified, section and field counts), **Edit layout**, and a list of the fields on the layout with their API names (click to copy, * = required). Also lists the object's Lightning record pages with App Builder links, plus Object Manager shortcuts (fields, layouts, record types, validation rules, triggers, buttons and actions, compact layouts). On a list view it shows just the object parts.
- **Me**: your profile, email, role and Id; your profile, permission sets and permission set groups (each links to Setup); and a user search with **Log in** (this tab) and **Incognito** (a new incognito window, so your own session stays open). Login-as needs "Administrators Can Log in as Any User", or the user granting access. Incognito also needs "Allow in Incognito" turned on for the extension in `chrome://extensions`.

Then **Tools**, grouped as Access (object & field access, user access, bulk field access, compare) and Data & dev (SOQL, import, record inspector, debug logs, org & limits). Each opens in a workspace tab. Hover one for what it does.

**Workspace** (a full browser tab, where all the real work happens):

| Tab | What it does |
| --- | --- |
| **Record** | Every field of a record (label, API name, value) with filtering. Dates show in your locale; hover for the raw value, and click copies the raw value. **Inline edit**: double-click a value (or ✎) to get an editor that suits the field type (picklist, checkbox, date, number…). Changes are highlighted and saved together; in production, Save asks for a second click. Validation errors are shown and the failing field is outlined. Inspect any record by pasting its Id. |
| **Access** | Object permissions and field-level security. See the views below. |
| **SOQL** | REST or Tooling API queries with autocomplete: objects after `FROM`, then that object's fields as you type, relationship paths (`Owner.` → User fields) and subqueries (`(SELECT … FROM Contacts)`). Ctrl+Space opens suggestions. Also CSV copy/download, clickable Ids and history. **Edit mode** (queries on one object that include Id): double-click cells to edit, select rows and **Set** any writable field on the selected or all rows (even fields not in the query), or **Delete selected**. Then **Review & save** applies everything in batches of 200, after a confirm step. Rows Salesforce rejects stay unsaved and show the reason. |
| **Import** | **Insert, Update or Delete** from a CSV file or cells pasted from Excel/Sheets (comma, semicolon or tab separated). Columns are auto-mapped to fields by API name or label. Values are converted and checked before sending (numbers, dates, checkboxes, Ids…), and bad rows are skipped and listed. For updates, empty cells leave fields unchanged unless you untick that option. Shows a preview and the number of API calls, warns about unmapped required fields, runs in batches of 200 with progress and Stop, and gives you a results CSV (your columns + Result Id, Result, Error). It won't re-run the same data by accident. |
| **Logs** | **Trace me for 30 min** turns on a debug log trace flag for you in one click (using a debug level called SFManas, created the first time: Apex FINEST, the rest INFO/DEBUG); click again to extend. Lists your Apex logs (or everyone's), with filter, auto-refresh and two-click delete. The viewer filters a log to **Debug** statements, **Errors**, **SOQL** or **DML** (with counts), searches the text, and copies or downloads it. |
| **Org** | Org and user details, plus usage meters for the main limits. |

### Access views

Pick an object, then a view:

| View | Use it to |
| --- | --- |
| **Object access** | Edit Read, Create, Edit, Delete, View All and Modify All for every profile and permission set |
| **Fields by set** | Edit field-level security for every field on the object, for one profile or permission set |
| **One field** | Edit who can read or edit one field, across all profiles and permission sets |
| **Bulk fields** | Give many fields Read & Edit, Read only or No access, on many profiles and permission sets at once, with a preview first |
| **User access** | See what one user can do and *which* profile, permission set or group grants it, including View All Data / Modify All Data. Answers "why can't they see this field?" |
| **Compare** | Show two profiles or permission sets side by side, highlighting differences |

Safety rules:
- Permission dependencies are enforced the way Setup enforces them.
- All edits are staged and highlighted, then applied after a confirm step, which turns red in production.
- Standard profiles (object level), standard permission sets and managed-package permission sets are read only, and are tagged as such in the grid.
- Formula and auto-number fields can't get Edit.
- If Salesforce rejects a change, the error is shown on that row and the rest still save.

## Install (developer mode)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `SalesforceManas` folder
4. Open any Salesforce org. The side tab appears on the right.

After changing code, click the reload icon on the extension card and refresh your Salesforce tabs
(content scripts only reload with the page).
To debug the launcher, right-click it and choose **Inspect**. To debug the workspace, use DevTools in its tab.

## How it works

- `lib/salesforce.js` reads the `sid` cookie for the org in the tab, then finds the matching sessions
  on the org's `*.my.salesforce.com` domains (Lightning domains don't accept API calls). An old cookie
  can outlive its session, so each candidate is tried until one works. If none does, you're asked to
  reload the Salesforce tab.
- API calls go straight from extension pages to your org's REST API. Permission changes are written
  to `ObjectPermissions` / `FieldPermissions` with the sObject Collections API (200 records per call).
- The side tab is a content script. It draws its button inside a closed shadow root, so Salesforce styles
  can't affect it, and loads the launcher in an iframe.
- Nothing leaves your browser except calls to your own Salesforce org.

## Structure

```
SalesforceManas/
├── manifest.json
├── content/sidetab.js       # side tab + slide-out panel on Salesforce pages
├── launcher/                # small panel: toolbar popup and side-tab iframe
│   ├── launcher.js          # startup, search, context tabs, login-as
│   └── panels.js            # Record / Layout / Me tab contents
├── app/                     # full-tab workspace
│   ├── app.js               # Record, SOQL, Org tabs
│   ├── access.js            # Access tab: object picker, modes, editable grid
│   ├── access-bulk.js       # Bulk field access
│   ├── access-user.js       # User access
│   ├── access-compare.js    # Compare
│   ├── access-common.js     # permission rules, save engine, widgets
│   ├── soql-complete.js     # SOQL editor autocomplete
│   ├── soql-results.js      # results table + mass edit
│   ├── import.js            # data import (insert / update / delete)
│   ├── logs.js              # debug logs: trace flag, log list, viewer
│   └── fields.js            # field types: editors, value parsing, batching
├── shared/                  # ui.js, context.js (connect/open workspace), recent.js, base.css
├── lib/                     # salesforce.js (API client), setup-links.js
└── icons/
```

## Ideas for next versions

- Show the API name next to each field label on record pages
- Metadata search across Apex, Flows and LWC (Tooling API)
- Anonymous Apex runner
- Field usage and dependency check before deleting a field
- Access: copy one set's field access to another, system permissions, permission set assignment
