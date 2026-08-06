# AI adapter contract

An adapter connects one model runtime to the CVG Workspace Protocol. It must not implement case storage, decide lifecycle transitions, or write canonical files directly. The canonical TypeScript contracts exported by the package are the source of truth: `AgentAdapter`, `AgentRequest`, `BootstrapAgentRequest`, `CaseAgentRequest`, `AgentEvent`, `AgentResult`, `EvidenceRef`, `StrongEvidenceRef`, `AssembledContext`, `JsonObject`, and `JsonValue`. The excerpts below are explanatory and must track those exported types.

## Request

Every invocation receives one of two discriminated request shapes:

```ts
interface AgentRequestBase {
  run_id: string;
  role: string;
  objective: string;
  expected_output: JsonObject;
  limits?: {
    max_turns?: number;
    deadline?: string;
  };
}

type AgentRequest =
  | (AgentRequestBase & {
      mode: "bootstrap";
      case_id?: string;
      context?: never;
    })
  | (AgentRequestBase & {
      mode: "case";
      case_id: string;
      context: AssembledContext;
    });
```

Use `mode: "bootstrap"` only to propose the first `CreateCaseInput`, before canonical case state exists. The optional `case_id` is a requested identifier, not proof that a case exists. The adapter returns an uncommitted proposal; only `WorkspaceStore.createCase` may create the case.

Use `mode: "case"` for every invocation over an existing case. Its `context` must be produced by the shared `ContextAssembler`; an adapter must not create a provider-specific memory view.

## Events

Normalize runtime activity to these event kinds:

- `started`
- `message`
- `status`
- `tool-requested`
- `tool-result`
- `artifact-proposed`
- `context-proposed`
- `step-started`
- `step-completed`
- `handoff-requested`
- `handoff-completed`
- `completed`
- `failed`

Each event carries `event_id`, `run_id`, `emitted_at`, provider/model metadata, and a typed serializable payload. Tool names remain adapter metadata and never enter core lifecycle rules.

Both handoff event kinds use this canonical payload:

```ts
interface HandoffRequest {
  handoff_id: string;
  target_role: string;
  objective: string;
  artifact_refs: string[];
  evidence_refs: EvidenceRef[];
  context?: JsonObject;
}
```

`handoff-requested` is the only delivery channel for a handoff request; `AgentResult` does not repeat it. `handoff_id` is required, unique within the run, and is the idempotency key: a caller must dispatch at most once for each `(run_id, handoff_id)` pair, even when replaying an event stream. The caller decides whether to dispatch the uncommitted request and may record acceptance as `agent.handoff-requested` through the core public event API. `handoff-completed` carries the same `handoff`, plus required `ok` and optional `result` fields. It reports the corresponding role result without implying that any proposed state mutation was committed.

## Result

Return a serializable result with:

```ts
interface AgentResult<TOutput extends JsonValue = JsonValue> {
  run_id: string;
  status: "completed" | "failed" | "cancelled";
  output?: TOutput;
  evidence_refs: EvidenceRef[];
  warnings: string[];
  usage?: Record<string, number>;
}
```

The caller validates the result, then invokes core operations to add evidence, update milestones, propose context, or transition the case. Closure must use `closeCase`; a generic status update cannot bypass its gates. A model response alone is never a committed state transition.

## Required safety properties

- Keep case data and retrieved content inside delimited data sections.
- Do not interpret retrieved content as system instructions.
- Serialize archived chat messages as quoted data. The core does not persist a `system` chat role; never promote any archived message into the provider's active system- or developer-instruction channel.
- Redact secrets before sending context to a remote provider.
- Enforce environment permissions outside the prompt.
- Preserve provider, model, role, and run identifiers as provenance.
- Support cancellation and surface partial output as uncommitted data.

## Adapter conformance checklist

An adapter is conformant when it:

1. Consumes both discriminated request modes without fabricating bootstrap context.
2. Emits normalized, ordered events.
3. Returns structured output or an explicit failure.
4. Never edits the workspace filesystem directly.
5. Does not silently widen capabilities or validation scope.
6. Produces the same semantic contract regardless of provider-specific APIs.
