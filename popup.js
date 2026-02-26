// popup.js — PKRelay flyout logic

const $ = (sel) => document.querySelector(sel);

let currentState = null;

async function getState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getState' }, resolve);
  });
}

function render(state) {
  currentState = state;

  // Connection status
  const dot = $('#statusDot');
  dot.className = `status-dot ${state.connectionState}`;
  $('#connState').textContent = capitalize(state.connectionState);

  // Info
  $('#browserName').textContent = state.browserName;
  $('#relayUrl').textContent = state.relayUrl;

  // Browser level
  const blSelect = $('#browserLevel');
  blSelect.value = state.browserLevel;

  // Tab list
  renderTabs(state.tabs, state.browserLevel === 'full-browser');
}

function renderTabs(tabs, isFullBrowser) {
  const container = $('#tabList');

  if (!tabs || tabs.length === 0) {
    container.innerHTML = '<div class="empty">No tabs open</div>';
    return;
  }

  // Filter out extension pages and empty tabs
  const filtered = tabs.filter(t =>
    t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://')
  );

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty">No browsable tabs</div>';
    return;
  }

  container.innerHTML = '';
  for (const tab of filtered) {
    const item = document.createElement('div');
    item.className = 'tab-item';

    // Indicator dot
    const indicator = document.createElement('span');
    indicator.className = 'tab-indicator';
    if (tab.hasPendingRequest) {
      indicator.classList.add('pending');
    } else if (tab.attached) {
      indicator.classList.add('attached');
    } else {
      indicator.classList.add('detached');
    }
    indicator.title = tab.attached ? 'Debugger attached' : 'Not attached';
    item.appendChild(indicator);

    // Tab info
    const info = document.createElement('div');
    info.className = 'tab-info';

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = tab.title || 'Untitled';
    info.appendChild(title);

    const url = document.createElement('div');
    url.className = 'tab-url';
    url.textContent = compactUrl(tab.url);
    info.appendChild(url);

    item.appendChild(info);

    // Permission dropdown
    const permWrapper = document.createElement('div');
    permWrapper.className = 'tab-perm';

    const select = document.createElement('select');
    select.innerHTML = `
      <option value="full">Full</option>
      <option value="ask">Ask First</option>
      <option value="none">No Access</option>
    `;
    select.value = tab.level;

    if (isFullBrowser) {
      select.classList.add('override');
      select.title = 'Overridden by Full Browser Permission';
    }

    select.addEventListener('change', () => {
      const pattern = urlToPattern(tab.url);
      chrome.runtime.sendMessage({
        type: 'setPermission',
        pattern,
        level: select.value
      });
    });

    permWrapper.appendChild(select);
    item.appendChild(permWrapper);

    // Click indicator to toggle attach/detach
    indicator.style.cursor = 'pointer';
    indicator.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'toggleTab', tabId: tab.tabId }, () => {
        refresh();
      });
    });

    container.appendChild(item);
  }
}

function compactUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return u.hostname + path;
  } catch {
    return url;
  }
}

function urlToPattern(url) {
  try {
    return new URL(url).hostname + '/*';
  } catch {
    return url;
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function refresh() {
  const state = await getState();
  if (state) render(state);
}

// --- Event listeners ---

$('#browserLevel').addEventListener('change', (e) => {
  chrome.runtime.sendMessage({
    type: 'setBrowserLevel',
    level: e.target.value
  }, () => refresh());
});

$('#refreshBtn').addEventListener('click', refresh);

$('#settingsLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('#connectBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'connect' }, () => {
    setTimeout(refresh, 500);
  });
});

// Listen for tab changes to auto-refresh
chrome.tabs.onCreated.addListener(refresh);
chrome.tabs.onRemoved.addListener(refresh);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.title) refresh();
});

// Initial load
refresh();
