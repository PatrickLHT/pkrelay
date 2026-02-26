// perception.js — Structured page perception via accessibility tree (stub)

export class PerceptionEngine {
  constructor() {
    this.lastSnapshot = null;
    this.elementIndex = new Map();
    this.nextIndex = 1;
  }

  async snapshot(tabId, options = {}) { return { type: 'full', content: { lines: [], indexed: [], elementCount: 0 } }; }
  getElement(index) { return this.elementIndex.get(index); }
}
