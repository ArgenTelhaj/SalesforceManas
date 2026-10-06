// Adds a small tab on the right edge of Salesforce pages. Clicking it slides
// out the launcher (the same page as the toolbar popup) in an iframe.
// Drag the tab up or down to move it; turn it off from the launcher footer.

(() => {
  if (window.top !== window || document.getElementById('sfm-sidetab')) return;

  const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  const PANEL_WIDTH = 380;
  const DRAG_THRESHOLD = 4;

  let host = null;
  let handle = null;
  let panel = null;
  let frame = null;
  let isOpen = false;

  const STYLES = `
    :host { all: initial; }
    .handle {
      position: fixed; right: 0; z-index: 2147483000;
      width: 22px; height: 56px; padding: 0;
      display: grid; place-items: center;
      border: 0; border-radius: 8px 0 0 8px;
      background: #0b5cab; color: #fff; cursor: pointer;
      box-shadow: -2px 2px 8px rgb(0 0 0 / 0.25);
      opacity: 0.8; transform: translateY(-50%);
      transition: right 160ms cubic-bezier(0.32, 0.72, 0, 1), width 120ms ease, opacity 120ms ease;
      touch-action: none;
    }
    .handle:hover, .handle.open { opacity: 1; width: 26px; }
    .handle.open { right: ${PANEL_WIDTH}px; transition-duration: 240ms, 120ms, 120ms; }
    .handle.dragging { transition: none; cursor: grabbing; }
    .handle svg { transition: transform 240ms cubic-bezier(0.32, 0.72, 0, 1); }
    .handle.open svg { transform: rotate(180deg); }
    .handle:focus-visible { outline: 2px solid #fff; outline-offset: -4px; }
    .panel {
      position: fixed; top: 50%; right: 0; z-index: 2147483000;
      width: ${PANEL_WIDTH}px; height: min(640px, calc(100vh - 32px));
      border-radius: 10px 0 0 10px; overflow: hidden;
      box-shadow: -6px 0 24px rgb(0 0 0 / 0.25);
      background: #fff;
      transform: translate(100%, -50%); visibility: hidden;
      transition: transform 160ms cubic-bezier(0.32, 0.72, 0, 1), visibility 0s linear 160ms;
    }
    .panel.open { transform: translate(0, -50%); visibility: visible; transition: transform 240ms cubic-bezier(0.32, 0.72, 0, 1); }
    iframe { width: 100%; height: 100%; border: 0; display: block; color-scheme: normal; }
    @media (prefers-color-scheme: dark) { .panel { background: #17191d; } }
    @media (prefers-reduced-motion: reduce) { .handle, .panel, .handle svg { transition: none; } }
  `;

  chrome.storage.local.get({ sideTab: true, sideTabTop: 50 }).then(({ sideTab, sideTabTop }) => {
    if (sideTab) mount(sideTabTop);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.sideTab) return;
    if (changes.sideTab.newValue === false) unmount();
    else chrome.storage.local.get({ sideTabTop: 50 }).then(({ sideTabTop }) => mount(sideTabTop));
  });

  function mount(topPercent) {
    if (host) return;
    host = document.createElement('div');
    host.id = 'sfm-sidetab';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>${STYLES}</style>
      <button class="handle" title="SalesforceManas (drag to move)" aria-label="Open SalesforceManas" aria-expanded="false">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div class="panel" role="dialog" aria-label="SalesforceManas"></div>`;
    handle = shadow.querySelector('.handle');
    panel = shadow.querySelector('.panel');
    handle.style.top = `${topPercent}%`;
    setupDrag();
    document.documentElement.appendChild(host);
  }

  function unmount() {
    host?.remove();
    host = handle = panel = frame = null;
    isOpen = false;
  }

  function setupDrag() {
    let startY = 0;
    let startTop = 0;
    let dragging = false;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      startY = e.clientY;
      startTop = handle.getBoundingClientRect().top + handle.offsetHeight / 2;
      dragging = false;
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const delta = e.clientY - startY;
      if (!dragging && Math.abs(delta) < DRAG_THRESHOLD) return;
      dragging = true;
      handle.classList.add('dragging');
      const center = Math.min(window.innerHeight - 40, Math.max(40, startTop + delta));
      handle.style.top = `${(center / window.innerHeight) * 100}%`;
    });

    handle.addEventListener('pointerup', (e) => {
      handle.releasePointerCapture(e.pointerId);
      handle.classList.remove('dragging');
      if (dragging) {
        chrome.storage.local.set({ sideTabTop: parseFloat(handle.style.top) });
      } else {
        toggle();
      }
    });

    // Keyboard users: Enter/Space on the focused handle.
    handle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  function open() {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.allow = 'clipboard-write';
      frame.src = chrome.runtime.getURL('launcher/launcher.html') + '?embedded=1&page=' + encodeURIComponent(location.href);
      panel.appendChild(frame);
    } else {
      // Lightning changes the URL without reloading, so tell the launcher where we are now.
      frame.contentWindow.postMessage({ type: 'sfm-url', url: location.href }, EXTENSION_ORIGIN);
    }
    panel.classList.add('open');
    handle.classList.add('open');
    handle.setAttribute('aria-expanded', 'true');
    handle.setAttribute('aria-label', 'Close SalesforceManas');
    isOpen = true;
    frame.focus();
  }

  function close() {
    if (!isOpen) return;
    panel.classList.remove('open');
    handle.classList.remove('open');
    handle.setAttribute('aria-expanded', 'false');
    handle.setAttribute('aria-label', 'Open SalesforceManas');
    isOpen = false;
  }

  window.addEventListener('message', (e) => {
    if (!frame || e.origin !== EXTENSION_ORIGIN || e.source !== frame.contentWindow) return;
    if (e.data?.type === 'sfm-close') {
      close();
      handle.focus();
    } else if (e.data?.type === 'sfm-navigate') {
      const url = new URL(e.data.url);
      if (url.protocol === 'https:' && /\.(force|salesforce|salesforce-setup)\.com$/.test(url.hostname)) {
        close();
        location.href = url.href;
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) close();
  });

  // Clicking anywhere on the page outside the panel closes it.
  document.addEventListener('pointerdown', (e) => {
    if (isOpen && e.target !== host) close();
  });
})();
