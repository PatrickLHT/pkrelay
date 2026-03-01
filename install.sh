#!/bin/bash
# install.sh — Install PKRelay native messaging host for Chrome and Arc
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/pkrelay-token-reader"
HOST_NAME="com.pkrelay.token_reader"

chmod +x "$HOST_PATH"

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

install_host() {
    local browser_name="$1"
    local host_dir="$2"
    local ext_id="$3"

    if [ -z "$ext_id" ]; then
        echo "  $browser_name: PKRelay not found, skipping"
        return
    fi

    mkdir -p "$host_dir"
    cat > "$host_dir/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "PKRelay OpenClaw Token Reader",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ext_id/"]
}
EOF
    echo "  $browser_name: installed (extension ID: $ext_id)"
}

echo "Installing PKRelay native messaging host..."
echo ""

# Chrome
CHROME_PREFS="$HOME/Library/Application Support/Google/Chrome/Default/Secure Preferences"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
CHROME_ID=$(detect_id "$CHROME_PREFS")
install_host "Chrome" "$CHROME_DIR" "$CHROME_ID"

# Arc
ARC_PREFS="$HOME/Library/Application Support/Arc/User Data/Default/Secure Preferences"
ARC_DIR="$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
ARC_ID=$(detect_id "$ARC_PREFS")
install_host "Arc" "$ARC_DIR" "$ARC_ID"

echo ""
echo "Done. Reload PKRelay in each browser (click Update in popup)."
echo "The token and port will be auto-read from ~/.openclaw/openclaw.json."
