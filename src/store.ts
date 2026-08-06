import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  appendJsonLine,
  atomicCreateFile,
  atomicWriteFile,
  atomicWriteJson,
  pathExists,
  readJsonFile,
  readJsonLines,
} from "./atomic-fs.js";
import { ProtocolError, invariant } from "./errors.js";
import { type IdGenerator, SortableIdGenerator } from "./ids.js";
import { renderJournal } from "./journal.js";
import { KeyedMutex, withFileLock } from "./lock.js";
import { resolveInside, safePathSegment, safeRelativePath } from "./paths.js";
import {
  SCHEMA_VERSION,
  type AddArtifactInput,
  type AddMemoryInput,
  type AppendChatMessageInput,
  type AppendEventInput,
  type ApplicableMemory,
  type ArtifactCollection,
  type ArtifactRecord,
  type CaseRecord,
  type CaseSnapshot,
  type CaseStatus,
  type ChatMessageRecord,
  type ChatThreadCollection,
  type ChatThreadRecord,
  type ChatTranscript,
  type ContextDecisionInput,
  type ContextProposalRecord,
  type ContextState,
  type CloseCaseInput,
  type CreateCaseInput,
  type CreateChatThreadInput,
  type CreateMilestoneInput,
  type EventRecord,
  type EvidenceRef,
  type JsonObject,
  type MemoryCollection,
  type MemoryEntryRecord,
  type MilestoneCollection,
  type MilestoneRecord,
  type MilestoneStatus,
  type MutationOptions,
  type ProposeContextInput,
  type Provenance,
  type ProvenanceInput,
  type SupersedeMemoryInput,
  type UpdateCaseInput,
  type UpdateMilestoneInput,
} from "./types.js";

const CASE_FILE = "case.json";
const MILESTONES_FILE = "milestones.json";
const CONTEXT_FILE = "context.json";
const ARTIFACTS_FILE = "artifacts.json";
const MEMORY_FILE = "memory.json";
const EVENTS_FILE = "events.jsonl";
const JOURNAL_FILE = "journal.md";
const CHAT_THREADS_FILE = "chat/threads.json";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/;
const WORKSPACE_MUTEX_KEY = "\u0000workspace-state";
const CASE_MUTEX_PREFIX = "\u0000case:";

const CASE_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  draft: ["active", "discarded"],
  active: ["blocked", "resolved", "discarded"],
  blocked: ["active", "resolved", "discarded"],
  resolved: ["active", "closed"],
  closed: [],
  discarded: [],
};

const MILESTONE_TRANSITIONS: Readonly<Record<MilestoneStatus, readonly MilestoneStatus[]>> = {
  proposed: ["pending", "rejected", "cancelled"],
  pending: ["in_progress", "blocked", "validated", "rejected", "completed", "cancelled"],
  in_progress: ["blocked", "validated", "rejected", "completed", "cancelled"],
  blocked: ["pending", "in_progress", "cancelled"],
  validated: ["completed", "rejected"],
  rejected: [],
  completed: [],
  cancelled: [],
};

export interface WorkspaceStoreOptions {
  clock?: () => Date;
  id_generator?: IdGenerator;
  locks?: KeyedMutex;
}

export interface ApplicableMemoryOptions {
  shared_scopes?: string[];
  include_inactive?: boolean;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function requireText(value: string, label: string): string {
  invariant(typeof value === "string" && value.trim().length > 0, "INVALID_INPUT", label + " es obligatorio");
  return value.trim();
}

function requireIdentifier(value: string, label: string): string {
  invariant(
    typeof value === "string" && IDENTIFIER_PATTERN.test(value),
    "INVALID_INPUT",
    label + " is invalid",
  );
  return safePathSegment(value, label);
}

function assertStoredIdentity(
  value: unknown,
  expected_case_id: string,
  label: string,
): asserts value is { schema_version: typeof SCHEMA_VERSION; case_id: string } {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "INTEGRITY_ERROR", label + " is invalid");
  const record = value as { schema_version?: unknown; case_id?: unknown };
  invariant(record.schema_version === SCHEMA_VERSION, "INTEGRITY_ERROR", label + " tiene schema_version incompatible");
  invariant(record.case_id === expected_case_id, "INTEGRITY_ERROR", label + " pertenece a otro caso", {
    expected_case_id,
    actual_case_id: record.case_id,
  });
}

function normalizeLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((label) => label.trim()).filter(Boolean))].sort();
}

function evidenceRefPayload(reference: EvidenceRef): JsonObject {
  const payload: JsonObject = {};
  if (reference.artifact_id !== undefined) payload.artifact_id = reference.artifact_id;
  if (reference.uri !== undefined) payload.uri = reference.uri;
  if (reference.path !== undefined) payload.path = reference.path;
  if (reference.locator !== undefined) payload.locator = reference.locator;
  if (reference.digest !== undefined) payload.digest = reference.digest;
  if (reference.note !== undefined) payload.note = reference.note;
  return payload;
}

function compareCreatedId<T extends { created_at: string }>(
  a: T,
  b: T,
  id_key: keyof T,
): number {
  return a.created_at.localeCompare(b.created_at) || String(a[id_key]).localeCompare(String(b[id_key]));
}

function requireRevision(value: number, label: string): number {
  invariant(Number.isSafeInteger(value) && value >= 0, "INVALID_INPUT", label + " debe ser un entero no negativo");
  return value;
}

function requireConfidence(value: number): number {
  invariant(Number.isFinite(value) && value >= 0 && value <= 1, "INVALID_INPUT", "confidence debe estar entre 0 y 1");
  return value;
}

export class WorkspaceStore {
  readonly root: string;
  private readonly clock: () => Date;
  private readonly ids: IdGenerator;
  private readonly locks: KeyedMutex;

  constructor(root: string, options: WorkspaceStoreOptions = {}) {
    invariant(typeof root === "string" && root.trim().length > 0, "INVALID_INPUT", "Workspace root vacío");
    this.root = path.resolve(root);
    this.clock = options.clock ?? (() => new Date());
    this.ids = options.id_generator ?? new SortableIdGenerator({ clock: () => this.clock().getTime() });
    this.locks = options.locks ?? new KeyedMutex();
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  getCaseDirectory(case_id: string): string {
    return path.join(this.root, requireIdentifier(case_id, "case_id"));
  }

  private async withWorkspaceStateLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.locks.run(WORKSPACE_MUTEX_KEY, async () => {
      await this.initialize();
      return withFileLock(path.join(this.root, ".locks", "workspace-state.lock"), operation);
    });
  }

  /** Run a read-only callback while all workspace mutations are excluded. */
  async withConsistentRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.withWorkspaceStateLock(operation);
  }

  private async runMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.withWorkspaceStateLock(() => this.locks.run(CASE_MUTEX_PREFIX + key, async () => {
      const lock_name = `case-${requireIdentifier(key, "case_id")}.lock`;
      return withFileLock(path.join(this.root, ".locks", lock_name), operation);
    }));
  }

  private nowIso(): string {
    const date = this.clock();
    invariant(!Number.isNaN(date.getTime()), "INVALID_INPUT", "El clock devolvió una fecha inválida");
    return date.toISOString();
  }

  private nextId(prefix: string): string {
    return this.ids.next(prefix, this.clock().getTime());
  }

  private normalizeProvenance(input: ProvenanceInput, fallback_at = this.nowIso()): Provenance {
    const occurred_at = input.occurred_at ?? fallback_at;
    invariant(!Number.isNaN(Date.parse(occurred_at)), "INVALID_INPUT", "provenance.occurred_at inválido");
    return {
      actor: requireText(input.actor, "provenance.actor"),
      actor_type: input.actor_type,
      source: requireText(input.source, "provenance.source"),
      occurred_at: new Date(occurred_at).toISOString(),
      ...(input.run_id ? { run_id: input.run_id } : {}),
      ...(input.tool ? { tool: input.tool } : {}),
    };
  }

  private normalizeHumanReviewer(input: ProvenanceInput, fallback_at: string): Provenance {
    const reviewer = this.normalizeProvenance(input, fallback_at);
    invariant(
      reviewer.actor_type === "human",
      "INVALID_INPUT",
      "Context decisions require a human reviewer",
    );
    return reviewer;
  }

  private async requireCase(case_id: string): Promise<string> {
    const dir = this.getCaseDirectory(case_id);
    invariant(await pathExists(path.join(dir, CASE_FILE)), "NOT_FOUND", "Caso " + case_id + " no encontrado");
    return dir;
  }

  private caseFile(case_id: string, relative_path: string): string {
    return resolveInside(this.getCaseDirectory(case_id), relative_path);
  }

  private async beginMutation(case_id: string, options: MutationOptions): Promise<CaseRecord> {
    const current = await this.readCase(case_id);
    invariant(
      current.status !== "closed" && current.status !== "discarded",
      "INVALID_TRANSITION",
      `El caso ${case_id} está ${current.status} y no admite mutaciones canónicas`,
    );
    if (options.expected_revision !== undefined) {
      requireRevision(options.expected_revision, "expected_revision");
      invariant(
        current.revision === options.expected_revision,
        "CONFLICT",
        "Revisión esperada " + options.expected_revision + ", actual " + current.revision,
        { case_id, expected_revision: options.expected_revision, actual_revision: current.revision },
      );
    }
    return current;
  }

  private async advanceRevisionUnlocked(
    case_id: string,
    baseline: CaseRecord,
    updated_at: string,
  ): Promise<CaseRecord> {
    const latest = await this.readCase(case_id);
    invariant(
      latest.revision === baseline.revision,
      "CONFLICT",
      "El caso cambió durante la operación",
      { case_id, expected_revision: baseline.revision, actual_revision: latest.revision },
    );
    const updated: CaseRecord = {
      ...latest,
      revision: latest.revision + 1,
      updated_at,
    };
    await atomicWriteJson(this.caseFile(case_id, CASE_FILE), updated);
    return updated;
  }

  async createCase(input: CreateCaseInput): Promise<CaseRecord> {
    const case_id = requireIdentifier(input.case_id ?? this.nextId("case"), "case_id");
    return this.runMutation(case_id, async () => {
      const now = this.nowIso();
      const dir = this.getCaseDirectory(case_id);
      const status = input.status ?? "draft";
      invariant(
        status === "draft" || status === "active",
        "INVALID_INPUT",
        "El estado inicial debe ser draft o active",
      );
      const provenance = this.normalizeProvenance(input.provenance, now);
      const record: CaseRecord = {
        schema_version: SCHEMA_VERSION,
        case_id,
        title: requireText(input.title, "title"),
        objective: requireText(input.objective, "objective"),
        summary: input.summary?.trim() ?? "",
        status,
        revision: 0,
        labels: normalizeLabels(input.labels),
        metadata: cloneJson(input.metadata ?? {}),
        created_at: now,
        updated_at: now,
        created_by: provenance,
      };
      const milestones: MilestoneCollection = { schema_version: SCHEMA_VERSION, case_id, milestones: [] };
      const context: ContextState = {
        schema_version: SCHEMA_VERSION,
        case_id,
        revision: 0,
        active_proposal_id: null,
        proposals: [],
      };
      const artifacts: ArtifactCollection = { schema_version: SCHEMA_VERSION, case_id, artifacts: [] };
      const memory: MemoryCollection = { schema_version: SCHEMA_VERSION, case_id, entries: [] };
      const threads: ChatThreadCollection = { schema_version: SCHEMA_VERSION, case_id, threads: [] };

      try {
        await fs.mkdir(dir, { recursive: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ProtocolError("CONFLICT", "El caso " + case_id + " ya existe");
        }
        throw error;
      }

      await atomicWriteJson(path.join(dir, CASE_FILE), record);
      await atomicWriteJson(path.join(dir, MILESTONES_FILE), milestones);
      await atomicWriteJson(path.join(dir, CONTEXT_FILE), context);
      await atomicWriteJson(path.join(dir, ARTIFACTS_FILE), artifacts);
      await atomicWriteJson(path.join(dir, MEMORY_FILE), memory);
      await atomicWriteJson(path.join(dir, CHAT_THREADS_FILE), threads);
      await this.appendEventUnlocked(case_id, {
        event_type: "case.created",
        payload: { status: record.status, title: record.title, objective: record.objective },
        provenance,
      });
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(record);
    });
  }

  async listCases(): Promise<CaseRecord[]> {
    await this.initialize();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const cases: CaseRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        cases.push(await this.readCase(entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return cases.sort((a, b) => a.case_id.localeCompare(b.case_id));
  }

  async readCase(case_id: string): Promise<CaseRecord> {
    const dir = await this.requireCase(case_id);
    const value = await readJsonFile<unknown>(path.join(dir, CASE_FILE));
    assertStoredIdentity(value, case_id, CASE_FILE);
    return cloneJson(value as CaseRecord);
  }

  async updateCase(
    case_id: string,
    patch: UpdateCaseInput,
    provenance_input: ProvenanceInput,
    options: MutationOptions = {},
  ): Promise<CaseRecord> {
    return this.runMutation(case_id, async () => {
      const current = await this.beginMutation(case_id, options);
      const next_status = patch.status ?? current.status;
      invariant(
        next_status !== "closed" || current.status === "closed",
        "INVALID_TRANSITION",
        "Use closeCase to enforce closure gates",
      );
      this.assertCaseTransition(current.status, next_status);
      const now = this.nowIso();
      const provenance = this.normalizeProvenance(provenance_input, now);
      const updated: CaseRecord = {
        ...current,
        title: patch.title === undefined ? current.title : requireText(patch.title, "title"),
        objective: patch.objective === undefined ? current.objective : requireText(patch.objective, "objective"),
        summary: patch.summary === undefined ? current.summary : patch.summary.trim(),
        status: next_status,
        revision: current.revision + 1,
        labels: patch.labels === undefined ? current.labels : normalizeLabels(patch.labels),
        metadata: patch.metadata === undefined ? current.metadata : { ...current.metadata, ...cloneJson(patch.metadata) },
        updated_at: now,
      };
      if (next_status === "closed") updated.closed_at = now;
      else if (updated.closed_at) delete updated.closed_at;
      await atomicWriteJson(this.caseFile(case_id, CASE_FILE), updated);
      await this.appendEventUnlocked(case_id, {
        event_type: "case.updated",
        payload: {
          previous_status: current.status,
          status: updated.status,
          changed_fields: Object.keys(patch).sort(),
          revision: updated.revision,
        },
        provenance,
      });
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(updated);
    });
  }

  async closeCase(
    case_id: string,
    input: CloseCaseInput,
    options: MutationOptions = {},
  ): Promise<CaseRecord> {
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      invariant(baseline.status === "resolved", "INVALID_TRANSITION", "Only a resolved case can be closed");
      invariant(input.criteria.length > 0, "INVALID_INPUT", "Closure requires explicit criteria");

      const criterion_ids = new Set<string>();
      for (const criterion of input.criteria) {
        const criterion_id = requireIdentifier(criterion.criterion_id, "criterion_id");
        invariant(!criterion_ids.has(criterion_id), "INVALID_INPUT", "Duplicate closure criterion: " + criterion_id);
        criterion_ids.add(criterion_id);
        requireText(criterion.description, "criterion.description");
        invariant(
          criterion.disposition === "met" || criterion.disposition === "not_met",
          "INVALID_INPUT",
          "Invalid criterion disposition",
        );
        invariant(
          !criterion.mandatory || criterion.disposition === "met",
          "INVALID_TRANSITION",
          "Mandatory closure criterion is not met: " + criterion_id,
        );
        if (criterion.disposition === "met") {
          await this.validateEvidence(case_id, criterion.evidence_refs, true);
        }
      }

      requireText(input.validation_scope.summary, "validation_scope.summary");
      input.validation_scope.environments.forEach((environment) => requireText(environment, "validation_scope.environment"));
      input.validation_scope.limitations.forEach((limitation) => requireText(limitation, "validation_scope.limitation"));
      await this.validateEvidence(case_id, input.validation_scope.evidence_refs, true);

      for (const risk of input.residual_risks) {
        requireIdentifier(risk.risk_id, "risk_id");
        requireText(risk.description, "risk.description");
        requireText(risk.impact, "risk.impact");
        requireText(risk.owner, "risk.owner");
        requireText(risk.rationale, "risk.rationale");
        invariant(
          risk.disposition === "resolved" || risk.disposition === "accepted",
          "INVALID_TRANSITION",
          "Residual risk lacks an accepted disposition: " + risk.risk_id,
        );
      }

      invariant(input.memory_reviewed === true, "INVALID_TRANSITION", "Durable memory must be reviewed before closure");
      invariant(input.context_reviewed === true, "INVALID_TRANSITION", "Approved context must be reviewed before closure");

      const milestones = await this.listMilestones(case_id);
      for (const milestone of milestones) {
        if (milestone.status === "validated" || milestone.status === "completed") {
          await this.validateEvidence(case_id, milestone.evidence_refs, true);
        }
      }
      const nonterminal = milestones.filter(
        (milestone) => !["validated", "completed", "rejected", "cancelled"].includes(milestone.status),
      );
      invariant(
        nonterminal.length === 0,
        "INVALID_TRANSITION",
        "Closure has non-terminal milestones",
        { milestone_ids: nonterminal.map((milestone) => milestone.milestone_id) },
      );

      const final_report_artifact_id = requireIdentifier(
        input.final_report_artifact_id,
        "final_report_artifact_id",
      );
      const artifacts = await this.readArtifactsCollection(case_id);
      const report = artifacts.artifacts.find((artifact) => artifact.artifact_id === final_report_artifact_id);
      invariant(report, "INTEGRITY_ERROR", "Final report artifact does not exist");
      invariant(report.kind === "report", "INVALID_INPUT", "Final artifact must have kind report");
      await this.readVerifiedArtifactBytes(case_id, report);

      const now = this.nowIso();
      const reviewer = this.normalizeHumanReviewer(input.provenance, now);
      const closed: CaseRecord = {
        ...baseline,
        status: "closed",
        revision: baseline.revision + 1,
        updated_at: now,
        closed_at: now,
      };
      await atomicWriteJson(this.caseFile(case_id, CASE_FILE), closed);
      await this.appendEventUnlocked(case_id, {
        event_type: "case.closed",
        payload: {
          final_report_artifact_id,
          criteria: input.criteria.map((criterion) => ({
            criterion_id: criterion.criterion_id,
            description: criterion.description.trim(),
            mandatory: criterion.mandatory,
            disposition: criterion.disposition,
            evidence_refs: criterion.evidence_refs.map(evidenceRefPayload),
          })),
          validation_scope: {
            summary: input.validation_scope.summary.trim(),
            environments: input.validation_scope.environments.map((environment) => environment.trim()),
            limitations: input.validation_scope.limitations.map((limitation) => limitation.trim()),
            evidence_refs: input.validation_scope.evidence_refs.map(evidenceRefPayload),
          },
          memory_reviewed: input.memory_reviewed,
          context_reviewed: input.context_reviewed,
          residual_risks: input.residual_risks.map((risk) => ({
            risk_id: risk.risk_id,
            description: risk.description.trim(),
            impact: risk.impact.trim(),
            disposition: risk.disposition,
            owner: risk.owner.trim(),
            rationale: risk.rationale.trim(),
          })),
          revision: closed.revision,
        },
        provenance: reviewer,
      });
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(closed);
    });
  }

  private assertCaseTransition(from: CaseStatus, to: CaseStatus): void {
    if (from === to) return;
    invariant(CASE_TRANSITIONS[from].includes(to), "INVALID_TRANSITION", "Transición de caso inválida: " + from + " -> " + to);
  }

  async appendEvent(
    case_id: string,
    input: AppendEventInput,
    options: MutationOptions = {},
  ): Promise<EventRecord> {
    invariant(
      /^(?:custom|agent|integration)\.[a-z0-9][a-z0-9_.-]*$/.test(input.event_type),
      "INVALID_INPUT",
      "Public events must use the custom.*, agent.*, or integration.* namespace",
    );
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const event = await this.appendEventUnlocked(case_id, {
        event_type: input.event_type,
        payload: input.payload ?? {},
        provenance: this.normalizeProvenance(input.provenance),
      });
      await this.advanceRevisionUnlocked(case_id, baseline, event.occurred_at);
      await this.refreshJournalUnlocked(case_id);
      return event;
    });
  }

  private async appendEventUnlocked(
    case_id: string,
    input: { event_type: string; payload: JsonObject; provenance: Provenance },
  ): Promise<EventRecord> {
    invariant(/^[a-z][a-z0-9_.-]*$/.test(input.event_type), "INVALID_INPUT", "event_type inválido: " + input.event_type);
    const event: EventRecord = {
      schema_version: SCHEMA_VERSION,
      event_id: this.nextId("event"),
      case_id,
      event_type: input.event_type,
      occurred_at: input.provenance.occurred_at,
      provenance: input.provenance,
      payload: cloneJson(input.payload),
    };
    await appendJsonLine(this.caseFile(case_id, EVENTS_FILE), event);
    return cloneJson(event);
  }

  async listEvents(case_id: string): Promise<EventRecord[]> {
    await this.requireCase(case_id);
    return this.readEventsUnlocked(case_id);
  }

  private async readEventsUnlocked(case_id: string): Promise<EventRecord[]> {
    const values = await readJsonLines<unknown>(this.caseFile(case_id, EVENTS_FILE));
    for (const [index, value] of values.entries()) {
      assertStoredIdentity(value, case_id, `${EVENTS_FILE}:${index + 1}`);
    }
    return (values as EventRecord[]).map(cloneJson);
  }

  async listMilestones(case_id: string): Promise<MilestoneRecord[]> {
    const collection = await this.readMilestonesCollection(case_id);
    return collection.milestones.map(cloneJson).sort((a, b) => compareCreatedId(a, b, "milestone_id"));
  }

  async createMilestone(
    case_id: string,
    input: CreateMilestoneInput,
    options: MutationOptions = {},
  ): Promise<MilestoneRecord> {
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const collection = await this.readMilestonesCollection(case_id);
      const milestone_id = requireIdentifier(input.milestone_id ?? this.nextId("milestone"), "milestone_id");
      invariant(!collection.milestones.some((item) => item.milestone_id === milestone_id), "CONFLICT", "El hito " + milestone_id + " ya existe");
      const evidence_refs = cloneJson(input.evidence_refs ?? []);
      const status = input.status ?? "proposed";
      await this.validateEvidence(case_id, evidence_refs, status === "validated" || status === "completed");
      const now = this.nowIso();
      const provenance = this.normalizeProvenance(input.provenance, now);
      const record: MilestoneRecord = {
        schema_version: SCHEMA_VERSION,
        milestone_id,
        case_id,
        title: requireText(input.title, "milestone.title"),
        description: input.description?.trim() ?? "",
        status,
        evidence_refs,
        metadata: cloneJson(input.metadata ?? {}),
        created_at: now,
        updated_at: now,
        created_by: provenance,
        updated_by: provenance,
      };
      collection.milestones.push(record);
      await atomicWriteJson(this.caseFile(case_id, MILESTONES_FILE), collection);
      await this.appendEventUnlocked(case_id, {
        event_type: "milestone.created",
        payload: { milestone_id, status },
        provenance,
      });
      await this.advanceRevisionUnlocked(case_id, baseline, now);
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(record);
    });
  }

  async updateMilestone(
    case_id: string,
    milestone_id: string,
    patch: UpdateMilestoneInput,
    provenance_input: ProvenanceInput,
    options: MutationOptions = {},
  ): Promise<MilestoneRecord> {
    requireIdentifier(milestone_id, "milestone_id");
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const collection = await this.readMilestonesCollection(case_id);
      const current = collection.milestones.find((item) => item.milestone_id === milestone_id);
      invariant(current, "NOT_FOUND", "Hito " + milestone_id + " no encontrado");
      const next_status = patch.status ?? current.status;
      this.assertMilestoneTransition(current.status, next_status);
      const evidence_refs = patch.evidence_refs === undefined ? current.evidence_refs : cloneJson(patch.evidence_refs);
      await this.validateEvidence(case_id, evidence_refs, next_status === "validated" || next_status === "completed");
      const now = this.nowIso();
      const provenance = this.normalizeProvenance(provenance_input, now);
      const updated: MilestoneRecord = {
        ...current,
        title: patch.title === undefined ? current.title : requireText(patch.title, "milestone.title"),
        description: patch.description === undefined ? current.description : patch.description.trim(),
        status: next_status,
        evidence_refs,
        metadata: patch.metadata === undefined ? current.metadata : { ...current.metadata, ...cloneJson(patch.metadata) },
        updated_at: now,
        updated_by: provenance,
      };
      collection.milestones[collection.milestones.indexOf(current)] = updated;
      await atomicWriteJson(this.caseFile(case_id, MILESTONES_FILE), collection);
      await this.appendEventUnlocked(case_id, {
        event_type: "milestone.updated",
        payload: { milestone_id, previous_status: current.status, status: next_status },
        provenance,
      });
      await this.advanceRevisionUnlocked(case_id, baseline, now);
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(updated);
    });
  }

  private assertMilestoneTransition(from: MilestoneStatus, to: MilestoneStatus): void {
    if (from === to) return;
    invariant(MILESTONE_TRANSITIONS[from].includes(to), "INVALID_TRANSITION", "Transición de hito inválida: " + from + " -> " + to);
  }

  private async readMilestonesCollection(case_id: string): Promise<MilestoneCollection> {
    await this.requireCase(case_id);
    const value = await readJsonFile<unknown>(this.caseFile(case_id, MILESTONES_FILE));
    assertStoredIdentity(value, case_id, MILESTONES_FILE);
    const collection = value as MilestoneCollection;
    invariant(Array.isArray(collection.milestones), "INTEGRITY_ERROR", MILESTONES_FILE + " is invalid");
    for (const record of collection.milestones) assertStoredIdentity(record, case_id, "milestone");
    return collection;
  }

  private async validateEvidence(case_id: string, refs: EvidenceRef[], require_resolvable: boolean): Promise<void> {
    if (require_resolvable) invariant(refs.length > 0, "INVALID_INPUT", "This operation requires resolvable evidence");
    const artifacts = await this.readArtifactsCollection(case_id);
    for (const ref of refs) {
      invariant(Boolean(ref.artifact_id || ref.uri || ref.path || ref.locator || ref.digest), "INVALID_INPUT", "EvidenceRef sin referencia");
      if (require_resolvable) {
        invariant(
          Boolean(ref.artifact_id || (ref.path && ref.digest)),
          "INTEGRITY_ERROR",
          "Strong evidence gates require artifact_id or path with SHA-256 digest",
        );
      }
      if (ref.path) {
        const relative = safeRelativePath(ref.path);
        if (require_resolvable) {
          invariant(
            relative.startsWith("artifacts/"),
            "INTEGRITY_ERROR",
            "Strong path evidence must be stored under artifacts/",
          );
          invariant(ref.digest, "INTEGRITY_ERROR", "Path evidence requires a SHA-256 digest");
          let bytes: Buffer;
          try {
            bytes = await fs.readFile(this.caseFile(case_id, relative));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              throw new ProtocolError("INTEGRITY_ERROR", "Evidence path does not exist: " + relative);
            }
            throw error;
          }
          const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
          invariant(digest === ref.digest, "INTEGRITY_ERROR", "Path evidence digest does not match");
        }
      }
      if (ref.artifact_id) {
        requireIdentifier(ref.artifact_id, "evidence.artifact_id");
        const artifact = artifacts.artifacts.find((item) => item.artifact_id === ref.artifact_id);
        invariant(artifact, "INTEGRITY_ERROR", "Artefacto de evidencia inexistente: " + ref.artifact_id);
        if (ref.digest) invariant(ref.digest === artifact.digest, "INTEGRITY_ERROR", "Digest de evidencia no coincide");
        await this.readVerifiedArtifactBytes(case_id, artifact);
      }
      if (ref.digest) invariant(/^sha256:[a-f0-9]{64}$/.test(ref.digest), "INVALID_INPUT", "Digest de evidencia inválido");
      if (ref.uri) {
        try {
          new URL(ref.uri);
        } catch {
          throw new ProtocolError("INVALID_INPUT", "URI de evidencia inválida: " + ref.uri);
        }
      }
    }
  }

  async getContextState(case_id: string): Promise<ContextState> {
    const dir = await this.requireCase(case_id);
    const value = await readJsonFile<unknown>(path.join(dir, CONTEXT_FILE));
    assertStoredIdentity(value, case_id, CONTEXT_FILE);
    const state = value as ContextState;
    invariant(Array.isArray(state.proposals), "INTEGRITY_ERROR", CONTEXT_FILE + " is invalid");
    for (const proposal of state.proposals) assertStoredIdentity(proposal, case_id, "context proposal");
    return cloneJson(state);
  }

  async getActiveContext(case_id: string): Promise<ContextProposalRecord | null> {
    const state = await this.getContextState(case_id);
    if (!state.active_proposal_id) return null;
    const active = state.proposals.find((item) => item.proposal_id === state.active_proposal_id);
    invariant(active?.status === "approved", "INTEGRITY_ERROR", "El contexto activo no está aprobado");
    return cloneJson(active);
  }

  async proposeContext(
    case_id: string,
    input: ProposeContextInput,
    options: MutationOptions = {},
  ): Promise<ContextProposalRecord> {
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const state = await this.getContextState(case_id);
      const active = state.active_proposal_id
        ? state.proposals.find((item) => item.proposal_id === state.active_proposal_id)
        : undefined;
      const observed_version = active?.version ?? 0;
      if (input.base_version !== undefined) {
        requireRevision(input.base_version, "base_version");
        invariant(input.base_version === observed_version, "CONFLICT", "base_version de contexto obsoleta");
      }
      if (input.base_revision !== undefined) {
        requireRevision(input.base_revision, "base_revision");
        invariant(input.base_revision === state.revision, "CONFLICT", "base_revision de contexto obsoleta");
      }
      if (active) {
        invariant(input.supersedes_proposal_id === active.proposal_id, "CONFLICT", "La propuesta debe reemplazar " + active.proposal_id);
      } else {
        invariant(!input.supersedes_proposal_id, "CONFLICT", "No hay contexto activo que reemplazar");
      }
      const proposal_id = requireIdentifier(input.proposal_id ?? this.nextId("proposal"), "proposal_id");
      invariant(!state.proposals.some((item) => item.proposal_id === proposal_id), "CONFLICT", "La propuesta " + proposal_id + " ya existe");
      const evidence_refs = cloneJson(input.evidence_refs ?? []);
      await this.validateEvidence(case_id, evidence_refs, false);
      const now = this.nowIso();
      const provenance = this.normalizeProvenance(input.provenance, now);
      const version = state.proposals.reduce((max, item) => Math.max(max, item.version), 0) + 1;
      const record: ContextProposalRecord = {
        schema_version: SCHEMA_VERSION,
        proposal_id,
        case_id,
        version,
        base_version: observed_version,
        base_revision: state.revision,
        summary: requireText(input.summary, "context.summary"),
        content: requireText(input.content, "context.content"),
        evidence_refs,
        status: "pending_review",
        created_at: now,
        updated_at: now,
        proposed_by: provenance,
        ...(input.supersedes_proposal_id ? { supersedes_proposal_id: input.supersedes_proposal_id } : {}),
      };
      state.proposals.push(record);
      state.revision += 1;
      await atomicWriteJson(this.caseFile(case_id, CONTEXT_FILE), state);
      await this.appendEventUnlocked(case_id, {
        event_type: "context.proposed",
        payload: {
          proposal_id,
          version,
          base_version: record.base_version,
          base_revision: record.base_revision,
          ...(record.supersedes_proposal_id ? { supersedes_proposal_id: record.supersedes_proposal_id } : {}),
        },
        provenance,
      });
      await this.advanceRevisionUnlocked(case_id, baseline, now);
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(record);
    });
  }

  async approveContext(
    case_id: string,
    proposal_id: string,
    decision: ContextDecisionInput,
    options: MutationOptions = {},
  ): Promise<ContextProposalRecord> {
    requireIdentifier(proposal_id, "proposal_id");
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const state = await this.getContextState(case_id);
      invariant(!state.active_proposal_id, "CONFLICT", "Ya existe contexto activo; use supersedeContext");
      const proposal = this.pendingProposal(state, proposal_id);
      invariant(!proposal.supersedes_proposal_id, "CONFLICT", "La propuesta reemplaza otra; use supersedeContext");
      const now = this.nowIso();
      const reviewer = this.normalizeHumanReviewer(decision.provenance, now);
      invariant(reviewer.actor !== proposal.proposed_by.actor, "INVALID_INPUT", "A proposer cannot approve their own context");
      await this.validateEvidence(case_id, proposal.evidence_refs, true);
      proposal.status = "approved";
      proposal.updated_at = now;
      proposal.reviewed_by = reviewer;
      if (decision.note) proposal.review_note = decision.note.trim();
      state.active_proposal_id = proposal_id;
      state.revision += 1;
      await atomicWriteJson(this.caseFile(case_id, CONTEXT_FILE), state);
      await this.appendEventUnlocked(case_id, {
        event_type: "context.approved",
        payload: { proposal_id, version: proposal.version },
        provenance: reviewer,
      });
      await this.advanceRevisionUnlocked(case_id, baseline, now);
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(proposal);
    });
  }

  async rejectContext(
    case_id: string,
    proposal_id: string,
    decision: ContextDecisionInput,
    options: MutationOptions = {},
  ): Promise<ContextProposalRecord> {
    requireIdentifier(proposal_id, "proposal_id");
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const state = await this.getContextState(case_id);
      const proposal = this.pendingProposal(state, proposal_id);
      const now = this.nowIso();
      const reviewer = this.normalizeHumanReviewer(decision.provenance, now);
      proposal.status = "rejected";
      proposal.updated_at = now;
      proposal.reviewed_by = reviewer;
      if (decision.note) proposal.review_note = decision.note.trim();
      state.revision += 1;
      await atomicWriteJson(this.caseFile(case_id, CONTEXT_FILE), state);
      await this.appendEventUnlocked(case_id, {
        event_type: "context.rejected",
        payload: { proposal_id, ...(decision.note ? { note: decision.note.trim() } : {}) },
        provenance: reviewer,
      });
      await this.advanceRevisionUnlocked(case_id, baseline, now);
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(proposal);
    });
  }

  async supersedeContext(
    case_id: string,
    replacement_proposal_id: string,
    decision: ContextDecisionInput,
    options: MutationOptions = {},
  ): Promise<ContextProposalRecord> {
    requireIdentifier(replacement_proposal_id, "proposal_id");
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const state = await this.getContextState(case_id);
      const active_id = state.active_proposal_id;
      invariant(active_id, "CONFLICT", "No hay contexto activo para reemplazar");
      const active = state.proposals.find((item) => item.proposal_id === active_id);
      invariant(active?.status === "approved", "INTEGRITY_ERROR", "Contexto activo inválido");
      const replacement = this.pendingProposal(state, replacement_proposal_id);
      invariant(replacement.supersedes_proposal_id === active_id, "CONFLICT", "La propuesta no reemplaza el contexto activo");
      invariant(replacement.base_version === active.version, "CONFLICT", "La propuesta parte de una versión obsoleta");
      const now = this.nowIso();
      const reviewer = this.normalizeHumanReviewer(decision.provenance, now);
      invariant(reviewer.actor !== replacement.proposed_by.actor, "INVALID_INPUT", "A proposer cannot approve their own context");
      await this.validateEvidence(case_id, replacement.evidence_refs, true);
      active.status = "superseded";
      active.updated_at = now;
      active.superseded_by_proposal_id = replacement_proposal_id;
      replacement.status = "approved";
      replacement.updated_at = now;
      replacement.reviewed_by = reviewer;
      if (decision.note) replacement.review_note = decision.note.trim();
      state.active_proposal_id = replacement_proposal_id;
      state.revision += 1;
      await atomicWriteJson(this.caseFile(case_id, CONTEXT_FILE), state);
      await this.appendEventUnlocked(case_id, {
        event_type: "context.superseded",
        payload: { previous_proposal_id: active_id, proposal_id: replacement_proposal_id },
        provenance: reviewer,
      });
      await this.advanceRevisionUnlocked(case_id, baseline, now);
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(replacement);
    });
  }

  private pendingProposal(state: ContextState, proposal_id: string): ContextProposalRecord {
    const proposal = state.proposals.find((item) => item.proposal_id === proposal_id);
    invariant(proposal, "NOT_FOUND", "Propuesta " + proposal_id + " no encontrada");
    invariant(
      proposal.status === "pending_review" || proposal.status === "draft",
      "INVALID_TRANSITION",
      "La propuesta " + proposal_id + " está " + proposal.status,
    );
    return proposal;
  }

  async addArtifact(
    case_id: string,
    input: AddArtifactInput,
    options: MutationOptions = {},
  ): Promise<ArtifactRecord> {
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const collection = await this.readArtifactsCollection(case_id);
      const artifact_id = requireIdentifier(input.artifact_id ?? this.nextId("artifact"), "artifact_id");
      invariant(!collection.artifacts.some((item) => item.artifact_id === artifact_id), "CONFLICT", "El artefacto " + artifact_id + " ya existe");
      const relative = safeRelativePath(input.relative_path);
      const stored_path = safeRelativePath("artifacts/" + artifact_id + "/" + relative);
      const absolute = this.caseFile(case_id, stored_path);
      const bytes = typeof input.content === "string" ? Buffer.from(input.content, "utf-8") : Buffer.from(input.content);
      const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      const now = this.nowIso();
      const provenance = this.normalizeProvenance(input.provenance, now);
      const record: ArtifactRecord = {
        schema_version: SCHEMA_VERSION,
        artifact_id,
        case_id,
        kind: input.kind,
        title: requireText(input.title, "artifact.title"),
        path: stored_path,
        media_type: input.media_type ?? (typeof input.content === "string" ? "text/plain; charset=utf-8" : "application/octet-stream"),
        size_bytes: bytes.byteLength,
        digest,
        metadata: cloneJson(input.metadata ?? {}),
        created_at: now,
        created_by: provenance,
        ...(input.source ? { source: input.source } : {}),
      };
      let created_file = false;
      try {
        await atomicCreateFile(absolute, bytes);
        created_file = true;
        collection.artifacts.push(record);
        await atomicWriteJson(this.caseFile(case_id, ARTIFACTS_FILE), collection);
      } catch (error) {
        if (created_file) await fs.rm(absolute, { force: true }).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ProtocolError("CONFLICT", "El archivo del artefacto " + artifact_id + " ya existe");
        }
        throw error;
      }
      await this.appendEventUnlocked(case_id, {
        event_type: "artifact.created",
        payload: { artifact_id, kind: record.kind, path: record.path, digest },
        provenance,
      });
      await this.advanceRevisionUnlocked(case_id, baseline, now);
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(record);
    });
  }

  async listArtifacts(case_id: string): Promise<ArtifactRecord[]> {
    const collection = await this.readArtifactsCollection(case_id);
    return collection.artifacts.map(cloneJson).sort((a, b) => compareCreatedId(a, b, "artifact_id"));
  }

  async verifyArtifact(case_id: string, artifact_id: string): Promise<boolean> {
    requireIdentifier(artifact_id, "artifact_id");
    const collection = await this.readArtifactsCollection(case_id);
    const artifact = collection.artifacts.find((item) => item.artifact_id === artifact_id);
    invariant(artifact, "NOT_FOUND", "Artefacto " + artifact_id + " no encontrado");
    try {
      await this.readVerifiedArtifactBytes(case_id, artifact);
      return true;
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "INTEGRITY_ERROR") return false;
      throw error;
    }
  }

  async readArtifact(case_id: string, artifact_id: string): Promise<Uint8Array> {
    requireIdentifier(artifact_id, "artifact_id");
    const collection = await this.readArtifactsCollection(case_id);
    const artifact = collection.artifacts.find((item) => item.artifact_id === artifact_id);
    invariant(artifact, "NOT_FOUND", "Artefacto " + artifact_id + " no encontrado");
    return this.readVerifiedArtifactBytes(case_id, artifact);
  }

  private async readVerifiedArtifactBytes(case_id: string, artifact: ArtifactRecord): Promise<Buffer> {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.caseFile(case_id, artifact.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProtocolError("INTEGRITY_ERROR", "Archivo de artefacto inexistente: " + artifact.artifact_id);
      }
      throw error;
    }
    const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    invariant(
      digest === artifact.digest && bytes.byteLength === artifact.size_bytes,
      "INTEGRITY_ERROR",
      "Artifact integrity is invalid: " + artifact.artifact_id,
      {
        artifact_id: artifact.artifact_id,
        expected_digest: artifact.digest,
        actual_digest: digest,
        expected_size_bytes: artifact.size_bytes,
        actual_size_bytes: bytes.byteLength,
      },
    );
    return bytes;
  }

  private async readArtifactsCollection(case_id: string): Promise<ArtifactCollection> {
    await this.requireCase(case_id);
    const value = await readJsonFile<unknown>(this.caseFile(case_id, ARTIFACTS_FILE));
    assertStoredIdentity(value, case_id, ARTIFACTS_FILE);
    const collection = value as ArtifactCollection;
    invariant(Array.isArray(collection.artifacts), "INTEGRITY_ERROR", ARTIFACTS_FILE + " is invalid");
    for (const artifact of collection.artifacts) assertStoredIdentity(artifact, case_id, "artifact");
    return collection;
  }

  async listMemory(case_id: string, include_inactive = true): Promise<MemoryEntryRecord[]> {
    const collection = await this.readMemoryCollection(case_id);
    return collection.entries
      .filter((item) => include_inactive || item.status === "active")
      .map(cloneJson)
      .sort((a, b) => compareCreatedId(a, b, "memory_id"));
  }

  async listApplicableMemory(
    case_id: string,
    options: ApplicableMemoryOptions = {},
  ): Promise<ApplicableMemory> {
    await this.requireCase(case_id);
    const include_inactive = options.include_inactive ?? false;
    const scopes = new Set((options.shared_scopes ?? ["global"]).map((scope) => requireText(scope, "shared_scope")));
    const all_cases = await this.listCases();
    const collections = await Promise.all(all_cases.map((item) => this.readMemoryCollection(item.case_id)));
    const case_memory: MemoryEntryRecord[] = [];
    const shared_memory: MemoryEntryRecord[] = [];
    for (const collection of collections) {
      for (const entry of collection.entries) {
        if (!include_inactive && entry.status !== "active") continue;
        if (entry.scope === "case" && entry.case_id === case_id) case_memory.push(cloneJson(entry));
        if (entry.scope === "shared" && scopes.has(entry.shared_scope ?? "global")) shared_memory.push(cloneJson(entry));
      }
    }
    case_memory.sort((a, b) => a.memory_id.localeCompare(b.memory_id));
    shared_memory.sort((a, b) => a.memory_id.localeCompare(b.memory_id));
    return { case_memory, shared_memory };
  }

  async addMemory(
    case_id: string,
    input: AddMemoryInput,
    options: MutationOptions = {},
  ): Promise<MemoryEntryRecord> {
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const collection = await this.readMemoryCollection(case_id);
      const memory_id = requireIdentifier(input.memory_id ?? this.nextId("memory"), "memory_id");
      invariant(!collection.entries.some((item) => item.memory_id === memory_id), "CONFLICT", "La memoria " + memory_id + " ya existe");
      const evidence_refs = cloneJson(input.evidence_refs ?? []);
      await this.validateEvidence(case_id, evidence_refs, false);
      const shared_scope = input.scope === "shared" ? requireText(input.shared_scope ?? "global", "shared_scope") : undefined;
      invariant(input.scope === "shared" || input.shared_scope === undefined, "INVALID_INPUT", "shared_scope requiere scope shared");
      const now = this.nowIso();
      const provenance = this.normalizeProvenance(input.provenance, now);
      const record: MemoryEntryRecord = {
        schema_version: SCHEMA_VERSION,
        memory_id,
        case_id,
        scope: input.scope,
        classification: input.classification,
        statement: requireText(input.statement, "memory.statement"),
        evidence_refs,
        confidence: requireConfidence(input.confidence),
        status: "active",
        revision: 1,
        created_at: now,
        updated_at: now,
        provenance,
        ...(shared_scope ? { shared_scope } : {}),
      };
      collection.entries.push(record);
      await atomicWriteJson(this.caseFile(case_id, MEMORY_FILE), collection);
      await this.appendEventUnlocked(case_id, {
        event_type: "memory.added",
        payload: { memory_id, scope: record.scope, classification: record.classification, ...(shared_scope ? { shared_scope } : {}) },
        provenance,
      });
      await this.advanceRevisionUnlocked(case_id, baseline, now);
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(record);
    });
  }

  async supersedeMemory(
    case_id: string,
    memory_id: string,
    input: SupersedeMemoryInput,
    options: MutationOptions = {},
  ): Promise<MemoryEntryRecord> {
    requireIdentifier(memory_id, "memory_id");
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const collection = await this.readMemoryCollection(case_id);
      const current = collection.entries.find((item) => item.memory_id === memory_id);
      invariant(current, "NOT_FOUND", "Memoria " + memory_id + " no encontrada");
      invariant(current.status === "active", "INVALID_TRANSITION", "Solo una memoria activa puede reemplazarse");
      const scope = input.scope ?? current.scope;
      invariant(scope === current.scope, "INVALID_INPUT", "Una supersesión no puede cambiar scope");
      const shared_scope = scope === "shared"
        ? requireText(input.shared_scope ?? current.shared_scope ?? "global", "shared_scope")
        : undefined;
      const replacement_id = requireIdentifier(input.memory_id ?? this.nextId("memory"), "memory_id");
      invariant(!collection.entries.some((item) => item.memory_id === replacement_id), "CONFLICT", "La memoria " + replacement_id + " ya existe");
      const evidence_refs = cloneJson(input.evidence_refs ?? []);
      await this.validateEvidence(case_id, evidence_refs, false);
      const now = this.nowIso();
      const provenance = this.normalizeProvenance(input.provenance, now);
      current.status = "superseded";
      current.revision += 1;
      current.updated_at = now;
      current.superseded_by_memory_id = replacement_id;
      const replacement: MemoryEntryRecord = {
        schema_version: SCHEMA_VERSION,
        memory_id: replacement_id,
        case_id,
        scope,
        classification: input.classification,
        statement: requireText(input.statement, "memory.statement"),
        evidence_refs,
        confidence: requireConfidence(input.confidence),
        status: "active",
        revision: 1,
        supersedes_memory_id: memory_id,
        created_at: now,
        updated_at: now,
        provenance,
        ...(shared_scope ? { shared_scope } : {}),
      };
      collection.entries.push(replacement);
      await atomicWriteJson(this.caseFile(case_id, MEMORY_FILE), collection);
      await this.appendEventUnlocked(case_id, {
        event_type: "memory.superseded",
        payload: { previous_memory_id: memory_id, memory_id: replacement_id, scope },
        provenance,
      });
      await this.advanceRevisionUnlocked(case_id, baseline, now);
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(replacement);
    });
  }

  private async readMemoryCollection(case_id: string): Promise<MemoryCollection> {
    await this.requireCase(case_id);
    const value = await readJsonFile<unknown>(this.caseFile(case_id, MEMORY_FILE));
    assertStoredIdentity(value, case_id, MEMORY_FILE);
    const collection = value as MemoryCollection;
    invariant(Array.isArray(collection.entries), "INTEGRITY_ERROR", MEMORY_FILE + " is invalid");
    for (const entry of collection.entries) assertStoredIdentity(entry, case_id, "memory entry");
    return collection;
  }

  async createChatThread(
    case_id: string,
    input: CreateChatThreadInput,
    options: MutationOptions = {},
  ): Promise<ChatThreadRecord> {
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const collection = await this.readChatThreadsCollection(case_id);
      const thread_id = requireIdentifier(input.thread_id ?? this.nextId("thread"), "thread_id");
      invariant(!collection.threads.some((item) => item.thread_id === thread_id), "CONFLICT", "El chat " + thread_id + " ya existe");
      const now = this.nowIso();
      const provenance = this.normalizeProvenance(input.provenance, now);
      const thread: ChatThreadRecord = {
        schema_version: SCHEMA_VERSION,
        thread_id,
        case_id,
        title: input.title?.trim() || "Conversación",
        metadata: cloneJson(input.metadata ?? {}),
        created_at: now,
        updated_at: now,
        created_by: provenance,
      };
      collection.threads.push(thread);
      await atomicWriteJson(this.caseFile(case_id, CHAT_THREADS_FILE), collection);
      await this.appendEventUnlocked(case_id, {
        event_type: "chat.thread_created",
        payload: { thread_id, title: thread.title },
        provenance,
      });
      await this.advanceRevisionUnlocked(case_id, baseline, now);
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(thread);
    });
  }

  async listChatThreads(case_id: string): Promise<ChatThreadRecord[]> {
    const collection = await this.readChatThreadsCollection(case_id);
    return collection.threads.map(cloneJson).sort((a, b) => compareCreatedId(a, b, "thread_id"));
  }

  async appendChatMessage(
    case_id: string,
    thread_id: string,
    input: AppendChatMessageInput,
    options: MutationOptions = {},
  ): Promise<ChatMessageRecord> {
    requireIdentifier(thread_id, "thread_id");
    return this.runMutation(case_id, async () => {
      const baseline = await this.beginMutation(case_id, options);
      const collection = await this.readChatThreadsCollection(case_id);
      const thread = collection.threads.find((item) => item.thread_id === thread_id);
      invariant(thread, "NOT_FOUND", "Chat " + thread_id + " no encontrado");
      invariant(
        input.role === "user" || input.role === "assistant" || input.role === "tool",
        "INVALID_INPUT",
        "chat.role is invalid or cannot be persisted: " + String(input.role),
      );
      if (input.role === "assistant") {
        invariant(input.provider && input.model, "INVALID_INPUT", "Mensajes assistant requieren provider y model");
      }
      const now = this.nowIso();
      const provenance = this.normalizeProvenance(input.provenance, now);
      const message_id = requireIdentifier(input.message_id ?? this.nextId("message"), "message_id");
      const existing = await this.readChatMessagesUnlocked(case_id, thread_id);
      invariant(!existing.some((item) => item.message_id === message_id), "CONFLICT", "Mensaje " + message_id + " ya existe");
      const message: ChatMessageRecord = {
        schema_version: SCHEMA_VERSION,
        message_id,
        case_id,
        thread_id,
        role: input.role,
        content: requireText(input.content, "chat.content"),
        metadata: cloneJson(input.metadata ?? {}),
        created_at: now,
        provenance,
        ...(input.provider ? { provider: requireText(input.provider, "provider") } : {}),
        ...(input.model ? { model: requireText(input.model, "model") } : {}),
      };
      await appendJsonLine(this.chatMessagesFile(case_id, thread_id), message);
      thread.updated_at = now;
      await atomicWriteJson(this.caseFile(case_id, CHAT_THREADS_FILE), collection);
      await this.appendEventUnlocked(case_id, {
        event_type: "chat.message_appended",
        payload: {
          thread_id,
          message_id,
          role: message.role,
          ...(message.provider ? { provider: message.provider } : {}),
          ...(message.model ? { model: message.model } : {}),
        },
        provenance,
      });
      await this.advanceRevisionUnlocked(case_id, baseline, now);
      await this.refreshJournalUnlocked(case_id);
      return cloneJson(message);
    });
  }

  async readChat(case_id: string, thread_id: string): Promise<ChatTranscript> {
    requireIdentifier(thread_id, "thread_id");
    const threads = await this.listChatThreads(case_id);
    const thread = threads.find((item) => item.thread_id === thread_id);
    invariant(thread, "NOT_FOUND", "Chat " + thread_id + " no encontrado");
    return { thread, messages: await this.readChatMessagesUnlocked(case_id, thread_id) };
  }

  async readChatMessages(case_id: string, thread_id: string): Promise<ChatMessageRecord[]> {
    return (await this.readChat(case_id, thread_id)).messages;
  }

  private async readChatThreadsCollection(case_id: string): Promise<ChatThreadCollection> {
    await this.requireCase(case_id);
    const value = await readJsonFile<unknown>(this.caseFile(case_id, CHAT_THREADS_FILE));
    assertStoredIdentity(value, case_id, CHAT_THREADS_FILE);
    const collection = value as ChatThreadCollection;
    invariant(Array.isArray(collection.threads), "INTEGRITY_ERROR", CHAT_THREADS_FILE + " is invalid");
    for (const thread of collection.threads) assertStoredIdentity(thread, case_id, "chat thread");
    return collection;
  }

  private chatMessagesFile(case_id: string, thread_id: string): string {
    return this.caseFile(case_id, "chat/" + requireIdentifier(thread_id, "thread_id") + ".jsonl");
  }

  private async readChatMessagesUnlocked(case_id: string, thread_id: string): Promise<ChatMessageRecord[]> {
    const values = await readJsonLines<unknown>(this.chatMessagesFile(case_id, thread_id));
    for (const [index, value] of values.entries()) {
      assertStoredIdentity(value, case_id, `chat message:${index + 1}`);
      const stored_role = (value as { role?: unknown }).role;
      invariant(
        stored_role === "user" || stored_role === "assistant" || stored_role === "tool",
        "INTEGRITY_ERROR",
        "Mensaje persistido tiene un role no reproducible: " + String(stored_role),
      );
      invariant(
        (value as { thread_id?: unknown }).thread_id === thread_id,
        "INTEGRITY_ERROR",
        "Mensaje pertenece a otro chat",
      );
    }
    return (values as ChatMessageRecord[]).map(cloneJson);
  }

  async readSnapshot(case_id: string, chat_thread_ids?: string[]): Promise<CaseSnapshot> {
    return this.withConsistentRead(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const workspace_before = await this.listCases();
        const [case_record, milestones, context, artifacts, memory, events, all_threads] = await Promise.all([
          this.readCase(case_id),
          this.listMilestones(case_id),
          this.getContextState(case_id),
          this.listArtifacts(case_id),
          this.listApplicableMemory(case_id),
          this.listEvents(case_id),
          this.listChatThreads(case_id),
        ]);
        const selected = chat_thread_ids
          ? all_threads.filter((thread) => chat_thread_ids.includes(thread.thread_id))
          : all_threads;
        const chats = await Promise.all(selected.map((thread) => this.readChat(case_id, thread.thread_id)));
        const workspace_after = await this.listCases();
        const before_revisions = workspace_before
          .map((item) => `${item.case_id}:${item.revision}`)
          .sort()
          .join("|");
        const after_revisions = workspace_after
          .map((item) => `${item.case_id}:${item.revision}`)
          .sort()
          .join("|");
        const after_case = workspace_after.find((item) => item.case_id === case_id);
        if (
          before_revisions !== after_revisions
          || !after_case
          || case_record.revision !== after_case.revision
        ) continue;
        return { case: after_case, milestones, context, artifacts, memory, events, chats };
      }
      throw new ProtocolError("CONFLICT", "No se pudo obtener un snapshot estable del caso");
    });
  }

  async refreshJournal(case_id: string): Promise<string> {
    return this.runMutation(case_id, async () => this.refreshJournalUnlocked(case_id));
  }

  private async refreshJournalUnlocked(case_id: string): Promise<string> {
    const [case_record, milestones, context, artifacts, memory, events] = await Promise.all([
      this.readCase(case_id),
      this.listMilestones(case_id),
      this.getContextState(case_id),
      this.listArtifacts(case_id),
      this.listApplicableMemory(case_id),
      this.readEventsUnlocked(case_id),
    ]);
    const active_context = context.active_proposal_id
      ? context.proposals.find((item) => item.proposal_id === context.active_proposal_id) ?? null
      : null;
    const markdown = renderJournal({
      case: case_record,
      active_context,
      milestones,
      artifacts,
      memory,
      events: events.slice(-100),
    });
    await atomicWriteFile(this.caseFile(case_id, JOURNAL_FILE), markdown);
    return markdown;
  }
}
