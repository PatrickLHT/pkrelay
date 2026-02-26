// background.js — PKRelay service worker entry point
import { RelayConnection } from './relay.js';
import { TabManager } from './tabs.js';
import { PermissionManager } from './permissions.js';
import { PerceptionEngine } from './perception.js';
import { ActionExecutor } from './actions.js';

const relay = new RelayConnection();
const tabMgr = new TabManager(relay);
const perms = new PermissionManager();
const perception = new PerceptionEngine();
const actions = new ActionExecutor();

// --- Badge management ---
const BADGE = {
  on:         { text: 'ON',  bg: '#22C55E' },
  off:        { text: '',    bg: '#000000' },
  connecting: { text: '...', bg: '#F59E0B' },
  error:      { text: '!',   bg: '#B91C1C' },
  ask:        { text: '?',   bg: '#3B82F6' }
};

function setBadge(tabId, state) {
  const cfg = BADGE[state];
  if (!cfg) return;
  const opts = tabId ? { tabId } : {};
  chrome.action.setBadgeText({ ...opts, text: cfg.text });
  chrome.action.setBadgeBackgroundColor({ ...opts, color: cfg.bg });
}

function updateGlobalBadge() {
  const attached = tabMgr.getAttachedTabs();
  if (relay.state !== 'connected') {
    if (relay.state === 'connecting' || relay.state === 'reconnecting') {
      setBadge(null, 'connecting');
    } else {
      setBadge(null, 'error');
    }
    return;
  }
  if (attached.size > 0) {
    setBadge(null, 'on');
  } else {
    setBadge(null, 'off');
  }
}

function updateTabBadge(tabId) {
  if (perms.hasPendingRequest(tabId)) {
    setBadge(tabId, 'ask');
  } else if (tabMgr.isAttached(tabId)) {
    setBadge(tabId, 'on');
  } else {
    setBadge(tabId, 'off');
  }
}

// --- Alarm handler (relay keepalive & reconnect) ---
chrome.alarms.onAlarm.addListener((alarm) => relay.handleAlarm(alarm));

// --- Permission manager init ---
perms.load();
perms.onPendingChange = (tabId) => updateTabBadge(tabId);

// --- Tab manager init ---
tabMgr.setPermissionManager(perms);
tabMgr.onTabChange = (tabId, attached) => {
  updateTabBadge(tabId);
  updateGlobalBadge();
};
tabMgr.init();

// On relay state change, update badge and re-announce
relay.onStateChange = (state) => {
  updateGlobalBadge();
  if (state === 'connected') {
    tabMgr.reannounceAll();
  }
};

// --- Permission relay handlers ---
relay.on('pkrelay.permission.grant', (msg) => {
  const { tabId, duration } = msg.params || {};
  perms.resolvePermissionRequest(tabId, true, duration);
  updateTabBadge(tabId);
});

relay.on('pkrelay.permission.deny', (msg) => {
  const { tabId } = msg.params || {};
  perms.resolvePermissionRequest(tabId, false);
  updateTabBadge(tabId);
});

// --- Perception (snapshot) handler ---
relay.on('pkrelay.snapshot', async (msg) => {
  const { id, params } = msg;
  const { tabTarget, diff, elementId, depth } = params || {};
  const tabId = tabMgr.resolveTab(tabTarget);
  try {
    const result = await perception.snapshot(tabId, { diff, elementId, depth });
    relay.send({ id, result });
  } catch (err) {
    relay.send({ id, error: String(err.message) });
  }
});

// --- Action executor ---
actions.setPerception(perception);

relay.on('pkrelay.action', async (msg) => {
  const { id, params } = msg;
  const { tabTarget, action } = params || {};
  const tabId = tabMgr.resolveTab(tabTarget);
  try {
    const result = await actions.execute(tabId, action);
    // Auto-include snapshot diff with action result
    await new Promise(r => setTimeout(r, 100)); // Brief settle time
    const diff = await perception.snapshot(tabId, { diff: true });
    relay.send({ id, result: { ...result, snapshot: diff } });
  } catch (err) {
    relay.send({ id, error: String(err.message) });
  }
});

relay.on('pkrelay.screenshot', async (msg) => {
  const { id, params } = msg;
  const { tabTarget, elementIndex, format, quality } = params || {};
  const tabId = tabMgr.resolveTab(tabTarget);
  try {
    const result = await perception.takeScreenshot(tabId, { elementIndex, format, quality });
    relay.send({ id, result });
  } catch (err) {
    relay.send({ id, error: String(err.message) });
  }
});

// --- Tab listing handler ---
relay.on('pkrelay.tabs', async (msg) => {
  const { id } = msg;
  try {
    const tabPerms = await perms.getTabPermissions();
    const attachedTabs = tabMgr.getAttachedTabs();
    const result = tabPerms
      .filter(t => t.level !== 'none')
      .map(t => ({
        tabId: t.tabId,
        url: t.url,
        title: t.title,
        level: t.level,
        attached: attachedTabs.has(t.tabId),
        hasPendingRequest: t.hasPendingRequest
      }));
    relay.send({ id, result });
  } catch (err) {
    relay.send({ id, error: String(err.message) });
  }
});

// --- Popup / internal message passing ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getState') {
    (async () => {
      const stored = await chrome.storage.local.get(['browserName']);
      const tabPerms = await perms.getTabPermissions();
      const attachedTabs = tabMgr.getAttachedTabs();
      const tabs = tabPerms.map(t => ({
        ...t,
        attached: attachedTabs.has(t.tabId)
      }));
      sendResponse({
        connectionState: relay.state,
        browserName: stored.browserName || 'Browser',
        relayUrl: `ws://127.0.0.1:${relay.port}/extension`,
        browserLevel: perms.browserLevel,
        tabs
      });
    })();
    return true; // async response
  }
  if (msg.type === 'setPermission') {
    perms.setRule(msg.pattern, msg.level);
    sendResponse({ ok: true });
  }
  if (msg.type === 'setBrowserLevel') {
    perms.setBrowserLevel(msg.level);
    sendResponse({ ok: true });
  }
  if (msg.type === 'toggleTab') {
    tabMgr.toggleTab(msg.tabId).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  if (msg.type === 'connect') {
    relay.connect().then(() => sendResponse({ ok: true }));
    return true;
  }
});
