// Small DOM helpers shared by the popup panels.

export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

let toastTimer;
export function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 1600);
}

export async function copy(text, label = 'Copied') {
  await navigator.clipboard.writeText(String(text));
  toast(label);
}

export function showError(id, error) {
  const node = $(id);
  node.textContent = error?.message || String(error);
  node.hidden = false;
}
