# PKRelay — Persistent Memory

> Read this first every session for core identity and context.

## Project Overview

- **Project:** PKRelay
- **Repo Root:** `/Users/patrickkelly/pkrelay`
- **Purpose:** Token-efficient browser relay for AI agent interaction; drop-in replacement for the stock OpenClaw Browser Relay
- **OpenClaw Session Key:** `project:pkrelay:main`
- **Runtime:** Chrome/Arc MV3 extension + Python native messaging host + local OpenClaw gateway

## Core Product Facts

- Structured perception uses accessibility tree snapshots instead of screenshots for major token reduction.
- High-level actions are exposed through the `pkrelay.*` protocol namespace.
- The extension supports multi-browser hot-swap across Chrome and Arc.
- Per-tab permissions are first-class: `full`, `ask`, `none`.
- Auth token is auto-read from `~/.openclaw/openclaw.json` through the native messaging host.
- The relay connects to the extension relay port `18792` by default.

## Architecture

### Key Modules

- `background.js`
  - MV3 service worker entry point.
  - Wires together relay connection, tab manager, permission manager, perception engine, and action executor.
  - Owns badge state and runtime message flow.
- `relay.js`
  - WebSocket lifecycle, keepalive, reconnect, contention detection, standby, fast retry, and browser handoff behavior.
- `tabs.js`
  - Tab lifecycle, debugger attach/detach, CDP session handling.
- `perception.js`
  - Accessibility snapshots, diff mode, screenshots, visual metadata.
- `actions.js`
  - High-level action execution (`click`, `type`, `scroll`, `drag`, `fill-form`, etc.).
- `permissions.js`
  - URL-pattern permission model and Ask First flow.
- `popup.*`
  - Operator-facing status and controls.
- `options.*`
  - Settings UI for browser identity, relay port, token override, known browsers, default browser.
- `pkrelay-token-reader`
  - Native messaging host that reads OpenClaw config and can pull repo updates.
- `install.sh`
  - Installs the native messaging host manifest for Chrome and Arc.
- `scripts/reload-extension.py`
  - Local development helper for reloading the extension.

## Important Constraints

- This is a browser extension project, so many changes require browser reload/retest, not just static inspection.
- `manifest.json` permissions and host permissions are security-sensitive.
- Native messaging behavior must stay aligned with `~/.openclaw/openclaw.json` structure.
- Multi-browser slot ownership and standby behavior are core product guarantees; do not casually simplify them.
- Badge state, attach/detach semantics, and Ask First permission flow are user-facing behavior.

## Development Rules

- Read `README.md` and `./.clawdbot/AGENT_CONTEXT.md` before implementation work.
- Prefer preserving protocol compatibility over clever refactors.
- Avoid widening browser permissions unless clearly required.
- Treat reconnect logic, contention handling, and permission gating as high-risk areas.
- Keep behavior explicit and debuggable; hidden relay state is expensive to diagnose.

## Manual Verification Expectations

When behavior changes, verify as many of these as relevant:

1. Extension loads successfully in Chrome/Arc.
2. Popup opens and reflects connection state correctly.
3. Relay connects to the local OpenClaw gateway.
4. Token auto-read still works through native messaging.
5. Attach/detach flow works on a real tab.
6. Ask First permission flow still works.
7. Multi-browser handoff/standby behavior still works if touched.
8. Snapshot/action protocol responses still behave as expected.

## Key Files

- `README.md`
- `manifest.json`
- `background.js`
- `relay.js`
- `tabs.js`
- `permissions.js`
- `perception.js`
- `actions.js`
- `install.sh`
- `pkrelay-token-reader`
- `scripts/reload-extension.py`

## OpenClaw Workflow

- Read `./.clawdbot/AGENT_CONTEXT.md` first for repo-specific rules.
- Read `./.clawdbot/memory.md` for current initiative state.
- Use `.clawdbot/scripts/resume-initiative.sh` to resume active work.
- Keep initiative state on disk rather than relying on chat memory.
