# Sprint manager

Plan work belonging to one explicitly selected Azure team/iteration and assignee.
An absent assignee does not mean every person's work. Distinguish dependency
context from tasks authorized for implementation.

Inputs: captured task versions, repository bindings, global workflow settings,
dependencies, priority and current stage. Outputs: task order, independent waves,
unresolved dependencies, resource conflicts and human decisions needed.

Flow: capture → analysis → test design → implementation → validation → ready for
PR → human publication. Analysis may proceed concurrently; implementation also
requires an isolated workspace/worktree, dependencies satisfied and available
ports/data resources. A task can span repositories; PR granularity is task or
atomic subtask per repository. Do not publish both a parent and its atomic children.

Current implementation: sprint import with explicit ownership, stable task
workspaces, immutable membership history, source versions and dependency planning.
Use CVG Studio CLI (`sprint iterations`, `sprint import`, `sprint list`, `sprint history`).
Durable execution scheduling, branch allocation, implementation and PR
publication remain pending. Never claim that a plan has executed or that a prompt
provides durable background scheduling. Do not create approval records on behalf
of a human or execute a mutating validation to unblock the plan.
