// relay.js — WebSocket connection to OpenClaw gateway relay

const KEEPALIVE_ALARM = 'pkrelay-keepalive';
const RECONNECT_ALARM = 'pkrelay-reconnect';
const STANDBY_ALARM = 'pkrelay-standby-resume';
const FAST_RETRY_ALARM = 'pkrelay-fast-retry';
const KEEPALIVE_INTERVAL_MIN = 0.42; // ~25 seconds
const MAX_RECONNECT_DELAY = 30000;
const MAX_FAST_RETRY_DELAY = 5000;   // 5s cap for slot-taken retries
const STANDBY_TIMEOUT = 15000;            // 15s for intentional browser switches
const CONTENTION_STANDBY_TIMEOUT = 120000; // 2min for slot contention
const HEALTH_CHECK_TIMEOUT = 2000;
const WS_CONNECT_TIMEOUT = 3000;
const PONG_TIMEOUT = 5000;

export class RelayConnection {
  constructor() {
    this.ws = null;
    this.port = 18792;
    this.token = '';
    this.reconnectAttempts = 0;
    this.state = 'disconnected'; // disconnected | connecting | connected | reconnecting | standby
    this.messageHandlers = new Map(); // method -> handler function
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this.nextRequestId = 1;
    this.lastPongTime = 0;
    this.onStateChange = null; // callback(newState)
    this.standbyReason = null;     // { targetBrowser, startTime }
    this.slotTaken = false;        // true when gateway up but slot taken
    this.fastRetryAttempts = 0;
    this.connectedAt = 0;
    this.isDefault = false;
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

  async loadConfig() {
    const stored = await chrome.storage.local.get(['relayPort', 'relayToken', 'isDefault']);
    this.port = Number(stored.relayPort) || 18792;
    this.token = stored.relayToken || '';
    this.isDefault = !!stored.isDefault;

    // If no manual token, try native messaging to read from openclaw.json
    if (!this.token) {
      try {
        const config = await this.readNativeConfig();
        if (config.token) this.token = config.token;
        // Note: don't use config.port — openclaw.json has the main gateway port,
        // but extensions connect to the separate extension port (default 18792)
      } catch {}
    }
  }

  readNativeConfig() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native messaging timeout')), 2000);
      try {
        chrome.runtime.sendNativeMessage(
          'com.pkrelay.token_reader',
          { action: 'getConfig' },
          (response) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response?.error) {
              reject(new Error(response.error));
              return;
            }
            resolve(response || {});
          }
        );
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
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
    const wasStandby = this.state === 'standby';
    this.setState('connecting');
    await this.loadConfig();

    try {
      await this.healthCheck();
    } catch {
      this.slotTaken = false;
      this.setState('disconnected');
      this.scheduleReconnect();
      return;
    }

    try {
      await this.openWebSocket();
      this.connectedAt = Date.now();
      this.lastPongTime = Date.now(); // Enable stale-pong detection from the start
      // Note: don't reset fastRetryAttempts here — only reset after stable connection
      // (see onRelayDisconnected which checks connDuration)
      this.slotTaken = false;
      this.setState('connected');
      this.startKeepalive();
      chrome.alarms.clear(RECONNECT_ALARM);
      chrome.alarms.clear(FAST_RETRY_ALARM);
      if (wasStandby) {
        this.standbyReason = null;
        chrome.alarms.clear(STANDBY_ALARM);
      }
      await this.announceIdentity();
    } catch {
      // Health check passed but WebSocket upgrade failed — slot likely taken (409)
      this.slotTaken = true;

      // After too many rejected connection attempts, enter standby
      const maxAttempts = this.isDefault ? 8 : 4;
      if (this.fastRetryAttempts >= maxAttempts) {
        this.standbyReason = { targetBrowser: 'another browser', startTime: Date.now() };
        this.fastRetryAttempts = 0;
        this.setState('standby');
        chrome.alarms.create(STANDBY_ALARM, {
          delayInMinutes: CONTENTION_STANDBY_TIMEOUT / 60000
        });
        setTimeout(() => this.resumeFromStandby(), CONTENTION_STANDBY_TIMEOUT);
        return;
      }

      this.setState(wasStandby ? 'standby' : 'disconnected');
      this.scheduleFastRetry();
    }
  }

  async announceIdentity() {
    const stored = await chrome.storage.local.get(['browserName', 'browserId', 'isDefault']);
    let browserId = stored.browserId;
    if (!browserId) {
      browserId = `pkrelay-${crypto.randomUUID().slice(0, 8)}`;
      await chrome.storage.local.set({ browserId });
    }
    this.send({
      method: 'relay.announce',
      params: {
        browserName: stored.browserName || 'Browser',
        browserId,
        isDefault: !!stored.isDefault,
        extensionVersion: chrome.runtime.getManifest().version,
        capabilities: ['snapshot', 'actions', 'screenshot', 'diff', 'permissions', 'hot-swap']
      }
    });
  }

  openWebSocket() {
    return new Promise((resolve, reject) => {
      const tokenParam = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
      const url = `ws://127.0.0.1:${this.port}/extension${tokenParam}`;
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
    this.stopKeepalive();
    // Reject all pending requests
    for (const [id, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error('Relay disconnected'));
    }
    this.pendingRequests.clear();

    const connDuration = Date.now() - (this.connectedAt || 0);
    if (connDuration < 5000) {
      // Connection dropped almost immediately — another browser likely took the slot
      this.slotTaken = true;

      // After several rapid disconnections, stop fighting and enter standby
      // Default browser gets more attempts before yielding
      const maxAttempts = this.isDefault ? 8 : 4;
      if (this.fastRetryAttempts >= maxAttempts) {
        this.standbyReason = { targetBrowser: 'another browser', startTime: Date.now() };
        this.fastRetryAttempts = 0;
        this.setState('standby');
        // Long timeout for contention — don't keep fighting the other browser
        chrome.alarms.create(STANDBY_ALARM, {
          delayInMinutes: CONTENTION_STANDBY_TIMEOUT / 60000
        });
        setTimeout(() => this.resumeFromStandby(), CONTENTION_STANDBY_TIMEOUT);
        return;
      }

      this.setState('reconnecting');
      this.scheduleFastRetry();
    } else {
      // Normal disconnection after stable connection — reset attempts
      this.reconnectAttempts = 0;
      this.fastRetryAttempts = 0;
      this.setState('reconnecting');
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    this.slotTaken = false;
    this.fastRetryAttempts = 0;
    chrome.alarms.clear(FAST_RETRY_ALARM);
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
    if (alarm.name === STANDBY_ALARM) {
      this.resumeFromStandby();
    }
    if (alarm.name === FAST_RETRY_ALARM) {
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
    chrome.alarms.clear(STANDBY_ALARM);
    chrome.alarms.clear(FAST_RETRY_ALARM);
    this.standbyReason = null;
    this.slotTaken = false;
    this.fastRetryAttempts = 0;
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

  // Yield the gateway slot for a browser switch
  async yieldSlot(targetBrowser, requestId, yieldingBrowser) {
    // Send acknowledgment before disconnecting (skip for popup-initiated switches)
    if (requestId != null) {
      this.send({
        id: requestId,
        result: {
          status: 'yielding',
          yieldingBrowser,
          targetBrowser,
          timeoutMs: STANDBY_TIMEOUT
        }
      });

      // Brief delay to ensure response is flushed
      await new Promise(r => setTimeout(r, 100));
    }

    // Disconnect without triggering onRelayDisconnected
    this.stopKeepalive();
    chrome.alarms.clear(RECONNECT_ALARM);
    chrome.alarms.clear(FAST_RETRY_ALARM);
    for (const [id, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error('Relay yielded for browser switch'));
    }
    this.pendingRequests.clear();
    if (this.ws) {
      this.ws.onclose = null; // prevent onRelayDisconnected
      this.ws.close();
      this.ws = null;
    }

    // Enter standby with fast-retry polling
    this.standbyReason = { targetBrowser, startTime: Date.now() };
    this.fastRetryAttempts = 0;
    this.slotTaken = true;
    this.setState('standby');

    // Grace period: give target browser 2s to connect, then start polling
    setTimeout(() => {
      if (this.state === 'standby') this.scheduleFastRetry();
    }, 2000);

    // Safety timeout: force resume if target never connects
    chrome.alarms.create(STANDBY_ALARM, {
      delayInMinutes: STANDBY_TIMEOUT / 60000
    });
    setTimeout(() => this.resumeFromStandby(), STANDBY_TIMEOUT);
  }

  resumeFromStandby() {
    if (this.state !== 'standby') return;
    chrome.alarms.clear(STANDBY_ALARM);
    chrome.alarms.clear(FAST_RETRY_ALARM);
    this.standbyReason = null;
    this.slotTaken = false;
    this.fastRetryAttempts = 0;
    void this.connect();
  }

  scheduleFastRetry() {
    const delay = Math.min(
      1000 * Math.pow(1.5, this.fastRetryAttempts),
      MAX_FAST_RETRY_DELAY
    );
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
    this.fastRetryAttempts++;

    setTimeout(() => void this.connect(), jittered);

    // Backup alarm for SW persistence
    chrome.alarms.create(FAST_RETRY_ALARM, {
      delayInMinutes: Math.max(jittered / 60000, 0.5)
    });
  }
}
