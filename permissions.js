// permissions.js — URL-pattern-based tab permission system (stub)

export class PermissionManager {
  constructor() {
    this.browserLevel = 'per-tab';
    this.tabRules = [];
    this.defaultLevel = 'ask';
  }

  async load() {}
  async save() {}
  getLevel(url) { return this.defaultLevel; }
  canAccess(tabId, url) { return true; }
  setRule(pattern, level) {}
  setBrowserLevel(level) {}
}
