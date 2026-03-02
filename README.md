# PKRelay

Token-efficient browser relay for AI agent interaction. Drop-in replacement for the stock [OpenClaw](https://openclaw.com) Browser Relay with structured perception, high-level actions, and multi-browser support.

## Features

- **Structured perception** — Accessibility tree snapshots instead of screenshots (~95-99% token reduction)
- **High-level actions** — `click #7`, `fill-form`, `drag #3 to #5` instead of raw CDP commands
- **Multi-browser hot-swap** — Switch between Chrome and Arc with one gateway slot
- **Per-tab permissions** — Full / Ask First / No Access per URL pattern
- **Auto auth token** — Reads gateway token via native messaging (no manual paste)
- **Contention detection** — Browsers enter standby instead of fighting for the slot
- **Auto-reconnect** — Keepalive pings, exponential backoff, alarm-based persistence

## Requirements

- [OpenClaw](https://openclaw.com) gateway running locally
- Chrome or Arc browser (any Chromium-based browser should work)
- Python 3 (for the native messaging host)

## Installation

1. Clone this repo:
   ```bash
   git clone https://github.com/PatrickLHT/pkrelay.git
   ```

2. Load the unpacked extension:
   - Open `chrome://extensions` (or `arc://extensions`)
   - Enable **Developer mode**
   - Click **Load unpacked** and select the `pkrelay` directory

3. Set up native messaging (auto-reads auth token):
   ```bash
   cd pkrelay
   ./install.sh
   ```
   This auto-detects your extension ID and installs the native messaging host manifest for Chrome and/or Arc.

4. Open the extension settings (click gear icon in popup) and set your **Browser Name** (e.g., "Chrome" or "Arc").

5. The extension auto-connects to the gateway on port `18792`.

## Configuration

Open the extension's **Settings** page to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| Browser Name | `Browser` | Identifies this browser to the agent |
| Relay Port | `18792` | OpenClaw extension relay port |
| Relay Auth Token | *(auto-read)* | Manual override; auto-read from `~/.openclaw/openclaw.json` if blank |
| Default Browser | unchecked | Gets more retry attempts before yielding the slot |
| Known Browsers | *(empty)* | Comma-separated list for the browser switcher dropdown |

## Multi-Browser Setup

To use PKRelay across multiple browsers:

1. Install the extension in both Chrome and Arc
2. Run `./install.sh` (detects both browsers automatically)
3. Set a unique **Browser Name** in each browser's settings (e.g., "Chrome", "Arc")
4. Add both names to **Known Browsers** in each browser
5. Mark one as **Default Browser**
6. Use the **Switch Browser** dropdown in the connected browser's popup to hand off the slot

The non-active browser enters standby and displays "Another browser has the slot". It will automatically reconnect when the slot becomes available.

## Architecture

| Module | Purpose |
|--------|---------|
| `relay.js` | WebSocket connection, keepalive, reconnect, contention detection, browser hot-swap |
| `tabs.js` | Tab lifecycle, CDP debugger attach/detach, session management |
| `perception.js` | Accessibility tree snapshots, diff mode, visual metadata, screenshots |
| `actions.js` | High-level action executor (click, type, scroll, drag, fill-form, etc.) |
| `permissions.js` | Per-tab permission rules, "Ask First" approval flow |
| `background.js` | MV3 service worker entry point, message routing, badge management |
| `popup.html/js/css` | Extension popup UI |
| `options.html/js` | Settings page |
| `pkrelay-token-reader` | Native messaging host — reads auth token from OpenClaw config |
| `install.sh` | Installs native messaging host manifests for Chrome and Arc |

## Protocol

PKRelay is compatible with the OpenClaw gateway relay protocol and extends it via the `pkrelay.*` namespace:

| Method | Description |
|--------|-------------|
| `pkrelay.snapshot` | Get accessibility tree snapshot (supports diff mode) |
| `pkrelay.action` | Execute a high-level action (click, type, scroll, etc.) |
| `pkrelay.screenshot` | Capture a screenshot (on-demand only) |
| `pkrelay.tabs` | List available tabs with permission levels |
| `pkrelay.attach` | Attach CDP debugger to a tab |
| `pkrelay.detach` | Detach CDP debugger from a tab |
| `pkrelay.switchBrowser` | Hot-swap to a different browser |

## Connection States

| State | Badge | Description |
|-------|-------|-------------|
| Connected | `ON` (green) | Ready for commands |
| Connecting | `...` (yellow) | Connecting to gateway |
| Reconnecting | `...` (yellow) | Connection lost, retrying |
| Disconnected | `!` (red) | Not connected |
| Standby | `SB` (purple) | Another browser has the slot |
| Ask | `?` (blue) | Tab needs permission approval |

## License

[MIT](LICENSE)
