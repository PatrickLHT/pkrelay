#!/usr/bin/env python3
"""
PKRelay CDP Bridge Server

Runs as a Chrome Native Messaging host: Chrome launches this process when the
extension calls chrome.runtime.connectNative('com.pkrelay.cdp_server').
stdin/stdout carry native messages (length-prefixed JSON).

The server binds to port 18792 and bridges:
  OpenClaw → HTTP/WS (port 18792) → server.py → stdin/stdout NM → background.js
             ↑                                                          |
             └──────────── responses + events ←──────────────────────┘

HTTP endpoints:
  GET /json/version      — CDP browser version metadata
  GET /json/list         — CDP target list (attached tabs from extension)
  GET /json/protocol     — Minimal CDP protocol descriptor
  GET /health            — Health check

WebSocket endpoints:
  WS /devtools/page/{targetId}   — CDP session for a specific target
  WS /devtools/browser/{any}     — Browser-level CDP session
"""

import asyncio
import base64
import hashlib
import json
import logging
import os
import struct
import sys
import threading
import time
import uuid
import urllib.parse
from typing import Dict, Optional

# ──────────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────────

DEFAULT_PORT = 18792
LOG_LEVEL = os.environ.get('PKRELAY_LOG', 'INFO').upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format='[PKRelay] %(levelname)s %(message)s',
    stream=sys.stderr
)
log = logging.getLogger('pkrelay.server')

# Global bridge reference (set after asyncio loop starts)
_bridge: Optional['Bridge'] = None
bridge_port = DEFAULT_PORT

# ──────────────────────────────────────────────────────────────────────────────
# Minimal CDP protocol stub
# ──────────────────────────────────────────────────────────────────────────────

CDP_PROTOCOL_STUB = {
    'domains': [
        {
            'domain': 'Target',
            'commands': [
                {'name': 'getTargets'},
                {'name': 'activateTarget'},
                {'name': 'closeTarget'},
                {'name': 'createTarget'},
                {'name': 'attachToTarget'},
                {'name': 'detachFromTarget'},
            ],
            'events': [
                {'name': 'targetCreated'},
                {'name': 'targetDestroyed'},
                {'name': 'attachedToTarget'},
                {'name': 'detachedFromTarget'},
            ]
        },
        {'domain': 'Runtime', 'commands': [], 'events': []},
        {'domain': 'Page', 'commands': [], 'events': []},
        {'domain': 'DOM', 'commands': [], 'events': []},
        {'domain': 'Network', 'commands': [], 'events': []},
        {'domain': 'Input', 'commands': [], 'events': []},
    ]
}

# ──────────────────────────────────────────────────────────────────────────────
# Native messaging helpers (length-prefixed JSON on stdin/stdout)
# ──────────────────────────────────────────────────────────────────────────────

def nm_read_message(stream=None) -> Optional[dict]:
    """Read one native messaging message from stdin (or given stream)."""
    if stream is None:
        stream = sys.stdin.buffer
    raw_len = stream.read(4)
    if len(raw_len) < 4:
        return None
    length = struct.unpack('<I', raw_len)[0]
    data = stream.read(length)
    if len(data) < length:
        return None
    return json.loads(data.decode('utf-8'))


def nm_write_message(msg: dict, stream=None):
    """Write one native messaging message to stdout (or given stream)."""
    if stream is None:
        stream = sys.stdout.buffer
    encoded = json.dumps(msg).encode('utf-8')
    stream.write(struct.pack('<I', len(encoded)))
    stream.write(encoded)
    stream.flush()


def nm_send_threadsafe(bridge: 'Bridge', msg: dict):
    """Send a native message from any thread."""
    try:
        nm_write_message(msg)
    except Exception as exc:
        log.error('NM write error: %s', exc)

# ──────────────────────────────────────────────────────────────────────────────
# Bridge — shared state between the async server and the NM reader thread
# ──────────────────────────────────────────────────────────────────────────────

class Bridge:
    """
    Shared mutable state between the HTTP/WS server and the NM reader thread.

    targets:     dict[targetId -> dict]  — CDP target descriptors from the extension
    session_ws:  dict[sessionId -> RawWebSocket]  — active CDP WS connections
    pending:     dict[nmId -> asyncio.Future]  — in-flight commands awaiting responses
    """

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.targets: Dict[str, dict] = {}
        self.session_ws: Dict[str, 'RawWebSocket'] = {}
        self.pending: Dict[int, asyncio.Future] = {}
        self._nm_id = 0
        self._lock = threading.Lock()

    def next_nm_id(self) -> int:
        with self._lock:
            self._nm_id += 1
            return self._nm_id

    # ── Target registry ───────────────────────────────────────────────────────

    def set_targets(self, targets: list):
        self.targets = {t['targetId']: t for t in targets}
        log.debug('Targets updated: %s', list(self.targets.keys()))

    def get_target_list(self) -> list:
        out = []
        for t in self.targets.values():
            entry = {
                'description': '',
                'devtoolsFrontendUrl': '',
                'id': t['targetId'],
                'title': t.get('title', ''),
                'type': t.get('type', 'page'),
                'url': t.get('url', ''),
                'webSocketDebuggerUrl':
                    f'ws://127.0.0.1:{bridge_port}/devtools/page/{t["targetId"]}'
            }
            out.append(entry)
        return out

    # ── WS session registry ───────────────────────────────────────────────────

    def register_ws(self, session_id: str, ws: 'RawWebSocket'):
        self.session_ws[session_id] = ws

    def unregister_ws(self, session_id: str):
        self.session_ws.pop(session_id, None)

    def find_pk_session_for_target(self, target_id: str) -> Optional[str]:
        """Find the pkSessionId for a target (stored on the target by the extension)."""
        target = self.targets.get(target_id)
        if not target:
            return None
        return target.get('sessionId')

    # ── Pending request tracking ──────────────────────────────────────────────

    def register_pending(self, nm_id: int) -> asyncio.Future:
        fut = self.loop.create_future()
        self.pending[nm_id] = fut
        return fut

    def resolve_pending(self, nm_id: int, result=None, error=None):
        fut = self.pending.pop(nm_id, None)
        if not fut or fut.done():
            return
        if error:
            fut.set_exception(Exception(str(error)))
        else:
            fut.set_result(result)

    # ── Dispatch inbound NM messages from extension ───────────────────────────

    async def dispatch_event(self, msg: dict):
        """
        Route a message from the extension to the appropriate WS client.

        Message types from extension:
          targets      — Update the target list (attached tabs)
          cdpResponse  — Response to a CDP command we forwarded
          cdpEvent     — Unsolicited CDP event (e.g., Page.loadEventFired)
          pong         — Keepalive response
        """
        msg_type = msg.get('type')

        if msg_type == 'targets':
            self.set_targets(msg.get('targets', []))
            return

        if msg_type == 'cdpResponse':
            nm_id = msg.get('nmId')
            if nm_id is not None:
                self.resolve_pending(nm_id, result=msg.get('result'), error=msg.get('error'))
            return

        if msg_type == 'cdpEvent':
            session_id = msg.get('sessionId')
            method = msg.get('method', '')
            params = msg.get('params', {})
            event_json = json.dumps({'method': method, 'params': params})

            if session_id:
                ws = self.session_ws.get(session_id)
                if ws:
                    await ws.send(event_json)
                    return
            # Broadcast to all connected WS clients
            for ws in list(self.session_ws.values()):
                await ws.send(event_json)
            return

        if msg_type == 'pong':
            return  # keepalive

        log.debug('Unknown NM message type: %s', msg_type)


# ──────────────────────────────────────────────────────────────────────────────
# Native messaging reader thread
# ──────────────────────────────────────────────────────────────────────────────

def nm_reader_thread(bridge: Bridge):
    """Blocking loop that reads native messages from stdin."""
    log.info('NM reader thread started')
    while True:
        try:
            msg = nm_read_message()
            if msg is None:
                log.info('NM stdin EOF — extension disconnected')
                break
            log.debug('NM recv: %s', str(msg)[:200])
            asyncio.run_coroutine_threadsafe(bridge.dispatch_event(msg), bridge.loop)
        except Exception as exc:
            log.error('NM reader error: %s', exc)
            break

    # Clear targets on extension disconnect
    async def _clear():
        bridge.set_targets([])
    asyncio.run_coroutine_threadsafe(_clear(), bridge.loop)


# ──────────────────────────────────────────────────────────────────────────────
# Raw WebSocket implementation (no external deps)
# ──────────────────────────────────────────────────────────────────────────────

class RawWebSocket:
    """Minimal WebSocket over raw asyncio streams — no external dependencies."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter,
                 path: str, bridge: Bridge):
        self.reader = reader
        self.writer = writer
        self.path = path
        self.bridge = bridge
        self._closed = False

    async def send(self, data: str):
        """Send a text frame."""
        if self._closed:
            return
        payload = data.encode('utf-8')
        length = len(payload)
        header = bytearray()
        header.append(0x81)  # FIN + text opcode
        if length < 126:
            header.append(length)
        elif length < 65536:
            header.append(126)
            header += length.to_bytes(2, 'big')
        else:
            header.append(127)
            header += length.to_bytes(8, 'big')
        try:
            self.writer.write(bytes(header) + payload)
            await self.writer.drain()
        except Exception as exc:
            log.debug('WS send error: %s', exc)
            self._closed = True

    async def recv(self) -> Optional[str]:
        """Receive one text or binary frame, handling control frames."""
        while True:
            try:
                b0 = (await self.reader.readexactly(1))[0]
                b1 = (await self.reader.readexactly(1))[0]
            except Exception:
                self._closed = True
                return None

            opcode = b0 & 0x0F
            masked = b1 & 0x80
            length = b1 & 0x7F

            if opcode == 0x8:  # Close
                self._closed = True
                return None
            if opcode == 0x9:  # Ping — send pong
                self.writer.write(b'\x8A\x00')
                try:
                    await self.writer.drain()
                except Exception:
                    pass
                continue
            if opcode == 0xA:  # Pong — ignore
                continue

            if length == 126:
                length = int.from_bytes(await self.reader.readexactly(2), 'big')
            elif length == 127:
                length = int.from_bytes(await self.reader.readexactly(8), 'big')

            mask_key = b''
            if masked:
                mask_key = await self.reader.readexactly(4)

            payload = bytearray(await self.reader.readexactly(length))
            if masked:
                for i in range(length):
                    payload[i] ^= mask_key[i % 4]

            if opcode in (0x1, 0x2, 0x0):
                return payload.decode('utf-8', errors='replace')

    async def run_session(self, pk_session_id: str, target_id: Optional[str], is_browser: bool):
        """Main CDP command loop for this WebSocket connection."""
        bridge = self.bridge

        while not self._closed:
            raw = await self.recv()
            if raw is None:
                break

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning('Invalid JSON from WS: %s', raw[:100])
                continue

            cmd_id = msg.get('id')
            method = msg.get('method', '')
            params = msg.get('params', {})
            session_id = msg.get('sessionId')  # CDP flat session multiplexing

            log.debug('CDP cmd: id=%s method=%s', cmd_id, method)

            # ── Local handling: Target.getTargets ─────────────────────────────
            if method == 'Target.getTargets':
                target_infos = [{
                    'targetId': t['id'],
                    'type': t['type'],
                    'title': t['title'],
                    'url': t['url'],
                    'attached': True,
                    'canAccessOpener': False
                } for t in bridge.get_target_list()]
                await self.send(json.dumps({
                    'id': cmd_id,
                    'result': {'targetInfos': target_infos}
                }))
                continue

            # ── Local handling: Target.attachToTarget ─────────────────────────
            if method == 'Target.attachToTarget':
                attach_tid = (params or {}).get('targetId', target_id)
                new_session = bridge.find_pk_session_for_target(attach_tid) if attach_tid else None
                if not new_session:
                    new_session = f'cdp-{attach_tid}-{int(time.time() * 1000)}'
                bridge.register_ws(new_session, self)
                target = bridge.targets.get(attach_tid, {})
                await self.send(json.dumps({'id': cmd_id, 'result': {'sessionId': new_session}}))
                await self.send(json.dumps({
                    'method': 'Target.attachedToTarget',
                    'params': {
                        'sessionId': new_session,
                        'targetInfo': {
                            'targetId': attach_tid,
                            'type': target.get('type', 'page'),
                            'title': target.get('title', ''),
                            'url': target.get('url', ''),
                            'attached': True,
                            'canAccessOpener': False
                        },
                        'waitingForDebugger': False
                    }
                }))
                continue

            # ── Forward all other commands to extension via NM ────────────────
            nm_id = bridge.next_nm_id()
            fut = bridge.register_pending(nm_id)
            effective_session = session_id or pk_session_id

            nm_send_threadsafe(bridge, {
                'type': 'cdpCommand',
                'nmId': nm_id,
                'wsId': cmd_id,
                'sessionId': effective_session,
                'targetId': target_id,
                'method': method,
                'params': params or {}
            })

            try:
                result = await asyncio.wait_for(fut, timeout=15.0)
                await self.send(json.dumps({'id': cmd_id, 'result': result or {}}))
            except asyncio.TimeoutError:
                log.warning('Timeout: %s id=%s', method, cmd_id)
                await self.send(json.dumps({
                    'id': cmd_id,
                    'error': {'code': -32001, 'message': f'Timeout: {method}'}
                }))
            except Exception as exc:
                await self.send(json.dumps({
                    'id': cmd_id,
                    'error': {'code': -32000, 'message': str(exc)}
                }))


# ──────────────────────────────────────────────────────────────────────────────
# CDP Server — HTTP + WebSocket on a single port (no external deps)
# ──────────────────────────────────────────────────────────────────────────────

class CDPServer:
    """
    Single-port CDP server.
    HTTP GET requests → CDP discovery (json/version, json/list, etc.)
    WebSocket upgrades → CDP sessions (/devtools/page/{targetId}, etc.)
    """

    def __init__(self, bridge: Bridge, host: str, port: int):
        self.bridge = bridge
        self.host = host
        self.port = port
        self._server = None

    async def start(self):
        self._server = await asyncio.start_server(
            self._handle_connection, self.host, self.port
        )
        log.info('CDP server listening on %s:%d', self.host, self.port)

    async def _handle_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            headers_raw = b''
            while b'\r\n\r\n' not in headers_raw:
                chunk = await asyncio.wait_for(reader.read(4096), timeout=5.0)
                if not chunk:
                    return
                headers_raw += chunk
                if len(headers_raw) > 65536:
                    return

            header_section, _, _ = headers_raw.partition(b'\r\n\r\n')
            lines = header_section.decode('utf-8', errors='replace').split('\r\n')
            request_line = lines[0]
            headers = {}
            for line in lines[1:]:
                if ':' in line:
                    key, _, val = line.partition(':')
                    headers[key.strip().lower()] = val.strip()

            parts = request_line.split(' ', 2)
            method = parts[0] if parts else 'GET'
            path = parts[1] if len(parts) > 1 else '/'

            # WebSocket upgrade?
            if (headers.get('upgrade', '').lower() == 'websocket' and
                    'upgrade' in headers.get('connection', '').lower()):
                await self._handle_websocket(reader, writer, path, headers)
            else:
                await self._handle_http(writer, method, path)

        except asyncio.TimeoutError:
            pass
        except Exception as exc:
            log.debug('Connection error: %s', exc)
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _handle_http(self, writer: asyncio.StreamWriter, method: str, path: str):
        parsed_path = urllib.parse.urlparse(path).path

        if parsed_path in ('/json/version', '/json/version/'):
            body = json.dumps({
                'Browser': 'PKRelay/2.0.0',
                'Protocol-Version': '1.3',
                'User-Agent': 'PKRelay CDP Bridge 2.0.0',
                'V8-Version': '',
                'WebKit-Version': '',
                'webSocketDebuggerUrl': f'ws://127.0.0.1:{bridge_port}/devtools/browser/pkrelay'
            }).encode()
        elif parsed_path in ('/json', '/json/', '/json/list', '/json/list/'):
            body = json.dumps(self.bridge.get_target_list()).encode()
        elif parsed_path in ('/json/protocol', '/json/protocol/'):
            body = json.dumps(CDP_PROTOCOL_STUB).encode()
        elif parsed_path in ('/', '/health'):
            body = json.dumps({
                'status': 'ok',
                'server': 'pkrelay-cdp-bridge',
                'version': '2.0.0',
                'targets': len(self.bridge.targets)
            }).encode()
        else:
            writer.write(b'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            await writer.drain()
            return

        response = (
            f'HTTP/1.1 200 OK\r\n'
            f'Content-Type: application/json\r\n'
            f'Content-Length: {len(body)}\r\n'
            f'Access-Control-Allow-Origin: *\r\n'
            f'Connection: close\r\n'
            f'\r\n'
        ).encode() + body
        writer.write(response)
        await writer.drain()

    async def _handle_websocket(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        path: str,
        headers: dict
    ):
        # WebSocket handshake
        ws_key = headers.get('sec-websocket-key', '')
        if not ws_key:
            writer.write(b'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')
            await writer.drain()
            return

        magic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
        accept = base64.b64encode(
            hashlib.sha1((ws_key + magic).encode()).digest()
        ).decode()

        writer.write((
            'HTTP/1.1 101 Switching Protocols\r\n'
            'Upgrade: websocket\r\n'
            'Connection: Upgrade\r\n'
            f'Sec-WebSocket-Accept: {accept}\r\n'
            '\r\n'
        ).encode())
        await writer.drain()

        # Determine session/target IDs from path
        parts = path.strip('/').split('/')
        is_browser = len(parts) >= 2 and parts[1] == 'browser'
        target_id = parts[2] if len(parts) >= 3 else None

        pk_session_id = None
        if target_id and not is_browser:
            pk_session_id = self.bridge.find_pk_session_for_target(target_id)
        if not pk_session_id:
            pk_session_id = target_id or f'browser-{uuid.uuid4().hex[:8]}'

        ws = RawWebSocket(reader, writer, path, self.bridge)
        self.bridge.register_ws(pk_session_id, ws)

        log.info('WS session started: path=%s session=%s', path, pk_session_id)

        # Notify extension: CDP client connected
        nm_send_threadsafe(self.bridge, {
            'type': 'cdpClientConnected',
            'sessionId': pk_session_id,
            'targetId': target_id,
            'isBrowserSession': is_browser
        })

        try:
            await ws.run_session(pk_session_id, target_id, is_browser)
        finally:
            self.bridge.unregister_ws(pk_session_id)
            nm_send_threadsafe(self.bridge, {
                'type': 'cdpClientDisconnected',
                'sessionId': pk_session_id,
                'targetId': target_id
            })
            log.info('WS session ended: %s', path)


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

async def run():
    global _bridge, bridge_port

    port = int(os.environ.get('PKRELAY_PORT', DEFAULT_PORT))
    host = os.environ.get('PKRELAY_HOST', '127.0.0.1')
    standalone = os.environ.get('PKRELAY_STANDALONE', '').lower() in ('1', 'true', 'yes')
    bridge_port = port

    loop = asyncio.get_event_loop()
    bridge = Bridge(loop)
    _bridge = bridge

    # Detect standalone mode: stdin is a TTY or PKRELAY_STANDALONE is set
    # (launchd launches with /dev/null as stdin, which is not a TTY but reads EOF immediately)
    if standalone or (not hasattr(sys.stdin, 'buffer') or not sys.stdin.buffer.readable()):
        standalone = True
        log.info('Running in standalone mode (no extension connected)')
    else:
        # Start NM reader thread (reads commands from extension via stdin)
        nm_thread = threading.Thread(
            target=nm_reader_thread,
            args=(bridge,),
            daemon=True,
            name='pkrelay-nm-reader'
        )
        nm_thread.start()

        # Signal extension that we're ready
        nm_send_threadsafe(bridge, {'type': 'serverStarted', 'port': port})

    # Start CDP server (HTTP + WS on same port)
    server = CDPServer(bridge, host, port)
    try:
        await server.start()
    except OSError as exc:
        log.error('Failed to bind port %d: %s', port, exc)
        if not standalone:
            nm_send_threadsafe(bridge, {'type': 'serverError', 'error': str(exc)})
        sys.exit(1)

    log.info('PKRelay CDP bridge ready on %s:%d%s', host, port,
             ' (standalone)' if standalone else ' (extension-connected)')

    try:
        if standalone:
            # In standalone mode, run forever (launchd keeps us alive)
            while True:
                await asyncio.sleep(60.0)
        else:
            # Run until the NM thread exits (stdin closes = extension disconnected)
            while nm_thread.is_alive():
                await asyncio.sleep(1.0)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass

    log.info('PKRelay CDP bridge shutting down')


if __name__ == '__main__':
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
