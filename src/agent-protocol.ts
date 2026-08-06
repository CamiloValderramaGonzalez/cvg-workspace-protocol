import type { AssembledContext, EvidenceRef, JsonObject, JsonValue } from "./types.js";

export interface HandoffRequest {
  handoff_id: string;
  target_role: string;
  objective: string;
  artifact_refs: string[];
  evidence_refs: EvidenceRef[];
  context?: JsonObject;
}

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

/** Use only before canonical case state exists. The result remains an uncommitted CreateCaseInput proposal. */
export interface BootstrapAgentRequest extends AgentRequestBase {
  mode: "bootstrap";
  case_id?: string;
  context?: never;
}

/** Use for every invocation that reasons over an existing canonical case. */
export interface CaseAgentRequest extends AgentRequestBase {
  mode: "case";
  case_id: string;
  context: AssembledContext;
}

export type AgentRequest = BootstrapAgentRequest | CaseAgentRequest;

export interface AgentResult<TOutput extends JsonValue = JsonValue> {
  run_id: string;
  status: "completed" | "failed" | "cancelled";
  output?: TOutput;
  evidence_refs: EvidenceRef[];
  warnings: string[];
  usage?: Record<string, number>;
}

export interface AgentEventMetadata {
  event_id: string;
  run_id: string;
  emitted_at: string;
  provider: string;
  model?: string;
}

export type AgentEvent<TOutput extends JsonValue = JsonValue> = AgentEventMetadata & (
  | { type: "started"; role: string }
  | { type: "message"; role: "assistant" | "tool"; content: string; delta?: boolean }
  | { type: "status"; message: string }
  | { type: "tool-requested"; call_id: string; name: string; input?: JsonValue }
  | { type: "tool-result"; call_id: string; name: string; ok: boolean; result?: JsonValue }
  | { type: "artifact-proposed"; artifact_id?: string; proposal: JsonObject }
  | { type: "context-proposed"; proposal_id?: string; proposal: JsonObject }
  | { type: "handoff-requested"; handoff: HandoffRequest }
  | {
      type: "handoff-completed";
      handoff: HandoffRequest;
      ok: boolean;
      result?: JsonObject;
    }
  | { type: "step-started"; index: number; kind: string }
  | { type: "step-completed"; index: number; kind: string; ok: boolean }
  | { type: "completed"; result: AgentResult<TOutput> }
  | { type: "failed"; error: string; retryable: boolean }
);

export type AgentEventSink<TOutput extends JsonValue = JsonValue> = (
  event: AgentEvent<TOutput>,
) => void | Promise<void>;

export interface AgentAdapter {
  readonly provider: string;
  run<TOutput extends JsonValue = JsonValue>(
    request: AgentRequest,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<AgentEvent<TOutput>>;
}
