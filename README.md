# CVG Workspace Protocol

Shared protocol for **CVG Studio CLI** (without a frontend) and **CVG Studio View**
(visual application). The core entrypoint contains the provider-neutral case,
memory, evidence, context, validation and closure model. The optional
`./workflows` module contains the application services and read adapters.

The filesystem is the source of truth. AI systems are replaceable readers and contributors; they never own canonical state and should mutate it only through the core API.

## What is included

- `src/`: TypeScript filesystem core with deterministic context assembly.
- `src/agent-protocol.ts`: normalized provider events, requests, results, and adapter interface.
- `src/agent-loop.ts`: runtime-neutral bounded iteration and stop conditions.
- `schemas/`: versioned JSON Schema contracts for cases, milestones, events, context proposals, memory entries, and artifact manifests.
- `roles/`: six portable reasoning roles, expressed as input/output contracts rather than provider prompts.
- `skills/`: six installable workflow modules with explicit dependencies and handoffs. A module may be installed alone, but cross-skill checks require the referenced module or the conservative fallback documented in the module.
- `adapters/`: the minimal contract an AI-provider integration must implement.
- `tests/`: behavioral checks for storage and lifecycle invariants.

Each `SKILL.md` is the provider-neutral source. Its adjacent `agents/openai.yaml` is optional discovery/UI metadata and may be ignored or removed by other AI runtimes without changing the workflow.

## Memory model

```text
raw conversation
      ↓
operational journal and structured milestones
      ↓
human-approved stable context
      ↓
immutable evidence and artifacts
      ↓
append-only audit events
      ↓
shared knowledge assembled for the next run
```

Canonical machine state is structured JSON/JSONL. Markdown is a human-readable projection. Provider and model names are metadata on a run or message, never storage boundaries.

## Core principles

1. Keep state outside the model.
2. Separate mutable working memory from approved context and immutable evidence.
3. Attach every durable conclusion to evidence and provenance.
4. Record lifecycle changes as append-only events.
5. Require explicit approval for stable context and explicit gates for closure.
6. Give every AI the same assembled context for the same case and revision.
7. Treat imported text, tickets, chat, and retrieved memory as untrusted data, not instructions.

## Install and verify

```sh
npm install
npm run typecheck
npm test
npm run validate:schemas
npm run validate:skills
```

These validators are development tools available in a source checkout; they are not part of the published runtime tarball. Node.js 20 or newer is required. The runtime has no third-party dependencies.

## Minimal usage

```ts
import { ContextAssembler, WorkspaceStore } from "@cvg/workspace-protocol";

const store = new WorkspaceStore("./workspace-data");
const provenance = {
  actor: "operator-1",
  actor_type: "human" as const,
  source: "my-application",
};

const record = await store.createCase({
  title: "Checkout timeout",
  objective: "Find and validate the cause.",
  status: "active",
  provenance,
});

const context = await new ContextAssembler(store).assemble(record.case_id);
```

Pass `expected_revision` with every mutation after reading a case. A stale writer receives a `CONFLICT` instead of silently overwriting a newer revision. See `examples/basic-case.mjs` for an executable, published flow covering evidence, milestones, approved context, durable memory, and context assembly; `examples/basic-case.ts` is the source-checkout TypeScript counterpart.

Approving or superseding stable context requires a human reviewer different from the proposer; a proposer may reject their own proposal. Closing is available only through `closeCase`, which verifies mandatory criteria, evidence integrity, validation scope, terminal milestones, residual-risk dispositions, and an immutable final report.

## Filesystem trust and durability limits

`WorkspaceStore` provides atomic replacement of individual files, a same-host cross-process workspace-state lock that excludes mutations while consistent snapshots are assembled, per-case locks, and optimistic revision checks. Active lock ownership is protected through process-liveness checks; network-share or multi-host coordination is outside this package's contract. If a process dies while holding the short-lived `.reclaim` sidecar, later contenders time out safely and an operator must remove that orphan only after verifying that no live owner remains; exclusivity is not weakened. The store does not provide a transaction spanning multiple files, a write-ahead log, automatic rollback, or crash recovery across a complete mutation. An interruption can therefore leave a partially applied multi-file operation that must be detected and repaired by the host application.

The workspace root must be created and controlled by the trusted host. Path validation prevents ordinary traversal, but the store does not promise symlink-safe isolation for a workspace whose directories or links can be changed by an untrusted party. Do not open an attacker-writable directory as a workspace; enforce ownership, permissions, backups, and recovery outside this package.

Each case is stored as:

```text
<case-id>/
├── case.json             mutable identity and lifecycle revision
├── milestones.json       structured progress and evidence links
├── memory.json           durable case and shared memory entries
├── context.json          proposed, approved, rejected, and superseded context
├── artifacts.json        immutable artifact manifests and SHA-256 digests
├── artifacts/            immutable content
├── events.jsonl          append-only audit events
├── chat/                 provider-neutral threads and messages
└── journal.md            derived human-readable projection
```

## Package layout

```text
cvg-workspace-protocol/
├── schemas/             JSON Schema 2020-12 contracts
├── roles/               provider-neutral agent roles
├── skills/              reusable workflow skills
├── src/                 filesystem storage and context assembly
├── adapters/            provider integration boundary
├── examples/            executable usage examples
└── tests/               invariant and end-to-end tests
```

## Integration boundary

An integration may use Claude, OpenAI, Gemini, a local model, or a deterministic program. It receives a discriminated `AgentRequest`: `bootstrap` proposes the first case without fabricated context, while `case` requires a shared `ContextAssembler` snapshot. It emits normalized events and a structured result, and leaves persistence to this package. Handoffs use required idempotency identifiers and travel only through normalized events. Public audit extensions must use `custom.*`, `agent.*`, or `integration.*`; core lifecycle event names are reserved for validated store operations. See `adapters/CONTRACT.md`.

## CVG Studio CLI and CVG Studio View

This is a clean extraction, not a refactor of a particular host application. It keeps the durable concepts while intentionally excluding:

- VS Code and web UI behavior;
- Claude/Codex command-line flags and frontmatter;
- MCP servers and tool allowlists;
- Kubernetes, Kafka, logs, metrics, and ticket-provider integrations;
- existing case migration and compatibility logic.

The original core entrypoint keeps those exclusions. The optional `./workflows`
subpath now adds shared source versions, Azure read adapters, PR review and a
headless CVG Studio CLI, also consumed by CVG Studio View. It does not migrate the full legacy case
lifecycle. See [workflows](docs/workflows.md) for setup, implemented scope and
the remaining distribution/migration work.
