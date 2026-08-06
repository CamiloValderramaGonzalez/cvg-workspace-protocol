export const SCHEMA_VERSION = "1.0.0" as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ActorType = "human" | "agent" | "system" | "tool" | "import";

/** Provider-neutral provenance. `source` names the originating workflow or adapter. */
export interface Provenance {
  actor: string;
  actor_type: ActorType;
  source: string;
  occurred_at: string;
  run_id?: string;
  tool?: string;
}

export type ProvenanceInput = Omit<Provenance, "occurred_at"> & {
  occurred_at?: string;
};

export type HumanProvenanceInput = Omit<ProvenanceInput, "actor_type"> & {
  actor_type: "human";
};

interface EvidenceRefFields {
  artifact_id?: string;
  uri?: string;
  path?: string;
  locator?: string;
  digest?: string;
  note?: string;
}

/** At least one locator is required at compile time, matching the JSON Schemas and runtime core. */
export type EvidenceRef = EvidenceRefFields & (
  | { artifact_id: string }
  | { uri: string }
  | { path: string }
  | { locator: string }
  | { digest: string }
);

/** Evidence accepted by integrity-sensitive gates without an external resolver. */
export type StrongEvidenceRef = EvidenceRef & (
  | { artifact_id: string }
  | { path: string; digest: `sha256:${string}` }
);

/** Optional compare-and-set guard accepted by every case mutation. */
export interface MutationOptions {
  expected_revision?: number;
}

export type CaseStatus =
  | "draft"
  | "active"
  | "blocked"
  | "resolved"
  | "closed"
  | "discarded";

export interface CaseRecord {
  schema_version: SchemaVersion;
  case_id: string;
  title: string;
  objective: string;
  summary: string;
  status: CaseStatus;
  revision: number;
  labels: string[];
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  created_by: Provenance;
}

export interface CreateCaseInput {
  case_id?: string;
  title: string;
  objective: string;
  summary?: string;
  status?: "draft" | "active";
  labels?: string[];
  metadata?: JsonObject;
  provenance: ProvenanceInput;
}

export interface UpdateCaseInput {
  title?: string;
  objective?: string;
  summary?: string;
  status?: CaseStatus;
  labels?: string[];
  metadata?: JsonObject;
}

export interface ClosureCriterion {
  criterion_id: string;
  description: string;
  mandatory: boolean;
  disposition: "met" | "not_met";
  evidence_refs: StrongEvidenceRef[];
}

export interface ValidationScope {
  summary: string;
  environments: string[];
  limitations: string[];
  evidence_refs: StrongEvidenceRef[];
}

export interface ResidualRiskDisposition {
  risk_id: string;
  description: string;
  impact: string;
  disposition: "resolved" | "accepted";
  owner: string;
  rationale: string;
}

export interface CloseCaseInput {
  criteria: ClosureCriterion[];
  validation_scope: ValidationScope;
  residual_risks: ResidualRiskDisposition[];
  memory_reviewed: boolean;
  context_reviewed: boolean;
  final_report_artifact_id: string;
  provenance: HumanProvenanceInput;
}

export type MilestoneStatus =
  | "proposed"
  | "pending"
  | "in_progress"
  | "blocked"
  | "validated"
  | "rejected"
  | "completed"
  | "cancelled";

export interface MilestoneRecord {
  schema_version: SchemaVersion;
  milestone_id: string;
  case_id: string;
  title: string;
  description: string;
  status: MilestoneStatus;
  evidence_refs: EvidenceRef[];
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
  created_by: Provenance;
  updated_by: Provenance;
}

export interface CreateMilestoneInput {
  milestone_id?: string;
  title: string;
  description?: string;
  status?: MilestoneStatus;
  evidence_refs?: EvidenceRef[];
  metadata?: JsonObject;
  provenance: ProvenanceInput;
}

export interface UpdateMilestoneInput {
  title?: string;
  description?: string;
  status?: MilestoneStatus;
  evidence_refs?: EvidenceRef[];
  metadata?: JsonObject;
}

export interface MilestoneCollection {
  schema_version: SchemaVersion;
  case_id: string;
  milestones: MilestoneRecord[];
}

export type ContextProposalStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "superseded";

export interface ContextProposalRecord {
  schema_version: SchemaVersion;
  proposal_id: string;
  case_id: string;
  version: number;
  base_version: number;
  base_revision: number;
  summary: string;
  content: string;
  evidence_refs: EvidenceRef[];
  status: ContextProposalStatus;
  created_at: string;
  updated_at: string;
  proposed_by: Provenance;
  reviewed_by?: Provenance;
  review_note?: string;
  supersedes_proposal_id?: string;
  superseded_by_proposal_id?: string;
}

export interface ContextState {
  schema_version: SchemaVersion;
  case_id: string;
  revision: number;
  active_proposal_id: string | null;
  proposals: ContextProposalRecord[];
}

export interface ProposeContextInput {
  proposal_id?: string;
  summary: string;
  content: string;
  evidence_refs?: EvidenceRef[];
  /** If supplied, guards the active context version observed by the caller. */
  base_version?: number;
  /** If supplied, guards the context-state revision observed by the caller. */
  base_revision?: number;
  supersedes_proposal_id?: string;
  provenance: ProvenanceInput;
}

export interface ContextDecisionInput {
  note?: string;
  provenance: HumanProvenanceInput;
}

export type ArtifactKind =
  | "source"
  | "evidence"
  | "diagnosis"
  | "requirement"
  | "test_plan"
  | "test_run"
  | "decision"
  | "report"
  | "attachment"
  | "other";

export interface ArtifactManifest {
  schema_version: SchemaVersion;
  artifact_id: string;
  case_id: string;
  kind: ArtifactKind;
  title: string;
  path: string;
  media_type: string;
  size_bytes: number;
  digest: string;
  source?: string;
  metadata: JsonObject;
  created_at: string;
  created_by: Provenance;
}

/** Backward-friendly alias for stores that call a persisted manifest a record. */
export type ArtifactRecord = ArtifactManifest;

export interface ArtifactCollection {
  schema_version: SchemaVersion;
  case_id: string;
  artifacts: ArtifactRecord[];
}

export interface AddArtifactInput {
  artifact_id?: string;
  kind: ArtifactKind;
  title: string;
  relative_path: string;
  content: string | Uint8Array;
  media_type?: string;
  source?: string;
  metadata?: JsonObject;
  provenance: ProvenanceInput;
}

export interface EventRecord {
  schema_version: SchemaVersion;
  event_id: string;
  case_id: string;
  event_type: string;
  occurred_at: string;
  provenance: Provenance;
  payload: JsonObject;
}

export interface AppendEventInput {
  event_type: string;
  payload?: JsonObject;
  provenance: ProvenanceInput;
}

export type MemoryScope = "case" | "shared";
export type MemoryClassification =
  | "fact"
  | "decision"
  | "constraint"
  | "preference"
  | "lesson"
  | "risk"
  | "assumption";
export type MemoryStatus = "active" | "contested" | "deprecated" | "superseded" | "retracted";

/** A durable, evidence-aware memory entry. Shared entries remain owned by their source case. */
export interface MemoryEntryRecord {
  schema_version: SchemaVersion;
  memory_id: string;
  case_id: string;
  scope: MemoryScope;
  shared_scope?: string;
  classification: MemoryClassification;
  statement: string;
  evidence_refs: EvidenceRef[];
  confidence: number;
  status: MemoryStatus;
  revision: number;
  supersedes_memory_id?: string;
  superseded_by_memory_id?: string;
  created_at: string;
  updated_at: string;
  provenance: Provenance;
}

export interface MemoryCollection {
  schema_version: SchemaVersion;
  case_id: string;
  entries: MemoryEntryRecord[];
}

export interface AddMemoryInput {
  memory_id?: string;
  scope: MemoryScope;
  shared_scope?: string;
  classification: MemoryClassification;
  statement: string;
  evidence_refs?: EvidenceRef[];
  confidence: number;
  provenance: ProvenanceInput;
}

export type SupersedeMemoryInput = Omit<AddMemoryInput, "scope" | "shared_scope"> & {
  scope?: MemoryScope;
  shared_scope?: string;
};

export interface ApplicableMemory {
  case_memory: MemoryEntryRecord[];
  shared_memory: MemoryEntryRecord[];
}

/** Persisted chat is evidence data; provider-level system instructions are never stored here. */
export type ChatRole = "user" | "assistant" | "tool";

export interface ChatThreadRecord {
  schema_version: SchemaVersion;
  thread_id: string;
  case_id: string;
  title: string;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
  created_by: Provenance;
}

export interface ChatThreadCollection {
  schema_version: SchemaVersion;
  case_id: string;
  threads: ChatThreadRecord[];
}

export interface CreateChatThreadInput {
  thread_id?: string;
  title?: string;
  metadata?: JsonObject;
  provenance: ProvenanceInput;
}

export interface ChatMessageRecord {
  schema_version: SchemaVersion;
  message_id: string;
  case_id: string;
  thread_id: string;
  role: ChatRole;
  content: string;
  provider?: string;
  model?: string;
  metadata: JsonObject;
  created_at: string;
  provenance: Provenance;
}

export interface AppendChatMessageInput {
  message_id?: string;
  role: ChatRole;
  content: string;
  provider?: string;
  model?: string;
  metadata?: JsonObject;
  provenance: ProvenanceInput;
}

export interface ChatTranscript {
  thread: ChatThreadRecord;
  messages: ChatMessageRecord[];
}

export interface CaseSnapshot {
  case: CaseRecord;
  milestones: MilestoneRecord[];
  context: ContextState;
  artifacts: ArtifactRecord[];
  memory: ApplicableMemory;
  events: EventRecord[];
  chats: ChatTranscript[];
}

export interface ContextAssemblyOptions {
  include_events?: boolean;
  event_limit?: number;
  chat_thread_ids?: string[];
  chat_message_limit?: number;
  shared_scopes?: string[];
  include_inactive_memory?: boolean;
}

export interface AssembledContext {
  schema_version: SchemaVersion;
  /** Revisions of the case records that contributed case or shared memory. */
  source_revisions: Record<string, number>;
  case: CaseRecord;
  active_context: ContextProposalRecord | null;
  milestones: MilestoneRecord[];
  artifacts: ArtifactRecord[];
  case_memory: MemoryEntryRecord[];
  shared_memory: MemoryEntryRecord[];
  events: EventRecord[];
  chats: ChatTranscript[];
}
