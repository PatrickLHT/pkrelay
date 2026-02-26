// actions.js — High-level action primitives (stub)

export class ActionExecutor {
  constructor() {
    this.perception = null;
  }

  setPerception(perception) { this.perception = perception; }
  async execute(tabId, action) { throw new Error('Not implemented'); }
}
