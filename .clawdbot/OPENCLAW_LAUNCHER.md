# OpenClaw PKRelay Launcher

Use the repo-local launcher:

```bash
/Users/patrickkelly/pkrelay/openclaw-pkrelay
```

What it does:

1. switches into the repo
2. prints the active initiative summary from `.clawdbot`
3. launches `openclaw tui`
4. uses a stable session key: `project:pkrelay:main`

## Why This Exists

This is the update-safe fallback.

It does not depend on patching OpenClaw internals or bundled files, so OpenClaw updates should not overwrite it.
