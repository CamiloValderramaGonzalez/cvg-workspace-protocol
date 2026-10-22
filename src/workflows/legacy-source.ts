import * as path from "node:path";
import type { SourceContent, SourceIdentity } from "./snapshots.js";
import { SnapshotStore } from "./snapshots.js";
import { atomicWriteJson, digest, readOptional, segment, withFileLock } from "./storage.js";

interface LegacyMeta { ticket_id?: string | number; tickets?: { provider: string; id: string | number }[] }
const aliases = (source: SourceIdentity) => source.provider === "azure_devops" ? ["azure_devops", "azure", "ado"] : [source.provider];
function primary(meta: LegacyMeta, source: SourceIdentity): boolean {
  const first = meta.tickets?.[0];
  return first ? aliases(source).includes(first.provider) && String(first.id) === source.ticket_id : String(meta.ticket_id ?? "") === source.ticket_id;
}
/** Compatibility only. Source versions are authoritative; these JSONs are derived. */
export async function syncLegacySource(root: string, workspace: string, source: SourceIdentity): Promise<void> {
  const dir = path.join(root, segment(workspace));
  const meta = await readOptional<LegacyMeta>(path.join(dir, "caso.json"));
  if (!meta) return;
  await withFileLock(path.join(dir, "source-versions", digest(source), ".capture.lock"), async () => {
    const history = await new SnapshotStore(root).history(workspace, source);
    const chosen = history.versions.find(v => v.version === history.baseline_version);
    if (!chosen) return;
    const data = { ticket: chosen.content.ticket, conversations: chosen.content.conversations, fetched_at: chosen.captured_at };
    const names = new Set([source.provider, ...(meta.tickets ?? []).filter(t => String(t.id) === source.ticket_id && aliases(source).includes(t.provider)).map(t => t.provider)]);
    for (const provider of names) await atomicWriteJson(path.join(dir, "tickets", `${segment(provider)}-${segment(source.ticket_id)}.json`), data);
    if (primary(meta, source)) {
      await atomicWriteJson(path.join(dir, "ticket-snapshot.json"), chosen.content.ticket);
      await atomicWriteJson(path.join(dir, "ticket-conversations.json"), chosen.content.conversations);
    }
  });
}
export async function refreshWorkspaceSource(root: string, workspace: string, source: SourceIdentity, fetchComplete: () => Promise<SourceContent>) {
  const dir = path.join(root, segment(workspace));
  const store = new SnapshotStore(root);
  const meta = await readOptional<LegacyMeta>(path.join(dir, "caso.json"));
  if (meta && !(await store.history(workspace, source)).versions.length) {
    let legacy: SourceContent | null = null;
    for (const provider of aliases(source)) {
      legacy = await readOptional<SourceContent>(path.join(dir, "tickets", `${segment(provider)}-${segment(source.ticket_id)}.json`));
      if (legacy) break;
    }
    if (!legacy && primary(meta, source)) {
      const ticket = await readOptional<Record<string, unknown>>(path.join(dir, "ticket-snapshot.json"));
      const conversations = await readOptional<unknown[]>(path.join(dir, "ticket-conversations.json"));
      if (ticket) legacy = { ticket, conversations: conversations ?? [] };
    }
    if (legacy) await store.capture(workspace, source, async () => ({ ticket: legacy!.ticket, conversations: legacy!.conversations ?? [] }), "legacy_import");
  }
  const result = await store.capture(workspace, source, fetchComplete);
  await syncLegacySource(root, workspace, source);
  return result;
}
