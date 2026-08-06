# Extraction map

This package preserves CVG Studio's management semantics while removing runtime and tool coupling.

## Roles retained

| Portable role | Source concept | Retained behavior |
|---|---|---|
| `requirement-author` | `requirement-author` agent | Turn an informal request into stable, testable criteria |
| `requirement-analyst` | `requirement-analyst` agent | Analyze impact, risk, dependencies, and validation strategy |
| `orchestrator` | `orchestrator` agent | Correlate evidence, competing hypotheses, and confidence |
| `validation-scoper` | `validation-scoper` agent | Bound claims to the path and environments actually tested |
| `executive-translator` | `diagnosis-translator` agent | Explain verified technical findings without adding conclusions |
| `file-explainer` | `file-explainer` agent | Explain supplied content and identify uncertainty |

## Skills created

| Skill | Extracted responsibility |
|---|---|
| `operate-cvg-workspace` | Case creation, lifecycle, coordination, and safe state transitions |
| `curate-cvg-memory` | Promotion from transient conversation to durable memory |
| `enforce-cvg-evidence` | Provenance, evidence references, integrity, and claim discipline |
| `govern-cvg-context` | Proposal, review, approval, rejection, and supersession of stable context |
| `validate-cvg-hypotheses` | Hypothesis-to-test-to-verdict workflow |
| `close-cvg-case` | Closure gates, residual risk, final reporting, and RCA |

The original monolithic chat agent is intentionally not copied. Its durable responsibilities are distributed across `operate-cvg-workspace`, `curate-cvg-memory`, and `govern-cvg-context`.

## Concepts retained in the core

- File-backed state independent of model sessions.
- A mutable case record and operational journal.
- Structured milestones linked to evidence.
- Human-approved stable context.
- Immutable, content-addressed artifacts.
- Append-only lifecycle events.
- Provider-neutral conversation metadata.
- Deterministic context assembly.
- Normalized provider events and a bounded runtime-neutral agent loop.

## Excluded from the portable core

- Claude or Codex CLI invocation.
- Agent frontmatter and slash commands tied to one product.
- MCP server names and tool allowlists.
- VS Code extension and web routes.
- Kubernetes, Kafka, metrics, logs, and ticketing collectors.
- Existing client data and migration compatibility code.
- Prompt-only enforcement of filesystem or production permissions.

Those capabilities belong in adapters. They may supply evidence to the core but cannot redefine its lifecycle or persistence rules.

## Original-to-new boundary

This extraction does not modify or import from the original application at runtime. A legacy implementation can later receive a migration adapter that:

1. reads legacy case files without rewriting them;
2. maps statuses and paths to the versioned schemas;
3. hashes existing evidence;
4. emits a provenance-preserving import event;
5. reports ambiguous or invalid records for human review.
