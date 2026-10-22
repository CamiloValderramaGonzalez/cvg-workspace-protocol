---
name: cvg-sprint-plan
description: Import an Azure sprint into CVG Studio CLI with explicit task ownership, then plan dependency waves and identify blockers without executing the sprint.
---

# CVG sprint planning

Use the installed `cvg-studio-cli` command from `@cvg/workspace-protocol` (`cvg-workflow` is a compatible alias), or its
resolved `dist/workflows/cli.js` with Node. `settings get` reads shared PR
granularity and concurrency. Set the same `CVG_WORKFLOWS_ROOT` as CVG Studio View.

Establish the selected organization, project, team, iteration and exact assignee.
Missing identity is a question, not authorization for all tasks. Distinguish
imported task IDs, proposed implementation subtasks and dependency-only context.

Use `sprint iterations <team>` to select a real iteration, then
`sprint import <team> <iteration-id> <assignee>` to capture tasks owned by the
explicit identity. The command creates stable local workspaces and source copies,
records membership history, and does not change Azure. Repeat a failed import to
reuse partial work without duplicate workspaces. `sprint list` and
`sprint history <local-sprint-id>` show saved results. Removed membership does not
delete a workspace. Task assignment changes during capture cause an explicit failure.

For a supplied task list, `sprint plan <tasks.json> [concurrency]` takes a
JSON array of `{id, workspace_id, title, depends_on, priority, stage}`. Lower
priority numbers run first among available tasks. It returns dependency waves,
rejects duplicate IDs, unresolved dependencies and cycles, and executes nothing.

Explain the intended sequence: capture → analysis → test design → isolated
implementation → validation → ready for PR → human publication. Flag repository,
port, database and shared-environment collisions before calling work parallelizable.

Worktree/branch allocation, durable execution queues and publication are
not yet implemented in this module. Preserve that distinction. Do not simulate
an import from guesses or claim that capturing and ordering tasks starts a background runner.
API/UI tests with data effects require the future supervised executor; planning
never grants approval to run them.
