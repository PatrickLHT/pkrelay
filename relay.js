// relay.js — WebSocket connection to OpenClaw gateway relay

const KEEPALIVE_ALARM = 'pkrelay-keepalive';
const RECONNECT_ALARM = 'pkrelay-reconnect';
const KEEPALIVE_INTERVAL_MIN = 0.42; // ~25 seconds
const MAX_RECONNECT_DELAY = 30000;
const HEALTH_CHECK_TIMEOUT = 2000;
const WS_CONNECT_TIMEOUT = 5000;
const PONG_TIMEOUT = 5000;

export class RelayConnection {
  constructor() {
    this.ws = null;
    this.port = 18792;
    this.reconnectAttempts = 0;
    this.state = 'disconnected'; // disconnected | connecting | connected | reconnecting
    this.messageHandlers = new Map(); // method -> handler function
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this.nextRequestId = 1;
    this.lastPongTime = 0;
    this.onStateChange = null; // callback(newState)
  }

  // Register handler for incoming messages by method name
  on(method, handler) {
    this.messageHandlers.set(method, handler);
  }

  // Send message to relay
  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  // Send request and await response (for messages with id)
  async request(method, params, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async loadPort() {
    const stored = await chrome.storage.local.get(['relayPort']);
    this.port = Number(stored.relayPort) || 18792;
  }

  async healthCheck() {
    const url = `http://127.0.0.1:${this.port}/`;
    const resp = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT)
    });
    return resp.ok || resp.status < 500;
  }

  async connect() {
    if (this.state === 'connecting') return;
    this.setState('connecting');
    await this.loadPort();

    try {
      await this.healthCheck();
    } catch {
      this.setState('disconnected');
      this.scheduleReconnect();
      return;
    }

    try {
      await this.openWebSocket();
      this.reconnectAttempts = 0;
      this.setState('connected');
      this.startKeepalive();
      chrome.alarms.clear(RECONNECT_ALARM);
    } catch {
      this.setState('disconnected');
      this.scheduleReconnect();
    }
  }

  openWebSocket() {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${this.port}/extension`;
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connect timeout'));
      }, WS_CONNECT_TIMEOUT);

      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };

      ws.onclose = () => {
        clearTimeout(timer);
        if (this.ws === ws) {
          this.ws = null;
          this.onRelayDisconnected();
        } else {
          reject(new Error('WebSocket closed before open'));
        }
      };

      ws.onerror = () => {}; // onclose always follows

      ws.onmessage = (event) => this.handleMessage(event);
    });
  }

  handleMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    // Handle pong
    if (msg.method === 'pong') {
      this.lastPongTime = Date.now();
      return;
    }

    // Handle response to our request
    if (msg.id != null && this.pendingRequests.has(msg.id)) {
      const { resolve, reject, timer } = this.pendingRequests.get(msg.id);
      clearTimeout(timer);
      this.pendingRequests.delete(msg.id);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
      return;
    }

    // Handle ping from relay
    if (msg.method === 'ping') {
      this.send({ method: 'pong' });
      return;
    }

    // Dispatch to registered handler
    const handler = this.messageHandlers.get(msg.method);
    if (handler) {
      handler(msg);
    }
  }

  onRelayDisconnected() {
    this.setState('reconnecting');
    this.stopKeepalive();
    // Reject all pending requests
    for (const [id, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error('Relay disconnected'));
    }
    this.pendingRequests.clear();
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    const base = 1000;
    const delay = Math.min(base * Math.pow(2, this.reconnectAttempts), MAX_RECONNECT_DELAY);
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts++;

    setTimeout(() => void this.connect(), jittered);

    // Backup alarm in case SW dies before setTimeout fires
    chrome.alarms.create(RECONNECT_ALARM, {
      delayInMinutes: Math.max(jittered / 60000, 0.5)
    });
  }

  startKeepalive() {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
  }

  stopKeepalive() {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  }

  handleAlarm(alarm) {
    if (alarm.name === KEEPALIVE_ALARM) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        void this.connect();
        return;
      }
      // Check if last pong is stale (dead connection)
      if (this.lastPongTime > 0 && Date.now() - this.lastPongTime > PONG_TIMEOUT * 2) {
        this.ws.close(); // Will trigger onRelayDisconnected
        return;
      }
      this.send({ method: 'ping' });
    }
    if (alarm.name === RECONNECT_ALARM) {
      if (this.state !== 'connected') void this.connect();
    }
  }

  setState(newState) {
    this.state = newState;
    if (this.onStateChange) this.onStateChange(newState);
  }

  disconnect() {
    this.stopKeepalive();
    chrome.alarms.clear(RECONNECT_ALARM);
    // Reject all pending requests
    for (const [id, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error('Relay disconnected'));
    }
    this.pendingRequests.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }
}
