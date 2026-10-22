import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AzureReadClient, AzureIteration, SprintSelection } from "./azure.js";
import type { SprintTask, WorkflowSettings } from "./contracts.js";
import { planWaves } from "./contracts.js";
import { SettingsStore } from "./settings.js";
import { SnapshotStore } from "./snapshots.js";
import type { SourceIdentity } from "./snapshots.js";
import { refreshWorkspaceSource } from "./legacy-source.js";
import { atomicWriteJson, canonical, digest, immutableJson, readOptional, segment, withFileLock } from "./storage.js";

export interface ImportedSprintTask extends SprintTask {
  source: SourceIdentity;
  latest_version: number;
  baseline_version: number;
  source_state: string;
  work_item_type: string;
}
export interface SprintRecord {
  schema_version: 1; id: string; revision: number; imported_at: string;
  organization: string; project: string; selection: SprintSelection; iteration: AzureIteration;
  settings: WorkflowSettings; total_items: number; tasks: ImportedSprintTask[];
  waves: string[][]; blocked: { task_id: string; reason: string }[];
  import_id: string; scope_hash: string; execution: "not_started";
}
export function sprintWaves(tasks: SprintTask[], concurrency: number): { waves: string[][]; blocked: { task_id: string; reason: string }[] } {
  const ids = new Set(tasks.map(t => t.id));
  const blocked = new Map<string, string>();
  for (const task of tasks) {
    const missing = task.depends_on.filter(id => !ids.has(id));
    if (missing.length) blocked.set(task.id, `Dependencias externas pendientes de comprobar: ${missing.join(", ")}`);
  }
  for (let i = 0; i < tasks.length; i++) for (const task of tasks) {
    if (!blocked.has(task.id) && task.depends_on.some(id => blocked.has(id))) blocked.set(task.id, "Depende de una tarea bloqueada");
  }
  const eligible = tasks.filter(t => !blocked.has(t.id));
  let waves: string[][] = [];
  try { waves = planWaves(eligible, concurrency); }
  catch {
    // Keep executable acyclic components; mark the unresolved cycle and its dependents.
    const done = new Set<string>();
    while (true) {
      const next = eligible.filter(t => !done.has(t.id) && t.depends_on.every(d => done.has(d))).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).slice(0, concurrency);
      if (!next.length) break;
      waves.push(next.map(t => t.id)); next.forEach(t => done.add(t.id));
    }
    eligible.filter(t => !done.has(t.id)).forEach(t => blocked.set(t.id, "Ciclo de dependencias o dependencia de un ciclo"));
  }
  return { waves, blocked: [...blocked].map(([task_id, reason]) => ({ task_id, reason })) };
}
/** Imports are serialized and retryable; task identities do not depend on sprint membership. */
export class SprintStore {
  constructor(private readonly root: string) {}
  private get dir(): string { return path.join(this.root, "_workflows", "sprints"); }
  async list(): Promise<SprintRecord[]> {
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records: SprintRecord[] = [];
    for (const name of names.filter(n => /^sprint-[a-f\d]{24}$/.test(n))) {
      const record = await readOptional<SprintRecord>(path.join(this.dir, name, "current.json"));
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.imported_at.localeCompare(a.imported_at));
  }
  async read(id: string): Promise<SprintRecord> {
    const record = await readOptional<SprintRecord>(path.join(this.dir, segment(id), "current.json"));
    if (!record) throw new Error("Sprint local inexistente"); return record;
  }
  async imports(id: string): Promise<SprintRecord[]> {
    const dir = path.join(this.dir, segment(id), "history");
    let names: string[];
    try { names = await fs.readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const history: SprintRecord[] = [];
    for (const name of names.filter(n => /^v\d{8}\.json$/.test(n)).sort()) {
      const record = await readOptional<SprintRecord>(path.join(dir, name)); if (record) history.push(record);
    }
    return history;
  }
  async import(client: AzureReadClient, selection: SprintSelection): Promise<SprintRecord> {
    if (!selection.assignee?.trim()) throw new Error("Responsable explícito requerido: no se importarán tareas de todo el equipo");
    const identity = client.source("1");
    const id = "sprint-" + digest({ organization: identity.organization, project: identity.project, team: selection.team.trim().toLowerCase(), iteration: selection.iteration_id, assignee: selection.assignee.trim().toLowerCase() }).slice(0, 24);
    const dir = path.join(this.dir, id);
    return withFileLock(path.join(dir, ".import.lock"), async () => {
      const import_id = `import-${randomUUID()}`;
      const attemptPath = path.join(dir, "attempts", import_id + ".json");
      const attempt = { import_id, started_at: new Date().toISOString(), status: "running", completed_workspaces: [] as string[] };
      await atomicWriteJson(attemptPath, attempt);
      try {
        const scope = await client.sprintScope(selection);
        await immutableJson(path.join(dir, "scopes", import_id + ".json"), scope);
        const settings = await new SettingsStore(this.root).read();
        const tasks: ImportedSprintTask[] = [];
        // Capture only selected ownership. Other people's work is dependency context, never scheduled.
        for (const item of scope.selected_items) {
          const source = client.source(String(item.id));
          const workspace = `CVG-AZ-${digest({ organization: source.organization, project: source.project }).slice(0, 12)}-${source.ticket_id}`;
          const workspaceDir = path.join(this.root, workspace);
          await withFileLock(path.join(this.root, "_workflows", "task-locks", workspace + ".lock"), async () => {
            const bindingFile = path.join(workspaceDir, "task-workspace.json");
            const binding = await readOptional<{ source: SourceIdentity }>(bindingFile);
            if (binding && canonical(binding.source) !== canonical(source)) throw new Error("Colisión de identidad de workspace");
            if (!binding) {
              if (await readOptional(path.join(workspaceDir, "caso.json"))) throw new Error("Workspace existente sin vínculo comprobable; se requiere migración");
              await immutableJson(bindingFile, { schema_version: 1, workspace_id: workspace, source, created_at: new Date().toISOString() });
            }
            // Legacy projection is created once; never reset a human-edited case during a new import.
            if (!await readOptional(path.join(workspaceDir, "caso.json"))) await immutableJson(path.join(workspaceDir, "caso.json"), {
              id: workspace, summary: String(item.fields["System.Title"] ?? `Tarea ${item.id}`), service: source.project,
              status: "borrador", source: "azure_sprint", opened_at: new Date().toISOString(),
              tickets: [{ provider: source.provider, id: source.ticket_id, url: `https://dev.azure.com/${encodeURIComponent(source.organization)}/${encodeURIComponent(source.project)}/_workitems/edit/${source.ticket_id}` }],
            });
            await refreshWorkspaceSource(this.root, workspace, source, async () => {
              const captured = await client.captureTicket(source.ticket_id);
              const fields = (captured.native as { fields?: Record<string, any> } | undefined)?.fields;
              const owner = fields?.["System.AssignedTo"];
              const expected = selection.assignee.trim().toLowerCase();
              const matches = typeof owner === "string" ? owner.toLowerCase() === expected : [owner?.uniqueName, owner?.id].some(v => typeof v === "string" && v.toLowerCase() === expected);
              if (!matches || String(fields?.["System.IterationPath"]).toLowerCase() !== scope.iteration.path.toLowerCase()) throw new Error(`La tarea ${source.ticket_id} cambió de responsable o sprint durante la importación; volvé a importar`);
              return captured;
            });
          }, { timeout_ms: 180_000 });
          const history = await new SnapshotStore(this.root).history(workspace, source);
          const baseline = history.versions.find(v => v.version === history.baseline_version)!;
          const native = baseline.content.native as { fields?: Record<string, unknown>; relations?: { rel: string; url: string }[] } | undefined;
          const fields = native?.fields ?? {};
          const dependencies = (native?.relations ?? []).filter(r => r.rel === "System.LinkTypes.Dependency-Reverse").map(r => /\/workitems\/(\d+)$/i.exec(r.url)?.[1]).filter((v): v is string => !!v);
          tasks.push({ id: source.ticket_id, workspace_id: workspace, title: String(baseline.content.ticket.subject ?? item.fields["System.Title"]), depends_on: dependencies,
            priority: Number(fields["Microsoft.VSTS.Common.Priority"]) || 2, stage: "captured", source,
            baseline_version: baseline.version, latest_version: history.latest_version!, source_state: String(fields["System.State"] ?? ""), work_item_type: String(fields["System.WorkItemType"] ?? "") });
          attempt.completed_workspaces.push(workspace); await atomicWriteJson(attemptPath, attempt);
        }
        // Append-only import history records membership, including removals; workspaces are never deleted.
        const previous = await this.imports(id);
        const record: SprintRecord = { schema_version: 1, id, revision: (previous.at(-1)?.revision ?? 0) + 1, imported_at: new Date().toISOString(),
          organization: identity.organization, project: identity.project, selection: scope.selection, iteration: scope.iteration, settings,
          total_items: scope.all_items.length, tasks, ...sprintWaves(tasks, settings.max_parallel_tasks), import_id, scope_hash: digest(scope), execution: "not_started" };
        await immutableJson(path.join(dir, "history", `v${String(record.revision).padStart(8, "0")}.json`), record);
        await atomicWriteJson(path.join(dir, "current.json"), record);
        attempt.status = "completed"; await atomicWriteJson(attemptPath, attempt);
        return record;
      } catch (error) {
        attempt.status = "failed"; await atomicWriteJson(attemptPath, attempt); throw error;
      }
    }, { timeout_ms: 180_000 });
  }
}
