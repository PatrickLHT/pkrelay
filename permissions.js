// permissions.js — URL-pattern-based tab permission system

export class PermissionManager {
  constructor() {
    this.browserLevel = 'per-tab'; // 'per-tab' | 'full-browser'
    this.tabRules = [];            // [{ pattern, level }]
    this.defaultLevel = 'ask';     // 'none' | 'ask' | 'full'
    this.sessionGrants = new Map(); // tabId -> 'granted' (for "Ask First" session grants)
    this.pendingRequests = new Map(); // tabId -> { resolve, reject }
  }

  async load() {
    const stored = await chrome.storage.local.get(['permissions']);
    const perms = stored.permissions || {};
    this.browserLevel = perms.browserLevel || 'per-tab';
    this.tabRules = perms.tabRules || [];
    this.defaultLevel = perms.defaultLevel || 'ask';
  }

  async save() {
    await chrome.storage.local.set({
      permissions: {
        browserLevel: this.browserLevel,
        tabRules: this.tabRules,
        defaultLevel: this.defaultLevel
      }
    });
  }

  // Get effective permission for a URL
  getLevel(url) {
    if (this.browserLevel === 'full-browser') return 'full';

    for (const rule of this.tabRules) {
      if (this.matchPattern(rule.pattern, url)) return rule.level;
    }
    return this.defaultLevel;
  }

  // Check if agent can access this tab right now
  canAccess(tabId, url) {
    const level = this.getLevel(url);
    if (level === 'full') return true;
    if (level === 'none') return false;
    // 'ask' — check session grants
    return this.sessionGrants.has(tabId);
  }

  // Set permission for a URL pattern
  setRule(pattern, level) {
    const existing = this.tabRules.findIndex(r => r.pattern === pattern);
    if (existing >= 0) {
      if (level === 'default') {
        this.tabRules.splice(existing, 1);
      } else {
        this.tabRules[existing].level = level;
      }
    } else if (level !== 'default') {
      this.tabRules.push({ pattern, level });
    }
    void this.save();
  }

  // Set browser-level permission
  setBrowserLevel(level) {
    this.browserLevel = level;
    void this.save();
  }

  // Grant session access for "Ask First" tab
  grantSession(tabId) {
    this.sessionGrants.set(tabId, 'granted');
  }

  // Grant permanent access (promotes to "full")
  grantAlways(url) {
    const pattern = this.urlToPattern(url);
    this.setRule(pattern, 'full');
  }

  // Resolve a pending "Ask First" request
  resolvePermissionRequest(tabId, granted, duration) {
    const pending = this.pendingRequests.get(tabId);
    if (!pending) return;

    this.pendingRequests.delete(tabId);

    if (granted) {
      if (duration === 'always') {
        // Need the tab URL to create permanent rule
        chrome.tabs.get(tabId).then(tab => {
          if (tab?.url) this.grantAlways(tab.url);
        });
      }
      if (duration === 'session' || duration === 'always') {
        this.grantSession(tabId);
      }
      pending.resolve(true);
    } else {
      pending.resolve(false);
    }
  }

  // Request permission — returns promise that resolves when user responds
  requestPermission(tabId) {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(tabId, { resolve, reject });
    });
  }

  hasPendingRequest(tabId) {
    return this.pendingRequests.has(tabId);
  }

  // Convert URL to a matching pattern
  urlToPattern(url) {
    try {
      const u = new URL(url);
      return `${u.hostname}/*`;
    } catch {
      return url;
    }
  }

  // Simple glob-style pattern matching
  matchPattern(pattern, url) {
    try {
      const u = new URL(url);
      const target = u.hostname + u.pathname;

      // Convert glob pattern to regex
      const regex = new RegExp(
        '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
      );
      return regex.test(target) || regex.test(u.hostname);
    } catch {
      return false;
    }
  }

  // Get all rules for popup display
  getRules() {
    return [...this.tabRules];
  }

  // Get permission info for all open tabs
  async getTabPermissions() {
    const allTabs = await chrome.tabs.query({});
    return allTabs.map(tab => ({
      tabId: tab.id,
      url: tab.url || '',
      title: tab.title || '',
      favIconUrl: tab.favIconUrl || '',
      level: this.getLevel(tab.url || ''),
      hasPendingRequest: this.pendingRequests.has(tab.id)
    }));
  }
}
