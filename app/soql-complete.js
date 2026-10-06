// Autocomplete for the SOQL editor.
//
// - After FROM: object names; inside a subquery, the outer object's child
//   relationships come first since that's what a parent-to-child query needs.
// - Elsewhere, once the query has a FROM <Object>: that object's fields.
// - Dotted paths follow relationships: "Owner." lists User fields.
// - Inside a subquery "(SELECT … FROM Contacts)" fields come from the child object.
//
// Opens while typing a word or after ".", or with Ctrl+Space.
// ↑/↓ to move, Enter/Tab to accept, Esc to close.

import { el } from '../shared/ui.js';

const MAX_ITEMS = 60;
const NO_SUGGEST_AFTER = /^(limit|offset)$/i;

export function attachSoqlAutocomplete(textarea, { client, isTooling }) {
  const menu = el('div', { class: 'ac-menu', role: 'listbox', hidden: true });
  textarea.parentElement.append(menu);

  let items = [];
  let active = 0;
  let replaceRange = null;
  let requestId = 0;
  let suppressNext = false;

  const close = () => {
    menu.hidden = true;
    items = [];
  };

  async function update({ force = false } = {}) {
    const id = ++requestId;
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return close();

    const context = analyze(textarea.value, caret);
    if (!context || (!force && !context.token && !context.afterDot)) return close();

    let next;
    try {
      next = await suggestionsFor(context);
    } catch {
      next = [];
    }
    if (id !== requestId) return;
    if (!next.length) return close();

    items = next;
    active = 0;
    replaceRange = [context.prefixStart, context.wordEnd];
    render();
    position(context.prefixStart);
  }

  // --- Suggestions --------------------------------------------------------

  async function suggestionsFor(context) {
    const tooling = isTooling();
    if (context.mode === 'object') {
      const objects = (await client.describeGlobal({ tooling })).map((s) => ({
        insert: s.name,
        label: s.label,
        detail: s.custom ? 'Custom object' : 'Object',
      }));
      let children = [];
      if (context.outerObject) {
        const outer = await client.describe(context.outerObject, { tooling }).catch(() => null);
        children = (outer?.childRelationships || [])
          .filter((r) => r.relationshipName)
          .map((r) => ({ insert: r.relationshipName, label: r.childSObject, detail: 'Child relationship', priority: 0 }));
      }
      return rank([...children, ...objects], context.prefix);
    }

    // Field mode: resolve the object, then walk any dotted path.
    let objectName = context.fromName;
    if (context.outerObject) {
      const outer = await client.describe(context.outerObject, { tooling }).catch(() => null);
      const child = outer?.childRelationships?.find((r) => r.relationshipName?.toLowerCase() === objectName.toLowerCase());
      if (child) objectName = child.childSObject;
    }
    let describe = await client.describe(objectName, { tooling });
    for (const part of context.path) {
      const field = describe.fields.find((f) => f.relationshipName?.toLowerCase() === part.toLowerCase());
      if (!field?.referenceTo?.length) return [];
      describe = await client.describe(field.referenceTo[0], { tooling });
    }

    const used = context.path.length ? new Set() : selectedFields(context.scope);
    const fields = [];
    for (const f of describe.fields) {
      fields.push({ insert: f.name, label: f.label, detail: f.type, dim: used.has(f.name.toLowerCase()) });
      if (f.type === 'reference' && f.relationshipName) {
        fields.push({ insert: `${f.relationshipName}.`, label: `${f.label} →`, detail: f.referenceTo.join(' / ') });
      }
    }
    return rank(fields, context.prefix);
  }

  function rank(list, prefix) {
    const p = prefix.toLowerCase();
    const score = (item) => {
      const name = item.insert.toLowerCase();
      const label = (item.label || '').toLowerCase();
      if (!p) return 3;
      if (name.startsWith(p)) return 0;
      if (label.startsWith(p)) return 1;
      if (name.includes(p) || label.includes(p)) return 2;
      return -1;
    };
    return list
      .map((item) => ({ item, s: score(item) }))
      .filter(({ s }) => s >= 0)
      .sort(
        (a, b) =>
          a.s - b.s ||
          (a.item.priority ?? 1) - (b.item.priority ?? 1) ||
          (a.item.dim ? 1 : 0) - (b.item.dim ? 1 : 0) ||
          a.item.insert.localeCompare(b.item.insert)
      )
      .slice(0, MAX_ITEMS)
      .map(({ item }) => item);
  }

  // --- Menu ---------------------------------------------------------------

  function render() {
    menu.replaceChildren(
      ...items.map((item, i) =>
        el('div', {
          class: `ac-item${i === active ? ' active' : ''}${item.dim ? ' dim' : ''}`,
          role: 'option',
          'aria-selected': String(i === active),
          onmousedown: (e) => {
            e.preventDefault();
            accept(i);
          },
          onmousemove: () => {
            if (active !== i) {
              active = i;
              render();
            }
          },
        },
          el('span', { class: 'ac-name' }, item.insert),
          el('span', { class: 'ac-label' }, item.label),
          el('span', { class: 'ac-detail' }, item.detail)
        )
      )
    );
    menu.hidden = false;
    menu.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function position(offset) {
    const { top, left, height } = caretCoordinates(textarea, offset);
    const maxLeft = textarea.offsetWidth - Math.min(menu.offsetWidth || 360, textarea.offsetWidth);
    menu.style.top = `${textarea.offsetTop + top + height + 2}px`;
    menu.style.left = `${textarea.offsetLeft + Math.max(0, Math.min(left, maxLeft))}px`;
  }

  function accept(index) {
    const item = items[index];
    if (!item) return;
    const [start, end] = replaceRange;
    textarea.focus();
    textarea.setSelectionRange(start, end);
    // insertText keeps the browser's undo history; setRangeText is the fallback.
    suppressNext = !item.insert.endsWith('.');
    if (!document.execCommand('insertText', false, item.insert)) {
      textarea.setRangeText(item.insert, start, end, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (suppressNext) close();
  }

  // --- Events -------------------------------------------------------------

  textarea.addEventListener('input', () => {
    if (suppressNext) {
      suppressNext = false;
      return close();
    }
    update();
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      update({ force: true });
      return;
    }
    if (menu.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      accept(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  textarea.addEventListener('keyup', (e) => {
    if (!menu.hidden && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) update();
  });
  textarea.addEventListener('click', () => !menu.hidden && update());
  textarea.addEventListener('blur', () => setTimeout(close, 100));
  textarea.addEventListener('scroll', close);
}

// --- Parsing ----------------------------------------------------------------

// Works out what the word under the caret is and what it should complete to.
export function analyze(text, caret) {
  const before = text.slice(0, caret);
  if ((before.match(/(?<!\\)'/g) || []).length % 2) return null; // inside a string literal

  const token = before.match(/[\w.]*$/)[0];
  const tokenStart = caret - token.length;
  const wordEnd = caret + text.slice(caret).match(/^\w*/)[0].length;
  const lastDot = token.lastIndexOf('.');
  const path = lastDot >= 0 ? token.slice(0, lastDot).split('.').filter(Boolean) : [];
  const prefix = token.slice(lastDot + 1);
  const prefixStart = tokenStart + lastDot + 1;
  const prevWord = before.slice(0, tokenStart).match(/(\w+)\s*$/)?.[1] || '';
  if (NO_SUGGEST_AFTER.test(prevWord)) return null;

  const scopes = enclosingSelectScopes(text, tokenStart);
  const scope = scopes[0];
  const outer = scopes[1];
  const fromName = fromOf(scope);
  const outerObject = outer ? fromOf(outer) : null;
  const base = { token, prefix, prefixStart, wordEnd, path, afterDot: lastDot >= 0, scope, outerObject };

  if (/^from$/i.test(prevWord) && !path.length) return { ...base, mode: 'object' };
  if (!fromName) return null;
  return { ...base, mode: 'field', fromName };
}

// SELECT scopes around `pos`, innermost first: the subquery text, then its
// parent query, etc. Parentheses that aren't subqueries (functions, IN lists)
// are skipped over.
function enclosingSelectScopes(text, pos) {
  const scopes = [];
  let start = pos;
  for (;;) {
    let depth = 0;
    let open = -1;
    for (let i = start - 1; i >= 0; i--) {
      if (text[i] === ')') depth++;
      else if (text[i] === '(') {
        if (depth === 0) {
          open = i;
          break;
        }
        depth--;
      }
    }
    let close = text.length;
    depth = 0;
    for (let i = open + 1; i < text.length; i++) {
      if (i < start && open >= 0) continue;
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        if (depth === 0) {
          close = i;
          break;
        }
        depth--;
      }
    }
    const body = text.slice(open + 1, close);
    if (open < 0 || /^\s*SELECT\b/i.test(body)) scopes.push(body);
    if (open < 0) return scopes;
    start = open;
  }
}

// The FROM object of a scope, ignoring nested subqueries.
function fromOf(scope) {
  let flat = scope;
  while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, ' ');
  return flat.match(/\bFROM\s+(\w+)/i)?.[1] || null;
}

// Field names already in the SELECT list of this scope, to dim them.
function selectedFields(scope) {
  let flat = scope;
  while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, ' ');
  const list = flat.match(/^\s*SELECT\s+([\s\S]*?)\bFROM\b/i)?.[1] || '';
  return new Set(list.split(',').map((f) => f.trim().toLowerCase()).filter(Boolean));
}

// Pixel position of a character offset inside a textarea, via a hidden mirror.
function caretCoordinates(textarea, offset) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement('div');
  for (const prop of [
    'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
    'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent',
  ]) {
    mirror.style[prop] = style[prop];
  }
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  mirror.textContent = textarea.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(offset) || '.';
  mirror.append(marker);
  document.body.append(mirror);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const coords = {
    top: marker.offsetTop - textarea.scrollTop,
    left: marker.offsetLeft - textarea.scrollLeft,
    height: lineHeight,
  };
  mirror.remove();
  return coords;
}
