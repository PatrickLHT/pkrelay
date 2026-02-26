// tabs.js — Tab attachment, session management, CDP event forwarding (stub)

export class TabManager {
  constructor(relay) {
    this.relay = relay;
    this.tabs = new Map();
  }

  async init() {}
  async attachTab(tabId) {}
  async detachTab(tabId) {}
  async toggleTab(tabId) {}
  async reannounceAll() {}
  getAttachedTabs() { return new Map(this.tabs); }
  isAttached(tabId) { return this.tabs.has(tabId); }
}
