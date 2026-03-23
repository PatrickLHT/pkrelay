// relay.js — Native messaging relay to PKRelay CDP bridge server (v2.0)
//
// Architecture change (OpenClaw 2026.3.22+):
//   OLD: Extension connects as WebSocket CLIENT to ws://127.0.0.1:18792/extension
//   NEW: server.py runs a CDP SERVER on port 18792; extension communicates with
//        it via chrome.runtime.connectNative (native messaging port)
//
// Communication flow:
//   OpenClaw → HTTP/WS → server.py → NM port → background.js (here) → chrome.debugger
//
// This module maintains the native messaging port connection and provides the
// same send/on/request interface that background.js and tabs.js use.

const KEEPALIVE_ALARM = 'pkrelay-keepalive';
const RECONNECT_ALARM = 'pkrelay-reconnect';
const KEEPALIVE_INTERVAL_MIN = 0.42; // ~25 seconds
const MAX_RECONNECT_DELAY = 30000;
const NM_HOST_NAME = 'com.pkrelay.cdp_server';

export class RelayConnection {
  constructor() {
    this.port = null;           // Native messaging port (chrome.runtime.Port)
    this.cdpPort = 18792;      // CDP server port (for display/options only)
    this.reconnectAttempts = 0;
    this.state = 'disconnected'; // disconnected | connecting | connected | reconnecting
    this.messageHandlers = new Map(); // method -> handler function
    this.pendingRequests = new Map(); // nmId -> { resolve, reject, timer }
    this.nextNmId = 1;
    this.onStateChange = null; // callback(newState)
    this.connectedAt = 0;

    // Compatibility shims (kept for callers that reference these)
    this.standbyReason = null;
    this.slotTaken = false;
    this.fastRetryAttempts = 0;
    this.isDefault = false;
  }

  // ── Public API (same interface as old RelayConnection) ─────────────────────

  /** Register handler for incoming messages from server.py by method name */
  on(method, handler) {
    this.messageHandlers.set(method, handler);
  }

  /** Send a request and await the response (uses nmId round-trip). */
  async request(method, params, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const nmId = this.nextNmId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(nmId);
        reject(new Error(`Request ${method} timed out`));
      }, timeoutMs);
      this.pendingRequests.set(nmId, { resolve, reject, timer });
      this.send({ nmId, method, params });
    });
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  async loadConfig() {
    const stored = await chrome.storage.local.get(['cdpServerPort', 'relayPort', 'isDefault']);
    // cdpServerPort is the new key; fall back to relayPort for migration
    this.cdpPort = Number(stored.cdpServerPort || stored.relayPort) || 18792;
    this.isDefault = !!stored.isDefault;
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  async connect() {
    if (this.state === 'connecting' || this.state === 'connected') return;
    console.log(`[PKRelay] connect() — state=${this.state}`);
    this.setState('connecting');
    await this.loadConfig();

    try {
      this._openNativePort();
      // State transitions to 'connected' when server.py sends 'serverStarted'
      // or after a brief grace period (server might already be running)
    } catch (err) {
      console.log('[PKRelay] NM connect failed:', err.message);
      this.setState('disconnected');
      this.scheduleReconnect();
    }
  }

  _openNativePort() {
    console.log('[PKRelay] Opening native messaging port:', NM_HOST_NAME);
    const port = chrome.runtime.connectNative(NM_HOST_NAME);
    this.port = port;

    port.onMessage.addListener((msg) => this._handleNativeMessage(msg));

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      console.log('[PKRelay] NM port disconnected:', err?.message || 'no error');
      this.port = null;
      this._onDisconnected();
    });

    // Give the server a moment to start (it sends 'serverStarted' when ready)
    // But also set connected optimistically after a short timeout so auto-attach works
    setTimeout(() => {
      if (this.state === 'connecting' && this.port) {
        console.log('[PKRelay] NM port assumed ready');
        this._onConnected();
      }
    }, 500);
  }

  _handleNativeMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    const type = msg.type;

    // Server lifecycle
    if (type === 'serverStarted') {
      console.log('[PKRelay] CDP server started on port', msg.port);
      if (this.state === 'connecting') {
        this._onConnected();
      }
      return;
    }

    // CDP command from a WS client (OpenClaw) → dispatch to our handlers
    if (type === 'cdpCommand') {
      const { nmId, wsId, sessionId, targetId, method, params } = msg;
      this._dispatchCDPCommand({ nmId, wsId, sessionId, targetId, method, params });
      return;
    }

    // WS client connected/disconnected lifecycle
    if (type === 'cdpClientConnected') {
      console.log('[PKRelay] CDP client connected, session:', msg.sessionId);
      // Re-announce all attached tabs so OpenClaw sees them
      const handler = this.messageHandlers.get('_clientConnected');
      if (handler) Promise.resolve(handler(msg)).catch(() => {});
      return;
    }

    if (type === 'cdpClientDisconnected') {
      console.log('[PKRelay] CDP client disconnected, session:', msg.sessionId);
      return;
    }

    // Response to a request we sent (nmId echo)
    if (msg.nmId != null && this.pendingRequests.has(msg.nmId)) {
      const { resolve, reject, timer } = this.pendingRequests.get(msg.nmId);
      clearTimeout(timer);
      this.pendingRequests.delete(msg.nmId);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
      return;
    }

    // Fallback: dispatch to registered handler by method
    if (msg.method) {
      const handler = this.messageHandlers.get(msg.method);
      if (handler) {
        Promise.resolve(handler(msg)).catch(() => {});
      }
    }
  }

  /**
   * Dispatch an incoming CDP command from OpenClaw (via server.py).
   * Maps to the old relay.on('forwardCDPCommand', ...) interface so
   * tabs.js and background.js handlers still work unchanged.
   */
  _dispatchCDPCommand({ nmId, wsId, sessionId, targetId, method, params }) {
    // Build a message that looks like the old gateway forwardCDPCommand
    const msg = {
      id: nmId,         // used by relay.send({ id, result }) below
      _wsId: wsId,      // original CDP id from WS client
      params: { sessionId, targetId, method, params }
    };

    const handler = this.messageHandlers.get('forwardCDPCommand');
    if (handler) {
      Promise.resolve(handler(msg)).catch(() => {});
    }
  }

  _onConnected() {
    this.connectedAt = Date.now();
    this.reconnectAttempts = 0;
    this.setState('connected');
    console.log('[PKRelay] NM connected to CDP bridge');
    this.startKeepalive();
    chrome.alarms.clear(RECONNECT_ALARM);
  }

  _onDisconnected() {
    const connDuration = Date.now() - (this.connectedAt || 0);
    console.log(`[PKRelay] NM disconnected — connDuration=${connDuration}ms`);
    this.stopKeepalive();

    // Reject all pending requests
    for (const [id, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error('NM disconnected'));
    }
    this.pendingRequests.clear();

    this.setState('disconnected');
    this.scheduleReconnect();
  }

  // ── Keepalive ──────────────────────────────────────────────────────────────

  startKeepalive() {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN });
  }

  stopKeepalive() {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  }

  handleAlarm(alarm) {
    console.log(`[PKRelay] alarm: ${alarm.name} state=${this.state}`);
    if (alarm.name === KEEPALIVE_ALARM) {
      if (!this.port) {
        void this.connect();
        return;
      }
      // Send a ping to server.py to keep NM port alive
      try {
        this.port.postMessage({ type: 'ping' });
      } catch {}
    }
    if (alarm.name === RECONNECT_ALARM) {
      if (this.state !== 'connected') void this.connect();
    }
  }

  scheduleReconnect() {
    const base = 1000;
    const delay = Math.min(base * Math.pow(2, this.reconnectAttempts), MAX_RECONNECT_DELAY);
    const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
    this.reconnectAttempts++;

    setTimeout(() => void this.connect(), jittered);
    chrome.alarms.create(RECONNECT_ALARM, {
      delayInMinutes: Math.max(jittered / 60000, 0.5)
    });
  }

  // ── State ─────────────────────────────────────────────────────────────────

  setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (this.onStateChange) this.onStateChange(newState);
  }

  disconnect() {
    this.stopKeepalive();
    chrome.alarms.clear(RECONNECT_ALARM);
    for (const [id, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error('Relay disconnected'));
    }
    this.pendingRequests.clear();
    if (this.port) {
      try { this.port.disconnect(); } catch {}
      this.port = null;
    }
    this.setState('disconnected');
  }

  // ── Compat stubs (hot-swap & standby no longer needed in CDP mode) ─────────

  /**
   * yieldSlot: no-op in CDP mode. OpenClaw connects directly to the CDP server;
   * there's no single "slot" to contend over. Kept for API compatibility.
   */
  async yieldSlot(targetBrowser, requestId, yieldingBrowser) {
    console.log('[PKRelay] yieldSlot: hot-swap not needed in CDP mode');
  }

  resumeFromStandby() {
    if (this.state !== 'standby') return;
    void this.connect();
  }

  // ── Announce targets to server.py ─────────────────────────────────────────

  /**
   * Called by TabManager when tabs attach/detach.
   * Sends the current target list to server.py so /json/list stays accurate.
   */
  announceTargets(targets) {
    if (!this.port) return;
    try {
      this.port.postMessage({ type: 'targets', targets });
    } catch (err) {
      console.warn('[PKRelay] announceTargets failed:', err.message);
    }
  }

  /**
   * Send a CDP response back to server.py, which forwards it to the WS client.
   * Wraps relay.send() calls (id + result/error) into typed messages.
   */
  send(message) {
    if (!this.port) return;

    // If this is a response to a CDP command (has id field), wrap it
    if (message.id != null && ('result' in message || 'error' in message)) {
      try {
        this.port.postMessage({
          type: 'cdpResponse',
          nmId: message.id,
          result: message.result,
          error: message.error
        });
      } catch (err) {
        console.warn('[PKRelay] NM send (cdpResponse) failed:', err.message);
      }
      return;
    }

    // CDP events (forwardCDPEvent from tabs.js): wrap as cdpEvent
    if (message.method === 'forwardCDPEvent') {
      try {
        this.port.postMessage({
          type: 'cdpEvent',
          sessionId: message.params?.sessionId,
          method: message.params?.method,
          params: message.params?.params
        });
      } catch (err) {
        console.warn('[PKRelay] NM send (cdpEvent) failed:', err.message);
      }
      return;
    }

    // Generic fallback
    try {
      this.port.postMessage(message);
    } catch (err) {
      console.warn('[PKRelay] NM send failed:', err.message);
    }
  }
}
