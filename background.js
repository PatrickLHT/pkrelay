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

// Expose for CDP debugging
self._relay = relay;
self._tabMgr = tabMgr;

// --- Badge management ---
const BADGE = {
  on:         { text: 'ON',  bg: '#22C55E' },
  off:        { text: '',    bg: '#000000' },
  connecting: { text: '...', bg: '#F59E0B' },
  error:      { text: '!',   bg: '#B91C1C' },
  ask:        { text: '?',   bg: '#3B82F6' },
  standby:    { text: 'SB',  bg: '#8B5CF6' }
};

function setBadge(tabId, state) {
  const cfg = BADGE[state];
  if (!cfg) return;
  const opts = tabId ? { tabId } : {};
  chrome.action.setBadgeText({ ...opts, text: cfg.text });
  chrome.action.setBadgeBackgroundColor({ ...opts, color: cfg.bg });
}

// Notify popup of state changes (real-time UI updates)
function notifyPopup() {
  chrome.runtime.sendMessage({ type: 'stateChanged' }).catch(() => {
    // Popup not open — ignore
  });
}

function updateGlobalBadge() {
  const attached = tabMgr.getAttachedTabs();
  if (relay.state !== 'connected') {
    if (relay.state === 'standby') {
      setBadge(null, 'standby');
    } else if (relay.state === 'connecting' || relay.state === 'reconnecting') {
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
  notifyPopup();
};
tabMgr.init();

// --- Auto-connect on startup ---
relay.connect();

// On relay state change, update badge and re-announce
relay.onStateChange = (state) => {
  updateGlobalBadge();
  notifyPopup();
  if (state === 'connected') {
    tabMgr.clearUserDetached(); // Fresh connection = fresh start
    tabMgr.reannounceAll();
    autoAttachActiveTab();
  }
};

// Auto-attach the active tab on connect — only if permission is "full".
// Skips "ask" tabs (would block forever waiting for popup approval).
async function autoAttachActiveTab() {
  if (tabMgr.getAttachedTabs().size > 0) return;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!activeTab || !activeTab.url || activeTab.url.startsWith('chrome')) return;

    // Only auto-attach if this tab has "full" permission (no user prompt needed)
    const level = perms.getLevel(activeTab.url);
    if (level !== 'full') {
      console.log(`[PKRelay] Auto-attach skipped: tab ${activeTab.id} has "${level}" permission (need "full")`);
      return;
    }

    // Respect user manual detach
    if (tabMgr.isUserDetached(activeTab.id)) {
      console.log(`[PKRelay] Auto-attach skipped: tab ${activeTab.id} was manually detached`);
      return;
    }

    await tabMgr.attachTab(activeTab.id);
    console.log(`[PKRelay] Auto-attached tab ${activeTab.id}: ${activeTab.title}`);
  } catch (err) {
    console.log('[PKRelay] Auto-attach failed:', err.message);
  }
}

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
  const tabId = tabMgr.resolveTabTarget(tabTarget);
  try {
    await tabMgr.enforcePermission(tabId);
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
  const tabId = tabMgr.resolveTabTarget(tabTarget);
  try {
    await tabMgr.enforcePermission(tabId);
    const result = await actions.execute(tabId, action);
    // Auto-include snapshot diff with action result (non-fatal if it fails)
    let snapshot = null;
    try {
      await new Promise(r => setTimeout(r, 100)); // Brief settle time
      snapshot = await perception.snapshot(tabId, { diff: true });
    } catch {}
    relay.send({ id, result: { ...result, snapshot } });
  } catch (err) {
    relay.send({ id, error: String(err.message) });
  }
});

relay.on('pkrelay.screenshot', async (msg) => {
  const { id, params } = msg;
  const { tabTarget, elementIndex, format, quality } = params || {};
  const tabId = tabMgr.resolveTabTarget(tabTarget);
  try {
    await tabMgr.enforcePermission(tabId);
    const result = await perception.takeScreenshot(tabId, { elementIndex, format, quality });
    relay.send({ id, result });
  } catch (err) {
    relay.send({ id, error: String(err.message) });
  }
});

// --- Auto-discover: when stock CDP asks for targets and none are attached,
//     auto-attach the active tab (with permission flow) so the agent can see it.
//     This bridges the gap between OpenClaw's stock CDP protocol and PKRelay's
//     permission-based tab system.
const _origCDPHandler = relay.messageHandlers.get('forwardCDPCommand');
relay.messageHandlers.delete('forwardCDPCommand');
relay.on('forwardCDPCommand', async (msg) => {
  // Auto-attach active tab when CDP command arrives and none are attached.
  // Only for "full" permission tabs — "ask" tabs would block the command.
  const attached = tabMgr.getAttachedTabs();
  if (attached.size === 0) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (activeTab && activeTab.url && !activeTab.url.startsWith('chrome')) {
        const level = perms.getLevel(activeTab.url);
        if (level === 'full' && !tabMgr.isUserDetached(activeTab.id)) {
          await tabMgr.attachTab(activeTab.id);
          await new Promise(r => setTimeout(r, 200));
          console.log(`[PKRelay] Auto-attached tab ${activeTab.id} on CDP command`);
        }
      }
    } catch (err) {
      console.log('[PKRelay] Auto-attach on CDP skipped:', err.message);
    }
  }
  // Continue to the normal CDP handler registered by TabManager
  tabMgr.handleCDPCommand(msg);
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

// --- Tab attach/detach handler ---
relay.on('pkrelay.attach', async (msg) => {
  const { id, params } = msg;
  const { tabId } = params || {};
  try {
    if (typeof tabId !== 'number') throw new Error('Missing or invalid tabId');
    await tabMgr.enforcePermission(tabId);
    const tabState = await tabMgr.attachTab(tabId);
    relay.send({ id, result: { tabId, sessionId: tabState.sessionId, targetId: tabState.targetId } });
  } catch (err) {
    relay.send({ id, error: String(err.message) });
  }
});

relay.on('pkrelay.detach', async (msg) => {
  const { id, params } = msg;
  const { tabId } = params || {};
  try {
    if (typeof tabId !== 'number') throw new Error('Missing or invalid tabId');
    await tabMgr.detachTab(tabId, 'agent');
    relay.send({ id, result: { tabId, detached: true } });
  } catch (err) {
    relay.send({ id, error: String(err.message) });
  }
});

// --- Extension reload (callable by agent) ---
relay.on('pkrelay.reload', async (msg) => {
  const { id } = msg;
  relay.send({ id, result: { reloading: true } });
  // Brief delay to flush the response before we die
  await new Promise(r => setTimeout(r, 200));
  chrome.runtime.reload();
});

// --- Hot-swap browser switching ---
relay.on('pkrelay.switchBrowser', async (msg) => {
  const { id, params } = msg;
  const { targetBrowser } = params || {};

  if (!targetBrowser) {
    relay.send({ id, error: 'Missing targetBrowser parameter' });
    return;
  }

  const stored = await chrome.storage.local.get(['browserName', 'knownBrowsers']);
  const ourName = stored.browserName || 'Browser';

  if (ourName.toLowerCase() === targetBrowser.toLowerCase()) {
    relay.send({ id, error: `Already connected as ${ourName}` });
    return;
  }

  // Auto-add target to known browsers
  const known = stored.knownBrowsers || [];
  if (!known.some(b => b.toLowerCase() === targetBrowser.toLowerCase())) {
    known.push(targetBrowser);
    await chrome.storage.local.set({ knownBrowsers: known });
  }

  await relay.yieldSlot(targetBrowser, id, ourName);
});

// --- Popup / internal message passing ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getState') {
    (async () => {
      const stored = await chrome.storage.local.get(['browserName', 'knownBrowsers']);
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
        standbyReason: relay.standbyReason,
        knownBrowsers: stored.knownBrowsers || [],
        tabs
      });
    })();
    return true; // async response
  }
  if (msg.type === 'setPermission') {
    perms.setRule(msg.pattern, msg.level);
    // Auto-attach/detach tabs matching this pattern based on new permission level
    if (msg.level === 'full' || msg.level === 'none') {
      (async () => {
        const allTabs = await chrome.tabs.query({});
        for (const tab of allTabs) {
          if (!tab.url || tab.url.startsWith('chrome')) continue;
          if (!perms.matchPattern(msg.pattern, tab.url)) continue;
          if (msg.level === 'full' && !tabMgr.isAttached(tab.id) && relay.state === 'connected') {
            tabMgr.attachTab(tab.id).catch(() => {});
          } else if (msg.level === 'none' && tabMgr.isAttached(tab.id)) {
            tabMgr.detachTab(tab.id, 'permission').catch(() => {});
          }
        }
      })();
    }
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
  if (msg.type === 'switchBrowser') {
    (async () => {
      const { targetBrowser } = msg;
      if (!targetBrowser) {
        sendResponse({ ok: false, reason: 'Missing targetBrowser' });
        return;
      }
      const stored = await chrome.storage.local.get(['browserName']);
      const ourName = stored.browserName || 'Browser';
      if (ourName.toLowerCase() === targetBrowser.toLowerCase()) {
        sendResponse({ ok: false, reason: `Already connected as ${ourName}` });
        return;
      }
      await relay.yieldSlot(targetBrowser, null, ourName);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'resumeFromStandby') {
    if (relay.state === 'standby') {
      relay.resumeFromStandby();
      setTimeout(() => sendResponse({ ok: true }), 500);
    } else {
      sendResponse({ ok: false, reason: 'Not in standby' });
    }
    return true;
  }
});
