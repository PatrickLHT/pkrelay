// relay.js — WebSocket connection to OpenClaw gateway relay (stub)

export class RelayConnection {
  constructor() {
    this.ws = null;
    this.state = 'disconnected';
    this.messageHandlers = new Map();
    this.onStateChange = null;
  }

  on(method, handler) {
    this.messageHandlers.set(method, handler);
  }

  send(message) {}
  async connect() {}
  disconnect() {}
  handleAlarm(alarm) {}
}
