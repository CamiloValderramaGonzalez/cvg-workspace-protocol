/** Contracts shared by the UI and headless adapters. No implicit publishing authority. */
export type PrGranularity = "task" | "subtask";
export type Stage = "captured" | "analysis" | "test_design" | "ready_to_implement" | "implementation" | "validation" | "ready_for_pr" | "blocked";
export interface WorkflowSettings {
  schema_version: 1;
  revision: number;
  pr_granularity: PrGranularity;
  max_parallel_tasks: number;
  publish_requires_human: true;
  mutating_tests_require_human: true;
  visual_execution_host: "local_pc";
}
export interface SprintTask {
  id: string;
  workspace_id: string;
  title: string;
  depends_on: string[];
  priority: number;
  stage: Stage;
}
export interface SprintPlan {
  id: string;
  source: { organization: string; project: string; team: string; iteration_id: string; assignee: string };
  tasks: SprintTask[];
}
export interface TestAction {
  kind: "code" | "visual" | "api";
  execution_host: "local_pc" | "remote";
  environment: "local" | "dev" | "qa" | "preprod" | "prod";
  effect: "read_only" | "mutates_data" | "unknown";
}
/** Planning gate, not a sandbox. Executors must enforce these restrictions too. */
export function testEligibility(action: TestAction): "eligible" | "human_supervision_required" | "blocked" {
  if (action.kind === "visual" && action.execution_host !== "local_pc") return "blocked";
  if (action.effect !== "read_only") {
    if (action.environment === "prod" || action.environment === "preprod") return "blocked";
    return "human_supervision_required";
  }
  return "eligible";
}
/** Deterministic dependency waves, useful before allocating branches or processes. */
export function planWaves(tasks: SprintTask[], concurrency: number): string[][] {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("Concurrencia fuera de rango (1–16)");
  const ids = new Set(tasks.map(t => t.id));
  if (ids.size !== tasks.length) throw new Error("Tareas duplicadas");
  for (const task of tasks) for (const dep of task.depends_on) if (!ids.has(dep)) throw new Error(`Dependencia sin resolver: ${dep}`);
  const remaining = [...tasks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const done = new Set<string>();
  const waves: string[][] = [];
  while (remaining.length) {
    const next = remaining.filter(t => t.depends_on.every(d => done.has(d))).slice(0, concurrency);
    if (!next.length) throw new Error("Dependencias cíclicas: se requiere resolverlas antes de ejecutar");
    waves.push(next.map(t => t.id));
    for (const task of next) { done.add(task.id); remaining.splice(remaining.indexOf(task), 1); }
  }
  return waves;
}
