#!/opt/homebrew/bin/python3
"""
PKRelay CLI — Direct interface to the PKRelay CDP bridge server.

Usage:
  pkrelay tabs                         — List attached tabs
  pkrelay snapshot [TAB_INDEX]         — AX tree snapshot (default: first tab)
  pkrelay snapshot --diff [TAB_INDEX]  — Diff since last snapshot
  pkrelay click INDEX                  — Click element #INDEX
  pkrelay type INDEX "text"            — Type text into element #INDEX
  pkrelay fill INDEX1=val1 INDEX2=val2 — Fill multiple form fields
  pkrelay scroll [INDEX] down 300      — Scroll (element or page)
  pkrelay navigate URL                 — Navigate current tab
  pkrelay screenshot [TAB_INDEX]       — Take screenshot (base64 PNG)
  pkrelay status                       — Server health check
  pkrelay action CMD [PARAMS...]       — Raw action command

Environment:
  PKRELAY_PORT  — CDP server port (default: 18792)
"""

import asyncio
import json
import os
import sys
import urllib.request
import urllib.error

PORT = int(os.environ.get('PKRELAY_PORT', '18792'))
BASE = f'http://127.0.0.1:{PORT}'


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def http_get(path):
    try:
        with urllib.request.urlopen(f'{BASE}{path}', timeout=5) as r:
            return json.loads(r.read())
    except urllib.error.URLError as e:
        print(f'Error: Cannot reach PKRelay server at {BASE} — {e.reason}', file=sys.stderr)
        sys.exit(1)


def get_tabs():
    return http_get('/json/list')


def get_status():
    return http_get('/health')


# ── WebSocket helpers (raw, no deps) ─────────────────────────────────────────

async def ws_command(ws_url, method, params=None):
    """Connect to a CDP WebSocket, send one command, return the result."""
    import hashlib, base64, struct, socket, ssl

    parsed = urllib.parse.urlparse(ws_url)
    host = parsed.hostname
    port = parsed.port or 80

    sock = socket.create_connection((host, port), timeout=10)

    # WebSocket handshake
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f'GET {parsed.path} HTTP/1.1\r\n'
        f'Host: {host}:{port}\r\n'
        f'Connection: Upgrade\r\n'
        f'Upgrade: websocket\r\n'
        f'Sec-WebSocket-Version: 13\r\n'
        f'Sec-WebSocket-Key: {key}\r\n'
        f'\r\n'
    ).encode()
    sock.sendall(request)

    # Read upgrade response
    response = b''
    while b'\r\n\r\n' not in response:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError('Server closed during handshake')
        response += chunk

    if b'101' not in response.split(b'\r\n')[0]:
        raise ConnectionError(f'WebSocket upgrade failed: {response[:200]}')

    def ws_send(data_str):
        payload = data_str.encode('utf-8')
        length = len(payload)
        mask_key = os.urandom(4)
        header = bytearray()
        header.append(0x81)  # FIN + text
        if length < 126:
            header.append(0x80 | length)  # masked
        elif length < 65536:
            header.append(0x80 | 126)
            header += length.to_bytes(2, 'big')
        else:
            header.append(0x80 | 127)
            header += length.to_bytes(8, 'big')
        header += mask_key
        masked = bytearray(b ^ mask_key[i % 4] for i, b in enumerate(payload))
        sock.sendall(bytes(header) + bytes(masked))

    def ws_recv():
        # Read frame header
        hdr = sock.recv(2)
        if len(hdr) < 2:
            return None
        opcode = hdr[0] & 0x0f
        length = hdr[1] & 0x7f
        if length == 126:
            length = int.from_bytes(sock.recv(2), 'big')
        elif length == 127:
            length = int.from_bytes(sock.recv(8), 'big')

        data = bytearray()
        while len(data) < length:
            chunk = sock.recv(length - len(data))
            if not chunk:
                break
            data += chunk

        if opcode in (0x1, 0x2):
            return data.decode('utf-8', errors='replace')
        return None

    # Send command
    msg = json.dumps({'id': 1, 'method': method, 'params': params or {}})
    ws_send(msg)

    # Collect responses (skip events, wait for id=1 response)
    result = None
    for _ in range(20):  # max 20 frames
        raw = ws_recv()
        if raw is None:
            break
        parsed_msg = json.loads(raw)
        if parsed_msg.get('id') == 1:
            result = parsed_msg
            break

    # Close
    sock.sendall(b'\x88\x82' + os.urandom(4))  # masked close frame
    sock.close()

    return result


async def pkrelay_command(tab_ws_url, method, params=None):
    """Send a pkrelay.* command via the tab's WS connection."""
    return await ws_command(tab_ws_url, method, params)


# ── Tab resolution ────────────────────────────────────────────────────────────

def resolve_tab(tabs, index=None):
    if not tabs:
        print('No attached tabs. Attach a tab in Chrome using the PKRelay extension.', file=sys.stderr)
        sys.exit(1)
    if index is None:
        return tabs[0]
    if index < 0 or index >= len(tabs):
        print(f'Tab index {index} out of range (0-{len(tabs)-1})', file=sys.stderr)
        sys.exit(1)
    return tabs[index]


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_status():
    status = get_status()
    print(json.dumps(status, indent=2))


def cmd_tabs():
    tabs = get_tabs()
    if not tabs:
        print('No attached tabs.')
        return
    for i, t in enumerate(tabs):
        print(f'  [{i}] {t["title"][:60]}')
        print(f'      {t["url"]}')
        print(f'      id={t["id"]}')


def cmd_snapshot(args):
    tabs = get_tabs()
    diff = '--diff' in args
    args = [a for a in args if a != '--diff']
    tab_idx = int(args[0]) if args else None
    tab = resolve_tab(tabs, tab_idx)

    result = asyncio.run(pkrelay_command(
        tab['webSocketDebuggerUrl'],
        'pkrelay.snapshot',
        {'tabTarget': None, 'diff': diff}  # tabTarget=None → first attached tab
    ))

    if not result:
        print('Error: No response from server', file=sys.stderr)
        sys.exit(1)

    if result.get('error'):
        print(f'Error: {result["error"]}', file=sys.stderr)
        sys.exit(1)

    content = result.get('result', {}).get('content', {})
    snap_type = result.get('result', {}).get('type', 'full')

    if snap_type == 'diff':
        changes = content.get('changes', [])
        if not changes:
            print('[No changes since last snapshot]')
        else:
            print(f'[{content.get("changeCount", len(changes))} changes]')
            for line in changes:
                print(line)
    else:
        lines = content.get('lines', [])
        for line in lines:
            print(line)
        stats = f'{content.get("elementCount", 0)} elements, {content.get("interactiveCount", 0)} interactive'
        print(f'\n--- {stats} ---')


def cmd_action(command, params):
    tabs = get_tabs()
    tab = resolve_tab(tabs)

    result = asyncio.run(pkrelay_command(
        tab['webSocketDebuggerUrl'],
        'pkrelay.action',
        {'tabTarget': None, 'action': {'command': command, 'params': params}}
    ))

    if not result:
        print('Error: No response from server', file=sys.stderr)
        sys.exit(1)

    if result.get('error'):
        print(f'Error: {result["error"]}', file=sys.stderr)
        sys.exit(1)

    r = result.get('result', {})
    print(f'OK: {r.get("action", command)}')

    # Print auto-diff if present
    snapshot = r.get('snapshot')
    if snapshot and snapshot.get('content'):
        content = snapshot['content']
        if snapshot.get('type') == 'diff':
            changes = content.get('changes', [])
            if changes:
                print(f'\n[{len(changes)} changes after action]')
                for line in changes:
                    print(f'  {line}')


def cmd_click(args):
    if not args:
        print('Usage: pkrelay click INDEX', file=sys.stderr)
        sys.exit(1)
    cmd_action('click', {'elementIndex': int(args[0])})


def cmd_type(args):
    if len(args) < 2:
        print('Usage: pkrelay type INDEX "text"', file=sys.stderr)
        sys.exit(1)
    cmd_action('type', {'elementIndex': int(args[0]), 'text': args[1]})


def cmd_fill(args):
    if not args:
        print('Usage: pkrelay fill INDEX1=val1 INDEX2=val2 ...', file=sys.stderr)
        sys.exit(1)
    fields = {}
    for arg in args:
        idx, _, val = arg.partition('=')
        fields[idx] = val
    cmd_action('fill-form', {'fields': fields})


def cmd_scroll(args):
    elem_idx = None
    direction = 'down'
    amount = 300

    remaining = list(args)
    if remaining and remaining[0].isdigit():
        elem_idx = int(remaining.pop(0))
    if remaining:
        direction = remaining.pop(0)
    if remaining:
        amount = int(remaining.pop(0))

    params = {'direction': direction, 'amount': amount}
    if elem_idx is not None:
        params['elementIndex'] = elem_idx
    cmd_action('scroll', params)


def cmd_navigate(args):
    if not args:
        print('Usage: pkrelay navigate URL', file=sys.stderr)
        sys.exit(1)
    cmd_action('navigate', {'url': args[0]})


def cmd_screenshot(args):
    tabs = get_tabs()
    tab_idx = int(args[0]) if args else None
    tab = resolve_tab(tabs, tab_idx)

    result = asyncio.run(pkrelay_command(
        tab['webSocketDebuggerUrl'],
        'pkrelay.screenshot',
        {'tabTarget': None, 'format': 'png'}
    ))

    if not result:
        print('Error: No response', file=sys.stderr)
        sys.exit(1)

    if result.get('error'):
        print(f'Error: {result["error"]}', file=sys.stderr)
        sys.exit(1)

    data = result.get('result', {}).get('data', '')
    if data:
        # Write to file
        import base64
        outfile = '/tmp/pkrelay-screenshot.png'
        with open(outfile, 'wb') as f:
            f.write(base64.b64decode(data))
        print(f'Screenshot saved: {outfile}')
    else:
        print('No screenshot data returned')


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    import urllib.parse

    if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help', 'help'):
        print(__doc__.strip())
        sys.exit(0)

    cmd = sys.argv[1]
    args = sys.argv[2:]

    commands = {
        'status': lambda: cmd_status(),
        'tabs': lambda: cmd_tabs(),
        'snapshot': lambda: cmd_snapshot(args),
        'click': lambda: cmd_click(args),
        'type': lambda: cmd_type(args),
        'fill': lambda: cmd_fill(args),
        'scroll': lambda: cmd_scroll(args),
        'navigate': lambda: cmd_navigate(args),
        'screenshot': lambda: cmd_screenshot(args),
    }

    if cmd in commands:
        commands[cmd]()
    else:
        # Try as raw action
        params = {}
        for a in args:
            if '=' in a:
                k, _, v = a.partition('=')
                try:
                    v = int(v)
                except ValueError:
                    pass
                params[k] = v
        cmd_action(cmd, params)


if __name__ == '__main__':
    main()
