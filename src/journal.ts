import type {
  ArtifactRecord,
  CaseRecord,
  ContextProposalRecord,
  EventRecord,
  EvidenceRef,
  ApplicableMemory,
  MilestoneRecord,
} from "./types.js";

export interface JournalInput {
  case: CaseRecord;
  active_context: ContextProposalRecord | null;
  milestones: MilestoneRecord[];
  artifacts: ArtifactRecord[];
  memory: ApplicableMemory;
  events: EventRecord[];
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "—";
}

function evidenceLabel(ref: EvidenceRef): string {
  return (
    ref.artifact_id ??
    ref.path ??
    ref.uri ??
    ref.locator ??
    ref.digest ??
    ref.note ??
    "—"
  );
}

/** Render determinista. `journal.md` es una vista, nunca la fuente canónica. */
export function renderJournal(input: JournalInput): string {
  const milestones = [...input.milestones].sort((a, b) =>
    a.milestone_id.localeCompare(b.milestone_id),
  );
  const artifacts = [...input.artifacts].sort((a, b) =>
    a.artifact_id.localeCompare(b.artifact_id),
  );
  const events = [...input.events].sort((a, b) => a.event_id.localeCompare(b.event_id));
  const lines = [
    `# ${input.case.title}`,
    "",
    `- **Case ID:** \`${input.case.case_id}\``,
    `- **Estado:** \`${input.case.status}\``,
    `- **Revisión:** ${input.case.revision}`,
    `- **Actualizado:** ${input.case.updated_at}`,
    "",
    "## Objetivo",
    "",
    input.case.objective,
    "",
    "## Resumen",
    "",
    input.case.summary || "—",
    "",
    "## Contexto activo",
    "",
  ];

  if (input.active_context) {
    lines.push(
      `**${input.active_context.summary}** (\`${input.active_context.proposal_id}\`)`,
      "",
      input.active_context.content,
    );
  } else {
    lines.push("No hay contexto aprobado.");
  }

  lines.push(
    "",
    "## Hitos",
    "",
    "| ID | Hito | Estado | Evidencia |",
    "|---|---|---|---|",
  );
  for (const milestone of milestones) {
    lines.push(
      `| ${cell(milestone.milestone_id)} | ${cell(milestone.title)} | ${cell(milestone.status)} | ${cell(milestone.evidence_refs.map(evidenceLabel).join(", "))} |`,
    );
  }
  if (!milestones.length) lines.push("| — | Sin hitos | — | — |");

  lines.push("", "## Artefactos", "");
  if (artifacts.length) {
    for (const artifact of artifacts) {
      lines.push(
        `- \`${artifact.artifact_id}\` · **${artifact.title}** · \`${artifact.kind}\` · [${artifact.path}](${artifact.path}) · \`${artifact.digest}\``,
      );
    }
  } else {
    lines.push("No hay artefactos.");
  }

  lines.push("", "## Memoria durable", "");
  const memories = [...input.memory.case_memory, ...input.memory.shared_memory].sort((a, b) =>
    a.memory_id.localeCompare(b.memory_id),
  );
  if (memories.length) {
    for (const memory of memories) {
      const scope = memory.scope === "shared" ? "shared:" + (memory.shared_scope ?? "global") : "case";
      lines.push(
        `- \`${memory.memory_id}\` · \`${scope}\` · \`${memory.classification}\` · ${memory.statement} · confianza ${memory.confidence}`,
      );
    }
  } else {
    lines.push("No hay memoria durable aplicable.");
  }

  lines.push("", "## Registro de eventos", "");
  if (events.length) {
    for (const event of events) {
      lines.push(
        `- ${event.occurred_at} · \`${event.event_type}\` · ${event.provenance.actor} (${event.provenance.actor_type})`,
      );
    }
  } else {
    lines.push("No hay eventos.");
  }
  return lines.join("\n") + "\n";
}
