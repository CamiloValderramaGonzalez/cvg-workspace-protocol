import { ProtocolError, invariant } from "./errors.js";
import type {
  AssembledContext,
  ChatTranscript,
  ContextAssemblyOptions,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import type { WorkspaceStore } from "./store.js";

function limit<T>(values: T[], maximum: number | undefined, label: string): T[] {
  if (maximum === undefined) return values;
  invariant(Number.isSafeInteger(maximum) && maximum >= 0, "INVALID_INPUT", label + " debe ser no negativo");
  return maximum === 0 ? [] : values.slice(-maximum);
}

/**
 * Ensambla un snapshot provider-neutral. El orden es explícito y se reintenta si
 * la revisión del caso cambia durante la lectura.
 */
export class ContextAssembler {
  constructor(private readonly store: WorkspaceStore) {}

  async assemble(case_id: string, options: ContextAssemblyOptions = {}): Promise<AssembledContext> {
    return this.store.withConsistentRead(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const workspace_before = await this.store.listCases();
        const before = await this.store.readCase(case_id);
        const [milestones, state, artifacts, memory, events, threads] = await Promise.all([
          this.store.listMilestones(case_id),
          this.store.getContextState(case_id),
          this.store.listArtifacts(case_id),
          this.store.listApplicableMemory(case_id, {
            ...(options.shared_scopes ? { shared_scopes: options.shared_scopes } : {}),
            include_inactive: options.include_inactive_memory ?? false,
          }),
          options.include_events === false ? Promise.resolve([]) : this.store.listEvents(case_id),
          this.store.listChatThreads(case_id),
        ]);
        const selected = options.chat_thread_ids
          ? threads.filter((thread) => options.chat_thread_ids?.includes(thread.thread_id))
          : threads;
        const chats: ChatTranscript[] = await Promise.all(
          selected.map(async (thread) => ({
            thread,
            messages: limit(
              await this.store.readChatMessages(case_id, thread.thread_id),
              options.chat_message_limit,
              "chat_message_limit",
            ),
          })),
        );
        const after = await this.store.readCase(case_id);
        const workspace_after = await this.store.listCases();
        const workspace_revision_before = workspace_before
          .map((item) => `${item.case_id}:${item.revision}`)
          .sort()
          .join("|");
        const workspace_revision_after = workspace_after
          .map((item) => `${item.case_id}:${item.revision}`)
          .sort()
          .join("|");
        if (before.revision !== after.revision || workspace_revision_before !== workspace_revision_after) continue;
        const active_context = state.active_proposal_id
          ? state.proposals.find((proposal) => proposal.proposal_id === state.active_proposal_id) ?? null
          : null;
        const contributing_case_ids = new Set([
          case_id,
          ...memory.shared_memory.map((entry) => entry.case_id),
        ]);
        return {
          schema_version: SCHEMA_VERSION,
          source_revisions: Object.fromEntries(
            workspace_after
              .filter((item) => contributing_case_ids.has(item.case_id))
              .map((item) => [item.case_id, item.revision]),
          ),
          case: after,
          active_context,
          milestones: [...milestones].sort((a, b) => a.milestone_id.localeCompare(b.milestone_id)),
          artifacts: [...artifacts].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
          case_memory: [...memory.case_memory].sort((a, b) => a.memory_id.localeCompare(b.memory_id)),
          shared_memory: [...memory.shared_memory].sort((a, b) => a.memory_id.localeCompare(b.memory_id)),
          events: limit(
            [...events],
            options.event_limit,
            "event_limit",
          ),
          chats: chats
            .map((chat) => ({
              thread: chat.thread,
              messages: [...chat.messages],
            }))
            .sort((a, b) => a.thread.thread_id.localeCompare(b.thread.thread_id)),
        };
      }
      throw new ProtocolError("CONFLICT", "No se pudo obtener un snapshot estable del caso");
    });
  }

  serialize(context: AssembledContext): string {
    return JSON.stringify(context, null, 2) + "\n";
  }
}
