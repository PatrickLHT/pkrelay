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

// --- Alarm handler (relay keepalive & reconnect) ---
chrome.alarms.onAlarm.addListener((alarm) => relay.handleAlarm(alarm));

// --- Permission manager init ---
perms.load();

// --- Tab manager init ---
tabMgr.setPermissionManager(perms);
tabMgr.init();

// On relay reconnect, re-announce tabs
relay.onStateChange = (state) => {
  if (state === 'connected') {
    tabMgr.reannounceAll();
  }
};

// --- Permission relay handlers ---
relay.on('pkrelay.permission.grant', (msg) => {
  const { tabId, duration } = msg.params || {};
  perms.resolvePermissionRequest(tabId, true, duration);
});

relay.on('pkrelay.permission.deny', (msg) => {
  const { tabId } = msg.params || {};
  perms.resolvePermissionRequest(tabId, false);
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
