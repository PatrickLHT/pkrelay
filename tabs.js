// tabs.js — Tab attachment, session management, CDP event forwarding

export class TabManager {
  constructor(relay) {
    this.relay = relay;
    this.perms = null;                // Set via setPermissionManager
    this.tabs = new Map();            // tabId -> { state, sessionId, targetId }
    this.tabBySession = new Map();    // sessionId -> tabId
    this.childSessionToTab = new Map(); // childSessionId -> tabId
    this.debuggerListening = false;
    this.onTabChange = null;       // callback(tabId, attached)
  }

  setPermissionManager(perms) {
    this.perms = perms;
  }

  async init() {
    // Restore persisted state
    const stored = await chrome.storage.session.get(['attachedTabs']);
    if (stored.attachedTabs) {
      for (const [tabIdStr, data] of Object.entries(stored.attachedTabs)) {
        const tabId = Number(tabIdStr);
        this.tabs.set(tabId, { state: 'connected', ...data });
        if (data.sessionId) this.tabBySession.set(data.sessionId, tabId);
      }
    }
    this.installDebuggerListeners();

    // Register relay handler for CDP commands
    this.relay.on('forwardCDPCommand', (msg) => this.handleCDPCommand(msg));
  }

  installDebuggerListeners() {
    if (this.debuggerListening) return;
    this.debuggerListening = true;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      this.onDebuggerEvent(source.tabId, method, params);
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
      this.onDebuggerDetach(source.tabId, reason);
    });
  }

  async attachTab(tabId) {
    if (this.tabs.has(tabId)) return this.tabs.get(tabId);

    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');

    const info = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
    const targetInfo = info?.targetInfo || {};
    const targetId = String(targetInfo.targetId || '');
    const sessionId = `pk-tab-${tabId}-${Date.now()}`;

    const tabState = { state: 'connected', sessionId, targetId };
    this.tabs.set(tabId, tabState);
    this.tabBySession.set(sessionId, tabId);

    // Notify relay
    this.relay.send({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        sessionId,
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false
        }
      }
    });

    await this.persistState();
    if (this.onTabChange) this.onTabChange(tabId, true);
    return tabState;
  }

  async detachTab(tabId, reason = 'toggle') {
    const tabState = this.tabs.get(tabId);
    if (!tabState) return;

    // Notify relay
    if (tabState.sessionId) {
      this.relay.send({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: {
            sessionId: tabState.sessionId,
            targetId: tabState.targetId,
            reason
          }
        }
      });
      this.tabBySession.delete(tabState.sessionId);
    }

    // Clean up child sessions
    for (const [childSession, parentTabId] of this.childSessionToTab) {
      if (parentTabId === tabId) this.childSessionToTab.delete(childSession);
    }

    this.tabs.delete(tabId);

    try { await chrome.debugger.detach({ tabId }); } catch {}

    await this.persistState();
    if (this.onTabChange) this.onTabChange(tabId, false);
  }

  async toggleTab(tabId) {
    if (this.tabs.has(tabId)) {
      await this.detachTab(tabId, 'toggle');
    } else {
      await this.attachTab(tabId);
    }
  }

  onDebuggerEvent(tabId, method, params) {
    const tabState = this.tabs.get(tabId);
    if (!tabState) return;

    // Track child sessions (iframes, workers)
    if (method === 'Target.attachedToTarget' && params?.sessionId) {
      this.childSessionToTab.set(String(params.sessionId), tabId);
    }

    // Forward event to relay
    this.relay.send({
      method: 'forwardCDPEvent',
      params: {
        method,
        sessionId: tabState.sessionId,
        params
      }
    });
  }

  onDebuggerDetach(tabId, reason) {
    if (reason === 'target_closed') {
      void this.reattachAfterNavigation(tabId);
      return;
    }
    void this.detachTab(tabId, reason);
  }

  async reattachAfterNavigation(tabId) {
    const oldState = this.tabs.get(tabId);

    // Check if tab still exists (navigation vs actual close)
    try {
      await chrome.tabs.get(tabId);
    } catch {
      void this.detachTab(tabId, 'target_closed');
      return;
    }

    // Notify relay about old session ending
    if (oldState?.sessionId) {
      this.relay.send({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: {
            sessionId: oldState.sessionId,
            targetId: oldState.targetId,
            reason: 'navigation'
          }
        }
      });
      this.tabBySession.delete(oldState.sessionId);
    }

    // Clean up child sessions from old page
    for (const [childSession, parentTabId] of this.childSessionToTab) {
      if (parentTabId === tabId) this.childSessionToTab.delete(childSession);
    }

    this.tabs.delete(tabId);

    // Retry re-attachment with backoff
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      try {
        await this.attachTab(tabId);
        return;
      } catch {}
    }

    // Failed to re-attach after 3 attempts
    await this.persistState();
  }

  async handleCDPCommand(msg) {
    const { id, params } = msg;
    const { sessionId, method, params: cmdParams } = params || {};

    try {
      const tabId = this.resolveTab(sessionId, cmdParams);
      if (tabId == null) throw new Error(`No attached tab for ${method}`);

      // Permission enforcement
      if (this.perms) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const url = tab?.url || '';
        if (!this.perms.canAccess(tabId, url)) {
          const level = this.perms.getLevel(url);
          if (level === 'none') {
            throw new Error(`Access denied: tab ${tabId} has "No Access" permission`);
          }
          if (level === 'ask' && !this.perms.hasPendingRequest(tabId)) {
            // Send permission request to relay, block until resolved
            this.relay.send({
              method: 'pkrelay.permission.request',
              params: { tabId, url, title: tab?.title || '' }
            });
            const granted = await this.perms.requestPermission(tabId);
            if (!granted) {
              throw new Error(`Permission denied for tab ${tabId}`);
            }
          }
        }
      }

      let result;

      // Special command handlers
      if (method === 'Runtime.enable') {
        result = await this.handleRuntimeEnable(tabId, cmdParams);
      } else if (method === 'Target.createTarget') {
        result = await this.handleCreateTarget(cmdParams);
      } else if (method === 'Target.closeTarget') {
        result = await this.handleCloseTarget(tabId, cmdParams);
      } else if (method === 'Target.activateTarget') {
        result = await this.handleActivateTarget(tabId, cmdParams);
      } else {
        // Standard CDP passthrough
        const debuggee = this.buildDebuggee(tabId, sessionId);
        result = await chrome.debugger.sendCommand(debuggee, method, cmdParams || {});
      }

      this.relay.send({ id, result: result || {} });
    } catch (err) {
      this.relay.send({ id, error: String(err.message || err) });
    }
  }

  resolveTab(sessionId, params) {
    // By session
    if (sessionId && this.tabBySession.has(sessionId)) {
      return this.tabBySession.get(sessionId);
    }
    // By child session
    if (sessionId && this.childSessionToTab.has(sessionId)) {
      return this.childSessionToTab.get(sessionId);
    }
    // By targetId
    const targetId = params?.targetId;
    if (targetId) {
      for (const [tabId, state] of this.tabs) {
        if (state.targetId === targetId) return tabId;
      }
    }
    // Fallback: first connected tab
    for (const [tabId, state] of this.tabs) {
      if (state.state === 'connected') return tabId;
    }
    return null;
  }

  buildDebuggee(tabId, sessionId) {
    const tabState = this.tabs.get(tabId);
    const mainSession = tabState?.sessionId;
    if (sessionId && mainSession && sessionId !== mainSession) {
      return { tabId, sessionId }; // Child session
    }
    return { tabId };
  }

  async handleRuntimeEnable(tabId, params) {
    try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.disable'); } catch {}
    await new Promise(r => setTimeout(r, 50));
    return await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', params || {});
  }

  async handleCreateTarget(params) {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank';
    const tab = await chrome.tabs.create({ url, active: false });
    await new Promise(r => setTimeout(r, 100));
    const attached = await this.attachTab(tab.id);
    return { targetId: attached.targetId };
  }

  async handleCloseTarget(fallbackTabId, params) {
    const targetId = params?.targetId;
    let tabId = fallbackTabId;
    if (targetId) {
      for (const [tid, state] of this.tabs) {
        if (state.targetId === targetId) { tabId = tid; break; }
      }
    }
    try {
      await chrome.tabs.remove(tabId);
      return { success: true };
    } catch {
      return { success: false };
    }
  }

  async handleActivateTarget(fallbackTabId, params) {
    const targetId = params?.targetId;
    let tabId = fallbackTabId;
    if (targetId) {
      for (const [tid, state] of this.tabs) {
        if (state.targetId === targetId) { tabId = tid; break; }
      }
    }
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return {};
  }

  async reannounceAll() {
    // Called after relay reconnection
    for (const [tabId, state] of this.tabs) {
      try {
        const info = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
        this.relay.send({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            sessionId: state.sessionId,
            params: {
              sessionId: state.sessionId,
              targetInfo: { ...info?.targetInfo, attached: true },
              waitingForDebugger: false
            }
          }
        });
      } catch {
        // Tab/debugger no longer valid — clean up
        this.tabBySession.delete(state.sessionId);
        this.tabs.delete(tabId);
      }
    }
    await this.persistState();
  }

  async persistState() {
    const attachedTabs = {};
    for (const [tabId, state] of this.tabs) {
      attachedTabs[tabId] = { sessionId: state.sessionId, targetId: state.targetId };
    }
    await chrome.storage.session.set({ attachedTabs });
  }

  getAttachedTabs() {
    return new Map(this.tabs);
  }

  isAttached(tabId) {
    return this.tabs.has(tabId);
  }
}
