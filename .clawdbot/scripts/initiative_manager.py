#!/usr/bin/env python3
"""
initiative_manager.py — Persistent state manager for OpenClaw initiative orchestration.

This script gives `.clawdbot` a durable operating layer:
- one active initiative at a time
- versioned initiative state on disk
- task graph with dependency-aware spawning
- machine-readable artifact registry
- resumable status summaries across sessions
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
CLAWDBOT_DIR = SCRIPT_DIR.parent
REPO_ROOT = CLAWDBOT_DIR.parent

INITIATIVES_DIR = CLAWDBOT_DIR / "initiatives"
CURRENT_STATE_FILE = CLAWDBOT_DIR / "current-state.json"
CURRENT_INITIATIVE_FILE = CLAWDBOT_DIR / "current-initiative.md"
CURRENT_TASK_GRAPH_FILE = CLAWDBOT_DIR / "current-task-graph.json"
CURRENT_BOOTSTRAP_MEMORY_FILE = CLAWDBOT_DIR / "memory.md"
ACTIVE_TASKS_FILE = CLAWDBOT_DIR / "active-tasks.json"
SPAWN_SCRIPT = CLAWDBOT_DIR / "scripts" / "spawn-agent.sh"


STAGES = [
    {
        "key": "initiative",
        "label": "Initiative Draft",
        "required": [],
    },
    {
        "key": "scope_approved",
        "label": "Scope Approved",
        "required": ["artifacts/scope/approved-scope.md"],
    },
    {
        "key": "research",
        "label": "Research Complete",
        "required": ["artifacts/research/research-summary.md"],
    },
    {
        "key": "technical_spec",
        "label": "Technical Spec Complete",
        "required": [
            "artifacts/spec/technical-spec.md",
            "artifacts/spec/technical-spec.json",
        ],
    },
    {
        "key": "framework_review",
        "label": "Framework and Compliance Review Complete",
        "required": [
            "reviews/framework-compatibility-review.md",
            "reviews/compliance-review.md",
        ],
    },
    {
        "key": "implementation",
        "label": "Implementation In Progress",
        "required": ["task-graph.json"],
    },
    {
        "key": "qa_review",
        "label": "QA Review Complete",
        "required": ["qa/qa-report.md"],
    },
    {
        "key": "release_ready",
        "label": "Release Ready",
        "required": ["handoffs/release-readiness.md"],
    },
]

STAGE_INDEX = {stage["key"]: index for index, stage in enumerate(STAGES)}
STAGE_LABELS = {stage["key"]: stage["label"] for stage in STAGES}
TASK_TERMINAL_STATUSES = {"done", "approved", "cancelled"}


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "initiative"


def read_json(path: Path, default):
    if not path.exists():
        return deepcopy(default)
    return json.loads(path.read_text())


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def load_active_task_registry() -> dict:
    return read_json(ACTIVE_TASKS_FILE, {"tasks": [], "lastUpdated": None, "version": 1})


def find_stage(stage_key: str) -> dict:
    try:
        return STAGES[STAGE_INDEX[stage_key]]
    except KeyError as exc:
        raise SystemExit(f"Unknown stage: {stage_key}") from exc


def initiative_paths(key: str) -> dict[str, Path]:
    root = INITIATIVES_DIR / key
    return {
        "root": root,
        "artifacts_scope": root / "artifacts" / "scope",
        "artifacts_research": root / "artifacts" / "research",
        "artifacts_spec": root / "artifacts" / "spec",
        "reviews": root / "reviews",
        "qa": root / "qa",
        "handoffs": root / "handoffs",
        "initiative_file": root / "initiative.md",
        "state_file": root / "state.json",
        "task_graph_file": root / "task-graph.json",
        "decisions_file": root / "decisions.log.md",
    }


def load_state_from_current() -> tuple[dict, dict[str, Path]]:
    current = read_json(CURRENT_STATE_FILE, {})
    active_key = current.get("active_initiative_key")
    if not active_key:
        raise SystemExit("No active initiative. Start one with `.clawdbot/scripts/start-initiative.sh`.")
    paths = initiative_paths(active_key)
    state = read_json(paths["state_file"], {})
    if not state:
        raise SystemExit(f"Active initiative state missing: {paths['state_file']}")
    return state, paths


def load_task_graph(path: Path, initiative_key: str) -> dict:
    return read_json(
        path,
        {
            "version": 1,
            "initiative_key": initiative_key,
            "updated_at": now_iso(),
            "tasks": [],
        },
    )


def write_summary_files(state: dict, paths: dict[str, Path], task_graph: dict) -> None:
    ensure_dir(CLAWDBOT_DIR)
    artifact_count = len(state.get("artifacts", []))
    history = state.get("history", [])
    latest_transition = history[-1] if history else None

    ready_tasks = get_ready_tasks(task_graph)
    task_counts = Counter(task.get("status", "pending") for task in task_graph.get("tasks", []))

    current_snapshot = {
        "version": 1,
        "active_initiative_key": state["initiative"]["key"],
        "title": state["initiative"]["title"],
        "stage": state["initiative"]["stage"],
        "stage_label": STAGE_LABELS[state["initiative"]["stage"]],
        "status": state["initiative"]["status"],
        "owner": state["initiative"]["owner"],
        "summary": state["scope"].get("summary", ""),
        "updated_at": state["initiative"]["updated_at"],
        "initiative_dir": str(paths["root"]),
        "initiative_file": str(paths["initiative_file"]),
        "state_file": str(paths["state_file"]),
        "task_graph_file": str(paths["task_graph_file"]),
        "artifact_count": artifact_count,
        "task_counts": dict(task_counts),
        "ready_task_ids": [task["id"] for task in ready_tasks],
        "next_action": state.get("next_action", ""),
    }
    write_json(CURRENT_STATE_FILE, current_snapshot)
    write_json(CURRENT_TASK_GRAPH_FILE, task_graph)

    summary_lines = [
        f"# Current Initiative — {state['initiative']['title']}",
        "",
        f"- Key: `{state['initiative']['key']}`",
        f"- Stage: `{state['initiative']['stage']}` — {STAGE_LABELS[state['initiative']['stage']]}",
        f"- Status: `{state['initiative']['status']}`",
        f"- Owner: `{state['initiative']['owner']}`",
        f"- Updated: `{state['initiative']['updated_at']}`",
        "",
        "## Summary",
        state["scope"].get("summary", "(no summary set)"),
        "",
        "## Next Action",
        state.get("next_action", "(not set)"),
        "",
        "## Paths",
        f"- Initiative file: `{paths['initiative_file'].relative_to(REPO_ROOT)}`",
        f"- State file: `{paths['state_file'].relative_to(REPO_ROOT)}`",
        f"- Task graph: `{paths['task_graph_file'].relative_to(REPO_ROOT)}`",
        "",
        "## Task Counts",
    ]
    if task_counts:
        for status, count in sorted(task_counts.items()):
            summary_lines.append(f"- `{status}`: {count}")
    else:
        summary_lines.append("- No tasks yet")
    summary_lines.extend(["", "## Ready Tasks"])
    if ready_tasks:
        for task in ready_tasks[:10]:
            summary_lines.append(f"- `{task['id']}` — {task['title']} ({task.get('agent', 'codex')}/{task.get('model', 'gpt-5.4')})")
    else:
        summary_lines.append("- None")

    if latest_transition:
        summary_lines.extend(
            [
                "",
                "## Latest Stage Transition",
                f"- `{latest_transition['to_stage']}` at {latest_transition['at']}",
                f"- Note: {latest_transition.get('note') or '(none)'}",
            ]
        )

    CURRENT_INITIATIVE_FILE.write_text("\n".join(summary_lines) + "\n")

    bootstrap_memory_lines = [
        f"# Active Initiative Memory — {state['initiative']['title']}",
        "",
        f"- Key: `{state['initiative']['key']}`",
        f"- Stage: `{state['initiative']['stage']}` — {STAGE_LABELS[state['initiative']['stage']]}",
        f"- Status: `{state['initiative']['status']}`",
        f"- Updated: `{state['initiative']['updated_at']}`",
        "",
        "## Summary",
        state["scope"].get("summary", "(no summary set)"),
        "",
        "## Next Action",
        state.get("next_action", "(not set)"),
        "",
        "## Immediate Resume Checklist",
        "1. Read `.clawdbot/current-state.json`.",
        "2. Read `.clawdbot/current-task-graph.json`.",
        "3. Inspect ready tasks and active swarm tasks.",
        "4. Continue from the initiative stage instead of reconstructing from chat history.",
        "",
        "## Ready Tasks",
    ]
    if ready_tasks:
        for task in ready_tasks[:10]:
            bootstrap_memory_lines.append(
                f"- `{task['id']}` — {task['title']} ({task.get('agent', 'codex')}/{task.get('model', 'gpt-5.4')})"
            )
    else:
        bootstrap_memory_lines.append("- None")
    CURRENT_BOOTSTRAP_MEMORY_FILE.write_text("\n".join(bootstrap_memory_lines) + "\n")


def create_state(key: str, title: str, owner: str, summary: str) -> dict:
    timestamp = now_iso()
    return {
        "version": 1,
        "initiative": {
            "key": key,
            "title": title,
            "owner": owner,
            "status": "active",
            "stage": "initiative",
            "created_at": timestamp,
            "updated_at": timestamp,
        },
        "scope": {
            "summary": summary or "Fill in approved scope in initiative.md and artifacts/scope/approved-scope.md.",
            "goals": [],
            "constraints": [],
            "definition_of_done": [],
        },
        "history": [],
        "artifacts": [],
        "notes": [],
        "next_action": "Write approved scope, register the artifact, then advance to scope_approved.",
    }


def create_initiative_files(paths: dict[str, Path], state: dict) -> None:
    ensure_dir(INITIATIVES_DIR)
    ensure_dir(paths["root"])
    ensure_dir(paths["artifacts_scope"])
    ensure_dir(paths["artifacts_research"])
    ensure_dir(paths["artifacts_spec"])
    ensure_dir(paths["reviews"])
    ensure_dir(paths["qa"])
    ensure_dir(paths["handoffs"])

    if not paths["initiative_file"].exists():
        paths["initiative_file"].write_text(
            "\n".join(
                [
                    f"# Initiative — {state['initiative']['title']}",
                    "",
                    f"- Key: `{state['initiative']['key']}`",
                    f"- Owner: `{state['initiative']['owner']}`",
                    f"- Created: `{state['initiative']['created_at']}`",
                    f"- Stage: `{state['initiative']['stage']}`",
                    "",
                    "## Approved Scope",
                    "",
                    "Fill in the approved scope here before advancing.",
                    "",
                    "## Goals",
                    "",
                    "- ",
                    "",
                    "## Constraints",
                    "",
                    "- ",
                    "",
                    "## Definition of Done",
                    "",
                    "- ",
                ]
            )
            + "\n"
        )

    if not paths["task_graph_file"].exists():
        write_json(
            paths["task_graph_file"],
            {
                "version": 1,
                "initiative_key": state["initiative"]["key"],
                "updated_at": now_iso(),
                "tasks": [],
            },
        )

    if not paths["decisions_file"].exists():
        paths["decisions_file"].write_text(
            "\n".join(
                [
                    f"# Decisions Log — {state['initiative']['title']}",
                    "",
                    f"- Created: `{state['initiative']['created_at']}`",
                    "",
                    "## Entries",
                    "",
                    "- ",
                ]
            )
            + "\n"
        )


def get_ready_tasks(task_graph: dict) -> list[dict]:
    task_map = {task["id"]: task for task in task_graph.get("tasks", [])}
    ready = []
    for task in task_graph.get("tasks", []):
        status = task.get("status", "pending")
        if status not in {"pending", "ready"}:
            continue
        deps = task.get("depends_on", [])
        if all(task_map.get(dep, {}).get("status") in TASK_TERMINAL_STATUSES for dep in deps):
            ready.append(task)
    return ready


def format_resume(state: dict, paths: dict[str, Path], task_graph: dict) -> str:
    ready_tasks = get_ready_tasks(task_graph)
    task_counts = Counter(task.get("status", "pending") for task in task_graph.get("tasks", []))
    active_registry = load_active_task_registry()
    initiative_prefix = f"{state['initiative']['key']}-"
    active_swarm = [
        task
        for task in active_registry.get("tasks", [])
        if task.get("status") == "running" and task.get("id", "").startswith(initiative_prefix)
    ]

    lines = [
        f"Initiative: {state['initiative']['title']} ({state['initiative']['key']})",
        f"Stage: {state['initiative']['stage']} — {STAGE_LABELS[state['initiative']['stage']]}",
        f"Status: {state['initiative']['status']}",
        f"Owner: {state['initiative']['owner']}",
        f"Updated: {state['initiative']['updated_at']}",
        "",
        "Summary:",
        f"  {state['scope'].get('summary', '(none)')}",
        "",
        f"Next action: {state.get('next_action', '(not set)')}",
        "",
        "Stage checklist:",
    ]

    current_index = STAGE_INDEX[state["initiative"]["stage"]]
    for index, stage in enumerate(STAGES):
        marker = "✅" if index < current_index else "➡️" if index == current_index else "⬜"
        lines.append(f"  {marker} {stage['key']} — {stage['label']}")

    lines.append("")
    lines.append("Task counts:")
    if task_counts:
        for status, count in sorted(task_counts.items()):
            lines.append(f"  - {status}: {count}")
    else:
        lines.append("  - No tasks yet")

    lines.append("")
    lines.append("Ready tasks:")
    if ready_tasks:
        for task in ready_tasks[:10]:
            lines.append(f"  - {task['id']}: {task['title']} [{task.get('agent', 'codex')}/{task.get('model', 'gpt-5.4')}]")
    else:
        lines.append("  - None")

    lines.append("")
    lines.append("Active swarm tasks:")
    if active_swarm:
        for task in active_swarm:
            lines.append(f"  - {task['id']}: {task.get('agent')} ({task.get('model')})")
    else:
        lines.append("  - None")

    lines.append("")
    lines.append("Recent artifacts:")
    artifacts = state.get("artifacts", [])[-5:]
    if artifacts:
        for artifact in artifacts:
            lines.append(f"  - {artifact['stage']}/{artifact['kind']}: {artifact['path']}")
    else:
        lines.append("  - None registered")

    lines.extend(
        [
            "",
            f"Initiative file: {paths['initiative_file']}",
            f"Task graph: {paths['task_graph_file']}",
            f"Decisions log: {paths['decisions_file']}",
        ]
    )
    return "\n".join(lines)


def command_start(args: argparse.Namespace) -> int:
    key = slugify(args.key)
    paths = initiative_paths(key)
    if paths["root"].exists():
        raise SystemExit(f"Initiative already exists: {paths['root']}")

    state = create_state(key, args.title, args.owner, args.summary or "")
    create_initiative_files(paths, state)
    write_json(paths["state_file"], state)

    task_graph = load_task_graph(paths["task_graph_file"], key)
    write_summary_files(state, paths, task_graph)

    print(f"Started initiative: {state['initiative']['title']} ({key})")
    print(f"Initiative file: {paths['initiative_file']}")
    print(f"Task graph: {paths['task_graph_file']}")
    return 0


def command_resume(_: argparse.Namespace) -> int:
    state, paths = load_state_from_current()
    task_graph = load_task_graph(paths["task_graph_file"], state["initiative"]["key"])
    write_summary_files(state, paths, task_graph)
    print(format_resume(state, paths, task_graph))
    return 0


def command_advance(args: argparse.Namespace) -> int:
    state, paths = load_state_from_current()
    current_stage = state["initiative"]["stage"]
    target_stage = args.stage

    if target_stage not in STAGE_INDEX:
        raise SystemExit(f"Unknown stage: {target_stage}")
    if STAGE_INDEX[target_stage] < STAGE_INDEX[current_stage] and not args.force:
        raise SystemExit(f"Refusing to move backwards from {current_stage} to {target_stage} without --force.")

    required = [paths["root"] / rel for rel in find_stage(target_stage)["required"]]
    missing = [path for path in required if not path.exists()]
    if missing and not args.force:
        missing_rel = ", ".join(str(path.relative_to(paths["root"])) for path in missing)
        raise SystemExit(f"Missing required artifacts for {target_stage}: {missing_rel}")

    timestamp = now_iso()
    state["history"].append(
        {
            "from_stage": current_stage,
            "to_stage": target_stage,
            "at": timestamp,
            "note": args.note or "",
        }
    )
    state["initiative"]["stage"] = target_stage
    state["initiative"]["updated_at"] = timestamp
    if args.next_action:
        state["next_action"] = args.next_action
    elif target_stage == "implementation":
        state["next_action"] = "Add implementation tasks and spawn ready workers from the task graph."
    elif target_stage == "qa_review":
        state["next_action"] = "Run QA loop, capture findings, and drive fix batches until pass."
    elif target_stage == "release_ready":
        state["next_action"] = "Prepare release handoff and final human approval."

    write_json(paths["state_file"], state)
    task_graph = load_task_graph(paths["task_graph_file"], state["initiative"]["key"])
    write_summary_files(state, paths, task_graph)
    print(f"Advanced initiative to {target_stage}")
    return 0


def command_register_artifact(args: argparse.Namespace) -> int:
    state, paths = load_state_from_current()
    artifact_path = Path(args.path)
    if not artifact_path.is_absolute():
        artifact_path = paths["root"] / artifact_path
    if not artifact_path.exists():
        raise SystemExit(f"Artifact file does not exist: {artifact_path}")

    relative_path = str(artifact_path.relative_to(paths["root"]))
    state["artifacts"].append(
        {
            "stage": args.stage or state["initiative"]["stage"],
            "kind": args.kind,
            "path": relative_path,
            "description": args.description or "",
            "registered_at": now_iso(),
        }
    )
    state["initiative"]["updated_at"] = now_iso()
    if args.next_action:
        state["next_action"] = args.next_action

    write_json(paths["state_file"], state)
    task_graph = load_task_graph(paths["task_graph_file"], state["initiative"]["key"])
    write_summary_files(state, paths, task_graph)
    print(f"Registered artifact: {relative_path}")
    return 0


def command_add_task(args: argparse.Namespace) -> int:
    state, paths = load_state_from_current()
    task_graph = load_task_graph(paths["task_graph_file"], state["initiative"]["key"])
    task_id = slugify(args.task_id)
    if any(task["id"] == task_id for task in task_graph["tasks"]):
        raise SystemExit(f"Task already exists: {task_id}")

    depends_on = [item.strip() for item in args.depends_on.split(",") if item.strip()] if args.depends_on else []
    file_paths = [item.strip() for item in args.paths.split(",") if item.strip()] if args.paths else []
    acceptance = [item.strip() for item in args.acceptance.split("|") if item.strip()] if args.acceptance else []
    artifacts = [item.strip() for item in args.artifacts.split(",") if item.strip()] if args.artifacts else []

    task_graph["tasks"].append(
        {
            "id": task_id,
            "title": args.title,
            "description": args.description or "",
            "stage": args.stage or state["initiative"]["stage"],
            "status": "pending",
            "priority": args.priority,
            "agent": args.agent,
            "model": args.model,
            "depends_on": depends_on,
            "paths": file_paths,
            "acceptance_criteria": acceptance,
            "artifact_targets": artifacts,
            "notes": args.notes or "",
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "branch_name": args.branch or "",
            "pr_number": None,
            "spawn_task_id": None,
        }
    )
    task_graph["updated_at"] = now_iso()
    write_json(paths["task_graph_file"], task_graph)
    write_summary_files(state, paths, task_graph)
    print(f"Added task: {task_id}")
    return 0


def command_update_task(args: argparse.Namespace) -> int:
    state, paths = load_state_from_current()
    task_graph = load_task_graph(paths["task_graph_file"], state["initiative"]["key"])
    task = next((item for item in task_graph["tasks"] if item["id"] == args.task_id), None)
    if not task:
        raise SystemExit(f"Task not found: {args.task_id}")

    if args.status:
        task["status"] = args.status
    if args.note is not None:
        task["notes"] = args.note
    if args.branch is not None:
        task["branch_name"] = args.branch
    if args.pr is not None:
        task["pr_number"] = args.pr
    task["updated_at"] = now_iso()
    task_graph["updated_at"] = now_iso()

    if args.next_action:
        state["next_action"] = args.next_action
        state["initiative"]["updated_at"] = now_iso()
        write_json(paths["state_file"], state)

    write_json(paths["task_graph_file"], task_graph)
    write_summary_files(state, paths, task_graph)
    print(f"Updated task: {args.task_id}")
    return 0


def build_task_prompt(state: dict, task: dict) -> str:
    lines = [
        f"Initiative: {state['initiative']['title']} ({state['initiative']['key']})",
        f"Current initiative stage: {state['initiative']['stage']} — {STAGE_LABELS[state['initiative']['stage']]}",
        "",
        "Approved scope summary:",
        state["scope"].get("summary", "(not set)"),
        "",
        f"Task ID: {task['id']}",
        f"Task title: {task['title']}",
        f"Task stage: {task.get('stage', state['initiative']['stage'])}",
    ]
    if task.get("description"):
        lines.extend(["", "Task description:", task["description"]])
    if task.get("paths"):
        lines.extend(["", "Relevant files/areas:"])
        lines.extend(f"- {path}" for path in task["paths"])
    if task.get("acceptance_criteria"):
        lines.extend(["", "Acceptance criteria:"])
        lines.extend(f"- {item}" for item in task["acceptance_criteria"])
    if task.get("artifact_targets"):
        lines.extend(["", "Expected outputs/artifacts:"])
        lines.extend(f"- {item}" for item in task["artifact_targets"])

    lines.extend(
        [
            "",
            "Execution rules:",
            "- Follow the BrightBot shared context pack and repository standards.",
            "- Update tests if behavior changes.",
            "- Leave the branch in a reviewable state.",
            "- Summarize blockers clearly if you cannot complete the task safely.",
        ]
    )
    return "\n".join(lines)


def command_spawn_ready(args: argparse.Namespace) -> int:
    state, paths = load_state_from_current()
    task_graph = load_task_graph(paths["task_graph_file"], state["initiative"]["key"])
    ready_tasks = get_ready_tasks(task_graph)

    if args.stage:
        ready_tasks = [task for task in ready_tasks if task.get("stage") == args.stage]

    if not ready_tasks:
        print("No ready tasks to spawn.")
        return 0

    limit = args.limit or len(ready_tasks)
    spawned = 0
    for task in ready_tasks[:limit]:
        agent = task.get("agent", "codex")
        model = task.get("model", "gpt-5.4")
        spawn_task_id = f"{state['initiative']['key']}-{task['id']}"
        branch_name = task.get("branch_name") or f"codex/{state['initiative']['key']}-{task['id']}"[:63]
        prompt = build_task_prompt(state, task)

        cmd = [
            str(SPAWN_SCRIPT),
            spawn_task_id,
            branch_name,
            prompt,
            agent,
            model,
        ]
        result = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"Failed to spawn task {task['id']}: {result.stderr or result.stdout}", file=sys.stderr)
            continue

        task["status"] = "running"
        task["spawn_task_id"] = spawn_task_id
        task["branch_name"] = branch_name
        task["updated_at"] = now_iso()
        spawned += 1

    task_graph["updated_at"] = now_iso()
    write_json(paths["task_graph_file"], task_graph)
    state["initiative"]["updated_at"] = now_iso()
    if spawned:
        state["next_action"] = "Monitor running workers, collect review artifacts, and feed fixes back into the loop."
        write_json(paths["state_file"], state)
    write_summary_files(state, paths, task_graph)
    print(f"Spawned {spawned} task(s).")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Persistent initiative manager for OpenClaw.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    start = subparsers.add_parser("start", help="Create and activate a new initiative.")
    start.add_argument("key", help="Short initiative key.")
    start.add_argument("title", help="Human-readable initiative title.")
    start.add_argument("--owner", default="Patrick/OpenClaw", help="Initiative owner.")
    start.add_argument("--summary", default="", help="Short scope summary.")
    start.set_defaults(func=command_start)

    resume = subparsers.add_parser("resume", help="Print a resumable initiative summary.")
    resume.set_defaults(func=command_resume)

    advance = subparsers.add_parser("advance", help="Advance the active initiative stage.")
    advance.add_argument("stage", choices=[stage["key"] for stage in STAGES])
    advance.add_argument("--note", default="", help="Transition note.")
    advance.add_argument("--next-action", default="", help="Updated next action.")
    advance.add_argument("--force", action="store_true", help="Bypass missing artifact checks.")
    advance.set_defaults(func=command_advance)

    register = subparsers.add_parser("register-artifact", help="Register an artifact for the active initiative.")
    register.add_argument("path", help="Path relative to the initiative dir or absolute.")
    register.add_argument("--stage", default="", help="Artifact stage. Defaults to current stage.")
    register.add_argument("--kind", default="document", help="Artifact kind.")
    register.add_argument("--description", default="", help="Artifact description.")
    register.add_argument("--next-action", default="", help="Updated next action.")
    register.set_defaults(func=command_register_artifact)

    add_task = subparsers.add_parser("add-task", help="Add a task to the active initiative task graph.")
    add_task.add_argument("task_id", help="Task identifier.")
    add_task.add_argument("title", help="Task title.")
    add_task.add_argument("--description", default="", help="Task description.")
    add_task.add_argument("--stage", default="", help="Task stage. Defaults to current stage.")
    add_task.add_argument("--priority", default="medium", help="Task priority.")
    add_task.add_argument("--agent", default="codex", help="Preferred agent.")
    add_task.add_argument("--model", default="gpt-5.4", help="Preferred model.")
    add_task.add_argument("--depends-on", default="", help="Comma-separated task ids.")
    add_task.add_argument("--paths", default="", help="Comma-separated file paths.")
    add_task.add_argument("--acceptance", default="", help="Use | to separate acceptance criteria.")
    add_task.add_argument("--artifacts", default="", help="Comma-separated expected artifact paths.")
    add_task.add_argument("--notes", default="", help="Task notes.")
    add_task.add_argument("--branch", default="", help="Optional branch name override.")
    add_task.set_defaults(func=command_add_task)

    update_task = subparsers.add_parser("update-task", help="Update task status or metadata.")
    update_task.add_argument("task_id", help="Task id.")
    update_task.add_argument("--status", default="", help="New status.")
    update_task.add_argument("--note", default=None, help="Replace task notes.")
    update_task.add_argument("--branch", default=None, help="Branch name.")
    update_task.add_argument("--pr", type=int, default=None, help="PR number.")
    update_task.add_argument("--next-action", default="", help="Updated initiative next action.")
    update_task.set_defaults(func=command_update_task)

    spawn_ready = subparsers.add_parser("spawn-ready", help="Spawn ready tasks from the active task graph.")
    spawn_ready.add_argument("--stage", default="", help="Only spawn tasks for a specific stage.")
    spawn_ready.add_argument("--limit", type=int, default=0, help="Maximum number of tasks to spawn.")
    spawn_ready.set_defaults(func=command_spawn_ready)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
