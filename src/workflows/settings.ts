import * as path from "node:path";
import type { WorkflowSettings, PrGranularity } from "./contracts.js";
import { readOptional, withFileLock, atomicWriteJson } from "./storage.js";

export class SettingsStore {
  constructor(private readonly root: string) {}
  private get file(): string { return path.join(this.root, "_workflows", "settings.json"); }
  async read(): Promise<WorkflowSettings> {
    return await readOptional<WorkflowSettings>(this.file) ?? {
      schema_version: 1, revision: 0, pr_granularity: "task", max_parallel_tasks: 2,
      publish_requires_human: true, mutating_tests_require_human: true, visual_execution_host: "local_pc",
    };
  }
  async update(input: { expected_revision: number; pr_granularity: PrGranularity; max_parallel_tasks: number }): Promise<WorkflowSettings> {
    if (!["task", "subtask"].includes(input.pr_granularity)) throw new Error("Granularidad inválida");
    if (!Number.isInteger(input.max_parallel_tasks) || input.max_parallel_tasks < 1 || input.max_parallel_tasks > 16) throw new Error("Concurrencia fuera de rango (1–16)");
    return withFileLock(this.file + ".lock", async () => {
      const current = await this.read();
      if (current.revision !== input.expected_revision) throw new Error("CONFLICT: la configuración cambió; recargá antes de guardar");
      const next: WorkflowSettings = { schema_version: 1, revision: current.revision + 1,
        pr_granularity: input.pr_granularity, max_parallel_tasks: input.max_parallel_tasks,
        publish_requires_human: true, mutating_tests_require_human: true, visual_execution_host: "local_pc" };
      await atomicWriteJson(this.file, next);
      return next;
    });
  }
}
