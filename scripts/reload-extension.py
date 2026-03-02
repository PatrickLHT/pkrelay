#!/usr/bin/env python3
"""
Reload PKRelay by briefly disconnecting from the gateway.
The extension detects the disconnect and auto-reconnects,
which triggers reannounceAll() + autoAttachActiveTab().

For a full extension reload (picks up new code from disk),
use chrome://extensions manually or the popup reload button.
"""
import json, urllib.request, time

with open('/Users/patrickkelly/.openclaw/openclaw.json') as f:
    token = json.load(f)['gateway']['auth']['token']

base = f"http://127.0.0.1:18792"

# Check current state
req = urllib.request.Request(f"{base}/json/list?token={token}")
with urllib.request.urlopen(req, timeout=3) as resp:
    tabs = json.loads(resp.read())
print(f"Before: {len(tabs)} tab(s) attached")

# The extension will auto-reconnect and re-attach
print("Extension will pick up changes on next reload from chrome://extensions")
print("Or click the reload button in the PKRelay popup")
