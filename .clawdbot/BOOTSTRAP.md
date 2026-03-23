# PKRelay OpenClaw Bootstrap

This file exists for OpenClaw's `bootstrap-extra-files` hook.

When this workspace is opened through OpenClaw, use this file as the first project-specific bootstrap beyond the default workspace context.

## Startup Order

1. Read `./.clawdbot/AGENT_CONTEXT.md`
2. Read `./MEMORY.md`
3. Read `./.clawdbot/memory.md` for the current active initiative snapshot
4. If orchestration work is involved, read `./.clawdbot/OPERATING_SYSTEM.md`
5. If project-specific workflow docs exist, read those next

## What This Workspace Expects

- OpenClaw should behave like a Chief of Staff / orchestrator, not just a chat shell.
- The active initiative state on disk is the source of truth across sessions.
- Use `.clawdbot/current-state.json`, `.clawdbot/current-initiative.md`, and `.clawdbot/current-task-graph.json` to resume work.
- Use the `.clawdbot/scripts/*initiative*` commands to manage scope, artifacts, task graph, and stage transitions.

## Operating Rule

Do not reconstruct initiative context from memory if the on-disk initiative state exists. Read the active state files first.
