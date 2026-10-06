// Field-type knowledge shared by inline edit, SOQL mass edit and data import:
// which fields can be written, how to turn typed or CSV text into API values,
// and an in-cell editor for each field type.

import { isSalesforceId } from '../lib/salesforce.js';
import { el, toast } from '../shared/ui.js';

const NUMBER_TYPES = new Set(['int', 'double', 'currency', 'percent', 'long']);

export function isWritable(field, { creating = false } = {}) {
  if (field.calculated || field.autoNumber) return false;
  return creating ? field.createable : field.updateable;
}

// Salesforce sends "+0000" offsets; Date wants "+00:00".
const normalizeOffset = (iso) => iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

// Text -> API value. Returns { value } or { error }. Empty text means "blank".
export function parseValue(field, raw) {
  if (raw == null) return { value: null };
  const text = typeof raw === 'string' ? raw : String(raw);
  const trimmed = text.trim();
  if (trimmed === '') return { value: null };

  switch (field.type) {
    case 'boolean': {
      const t = trimmed.toLowerCase();
      if (['true', '1', 'yes', 'y', 'x'].includes(t)) return { value: true };
      if (['false', '0', 'no', 'n'].includes(t)) return { value: false };
      return { error: `"${text}" isn't true/false` };
    }
    case 'date': {
      const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
      return iso && !isNaN(Date.parse(iso)) ? { value: iso } : { error: `"${text}" isn't a date (use YYYY-MM-DD)` };
    }
    case 'datetime': {
      const ms = Date.parse(normalizeOffset(trimmed));
      return isNaN(ms) ? { error: `"${text}" isn't a date/time (use ISO, e.g. 2026-10-06T14:30:00Z)` } : { value: new Date(ms).toISOString() };
    }
    case 'time': {
      const m = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      return m ? { value: `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}.000Z` } : { error: `"${text}" isn't a time (use HH:mm)` };
    }
    case 'reference':
    case 'id':
      return isSalesforceId(trimmed) ? { value: trimmed } : { error: `"${text}" isn't a record Id` };
    default:
      if (NUMBER_TYPES.has(field.type)) {
        let n = Number(trimmed.replace(/\s/g, ''));
        // "1,250" could be one thousand or one-and-a-quarter; refuse to guess.
        if (isNaN(n) && /^-?\d{1,3},\d{3}$/.test(trimmed)) return { error: `"${text}" is ambiguous; write 1250 or 1.25` };
        // European decimal comma: "1.250,50" or "1,5".
        if (isNaN(n) && /^-?[\d.]*,\d+$/.test(trimmed)) n = Number(trimmed.replace(/\./g, '').replace(',', '.'));
        if (isNaN(n)) return { error: `"${text}" isn't a number` };
        if (field.type === 'int' && !Number.isInteger(n)) return { error: `"${text}" isn't a whole number` };
        return { value: n };
      }
      if (field.length && text.length > field.length) return { error: `Longer than ${field.length} characters` };
      return { value: text };
  }
}

export function sameValue(a, b) {
  if ((a ?? null) === (b ?? null)) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  const da = Date.parse(normalizeOffset(String(a)));
  const db = Date.parse(normalizeOffset(String(b)));
  if (/^\d{4}-\d{2}-\d{2}T/.test(String(a)) && !isNaN(da) && da === db) return true;
  return String(a) === String(b);
}

export function displayValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// What a value looks like on screen: dates and times in your locale, the
// rest as displayValue. Copy, edit and CSV keep using the raw API value.
// Without a field type (SOQL columns), ISO-looking strings are recognised.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function friendlyValue(value, type) {
  const text = displayValue(value);
  if (text == null) return null;
  if (type === 'datetime' || (!type && DATETIME_RE.test(text))) {
    const ms = Date.parse(normalizeOffset(text));
    if (!isNaN(ms)) return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  if (type === 'date' || (!type && DATE_RE.test(text))) {
    const day = new Date(`${text.slice(0, 10)}T00:00:00`);
    if (!isNaN(day)) return day.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }
  return text;
}

// Editor widget for a field, pre-filled with the current API value.
// `read()` returns the editor's content as text for parseValue.
export function editorFor(field, value) {
  const pad = (n) => String(n).padStart(2, '0');
  if (field.type === 'boolean') {
    const input = el('input', { type: 'checkbox', checked: Boolean(value) });
    return { node: input, focus: input, read: () => String(input.checked) };
  }
  if (field.type === 'picklist') {
    const options = (field.picklistValues || []).filter((p) => p.active);
    const select = el('select', {},
      el('option', { value: '' }, '— none —'),
      options.map((p) => el('option', { value: p.value, selected: p.value === value }, p.label)),
      value && !options.some((p) => p.value === value) ? el('option', { value, selected: true }, `${value} (inactive)`) : null
    );
    return { node: select, focus: select, read: () => select.value };
  }
  if (field.type === 'multipicklist') {
    const current = new Set(String(value || '').split(';').filter(Boolean));
    const select = el('select', { multiple: true, size: Math.min(6, (field.picklistValues || []).length || 1) },
      (field.picklistValues || []).filter((p) => p.active).map((p) => el('option', { value: p.value, selected: current.has(p.value) }, p.label))
    );
    return { node: select, focus: select, read: () => [...select.selectedOptions].map((o) => o.value).join(';') };
  }
  if (field.type === 'date') {
    const input = el('input', { type: 'date', value: value || '' });
    return { node: input, focus: input, read: () => input.value };
  }
  if (field.type === 'datetime') {
    let local = '';
    if (value) {
      const d = new Date(Date.parse(normalizeOffset(value)));
      local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    const input = el('input', { type: 'datetime-local', value: local });
    // datetime-local is in the browser's time zone; new Date() reads it the same way.
    return { node: input, focus: input, read: () => (input.value ? new Date(input.value).toISOString() : '') };
  }
  if (NUMBER_TYPES.has(field.type)) {
    const input = el('input', { type: 'number', step: 'any', value: value ?? '' });
    return { node: input, focus: input, read: () => input.value };
  }
  if (field.type === 'textarea' || (field.length || 0) > 255) {
    const area = el('textarea', { rows: 3, maxlength: field.length || null });
    area.value = value ?? '';
    return { node: area, focus: area, read: () => area.value, multiline: true };
  }
  const input = el('input', { type: 'text', value: value ?? '', maxlength: field.length || null, spellcheck: 'false' });
  return { node: input, focus: input, read: () => input.value };
}

// Swaps a table cell's content for an editor. Enter (⌘/Ctrl+Enter in
// multi-line fields) or leaving the cell commits; Esc cancels.
export function editCell(td, field, value, { onCommit, onCancel }) {
  if (td.classList.contains('editing')) return;
  const editor = editorFor(field, value);
  const previous = [...td.childNodes];
  td.classList.add('editing');
  td.replaceChildren(editor.node);
  editor.focus.focus();
  editor.focus.select?.();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    if (commit) {
      const parsed = parseValue(field, editor.read());
      if (parsed.error) {
        toast(parsed.error);
        editor.focus.focus();
        return;
      }
      done = true;
      td.classList.remove('editing');
      onCommit(parsed.value);
    } else {
      done = true;
      td.classList.remove('editing');
      td.replaceChildren(...previous);
      onCancel?.();
    }
  };

  editor.node.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    } else if (e.key === 'Enter' && (!editor.multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      finish(true);
    }
  });
  editor.node.addEventListener('blur', () => setTimeout(() => !td.contains(document.activeElement) && finish(true), 0));
  if (field.type === 'boolean' || field.type === 'picklist') editor.node.addEventListener('change', () => finish(true));
}

// Runs `fn` on consecutive chunks, reporting progress; stops early if `shouldStop()`.
export async function inBatches(items, size, fn, { onProgress, shouldStop } = {}) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    if (shouldStop?.()) break;
    const chunk = items.slice(i, i + size);
    results.push(...(await fn(chunk)));
    onProgress?.(Math.min(i + size, items.length), items.length);
  }
  return results;
}

// "Update 3 records in Acme (Sandbox)?" with a red bar for production.
export async function confirmIn(bar, textNode, getOrg, summary) {
  const { name, env } = await getOrg();
  bar.classList.add('confirm');
  bar.classList.toggle('danger', env.tone === 'prod');
  textNode.textContent = `${summary} in ${name}${env.tone === 'prod' ? ' (PRODUCTION)' : ` (${env.label})`}?`;
  return env;
}

export const errorText = (result) => result?.errors?.map((e) => e.message + (e.fields?.length ? ` [${e.fields.join(', ')}]` : '')).join('; ') || 'Unknown error';
