#!/bin/bash
# install.sh — Install PKRelay native messaging hosts and CDP bridge server
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOKEN_READER_PATH="$SCRIPT_DIR/pkrelay-token-reader"
SERVER_PATH="$SCRIPT_DIR/server.py"
TOKEN_HOST_NAME="com.pkrelay.token_reader"
CDP_HOST_NAME="com.pkrelay.cdp_server"
LAUNCHD_LABEL="com.pkrelay.cdp_server"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"

# Ensure executables are executable
chmod +x "$TOKEN_READER_PATH"
chmod +x "$SERVER_PATH"

# Detect extension ID from Secure Preferences (unpacked extensions stored there)
detect_id() {
    python3 -c "
import json, sys
try:
    with open('$1') as f:
        prefs = json.load(f)
    exts = prefs.get('extensions', {}).get('settings', {})
    for eid, info in exts.items():
        if 'pkrelay' in info.get('path', '').lower():
            print(eid)
            sys.exit(0)
except: pass
" 2>/dev/null
}

install_hosts() {
    local browser_name="$1"
    local host_dir="$2"
    local ext_id="$3"

    if [ -z "$ext_id" ]; then
        echo "  $browser_name: PKRelay not found, skipping"
        return
    fi

    mkdir -p "$host_dir"

    # Install token reader host (legacy, for config reading)
    cat > "$host_dir/$TOKEN_HOST_NAME.json" << EOF
{
  "name": "$TOKEN_HOST_NAME",
  "description": "PKRelay Config Reader",
  "path": "$TOKEN_READER_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ext_id/"]
}
EOF

    # Install CDP bridge server host
    cat > "$host_dir/$CDP_HOST_NAME.json" << EOF
{
  "name": "$CDP_HOST_NAME",
  "description": "PKRelay CDP Bridge Server",
  "path": "$SERVER_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ext_id/"]
}
EOF

    echo "  $browser_name: installed (extension ID: $ext_id)"
}

echo "Installing PKRelay native messaging hosts..."
echo ""

# Chrome
CHROME_PREFS="$HOME/Library/Application Support/Google/Chrome/Default/Secure Preferences"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
CHROME_ID=$(detect_id "$CHROME_PREFS")
install_hosts "Chrome" "$CHROME_DIR" "$CHROME_ID"

# Arc
ARC_PREFS="$HOME/Library/Application Support/Arc/User Data/Default/Secure Preferences"
ARC_DIR="$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
ARC_ID=$(detect_id "$ARC_PREFS")
install_hosts "Arc" "$ARC_DIR" "$ARC_ID"

echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Install launchd service for the CDP bridge server
# (Keeps server.py running independently for headless scenarios.
#  NOTE: When the extension is running, it launches server.py automatically
#  via native messaging. The launchd service is optional but ensures the
#  /json/* endpoints are always available even before a browser connects.)
# ─────────────────────────────────────────────────────────────────────────────

echo "Installing launchd service for CDP bridge..."

# Unload existing service if present
launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true

cat > "$LAUNCHD_PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>${SERVER_PATH}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PKRELAY_PORT</key>
    <string>18792</string>
    <key>PKRELAY_STANDALONE</key>
    <string>1</string>
    <key>PKRELAY_LOG</key>
    <string>INFO</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/pkrelay-server.log</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>WorkingDirectory</key>
  <string>${SCRIPT_DIR}</string>
</dict>
</plist>
EOF

# Load the service
launchctl load "$LAUNCHD_PLIST" 2>/dev/null || true
echo "  launchd service installed: $LAUNCHD_LABEL"
echo "  logs: ~/Library/Logs/pkrelay-server.log"
echo ""
echo "Done."
echo ""
echo "Next steps:"
echo "  1. Load/reload PKRelay in each browser (chrome://extensions → Update)"
echo "  2. Open PKRelay options and set your Browser Name"
echo "  3. Click the PKRelay icon to manage tab permissions"
echo "  4. Verify: curl http://127.0.0.1:18792/json/version"
