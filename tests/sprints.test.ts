import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AzureReadClient, SprintStore, SnapshotStore, sprintWaves } from "../src/workflows/index.js";
import type { SprintSelection, SprintTask } from "../src/workflows/index.js";

test("Azure sprint reads all batches, filters exact ownership and excludes parents outside the iteration", async () => {
  const batchSizes: number[] = [];
  const client = new AzureReadClient({ organization: "org", project: "project", pat: "test" }, async input => {
    const url = new URL(String(input)); let value: unknown;
    if (url.pathname.endsWith("/iterations")) value = { value: [{ id: "iteration-1", path: "project\\Sprint 1", name: "Sprint 1", attributes: {} }] };
    else if (url.pathname.includes("/iterations/")) value = { workItemRelations: Array.from({ length: 201 }, (_, i) => ({ source: { id: 999 }, target: { id: i + 1 } })) };
    else {
      const ids = url.searchParams.get("ids")!.split(",").map(Number); batchSizes.push(ids.length);
      value = { value: ids.map(id => ({ id, fields: { "System.IterationPath": id === 3 ? "other" : "project\\Sprint 1", "System.AssignedTo": { uniqueName: id === 1 || id === 3 ? "me@example.test" : "another@example.test" } } })) };
    }
    return new Response(JSON.stringify(value));
  });
  const scope = await client.sprintScope({ team: "Team One", iteration_id: "iteration-1", assignee: "ME@example.test" });
  assert.deepEqual(batchSizes, [200, 1]); assert.equal(scope.all_items.length, 200);
  assert.deepEqual(scope.selected_items.map(i => i.id), [1]);
  await assert.rejects(client.sprintScope({ team: "Team One", iteration_id: "iteration-1", assignee: "" }), /responsable/);
});
test("sprint imports are retryable, stable across rollover, and preserve membership history", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cvg-sprint-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const captured: string[] = []; let failSecond = false; let members = [1, 2]; let currentIteration = "iteration-1";
  const raw = (id: number) => ({ id, fields: { "System.Title": `Task ${id}`, "System.AssignedTo": { uniqueName: "me@example.test" }, "System.IterationPath": `project\\${currentIteration}`, "System.State": "Active", "System.WorkItemType": "Task" }, relations: id === 1 ? [{ rel: "System.LinkTypes.Dependency-Reverse", url: "https://dev.azure.com/org/_apis/wit/workItems/99" }] : [] });
  const client = {
    source: (id: string) => ({ provider: "azure_devops", organization: "org", project: "project", ticket_id: id }),
    sprintScope: async (selection: SprintSelection) => ({ selection, iteration: { id: selection.iteration_id, name: selection.iteration_id, path: `project\\${selection.iteration_id}`, attributes: {} }, all_items: [...members.map(raw), raw(3)], selected_items: members.map(raw) }),
    captureTicket: async (id: string) => { captured.push(id); if (failSecond && id === "2") throw new Error("simulated connection failure"); return { ticket: { subject: `Task ${id}` }, conversations: [], native: raw(Number(id)) }; },
  } as unknown as AzureReadClient;
  const store = new SprintStore(root);
  const selection = { team: "team", iteration_id: currentIteration, assignee: "me@example.test" };
  failSecond = true;
  await assert.rejects(store.import(client, selection), /connection failure/);
  assert.equal((await store.list()).length, 0);
  failSecond = false;
  const [a, b] = await Promise.all([store.import(client, selection), store.import(client, selection)]);
  assert.equal(a.id, b.id); assert.equal((await store.imports(a.id)).length, 2);
  assert.equal(new Set((await fs.readdir(root)).filter(n => n.startsWith("CVG-AZ-"))).size, 2);
  assert.equal(captured.includes("3"), false);
  assert.deepEqual(a.waves, [["2"]]); assert.equal(a.blocked[0]?.task_id, "1");
  const workspace = a.tasks[0]!.workspace_id;
  currentIteration = "iteration-2"; members = [1];
  const rollover = await store.import(client, { ...selection, iteration_id: currentIteration });
  assert.equal(rollover.tasks[0]?.workspace_id, workspace);
  assert.equal(rollover.tasks[0]?.latest_version, 2); assert.equal(rollover.tasks[0]?.baseline_version, 1);
  const old = await new SnapshotStore(root).history(workspace, client.source("1"));
  assert.equal(old.versions.length, 2);
  currentIteration = "iteration-1"; members = [];
  const empty = await store.import(client, selection);
  assert.equal(empty.tasks.length, 0); assert.equal((await store.imports(a.id))[0]?.tasks.length, 2);
  assert.equal((await fs.readdir(root)).filter(n => n.startsWith("CVG-AZ-")).length, 2);
});
test("planner preserves independent work around external dependencies and cycles", () => {
  const task = (id: string, depends_on: string[]): SprintTask => ({ id, depends_on, workspace_id: id, title: id, priority: 1, stage: "captured" });
  const plan = sprintWaves([task("a", ["b"]), task("b", ["a"]), task("c", []), task("d", ["outside"])], 2);
  assert.deepEqual(plan.waves, [["c"]]); assert.equal(plan.blocked.length, 3);
});
