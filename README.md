# PKRelay

Token-efficient browser CDP server for AI agent interaction. Compatible with [OpenClaw](https://openclaw.com) 2026.3.22+ which connects directly to browser profiles via CDP URLs.

## Features

- **Structured perception** — Accessibility tree snapshots instead of screenshots (~95-99% token reduction)
- **High-level actions** — `click #7`, `fill-form`, `drag #3 to #5` instead of raw CDP commands
- **Per-tab permissions** — Full / Ask First / No Access per URL pattern
- **CDP server bridge** — Exposes attached tabs as a standard CDP endpoint for OpenClaw
- **No gateway dependency** — Works directly with OpenClaw's browser profile CDP integration
- **Auto-reconnect** — Keepalive pings, exponential backoff, alarm-based persistence
- **Multi-browser support** — Run in Chrome and Arc simultaneously

## Architecture

PKRelay v2 flips the transport: instead of connecting as a WebSocket client to OpenClaw's old relay endpoint, it **runs a CDP server** that OpenClaw connects to.

```
OpenClaw → HTTP/WS → server.py (port 18792) → Native Messaging → background.js → chrome.debugger → page
```

| Module | Purpose |
|--------|---------|
| `server.py` | CDP bridge server (HTTP + WS on port 18792) — native messaging host |
| `relay.js` | Native messaging relay — replaces old WebSocket client |
| `tabs.js` | Tab lifecycle, CDP debugger attach/detach, session management |
| `perception.js` | Accessibility tree snapshots, diff mode, visual metadata, screenshots |
| `actions.js` | High-level action executor (click, type, scroll, drag, fill-form, etc.) |
| `permissions.js` | Per-tab permission rules, "Ask First" approval flow |
| `background.js` | MV3 service worker entry point, message routing, badge management |
| `popup.html/js/css` | Extension popup UI |
| `options.html/js` | Settings page |
| `pkrelay-token-reader` | Legacy native messaging host — reads auth token from OpenClaw config |
| `install.sh` | Installs native messaging host manifests + launchd service |

## Requirements

- [OpenClaw](https://openclaw.com) 2026.3.22 or later
- Chrome or Arc browser (any Chromium-based browser)
- Python 3.8+ (macOS ships with it; Homebrew Python works too)

## Installation

1. Clone this repo:
   ```bash
   git clone https://github.com/PatrickLHT/pkrelay.git
   ```

2. Load the unpacked extension:
   - Open `chrome://extensions` (or `arc://extensions`)
   - Enable **Developer mode**
   - Click **Load unpacked** and select the `pkrelay` directory

3. Install the native messaging host and CDP bridge service:
   ```bash
   cd pkrelay
   ./install.sh
   ```
   This auto-detects your extension ID, installs both native messaging host manifests, and registers a launchd service to keep the CDP server running.

4. Open the extension settings (click gear icon in popup) and set your **Browser Name** (e.g., "Chrome" or "Arc").

5. Verify the CDP server is running:
   ```bash
   curl http://127.0.0.1:18792/json/version
   ```

## OpenClaw Configuration

The OpenClaw config at `~/.openclaw/openclaw.json` should include:

```json
"browser": {
  "enabled": true,
  "profiles": {
    "pkrelay": {
      "cdpUrl": "http://127.0.0.1:18792",
      "attachOnly": true,
      "color": "#4CAF50"
    }
  }
}
```

## Configuration

Open the extension's **Settings** page to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| Browser Name | `Browser` | Identifies this browser to the agent |
| CDP Server Port | `18792` | Port where the CDP bridge listens (match `cdpUrl` in OpenClaw config) |
| Default Browser | unchecked | Mark as the preferred browser |
| Known Browsers | *(empty)* | Comma-separated list for browser switching |

## How It Works

1. **Extension starts** → `background.js` calls `chrome.runtime.connectNative('com.pkrelay.cdp_server')` → Chrome launches `server.py`
2. **server.py starts** → Binds port 18792, serves `/json/version`, `/json/list`, `/json/protocol`
3. **OpenClaw connects** → Fetches `/json/list` → Sees attached tabs as CDP targets → Opens WebSocket to `ws://127.0.0.1:18792/devtools/page/{targetId}`
4. **CDP commands flow** → `server.py` receives command → forwards to `background.js` via native messaging → `background.js` calls `chrome.debugger.sendCommand` → result flows back

## Protocol

PKRelay is compatible with the standard CDP protocol and extends it via the `pkrelay.*` namespace:

| Method | Description |
|--------|-------------|
| `pkrelay.snapshot` | Get accessibility tree snapshot (supports diff mode) |
| `pkrelay.action` | Execute a high-level action (click, type, scroll, etc.) |
| `pkrelay.screenshot` | Capture a screenshot (on-demand only) |
| `pkrelay.tabs` | List available tabs with permission levels |
| `pkrelay.attach` | Attach CDP debugger to a tab |
| `pkrelay.detach` | Detach CDP debugger from a tab |
| `pkrelay.switchBrowser` | Switch display to a different browser |
| `pkrelay.reload` | Reload the extension |

## CDP Discovery Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /json/version` | Browser version metadata |
| `GET /json/list` | Active CDP targets (attached tabs) |
| `GET /json/protocol` | CDP protocol descriptor |
| `GET /health` | Health check |
| `WS /devtools/page/{targetId}` | CDP session for a tab |
| `WS /devtools/browser/{id}` | Browser-level CDP session |

## Connection States

| State | Badge | Description |
|-------|-------|-------------|
| Connected | `ON` (green) | Native messaging port open, server running |
| Connecting | `...` (yellow) | Opening native messaging port |
| Reconnecting | `...` (yellow) | Port lost, retrying |
| Disconnected | `!` (red) | Not connected |
| Ask | `?` (blue) | Tab needs permission approval |

## Troubleshooting

**CDP server not reachable:**
```bash
# Check if server.py is running
curl http://127.0.0.1:18792/health

# Check launchd service status
launchctl list | grep pkrelay

# Check server logs
tail -f ~/Library/Logs/pkrelay-server.log

# Restart the service
launchctl unload ~/Library/LaunchAgents/com.pkrelay.cdp_server.plist
launchctl load ~/Library/LaunchAgents/com.pkrelay.cdp_server.plist
```

**Extension shows "Disconnected":**
- The extension starts `server.py` automatically via native messaging
- If the native host isn't installed, run `./install.sh` and reload the extension
- Check `chrome://extensions` → PKRelay → Inspect service worker → Console for errors

**No tabs in `/json/list`:**
- Attach tabs in the PKRelay popup (click the dot next to each tab)
- Or grant "Full" permission to the domain in the popup

## Migrating from PKRelay v1

v1 connected as a WebSocket client to `ws://127.0.0.1:18792/extension` (the old OpenClaw gateway relay). That endpoint was removed in OpenClaw 2026.3.22.

v2 runs the server itself — no changes needed on the OpenClaw side beyond updating the config to use `cdpUrl`.

**Config changes:**
- Remove `relayToken` from settings (no longer needed)
- The "Relay Port" setting is now "CDP Server Port" (same default: 18792)

## License

[MIT](LICENSE)
