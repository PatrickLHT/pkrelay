# PKRelay Shared Agent Context

This file is the model-neutral context pack for all `.clawdbot` agents in PKRelay.

## Purpose

Every agent spawned through `.clawdbot` should treat this file as the first project-specific context document to load.

The goal is consistent behavior across models:

- same project constraints
- same workflow standards
- same definition of done
- same risk awareness around browser permissions, relay state, and protocol compatibility

## Required Startup Routine

Before making changes:

1. Read `./README.md`.
2. Read `./MEMORY.md`.
3. Read `./.clawdbot/memory.md`.
4. Read the most relevant source files for the task area before editing.
5. If work touches startup/bootstrap flow, also read `./.clawdbot/BOOTSTRAP.md`.

Do not bulk-load everything unless the task truly requires it.

## Project-Specific Rules

- Preserve compatibility with the OpenClaw relay protocol and the `pkrelay.*` namespace.
- Treat `manifest.json` permissions and host permissions as security-sensitive.
- Preserve the native messaging contract in `pkrelay-token-reader` unless a deliberate config migration is part of the task.
- Respect multi-browser contention, standby, and handoff behavior in `relay.js`.
- Respect user-facing tab permission states: `full`, `ask`, `none`.
- Avoid broad refactors across service worker, relay, and tab/session state unless there is a concrete need.

## File Routing Guide

- `background.js`
  - Service worker wiring, badge management, message routing.
- `relay.js`
  - Connection lifecycle, keepalive, reconnect, slot contention, standby, browser switching.
- `tabs.js`
  - CDP attach/detach, tab/session state.
- `permissions.js`
  - Permission rules and Ask First flow.
- `perception.js`
  - Snapshot/screenshot behavior.
- `actions.js`
  - High-level action execution.
- `install.sh`, `pkrelay-token-reader`
  - Native messaging install and OpenClaw config/token integration.
- `popup.*`, `options.*`
  - User controls and settings UX.

## Definition of Done

A task is not complete unless the relevant parts are true:

1. The code matches the requested scope.
2. Protocol compatibility is preserved or intentionally updated.
3. Browser permission changes are justified and minimal.
4. Manual verification steps are identified or performed for changed behavior.
5. Any risky relay/session/permission behavior is called out clearly in the handoff.

## Stop And Escalate When

Stop and summarize blockers instead of guessing if:

- a change requires broader browser permissions than currently granted
- relay protocol behavior is unclear or undocumented
- native messaging behavior depends on unknown OpenClaw config assumptions
- multi-browser slot semantics may regress
- a fix would require speculative changes across several stateful modules at once

## Model Routing Notes

- `Claude`: architecture, protocol reasoning, risky behavior review
- `Codex`: implementation, refactors, bug fixing, tests
- `Gemini`: large-context review, security and product-behavior analysis

Regardless of model, the repo files and current initiative state are the source of truth.
